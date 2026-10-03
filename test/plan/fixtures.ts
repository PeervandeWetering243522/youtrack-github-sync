/**
 * Shared fixtures for the planner tests (test/plan/*.test.ts): frozen GitHub issues and
 * milestones, YouTrack issues of project CUI with a Type and a parent, mirror refs, read-only
 * maps, a `plan` shorthand over planActions and a compact view of actions. Everything is
 * frozen or locked, so any mutation by the code under test throws.
 */

import assert from "node:assert/strict";

import type { GitHubIssue } from "../../src/github/issues.ts";
import type { GitHubMilestone } from "../../src/github/milestones.ts";
import { YOUTRACK_TYPES } from "../../src/hierarchy.ts";
import { planActions } from "../../src/plan.ts";
import type { Action, AssigneeSync, Plan } from "../../src/plan.ts";
import { loginKey } from "../../src/plan/assignee-match.ts";
import { buildMilestoneIndex } from "../../src/plan/milestones.ts";
import type { MilestoneIndexResult } from "../../src/plan/milestones.ts";
import type { MirrorIndex, MirrorRef } from "../../src/plan/mirrors.ts";
import type { YouTrackIssue } from "../../src/youtrack.ts";

export const LABEL = "youtrack";
/** The configured YouTrack project (YOUTRACK_PROJECT) of every fixture issue. */
export const PROJECT = "CUI";
export const EXCLUDE_PREFIX = "[individual]";
export const RESOLVED_AT = 1_758_000_000_000;

/**
 * The mirror or milestone title planActions wants for ytIssue(n) with its default summary,
 * "[CUI-<n>] Issue <n>" (N1). A fixture mirror gets it from mirrors(...) unless it has a title.
 */
export function desiredTitle(numberInProject: number): string {
  return `[${PROJECT}-${String(numberInProject)}] Issue ${String(numberInProject)}`;
}

// ---------------------------------------------------------------------------
// GitHub

/** The REST id a fixture issue gets: 1_000_000 + its number. */
export function idOf(issueNumber: number): number {
  return 1_000_000 + issueNumber;
}

export function ghIssue(issueNumber: number, title: string, overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  const labelNames = Object.freeze([...(overrides.labelNames ?? [LABEL])]);
  const defaults: GitHubIssue = {
    number: issueNumber,
    id: idOf(issueNumber),
    title,
    state: "open",
    labelNames,
    isPullRequest: false,
    milestoneNumber: null,
    typeName: null,
    parentNumber: null,
    parentIsForeign: false,
    closedBy: null,
    assignees: Object.freeze([]),
  };
  return Object.freeze({ ...defaults, ...overrides, labelNames });
}

export function unlabelled(issueNumber: number, title: string, overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return ghIssue(issueNumber, title, { ...overrides, labelNames: [] });
}

export function ghMilestone(
  milestoneNumber: number,
  title: string,
  state: GitHubMilestone["state"] = "open",
): GitHubMilestone {
  return Object.freeze({ number: milestoneNumber, title, state });
}

/** A mirror ref that may still lack its title, which depends on its YouTrack number (see titled). */
export type MirrorDraft = Omit<MirrorRef, "title"> & Partial<Pick<MirrorRef, "title">>;

/**
 * A mirror ref as buildMirrorIndex makes it: open, labelled, id idOf(n), no milestone, type,
 * parent, closer or assignees unless `fields` says otherwise. It has no title unless `fields` gives one;
 * mirrors(...) and titled(...) fill in desiredTitle of its YouTrack number.
 */
export function mirror(issueNumber: number, fields: Partial<MirrorRef> = {}): MirrorDraft {
  return Object.freeze({
    issueNumber,
    id: idOf(issueNumber),
    state: "open",
    hasLabel: true,
    milestoneNumber: null,
    typeName: null,
    parentNumber: null,
    parentIsForeign: false,
    closedBy: null,
    assignees: Object.freeze([]),
    ...fields,
  });
}

/** The login the reopen tests configure as REOPEN_CLOSED_BY (the GitHub Action's default). */
export const ACTIONS_BOT = "github-actions[bot]";

/** A closed mirror ref that login `closer` closed (null: no closer reported); otherwise as mirror(...). */
export function closedMirror(issueNumber: number, closer: string | null, fields: Partial<MirrorRef> = {}): MirrorDraft {
  return mirror(issueNumber, { state: "closed", closedBy: closer, ...fields });
}

/** A Map whose mutators throw, since Object.freeze does not stop Map#set. */
export function lockedMap<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  const refuse = (): never => {
    throw new TypeError("input map is read-only");
  };
  return Object.freeze(Object.assign(new Map(entries), { set: refuse, delete: refuse, clear: refuse }));
}

