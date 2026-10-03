/**
 * Which scanned issues take part in assignee sync (docs/13 §2.3): the one predicate both the
 * assignee stage (src/sync/assignees.ts, whose YouTrack users to match) and the planner (whose
 * mirrors get assignee actions) use. Pure, no I/O.
 */

import { buildHierarchy, classify } from "../hierarchy.ts";
import type { PlanInput } from "../plan.ts";
import type { YouTrackIssue } from "../youtrack.ts";
import { isExcluded } from "./exclude.ts";

/**
 * numberInProject of every assignee-eligible issue: not excluded (F1, F3), not an epic (U13:
 * milestones have no assignees), unresolved, and with an open mirror or none yet (it gets a
 * create this run, R9). A closed mirror is never touched (U7), not even one R10 reopens this
 * run. A repeated number is decided by its first listed row, as planActions decides it.
 */
export function assigneeEligible(
  input: Pick<PlanInput, "youtrackIssues" | "mirrors" | "excludePrefix">,
): ReadonlySet<number> {
  const hierarchy = buildHierarchy(input.youtrackIssues);
  const eligible = new Set<number>();
  for (const issue of firstOfEachNumber(input.youtrackIssues)) {
    const mirror = input.mirrors.get(issue.numberInProject);
    if (issue.resolved !== null || classify(issue.type).kind === "milestone") continue;
    if (mirror !== undefined && mirror.state !== "open") continue;
    if (!isExcluded(hierarchy, issue, input.excludePrefix)) eligible.add(issue.numberInProject);
  }
  return eligible;
}

/** `issues` with only the first listed row of each numberInProject. */
function firstOfEachNumber(issues: readonly YouTrackIssue[]): readonly YouTrackIssue[] {
  const seen = new Set<number>();
  return issues.filter((issue) => {
    if (seen.has(issue.numberInProject)) return false;
    seen.add(issue.numberInProject);
    return true;
  });
}
