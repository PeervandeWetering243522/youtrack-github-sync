/**
 * The assignee writes of the write phase (docs/13 §2.7-2.8; U4, U5, D4): add matched logins to
 * an open mirror, existing or created earlier in this run, and remove owned logins from an
 * existing one. Both are retried once (adding or removing twice changes nothing). The answer's
 * assignees are checked against what was sent, ignoring A-Z case: a mismatch gets one warning
 * with counts only and no extra write, and the write still counts as done. Log lines name
 * counts, never a login (U8); an HttpError whose excerpt fills the cut loses its trailing
 * login-like characters first, since half a login escapes the identity redactor (§2.11).
 */

import type { GitHubAssignee } from "../github/assignees.ts";
import { BODY_EXCERPT_CHARS, HttpError } from "../http.ts";
import { loginKey } from "../plan/assignee-match.ts";
import { assigneeCount, describeAddAssignees, describeRemoveAssignees } from "./describe.ts";
import type { AddAssigneesAction, RemoveAssigneesAction } from "./describe.ts";
import { attemptWrite, notWritten, waitsFor } from "./execute-write.ts";
import type { WriteContext } from "./execute-write.ts";
import { mirrorFor } from "./resolved.ts";
import type { Resolved } from "./resolved.ts";
import { done, mirrorName } from "./tally.ts";
import type { Tally } from "./tally.ts";

/** The characters of a login or an email, at the very end of a text. */
const TRAILING_IDENTITY = /[A-Za-z0-9._%+@-]+$/;

/**
 * POST the logins to the mirror of `action.issue`, resolved from the run-local map: an existing
 * mirror, or one created earlier in this run. A mirror whose create failed or waited caps the
 * add with a warning (D4) and sends nothing.
 */
export async function executeAddAssignees(
  action: AddAssigneesAction,
  context: WriteContext,
  resolved: Resolved,
): Promise<Tally> {
  const { issue, logins } = action;
  const mirror = mirrorFor(resolved, issue.numberInProject, issue);
  if (!mirror.found) return waitsFor(context, `add ${assigneeCount(logins)} to ${mirrorName(issue)}`, mirror.missing);
  const { issueNumber } = mirror.value;
  const what = describeAddAssignees(resolved, action);
  const outcome = await attemptWrite(() => trimmingCutLogins(() => context.writer.addAssignees(issueNumber, logins)));
  if (outcome.kind !== "ok") return notWritten(context, what, outcome);
  context.log.info(what);
  const dropped = logins.filter((login) => !holds(outcome.value, login)).length;
  if (dropped > 0) warnMismatch(context, action, issueNumber, `dropped ${String(dropped)} of ${total(logins)} on add`);
  return done("assigneesAdded");
}

/** DELETE the logins from the existing mirror of `action.issue`. */
export async function executeRemoveAssignees(action: RemoveAssigneesAction, context: WriteContext): Promise<Tally> {
  const { mirror, logins } = action;
  const what = describeRemoveAssignees(action);
  const write = (): Promise<readonly GitHubAssignee[]> => context.writer.removeAssignees(mirror.issueNumber, logins);
  const outcome = await attemptWrite(() => trimmingCutLogins(write));
  if (outcome.kind !== "ok") return notWritten(context, what, outcome);
  context.log.info(what);
  const kept = logins.filter((login) => holds(outcome.value, login)).length;
  if (kept > 0) warnMismatch(context, action, mirror.issueNumber, `kept ${String(kept)} of ${total(logins)} on remove`);
  return done("assigneesRemoved");
}

/**
 * Runs `write`; an HttpError it throws is passed on with its excerpt trimmed when the excerpt
 * fills the cut (cutUtf16 may stop one short to keep a surrogate pair whole): the trailing run
 * of login and email characters goes, since it may be the first half of a login. Status, URL
 * and rateLimited stay, so failure handling (A10) and the rate-limit stop (R7) see the same error.
 */
async function trimmingCutLogins<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (!(error instanceof HttpError) || error.bodyExcerpt.length < BODY_EXCERPT_CHARS - 1) throw error;
    const excerpt = error.bodyExcerpt.replace(TRAILING_IDENTITY, "");
    throw new HttpError(error.method, error.url, error.status, excerpt, error.rateLimited);
  }
}

/** True when `assignees` holds `login`, A-Z case ignored (GitHub answers in its own spelling, live). */
function holds(assignees: readonly GitHubAssignee[], login: string): boolean {
  const key = loginKey(login);
  return assignees.some((assignee) => loginKey(assignee.login) === key);
}

/** "2 assignees": the count the warning says how many of were affected. */
function total(logins: readonly string[]): string {
  return `${String(logins.length)} assignees`;
}

/** "CUI-12 #21: GitHub dropped 1 of 1 assignees on add; the next run tries again" (counts only). */
function warnMismatch(
  context: WriteContext,
  action: AddAssigneesAction | RemoveAssigneesAction,
  issueNumber: number,
  what: string,
): void {
  context.log.warn(`${mirrorName(action.issue)} #${String(issueNumber)}: GitHub ${what}; the next run tries again`);
}
