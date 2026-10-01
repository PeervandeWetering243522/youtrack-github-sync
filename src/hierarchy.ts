/**
 * Pure YouTrack hierarchy logic (docs/11 §1.1-1.2), no I/O: classify an issue by its
 * Type value (H1, H6, D3) and walk Subtask parent links for every YouTrack ancestor (the
 * inherited exclusion, F3), its nearest epic (the milestone source, H4/D1), its non-epic
 * ancestors (task parents, H3/H9) and its depth.
 *
 * Parents are looked up among the scanned issues only, by idReadable compared
 * ASCII-case-insensitively (as parseProjectIssue compares it, R4). A parent outside
 * the scan, such as one in another project, ends the walk (D5).
 *
 * YouTrack should never hold a parent cycle. If it does, the walks for milestones,
 * parents and order (ancestors, nearestEpic, parentChain, depth) ignore every parent
 * link ON the cycle, so each issue on it acts as a root there, and hierarchyWarnings
 * names the cycle; an issue that merely points into a cycle keeps that parent. Those
 * walks are therefore total and form a forest: every ancestor has a smaller depth than
 * its descendants, so a parent-before-child order always exists. Only linkedAncestors
 * follows the links on a cycle (once around it), because each member of a cycle is a
 * YouTrack ancestor of the others and the exclude filter must see them all (F3).
 *
 * buildHierarchy resolves every parent link once, so a walk costs one map lookup per
 * ancestor (the planner walks every issue each run, within the Workers CPU budget).
 */

import type { YouTrackIssue } from "./youtrack.ts";

/** What an issue becomes on GitHub: a milestone, a top-level issue, or a task (sub-issue or top-level). */
export type IssueKind = "milestone" | "issue" | "task";

/** The GitHub issue types the mirror sets (H6). */
export type GitHubTypeName = "Feature" | "Bug" | "Task";

/** The YouTrack `Type` value names that have a mapping (H1). Matched exactly and case-sensitively. */
export const YOUTRACK_TYPES = { epic: "Epic", userStory: "User Story", bug: "Bug", task: "Task" } as const;

/** One parent cycle: `closer`'s parent link returns to `lowest`, the cycle's lowest-numbered issue. */
type CycleLink = { readonly closer: YouTrackIssue; readonly lowest: YouTrackIssue };

/**
 * The scanned issues indexed for parent walks. Build it with buildHierarchy and read
 * it only through the functions of this module.
 */
export type Hierarchy = {
  /** Scanned issues by idKey(idReadable); the first listed copy of an id wins. */
  readonly byId: ReadonlyMap<string, YouTrackIssue>;
  /** Each indexed issue's indexed parent, links on a cycle included; no entry for a root or a parent outside the scan. */
  readonly links: ReadonlyMap<YouTrackIssue, YouTrackIssue>;
  /** `links` without the links on a cycle: no entry for a root, a parent outside the scan or a link on a cycle. */
  readonly parents: ReadonlyMap<YouTrackIssue, YouTrackIssue>;
  /** The indexed issues on a parent cycle, whose own parent links are ignored. */
  readonly onCycle: ReadonlySet<YouTrackIssue>;
  /** One entry per cycle, ascending `lowest`. */
  readonly cycles: readonly CycleLink[];
};

/**
 * Kind and GitHub issue type of a YouTrack `Type` value (docs/11 §1.1): Epic -> milestone,
 * User Story -> issue/Feature, Bug -> issue/Bug, Task -> task/Task. Any other value,
 * including null and case variants, -> issue without a GitHub type (D3).
 */
export function classify(type: string | null): {
  readonly kind: IssueKind;
  readonly githubType: GitHubTypeName | null;
} {
  switch (type) {
    case YOUTRACK_TYPES.epic:
      return { kind: "milestone", githubType: null };
    case YOUTRACK_TYPES.userStory:
      return { kind: "issue", githubType: "Feature" };
    case YOUTRACK_TYPES.bug:
      return { kind: "issue", githubType: "Bug" };
    case YOUTRACK_TYPES.task:
      return { kind: "task", githubType: "Task" };
    case null:
    default:
      return { kind: "issue", githubType: null };
  }
}

/**
 * Indexes `issues` (every scanned issue, filtered and resolved ones included) by
 * idReadable, keeping the first listed copy of a repeated id, resolves each one's parent
 * and finds every parent cycle among them. Does not modify `issues`.
 */
export function buildHierarchy(issues: readonly YouTrackIssue[]): Hierarchy {
  const byId = indexById(issues);
  const links = parentLinks(byId);
  const cycles = findCycles(byId, links);
  const onCycle = new Set(cycles.flatMap((cycle) => cycle.members));
  const parents = new Map([...links].filter(([child]) => !onCycle.has(child)));
  return { byId, links, parents, onCycle, cycles: cycles.map(({ closer, lowest }) => ({ closer, lowest })) };
}

