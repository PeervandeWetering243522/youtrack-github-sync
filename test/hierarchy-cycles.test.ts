/**
 * Tests for src/hierarchy.ts on broken data: parent cycles (the forest walks ignore every
 * link on a cycle, one warning per cycle), prototype-like ids, and a seeded fuzz of random
 * scans checked against an independent cycle oracle, the recursive definitions of the
 * walks and an independent walk for linkedAncestors (which follows cycle links).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  YOUTRACK_TYPES,
  ancestors,
  buildHierarchy,
  classify,
  depth,
  hierarchyWarnings,
  linkedAncestors,
  nearestEpic,
  parentChain,
} from "../src/hierarchy.ts";
import type { Hierarchy } from "../src/hierarchy.ts";
import type { YouTrackIssue } from "../src/youtrack.ts";

// ---------------------------------------------------------------------------
// Fixtures (all frozen, so any mutation by the code under test throws)
// ---------------------------------------------------------------------------

const EPIC = YOUTRACK_TYPES.epic;
const TASK = YOUTRACK_TYPES.task;
const WARNING = /^YT-\d+: parent chain loops back to YT-\d+$/;

function id(numberInProject: number): string {
  return `CUI-${String(numberInProject)}`;
}

/** A scanned issue; `parent` is a CUI number, a raw parentId string, or null. */
function yt(
  numberInProject: number,
  type: string | null,
  parent: number | string | null = null,
  overrides: Partial<YouTrackIssue> = {},
): YouTrackIssue {
  return Object.freeze({
    idReadable: id(numberInProject),
    numberInProject,
    summary: `[team] Issue ${String(numberInProject)}`,
    description: null,
    resolved: null,
    updated: 0,
    type,
    parentId: typeof parent === "number" ? id(parent) : parent,
    ...overrides,
  });
}

function build(...issues: readonly YouTrackIssue[]): Hierarchy {
  return buildHierarchy(Object.freeze([...issues]));
}

function numbers(issues: readonly YouTrackIssue[]): readonly number[] {
  return issues.map((issue) => issue.numberInProject);
}

function loopWarning(closer: number, lowest: number): string {
  return `YT-${String(closer)}: parent chain loops back to YT-${String(lowest)}`;
}

/** Asserts that `issue` behaves as a root: no ancestors at all. */
function assertRoot(hierarchy: Hierarchy, issue: YouTrackIssue): void {
  const label = issue.idReadable;
  assert.deepEqual(ancestors(hierarchy, issue), [], label);
  assert.equal(nearestEpic(hierarchy, issue), null, label);
  assert.deepEqual(parentChain(hierarchy, issue), [], label);
  assert.equal(depth(hierarchy, issue), 0, label);
}

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

