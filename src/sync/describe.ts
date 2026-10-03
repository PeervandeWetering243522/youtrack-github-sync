/**
 * How log lines describe planned actions, shared by the dry-run preview and the write phase
 * so both name an action alike. YouTrack ids and GitHub numbers only; the dry-run preview
 * appends the mirror title to its create and rename lines (decision R3). A milestone or
 * mirror that is not in the resolution map yet is named "(new)": the dry run creates
 * nothing, so one it would create earlier in the run has no GitHub number (the write phase
 * resolves every dependency before logging).
 */

import type { Action } from "../plan.ts";
import type { YouTrackIssue } from "../youtrack.ts";
import type { Resolved } from "./resolved.ts";
import { mirrorName, projectIssueName } from "./tally.ts";

/** A planned `create` of an issue mirror. */
export type CreateAction = Extract<Action, { readonly kind: "create" }>;
/** A planned `close` of an open issue mirror. */
export type CloseAction = Extract<Action, { readonly kind: "close" }>;
/** A planned `reopen` of a closed issue mirror (R10). */
export type ReopenAction = Extract<Action, { readonly kind: "reopen" }>;
/** A planned `renameMilestone` of an epic milestone. */
export type RenameMilestoneAction = Extract<Action, { readonly kind: "renameMilestone" }>;
/** A planned `closeMilestone` of an open epic milestone. */
export type CloseMilestoneAction = Extract<Action, { readonly kind: "closeMilestone" }>;
/** A planned `update` of a mirror's title, milestone and/or type. */
export type UpdateAction = Extract<Action, { readonly kind: "update" }>;
/** A planned `setParent` (move under another mirror). */
export type SetParentAction = Extract<Action, { readonly kind: "setParent" }>;
/** A planned `removeParent` (detach from the current mirror parent). */
export type RemoveParentAction = Extract<Action, { readonly kind: "removeParent" }>;
/** A planned `addAssignees` of an open mirror, existing or created earlier in the run. */
export type AddAssigneesAction = Extract<Action, { readonly kind: "addAssignees" }>;
/** A planned `removeAssignees` of an existing open mirror. */
export type RemoveAssigneesAction = Extract<Action, { readonly kind: "removeAssignees" }>;

type MirrorAction =
  CloseAction | ReopenAction | UpdateAction | SetParentAction | RemoveParentAction | RemoveAssigneesAction;

const NOT_YET_NUMBERED = "(new)";

/** "CUI-33 #7" for issue `numberInProject` of `of`'s project, or "CUI-33 (new)" without a number. */
function numbered(of: YouTrackIssue, numberInProject: number, githubNumber: number | undefined): string {
  const number = githubNumber === undefined ? NOT_YET_NUMBERED : `#${String(githubNumber)}`;
  return `${projectIssueName(of, numberInProject)} ${number}`;
}

/** "CUI-33 #7": epic CUI-33 (of the project of `of`) and its milestone number, or "CUI-33 (new)". */
export function milestoneName(resolved: Resolved, of: YouTrackIssue, epic: number): string {
  return numbered(of, epic, resolved.milestones.get(epic));
}

/** "CUI-35 #21": YouTrack issue CUI-35 (of the project of `of`) and its mirror's number, or "CUI-35 (new)". */
export function issueName(resolved: Resolved, of: YouTrackIssue, numberInProject: number): string {
  return numbered(of, numberInProject, resolved.issues.get(numberInProject)?.issueNumber);
}

/** "CUI-40 #25": the action's YouTrack issue and its existing mirror. */
export function mirrorLabel(action: MirrorAction): string {
  return `${mirrorName(action.issue)} #${String(action.mirror.issueNumber)}`;
}

/**
 * What a create sets besides title, body and label: "" or e.g.
 * " with type Task, milestone CUI-33 #7, parent CUI-35 #21".
 */
export function createDetails(resolved: Resolved, action: CreateAction): string {
  const { issue, githubType, milestoneEpic, parentYt } = action;
  const parts = [
    ...(githubType === null ? [] : [`type ${githubType}`]),
    ...(milestoneEpic === null ? [] : [`milestone ${milestoneName(resolved, issue, milestoneEpic)}`]),
    ...(parentYt === null ? [] : [`parent ${issueName(resolved, issue, parentYt)}`]),
  ];
  return parts.length === 0 ? "" : ` with ${parts.join(", ")}`;
}

/** "update CUI-15 #21: set title, set milestone CUI-33 #7, set type Task" (or "...: clear milestone"). */
export function describeUpdate(resolved: Resolved, action: UpdateAction): string {
  const { title, milestoneEpic, githubType } = action;
  const titleChange = title === undefined ? [] : ["set title"];
  const milestone = milestoneEpic === undefined ? [] : [milestoneChange(resolved, action.issue, milestoneEpic)];
  const type = githubType === undefined ? [] : [`set type ${githubType}`];
  return `update ${mirrorLabel(action)}: ${[...titleChange, ...milestone, ...type].join(", ")}`;
}

/** "move CUI-40 #25 under CUI-36 #22". */
export function describeMove(resolved: Resolved, action: SetParentAction): string {
  return `move ${mirrorLabel(action)} under ${issueName(resolved, action.issue, action.parentYt)}`;
}

/** "detach CUI-40 #25 from parent CUI-35 #21". */
export function describeDetach(action: RemoveParentAction): string {
  return `detach ${mirrorLabel(action)} from parent ${numbered(action.issue, action.parentYt, action.parentNumber)}`;
}

/** "close CUI-3 #12". */
export function describeClose(action: CloseAction): string {
  return `close ${mirrorLabel(action)}`;
}

/** "reopen CUI-3 #12". */
export function describeReopen(action: ReopenAction): string {
  return `reopen ${mirrorLabel(action)}`;
}

/**
 * "add 1 assignee to CUI-41 #30": counts only, never a login (U8). The mirror is named from the
 * resolution map, so one created earlier in the run has its number, or "(new)" in the dry run.
 */
export function describeAddAssignees(resolved: Resolved, action: AddAssigneesAction): string {
  const { issue, logins } = action;
  return `add ${assigneeCount(logins)} to ${issueName(resolved, issue, issue.numberInProject)}`;
}

/** "remove 2 assignees from CUI-12 #21": counts only, never a login (U8). */
export function describeRemoveAssignees(action: RemoveAssigneesAction): string {
  return `remove ${assigneeCount(action.logins)} from ${mirrorLabel(action)}`;
}

/** "1 assignee", "2 assignees". */
export function assigneeCount(logins: readonly string[]): string {
  return `${String(logins.length)} ${logins.length === 1 ? "assignee" : "assignees"}`;
}

/** "rename milestone CUI-33 #7". */
export function describeRenameMilestone(action: RenameMilestoneAction): string {
  return `rename milestone ${milestoneLabel(action)}`;
}

/** "close milestone CUI-33 #7". */
export function describeCloseMilestone(action: CloseMilestoneAction): string {
  return `close milestone ${milestoneLabel(action)}`;
}

/** "CUI-33 #7": the epic of a milestone action and its existing milestone. */
function milestoneLabel(action: RenameMilestoneAction | CloseMilestoneAction): string {
  return `${mirrorName(action.issue)} #${String(action.milestone.milestoneNumber)}`;
}

function milestoneChange(resolved: Resolved, of: YouTrackIssue, epic: number | null): string {
  return epic === null ? "clear milestone" : `set milestone ${milestoneName(resolved, of, epic)}`;
}
