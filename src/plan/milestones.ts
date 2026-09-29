/**
 * The milestone index (H1, H7): which GitHub milestone mirrors which YouTrack epic, matched
 * by the `[YT-n]` title prefix like issue mirrors. Milestones have no label, so the lowest
 * milestone number wins among duplicates. Pure, no I/O.
 */

import type { GitHubMilestone } from "../github/milestones.ts";
import { parseMirrorTitle } from "../mirror.ts";
import { groupCandidates } from "./candidates.ts";
import type { Candidate } from "./candidates.ts";

/** One epic's milestone: its number and state as listed. */
export type MilestoneRef = {
  readonly milestoneNumber: GitHubMilestone["number"];
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
  /** One per ignored duplicate; numbers only, never titles. */
  readonly warnings: readonly string[];
};

/**
 * Build epic numberInProject -> milestone from GitHub milestones:
 * - titles are parsed with parseMirrorTitle; any other milestone is ignored;
 * - a milestone listed twice (a page boundary shifted while paging) is kept once, first copy;
 * - among several milestones for one epic the lowest number wins, whatever its state,
 *   and every other one adds a warning.
 */
export function buildMilestoneIndex(milestones: readonly GitHubMilestone[]): MilestoneIndexResult {
  const index = new Map<number, MilestoneRef>();
  const byNumber = new Map<number, number>();
  const warnings: string[] = [];
  for (const { numberInProject, winner, ignored } of groupCandidates(milestoneCandidates(milestones))) {
    index.set(numberInProject, winner);
    byNumber.set(winner.milestoneNumber, numberInProject);
    const count = ignored.length + 1;
    for (const ref of ignored) warnings.push(duplicateWarning(numberInProject, count, winner, ref));
  }
  return { index, byNumber, warnings };
}

/** Milestones with a mirror title, ranked by epic number, then lowest milestone number. */
function milestoneCandidates(milestones: readonly GitHubMilestone[]): readonly Candidate<MilestoneRef>[] {
  const seen = new Set<number>();
  const candidates: Candidate<MilestoneRef>[] = [];
  for (const milestone of milestones) {
    const numberInProject = parseMirrorTitle(milestone.title);
    if (numberInProject === null || seen.has(milestone.number)) continue;
    seen.add(milestone.number);
    candidates.push({ numberInProject, ref: { milestoneNumber: milestone.number, state: milestone.state } });
  }
  return candidates.sort(compareCandidates);
}

function compareCandidates(a: Candidate<MilestoneRef>, b: Candidate<MilestoneRef>): number {
  if (a.numberInProject !== b.numberInProject) return a.numberInProject - b.numberInProject;
  return a.ref.milestoneNumber - b.ref.milestoneNumber;
}

function duplicateWarning(numberInProject: number, count: number, winner: MilestoneRef, ignored: MilestoneRef): string {
  const matches = `YT-${String(numberInProject)}: ${String(count)} GitHub milestones match`;
  const using = `using milestone #${String(winner.milestoneNumber)}`;
  return `${matches}; ${using}, ignoring milestone #${String(ignored.milestoneNumber)}`;
}
