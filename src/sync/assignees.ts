/**
 * The assignee stage of a run (docs/13 §2.2-2.5, §2.10; U3, U4, U6, U15-U17), between the reads
 * and the plan: which YouTrack users of the eligible issues get which assignable GitHub login,
 * and which logins the mirror owns (those and the no-lookup matches of every scanned user). It
 * sends read 4 (the assignable list) and read 5 (the lookups), and catches every error of both:
 * an unreadable list skips assignee sync with one warning (U16); a failed lookup turns its step
 * off, skips that email or stops the lookups (§2.5), and is never fatal and never a failed write
 * (A10). Warnings carry issue ids, counts and statuses, never a login, an email or an error
 * message (U8). The stage also returns every identity the run saw, for the identity redactor
 * (§2.11). Matching itself is pure (src/plan/assignee-*.ts).
 */

import type { Config } from "../config.ts";
import { listAssignableUsers } from "../github/assignees.ts";
import type { GitHubAssignee } from "../github/assignees.ts";
import type { GitHubTarget } from "../github/client.ts";
import { findCommitAuthor, searchUsersByEmail } from "../github/users.ts";
import {
  DEFAULT_MAX_RETRY_AFTER_MS,
  DEFAULT_TIMEOUT_MS,
  FetchBudgetExceededError,
  HttpError,
  NetworkError,
} from "../http.ts";
import type { HttpClient } from "../http.ts";
import type { AssigneeSync } from "../plan.ts";
import { lookupBudget, lookupOrder, nextLookup, rotationIndex } from "../plan/assignee-lookups.ts";
import type { PlannedLookup } from "../plan/assignee-lookups.ts";
import { loginKey, LOOKUPS_OFF, matchAll, NO_LOOKUPS, withAnswer, withStepOff } from "../plan/assignee-match.ts";
import type { LookupAnswer, LookupState, LookupStep, MatchBasis, MatchOutcome } from "../plan/assignee-match.ts";
import { assigneeEligible } from "../plan/assignee-scope.ts";
import { assigneeWarning, desiredAssignees, noneMatchedWarning, ownedLogins } from "../plan/assignees.ts";
import type { NamedPerson } from "../plan/assignees.ts";
import type { MirrorIndex } from "../plan/mirrors.ts";
import { lookupEmails } from "../utils/student-id.ts";
import { YOUTRACK_ASSIGNEE_FIELD } from "../youtrack.ts";
import type { ScannedIssue, YouTrackUser } from "../youtrack.ts";

/**
 * A lookup starts only this long before the run deadline: one worst-case request, two
 * timeouts and the longest retry wait (src/http.ts).
 */
export const LOOKUP_DEADLINE_MARGIN_MS = 2 * DEFAULT_TIMEOUT_MS + DEFAULT_MAX_RETRY_AFTER_MS;

/** What the stage hands the run: the planner's input, the identities to redact and the warnings to log. */
export type AssigneeStage = {
  /** Null: no assignee action this run (switch off, field missing, nobody to match, list unreadable). */
  readonly sync: AssigneeSync | null;
  /** Every login and email the run saw (docs/13 §2.11); duplicates allowed. */
  readonly identities: readonly string[];
  /** In logging order: the aggregated warning, then the loud ones (§2.10). */
  readonly warnings: readonly string[];
};

/** What the stage reads of the run. */
export type AssigneeRun = {
  readonly config: Config;
  readonly http: HttpClient;
  readonly target: GitHubTarget;
  /** Current time, epoch ms. */
  readonly now: () => number;
  /** The run deadline (R8), epoch ms; lookups stop LOOKUP_DEADLINE_MARGIN_MS before it. */
  readonly deadline: number;
};

/** What the stage reads of reads 1-3. */
export type AssigneeInputs = {
  readonly mirrors: MirrorIndex;
  readonly youtrackIssues: readonly ScannedIssue[];
};

/** The switch is off (U1): nothing read, nothing matched, nothing to say. */
export const NO_ASSIGNEE_STAGE: AssigneeStage = { sync: null, identities: [], warnings: [] };

