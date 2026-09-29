/**
 * The dry-run preview (DRY_RUN on): one "[dry-run] would ..." line per planned action,
 * counted as the write phase counts a done one. It gets neither a writer nor an HTTP
 * client, so it cannot send anything. Lines carry numbers only, except the two create lines,
 * which end with the mirror title (decision R3). A milestone or mirror created earlier in
 * the run is named "(new)", since it has no GitHub number yet.
 */

import { formatMirror } from "../mirror.ts";
import type { Action } from "../plan.ts";
import {
  createDetails,
  describeClose,
  describeCloseMilestone,
  describeDetach,
  describeMove,
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
    case "closeMilestone":
      return { text: describeCloseMilestone(action), counter: "milestonesClosed" };
    case "create": {
      const details = createDetails(resolved, action);
      return { text: `create ${mirrorName(action.issue)}${details}: ${title(action, context)}`, counter: "created" };
    }
    case "close":
      return { text: describeClose(action), counter: "closed" };
    case "update":
      return { text: describeUpdate(resolved, action), counter: "updated" };
    case "setParent":
      return { text: describeMove(resolved, action), counter: "updated" };
    case "removeParent":
      return { text: describeDetach(action), counter: "updated" };
  }
}

function title(action: Action, context: PreviewContext): string {
  return formatMirror(action.issue, context.youtrackBaseUrl).title;
}