/**
 * Every ancestor of `issue` in the scan's forest (links on a cycle ignored), of any Type
 * (epics included) and in any state, nearest first. The walk ends at a root, at a parent
 * outside the scan (D5) or at a link on a cycle, and never repeats an issue. `issue` need
 * not be in the hierarchy; its own parentId starts the walk, unless its idReadable is on a
 * cycle (then it has no ancestors). nearestEpic, parentChain and depth are built on it; the
 * exclude filter uses linkedAncestors instead, which follows the links on a cycle too.
 */
export function ancestors(hierarchy: Hierarchy, issue: YouTrackIssue): readonly YouTrackIssue[] {
  const { self, seen } = walkStart(hierarchy, issue);
  // buildHierarchy leaves no cycle in `parents`, so only an `issue` that is not the indexed
  // copy can reach a repeat (by walking back to its own id).
  return walkUp(firstParent(hierarchy, issue, self), seen, (next) => hierarchy.parents.get(next));
}

/**
 * Every issue that `issue`'s parent links reach in the scan, nearest first: all its YouTrack
 * ancestors, of any Type (epics included) and in any state, which the inherited exclusion
 * checks (F3). Unlike `ancestors` it follows the links on a cycle too, once around, since
 * each member of a cycle is an ancestor of the others. The walk ends at a root, at a parent
 * outside the scan (D5) or at the first repeat: of `issue`, of the indexed copy of its id,
 * or of an issue already found. `issue` need not be in the hierarchy; its own parentId
 * starts the walk.
 */
export function linkedAncestors(hierarchy: Hierarchy, issue: YouTrackIssue): readonly YouTrackIssue[] {
  const { seen } = walkStart(hierarchy, issue);
  return walkUp(parentOf(hierarchy.byId, issue), seen, (next) => hierarchy.links.get(next));
}

/**
 * The first ancestor of `issue` whose Type is Epic (D1: higher epics are not searched),
 * or null when the walk ends first: no parent, a parent outside the scan (D5), or a
 * link on a cycle. `issue` need not be in the hierarchy; its own parentId starts the
 * walk, unless its idReadable is on a cycle (then it has no ancestors).
 */
export function nearestEpic(hierarchy: Hierarchy, issue: YouTrackIssue): YouTrackIssue | null {
  return ancestors(hierarchy, issue).find(isEpic) ?? null;
}

/**
 * The non-epic ancestors of `issue`, nearest first, ending before the first epic, at a
 * parent outside the scan (D5) or at a link on a cycle. The planner takes the first one
 * that is (or becomes) mirrored as a task's GitHub parent (H3, H9).
 */
export function parentChain(hierarchy: Hierarchy, issue: YouTrackIssue): readonly YouTrackIssue[] {
  const all = ancestors(hierarchy, issue);
  const epicAt = all.findIndex(isEpic);
  return epicAt === -1 ? all : all.slice(0, epicAt);
}

/**
 * How many ancestors `issue` has in the scan, epics included (0: a root, a parent outside
 * the scan, or an issue on a cycle). Every ancestor has a smaller depth than `issue`, so
 * ascending depth orders creates parent before child.
 */
export function depth(hierarchy: Hierarchy, issue: YouTrackIssue): number {
  return ancestors(hierarchy, issue).length;
}

/**
 * One warning per parent cycle, ascending by its lowest issue number:
 * "CUI-<n>: parent chain loops back to CUI-<m>", where CUI-<m> is the lowest-numbered issue
 * on the cycle and CUI-<n> the issue whose parent link returns to it (the same issue for a
 * self-parent). YouTrack ids only, never issue text.
 */
export function hierarchyWarnings(hierarchy: Hierarchy): readonly string[] {
  return hierarchy.cycles.map(
    ({ closer, lowest }) => `${closer.idReadable}: parent chain loops back to ${lowest.idReadable}`,
  );
}

// ---------------------------------------------------------------------------
// Index and walks

