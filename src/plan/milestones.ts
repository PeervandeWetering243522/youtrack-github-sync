/**
 * The milestone index (H1, H7): which GitHub milestone mirrors which YouTrack epic, matched
 * by the `[<project>-n]` title prefix like issue mirrors (N1). Milestones have no label, so
 * the lowest milestone number wins among duplicates. Pure, no I/O.
 */

import type { GitHubMilestone } from "../github/milestones.ts";
import { parseMirrorTitle } from "../mirror.ts";
import { groupCandidates } from "./candidates.ts";
import type { Candidate } from "./candidates.ts";

/** One epic's milestone: its number, title and state as listed. */
export type MilestoneRef = {
  readonly milestoneNumber: GitHubMilestone["number"];
  readonly title: GitHubMilestone["title"];
  readonly state: GitHubMilestone["state"];
};

/** Epic numberInProject -> its milestone. */
export type MilestoneIndex = ReadonlyMap<number, MilestoneRef>;

/** What buildMilestoneIndex returns; planActions takes it whole (PlanInput.milestones). */
export type MilestoneIndexResult = {
  readonly index: MilestoneIndex;
  /**
   * Milestone number -> epic numberInProject for every milestone in `index` (its inverse).
   * A milestone that lost a duplicate match is not in it, so it counts as hand-made (D2).
   */
  readonly byNumber: ReadonlyMap<number, number>;
  /**
   * titleKey(title) -> the numbers of every listed milestone with that title, hand-made ones
   * included. GitHub refuses a second milestone with a title that already exists, so a rename
   * to a title another milestone has is not planned (N2).
   */
  readonly titleOwners: ReadonlyMap<string, readonly number[]>;
  /** One per ignored duplicate; ids and numbers only, never titles. */
  readonly warnings: readonly string[];
};

/**
 * Build epic numberInProject -> milestone from GitHub milestones:
 * - titles are parsed with parseMirrorTitle for YouTrack project `project`; any other
 *   milestone is ignored;
 * - a milestone listed twice (a page boundary shifted while paging) is kept once, first copy;
 * - among several milestones for one epic the lowest number wins, whatever its state,
 *   and every other one adds a warning.
 */
export function buildMilestoneIndex(milestones: readonly GitHubMilestone[], project: string): MilestoneIndexResult {
  const index = new Map<number, MilestoneRef>();
  const byNumber = new Map<number, number>();
  const warnings: string[] = [];
  for (const { numberInProject, winner, ignored } of groupCandidates(milestoneCandidates(milestones, project))) {
    index.set(numberInProject, winner);
    byNumber.set(winner.milestoneNumber, numberInProject);
    const name = `${project}-${String(numberInProject)}`;
    const count = ignored.length + 1;
    for (const ref of ignored) warnings.push(duplicateWarning(name, count, winner, ref));
  }
  return { index, byNumber, titleOwners: titleOwners(milestones), warnings };
}

/**
 * How milestone titles compare for titleOwners: ASCII letters case-insensitively, since it is
 * not documented whether GitHub's uniqueness check ignores case (assuming it does only ever
 * skips a rename).
 */
export function titleKey(title: string): string {
  return title.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

function titleOwners(milestones: readonly GitHubMilestone[]): ReadonlyMap<string, readonly number[]> {
  const owners = new Map<string, number[]>();
  for (const { title, number } of milestones) {
    const key = titleKey(title);
    const numbers = owners.get(key) ?? [];
    if (!numbers.includes(number)) owners.set(key, [...numbers, number]);
  }
  return owners;
}

/** Milestones with a mirror title, ranked by epic number, then lowest milestone number. */
function milestoneCandidates(
  milestones: readonly GitHubMilestone[],
  project: string,
): readonly Candidate<MilestoneRef>[] {
  const seen = new Set<number>();
  const candidates: Candidate<MilestoneRef>[] = [];
  for (const milestone of milestones) {
    const numberInProject = parseMirrorTitle(milestone.title, project);
    if (numberInProject === null || seen.has(milestone.number)) continue;
    seen.add(milestone.number);
    const ref = { milestoneNumber: milestone.number, title: milestone.title, state: milestone.state };
    candidates.push({ numberInProject, ref });
  }
  return candidates.sort(compareCandidates);
}

function compareCandidates(a: Candidate<MilestoneRef>, b: Candidate<MilestoneRef>): number {
  if (a.numberInProject !== b.numberInProject) return a.numberInProject - b.numberInProject;
  return a.ref.milestoneNumber - b.ref.milestoneNumber;
}

function duplicateWarning(name: string, count: number, winner: MilestoneRef, ignored: MilestoneRef): string {
  const matches = `${name}: ${String(count)} GitHub milestones match`;
  const using = `using milestone #${String(winner.milestoneNumber)}`;
  return `${matches}; ${using}, ignoring milestone #${String(ignored.milestoneNumber)}`;
}
