/**
 * Pure decision logic (docs/11 §1.2-1.4): YouTrack issues + GitHub mirrors and milestones
 * -> ordered, capped actions. No I/O. The indexes are built in src/plan/mirrors.ts and
 * src/plan/milestones.ts; the exclude filter lives in src/plan/exclude.ts and the
 * desired-state rules in src/plan/desired.ts.
 */

import type { GitHubTypeName, Hierarchy, IssueKind } from "./hierarchy.ts";
import { buildHierarchy, classify, depth, hierarchyWarnings } from "./hierarchy.ts";
import { desiredMilestoneEpic, desiredParent, parentChange, updateFields } from "./plan/desired.ts";
import type { ParentChange, PlanContext, UpdateFields } from "./plan/desired.ts";
import { mirrorTitle } from "./mirror.ts";
import { isExcluded } from "./plan/exclude.ts";
import { titleKey } from "./plan/milestones.ts";
import type { MilestoneIndexResult, MilestoneRef } from "./plan/milestones.ts";
import { mirrorNumbers } from "./plan/mirrors.ts";
import type { MirrorIndex, MirrorRef } from "./plan/mirrors.ts";
import type { YouTrackIssue } from "./youtrack.ts";

/**
 * One GitHub write. `issue` is the scanned YouTrack issue (the epic, for milestone actions).
 * Dependencies are YouTrack numbers (`milestoneEpic`, `parentYt`), resolved to GitHub
 * numbers and ids at execution, where one created in the same run may be missing (D4).
 */
export type Action =
  /** POST a milestone for an eligible unresolved epic without one (title and description from formatMirror). */
  | { readonly kind: "createMilestone"; readonly issue: YouTrackIssue }
  /** PATCH the title of an epic's milestone, open or closed, to the epic's mirrorTitle (N2). */
  | {
      readonly kind: "renameMilestone";
      readonly issue: YouTrackIssue;
      readonly milestone: MilestoneRef;
      readonly title: string;
    }
  /** Close the open milestone of a resolved epic. */
  | { readonly kind: "closeMilestone"; readonly issue: YouTrackIssue; readonly milestone: MilestoneRef }
  /** POST a mirror for an eligible unresolved non-epic without one. */
  | {
      readonly kind: "create";
      readonly issue: YouTrackIssue;
      /** The GitHub issue type (H6); null: none (D3). */
      readonly githubType: GitHubTypeName | null;
      /** The epic whose milestone to set (existing, or created earlier in this run); null: none. */
      readonly milestoneEpic: number | null;
      /** Tasks only: the issue whose mirror is the parent (existing, or created earlier); null: top-level. */
      readonly parentYt: number | null;
    }
  /** Close the open mirror of a resolved issue (A7). */
  | { readonly kind: "close"; readonly issue: YouTrackIssue; readonly mirror: MirrorRef }
  /** Reopen a closed mirror of an unresolved issue that PlanInput.reopenClosedBy closed (R10). */
  | { readonly kind: "reopen"; readonly issue: YouTrackIssue; readonly mirror: MirrorRef }
  /** PATCH the mirror's title, milestone and/or type (the type guarantees at least one of the keys). */
  | ({ readonly kind: "update"; readonly issue: YouTrackIssue; readonly mirror: MirrorRef } & UpdateFields)
  /** Put the mirror under the mirror of `parentYt`, replacing any current parent (replace_parent). */
  | { readonly kind: "setParent"; readonly issue: YouTrackIssue; readonly mirror: MirrorRef; readonly parentYt: number }
  /** Take the mirror out from under its current parent, the mirror #parentNumber of YouTrack issue `parentYt`. */
  | {
      readonly kind: "removeParent";
      readonly issue: YouTrackIssue;
      readonly mirror: MirrorRef;
      readonly parentNumber: number;
      readonly parentYt: number;
    };

