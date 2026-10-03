/**
 * The dry-run preview (DRY_RUN on): one "[dry-run] would ..." line per planned action,
 * counted as the write phase counts a done one. It gets neither a writer nor an HTTP
 * client, so it cannot send anything. Lines carry ids and numbers only, except the create
 * lines and the lines that set a title, which end with the mirror title (decision R3);
 * assignee lines carry counts, never a login (U8). A
 * milestone or mirror created earlier in the run is named "(new)", since it has no GitHub
 * number yet.
 */

import { formatMirror } from "../mirror.ts";
import type { Action } from "../plan.ts";
import {
  createDetails,
  describeAddAssignees,
  describeClose,
  describeCloseMilestone,
  describeDetach,
  describeMove,
  describeRemoveAssignees,
  describeRenameMilestone,
  describeReopen,
  describeUpdate,
} from "./describe.ts";
import type { Logger } from "./log.ts";
import type { Resolved } from "./resolved.ts";
import { combine, done, mirrorName, NOTHING } from "./tally.ts";
import type { Counter, Tally } from "./tally.ts";

/** What the preview reads: the logger, the base URL for titles, and the resolution map of the reads. */
export type PreviewContext = {
  readonly log: Logger;
  readonly youtrackBaseUrl: string;
  /** seedResolved of the reads; the preview never extends it. */
  readonly resolved: Resolved;
};

const DRY_RUN_TAG = "[dry-run]";

/** Logs each write that would be sent and counts it; sends nothing. */
export function previewActions(actions: readonly Action[], context: PreviewContext): Tally {
  return actions.reduce((tally, action) => combine(tally, previewAction(action, context)), NOTHING);
}

function previewAction(action: Action, context: PreviewContext): Tally {
  const { text, counter } = preview(action, context);
  context.log.info(`${DRY_RUN_TAG} would ${text}`);
  return done(counter);
}

function preview(action: Action, context: PreviewContext): { readonly text: string; readonly counter: Counter } {
  const { resolved } = context;
  switch (action.kind) {
    case "createMilestone":
      return {
        text: `create milestone ${mirrorName(action.issue)}: ${title(action, context)}`,
        counter: "milestonesCreated",
      };
    case "renameMilestone":
      return { text: `${describeRenameMilestone(action)}: ${action.title}`, counter: "updated" };
    case "closeMilestone":
      return { text: describeCloseMilestone(action), counter: "milestonesClosed" };
    case "create": {
      const details = createDetails(resolved, action);
      return { text: `create ${mirrorName(action.issue)}${details}: ${title(action, context)}`, counter: "created" };
    }
    case "close":
      return { text: describeClose(action), counter: "closed" };
    case "reopen":
      return { text: describeReopen(action), counter: "reopened" };
    case "update": {
      const newTitle = action.title === undefined ? "" : `: ${action.title}`;
      return { text: `${describeUpdate(resolved, action)}${newTitle}`, counter: "updated" };
    }
    case "setParent":
      return { text: describeMove(resolved, action), counter: "updated" };
    case "removeParent":
      return { text: describeDetach(action), counter: "updated" };
    case "addAssignees":
      return { text: describeAddAssignees(resolved, action), counter: "assigneesAdded" };
    case "removeAssignees":
      return { text: describeRemoveAssignees(action), counter: "assigneesRemoved" };
  }
}

function title(action: Action, context: PreviewContext): string {
  return formatMirror(action.issue, context.youtrackBaseUrl).title;
}