const FIELD_MISSING =
  `assignees: no scanned issue has an "${YOUTRACK_ASSIGNEE_FIELD}" field, so no assignee is changed; check the ` +
  "field name in YouTrack, or set SYNC_ASSIGNEES (input sync-assignees) to false";

/** A commit lookup answered with one of these (not a rate limit) lacks Contents read: the Action without `contents: read`. */
const NO_ACCESS_STATUSES: readonly number[] = [403, 404];
/** GitHub answers 409 for the commits of an empty repository. */
const HTTP_CONFLICT = 409;

/**
 * Reads 4 and 5 and the matching chain for the eligible issues' YouTrack users (docs/13 §2.3).
 * Read 4 is sent only when a scanned row has the Assignee field and an eligible issue has a
 * user; no row with the field (with at least one row) is a loud warning instead. Never throws
 * for a read: see the module comment.
 */
export async function readAssignees(run: AssigneeRun, inputs: AssigneeInputs): Promise<AssigneeStage> {
  if (!run.config.syncAssignees) return NO_ASSIGNEE_STAGE;
  const rotation = rotationIndex(run.now());
  const seen = seenIdentities(inputs, run.config);
  const { youtrackIssues } = inputs;
  if (youtrackIssues.length > 0 && !youtrackIssues.some(({ assignee }) => assignee.kind === "users")) {
    return { sync: null, identities: seen, warnings: [FIELD_MISSING] };
  }
  const eligible = eligibleIssues(inputs, run.config.excludePrefix);
  const persons = personsOf(eligible);
  if (persons.length === 0) return { sync: null, identities: seen, warnings: [] };
  const list = await readAssignable(run);
  if (list.kind === "failed") return { sync: null, identities: seen, warnings: [unreadableWarning(list.detail)] };
  const basis: MatchBasis = { assignable: userLogins(list.users), map: run.config.assigneeMap };
  const lookups = await runLookups(run, persons, basis, rotation);
  const outcomes = matchAll(persons, { ...basis, lookups: lookups.state });
  const warnings = [assigneeWarning(persons, outcomes, lookups.notes), noneMatchedWarning(persons, outcomes)];
  return {
    sync: assigneeSync(eligible, outcomes, ownedOf(youtrackIssues, outcomes, basis)),
    identities: [...seen, ...list.users.map(({ login }) => login), ...answeredLogins(lookups.state)],
    warnings: warnings.filter((warning) => warning !== null),
  };
}

// ---------------------------------------------------------------------------
// Persons and the planner's input

/** The eligible issues (assigneeEligible), one row per number, ascending. */
function eligibleIssues(inputs: AssigneeInputs, excludePrefix: string): readonly ScannedIssue[] {
  const eligible = assigneeEligible({ youtrackIssues: inputs.youtrackIssues, mirrors: inputs.mirrors, excludePrefix });
  const seen = new Set<number>();
  const rows = inputs.youtrackIssues.filter(({ numberInProject }) => {
    if (!eligible.has(numberInProject) || seen.has(numberInProject)) return false;
    seen.add(numberInProject);
    return true;
  });
  return rows.toSorted((a, b) => a.numberInProject - b.numberInProject);
}

function usersOf(issue: ScannedIssue): readonly YouTrackUser[] {
  return issue.assignee.kind === "users" ? issue.assignee.users : [];
}

/**
 * The distinct users of `issues` (ascending), keyed by loginKey, in the order of their first
 * issue and then of its value; each named by that issue's id (docs/13 §2.3).
 */
function personsOf(issues: readonly ScannedIssue[]): readonly NamedPerson[] {
  const persons = new Map<string, NamedPerson>();
  for (const issue of issues) {
    for (const { login, email } of usersOf(issue)) {
      const key = loginKey(login);
      if (!persons.has(key)) persons.set(key, { login, email, name: issue.idReadable });
    }
  }
  return [...persons.values()];
}

