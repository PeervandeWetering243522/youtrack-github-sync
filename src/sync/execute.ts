/**
 * The write phase of a run: planned actions become GitHub writes, sent serially and
 * WRITE_PAUSE_MS apart, until the write cap, the fetch guard, a GitHub rate limit or the
 * run deadline stops them. Only src/sync.ts builds the writer, and only when dry run is off.
 */

import { addLabel, closeIssue, createIssue, MIRROR_LABEL } from "../github.ts";
import type { CreateIssueBody, GitHubIssue, GitHubTarget } from "../github.ts";
import { DEFAULT_MAX_FETCHES, FetchBudgetExceededError, HttpError } from "../http.ts";
import type { HttpClient } from "../http.ts";
import { formatMirror } from "../mirror.ts";
import { writeCost } from "../plan.ts";
import type { Action } from "../plan.ts";
import type { Redact } from "../utils/redact.ts";
import type { YouTrackIssue } from "../youtrack.ts";
import type { Logger } from "./log.ts";
import { combine, mirrorName, NOTHING, OUT_OF_FETCHES } from "./tally.ts";
import type { StopReason, Tally } from "./tally.ts";

/** Pause between GitHub writes (GitHub best practice: serial, >= 1 s apart). */
export const WRITE_PAUSE_MS = 1_000;

/** GitHub writes, sent one at a time and WRITE_PAUSE_MS apart. */
export type GitHubWriter = {
  readonly create: (body: CreateIssueBody) => Promise<GitHubIssue>;
  readonly close: (issueNumber: number) => Promise<void>;
  readonly addLabel: (issueNumber: number) => Promise<void>;
  /** Writes attempted so far; each one counts against MAX_WRITES_PER_RUN. */
  readonly count: () => number;
};

export type WriteContext = {
  readonly writer: GitHubWriter;
  readonly log: Logger;
  readonly redact: Redact;
  readonly youtrackBaseUrl: string;
  readonly maxWrites: number;
  /** Current time, epoch ms. */
  readonly now: () => number;
  /** No action starts at or after this time, epoch ms (decision R8). */
  readonly deadline: number;
};

type WriteOutcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "rate-limited"; readonly reason: string }
  | { readonly kind: "out-of-fetches" };

type Failed = Extract<WriteOutcome<never>, { readonly reason: string }>;

export function githubWriter(http: HttpClient, target: GitHubTarget, sleep: (ms: number) => Promise<void>): GitHubWriter {
  let writes = 0;
  const send = async <T>(write: () => Promise<T>): Promise<T> => {
    // No pause before the first write, nor before one the fetch guard is going to refuse.
    if (writes > 0 && http.remainingFetches() > 0) await sleep(WRITE_PAUSE_MS);
    writes += 1;
    return write();
  };
  return {
    create: (body) => send(() => createIssue(http, target, body)),
    close: (issueNumber) => send(() => closeIssue(http, target, issueNumber)),
    addLabel: (issueNumber) => send(() => addLabel(http, target, issueNumber, MIRROR_LABEL)),
    count: () => writes,
  };
}

/**
 * Runs the actions in order until one of these stops it; the stopping action (unless it
 * was sent) and everything after it count as capped:
 * - the write cap (no warning: planActions already capped by writeCost);
 * - the run deadline, checked before each action starts (decision R8);
 * - the fetch guard refusing a write, or GitHub rate-limiting one (decision R7).
 */
export async function executeActions(actions: readonly Action[], context: WriteContext): Promise<Tally> {
  let tally = NOTHING;
  for (const [position, action] of actions.entries()) {
    const notYetRun = actions.length - position;
    // planActions capped by writeCost; label re-adds are extra writes it could not foresee.
    if (context.writer.count() + writeCost(action) > context.maxWrites) {
      return combine(tally, { ...NOTHING, capped: notYetRun });
    }
    if (context.now() >= context.deadline) {
      context.log.warn(`run deadline reached; ${String(notYetRun)} more action(s) capped`);
      return combine(tally, { ...NOTHING, capped: notYetRun });
    }
    tally = combine(tally, await executeAction(action, context));
    if (tally.stop !== null) {
      const rest = notYetRun - 1;
      context.log.warn(`${stopCause(tally.stop)}; ${String(rest)} more action(s) capped`);
      return combine(tally, { ...NOTHING, capped: rest });
    }
  }
  return tally;
}

