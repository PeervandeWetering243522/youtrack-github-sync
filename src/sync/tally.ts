/**
 * What executed (or previewed) actions did, summed into the run totals with `combine`,
 * plus how log lines name an issue. Shared by the dry-run preview and the write phase.
 */

import type { YouTrackIssue } from "../youtrack.ts";

export type Tally = {
  readonly created: number;
  readonly closed: number;
  readonly labelsReAdded: number;
  /** Actions (or the close of a create+close pair) left undone by the write cap or the fetch guard. */
  readonly capped: number;
  readonly failures: readonly string[];
  /** The fetch guard ran out: nothing after this may run. */
  readonly stopped: boolean;
};

export const NOTHING: Tally = { created: 0, closed: 0, labelsReAdded: 0, capped: 0, failures: [], stopped: false };

/** A planned write the fetch guard refused before sending it: the action is capped and execution stops. */
export const OUT_OF_FETCHES: Tally = { ...NOTHING, capped: 1, stopped: true };

export function combine(a: Tally, b: Tally): Tally {
  return {
    created: a.created + b.created,
    closed: a.closed + b.closed,
    labelsReAdded: a.labelsReAdded + b.labelsReAdded,
    capped: a.capped + b.capped,
    failures: [...a.failures, ...b.failures],
    stopped: a.stopped || b.stopped,
  };
}

/** How issues are named in log lines; numbers only, like the mirror title prefix. */
export function mirrorName(issue: YouTrackIssue): string {
  return `YT-${String(issue.numberInProject)}`;
}
