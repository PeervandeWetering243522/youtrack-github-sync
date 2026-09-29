/**
 * The issue writes of the write phase: create a mirror with its milestone, type and parent
 * (docs/11 §1.3), resolved from the run-local map (D4); re-add a dropped label (A5); warn
 * about a dropped milestone, type or parent (§1.6, the next run's sync repairs it); close.
 */

import { MIRROR_LABEL } from "../github/client.ts";
import type { CreateIssueBody, GitHubIssue } from "../github/issues.ts";
import type { GitHubTypeName } from "../hierarchy.ts";
import { formatMirror } from "../mirror.ts";
import type { YouTrackIssue } from "../youtrack.ts";
import { createDetails, describeClose } from "./describe.ts";
import type { CloseAction, CreateAction } from "./describe.ts";
import { attemptWrite, failure, notWritten, sendWrite, waitsFor } from "./execute-write.ts";
import type { Step, WriteContext } from "./execute-write.ts";
import { milestoneFor, mirrorFor, optional, withIssue } from "./resolved.ts";
import type { IssueRef, Resolved } from "./resolved.ts";
import { combine, done, mirrorName, NOTHING } from "./tally.ts";
import type { Tally } from "./tally.ts";

/** What a create sets besides title, body and label, resolved to GitHub numbers and ids; null: none. */
type CreateTargets = {
  readonly milestone: number | null;
  readonly type: GitHubTypeName | null;
  readonly parent: IssueRef | null;
};

/**
 * POST the mirror of `action.issue` with its milestone, type and parent_issue_id, once both
 * dependencies resolve; a missing one caps the create (D4). On a 201 the new mirror joins the
 * resolution map, a missing label is re-added (A5) and any other dropped field is warned
 * about (no extra write). Never retried.
 */
export async function executeCreate(action: CreateAction, context: WriteContext, resolved: Resolved): Promise<Step> {
  const name = mirrorName(action.issue);
  const what = `create ${name}`;
  const milestone = optional(action.milestoneEpic, (epic) => milestoneFor(resolved, epic));
  if (!milestone.found) return { tally: waitsFor(context, what, milestone.missing), resolved };
  const parent = optional(action.parentYt, (parentYt) => mirrorFor(resolved, parentYt));
  if (!parent.found) return { tally: waitsFor(context, what, parent.missing), resolved };
  const targets: CreateTargets = { milestone: milestone.value, type: action.githubType, parent: parent.value };
  const body = createBody(action.issue, context.youtrackBaseUrl, targets);
  const outcome = await attemptWrite(() => context.writer.create(body));
  if (outcome.kind !== "ok") return { tally: notWritten(context, what, outcome), resolved };
  const created = outcome.value;
  const next = withIssue(resolved, action.issue.numberInProject, { issueNumber: created.number, id: created.id });
  context.log.info(`${what}${createDetails(next, action)} -> #${String(created.number)}`);
  warnDropped(context, created, name, targets);
  return { tally: combine(done("created"), await ensureLabel(created, name, context)), resolved: next };
}

/** PATCH the open mirror of a resolved issue to closed/completed (A7). */
export function executeClose(action: CloseAction, context: WriteContext): Promise<Tally> {
  const { issueNumber } = action.mirror;
  return sendWrite(context, describeClose(action), () => context.writer.close(issueNumber), "closed");
}

/** The POST /issues body: the mirror title, body and label, plus each target that is not null. */
function createBody(issue: YouTrackIssue, youtrackBaseUrl: string, targets: CreateTargets): CreateIssueBody {
  const mirror = formatMirror(issue, youtrackBaseUrl);
  const { milestone, type, parent } = targets;
  return {
    title: mirror.title,
    body: mirror.body,
    labels: [MIRROR_LABEL],
    ...(milestone === null ? {} : { milestone }),
    ...(type === null ? {} : { type }),
    ...(parent === null ? {} : { parent_issue_id: parent.id }),
  } satisfies CreateIssueBody;
}

/** One warning naming every target the 201 response lacks (GitHub drops them silently without push access). */
function warnDropped(context: WriteContext, created: GitHubIssue, name: string, targets: CreateTargets): void {
  const { milestone, type, parent } = targets;
  const dropped = [
    ...(milestone !== null && created.milestoneNumber !== milestone ? [`milestone #${String(milestone)}`] : []),
    ...(type !== null && created.typeName !== type ? [`type ${type}`] : []),
    ...(parent !== null && created.parentNumber !== parent.issueNumber
      ? [`parent #${String(parent.issueNumber)}`]
      : []),
  ];
  if (dropped.length === 0) return;
  const what = `${name} #${String(created.number)}`;
  context.log.warn(`${what}: GitHub dropped ${dropped.join(", ")} on create; the next run's sync repairs this`);
}

/**
 * Re-adds MIRROR_LABEL when the 201 response lacks it (decision A5), if a write is
 * left. Without it the next run still matches the mirror by title.
 */
async function ensureLabel(created: GitHubIssue, name: string, context: WriteContext): Promise<Tally> {
  const wanted = MIRROR_LABEL.toLowerCase();
  if (created.labelNames.some((label) => label.toLowerCase() === wanted)) return NOTHING;
  const what = `${name} #${String(created.number)}`;
  const notReAdded = `${what} was created without the "${MIRROR_LABEL}" label and it was not re-added`;
  if (context.writer.count() >= context.maxWrites) {
    context.log.warn(`${notReAdded} (write cap reached)`);
    return NOTHING;
  }
  const outcome = await attemptWrite(() => context.writer.addLabel(created.number));
  switch (outcome.kind) {
    case "ok":
      context.log.info(`label ${what}`);
      return { ...NOTHING, labelsReAdded: 1 };
    case "failed":
    case "rate-limited":
      return failure(context, `label ${what}`, outcome);
    case "out-of-fetches":
      context.log.warn(`${notReAdded} (fetch guard reached)`);
      return { ...NOTHING, stop: "fetch-guard" };
  }
}