describe("parent cycles", () => {
  it("ignores a self-parent link and warns once", () => {
    const task = yt(4, TASK, 4);
    const hierarchy = build(task);
    assertRoot(hierarchy, task);
    assert.deepEqual(hierarchyWarnings(hierarchy), [loopWarning(4, 4)]);
  });

  it("ignores a self-parent link on an epic, which still gives its children a milestone", () => {
    const epic = yt(4, EPIC, 4);
    const child = yt(5, TASK, 4);
    const hierarchy = build(epic, child);
    assertRoot(hierarchy, epic);
    assert.equal(nearestEpic(hierarchy, child), epic);
    assert.deepEqual(parentChain(hierarchy, child), []);
    assert.equal(depth(hierarchy, child), 1);
  });

  it("ignores both links of a two-issue cycle", () => {
    const low = yt(3, TASK, 5);
    const high = yt(5, TASK, 3);
    const hierarchy = build(low, high);
    assertRoot(hierarchy, low);
    assertRoot(hierarchy, high);
    assert.deepEqual(hierarchyWarnings(hierarchy), [loopWarning(5, 3)]);
  });

  it("names the link that closes the loop when walked from the lowest issue", () => {
    // 2 -> 9 -> 7 -> 2: YT-7's parent link closes the loop.
    const issues = [yt(7, TASK, 2), yt(2, TASK, 9), yt(9, TASK, 7)];
    const hierarchy = build(...issues);
    for (const issue of issues) assertRoot(hierarchy, issue);
    assert.deepEqual(hierarchyWarnings(hierarchy), [loopWarning(7, 2)]);
  });

  it("never gives a cycle member a parent, even an epic on the cycle", () => {
    const epic = yt(3, EPIC, 5);
    const task = yt(5, TASK, 3);
    const hierarchy = build(epic, task);
    assertRoot(hierarchy, epic);
    assertRoot(hierarchy, task);
  });

  it("keeps a tail's real parent on the cycle, but nothing beyond it", () => {
    const low = yt(3, TASK, 5);
    const high = yt(5, TASK, 3);
    const tail = yt(8, TASK, 3);
    const leaf = yt(9, TASK, 8);
    const hierarchy = build(low, high, tail, leaf);
    assert.deepEqual(parentChain(hierarchy, tail), [low]);
    assert.deepEqual(numbers(parentChain(hierarchy, leaf)), [8, 3]);
    assert.equal(depth(hierarchy, tail), 1);
    assert.equal(depth(hierarchy, leaf), 2);
    assert.deepEqual(hierarchyWarnings(hierarchy), [loopWarning(5, 3)], "tails add no warnings");
  });

  it("finds an epic on the cycle for a tail pointing at it", () => {
    const epic = yt(3, EPIC, 5);
    const task = yt(5, TASK, 3);
    const tail = yt(8, TASK, 3);
    const hierarchy = build(epic, task, tail);
    assert.equal(nearestEpic(hierarchy, tail), epic);
    assert.deepEqual(parentChain(hierarchy, tail), []);
    assert.equal(nearestEpic(hierarchy, yt(9, TASK, 5)), null, "task 5 is on the cycle, so its parent is ignored");
  });

  it("gives a tail no epic when the epic sits further along the cycle", () => {
    const entry = yt(3, TASK, 5);
    const tail = yt(8, TASK, 3);
    const hierarchy = build(entry, yt(5, EPIC, 3), tail);
    assert.equal(nearestEpic(hierarchy, tail), null);
    assert.deepEqual(parentChain(hierarchy, tail), [entry]);
  });

  it("names cycle members only, never a lower-numbered tail", () => {
    // Parents: 1 -> 7 -> 2 -> 9 -> 7. The cycle is 7, 2, 9; YT-7's link returns to YT-2.
    const tail = yt(1, TASK, 7);
    const hierarchy = build(yt(9, TASK, 7), yt(2, TASK, 9), tail, yt(7, TASK, 2));
    assert.deepEqual(hierarchyWarnings(hierarchy), [loopWarning(7, 2)]);
    assert.deepEqual(numbers(parentChain(hierarchy, tail)), [7]);
  });

  it("gives a stale copy of a cycle member no ancestors, whatever its own parentId", () => {
    const hierarchy = build(yt(1, EPIC), yt(3, TASK, 5), yt(5, TASK, 3));
    assertRoot(hierarchy, yt(3, TASK, 1));
  });

  it("handles a 3000-issue cycle without recursion limits", () => {
    const count = 3000;
    const ring = Array.from({ length: count }, (_, index) => yt(index + 1, TASK, index + 1 === count ? 1 : index + 2));
    const hierarchy = build(...ring);
    assert.deepEqual(hierarchyWarnings(hierarchy), [loopWarning(count, 1)]);
    assert.ok(ring.every((issue) => depth(hierarchy, issue) === 0));
    assert.equal(depth(hierarchy, yt(count + 1, TASK, 1)), 1);
  });

  it("reports one warning per cycle, ordered by lowest issue number, whatever the input order", () => {
    const issues = [yt(12, TASK, 10), yt(20, EPIC, 20), yt(10, TASK, 12), yt(6, TASK, 4), yt(4, TASK, 6)];
    const expected = [loopWarning(6, 4), loopWarning(12, 10), loopWarning(20, 20)];
    assert.deepEqual(hierarchyWarnings(build(...issues)), expected);
    assert.deepEqual(hierarchyWarnings(build(...[...issues].reverse())), expected);
  });

  it("detects a cycle closed through a differently cased id", () => {
    const task = yt(4, TASK, "cui-4");
    const hierarchy = build(task);
    assertRoot(hierarchy, task);
    assert.deepEqual(hierarchyWarnings(hierarchy), [loopWarning(4, 4)]);
  });

  it("returns no warnings for a forest or an empty scan", () => {
    assert.deepEqual(hierarchyWarnings(build(yt(1, EPIC), yt(2, TASK, 1), yt(3, TASK, "OTHER-3"))), []);
    assert.deepEqual(hierarchyWarnings(build()), []);
  });

  it("never puts issue text in a warning", () => {
    const secret = { summary: "[team] SECRET summary", description: "SECRET description" };
    const warnings = hierarchyWarnings(build(yt(3, TASK, 5, secret), yt(5, TASK, 3, secret)));
    assert.equal(warnings.length, 1);
    for (const warning of warnings) {
      assert.match(warning, WARNING);
      assert.doesNotMatch(warning, /SECRET/);
    }
  });

  it("ignores a later copy of a repeated idReadable, so its link forms no cycle", () => {
    const first = yt(2, TASK, 1);
    const hierarchy = build(yt(1, TASK), first, yt(2, TASK, 2));
    assert.deepEqual(hierarchyWarnings(hierarchy), []);
    assert.deepEqual(numbers(parentChain(hierarchy, first)), [1]);
  });

  it("stops when an issue outside the hierarchy walks back to its own id", () => {
    const hierarchy = build(yt(1, TASK), yt(2, TASK, 1));
    const stale = yt(1, TASK, 2);
    assert.deepEqual(numbers(parentChain(hierarchy, stale)), [2]);
    assert.equal(depth(hierarchy, stale), 1);
  });
});