/** desiredAssignees per eligible issue (left out when empty), with the run's owned logins. */
function assigneeSync(
  eligible: readonly ScannedIssue[],
  outcomes: ReadonlyMap<string, MatchOutcome>,
  owned: ReadonlySet<string>,
): AssigneeSync {
  const desired = new Map<number, readonly string[]>();
  for (const issue of eligible) {
    const logins = desiredAssignees(usersOf(issue), outcomes);
    if (logins.length > 0) desired.set(issue.numberInProject, logins);
  }
  return { desired, owned };
}

/**
 * The owned logins (U4, §2.6): every login matched to a person of the eligible issues, plus
 * every login the map or step b matches to a user of any scanned Assignee value (resolved
 * issues, closed mirrors and epics too), so an old assignee whose open issues all went to
 * someone else is still removed. Those users get no lookup: one only a lookup would match is
 * not owned, and someone YouTrack names on no issue at all cannot be owned.
 */
function ownedOf(
  scanned: readonly ScannedIssue[],
  outcomes: ReadonlyMap<string, MatchOutcome>,
  basis: MatchBasis,
): ReadonlySet<string> {
  const others = matchAll(personsOf(scanned), { ...basis, lookups: LOOKUPS_OFF });
  return new Set([...ownedLogins(outcomes), ...ownedLogins(others)]);
}

/** The logins of the assignable list's Users, as GitHub spells them (Bots and others never match). */
function userLogins(users: readonly GitHubAssignee[]): readonly string[] {
  return users.filter(({ type }) => type === "User").map(({ login }) => login);
}

/**
 * Identities known before reads 4 and 5: every user of every scanned Assignee value (epics and
 * ineligible issues too) with their lookup emails, every assignee of every mirror, and every
 * map key and value.
 */
function seenIdentities(inputs: AssigneeInputs, config: Config): readonly string[] {
  const users = inputs.youtrackIssues.flatMap(usersOf);
  return [
    ...users.flatMap((user) => [user.login, ...(user.email === null ? [] : [user.email]), ...lookupEmails(user)]),
    ...[...inputs.mirrors.values()].flatMap(({ assignees }) => assignees.map(({ login }) => login)),
    ...[...config.assigneeMap].flatMap(([key, value]) => (value === null ? [key] : [key, value])),
  ];
}

function answeredLogins(state: LookupState): readonly string[] {
  return [...state.commit.values(), ...state.search.values()].flatMap((answer) =>
    answer.kind === "found" ? answer.logins : [],
  );
}

// ---------------------------------------------------------------------------
// Read 4: the assignable list

type ListRead =
  | { readonly kind: "ok"; readonly users: readonly GitHubAssignee[] }
  | { readonly kind: "failed"; readonly detail: string };

async function readAssignable(run: AssigneeRun): Promise<ListRead> {
  try {
    return { kind: "ok", users: await listAssignableUsers(run.http, run.target) };
  } catch (error) {
    return { kind: "failed", detail: failureDetail(error instanceof Error ? error : null) };
  }
}

function unreadableWarning(detail: string): string {
  return `assignees: could not read the assignable GitHub users (${detail}); assignees are not synced this run`;
}

/** What a log may say about a failed read (null: not an Error): its status or kind, never its message (U8). */
function failureDetail(error: Error | null): string {
  if (error instanceof FetchBudgetExceededError) return "fetch guard reached";
  if (error instanceof HttpError) return `HTTP ${String(error.status)}`;
  return error instanceof NetworkError ? "network error" : "unexpected response";
}

// ---------------------------------------------------------------------------
// Read 5: the lookups (§2.5)

type LookupRun = { readonly state: LookupState; readonly notes: readonly string[] };

/** What one lookup did to the run's lookups. */
type LookupEffect =
  | { readonly kind: "answer"; readonly answer: LookupAnswer; readonly failure: string | null }
  | { readonly kind: "step-off"; readonly note: string }
  | { readonly kind: "stop"; readonly note: string };

