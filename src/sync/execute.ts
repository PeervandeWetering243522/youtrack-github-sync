/**
 * The write phase of a run: planned actions become GitHub writes, sent serially and
 * WRITE_PAUSE_MS apart, until the write cap, the fetch guard, a GitHub rate limit or the
 * run deadline stops them. Dependencies (a milestone's epic, a parent issue) resolve
 * through the run-local map (src/sync/resolved.ts), extended by every successful create.
 * The writes themselves live in execute-issues.ts and execute-hierarchy.ts, the writer and
 * outcome handling in execute-write.ts. Only src/sync.ts builds the writer, and only when
 * dry run is off.
 */

import { DEFAULT_MAX_FETCHES } from "../http.ts";
import { writeCost } from "../plan.ts";
import type { Action } from "../plan.ts";
import {
  executeCloseMilestone,
  executeCreateMilestone,
  executeRemoveParent,
  executeSetParent,
  executeUpdate,
} from "./execute-hierarchy.ts";
import { executeClose, executeCreate } from "./execute-issues.ts";
import type { Step, WriteContext } from "./execute-write.ts";
import type { Resolved } from "./resolved.ts";
import { combine, NOTHING } from "./tally.ts";
import type { StopReason, Tally } from "./tally.ts";

/**
 * Runs the actions in order, starting from the resolution map `seed` (seedResolved of the
 * reads), until one of these stops it; the stopping action (unless it was sent) and
 * everything after it count as capped:
 * - the write cap (no warning: planActions already capped by writeCost);
 * - the run deadline, checked before each action starts (decision R8);
 * - the fetch guard refusing a write, or GitHub rate-limiting one (decision R7).
 * An action whose dependency was not created in this run is capped alone, with a warning,
 * and the run goes on (D4). A failed write is recorded and the run goes on (A10).
 */
export async function executeActions(
  actions: readonly Action[],
  context: WriteContext,
  seed: Resolved,
): Promise<Tally> {
  let tally = NOTHING;
  let resolved = seed;
  for (const [position, action] of actions.entries()) {
    const notYetRun = actions.length - position;
    // planActions capped by writeCost; label re-adds are extra writes it could not foresee.
    if (context.writer.count() + writeCost(action) > context.maxWrites) {
      return combine(tally, { ...NOTHING, capped: notYetRun });
    }
    if (context.now() >= context.deadline) {
      context.log.warn(`run deadline reached; ${String(notYetRun)} more action(s) capped`);
      return combine(tally, { ...NOTHING, capped: notYetRun });
    }
    const step = await executeAction(action, context, resolved);
    tally = combine(tally, step.tally);
    resolved = step.resolved;
    if (tally.stop !== null) {
      const rest = notYetRun - 1;
      context.log.warn(`${stopCause(tally.stop)}; ${String(rest)} more action(s) capped`);
      return combine(tally, { ...NOTHING, capped: rest });
    }
  }
  return tally;
}

function stopCause(reason: StopReason): string {
  switch (reason) {
    case "fetch-guard":
      return `fetch guard of ${String(DEFAULT_MAX_FETCHES)} reached`;
    case "rate-limit":
      return "GitHub rate limit hit";
  }
}

/** Only the two creates extend the resolution map; every other action leaves it as it is. */
function executeAction(action: Action, context: WriteContext, resolved: Resolved): Promise<Step> {
  switch (action.kind) {
    case "createMilestone":
      return executeCreateMilestone(action.issue, context, resolved);
    case "create":
      return executeCreate(action, context, resolved);
    case "closeMilestone":
      return unchangedMap(resolved, executeCloseMilestone(action, context));
    case "close":
      return unchangedMap(resolved, executeClose(action, context));
    case "update":
      return unchangedMap(resolved, executeUpdate(action, context, resolved));
    case "setParent":
      return unchangedMap(resolved, executeSetParent(action, context, resolved));
    case "removeParent":
      return unchangedMap(resolved, executeRemoveParent(action, context));
  }
}

async function unchangedMap(resolved: Resolved, tally: Promise<Tally>): Promise<Step> {
  return { tally: await tally, resolved };
}
