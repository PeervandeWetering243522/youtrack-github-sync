/**
 * The hierarchy writes of the write phase (docs/11 §1.3): create, update and close
 * milestones, and keep an existing mirror's title, body, milestone, type and parent in sync
 * (update, setParent, removeParent; N2 for titles, N4 for bodies and descriptions).
 * Dependencies resolve through the run-local map; a missing one caps the action (D4). Only
 * the milestone create is never retried.
 */

import type { GitHubIssue, IssueUpdate } from "../github/issues.ts";
import { formatMirror } from "../mirror.ts";
import type { YouTrackIssue } from "../youtrack.ts";
import {
  describeCloseMilestone,
  describeDetach,
  describeMove,
  describeUpdate,
  describeUpdateMilestone,
  mirrorLabel,
} from "./describe.ts";
import type {
  CloseMilestoneAction,
  RemoveParentAction,
  SetParentAction,
  UpdateAction,
  UpdateMilestoneAction,
} from "./describe.ts";
import { attemptWrite, notWritten, sendWrite, waitsFor } from "./execute-write.ts";
import type { Step, WriteContext } from "./execute-write.ts";
import { milestoneFor, mirrorFor, optional, withMilestone } from "./resolved.ts";
import type { Dependency, Resolved } from "./resolved.ts";
import { done, mirrorName } from "./tally.ts";
import type { Tally } from "./tally.ts";

/**
 * POST the milestone of epic `issue`: title and description are formatMirror's title and
 * body (H7, H10). On a 201 the milestone joins the resolution map. Never retried.
 */
export async function executeCreateMilestone(
  issue: YouTrackIssue,
  context: WriteContext,
  resolved: Resolved,
): Promise<Step> {
  const what = `create milestone ${mirrorName(issue)}`;
  const mirror = formatMirror(issue, context.youtrackBaseUrl);
  const milestone = { title: mirror.title, description: mirror.body };
  const outcome = await attemptWrite(() => context.writer.createMilestone(milestone));
  if (outcome.kind !== "ok") return { tally: notWritten(context, what, outcome), resolved };
  const milestoneNumber = outcome.value.number;
  context.log.info(`${what} -> #${String(milestoneNumber)}`);
  return {
    tally: done("milestonesCreated"),
    resolved: withMilestone(resolved, issue.numberInProject, milestoneNumber),
  };
}

/**
 * PATCH the title (N2) and/or description (N4) of an epic's milestone; counted as a sync write.
 * A response that does not show the change is warned about, like an issue update's.
 */
export async function executeUpdateMilestone(action: UpdateMilestoneAction, context: WriteContext): Promise<Tally> {
  const what = describeUpdateMilestone(action);
  const { title, description } = action;
  const patch = { ...(title === undefined ? {} : { title }), ...(description === undefined ? {} : { description }) };
  const outcome = await attemptWrite(() => context.writer.updateMilestone(action.milestone.milestoneNumber, patch));
  if (outcome.kind !== "ok") return notWritten(context, what, outcome);
  context.log.info(what);
  const dropped = [
    ...(title !== undefined && outcome.value.title !== title ? ["the title"] : []),
    ...(description !== undefined && outcome.value.description !== description ? ["the description"] : []),
  ];
  if (dropped.length > 0) {
    const label = `milestone ${mirrorName(action.issue)} #${String(action.milestone.milestoneNumber)}`;
    context.log.warn(`${label}: GitHub dropped ${dropped.join(", ")} on update; the next run tries again`);
  }
  return done("updated");
}

/** PATCH the open milestone of a resolved epic to closed. */
export function executeCloseMilestone(action: CloseMilestoneAction, context: WriteContext): Promise<Tally> {
  const { milestoneNumber } = action.milestone;
  const write = (): Promise<void> => context.writer.closeMilestone(milestoneNumber);
  return sendWrite(context, describeCloseMilestone(action), write, "milestonesClosed");
}

/**
 * One PATCH of the mirror's title, body, milestone (null clears it) and/or type, once the
 * milestone resolves; a missing one caps it (D4). A response that does not show the change
 * is warned about (no extra write; the next run's plan sees the difference again).
 */
export async function executeUpdate(action: UpdateAction, context: WriteContext, resolved: Resolved): Promise<Tally> {
  const what = `update ${mirrorLabel(action)}`;
  const patch = issuePatch(action, resolved);
  if (!patch.found) return waitsFor(context, what, patch.missing);
  const outcome = await attemptWrite(() => context.writer.update(action.mirror.issueNumber, patch.value));
  if (outcome.kind !== "ok") return notWritten(context, what, outcome);
  context.log.info(describeUpdate(resolved, action));
  warnDropped(context, outcome.value, mirrorLabel(action), patch.value);
  return done("updated");
}

/** POST the mirror under its new parent's mirror with replace_parent, once that parent resolves (D4). */
export async function executeSetParent(
  action: SetParentAction,
  context: WriteContext,
  resolved: Resolved,
): Promise<Tally> {
  const parent = mirrorFor(resolved, action.parentYt, action.issue);
  if (!parent.found) return waitsFor(context, `move ${mirrorLabel(action)}`, parent.missing);
  const write = (): Promise<void> => context.writer.addSubIssue(parent.value.issueNumber, action.mirror.id);
  return sendWrite(context, describeMove(resolved, action), write, "updated");
}

/** DELETE the mirror from under its current mirror parent. */
export function executeRemoveParent(action: RemoveParentAction, context: WriteContext): Promise<Tally> {
  const write = (): Promise<void> => context.writer.removeSubIssue(action.parentNumber, action.mirror.id);
  return sendWrite(context, describeDetach(action), write, "updated");
}

/** The PATCH of `action`: its title, body and type as is, its milestone epic resolved to a milestone number. */
function issuePatch(action: UpdateAction, resolved: Resolved): Dependency<IssueUpdate> {
  const { title, body, milestoneEpic, githubType } = action;
  const rest = {
    ...(title === undefined ? {} : { title }),
    ...(body === undefined ? {} : { body }),
    ...(githubType === undefined ? {} : { type: githubType }),
  };
  if (milestoneEpic === undefined) return { found: true, value: rest };
  const milestone = optional(milestoneEpic, (epic) => milestoneFor(resolved, epic, action.issue));
  return milestone.found ? { found: true, value: { milestone: milestone.value, ...rest } } : milestone;
}

/** One warning naming every change the PATCH response does not show. */
function warnDropped(context: WriteContext, updated: GitHubIssue, label: string, patch: IssueUpdate): void {
  const { title, body, milestone, type } = patch;
  const dropped = [
    ...(title !== undefined && updated.title !== title ? ["the title"] : []),
    ...(body !== undefined && updated.body !== body ? ["the body"] : []),
    ...(milestone !== undefined && updated.milestoneNumber !== milestone ? [milestoneText(milestone)] : []),
    ...(type !== undefined && updated.typeName !== type ? [`type ${type}`] : []),
  ];
  if (dropped.length === 0) return;
  context.log.warn(`${label}: GitHub dropped ${dropped.join(", ")} on update; the next run tries again`);
}

function milestoneText(milestone: number | null): string {
  return milestone === null ? "the milestone removal" : `milestone #${String(milestone)}`;
}
