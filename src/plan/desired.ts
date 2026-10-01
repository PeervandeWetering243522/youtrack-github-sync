/**
 * Desired GitHub state of one scanned YouTrack issue (docs/11 §1.2) and how a mirror's
 * current state differs from it (§1.3). Only mirror-owned links are changed (D2) and a
 * desired type of none never clears one (D3). Pure, no I/O; src/plan.ts turns the
 * differences into actions.
 *
 * Dependencies are YouTrack numbers: a milestone or parent mirror created in the same run
 * has no GitHub number yet, so execution resolves them (D4).
 */

import type { GitHubTypeName, Hierarchy } from "../hierarchy.ts";
import { nearestEpic, parentChain } from "../hierarchy.ts";
import type { YouTrackIssue } from "../youtrack.ts";
import type { MilestoneIndexResult } from "./milestones.ts";
import type { MirrorIndex, MirrorRef } from "./mirrors.ts";

/**
 * What planning one run knows: the scan's hierarchy, which issues are excluded, both
 * indexes and what this run creates. "Eligible" means not excluded.
 */
export type PlanContext = {
  /** buildHierarchy of every scanned issue, filtered and resolved ones included. */
  readonly hierarchy: Hierarchy;
  /** numberInProject of every excluded scanned issue (isExcluded, F1/F3): never planned for, never a milestone or parent. */
  readonly excluded: ReadonlySet<number>;
  readonly mirrors: MirrorIndex;
  /** GitHub issue number -> YouTrack numberInProject of every mirror (mirrorNumbers). */
  readonly mirrorOf: ReadonlyMap<number, number>;
  readonly milestones: MilestoneIndexResult;
  /** Eligible unresolved non-epics without a mirror: each gets a `create` this run. */
  readonly newIssues: ReadonlySet<number>;
  /** Eligible unresolved epics without a milestone: each gets a `createMilestone` this run. */
  readonly newMilestones: ReadonlySet<number>;
  /** PlanInput.reopenClosedBy: the login whose closes a reopen undoes (R10); null: never reopen. */
  readonly reopenClosedBy: string | null;
};

/**
 * The fields of an `update`, at least one of them present (updateIssue refuses an empty
 * patch); a key left out is not changed. `title` sets the mirror title (N2);
 * `milestoneEpic` null clears the milestone, a number sets the milestone of that epic;
 * `githubType` sets the issue type.
 */
export type UpdateFields =
  | { readonly title: string; readonly milestoneEpic?: number | null; readonly githubType?: GitHubTypeName }
  | { readonly title?: never; readonly milestoneEpic: number | null; readonly githubType?: GitHubTypeName }
  | { readonly title?: never; readonly milestoneEpic?: never; readonly githubType: GitHubTypeName };

/** What a mirror should look like: the fields updateFields compares (docs/11 §1.3, N2). */
export type DesiredFields = {
  /** mirrorTitle of the YouTrack issue. */
  readonly title: string;
  /** desiredMilestoneEpic of the issue; null: no mirror milestone. */
  readonly milestoneEpic: number | null;
  /** The GitHub type of its YouTrack type; null: none (D3). */
  readonly githubType: GitHubTypeName | null;
};

/** A milestone change of an `update`: null clears it, a number sets that epic's milestone. */
type MilestoneChange = { readonly milestoneEpic: number | null };

/** A parent change: put the mirror under the mirror of `parentYt`, or take it out of its current mirror parent. */
export type ParentChange =
  | { readonly kind: "set"; readonly parentYt: number }
  | { readonly kind: "remove"; readonly parentNumber: number; readonly parentYt: number };

/**
 * The epic whose milestone `issue` belongs in (H4, D1): its nearest Epic ancestor, when that
 * epic is not excluded and has a milestone (whatever the epic's state) or gets one in this
 * run. Otherwise null; higher epics are never searched. An excluded epic's issues are
 * excluded themselves (F3), so the check only matters for inconsistent input.
 */
