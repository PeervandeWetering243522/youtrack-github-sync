/**
 * Pure decision logic: GitHub issues + YouTrack issues -> ordered, capped actions.
 */

import type { GitHubIssue, IssueState } from "./github.ts";
import { hasTitlePrefix, parseMirrorTitle } from "./mirror.ts";
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
  /**
   * Actions dropped by the write cap, plus 1 for a create+close pair taken as a plain
   * create because only the create fit (its close waits for the next run, decision R6).
   */
  readonly capped: number;
};

/** A GitHub issue whose title names a YouTrack issue. */
type Candidate = { readonly numberInProject: number; readonly ref: MirrorRef };

/** All candidates for one YouTrack issue: the best ranked one and the rest, in rank order. */
type CandidateGroup = {
  readonly numberInProject: number;
  readonly winner: MirrorRef;
  readonly ignored: readonly MirrorRef[];
};

/**
 * Build numberInProject -> mirror from GitHub issues (decision A5, A6):
 * - pull requests are ignored;
 * - titles are parsed with parseMirrorTitle;
 * - a candidate with the `label` beats one without; among equals the lowest issue
 *   number wins; every extra candidate adds a warning;
 * - an unlabelled winner adds a warning ("matched by title only").
 * Label names compare case-insensitively, as GitHub matches them (docs/03, gotcha 14).
 */
export function buildMirrorIndex(issues: readonly GitHubIssue[], label: string): MirrorIndexResult {
  const index = new Map<number, MirrorRef>();
  const warnings: string[] = [];
  for (const { numberInProject, winner, ignored } of groupCandidates(mirrorCandidates(issues, label))) {
    index.set(numberInProject, winner);
    if (!winner.hasLabel) warnings.push(titleOnlyWarning(numberInProject, winner, label));
    const count = ignored.length + 1;
    for (const ref of ignored) warnings.push(duplicateWarning(numberInProject, count, winner, ref));
  }
  return { index, warnings };
}

/** GitHub writes an action costs: create = 1 (+1 if closeAfter), close = 1. */
export function writeCost(action: Action): number {
  switch (action.kind) {
    case "create":
      return action.closeAfter ? 2 : 1;
    case "close":
      return 1;
  }
}

/**
 * - skip issues without the title prefix (filtered);
 * - no mirror -> create (closeAfter = resolved !== null);
 * - mirror open && resolved !== null -> close;
 * - otherwise unchanged (no reopen, no title/body updates);
 * - order by ascending numberInProject; take actions while their cost fits in
 *   maxWrites; at the first action that does not fit, stop -- it and everything
 *   after it count as capped. Nothing later jumps ahead (decision A2).
 * - exception (decision R6): when that action is a create+close pair and only its
 *   create fits, take it as a create with closeAfter = false and stop there. Its close
 *   counts as 1 capped; the next run closes the mirror (open mirror + resolved -> close).
 *   Without this, a cap of 1 would never get past a resolved issue that has no mirror.
 */
export function planActions(input: {
  readonly youtrackIssues: readonly YouTrackIssue[];
  readonly mirrors: MirrorIndex;
  readonly titlePrefix: string;
  readonly maxWrites: number;
}): Plan {
  const ordered = uniqueAscending(input.youtrackIssues);
  const needed: Action[] = [];
  let filtered = 0;
  let unchanged = 0;
  for (const issue of ordered) {
    const outcome = hasTitlePrefix(issue.summary, input.titlePrefix)
      ? actionFor(issue, input.mirrors.get(issue.numberInProject))
      : "filtered";
    if (outcome === "filtered") filtered += 1;
    else if (outcome === "unchanged") unchanged += 1;
    else needed.push(outcome);
  }
  const { actions, deferredCloses } = withinWriteCap(needed, input.maxWrites);
  const capped = needed.length - actions.length + deferredCloses;
  return { actions, scanned: ordered.length, filtered, unchanged, capped };
}

// ---------------------------------------------------------------------------
// Mirror index

/**
 * Non-PR issues with a mirror title, ranked: by numberInProject, then labelled first,
 * then lowest issue number. An issue listed twice (a page boundary shifted while
 * paging) is kept once, so it is never reported as its own duplicate.
 */