/** What planActions reads. */
export type PlanInput = {
  /** Every scanned issue, filtered and resolved ones included: the hierarchy walks all of them. */
  readonly youtrackIssues: readonly YouTrackIssue[];
  /** buildMirrorIndex(...).index of every GitHub issue; its warnings are logged by the caller, not repeated here. */
  readonly mirrors: MirrorIndex;
  /** buildMilestoneIndex of every GitHub milestone; its warnings are passed on in Plan.warnings. */
  readonly milestones: MilestoneIndexResult;
  /** YOUTRACK_EXCLUDE_PREFIX: an issue whose summary, or an ancestor's, starts with it is filtered (F1, F3). */
  readonly excludePrefix: string;
  readonly maxWrites: number;
  /** REOPEN_CLOSED_BY: the login whose closes are undone (R10); null: never reopen. */
  readonly reopenClosedBy: string | null;
};

/**
 * The run's plan. Counts are of scanned issues, except `capped` (of actions): an issue can
 * need several actions (e.g. update, setParent, close), so scanned = filtered + unchanged +
 * the issues with at least one action.
 */
export type Plan = {
  /** In execution order (docs/11 §1.4), already capped. */
  readonly actions: readonly Action[];
  /** YouTrack issues scanned (one per numberInProject). */
  readonly scanned: number;
  /**
   * Issues and epics excluded by the exclude prefix, their own (F1) or an ancestor's (F3);
   * ignored entirely, existing mirror or milestone included (F2).
   */
  readonly filtered: number;
  /**
   * Eligible issues and epics that need no write: a mirror or milestone already as desired,
   * a closed one whose YouTrack issue was reopened that `reopenClosedBy` did not close (R10),
   * or a resolved issue or epic without one (never mirrored, R9).
   */
  readonly unchanged: number;
  /** Actions dropped by the write cap. */
  readonly capped: number;
  /** The milestone index warnings, then one per YouTrack parent cycle; ids and numbers only. */
  readonly warnings: readonly string[];
};

/** GitHub writes an action costs: 1 for every kind (an update sends title, milestone and type in one PATCH). */
export function writeCost(action: Action): number {
  switch (action.kind) {
    case "createMilestone":
    case "renameMilestone":
    case "closeMilestone":
    case "create":
    case "close":
    case "reopen":
    case "update":
    case "setParent":
    case "removeParent":
      return 1;
  }
}

/**
 * - skip excluded issues and epics (filtered, src/plan/exclude.ts): the summary of the
 *   issue (F1) or of any YouTrack ancestor (F3) starts with `excludePrefix`. Nothing is
 *   planned for them, not even for an existing mirror or milestone (F2), and none of them is
 *   ever used as a milestone or parent;
 * - epics (H1): no milestone && unresolved -> createMilestone; a milestone, open or closed,
 *   whose title is not the epic's mirrorTitle -> renameMilestone (N2); open milestone &&
 *   resolved -> closeMilestone; milestones are never reopened or re-described (D7);
 * - other issues: no mirror && unresolved -> create, with type, milestone epic and (tasks
 *   only) parent; no mirror && resolved -> nothing (R9); every mirror, open or closed (D8),
 *   gets update (title, milestone, type) / setParent / removeParent where it differs from the
 *   desired state (src/plan/desired.ts); open mirror && resolved -> close; closed mirror &&
 *   unresolved && closed by `reopenClosedBy` -> reopen (R10); nothing else is reopened, and
 *   milestones never are;
 * - order (docs/11 §1.4): milestone writes by epic number; creates of non-tasks by number,
 *   then of tasks by YouTrack depth, then number (parent before child, D4); sync writes by
 *   number (an issue's update before its parent change); closes and reopens by number;
 * - take actions while their cost fits in maxWrites; at the first action that does not fit,
 *   stop -- it and everything after it count as capped. Nothing later jumps ahead (A2), so a
 *   child is never planned without the create it depends on (D4).
 */
export function planActions(input: PlanInput): Plan {
  const ordered = uniqueAscending(input.youtrackIssues);
  const context = planContext(input, ordered);
  const needed: Action[] = [];
  let filtered = 0;
  let unchanged = 0;
  for (const issue of ordered) {
    const actions = context.excluded.has(issue.numberInProject) ? null : actionsFor(context, issue);
    if (actions === null) filtered += 1;
    else if (actions.length === 0) unchanged += 1;
    else needed.push(...actions);
  }
  const sorted = inExecutionOrder(context.hierarchy, needed);
  const actions = withinWriteCap(sorted, input.maxWrites);
  const warnings = [...input.milestones.warnings, ...hierarchyWarnings(context.hierarchy)];
  return { actions, scanned: ordered.length, filtered, unchanged, capped: sorted.length - actions.length, warnings };
}