// ---------------------------------------------------------------------------
// Odd ids
// ---------------------------------------------------------------------------

describe("odd ids", () => {
  it("treats prototype-like parent ids as parents outside the scan", () => {
    const hierarchy = build(yt(1, EPIC));
    for (const parent of ["__proto__", "constructor", "toString", "hasOwnProperty", "prototype"]) {
      assertRoot(hierarchy, yt(2, TASK, parent));
    }
    assert.deepEqual(hierarchyWarnings(hierarchy), []);
  });

  it("finds an issue whose idReadable looks like a prototype key", () => {
    const epic = yt(1, EPIC, null, { idReadable: "__proto__" });
    const task = yt(2, TASK, "__proto__");
    assert.equal(nearestEpic(build(epic, task), task), epic);
  });
});

// ---------------------------------------------------------------------------
// Fuzz: random scans with missing parents, foreign parents, self links and cycles
// ---------------------------------------------------------------------------

const FUZZ_SEED = 0x41e7;
const FUZZ_SCANS = 300;
const FUZZ_MAX_ISSUES = 40;
const FUZZ_TYPES: readonly (string | null)[] = [EPIC, EPIC, "User Story", "Bug", TASK, TASK, TASK, null, "Other"];

/** Deterministic PRNG (mulberry32) returning floats in [0, 1). */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 2 ** 32;
  };
}

function pick<T>(random: () => number, values: readonly T[], fallback: T): T {
  return values[Math.floor(random() * values.length)] ?? fallback;
}

/** No parent, a foreign parent, or a CUI number up to count + 3 (so some are missing). */
function fuzzParent(random: () => number, count: number): number | string | null {
  const roll = random();
  if (roll < 0.15) return null;
  if (roll < 0.22) return "OTHER-1";
  const target = 1 + Math.floor(random() * (count + 3));
  return roll < 0.27 ? id(target).toLowerCase() : target;
}

/** A shuffled copy (Fisher-Yates), so the input order never matches the numbering. */
function shuffled<T>(random: () => number, values: readonly T[]): readonly T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const current = copy[index];
    const swap = copy[other];
    if (current === undefined || swap === undefined) continue;
    copy[index] = swap;
    copy[other] = current;
  }
  return copy;
}

function fuzzScan(random: () => number): readonly YouTrackIssue[] {
  const count = 1 + Math.floor(random() * FUZZ_MAX_ISSUES);
  const issues = Array.from({ length: count }, (_, index) =>
    yt(index + 1, pick(random, FUZZ_TYPES, null), fuzzParent(random, count)),
  );
  return shuffled(random, issues);
}

/** Independent oracle: the scanned parent of `issue`, by case-insensitive id (fuzz ids are ASCII). */
function oracleParent(issues: readonly YouTrackIssue[], issue: YouTrackIssue): YouTrackIssue | undefined {
  const wanted = issue.parentId?.toLowerCase();
  return issues.find((candidate) => candidate.idReadable.toLowerCase() === wanted);
}

/** Independent oracle: `issue` is on a cycle if following parents returns to it. */
function oracleOnCycle(issues: readonly YouTrackIssue[], issue: YouTrackIssue): boolean {
  let current = oracleParent(issues, issue);
  for (let step = 0; step < issues.length && current !== undefined; step += 1) {
    if (current === issue) return true;
    current = oracleParent(issues, current);
  }
  return false;
}

