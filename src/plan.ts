/**
 * Pure decision logic: GitHub issues + YouTrack issues -> ordered, capped actions.
 */

import type { GitHubIssue, IssueState } from "./github.ts";
import type { YouTrackIssue } from "./youtrack.ts";

export type MirrorRef = {
  readonly issueNumber: number;
  readonly state: IssueState;
  readonly hasLabel: boolean;
};

export type MirrorIndex = ReadonlyMap<number, MirrorRef>;

export type MirrorIndexResult = {
  readonly index: MirrorIndex;
  /** Human-readable warnings (unlabelled title match, duplicates). */
  readonly warnings: readonly string[];
};

export type Action =
  | { readonly kind: "create"; readonly issue: YouTrackIssue; readonly closeAfter: boolean }
  | { readonly kind: "close"; readonly issue: YouTrackIssue; readonly mirror: MirrorRef };

export type Plan = {
  /** In execution order (ascending numberInProject), already capped. */
  readonly actions: readonly Action[];
  /** YouTrack issues scanned. */
  readonly scanned: number;
  /** Issues whose summary lacks the title prefix. */
  readonly filtered: number;
  /** Eligible issues that need no action. */
  readonly unchanged: number;
  /** Actions dropped by the write cap. */
  readonly capped: number;
};

/**
 * Build numberInProject -> mirror from GitHub issues (decision A5, A6):
 * - pull requests are ignored;
 * - titles are parsed with parseMirrorTitle;
 * - a candidate with the `label` beats one without; among equals the lowest issue
 *   number wins; every extra candidate adds a warning;
 * - an unlabelled winner adds a warning ("matched by title only").
 */
export function buildMirrorIndex(issues: readonly GitHubIssue[], label: string): MirrorIndexResult {
  void issues;
  void label;
  throw new Error("not implemented");
}

/** GitHub writes an action costs: create = 1 (+1 if closeAfter), close = 1. */
export function writeCost(action: Action): number {
  void action;
  throw new Error("not implemented");
}

/**
 * - skip issues without the title prefix (filtered);
 * - no mirror -> create (closeAfter = resolved !== null);
 * - mirror open && resolved !== null -> close;
 * - otherwise unchanged (no reopen, no title/body updates);
 * - order by ascending numberInProject; take actions while their cost fits in
 *   maxWrites; at the first action that does not fit, stop -- it and everything
 *   after it count as capped (a create+close pair is never split).
 */
export function planActions(input: {
  readonly youtrackIssues: readonly YouTrackIssue[];
  readonly mirrors: MirrorIndex;
  readonly titlePrefix: string;
  readonly maxWrites: number;
}): Plan {
  void input;
  throw new Error("not implemented");
}