/** Lower-cases A-Z only, so no Unicode case mapping (e.g. U+212A KELVIN SIGN -> "k") can forge a match. */
function idKey(idReadable: string): string {
  return idReadable.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

function isEpic(issue: YouTrackIssue): boolean {
  return classify(issue.type).kind === "milestone";
}

/** `issues` by idKey(idReadable), keeping the first listed copy of a repeated id. */
function indexById(issues: readonly YouTrackIssue[]): ReadonlyMap<string, YouTrackIssue> {
  const byId = new Map<string, YouTrackIssue>();
  for (const issue of issues) {
    const key = idKey(issue.idReadable);
    if (!byId.has(key)) byId.set(key, issue);
  }
  return byId;
}

/** The indexed parent of `issue`, or undefined (no parent, or one outside the scan). */
function parentOf(byId: ReadonlyMap<string, YouTrackIssue>, issue: YouTrackIssue): YouTrackIssue | undefined {
  const { parentId } = issue;
  return parentId === null ? undefined : byId.get(idKey(parentId));
}

/** Every indexed issue's indexed parent, cycle links included (no entry: no parent, or one outside the scan). */
function parentLinks(byId: ReadonlyMap<string, YouTrackIssue>): ReadonlyMap<YouTrackIssue, YouTrackIssue> {
  const links = new Map<YouTrackIssue, YouTrackIssue>();
  for (const issue of byId.values()) {
    const parent = parentOf(byId, issue);
    if (parent !== undefined) links.set(issue, parent);
  }
  return links;
}

/**
 * The parent the walk from `issue` starts at: its resolved link when `issue` is the
 * indexed copy, none when its idReadable is on a cycle, otherwise its own parentId.
 */
function firstParent(
  hierarchy: Hierarchy,
  issue: YouTrackIssue,
  self: YouTrackIssue | undefined,
): YouTrackIssue | undefined {
  if (self === issue) return hierarchy.parents.get(issue);
  if (self !== undefined && hierarchy.onCycle.has(self)) return undefined;
  return parentOf(hierarchy.byId, issue);
}

/** The indexed copy of `issue`'s id (if any), and the issues a walk from `issue` must stop at: it and that copy. */
function walkStart(
  hierarchy: Hierarchy,
  issue: YouTrackIssue,
): { readonly self: YouTrackIssue | undefined; readonly seen: readonly YouTrackIssue[] } {
  const self = hierarchy.byId.get(idKey(issue.idReadable));
  return { self, seen: self === undefined ? [issue] : [issue, self] };
}

/**
 * The issues from `first` on, each followed by `step`, until `step` gives undefined or an
 * issue already seen (one of `seen`, or one found earlier). Iterative, so a long chain
 * cannot exhaust the stack.
 */
function walkUp(
  first: YouTrackIssue | undefined,
  seen: readonly YouTrackIssue[],
  step: (issue: YouTrackIssue) => YouTrackIssue | undefined,
): readonly YouTrackIssue[] {
  const visited = new Set(seen);
  const found: YouTrackIssue[] = [];
  let next = first;
  while (next !== undefined && !visited.has(next)) {
    visited.add(next);
    found.push(next);
    next = step(next);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Cycle detection (each issue has at most one parent, so cycles are disjoint)

type Cycle = CycleLink & { readonly members: readonly YouTrackIssue[] };

/** The issues one walk newly covered, and the cycle it closed (if any). */
type Walk = { readonly path: readonly YouTrackIssue[]; readonly cycle: Cycle | null };

/** Every parent cycle among the indexed issues, each found once, ascending by lowest numberInProject. */
function findCycles(
  byId: ReadonlyMap<string, YouTrackIssue>,
  links: ReadonlyMap<YouTrackIssue, YouTrackIssue>,
): readonly Cycle[] {
  const done = new Set<YouTrackIssue>();
  const cycles: Cycle[] = [];
  for (const start of byId.values()) {
    const { path, cycle } = walkUnvisited(links, start, done);
    for (const issue of path) done.add(issue);
    if (cycle !== null) cycles.push(cycle);
  }
  return cycles.sort((a, b) => a.lowest.numberInProject - b.lowest.numberInProject);
}

/**
 * Follows `links` from `start` until a missing parent, an issue an earlier walk covered
 * (in `done`), or an issue this walk already passed, which closes a new cycle.
 */
function walkUnvisited(
  links: ReadonlyMap<YouTrackIssue, YouTrackIssue>,
  start: YouTrackIssue,
  done: ReadonlySet<YouTrackIssue>,
): Walk {
  const path: YouTrackIssue[] = [];
  const position = new Map<YouTrackIssue, number>();
  let last = start;
  let current: YouTrackIssue | undefined = start;
  while (current !== undefined && !done.has(current)) {
    const seenAt = position.get(current);
    if (seenAt !== undefined) return { path, cycle: toCycle(path.slice(seenAt), current, last) };
    position.set(current, path.length);
    path.push(current);
    last = current;
    current = links.get(current);
  }
  return { path, cycle: null };
}

/**
 * The cycle of `members` in parent order (each member's parent is the next one), from
 * `entry` (the first member) to `last` (whose parent is `entry`).
 */
function toCycle(members: readonly YouTrackIssue[], entry: YouTrackIssue, last: YouTrackIssue): Cycle {
  let low = entry;
  let closer = last;
  let previous = last;
  for (const issue of members) {
    if (issue.numberInProject < low.numberInProject) {
      low = issue;
      closer = previous;
    }
    previous = issue;
  }
  return { members, closer, lowest: low };
}
