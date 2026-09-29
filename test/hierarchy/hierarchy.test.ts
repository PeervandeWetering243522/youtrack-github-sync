/**
 * Tests for src/hierarchy.ts on well-formed scans: classify (docs/11 §1.1, D3) and the
 * parent walks nearestEpic (H4, D1), parentChain (H3, H9) and depth, including parents
 * outside the scan (D5). Cycles, odd ids and fuzzing: test/hierarchy/cycles.test.ts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { YOUTRACK_TYPES, buildHierarchy, classify, depth, nearestEpic, parentChain } from "../../src/hierarchy.ts";
import type { Hierarchy } from "../../src/hierarchy.ts";
import type { YouTrackIssue } from "../../src/youtrack.ts";

// ---------------------------------------------------------------------------
// Fixtures (all frozen, so any mutation by the code under test throws)
// ---------------------------------------------------------------------------

const EPIC = YOUTRACK_TYPES.epic;
const STORY = YOUTRACK_TYPES.userStory;
const BUG = YOUTRACK_TYPES.bug;
const TASK = YOUTRACK_TYPES.task;

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

// ---------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------

describe("classify", () => {
  it("names the YouTrack Type values exactly", () => {
    assert.deepEqual(YOUTRACK_TYPES, { epic: "Epic", userStory: "User Story", bug: "Bug", task: "Task" });
  });

  it("maps Epic to a milestone without a GitHub type", () => {
    assert.deepEqual(classify("Epic"), { kind: "milestone", githubType: null });
  });

  it("maps User Story to an issue of type Feature", () => {
    assert.deepEqual(classify("User Story"), { kind: "issue", githubType: "Feature" });
  });

  it("maps Bug to an issue of type Bug", () => {
    assert.deepEqual(classify("Bug"), { kind: "issue", githubType: "Bug" });
  });

  it("maps Task to a task of type Task", () => {
    assert.deepEqual(classify("Task"), { kind: "task", githubType: "Task" });
  });

  it("maps a missing Type (null) to an issue without a GitHub type (D3)", () => {
    assert.deepEqual(classify(null), { kind: "issue", githubType: null });
  });

  it("maps every other value to an issue without a GitHub type, matching case-sensitively (D3)", () => {
    const others = [
      ...["", " ", "epic", "EPIC", "Epic ", " Epic", "Epics", "Epic​", "Еpic"],
      ...["user story", "User story", "UserStory", "User  Story", "User Story", "Story", "Feature"],
      ...["bug", "BUG", "Bug\n", "task", "TASK", "Tasks", "Subtask", "Sub-task", "Milestone", "Issue"],
    ];
    for (const value of others) {
      assert.deepEqual(classify(value), { kind: "issue", githubType: null }, JSON.stringify(value));
    }
  });
});

// ---------------------------------------------------------------------------
// nearestEpic
// ---------------------------------------------------------------------------

describe("nearestEpic", () => {
  it("returns null for an issue without a parent", () => {
    const task = yt(1, TASK);
    assert.equal(nearestEpic(build(task), task), null);
  });

  it("returns a direct epic parent (the scanned object)", () => {
    const epic = yt(1, EPIC);
    const task = yt(2, TASK, 1);
    assert.equal(nearestEpic(build(epic, task), task), epic);
  });

  it("returns the epic above a task -> task -> story chain, from every level", () => {
    const epic = yt(1, EPIC);
    const story = yt(2, STORY, 1);
    const task = yt(3, TASK, 2);
    const subtask = yt(4, TASK, 3);
    const hierarchy = build(subtask, task, story, epic);
    for (const issue of [story, task, subtask]) assert.equal(nearestEpic(hierarchy, issue), epic);
    assert.equal(nearestEpic(hierarchy, epic), null);
  });

  it("returns the nearest epic only when epics are nested (D1)", () => {
    const outer = yt(1, EPIC);
    const inner = yt(2, EPIC, 1);
    const task = yt(3, TASK, 2);
    const hierarchy = build(outer, inner, task);
    assert.equal(nearestEpic(hierarchy, task), inner);
    assert.equal(nearestEpic(hierarchy, inner), outer);
    assert.equal(nearestEpic(hierarchy, outer), null);
  });

  it("walks through bugs, stories and unknown types", () => {
    const epic = yt(1, EPIC);
    const bug = yt(2, BUG, 1);
    const unknown = yt(3, "Feature", 2);
    const untyped = yt(4, null, 3);
    const task = yt(5, TASK, 4);
    assert.equal(nearestEpic(build(epic, bug, unknown, untyped, task), task), epic);
  });

  it("returns null when no ancestor is an epic", () => {
    const story = yt(1, STORY);
    const task = yt(2, TASK, 1);
    assert.equal(nearestEpic(build(story, task), task), null);
  });

  it("does not treat a lower-case 'epic' Type as an epic", () => {
    const fake = yt(1, "epic");
    const task = yt(2, TASK, 1);
    assert.equal(nearestEpic(build(fake, task), task), null);
  });

  it("returns null when the parent is in another project (D5)", () => {
    const epic = yt(9, EPIC);
    const direct = yt(1, TASK, "OTHER-9");
    const story = yt(2, STORY, "ABC-9");
    const task = yt(3, TASK, 2);
    const hierarchy = build(epic, direct, story, task);
    assert.equal(nearestEpic(hierarchy, direct), null);
    assert.equal(nearestEpic(hierarchy, task), null);
  });

  it("ends the walk at a parent missing from the scan, even with an epic above it", () => {
    const epic = yt(1, EPIC);
    const orphan = yt(3, TASK, 2);
    assert.equal(nearestEpic(build(epic, orphan), orphan), null);
  });

  it("treats an empty parentId as a parent outside the scan", () => {
    const task = yt(2, TASK, "");
    const hierarchy = build(yt(1, EPIC), task);
    assert.equal(nearestEpic(hierarchy, task), null);
    assert.deepEqual(parentChain(hierarchy, task), []);
    assert.equal(depth(hierarchy, task), 0);
  });

  it("uses filtered and resolved ancestors too (docs/11 §1.2)", () => {
    const epic = yt(1, EPIC, null, { summary: "[individual] Excluded epic", resolved: 1_758_000_000_000 });
    const task = yt(2, TASK, 1);
    assert.equal(nearestEpic(build(epic, task), task), epic);
  });

  it("stops at a filtered or resolved inner epic, never searching the epic above it (D1)", () => {
    const outer = yt(1, EPIC);
    const inner = yt(2, EPIC, 1, { summary: "[individual] Excluded epic", resolved: 1_758_000_000_000 });
    const story = yt(3, STORY, 2);
    const task = yt(4, TASK, 3);
    const hierarchy = build(outer, inner, story, task);
    assert.equal(nearestEpic(hierarchy, task), inner);
    assert.deepEqual(parentChain(hierarchy, task), [story]);
  });

  it("matches a parent id case-insensitively (ASCII only)", () => {
    const epic = yt(1, EPIC);
    const lower = yt(2, TASK, "cui-1");
    const mixed = yt(3, TASK, "Cui-1");
    const hierarchy = build(epic, lower, mixed);
    assert.equal(nearestEpic(hierarchy, lower), epic);
    assert.equal(nearestEpic(hierarchy, mixed), epic);
  });

  it("does not match a parent id through Unicode case mapping", () => {
    // U+212A KELVIN SIGN lower-cases to ASCII "k" under String#toLowerCase.
    const epic = yt(1, EPIC, null, { idReadable: "KI-1" });
    const kelvin = yt(2, TASK, "KI-1");
    const dotless = yt(3, TASK, "kı-1");
    const hierarchy = build(epic, kelvin, dotless);
    assert.equal(nearestEpic(hierarchy, kelvin), null);
    assert.equal(nearestEpic(hierarchy, dotless), null);
  });

  it("walks from an issue that is not in the hierarchy", () => {
    const epic = yt(1, EPIC);
    assert.equal(nearestEpic(build(epic), yt(7, TASK, 1)), epic);
    assert.equal(nearestEpic(build(), yt(7, TASK, 1)), null);
  });

  it("follows the given issue's own parentId, not the indexed copy's", () => {
    const epic = yt(1, EPIC);
    const hierarchy = build(epic, yt(2, STORY, 1), yt(3, TASK, 2));
    const moved = yt(3, TASK, 1);
    assert.equal(nearestEpic(hierarchy, moved), epic);
    assert.deepEqual(parentChain(hierarchy, moved), []);
    assert.equal(depth(hierarchy, moved), 1);
  });
});

// ---------------------------------------------------------------------------
// parentChain
// ---------------------------------------------------------------------------

describe("parentChain", () => {
  it("is empty for an issue without a parent", () => {
    const task = yt(1, TASK);
    assert.deepEqual(parentChain(build(task), task), []);
  });

  it("is empty when the parent is an epic", () => {
    const epic = yt(1, EPIC);
    const task = yt(2, TASK, 1);
    assert.deepEqual(parentChain(build(epic, task), task), []);
  });

  it("lists non-epic ancestors nearest first and stops before the first epic", () => {
    const hierarchy = build(yt(1, EPIC), yt(2, STORY, 1), yt(3, TASK, 2), yt(4, TASK, 3));
    assert.deepEqual(numbers(parentChain(hierarchy, yt(4, TASK, 3))), [3, 2]);
    assert.deepEqual(numbers(parentChain(hierarchy, yt(3, TASK, 2))), [2]);
    assert.deepEqual(numbers(parentChain(hierarchy, yt(2, STORY, 1))), []);
  });

  it("returns the scanned objects", () => {
    const story = yt(1, STORY);
    const task = yt(2, TASK, 1);
    const [first] = parentChain(build(story, task), yt(3, TASK, 2));
    assert.equal(first, task);
  });

  it("stops before the first epic even with non-epic ancestors above it", () => {
    const hierarchy = build(yt(1, STORY), yt(2, EPIC, 1), yt(3, STORY, 2), yt(4, TASK, 3));
    assert.deepEqual(numbers(parentChain(hierarchy, yt(4, TASK, 3))), [3]);
    assert.deepEqual(numbers(parentChain(hierarchy, yt(5, TASK, 2))), []);
  });

  it("includes stories, bugs, tasks and unknown types (the planner picks, H9)", () => {
    const hierarchy = build(yt(1, null), yt(2, BUG, 1), yt(3, STORY, 2), yt(4, TASK, 3), yt(5, "Other", 4));
    assert.deepEqual(numbers(parentChain(hierarchy, yt(6, TASK, 5))), [5, 4, 3, 2, 1]);
  });

  it("stops at a parent outside the scan (D5)", () => {
    const story = yt(1, STORY, "OTHER-3");
    const hierarchy = build(story, yt(2, TASK, 1));
    assert.deepEqual(numbers(parentChain(hierarchy, yt(2, TASK, 1))), [1]);
    assert.deepEqual(numbers(parentChain(hierarchy, yt(3, TASK, 99))), []);
    assert.deepEqual(numbers(parentChain(hierarchy, yt(4, TASK, "OTHER-1"))), []);
  });

  it("works for any kind of issue, not only tasks", () => {
    const hierarchy = build(yt(1, STORY), yt(2, STORY, 1), yt(3, BUG, 2));
    assert.deepEqual(numbers(parentChain(hierarchy, yt(3, BUG, 2))), [2, 1]);
  });
});

// ---------------------------------------------------------------------------
// depth
// ---------------------------------------------------------------------------

describe("depth", () => {
  it("is 0 for a root and for an issue whose parent is outside the scan", () => {
    const hierarchy = build(yt(1, TASK), yt(2, TASK, "OTHER-1"), yt(3, TASK, 42));
    assert.equal(depth(hierarchy, yt(1, TASK)), 0);
    assert.equal(depth(hierarchy, yt(2, TASK, "OTHER-1")), 0);
    assert.equal(depth(hierarchy, yt(3, TASK, 42)), 0);
  });

  it("counts every ancestor, epics included, up to a parent outside the scan", () => {
    const issues = [yt(1, EPIC, "OTHER-1"), yt(2, EPIC, 1), yt(3, STORY, 2), yt(4, TASK, 3)];
    const hierarchy = build(...issues);
    assert.deepEqual(
      issues.map((issue) => depth(hierarchy, issue)),
      [0, 1, 2, 3],
    );
  });

  it("sorts every parent before its children", () => {
    const issues = [yt(5, TASK, 4), yt(3, STORY, 1), yt(4, TASK, 3), yt(1, EPIC), yt(2, TASK, 4)];
    const hierarchy = build(...issues);
    const ordered = [...issues].sort((a, b) => depth(hierarchy, a) - depth(hierarchy, b));
    assert.deepEqual(numbers(ordered), [1, 3, 4, 5, 2]);
  });

  it("resolves parent ids once at build time, not again on every walk (Workers CPU budget)", () => {
    let reads = 0;
    const chain = Array.from({ length: 50 }, (_, index) => {
      const parentId = index === 0 ? null : id(index);
      const counted = Object.defineProperty({ ...yt(index + 1, TASK) }, "parentId", {
        enumerable: true,
        get: () => {
          reads += 1;
          return parentId;
        },
      });
      return Object.freeze(counted);
    });
    const hierarchy = build(...chain);
    const readsAtBuild = reads;
    for (const issue of chain) {
      depth(hierarchy, issue);
      parentChain(hierarchy, issue);
      nearestEpic(hierarchy, issue);
    }
    assert.ok(readsAtBuild <= chain.length, String(readsAtBuild));
    assert.equal(reads, readsAtBuild);
    const last = chain.at(-1);
    assert.ok(last);
    assert.equal(depth(hierarchy, last), 49);
  });

  it("handles a 3000-deep chain without recursion limits", () => {
    const chain = Array.from({ length: 3000 }, (_, index) => (index === 0 ? yt(1, EPIC) : yt(index + 1, TASK, index)));
    const hierarchy = build(...chain);
    const deepest = yt(3000, TASK, 2999);
    assert.equal(depth(hierarchy, deepest), 2999);
    assert.equal(parentChain(hierarchy, deepest).length, 2998);
    assert.equal(nearestEpic(hierarchy, deepest)?.numberInProject, 1);
  });
});

// ---------------------------------------------------------------------------
// buildHierarchy
// ---------------------------------------------------------------------------

describe("buildHierarchy", () => {
  it("keeps the first listed issue for a repeated idReadable", () => {
    const epic = yt(1, EPIC);
    const first = yt(2, TASK, 1);
    const later = yt(2, TASK, null);
    const hierarchy = build(epic, first, later);
    assert.equal(nearestEpic(hierarchy, yt(3, TASK, 2)), epic);
    assert.deepEqual(parentChain(hierarchy, yt(3, TASK, 2)), [first]);
  });

  it("treats idReadables that differ only in ASCII case as one issue (first wins)", () => {
    const epic = yt(1, EPIC);
    const first = yt(2, TASK, 1, { idReadable: "cui-2" });
    const later = yt(2, TASK, null);
    const [found] = parentChain(build(epic, first, later), yt(3, TASK, 2));
    assert.equal(found, first);
  });

  it("treats one object listed twice as one issue", () => {
    const epic = yt(1, EPIC);
    const task = yt(2, TASK, 1);
    const hierarchy = build(epic, task, task, epic);
    assert.equal(depth(hierarchy, task), 1);
    assert.equal(nearestEpic(hierarchy, task), epic);
  });

  it("does not mutate its input", () => {
    const issues = [yt(1, EPIC), yt(2, TASK, 1), yt(3, TASK, 3), yt(4, TASK, 5), yt(5, TASK, 4)];
    const snapshot = structuredClone(issues);
    const hierarchy = build(...issues);
    for (const issue of issues) {
      nearestEpic(hierarchy, issue);
      parentChain(hierarchy, issue);
      depth(hierarchy, issue);
    }
    assert.deepEqual(issues, snapshot);
  });
});
