/**
 * How log lines describe planned actions, shared by the dry-run preview and the write phase
 * so both name an action alike. Numbers only; the dry-run preview appends the mirror title to
 * its two create lines (decision R3). A milestone or mirror that is not in the resolution map
 * yet is named "(new)": the dry run creates nothing, so one it would create earlier in the
 * run has no GitHub number (the write phase resolves every dependency before logging).
 */

import type { Action } from "../plan.ts";
import type { Resolved } from "./resolved.ts";
import { mirrorName } from "./tally.ts";

/** A planned `create` of an issue mirror. */
export type CreateAction = Extract<Action, { readonly kind: "create" }>;
/** A planned `close` of an open issue mirror. */
export type CloseAction = Extract<Action, { readonly kind: "close" }>;
/** A planned `closeMilestone` of an open epic milestone. */
export type CloseMilestoneAction = Extract<Action, { readonly kind: "closeMilestone" }>;
/** A planned `update` of a mirror's milestone and/or type. */
export type UpdateAction = Extract<Action, { readonly kind: "update" }>;
/** A planned `setParent` (move under another mirror). */
export type SetParentAction = Extract<Action, { readonly kind: "setParent" }>;
/** A planned `removeParent` (detach from the current mirror parent). */
export type RemoveParentAction = Extract<Action, { readonly kind: "removeParent" }>;

type MirrorAction = CloseAction | UpdateAction | SetParentAction | RemoveParentAction;

const NOT_YET_NUMBERED = "(new)";

function ytName(numberInProject: number): string {
  return `YT-${String(numberInProject)}`;
}

function numbered(numberInProject: number, githubNumber: number | undefined): string {
  return `${ytName(numberInProject)} ${githubNumber === undefined ? NOT_YET_NUMBERED : `#${String(githubNumber)}`}`;
}

/** "YT-33 #7": epic YT-33 and its milestone number, or "YT-33 (new)". */
export function milestoneName(resolved: Resolved, epic: number): string {
  return numbered(epic, resolved.milestones.get(epic));
}

/** "YT-35 #21": YouTrack issue YT-35 and its mirror's number, or "YT-35 (new)". */
export function issueName(resolved: Resolved, numberInProject: number): string {
  return numbered(numberInProject, resolved.issues.get(numberInProject)?.issueNumber);
}

/** "YT-40 #25": the action's YouTrack issue and its existing mirror. */
export function mirrorLabel(action: MirrorAction): string {
  return `${mirrorName(action.issue)} #${String(action.mirror.issueNumber)}`;
}

/**
 * What a create sets besides title, body and label: "" or e.g.
 * " with type Task, milestone YT-33 #7, parent YT-35 #21".
 */
export function createDetails(resolved: Resolved, action: CreateAction): string {
  const { githubType, milestoneEpic, parentYt } = action;
  const parts = [
    ...(githubType === null ? [] : [`type ${githubType}`]),
    ...(milestoneEpic === null ? [] : [`milestone ${milestoneName(resolved, milestoneEpic)}`]),
    ...(parentYt === null ? [] : [`parent ${issueName(resolved, parentYt)}`]),
  ];
  return parts.length === 0 ? "" : ` with ${parts.join(", ")}`;
}

/** "update YT-15 #21: set milestone YT-33 #7, set type Task" (or "...: clear milestone"). */
export function describeUpdate(resolved: Resolved, action: UpdateAction): string {
  const { milestoneEpic, githubType } = action;
  const milestone = milestoneEpic === undefined ? [] : [milestoneChange(resolved, milestoneEpic)];
  const type = githubType === undefined ? [] : [`set type ${githubType}`];
  return `update ${mirrorLabel(action)}: ${[...milestone, ...type].join(", ")}`;
}

/** "move YT-40 #25 under YT-36 #22". */
export function describeMove(resolved: Resolved, action: SetParentAction): string {
  return `move ${mirrorLabel(action)} under ${issueName(resolved, action.parentYt)}`;
}

/** "detach YT-40 #25 from parent YT-35 #21". */
export function describeDetach(action: RemoveParentAction): string {
  return `detach ${mirrorLabel(action)} from parent ${numbered(action.parentYt, action.parentNumber)}`;
}

/** "close YT-3 #12". */
export function describeClose(action: CloseAction): string {
  return `close ${mirrorLabel(action)}`;
}

/** "close milestone YT-33 #7". */
export function describeCloseMilestone(action: CloseMilestoneAction): string {
  return `close milestone ${numbered(action.issue.numberInProject, action.milestone.milestoneNumber)}`;
}

function milestoneChange(resolved: Resolved, epic: number | null): string {
  return epic === null ? "clear milestone" : `set milestone ${milestoneName(resolved, epic)}`;
}