/** For `start` on a cycle: true when no other member has a lower numberInProject. */
function isLowestOnCycle(issues: readonly YouTrackIssue[], start: YouTrackIssue): boolean {
  let current = oracleParent(issues, start);
  while (current !== undefined && current !== start) {
    if (current.numberInProject < start.numberInProject) return false;
    current = oracleParent(issues, current);
  }
  return true;
}

/** The warnings the oracle expects: per cycle, the member whose parent is the lowest member. */
function oracleWarnings(issues: readonly YouTrackIssue[]): readonly string[] {
  const members = issues.filter((issue) => oracleOnCycle(issues, issue));
  const lowest = members
    .filter((issue) => isLowestOnCycle(issues, issue))
    .sort((a, b) => a.numberInProject - b.numberInProject);
  return lowest.map((low) => {
    const closer = members.find((member) => oracleParent(issues, member) === low);
    return loopWarning(closer?.numberInProject ?? Number.NaN, low.numberInProject);
  });
}

/** Independent oracle for linkedAncestors: follow parents from `issue` until none, `issue` or a repeat. */
function oracleLinked(issues: readonly YouTrackIssue[], issue: YouTrackIssue): readonly YouTrackIssue[] {
  const found: YouTrackIssue[] = [];
  let current = oracleParent(issues, issue);
  while (current !== undefined && current !== issue && !found.includes(current)) {
    found.push(current);
    current = oracleParent(issues, current);
  }
  return found;
}

/** Checks the walks of `issue` against their recursive definitions (links on a cycle ignored). */
function assertWalks(issues: readonly YouTrackIssue[], hierarchy: Hierarchy, issue: YouTrackIssue): void {
  const label = `${issue.idReadable} (parent ${String(issue.parentId)})`;
  const parent = oracleOnCycle(issues, issue) ? undefined : oracleParent(issues, issue);
  if (parent === undefined) {
    assertRoot(hierarchy, issue);
    return;
  }
  const parentIsEpic = classify(parent.type).kind === "milestone";
  assert.deepEqual(ancestors(hierarchy, issue), [parent, ...ancestors(hierarchy, parent)], label);
  assert.equal(depth(hierarchy, issue), depth(hierarchy, parent) + 1, label);
  assert.equal(nearestEpic(hierarchy, issue), parentIsEpic ? parent : nearestEpic(hierarchy, parent), label);
  const expectedChain = parentIsEpic ? [] : [parent, ...parentChain(hierarchy, parent)];
  assert.deepEqual(parentChain(hierarchy, issue), expectedChain, label);
}

describe("fuzz: random scans", () => {
  it("matches the oracle and the recursive definitions on every issue", () => {
    const random = seededRandom(FUZZ_SEED);
    let cyclesSeen = 0;
    for (let scan = 0; scan < FUZZ_SCANS; scan += 1) {
      const issues = Object.freeze(fuzzScan(random));
      const hierarchy = buildHierarchy(issues);
      for (const issue of issues) {
        assertWalks(issues, hierarchy, issue);
        assert.deepEqual(linkedAncestors(hierarchy, issue), oracleLinked(issues, issue), issue.idReadable);
      }
      const warnings = hierarchyWarnings(hierarchy);
      assert.deepEqual(warnings, oracleWarnings(issues), `scan ${String(scan)}`);
      cyclesSeen += warnings.length;
    }
    assert.ok(cyclesSeen > FUZZ_SCANS / 2, `fuzz must exercise cycles (saw ${String(cyclesSeen)})`);
  });

  it("gives every task parent a smaller depth, so creates can run parent-first", () => {
    const random = seededRandom(FUZZ_SEED + 1);
    for (let scan = 0; scan < FUZZ_SCANS; scan += 1) {
      const issues = fuzzScan(random);
      const hierarchy = buildHierarchy(issues);
      for (const issue of issues) {
        const own = depth(hierarchy, issue);
        parentChain(hierarchy, issue).forEach((ancestor, index) => {
          assert.equal(depth(hierarchy, ancestor), own - index - 1);
        });
        const epic = nearestEpic(hierarchy, issue);
        if (epic !== null) assert.ok(depth(hierarchy, epic) < own);
      }
    }
  });
});
