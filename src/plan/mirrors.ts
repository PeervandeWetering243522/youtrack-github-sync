/**
 * The mirror index (decisions A5, A6): which GitHub issue mirrors which YouTrack issue,
 * with the milestone, type and parent the planner compares on every run (docs/11 §1.3).
 * Pure, no I/O.
 */

import type { GitHubIssue } from "../github/issues.ts";
import { parseMirrorTitle } from "../mirror.ts";
import { groupCandidates } from "./candidates.ts";
import type { Candidate } from "./candidates.ts";

/**
 * One YouTrack issue's mirror as the GitHub list reported it: its number and REST `id`
 * (what sub-issue writes take), state, whether it carries the mirror label, and its
 * title, milestone, issue type, parent, who closed it and its assignees (see GitHubIssue).
 */
export type MirrorRef = Pick<
  GitHubIssue,
  | "id"
  | "state"
  | "title"
  | "milestoneNumber"
  | "typeName"
  | "parentNumber"
  | "parentIsForeign"
  | "closedBy"
  | "assignees"
> & {
  readonly issueNumber: number;
  readonly hasLabel: boolean;
};

/** YouTrack numberInProject -> its mirror. */
export type MirrorIndex = ReadonlyMap<number, MirrorRef>;

/** What buildMirrorIndex returns; sync.ts logs its warnings and passes `index` to planActions. */
export type MirrorIndexResult = {
  readonly index: MirrorIndex;
  /** Human-readable warnings (unlabelled title match, duplicates). */
  readonly warnings: readonly string[];
};

/**
 * Build numberInProject -> mirror from GitHub issues (decision A5, A6):
 * - pull requests are ignored;
 * - titles are parsed with parseMirrorTitle for YouTrack project `project` (N1);
 * - a candidate with the `label` beats one without; among equals the lowest issue
 *   number wins; every extra candidate adds a warning;
 * - an unlabelled winner adds a warning ("matched by title only").
 * Label names compare case-insensitively, as GitHub matches them (docs/03, gotcha 14).
 * Every MirrorRef field comes from the winning issue.
 */
export function buildMirrorIndex(issues: readonly GitHubIssue[], label: string, project: string): MirrorIndexResult {
  const index = new Map<number, MirrorRef>();
  const warnings: string[] = [];
  for (const { numberInProject, winner, ignored } of groupCandidates(mirrorCandidates(issues, label, project))) {
    const name = `${project}-${String(numberInProject)}`;
    index.set(numberInProject, winner);
    if (!winner.hasLabel) warnings.push(titleOnlyWarning(name, winner, label));
    const count = ignored.length + 1;
    for (const ref of ignored) warnings.push(duplicateWarning(name, count, winner, ref));
  }
  return { index, warnings };
}

/**
 * GitHub issue number -> YouTrack numberInProject for every mirror in `index`, the inverse
 * of a buildMirrorIndex index. An issue that lost a duplicate match is not in it, so it
 * does not count as a mirror.
 */
export function mirrorNumbers(index: MirrorIndex): ReadonlyMap<number, number> {
  return new Map([...index].map(([numberInProject, ref]) => [ref.issueNumber, numberInProject]));
}

/**
 * Non-PR issues with a mirror title, ranked: by numberInProject, then labelled first,
 * then lowest issue number. An issue listed twice (a page boundary shifted while
 * paging) is kept once, so it is never reported as its own duplicate.
 */
function mirrorCandidates(
  issues: readonly GitHubIssue[],
  label: string,
  project: string,
): readonly Candidate<MirrorRef>[] {
  const wanted = label.toLowerCase();
  const seen = new Set<number>();
  const candidates: Candidate<MirrorRef>[] = [];
  for (const issue of issues) {
    const numberInProject = issue.isPullRequest ? null : parseMirrorTitle(issue.title, project);
    if (numberInProject === null || seen.has(issue.number)) continue;
    seen.add(issue.number);
    const hasLabel = issue.labelNames.some((name) => name.toLowerCase() === wanted);
    candidates.push({ numberInProject, ref: toMirrorRef(issue, hasLabel) });
  }
  return candidates.sort(compareCandidates);
}

function toMirrorRef(issue: GitHubIssue, hasLabel: boolean): MirrorRef {
  return {
    issueNumber: issue.number,
    id: issue.id,
    state: issue.state,
    hasLabel,
    title: issue.title,
    milestoneNumber: issue.milestoneNumber,
    typeName: issue.typeName,
    parentNumber: issue.parentNumber,
    parentIsForeign: issue.parentIsForeign,
    closedBy: issue.closedBy,
    assignees: issue.assignees,
  };
}

function compareCandidates(a: Candidate<MirrorRef>, b: Candidate<MirrorRef>): number {
  if (a.numberInProject !== b.numberInProject) return a.numberInProject - b.numberInProject;
  if (a.ref.hasLabel !== b.ref.hasLabel) return a.ref.hasLabel ? -1 : 1;
  return a.ref.issueNumber - b.ref.issueNumber;
}

/** Only ids and numbers go into warnings ("CUI-5: ..."), so no issue text reaches the logs. */
function titleOnlyWarning(name: string, ref: MirrorRef, label: string): string {
  return `${name}: #${String(ref.issueNumber)} matched by title only (no "${label}" label)`;
}

function duplicateWarning(name: string, count: number, winner: MirrorRef, ignored: MirrorRef): string {
  const matches = `${name}: ${String(count)} GitHub issues match`;
  const using = `#${String(winner.issueNumber)} (${winner.hasLabel ? "labelled" : "unlabelled"})`;
  return `${matches}; using ${using}, ignoring #${String(ignored.issueNumber)}`;
}