export const NO_MIRRORS: MirrorIndex = lockedMap<number, MirrorRef>([]);

/** `draft` as the whole mirror ref of YouTrack issue `numberInProject`: its own title, else desiredTitle. */
export function titled(numberInProject: number, draft: MirrorDraft): MirrorRef {
  return Object.freeze({ ...draft, title: draft.title ?? desiredTitle(numberInProject) });
}

/**
 * A locked MirrorIndex from [numberInProject, mirror] pairs, each one titled: a mirror the
 * test gave no title already has the desired one, so it needs no title update.
 */
export function mirrors(...entries: readonly (readonly [number, MirrorDraft])[]): MirrorIndex {
  return lockedMap(
    entries.map(([numberInProject, draft]) => [numberInProject, titled(numberInProject, draft)] as const),
  );
}

/** buildMilestoneIndex for PROJECT of frozen `milestones`, with locked maps and frozen warnings. */
export function milestoneIndex(...milestones: readonly GitHubMilestone[]): MilestoneIndexResult {
  const { index, byNumber, titleOwners, warnings } = buildMilestoneIndex(Object.freeze([...milestones]), PROJECT);
  return Object.freeze({
    index: lockedMap(index),
    byNumber: lockedMap(byNumber),
    titleOwners: lockedMap(titleOwners),
    warnings: Object.freeze([...warnings]),
  });
}

export const NO_MILESTONES: MilestoneIndexResult = milestoneIndex();

// ---------------------------------------------------------------------------
// YouTrack

/** An unresolved issue CUI-<n> with no Type, no parent and no exclude prefix. */
export function ytIssue(numberInProject: number, overrides: Partial<YouTrackIssue> = {}): YouTrackIssue {
  return Object.freeze({
    idReadable: `${PROJECT}-${String(numberInProject)}`,
    numberInProject,
    summary: `Issue ${String(numberInProject)}`,
    description: null,
    resolved: null,
    updated: 0,
    type: null,
    parentId: null,
    ...overrides,
  });
}

export function resolvedIssue(numberInProject: number, overrides: Partial<YouTrackIssue> = {}): YouTrackIssue {
  return ytIssue(numberInProject, { resolved: RESOLVED_AT, ...overrides });
}

export function epic(numberInProject: number, overrides: Partial<YouTrackIssue> = {}): YouTrackIssue {
  return ytIssue(numberInProject, { type: YOUTRACK_TYPES.epic, ...overrides });
}

export function story(numberInProject: number, overrides: Partial<YouTrackIssue> = {}): YouTrackIssue {
  return ytIssue(numberInProject, { type: YOUTRACK_TYPES.userStory, ...overrides });
}

export function bug(numberInProject: number, overrides: Partial<YouTrackIssue> = {}): YouTrackIssue {
  return ytIssue(numberInProject, { type: YOUTRACK_TYPES.bug, ...overrides });
}

export function task(numberInProject: number, overrides: Partial<YouTrackIssue> = {}): YouTrackIssue {
  return ytIssue(numberInProject, { type: YOUTRACK_TYPES.task, ...overrides });
}

/** Overrides that make CUI-<parent> the Subtask parent. */
export function under(parent: number): Partial<YouTrackIssue> {
  return { parentId: `${PROJECT}-${String(parent)}` };
}

/** Overrides for a summary with the exclude prefix (the issue and its descendants are filtered, F1/F3). */
export const FILTERED: Partial<YouTrackIssue> = Object.freeze({ summary: `${EXCLUDE_PREFIX} Not for the team` });

// ---------------------------------------------------------------------------
// Planning

export type PlanOptions = {
  readonly mirrors?: MirrorIndex;
  readonly milestones?: MilestoneIndexResult;
  readonly maxWrites?: number;
  readonly excludePrefix?: string;
  /** REOPEN_CLOSED_BY; left out: null, so nothing is reopened (the default outside the Action). */
  readonly reopenClosedBy?: string | null;
  /** What the assignee stage matched; left out: null, so no assignee action is planned. */
  readonly assignees?: AssigneeSync | null;
};

export function plan(youtrackIssues: readonly YouTrackIssue[], options: PlanOptions = {}): Plan {
  return planActions({
    youtrackIssues: Object.freeze([...youtrackIssues]),
    mirrors: options.mirrors ?? NO_MIRRORS,
    milestones: options.milestones ?? NO_MILESTONES,
    excludePrefix: options.excludePrefix ?? EXCLUDE_PREFIX,
    maxWrites: options.maxWrites ?? 30,
    reopenClosedBy: options.reopenClosedBy ?? null,
    assignees: options.assignees ?? null,
  });
}