function stopCause(reason: StopReason): string {
  switch (reason) {
    case "fetch-guard":
      return `fetch guard of ${String(DEFAULT_MAX_FETCHES)} reached`;
    case "rate-limit":
      return "GitHub rate limit hit";
  }
}

function executeAction(action: Action, context: WriteContext): Promise<Tally> {
  switch (action.kind) {
    case "create":
      return executeCreate(action.issue, context);
    case "close":
      return executeClose(action.issue, action.mirror.issueNumber, context);
  }
}

/**
 * A failed write becomes a value. FetchBudgetExceededError is told apart: the client throws
 * it before sending anything. So is an HttpError GitHub marked as rate-limited (decision R7).
 * Any other write that was sent and failed is a plain failure, also when its retry was
 * skipped because the budget could not pay for it (decision A10).
 */
async function attemptWrite<T>(write: () => Promise<T>): Promise<WriteOutcome<T>> {
  try {
    return { kind: "ok", value: await write() };
  } catch (error) {
    if (error instanceof FetchBudgetExceededError) return { kind: "out-of-fetches" };
    const reason = error instanceof Error ? error.message : String(error);
    if (error instanceof HttpError && error.rateLimited) return { kind: "rate-limited", reason };
    return { kind: "failed", reason };
  }
}

/**
 * Logs and records one failed write; the run throws at the end (decision A10). A
 * rate-limited write also stops the write phase (decision R7).
 */
function failure(context: WriteContext, what: string, outcome: Failed): Tally {
  const redacted = context.redact(`${what} failed: ${outcome.reason}`);
  context.log.error(redacted);
  return { ...NOTHING, failures: [redacted], stop: outcome.kind === "rate-limited" ? "rate-limit" : null };
}

async function executeCreate(issue: YouTrackIssue, context: WriteContext): Promise<Tally> {
  const name = mirrorName(issue);
  const mirror = formatMirror(issue, context.youtrackBaseUrl);
  const body = { title: mirror.title, body: mirror.body, labels: [MIRROR_LABEL] } satisfies CreateIssueBody;
  const outcome = await attemptWrite(() => context.writer.create(body));
  if (outcome.kind === "out-of-fetches") return OUT_OF_FETCHES;
  if (outcome.kind !== "ok") return failure(context, `create ${name}`, outcome);
  const created = outcome.value;
  context.log.info(`create ${name} -> #${String(created.number)}`);
  return combine({ ...NOTHING, created: 1 }, await ensureLabel(created, name, context));
}

/**
 * Re-adds MIRROR_LABEL when the 201 response lacks it (decision A5), if a write is
 * left. Without it the next run still matches the mirror by title.
 */
async function ensureLabel(created: GitHubIssue, name: string, context: WriteContext): Promise<Tally> {
  const wanted = MIRROR_LABEL.toLowerCase();
  if (created.labelNames.some((label) => label.toLowerCase() === wanted)) return NOTHING;
  const what = `${name} #${String(created.number)}`;
  const notReAdded = `${what} was created without the "${MIRROR_LABEL}" label and it was not re-added`;
  if (context.writer.count() >= context.maxWrites) {
    context.log.warn(`${notReAdded} (write cap reached)`);
    return NOTHING;
  }
  const outcome = await attemptWrite(() => context.writer.addLabel(created.number));
  switch (outcome.kind) {
    case "ok":
      context.log.info(`label ${what}`);
      return { ...NOTHING, labelsReAdded: 1 };
    case "failed":
    case "rate-limited":
      return failure(context, `label ${what}`, outcome);
    case "out-of-fetches":
      context.log.warn(`${notReAdded} (fetch guard reached)`);
      return { ...NOTHING, stop: "fetch-guard" };
  }
}

async function executeClose(issue: YouTrackIssue, issueNumber: number, context: WriteContext): Promise<Tally> {
  const what = `${mirrorName(issue)} #${String(issueNumber)}`;
  const outcome = await attemptWrite(() => context.writer.close(issueNumber));
  switch (outcome.kind) {
    case "ok":
      context.log.info(`close ${what}`);
      return { ...NOTHING, closed: 1 };
    case "failed":
    case "rate-limited":
      return failure(context, `close ${what}`, outcome);
    case "out-of-fetches":
      return OUT_OF_FETCHES;
  }
}
