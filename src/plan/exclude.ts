/**
 * The exclude filter (decisions F1-F3): which scanned YouTrack issues the mirror ignores.
 * Pure, no I/O. src/plan.ts counts an excluded issue as filtered and plans nothing for it,
 * not even for an existing mirror or milestone (F2), and src/plan/desired.ts never picks one
 * as a milestone or parent.
 */

import type { Hierarchy } from "../hierarchy.ts";
import { linkedAncestors } from "../hierarchy.ts";
import { hasTitlePrefix } from "../mirror.ts";
import type { YouTrackIssue } from "../youtrack.ts";

/**
 * True when `issue` is out of the mirror: its own summary starts with `excludePrefix`
 * (F1), or the summary of any of its YouTrack ancestors does (F3). The prefix is matched
 * case-insensitively after leading whitespace (hasTitlePrefix). Every ancestor counts,
 * whatever its Type (epics included) or state, and so does every other member of a parent
 * cycle `issue` is on or leads into; the walk (hierarchy.ts `linkedAncestors`) stops at the
 * first repeat and at a parent outside the scan (D5).
 */
export function isExcluded(hierarchy: Hierarchy, issue: YouTrackIssue, excludePrefix: string): boolean {
  return [issue, ...linkedAncestors(hierarchy, issue)].some(({ summary }) => hasTitlePrefix(summary, excludePrefix));
}
