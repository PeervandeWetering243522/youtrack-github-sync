/**
 * The assignee matching chain (decisions U2, U14, U17; docs/13 §2.4): which assignable GitHub
 * login, if any, one YouTrack user gets. Step a is the manual map, b the student ID in an
 * assignable login, c the commit author and d the public-email search of each lookup email.
 * Pure, no I/O: steps c and d only read the lookup answers they are given, and a chain that
 * needs one more says which (src/plan/assignee-lookups.ts orders them, src/sync sends them).
 */

import { lookupEmails, singleStudentId, studentIds } from "../utils/student-id.ts";
import type { PersonIdentity } from "../utils/student-id.ts";

/** ASSIGNEE_MAP (U14): A-Z lowercased YouTrack login -> GitHub login as written; null for "-". */
export type ManualMap = ReadonlyMap<string, string | null>;
/** The steps that need a GitHub request: c (commit author) and d (public-email search). */
export type LookupStep = "commit" | "search";
/** One lookup's answer: the logins GitHub gave, or a failure that skips this (step, email) for the run. */
export type LookupAnswer =
  | { readonly kind: "found"; readonly logins: readonly string[] } // commit: 0 or 1 login
  | { readonly kind: "failed" };
/** Answers so far, keyed by lowercased email, and the steps turned off for the run. */
export type LookupState = {
  readonly commit: ReadonlyMap<string, LookupAnswer>;
  readonly search: ReadonlyMap<string, LookupAnswer>;
  readonly off: ReadonlySet<LookupStep>;
};

export const NO_LOOKUPS: LookupState = Object.freeze({
  commit: new Map<string, LookupAnswer>(),
  search: new Map<string, LookupAnswer>(),
  off: new Set<LookupStep>(),
});

/** `state` plus the answer of one (step, email); the email is keyed A-Z lowercased. */
export function withAnswer(state: LookupState, step: LookupStep, email: string, answer: LookupAnswer): LookupState {
  const answers = new Map([...state[step], [lowerAscii(email), answer]]);
  return step === "commit" ? { ...state, commit: answers } : { ...state, search: answers };
}

/** `state` with `step` off for the rest of the run: it then counts as a step with no result. */
export function withStepOff(state: LookupState, step: LookupStep): LookupState {
  return { ...state, off: new Set([...state.off, step]) };
}

/** assignable: the logins of type User from the assignable list, as GitHub spells them. */
export type MatchBasis = { readonly assignable: readonly string[]; readonly map: ManualMap };
export type MatchContext = MatchBasis & { readonly lookups: LookupState };
export type MatchStep = "map" | "login-id" | "commit" | "search";
export type MatchOutcome =
  | { readonly kind: "matched"; readonly login: string; readonly step: MatchStep }
  | { readonly kind: "blocked" }
  | { readonly kind: "map-target-not-assignable" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "not-looked-up" }
  | { readonly kind: "unmatched" };
export type ChainState =
  | MatchOutcome
  | { readonly kind: "needs-lookup"; readonly step: LookupStep; readonly email: string; readonly ambiguous: boolean };

/** The automatic steps, in chain order. */
const AUTOMATIC_STEPS = ["login-id", "commit", "search"] as const;
type AutomaticStep = (typeof AUTOMATIC_STEPS)[number];

/**
 * One automatic step: its pooled logins (in the assignable list, as the list spells them,
 * deduplicated) and whether a failed lookup was skipped in it; or the email it still waits for.
 */
type StepResult =
  | { readonly kind: "pooled"; readonly logins: readonly string[]; readonly skipped: boolean }
  | { readonly kind: "waits"; readonly step: LookupStep; readonly email: string };

/** The assignable list as the chain reads it, built once per list (see assignableIndex). */
type Assignable = {
  /** loginKey -> the list's first spelling of it, in list order. */
  readonly byKey: ReadonlyMap<string, string>;
  /** The logins of byKey that carry a single student ID, with that ID, in list order (step b). */
  readonly withIds: readonly { readonly login: string; readonly id: string }[];
};

/**
 * Every index built so far, by the identity of its list. The sync stage passes one assignable
 * array for the whole run, so the chain, which runs per person and again per lookup, indexes it
 * and runs the ID regex over it once (the Workers CPU limit), not once per call. Invisible to
 * callers: the lists are readonly, and a WeakMap lets them go.
 */
const ASSIGNABLE_INDEXES = new WeakMap<readonly string[], Assignable>();

/** A-Z lowercased; the key of persons, the map and owned logins. */
export function loginKey(login: string): string {
  return lowerAscii(login);
}