/**
 * A frozen AssigneeSync: `desired` as [numberInProject, logins] pairs, `owned` as logins (A-Z
 * lowercased here, as ownedLogins keys them).
 */
export function assigneeSync(
  desired: readonly (readonly [number, readonly string[]])[],
  owned: readonly string[] = desired.flatMap(([, logins]) => logins),
): AssigneeSync {
  return Object.freeze({
    desired: lockedMap(desired.map(([numberInProject, logins]) => [numberInProject, Object.freeze([...logins])])),
    owned: lockedSet(owned.map(loginKey)),
  });
}

/** A Set whose mutators throw, since Object.freeze does not stop Set#add. */
function lockedSet<T>(values: Iterable<T>): ReadonlySet<T> {
  const refuse = (): never => {
    throw new TypeError("input set is read-only");
  };
  return Object.freeze(Object.assign(new Set(values), { add: refuse, delete: refuse, clear: refuse }));
}

/** " milestone=YT-9", " milestone=none" or "" for an optional milestone epic. */
function milestoneText(milestoneEpic: number | null | undefined): string {
  if (milestoneEpic === undefined) return "";
  return ` milestone=${milestoneEpic === null ? "none" : `YT-${String(milestoneEpic)}`}`;
}

function describeCreate(action: Extract<Action, { readonly kind: "create" }>): string {
  const n = String(action.issue.numberInProject);
  const type = action.githubType === null ? "" : ` type=${action.githubType}`;
  const milestone = action.milestoneEpic === null ? "" : milestoneText(action.milestoneEpic);
  const parent = action.parentYt === null ? "" : ` parent=YT-${String(action.parentYt)}`;
  return `create ${n}${type}${milestone}${parent}`;
}

function describeAction(action: Action): string {
  const n = String(action.issue.numberInProject);
  switch (action.kind) {
    case "createMilestone":
      return `createMilestone ${n}`;
    case "renameMilestone":
      return `renameMilestone ${n} -> m${String(action.milestone.milestoneNumber)}`;
    case "closeMilestone":
      return `closeMilestone ${n} -> m${String(action.milestone.milestoneNumber)}`;
    case "create":
      return describeCreate(action);
    case "close":
      return `close ${n} -> #${String(action.mirror.issueNumber)}`;
    case "reopen":
      return `reopen ${n} -> #${String(action.mirror.issueNumber)}`;
    case "update": {
      const title = action.title === undefined ? "" : " title";
      const type = action.githubType === undefined ? "" : ` type=${action.githubType}`;
      return `update ${n} #${String(action.mirror.issueNumber)}${title}${milestoneText(action.milestoneEpic)}${type}`;
    }
    case "setParent":
      return `setParent ${n} #${String(action.mirror.issueNumber)} under YT-${String(action.parentYt)}`;
    case "removeParent":
      return `removeParent ${n} #${String(action.mirror.issueNumber)} from #${String(action.parentNumber)} (YT-${String(action.parentYt)})`;
    case "addAssignees":
      return `addAssignees ${n} +${action.logins.join(",")}`;
    case "removeAssignees":
      return `removeAssignees ${n} #${String(action.mirror.issueNumber)} -${action.logins.join(",")}`;
  }
}

/**
 * Compact view of actions: "create 3", "create 5 type=Task milestone=YT-1 parent=YT-2",
 * "close 5 -> #12", "reopen 5 -> #12", "update 5 #12 title milestone=none type=Bug" (the new title itself is not
 * shown), "setParent 5 #12 under YT-2", "removeParent 5 #12 from #20 (YT-2)",
 * "createMilestone 9", "renameMilestone 9 -> m3", "closeMilestone 9 -> m3",
 * "addAssignees 5 +a,b" (the mirror is resolved at execution), "removeAssignees 5 #12 -c".
 * YT-<n> here is just YouTrack number n, not a title or log format.
 */
export function describeActions(actions: readonly Action[]): readonly string[] {
  return actions.map(describeAction);
}

/** For plans where every issue needs at most one action: scanned = filtered + unchanged + actions + capped. */
export function assertCountsAddUp(result: Plan): void {
  assert.equal(result.scanned, result.filtered + result.unchanged + result.actions.length + result.capped);
}

/** The four counts of a plan, for one deepEqual. */
export function counts(result: Plan): Pick<Plan, "scanned" | "filtered" | "unchanged" | "capped"> {
  return { scanned: result.scanned, filtered: result.filtered, unchanged: result.unchanged, capped: result.capped };
}
