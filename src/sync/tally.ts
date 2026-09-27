/**
 * What executed (or previewed) actions did, summed into the run totals with `combine`,
 * plus how log lines name an issue. Shared by the dry-run preview and the write phase.
 */

import type { YouTrackIssue } from "../youtrack.ts";

/** Why the write phase stopped early: the fetch guard ran out, or GitHub rate-limited a write (decision R7). */
export type StopReason = "fetch-guard" | "rate-limit";

export type Tally = {
  readonly created: number;
  readonly closed: number;
  readonly labelsReAdded: number;
  /** Actions left undone by the write cap, the fetch guard, a GitHub rate limit or the run deadline. */
  readonly capped: number;
  readonly failures: readonly string[];
  /** Set when nothing after this may run; the first reason wins. */
  readonly stop: StopReason | null;
};

export const NOTHING: Tally = { created: 0, closed: 0, labelsReAdded: 0, capped: 0, failures: [], stop: null };

/** A planned write the fetch guard refused before sending it: the action is capped and execution stops. */
export const OUT_OF_FETCHES: Tally = { ...NOTHING, capped: 1, stop: "fetch-guard" };

export function combine(a: Tally, b: Tally): Tally {
  return {
    created: a.created + b.created,
    closed: a.closed + b.closed,
    labelsReAdded: a.labelsReAdded + b.labelsReAdded,
    capped: a.capped + b.capped,
    failures: [...a.failures, ...b.failures],
    stop: a.stop ?? b.stop,
  };
}

/** How issues are named in log lines; numbers only, like the mirror title prefix. */
export function mirrorName(issue: YouTrackIssue): string {
  return `YT-${String(issue.numberInProject)}`;
}