/**
 * 2.4 for one person with the answers so far. The map (a) settles a person with an entry.
 * Otherwise b, c and d run in order and the first single pooled login is the match. The first
 * step with 2 or more logins makes them the candidates C and the chain goes on: a later single
 * login is a match only if it is in C, and one outside C ends the chain as ambiguous. A lookup
 * step is decided only once every lookup email has an answer for it; until then the chain
 * waits (`needs-lookup`). A step that is off counts as no result. Without a match the person is
 * ambiguous if any step was, not-looked-up if a failed lookup was skipped, else unmatched.
 */
export function evaluateChain(person: PersonIdentity, context: MatchContext): ChainState {
  const assignable = assignableIndex(context.assignable);
  const mapped = mapStep(person, context.map, assignable);
  if (mapped !== null) return mapped;

  let candidates: readonly string[] | null = null;
  let skipped = false;
  for (const step of AUTOMATIC_STEPS) {
    const result = stepResult(step, person, context.lookups, assignable);
    if (result.kind === "waits") return { ...result, kind: "needs-lookup", ambiguous: candidates !== null };
    skipped ||= result.skipped;
    const [only, ...others] = result.logins;
    if (only === undefined) continue;
    if (others.length > 0) {
      candidates ??= result.logins;
      continue;
    }
    // Both lists are spelled as the assignable list spells them.
    return candidates === null || candidates.includes(only)
      ? { kind: "matched", login: only, step }
      : { kind: "ambiguous" };
  }
  if (candidates !== null) return { kind: "ambiguous" };
  return { kind: skipped ? "not-looked-up" : "unmatched" };
}

/** needs-lookup -> "ambiguous" if ambiguous so far, else "not-looked-up"; any other state as is. */
export function finalOutcome(state: ChainState): MatchOutcome {
  if (state.kind !== "needs-lookup") return state;
  return { kind: state.ambiguous ? "ambiguous" : "not-looked-up" };
}

/** finalOutcome(evaluateChain(...)) per person, keyed by loginKey(login); the first of two with one key wins. */
export function matchAll(persons: readonly PersonIdentity[], context: MatchContext): ReadonlyMap<string, MatchOutcome> {
  const outcomes = new Map<string, MatchOutcome>();
  for (const person of persons) {
    const key = loginKey(person.login);
    if (!outcomes.has(key)) outcomes.set(key, finalOutcome(evaluateChain(person, context)));
  }
  return outcomes;
}

/** The index of `logins`, built on the first call for that list and reused after. */
function assignableIndex(logins: readonly string[]): Assignable {
  const cached = ASSIGNABLE_INDEXES.get(logins);
  if (cached !== undefined) return cached;
  const byKey = new Map<string, string>();
  for (const login of logins) {
    const key = loginKey(login);
    if (!byKey.has(key)) byKey.set(key, login);
  }
  const withIds = [...byKey.values()].flatMap((login) => {
    const id = singleStudentId(login);
    return id === null ? [] : [{ login, id }];
  });
  const index: Assignable = { byKey, withIds };
  ASSIGNABLE_INDEXES.set(logins, index);
  return index;
}

/** Step a: null when the person has no map entry, so the automatic steps run. */
function mapStep(person: PersonIdentity, map: ManualMap, assignable: Assignable): MatchOutcome | null {
  const target = map.get(loginKey(person.login));
  if (target === undefined) return null;
  if (target === null) return { kind: "blocked" };
  const login = assignable.byKey.get(loginKey(target));
  return login === undefined ? { kind: "map-target-not-assignable" } : { kind: "matched", login, step: "map" };
}

function stepResult(
  step: AutomaticStep,
  person: PersonIdentity,
  lookups: LookupState,
  assignable: Assignable,
): StepResult {
  if (step === "login-id") {
    const ids = studentIds(person);
    if (ids.length === 0) return { kind: "pooled", logins: [], skipped: false };
    const withId = assignable.withIds.filter(({ id }) => ids.includes(id)).map(({ login }) => login);
    return { kind: "pooled", logins: pooled(withId, assignable), skipped: false };
  }
  if (lookups.off.has(step)) return { kind: "pooled", logins: [], skipped: false };
  const emails = lookupEmails(person);
  const answers = emails.map((email) => lookups[step].get(email));
  const missing = emails.find((_, index) => answers[index] === undefined);
  if (missing !== undefined) return { kind: "waits", step, email: missing };
  const logins = answers.flatMap((answer) => (answer?.kind === "found" ? answer.logins : []));
  return { kind: "pooled", logins: pooled(logins, assignable), skipped: answers.some((a) => a?.kind === "failed") };
}

/** The logins that are in the assignable list (A-Z case ignored), spelled as it spells them, deduplicated. */
function pooled(logins: readonly string[], assignable: Assignable): readonly string[] {
  const spelled = logins.map((login) => assignable.byKey.get(loginKey(login)));
  return [...new Set(spelled.filter((login) => login !== undefined))];
}

/** Lowercases A-Z only: toLowerCase() also maps e.g. the Kelvin sign U+212A to "k". */
function lowerAscii(text: string): string {
  return text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}
