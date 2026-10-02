/**
 * Which lookup the assignee stage sends next (decision U17, docs/13 §2.5): the bound on
 * lookups per run, the rotation that keeps anyone past the first few from starving, and the
 * depth-first order (a person's step c emails, then their step d emails, then the next person).
 * Pure, no I/O and no clock: the sync stage passes the fetch count and the time in.
 */

import { evaluateChain, NO_LOOKUPS } from "./assignee-match.ts";
import type { LookupStep, MatchBasis, MatchContext } from "./assignee-match.ts";
import type { PersonIdentity } from "../utils/student-id.ts";

export const MAX_LOOKUPS_PER_RUN = 5;
/** Fetches kept free beyond the write cap, so lookups never eat into the writes' share of the guard. */
export const LOOKUP_FETCH_RESERVE = 2;
/** The rotation advances once per cron period (10 minutes). */
export const LOOKUP_ROTATION_MS = 600_000;

export type PlannedLookup = { readonly step: LookupStep; readonly email: string };

/** max(0, min(MAX_LOOKUPS_PER_RUN, remainingFetches - maxWrites - LOOKUP_FETCH_RESERVE)). */
export function lookupBudget(remainingFetches: number, maxWrites: number): number {
  return Math.max(0, Math.min(MAX_LOOKUPS_PER_RUN, remainingFetches - maxWrites - LOOKUP_FETCH_RESERVE));
}

/** floor(now / LOOKUP_ROTATION_MS). */
export function rotationIndex(now: number): number {
  return Math.floor(now / LOOKUP_ROTATION_MS);
}

/**
 * The persons that need a lookup with no answers yet, in input order, rotated left by rotation
 * mod n. Persons the map or step b settles, and those without any lookup email, are left out.
 */
export function lookupOrder<P extends PersonIdentity>(
  persons: readonly P[],
  basis: MatchBasis,
  rotation: number,
): readonly P[] {
  const context: MatchContext = { ...basis, lookups: NO_LOOKUPS };
  const waiting = persons.filter((person) => evaluateChain(person, context).kind === "needs-lookup");
  if (waiting.length === 0) return [];
  const shift = ((rotation % waiting.length) + waiting.length) % waiting.length;
  return [...waiting.slice(shift), ...waiting.slice(0, shift)];
}

/**
 * The first person in `order` whose chain waits for a lookup, and that lookup; null: none needed.
 * An answer is shared by every person with that email, so each (step, email) is asked for once.
 */
export function nextLookup(order: readonly PersonIdentity[], context: MatchContext): PlannedLookup | null {
  for (const person of order) {
    const state = evaluateChain(person, context);
    if (state.kind === "needs-lookup") return { step: state.step, email: state.email };
  }
  return null;
}