export function desiredMilestoneEpic(context: PlanContext, issue: YouTrackIssue): number | null {
  const epic = nearestEpic(context.hierarchy, issue);
  if (epic === null || context.excluded.has(epic.numberInProject)) return null;
  const { numberInProject } = epic;
  const isMirrored = context.milestones.index.has(numberInProject) || context.newMilestones.has(numberInProject);
  return isMirrored ? numberInProject : null;
}

/**
 * The YouTrack issue whose mirror should be the GitHub parent of task `issue` (H3): the
 * nearest non-epic ancestor that is not excluded and has a mirror (whatever its state) or
 * gets one in this run. The walk ends at the first epic, at a parent outside the scan (D5)
 * and on a cycle. null: top-level. An excluded ancestor's mirror is never used; its
 * descendants are excluded themselves (F3), so that only matters for inconsistent input.
 */
export function desiredParent(context: PlanContext, issue: YouTrackIssue): number | null {
  const isCandidate = (n: number): boolean =>
    !context.excluded.has(n) && (context.mirrors.has(n) || context.newIssues.has(n));
  const parent = parentChain(context.hierarchy, issue).find(({ numberInProject }) => isCandidate(numberInProject));
  return parent?.numberInProject ?? null;
}

/**
 * What an `update` of `mirror` must change, or null when nothing:
 * - title: a desired title that differs from the current one (compared exactly, N2);
 * - milestone: a desired epic whose milestone is not the current one -> that epic; no desired
 *   epic but the current milestone is a mirror milestone -> null (clear); a milestone not in
 *   the milestone index (hand-made) is otherwise left alone (D2);
 * - type: a desired type that differs from the current name (compared exactly); a desired
 *   type of none never changes it (D3).
 */
export function updateFields(context: PlanContext, mirror: MirrorRef, desired: DesiredFields): UpdateFields | null {
  const milestone = milestoneChange(context, mirror, desired.milestoneEpic);
  const { githubType: desiredType } = desired;
  const type = desiredType === null || desiredType === mirror.typeName ? null : { githubType: desiredType };
  const rest = milestone === null ? type : { ...milestone, ...type };
  if (desired.title !== mirror.title) return { title: desired.title, ...rest };
  return rest;
}

/**
 * The parent change `mirror` needs to sit under the mirror of `desiredYt` (null: top-level):
 * - a desired parent that is not the current mirror parent -> set (it replaces a hand-made
 *   or foreign parent too, since YouTrack wants a mirrored one there, D2);
 * - no desired parent while the current parent is a mirror -> remove;
 * - otherwise null: a foreign or hand-made parent that no mirror should replace is left alone (D2).
 */
export function parentChange(context: PlanContext, mirror: MirrorRef, desiredYt: number | null): ParentChange | null {
  const current = currentMirrorParent(context, mirror);
  if (desiredYt !== null) return desiredYt === current?.parentYt ? null : { kind: "set", parentYt: desiredYt };
  return current === null ? null : { kind: "remove", ...current };
}

/** The milestone half of updateFields; null: leave the milestone as it is. */
function milestoneChange(context: PlanContext, mirror: MirrorRef, desiredEpic: number | null): MilestoneChange | null {
  const current = mirror.milestoneNumber;
  if (desiredEpic !== null) {
    // A milestone created in this run is not in the index yet, so it always differs.
    const desired = context.milestones.index.get(desiredEpic)?.milestoneNumber;
    return desired === current ? null : { milestoneEpic: desiredEpic };
  }
  return current !== null && context.milestones.byNumber.has(current) ? { milestoneEpic: null } : null;
}

/** `mirror`'s current parent when it is a mirror in this repository, with its YouTrack number; else null. */
function currentMirrorParent(
  context: PlanContext,
  mirror: MirrorRef,
): { readonly parentNumber: number; readonly parentYt: number } | null {
  const { parentNumber } = mirror;
  if (mirror.parentIsForeign || parentNumber === null) return null;
  const parentYt = context.mirrorOf.get(parentNumber);
  return parentYt === undefined ? null : { parentNumber, parentYt };
}
