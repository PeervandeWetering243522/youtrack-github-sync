/**
 * Tests for `ancestors` and `linkedAncestors` in src/hierarchy.ts: every ancestor of any
 * Type, nearest first. `ancestors` (the forest the milestone, parent and order walks use)
 * ignores links on a cycle; `linkedAncestors`, which the inherited exclusion (F3) checks,
 * follows them once around. Chains, epics above epics, parents outside the scan, cycles and
 * stale copies. The seeded fuzz in cycles.test.ts also checks both against
 * independent definitions.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  YOUTRACK_TYPES,
  ancestors,
  buildHierarchy,
  depth,
  linkedAncestors,
  nearestEpic,
  parentChain,
} from "../../src/hierarchy.ts";
import type { Hierarchy } from "../../src/hierarchy.ts";
import type { YouTrackIssue } from "../../src/youtrack.ts";

const EPIC = YOUTRACK_TYPES.epic;
const STORY = YOUTRACK_TYPES.userStory;
const TASK = YOUTRACK_TYPES.task;

function id(numberInProject: number): string {
  return `CUI-${String(numberInProject)}`;
}

/** A frozen scanned issue; `parent` is a CUI number, a raw parentId string, or null. */
function yt(
  numberInProject: number,
  type: string | null,
  parent: number | string | null = null,
  overrides: Partial<YouTrackIssue> = {},
): YouTrackIssue {
  return Object.freeze({
    idReadable: id(numberInProject),
    numberInProject,
    summary: `Issue ${String(numberInProject)}`,
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

describe("ancestors: chains", () => {
  it("returns every ancestor nearest first, epics and stories included", () => {
    const leaf = yt(5, TASK, 4);
    const hierarchy = build(yt(1, EPIC), yt(2, EPIC, 1), yt(3, STORY, 2), yt(4, TASK, 3), leaf);

    assert.deepEqual(numbers(ancestors(hierarchy, leaf)), [4, 3, 2, 1]);
  });

  it("goes on past the first epic, where parentChain stops", () => {
    const leaf = yt(4, TASK, 3);
    const hierarchy = build(yt(1, STORY), yt(2, EPIC, 1), yt(3, TASK, 2), leaf);

    assert.deepEqual(numbers(ancestors(hierarchy, leaf)), [3, 2, 1]);
    assert.deepEqual(numbers(parentChain(hierarchy, leaf)), [3]);
  });

  it("includes resolved ancestors and ancestors of any Type value", () => {
    const leaf = yt(3, null, 2);
    const hierarchy = build(yt(1, "Other", null, { resolved: 1_758_000_000_000 }), yt(2, "task", 1), leaf);

    assert.deepEqual(numbers(ancestors(hierarchy, leaf)), [2, 1]);
  });

  it("returns the scanned issue objects, not copies", () => {
    const parent = yt(1, EPIC);
    const leaf = yt(2, TASK, 1);

    assert.equal(ancestors(build(parent, leaf), leaf)[0], parent);
  });

  it("agrees with depth and nearestEpic", () => {
    const leaf = yt(4, TASK, 3);
    const hierarchy = build(yt(1, EPIC), yt(2, STORY, 1), yt(3, TASK, 2), leaf);

    assert.equal(ancestors(hierarchy, leaf).length, depth(hierarchy, leaf));
    assert.equal(
      ancestors(hierarchy, leaf).find((issue) => issue.type === EPIC),
      nearestEpic(hierarchy, leaf),
    );
  });

  it("follows a parent id in another case (ASCII only)", () => {
    const leaf = yt(2, TASK, "cui-1");

    assert.deepEqual(numbers(ancestors(build(yt(1, EPIC), leaf), leaf)), [1]);
  });
});

describe("ancestors: where the walk ends", () => {
  it("is empty for a root and for an empty scan", () => {
    const root = yt(1, EPIC);

    assert.deepEqual(ancestors(build(root), root), []);
    assert.deepEqual(ancestors(build(), yt(2, TASK)), []);
  });

  it("ends at a parent outside the scan, such as one in another project (D5)", () => {
    const leaf = yt(3, TASK, 2);
    const hierarchy = build(yt(1, EPIC), yt(2, STORY, "OTHER-1"), leaf);

    assert.deepEqual(numbers(ancestors(hierarchy, leaf)), [2]);
    assert.deepEqual(ancestors(hierarchy, yt(4, TASK, 99)), [], "CUI-99 was not scanned");
  });

  it("starts from the parentId of an issue that is not in the hierarchy", () => {
    const hierarchy = build(yt(1, EPIC), yt(2, STORY, 1));

    assert.deepEqual(numbers(ancestors(hierarchy, yt(7, TASK, 2))), [2, 1]);
  });
});

describe("ancestors: cycles", () => {
  it("is empty for a self-parent and for every member of a longer cycle", () => {
    const self = yt(4, TASK, 4);
    const ring = [yt(7, TASK, 2), yt(2, TASK, 9), yt(9, EPIC, 7)];
    const hierarchy = build(self, ...ring);

    assert.deepEqual(ancestors(hierarchy, self), []);
    for (const issue of ring) assert.deepEqual(ancestors(hierarchy, issue), [], issue.idReadable);
  });

  it("gives a tail pointing into a cycle only its own parent on the cycle", () => {
    const tail = yt(8, TASK, 3);
    const leaf = yt(9, TASK, 8);
    const hierarchy = build(yt(3, EPIC, 5), yt(5, TASK, 3), tail, leaf);

    assert.deepEqual(numbers(ancestors(hierarchy, tail)), [3]);
    assert.deepEqual(numbers(ancestors(hierarchy, leaf)), [8, 3]);
  });

  it("gives a stale copy of a cycle member no ancestors, whatever its own parentId", () => {
    const hierarchy = build(yt(1, EPIC), yt(3, TASK, 5), yt(5, TASK, 3));

    assert.deepEqual(ancestors(hierarchy, yt(3, TASK, 1)), []);
  });

  it("stops when an issue outside the hierarchy walks back to its own id", () => {
    const hierarchy = build(yt(1, TASK), yt(2, TASK, 1));

    assert.deepEqual(numbers(ancestors(hierarchy, yt(1, TASK, 2))), [2]);
  });

  it("walks a 3000-issue chain without recursion limits", () => {
    const count = 3000;
    const chain = Array.from({ length: count }, (_, index) => yt(index + 1, TASK, index === 0 ? null : index));
    const leaf = chain.at(-1) ?? yt(0, TASK);

    const found = ancestors(build(...chain), leaf);

    assert.equal(found.length, count - 1);
    assert.equal(found.at(-1)?.numberInProject, 1);
  });
});

describe("linkedAncestors: the walk the exclude filter uses (F3)", () => {
  it("equals ancestors wherever there is no cycle", () => {
    const issues = [
      yt(1, EPIC),
      yt(2, EPIC, 1),
      yt(3, STORY, 2),
      yt(4, TASK, 3),
      yt(5, TASK, 4),
      yt(6, TASK, "OTHER-1"),
    ];
    const hierarchy = build(...issues);

    for (const issue of issues) {
      assert.deepEqual(linkedAncestors(hierarchy, issue), ancestors(hierarchy, issue), issue.idReadable);
    }
    assert.deepEqual(numbers(linkedAncestors(hierarchy, yt(7, TASK, 3))), [3, 2, 1], "an issue outside the scan");
  });

  it("gives each member of a cycle the other members, in parent order, and a self-parent none", () => {
    const self = yt(4, TASK, 4);
    const seven = yt(7, TASK, 2);
    const two = yt(2, TASK, 9);
    const nine = yt(9, EPIC, 7);
    const hierarchy = build(self, seven, two, nine);

    assert.deepEqual(linkedAncestors(hierarchy, self), []);
    assert.deepEqual(numbers(linkedAncestors(hierarchy, seven)), [2, 9]);
    assert.deepEqual(numbers(linkedAncestors(hierarchy, two)), [9, 7]);
    assert.deepEqual(numbers(linkedAncestors(hierarchy, nine)), [7, 2]);
    assert.deepEqual(ancestors(hierarchy, seven), [], "ancestors ignores the cycle");
  });

  it("gives a tail pointing into a cycle every member of that cycle, once", () => {
    const tail = yt(8, TASK, 3);
    const leaf = yt(9, TASK, 8);
    const hierarchy = build(yt(3, EPIC, 5), yt(5, TASK, 3), tail, leaf);

    assert.deepEqual(numbers(linkedAncestors(hierarchy, tail)), [3, 5]);
    assert.deepEqual(numbers(linkedAncestors(hierarchy, leaf)), [8, 3, 5]);
    assert.deepEqual(numbers(ancestors(hierarchy, leaf)), [8, 3], "ancestors stops at the cycle");
  });

  it("walks a stale copy's own parentId and stops at its indexed copy", () => {
    const hierarchy = build(yt(1, EPIC), yt(2, TASK, 1), yt(3, TASK, 5), yt(5, TASK, 3));

    assert.deepEqual(numbers(linkedAncestors(hierarchy, yt(3, TASK, 2))), [2, 1]);
    assert.deepEqual(numbers(linkedAncestors(hierarchy, yt(1, TASK, 2))), [2]);
  });

  it("ends at a parent outside the scan (D5)", () => {
    const leaf = yt(3, TASK, 2);
    const hierarchy = build(yt(1, EPIC), yt(2, STORY, "OTHER-1"), leaf);

    assert.deepEqual(numbers(linkedAncestors(hierarchy, leaf)), [2]);
    assert.deepEqual(linkedAncestors(hierarchy, yt(4, TASK, 99)), [], "CUI-99 was not scanned");
  });

  it("goes once around a 3000-issue cycle without recursion limits", () => {
    const count = 3000;
    const ring = Array.from({ length: count }, (_, index) => yt(index + 1, TASK, index + 1 === count ? 1 : index + 2));
    const first = ring[0] ?? yt(0, TASK);

    const found = linkedAncestors(build(...ring), first);

    assert.equal(found.length, count - 1);
    assert.equal(found.at(-1)?.numberInProject, count);
  });
});
