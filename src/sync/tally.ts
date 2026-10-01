/**
 * What executed (or previewed) actions did, summed into the run totals with `combine`,
 * plus how log lines name an issue. Shared by the dry-run preview and the write phase.
 */

import type { YouTrackIssue } from "../youtrack.ts";

/** Why the write phase stopped early: the fetch guard ran out, or GitHub rate-limited a write (decision R7). */
export type StopReason = "fetch-guard" | "rate-limit";

/** What executed (or previewed) actions did: one action's result, or several summed with `combine`. */
export type Tally = {
  readonly created: number;
  readonly closed: number;
  /** Closed mirrors reopened because their YouTrack issue is unresolved again (R10). */
  readonly reopened: number;
  /** Sync writes done: `update`, `setParent`, `removeParent` and `renameMilestone` (docs/11 §1.7, N2). */
  readonly updated: number;
  readonly milestonesCreated: number;
  readonly milestonesClosed: number;
  readonly labelsReAdded: number;
  /**
   * Actions left undone by the write cap, the fetch guard, a GitHub rate limit, the run
   * deadline, or a dependency created in this run that did not succeed (D4).
   */
  readonly capped: number;
  readonly failures: readonly string[];
  /** Set when nothing after this may run; the first reason wins. */
  readonly stop: StopReason | null;
};

/** The counting fields of a Tally, one of which an action adds 1 to when it is done. */
export type Counter = "created" | "closed" | "reopened" | "updated" | "milestonesCreated" | "milestonesClosed";

/** The empty Tally: nothing done, capped or failed. */
export const NOTHING: Tally = {
  created: 0,
  closed: 0,
  reopened: 0,
  updated: 0,
  milestonesCreated: 0,
  milestonesClosed: 0,
  labelsReAdded: 0,
  capped: 0,
  failures: [],
  stop: null,
};

/** A planned write the fetch guard refused before sending it: the action is capped and execution stops. */
export const OUT_OF_FETCHES: Tally = { ...NOTHING, capped: 1, stop: "fetch-guard" };

/** One action done, counted in `counter`. */
export function done(counter: Counter): Tally {
  return { ...NOTHING, [counter]: 1 };
}

/** A new Tally with every count of `a` and `b` summed, failures in order, and the first stop reason. */
export function combine(a: Tally, b: Tally): Tally {
  return {
    created: a.created + b.created,
    closed: a.closed + b.closed,
    reopened: a.reopened + b.reopened,
    updated: a.updated + b.updated,
    milestonesCreated: a.milestonesCreated + b.milestonesCreated,
    milestonesClosed: a.milestonesClosed + b.milestonesClosed,
    labelsReAdded: a.labelsReAdded + b.labelsReAdded,
    capped: a.capped + b.capped,
    failures: [...a.failures, ...b.failures],
    stop: a.stop ?? b.stop,
  };
}

/** How issues are named in log lines: the YouTrack id ("CUI-15"), like the mirror title prefix (N1). */
export function mirrorName(issue: YouTrackIssue): string {
  return issue.idReadable;
}

/**
 * How log lines name issue `numberInProject` of the same project as `issue`, e.g. the epic
 * or parent an action depends on: "CUI-33". Decision R4 guarantees that every scanned
 * idReadable is `<project>-<numberInProject>`.
 */
export function projectIssueName(issue: YouTrackIssue, numberInProject: number): string {
  const project = issue.idReadable.slice(0, issue.idReadable.lastIndexOf("-"));
  return `${project}-${String(numberInProject)}`;
}
