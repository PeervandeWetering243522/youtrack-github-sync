/**
 * Write primitives of the write phase: the GitHub writer (every write serial and
 * WRITE_PAUSE_MS apart) and how one write's outcome becomes a Tally: done, failed
 * (decision A10), rate-limited (R7), refused by the fetch guard, or waiting for a
 * dependency that was not created in this run (D4). Only src/sync.ts builds the writer, and
 * only when dry run is off.
 */

import { addAssignees, removeAssignees } from "../github/assignees.ts";
import type { GitHubAssignee } from "../github/assignees.ts";
import { MIRROR_LABEL } from "../github/client.ts";
import type { GitHubTarget } from "../github/client.ts";
import { addLabel, closeIssue, createIssue, reopenIssue, updateIssue } from "../github/issues.ts";
import type { CreateIssueBody, GitHubIssue, IssueUpdate } from "../github/issues.ts";
import { closeMilestone, createMilestone, renameMilestone } from "../github/milestones.ts";
import type { GitHubMilestone, NewMilestone } from "../github/milestones.ts";
import { addSubIssue, removeSubIssue } from "../github/sub-issues.ts";
import { FetchBudgetExceededError, HttpError } from "../http.ts";
import type { HttpClient } from "../http.ts";
import type { Redact } from "../utils/redact.ts";
import type { Logger } from "./log.ts";
import type { Resolved } from "./resolved.ts";
import { done, NOTHING, OUT_OF_FETCHES } from "./tally.ts";
import type { Counter, Tally } from "./tally.ts";

/** Pause between GitHub writes (GitHub best practice: serial, >= 1 s apart). */
export const WRITE_PAUSE_MS = 1_000;

/**
 * GitHub writes, sent one at a time and WRITE_PAUSE_MS apart. Creates are never retried;
 * every other write is retried once (all idempotent; see src/github/).
 */
export type GitHubWriter = {
  readonly create: (body: CreateIssueBody) => Promise<GitHubIssue>;
  readonly close: (issueNumber: number) => Promise<void>;
  readonly reopen: (issueNumber: number) => Promise<void>;
  readonly addLabel: (issueNumber: number) => Promise<void>;
  /** PATCH title, milestone and/or type; resolves to the issue GitHub answered with. */
  readonly update: (issueNumber: number, patch: IssueUpdate) => Promise<GitHubIssue>;
  /** Puts issue `childId` (REST id) under #parentNumber, replacing any current parent (replace_parent). */
  readonly addSubIssue: (parentNumber: number, childId: number) => Promise<void>;
  /** Takes issue `childId` (REST id) out from under #parentNumber. */
  readonly removeSubIssue: (parentNumber: number, childId: number) => Promise<void>;
  readonly createMilestone: (milestone: NewMilestone) => Promise<GitHubMilestone>;
  readonly renameMilestone: (milestoneNumber: number, title: string) => Promise<void>;
  readonly closeMilestone: (milestoneNumber: number) => Promise<void>;
  /** POST `logins` to #issueNumber's assignees (U5); resolves to the assignees GitHub answered with. */
  readonly addAssignees: (issueNumber: number, logins: readonly string[]) => Promise<readonly GitHubAssignee[]>;
  /** DELETE `logins` from #issueNumber's assignees; resolves to the assignees GitHub answered with. */
  readonly removeAssignees: (issueNumber: number, logins: readonly string[]) => Promise<readonly GitHubAssignee[]>;
  /** Writes attempted so far; each one counts against MAX_WRITES_PER_RUN. */
  readonly count: () => number;
};

/** What every write of one run shares. */
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

/** One executed action: what it did, and the resolution map for the actions after it. */
export type Step = { readonly tally: Tally; readonly resolved: Resolved };

/** A write that did not succeed: sent and failed, rate-limited, or refused by the fetch guard before sending. */
export type NotWritten =
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "rate-limited"; readonly reason: string }
  | { readonly kind: "out-of-fetches" };

/** How one write ended. */
export type WriteOutcome<T> = { readonly kind: "ok"; readonly value: T } | NotWritten;

type Failed = Extract<NotWritten, { readonly reason: string }>;

/** The only GitHub writer; every write goes through its serial, paused `send`. */
export function githubWriter(
  http: HttpClient,
  target: GitHubTarget,
  sleep: (ms: number) => Promise<void>,
): GitHubWriter {
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
    reopen: (issueNumber) => send(() => reopenIssue(http, target, issueNumber)),
    addLabel: (issueNumber) => send(() => addLabel(http, target, issueNumber, MIRROR_LABEL)),
    update: (issueNumber, patch) => send(() => updateIssue(http, target, issueNumber, patch)),
    addSubIssue: (parentNumber, childId) => send(() => addSubIssue(http, target, parentNumber, childId, true)),
    removeSubIssue: (parentNumber, childId) => send(() => removeSubIssue(http, target, parentNumber, childId)),
    createMilestone: (milestone) => send(() => createMilestone(http, target, milestone)),
    renameMilestone: (milestoneNumber, title) => send(() => renameMilestone(http, target, milestoneNumber, title)),
    closeMilestone: (milestoneNumber) => send(() => closeMilestone(http, target, milestoneNumber)),
    addAssignees: (issueNumber, logins) => send(() => addAssignees(http, target, issueNumber, logins)),
    removeAssignees: (issueNumber, logins) => send(() => removeAssignees(http, target, issueNumber, logins)),
    count: () => writes,
  };
}

/**
 * A failed write becomes a value. FetchBudgetExceededError is told apart: the client throws
 * it before sending anything. So is an HttpError GitHub marked as rate-limited (decision R7).
 * Any other write that was sent and failed is a plain failure, also when its retry was
 * skipped because the budget could not pay for it (decision A10).
 */
export async function attemptWrite<T>(write: () => Promise<T>): Promise<WriteOutcome<T>> {
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
 * Logs and records one failed write as "<what> failed: <reason>"; the run throws at the end
 * (decision A10). A rate-limited write also stops the write phase (decision R7).
 */
export function failure(context: WriteContext, what: string, outcome: Failed): Tally {
  const redacted = context.redact(`${what} failed: ${outcome.reason}`);
  context.log.error(redacted);
  return { ...NOTHING, failures: [redacted], stop: outcome.kind === "rate-limited" ? "rate-limit" : null };
}

/** The Tally of a write that did not succeed: capped and stopping if the fetch guard refused it, else a failure. */
export function notWritten(context: WriteContext, what: string, outcome: NotWritten): Tally {
  return outcome.kind === "out-of-fetches" ? OUT_OF_FETCHES : failure(context, what, outcome);
}

/** Sends a write whose answer is not needed; when it succeeds, logs `what` and counts it in `counter`. */
export async function sendWrite(
  context: WriteContext,
  what: string,
  write: () => Promise<void>,
  counter: Counter,
): Promise<Tally> {
  const outcome = await attemptWrite(write);
  if (outcome.kind !== "ok") return notWritten(context, what, outcome);
  context.log.info(what);
  return done(counter);
}

/**
 * D4: the action `what` waits for `dependency`, which was not created in this run (its
 * create failed or waited itself). Nothing is sent; the action is capped with a warning, not
 * failed, and the next run does it once the dependency exists.
 */
export function waitsFor(context: WriteContext, what: string, dependency: string): Tally {
  context.log.warn(`${what} capped: ${dependency} was not created in this run`);
  return { ...NOTHING, capped: 1 };
}
