/**
 * Shared fixtures for the planner tests (test/plan*.test.ts): frozen GitHub issues and
 * milestones, YouTrack issues with a Type and a parent, mirror refs, read-only maps, a
 * `plan` shorthand over planActions and a compact view of actions. Everything is frozen
 * or locked, so any mutation by the code under test throws.
 */

import assert from "node:assert/strict";

import type { GitHubIssue } from "../src/github/issues.ts";
import type { GitHubMilestone } from "../src/github/milestones.ts";
import { YOUTRACK_TYPES } from "../src/hierarchy.ts";
import { planActions } from "../src/plan.ts";
import type { Action, Plan } from "../src/plan.ts";
import { buildMilestoneIndex } from "../src/plan/milestones.ts";
import type { MilestoneIndexResult } from "../src/plan/milestones.ts";
import type { MirrorIndex, MirrorRef } from "../src/plan/mirrors.ts";
import type { YouTrackIssue } from "../src/youtrack.ts";

export const LABEL = "youtrack";
export const EXCLUDE_PREFIX = "[individual]";
export const RESOLVED_AT = 1_758_000_000_000;

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

/**
 * A mirror ref as buildMirrorIndex makes it: open, labelled, id idOf(n), no milestone, type
 * or parent unless `fields` says otherwise.
 */
export function mirror(issueNumber: number, fields: Partial<MirrorRef> = {}): MirrorRef {
  return Object.freeze({
    issueNumber,
    id: idOf(issueNumber),
    state: "open",
    hasLabel: true,
    milestoneNumber: null,
    typeName: null,
    parentNumber: null,
    parentIsForeign: false,
    ...fields,
  });
}

/** A Map whose mutators throw, since Object.freeze does not stop Map#set. */
export function lockedMap<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  const refuse = (): never => {
    throw new TypeError("input map is read-only");
  };
  return Object.freeze(Object.assign(new Map(entries), { set: refuse, delete: refuse, clear: refuse }));
}

export const NO_MIRRORS: MirrorIndex = lockedMap<number, MirrorRef>([]);

/** A locked MirrorIndex from [numberInProject, ref] pairs. */
export function mirrors(...entries: readonly (readonly [number, MirrorRef])[]): MirrorIndex {
  return lockedMap(entries);
}

/** buildMilestoneIndex of frozen `milestones`, with locked maps and frozen warnings. */
export function milestoneIndex(...milestones: readonly GitHubMilestone[]): MilestoneIndexResult {
  const { index, byNumber, warnings } = buildMilestoneIndex(Object.freeze([...milestones]));
  return Object.freeze({
    index: lockedMap(index),
    byNumber: lockedMap(byNumber),
    warnings: Object.freeze([...warnings]),
  });
}

export const NO_MILESTONES: MilestoneIndexResult = milestoneIndex();

// ---------------------------------------------------------------------------
// YouTrack

/** An unresolved issue CUI-<n> with no Type, no parent and no exclude prefix. */
export function ytIssue(numberInProject: number, overrides: Partial<YouTrackIssue> = {}): YouTrackIssue {
  return Object.freeze({
    idReadable: `CUI-${String(numberInProject)}`,
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
  return { parentId: `CUI-${String(parent)}` };
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
};

export function plan(youtrackIssues: readonly YouTrackIssue[], options: PlanOptions = {}): Plan {
  return planActions({
    youtrackIssues: Object.freeze([...youtrackIssues]),
    mirrors: options.mirrors ?? NO_MIRRORS,
    milestones: options.milestones ?? NO_MILESTONES,
    excludePrefix: options.excludePrefix ?? EXCLUDE_PREFIX,
    maxWrites: options.maxWrites ?? 30,
  });
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
    case "closeMilestone":
      return `closeMilestone ${n} -> m${String(action.milestone.milestoneNumber)}`;
    case "create":
      return describeCreate(action);
    case "close":
      return `close ${n} -> #${String(action.mirror.issueNumber)}`;
    case "update": {
      const type = action.githubType === undefined ? "" : ` type=${action.githubType}`;
      return `update ${n} #${String(action.mirror.issueNumber)}${milestoneText(action.milestoneEpic)}${type}`;
    }
    case "setParent":
      return `setParent ${n} #${String(action.mirror.issueNumber)} under YT-${String(action.parentYt)}`;
    case "removeParent":
      return `removeParent ${n} #${String(action.mirror.issueNumber)} from #${String(action.parentNumber)} (YT-${String(action.parentYt)})`;
  }
}

/**
 * Compact view of actions: "create 3", "create 5 type=Task milestone=YT-1 parent=YT-2",
 * "close 5 -> #12", "update 5 #12 milestone=none type=Bug", "setParent 5 #12 under YT-2",
 * "removeParent 5 #12 from #20 (YT-2)", "createMilestone 9", "closeMilestone 9 -> m3".
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