function mirrorCandidates(issues: readonly GitHubIssue[], label: string): readonly Candidate[] {
  const wanted = label.toLowerCase();
  const seen = new Set<number>();
  const candidates: Candidate[] = [];
  for (const issue of issues) {
    const numberInProject = issue.isPullRequest ? null : parseMirrorTitle(issue.title);
    if (numberInProject === null || seen.has(issue.number)) continue;
    seen.add(issue.number);
    const hasLabel = issue.labelNames.some((name) => name.toLowerCase() === wanted);
    candidates.push({ numberInProject, ref: { issueNumber: issue.number, state: issue.state, hasLabel } });
  }
  return candidates.sort(compareCandidates);
}

function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.numberInProject !== b.numberInProject) return a.numberInProject - b.numberInProject;
  if (a.ref.hasLabel !== b.ref.hasLabel) return a.ref.hasLabel ? -1 : 1;
  return a.ref.issueNumber - b.ref.issueNumber;
}

/** Splits ranked candidates into one group per numberInProject (they arrive adjacent). */
function groupCandidates(ranked: readonly Candidate[]): readonly CandidateGroup[] {
  const groups: { numberInProject: number; winner: MirrorRef; ignored: MirrorRef[] }[] = [];
  for (const { numberInProject, ref } of ranked) {
    const current = groups.at(-1);
    if (current?.numberInProject === numberInProject) current.ignored.push(ref);
    else groups.push({ numberInProject, winner: ref, ignored: [] });
  }
  return groups;
}

/** Only numbers go into warnings, so no issue text reaches the logs. */
function titleOnlyWarning(numberInProject: number, ref: MirrorRef, label: string): string {
  return `YT-${String(numberInProject)}: #${String(ref.issueNumber)} matched by title only (no "${label}" label)`;
}

function duplicateWarning(numberInProject: number, count: number, winner: MirrorRef, ignored: MirrorRef): string {
  const matches = `YT-${String(numberInProject)}: ${String(count)} GitHub issues match`;
  const using = `#${String(winner.issueNumber)} (${winner.hasLabel ? "labelled" : "unlabelled"})`;
  return `${matches}; using ${using}, ignoring #${String(ignored.issueNumber)}`;
}

// ---------------------------------------------------------------------------
// Actions

/**
 * A sorted copy with one issue per numberInProject (the first listed), so a repeated
 * row can never plan a second create. fetchProjectIssues already dedupes; this keeps
 * the planner safe on its own.
 */
function uniqueAscending(issues: readonly YouTrackIssue[]): readonly YouTrackIssue[] {
  // Array#sort is stable, so the first listed copy of a number stays first.
  const sorted = [...issues].sort((a, b) => a.numberInProject - b.numberInProject);
  return sorted.filter((issue, position) => sorted[position - 1]?.numberInProject !== issue.numberInProject);
}

/** The action an eligible issue needs, or "unchanged". Mirrors are never reopened or edited. */
function actionFor(issue: YouTrackIssue, mirror: MirrorRef | undefined): Action | "unchanged" {
  const isResolved = issue.resolved !== null;
  if (mirror === undefined) return { kind: "create", issue, closeAfter: isResolved };
  return mirror.state === "open" && isResolved ? { kind: "close", issue, mirror } : "unchanged";
}

type Capped = {
  readonly actions: readonly Action[];
  /** 1 when the last taken action is a create whose close was deferred to the next run, else 0. */
  readonly deferredCloses: number;
};

/**
 * The longest prefix of `actions` whose total writeCost fits in `maxWrites` (NaN: none).
 * A create+close pair that does not fit while its create alone does is taken as a plain
 * create, and the prefix ends there (decision R6).
 */
function withinWriteCap(actions: readonly Action[], maxWrites: number): Capped {
  const taken: Action[] = [];
  let used = 0;
  for (const action of actions) {
    if (used + writeCost(action) <= maxWrites) {
      taken.push(action);
      used += writeCost(action);
      continue;
    }
    const isSplittable = action.kind === "create" && action.closeAfter && used + 1 <= maxWrites;
    if (!isSplittable) break;
    return { actions: [...taken, { ...action, closeAfter: false }], deferredCloses: 1 };
  }
  return { actions: taken, deferredCloses: 0 };
}
