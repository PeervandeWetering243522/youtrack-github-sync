/**
 * The write phase of a run: planned actions become GitHub writes, sent serially and
 * WRITE_PAUSE_MS apart, until the write cap or the fetch guard stops them.
 * Only src/sync.ts builds the writer, and only when dry run is off.
 */

import { addLabel, closeIssue, createIssue, MIRROR_LABEL } from "../github.ts";
import type { CreateIssueBody, GitHubIssue, GitHubTarget } from "../github.ts";
import { DEFAULT_MAX_FETCHES, FetchBudgetExceededError } from "../http.ts";
import type { HttpClient } from "../http.ts";
import { formatMirror } from "../mirror.ts";
import { writeCost } from "../plan.ts";
import type { Action } from "../plan.ts";
import type { YouTrackIssue } from "../youtrack.ts";
import type { Logger, Redact } from "./log.ts";
import { combine, mirrorName, NOTHING, OUT_OF_FETCHES } from "./tally.ts";
import type { Tally } from "./tally.ts";

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
};

type WriteOutcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "out-of-fetches" };

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

/** Runs the actions in order until the write cap or the fetch guard stops it. */
export async function executeActions(actions: readonly Action[], context: WriteContext): Promise<Tally> {
  let tally = NOTHING;
  for (const [position, action] of actions.entries()) {
    const notYetRun = actions.length - position;
    // planActions capped by writeCost; label re-adds are extra writes it could not foresee.
    if (context.writer.count() + writeCost(action) > context.maxWrites) {
      return combine(tally, { ...NOTHING, capped: notYetRun });
    }
    tally = combine(tally, await executeAction(action, context));
    if (tally.stopped) {
      const rest = notYetRun - 1;
      context.log.warn(`fetch guard of ${String(DEFAULT_MAX_FETCHES)} reached; ${String(rest)} more action(s) capped`);
      return combine(tally, { ...NOTHING, capped: rest });
    }
  }
  return tally;
}

function executeAction(action: Action, context: WriteContext): Promise<Tally> {
  switch (action.kind) {
    case "create":
      return executeCreate(action.issue, action.closeAfter, context);
    case "close":
      return executeClose(action.issue, action.mirror.issueNumber, context);
  }
}

/**
 * A failed write becomes a value. Only FetchBudgetExceededError is told apart: the client
 * throws it before sending anything. A write that was sent and failed is a failure, also
 * when its retry was skipped because the budget could not pay for it (decision A10).
 */
async function attemptWrite<T>(write: () => Promise<T>): Promise<WriteOutcome<T>> {
  try {
    return { kind: "ok", value: await write() };
  } catch (error) {
    if (error instanceof FetchBudgetExceededError) return { kind: "out-of-fetches" };
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Logs and records one failed write; the run goes on and throws at the end (decision A10). */
function failure(context: WriteContext, message: string): Tally {
  const redacted = context.redact(message);
  context.log.error(redacted);
  return { ...NOTHING, failures: [redacted] };
}

async function executeCreate(issue: YouTrackIssue, closeAfter: boolean, context: WriteContext): Promise<Tally> {
  const name = mirrorName(issue);
  const mirror = formatMirror(issue, context.youtrackBaseUrl);
  const body = { title: mirror.title, body: mirror.body, labels: [MIRROR_LABEL] } satisfies CreateIssueBody;
  const outcome = await attemptWrite(() => context.writer.create(body));
  if (outcome.kind === "out-of-fetches") return OUT_OF_FETCHES;
  // A failed create skips its close: there is no issue to close.
  if (outcome.kind === "failed") return failure(context, `create ${name} failed: ${outcome.reason}`);
  const created = outcome.value;
  context.log.info(`create ${name} -> #${String(created.number)}`);
  const labelled = combine({ ...NOTHING, created: 1 }, await ensureLabel(created, name, closeAfter, context));
  if (!closeAfter) return labelled;
  // The fetch guard refused the label re-add, so it would refuse the close too.
  if (labelled.stopped) return combine(labelled, { ...NOTHING, capped: 1 });
  return combine(labelled, await executeClose(issue, created.number, context));
}

/**
 * Re-adds MIRROR_LABEL when the 201 response lacks it (decision A5), if a write is
 * left after the pending close. Without it the next run still matches the mirror by title.
 */
async function ensureLabel(created: GitHubIssue, name: string, closeAfter: boolean, context: WriteContext): Promise<Tally> {
  const wanted = MIRROR_LABEL.toLowerCase();
  if (created.labelNames.some((label) => label.toLowerCase() === wanted)) return NOTHING;
  const what = `${name} #${String(created.number)}`;
  const notReAdded = `${what} was created without the "${MIRROR_LABEL}" label and it was not re-added`;
  if (context.writer.count() + (closeAfter ? 1 : 0) >= context.maxWrites) {
    context.log.warn(`${notReAdded} (write cap reached)`);
    return NOTHING;
  }
  const outcome = await attemptWrite(() => context.writer.addLabel(created.number));
  switch (outcome.kind) {
    case "ok":
      context.log.info(`label ${what}`);
      return { ...NOTHING, labelsReAdded: 1 };
    case "failed":
      return failure(context, `label ${what} failed: ${outcome.reason}`);
    case "out-of-fetches":
      context.log.warn(`${notReAdded} (fetch guard reached)`);
      return { ...NOTHING, stopped: true };
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
      return failure(context, `close ${what} failed: ${outcome.reason}`);
    case "out-of-fetches":
      return OUT_OF_FETCHES;
  }
}