// ---------------------------------------------------------------------------
// Per-issue decisions

/**
 * A sorted copy with one issue per numberInProject (the first listed), so a repeated
 * row can never plan a second create. fetchProjectIssues already dedupes; this keeps
 * the planner safe on its own.
 */
function uniqueAscending(issues: readonly YouTrackIssue[]): readonly YouTrackIssue[] {
  // Array#sort is stable, so the first listed copy of a number stays first.
  const sorted = [...issues].sort((a, b) => a.numberInProject - b.numberInProject);
  return sorted.filter((issue, position) => sorted[position - 1]?.numberInProject !== issue.numberInProject);
}

function isEpic(issue: YouTrackIssue): boolean {
  return classify(issue.type).kind === "milestone";
}

function numbers(issues: readonly YouTrackIssue[]): ReadonlySet<number> {
  return new Set(issues.map(({ numberInProject }) => numberInProject));
}

/**
 * The hierarchy of `issues`, which of them are excluded (F1, F3), and what this run
 * creates: issues and epics that are not excluded, unresolved and not yet mirrored.
 */
function planContext(input: PlanInput, issues: readonly YouTrackIssue[]): PlanContext {
  const hierarchy = buildHierarchy(issues);
  const excluded = numbers(issues.filter((issue) => isExcluded(hierarchy, issue, input.excludePrefix)));
  const creatable = issues.filter((issue) => !excluded.has(issue.numberInProject) && issue.resolved === null);
  return {
    hierarchy,
    excluded,
    mirrors: input.mirrors,
    mirrorOf: mirrorNumbers(input.mirrors),
    milestones: input.milestones,
    newIssues: numbers(creatable.filter((issue) => !isEpic(issue) && !input.mirrors.has(issue.numberInProject))),
    newMilestones: numbers(
      creatable.filter((issue) => isEpic(issue) && !input.milestones.index.has(issue.numberInProject)),
    ),
    reopenClosedBy: input.reopenClosedBy,
  };
}

/** The actions an issue or epic that is not excluded needs, in the order they run; none: unchanged. */
function actionsFor(context: PlanContext, issue: YouTrackIssue): readonly Action[] {
  const { kind, githubType } = classify(issue.type);
  if (kind === "milestone") return epicActions(context, issue);
  const mirror = context.mirrors.get(issue.numberInProject);
  if (mirror === undefined) {
    if (!context.newIssues.has(issue.numberInProject)) return [];
    const milestoneEpic = desiredMilestoneEpic(context, issue);
    const parentYt = kind === "task" ? desiredParent(context, issue) : null;
    return [{ kind: "create", issue, githubType, milestoneEpic, parentYt }];
  }
  return mirrorActions(context, issue, { kind, githubType }, mirror);
}

/**
 * createMilestone for a new epic; for an existing milestone, renameMilestone when its title
 * is not the epic's (N2) and no other milestone has that title yet (GitHub would refuse it on
 * every run; that other milestone is a duplicate the index already warns about), then
 * closeMilestone when the epic is resolved. Never reopen or re-describe (D7).
 */
function epicActions(context: PlanContext, issue: YouTrackIssue): readonly Action[] {
  const milestone = context.milestones.index.get(issue.numberInProject);
  if (milestone === undefined) {
    return context.newMilestones.has(issue.numberInProject) ? [{ kind: "createMilestone", issue }] : [];
  }
  const title = mirrorTitle(issue);
  const owners = context.milestones.titleOwners.get(titleKey(title)) ?? [];
  const isTaken = owners.some((owner) => owner !== milestone.milestoneNumber);
  const actions: Action[] = [];
  if (milestone.title !== title && !isTaken) {
    actions.push({ kind: "renameMilestone", issue, milestone, title });
  }
  if (milestone.state === "open" && issue.resolved !== null) actions.push({ kind: "closeMilestone", issue, milestone });
  return actions;
}