/**
 * Sends the lookups the persons' chains wait for, in lookupOrder (rotated by `rotation`), each
 * (step, email) once, while the fetch growth is below the bound measured before the first one
 * and the deadline margin allows. Returns the answers and the notes for the aggregated warning.
 */
async function runLookups(
  run: AssigneeRun,
  persons: readonly NamedPerson[],
  basis: MatchBasis,
  rotation: number,
): Promise<LookupRun> {
  const order = lookupOrder(persons, basis, rotation);
  if (order.length === 0) return { state: NO_LOOKUPS, notes: [] };
  const bound = lookupBudget(run.http.remainingFetches(), run.config.maxWritesPerRun);
  const start = run.http.fetchCount();
  let state = NO_LOOKUPS;
  const notes: string[] = [];
  const failures: string[] = [];
  let next = nextLookup(order, { ...basis, lookups: state });
  while (next !== null) {
    const stop = stopBefore(run, bound, run.http.fetchCount() - start);
    if (stop !== null) {
      notes.push(stop);
      break;
    }
    const effect = await lookUp(run, next);
    if (effect.kind === "stop") {
      notes.push(effect.note);
      break;
    }
    if (effect.kind === "step-off") {
      notes.push(effect.note);
      state = withStepOff(state, next.step);
    } else {
      if (effect.failure !== null) failures.push(effect.failure);
      state = withAnswer(state, next.step, next.email, effect.answer);
    }
    next = nextLookup(order, { ...basis, lookups: state });
  }
  return { state, notes: failures.length === 0 ? notes : [...notes, failedNote(failures)] };
}

/** Why no further lookup may start, or null: the bound is used up, or the deadline margin is reached. */
function stopBefore(run: AssigneeRun, bound: number, growth: number): string | null {
  if (growth >= bound)
    return bound === 0 ? "no lookup budget left by the write cap" : `lookup budget of ${String(bound)} used up`;
  return run.now() < run.deadline - LOOKUP_DEADLINE_MARGIN_MS ? null : "lookups stopped at the run deadline";
}

async function lookUp(run: AssigneeRun, lookup: PlannedLookup): Promise<LookupEffect> {
  try {
    const logins =
      lookup.step === "commit"
        ? [await findCommitAuthor(run.http, run.target, lookup.email)].filter((login) => login !== null)
        : await searchUsersByEmail(run.http, run.target, lookup.email);
    return { kind: "answer", answer: { kind: "found", logins }, failure: null };
  } catch (error) {
    return lookupFailure(lookup.step, error instanceof Error ? error : null);
  }
}

/**
 * docs/13 §2.5 "Failures" for an error (null: not an Error): only the status is kept, never
 * the message, whose URL holds the email. Anything not named here skips that (step, email).
 */
function lookupFailure(step: LookupStep, error: Error | null): LookupEffect {
  if (error instanceof FetchBudgetExceededError) return { kind: "stop", note: "lookups stopped: fetch guard reached" };
  if (error instanceof HttpError && error.rateLimited) {
    return step === "commit"
      ? { kind: "stop", note: "lookups stopped: GitHub rate limit" }
      : { kind: "step-off", note: "email search off: GitHub rate limit" };
  }
  if (step === "commit" && error instanceof HttpError && NO_ACCESS_STATUSES.includes(error.status)) {
    const note = `commit lookups off: the token lacks Contents read (HTTP ${String(error.status)})`;
    return { kind: "step-off", note };
  }
  if (step === "commit" && error instanceof HttpError && error.status === HTTP_CONFLICT) {
    return { kind: "step-off", note: `commit lookups off (HTTP ${String(HTTP_CONFLICT)})` };
  }
  return { kind: "answer", answer: { kind: "failed" }, failure: failureDetail(error) };
}

/** "2 lookups failed (HTTP 502, network error)": each distinct failure once. */
function failedNote(failures: readonly string[]): string {
  const count = failures.length;
  return `${String(count)} ${count === 1 ? "lookup" : "lookups"} failed (${[...new Set(failures)].join(", ")})`;
}
