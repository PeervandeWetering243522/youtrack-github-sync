/**
 * What each eligible mirror's assignees should be (decisions U4, U6, U15; docs/13 §2.6) and the
 * assignee warnings (U3; §2.10, §5). Mirror-owned: the diff only adds logins matched to the
 * issue's YouTrack users and only removes Users matched to someone this run, so staff, bots and
 * anyone unmatched stay. Warnings name persons by issue id and counts, never by login. Pure.
 */

import { loginKey } from "./assignee-match.ts";
import type { MatchOutcome } from "./assignee-match.ts";
import type { PersonIdentity } from "../utils/student-id.ts";

/** GitHub allows 10 assignees per issue. */
export const GITHUB_MAX_ASSIGNEES = 10;

/** An assignee on the mirror as GitHub reports it: the login verbatim and the account type ("" if absent). */
export type CurrentAssignee = { readonly login: string; readonly type: string };
/** A person and the idReadable of their oldest eligible issue (e.g. "CUI-12"), the name warnings use. */
export type NamedPerson = PersonIdentity & { readonly name: string };
export type AssigneeDiff = {
  readonly add: readonly string[];
  readonly remove: readonly string[];
  /** Desired logins left out of `add` by GitHub's limit (a plan warning). */
  readonly notAdded: number;
};

/** The only account type the mirror ever removes (U4: never a Bot, never an unknown type). */
const USER_TYPE = "User";
const NO_CHANGE: AssigneeDiff = Object.freeze({ add: Object.freeze([]), remove: Object.freeze([]), notAdded: 0 });

/** The aggregated warning's categories in their fixed order (blocked and matched are never listed). */
const CATEGORIES = [
  ["unmatched", "unmatched"],
  ["ambiguous", "ambiguous"],
  ["not-looked-up", "not looked up"],
  ["map-target-not-assignable", "mapped to a login that cannot be assigned"],
] as const satisfies readonly (readonly [MatchOutcome["kind"], string])[];

/** 2.6 desired: matched logins of `users` in order, deduplicated by loginKey. */
export function desiredAssignees(
  users: readonly PersonIdentity[],
  outcomes: ReadonlyMap<string, MatchOutcome>,
): readonly string[] {
  return uniqueByKey(users.flatMap((user) => matchedLogin(outcomes.get(loginKey(user.login)))));
}

/** 2.6 owned: loginKey of every matched login. */
export function ownedLogins(outcomes: ReadonlyMap<string, MatchOutcome>): ReadonlySet<string> {
  return new Set([...outcomes.values()].flatMap(matchedLogin).map(loginKey));
}

/**
 * 2.6 diff; desired [] -> nothing (U6). Adds are the desired logins not on the issue (any
 * type, A-Z case ignored), cut to the slots GitHub's limit leaves before removes run. Removes
 * are the issue's Users whose login is owned and not desired, spelled as the issue spells them.
 */
export function assigneeDiff(
  current: readonly CurrentAssignee[],
  desired: readonly string[],
  owned: ReadonlySet<string>,
): AssigneeDiff {
  if (desired.length === 0) return NO_CHANGE;
  const onIssue = new Set(current.map(({ login }) => loginKey(login)));
  const wanted = new Set(desired.map(loginKey));
  const missing = uniqueByKey(desired).filter((login) => !onIssue.has(loginKey(login)));
  const add = missing.slice(0, Math.max(0, GITHUB_MAX_ASSIGNEES - current.length));
  const remove = current
    .filter(({ login, type }) => type === USER_TYPE && owned.has(loginKey(login)) && !wanted.has(loginKey(login)))
    .map(({ login }) => login);
  return { add, remove, notAdded: missing.length - add.length };
}

/**
 * The aggregated warning of 2.10 and section 5, or null when there is nothing to say: each
 * non-empty category with its count of persons and their distinct issue ids, then the lookup
 * notes after "; ". Blocked (-) and matched persons are never listed.
 */
export function assigneeWarning(
  persons: readonly NamedPerson[],
  outcomes: ReadonlyMap<string, MatchOutcome>,
  notes: readonly string[],
): string | null {
  const categories = CATEGORIES.flatMap(([kind, label]) => {
    const names = persons.filter((person) => outcomeOf(person, outcomes)?.kind === kind).map(({ name }) => name);
    return names.length === 0 ? [] : [`${String(names.length)} ${label} (${[...new Set(names)].join(", ")})`];
  });
  const parts = categories.length === 0 ? notes : [categories.join(", "), ...notes];
  return parts.length === 0 ? null : `assignees: ${parts.join("; ")}`;
}

/**
 * The "none matched" loud warning of 2.10, or null: at least one person is not blocked and
 * nobody matched. It catches anonymized logins after the YouTrack token lost Read User Basic.
 */
export function noneMatchedWarning(
  persons: readonly NamedPerson[],
  outcomes: ReadonlyMap<string, MatchOutcome>,
): string | null {
  const unblocked = persons
    .map((person) => outcomeOf(person, outcomes))
    .filter((outcome) => outcome?.kind !== "blocked");
  if (unblocked.length === 0 || unblocked.some((outcome) => outcome?.kind === "matched")) return null;
  const count = unblocked.length;
  return (
    `assignees: none of the ${String(count)} YouTrack ${count === 1 ? "assignee" : "assignees"} matched a GitHub ` +
    "account; if their YouTrack logins look anonymized, the YouTrack token may lack Read User Basic"
  );
}

function outcomeOf(person: PersonIdentity, outcomes: ReadonlyMap<string, MatchOutcome>): MatchOutcome | undefined {
  return outcomes.get(loginKey(person.login));
}

function matchedLogin(outcome: MatchOutcome | undefined): readonly string[] {
  return outcome?.kind === "matched" ? [outcome.login] : [];
}

/** The first spelling of each loginKey, in order. */
function uniqueByKey(logins: readonly string[]): readonly string[] {
  const firsts = new Map<string, string>();
  for (const login of logins) {
    const key = loginKey(login);
    if (!firsts.has(key)) firsts.set(key, login);
  }
  return [...firsts.values()];
}