/** Sync writes for an existing mirror, open or closed (D8), then its close if it is due. */
function mirrorActions(
  context: PlanContext,
  issue: YouTrackIssue,
  classified: { readonly kind: IssueKind; readonly githubType: GitHubTypeName | null },
  mirror: MirrorRef,
): readonly Action[] {
  const actions: Action[] = [];
  const fields = updateFields(context, mirror, {
    title: mirrorTitle(issue),
    milestoneEpic: desiredMilestoneEpic(context, issue),
    githubType: classified.githubType,
  });
  if (fields !== null) actions.push({ kind: "update", issue, mirror, ...fields });
  // Only tasks become sub-issues (H9); for any other kind the desired parent is none.
  const change = parentChange(context, mirror, classified.kind === "task" ? desiredParent(context, issue) : null);
  if (change !== null) actions.push(parentAction(issue, mirror, change));
  if (mirror.state === "open" && issue.resolved !== null) actions.push({ kind: "close", issue, mirror });
  if (isReopenDue(context, issue, mirror)) actions.push({ kind: "reopen", issue, mirror });
  return actions;
}

/**
 * R10: a closed mirror of an unresolved issue is reopened only when the `reopenClosedBy`
 * login closed it; a close by any other login (a person, or this tool on an earlier token)
 * stays. With github-actions[bot] that includes closes by any workflow using GITHUB_TOKEN.
 * Logins compare ASCII-case-insensitively, as GitHub treats them.
 */
function isReopenDue(context: PlanContext, issue: YouTrackIssue, mirror: MirrorRef): boolean {
  const { reopenClosedBy } = context;
  if (reopenClosedBy === null || mirror.state !== "closed" || issue.resolved !== null) return false;
  return mirror.closedBy !== null && loginKey(mirror.closedBy) === loginKey(reopenClosedBy);
}

function loginKey(login: string): string {
  return login.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

function parentAction(issue: YouTrackIssue, mirror: MirrorRef, change: ParentChange): Action {
  switch (change.kind) {
    case "set":
      return { kind: "setParent", issue, mirror, parentYt: change.parentYt };
    case "remove":
      return { kind: "removeParent", issue, mirror, parentNumber: change.parentNumber, parentYt: change.parentYt };
  }
}

// ---------------------------------------------------------------------------
// Order and cap

/** Execution phases of docs/11 §1.4, in order. */
const PHASE = { milestones: 0, issueCreates: 1, taskCreates: 2, sync: 3, closes: 4 } as const;

function phaseOf(action: Action): number {
  switch (action.kind) {
    case "createMilestone":
    case "renameMilestone":
    case "closeMilestone":
      return PHASE.milestones;
    case "create":
      return classify(action.issue.type).kind === "task" ? PHASE.taskCreates : PHASE.issueCreates;
    case "update":
    case "setParent":
    case "removeParent":
      return PHASE.sync;
    case "close":
    case "reopen":
      return PHASE.closes;
  }
}

type SortKey = { readonly phase: number; readonly depth: number; readonly numberInProject: number };

/**
 * `actions` sorted by phase, then (task creates only) YouTrack depth, then numberInProject.
 * The sort is stable and `actions` arrive per issue in run order, so an issue's update stays
 * before its parent change.
 */
function inExecutionOrder(hierarchy: Hierarchy, actions: readonly Action[]): readonly Action[] {
  const keyed = actions.map((action) => {
    const phase = phaseOf(action);
    const key: SortKey = {
      phase,
      depth: phase === PHASE.taskCreates ? depth(hierarchy, action.issue) : 0,
      numberInProject: action.issue.numberInProject,
    };
    return { action, key };
  });
  return keyed.sort((a, b) => compareKeys(a.key, b.key)).map(({ action }) => action);
}

function compareKeys(a: SortKey, b: SortKey): number {
  if (a.phase !== b.phase) return a.phase - b.phase;
  if (a.depth !== b.depth) return a.depth - b.depth;
  return a.numberInProject - b.numberInProject;
}

/**
 * The longest prefix of `actions` whose total writeCost fits in `maxWrites` (NaN: none).
 * It ends at the first action that does not fit, so nothing later jumps ahead.
 */
function withinWriteCap(actions: readonly Action[], maxWrites: number): readonly Action[] {
  const taken: Action[] = [];
  let used = 0;
  for (const action of actions) {
    const cost = writeCost(action);
    // Written as !(<=) so a NaN cap takes nothing.
    if (!(used + cost <= maxWrites)) break;
    taken.push(action);
    used += cost;
  }
  return taken;
}
