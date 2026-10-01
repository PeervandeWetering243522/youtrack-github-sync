/**
 * The exclude filter (decisions F1-F3): isExcluded on its own, and what planActions does
 * with issues excluded by their own prefix or by an ancestor's (inherited, F3).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildHierarchy } from "../../src/hierarchy.ts";
import { isExcluded } from "../../src/plan/exclude.ts";
import type { YouTrackIssue } from "../../src/youtrack.ts";
import {
  bug,
  counts,
  describeActions,
  epic,
  EXCLUDE_PREFIX,
  FILTERED,
  ghMilestone,
  milestoneIndex,
  mirror,
  mirrors,
  plan,
  RESOLVED_AT,
  story,
  task,
  under,
  ytIssue,
} from "./fixtures.ts";

const RESOLVED = { resolved: RESOLVED_AT } as const;
/** The live example: epic CUI-32 with the prefix and its two tasks, which have none. */
const INDIVIDUAL_EPIC = [
  epic(32, { summary: "[Individual] Data Structures and Algorithms" }),
  task(46, { ...under(32), summary: "Implement a linked list" }),
  task(47, { ...under(32), summary: "Big-O exercises" }),
];

/** isExcluded for each of `issues`, over the hierarchy of all of them, as [number, excluded]. */
function excludedOf(issues: readonly YouTrackIssue[], prefix = EXCLUDE_PREFIX): readonly [number, boolean][] {
  const hierarchy = buildHierarchy(Object.freeze([...issues]));
  return issues.map((issue) => [issue.numberInProject, isExcluded(hierarchy, issue, prefix)]);
}

describe("isExcluded (F1, F3)", () => {
  it("excludes an issue by its own prefix, in any case and after leading whitespace", () => {
    const summaries = ["[individual] x", "[INDIVIDUAL] x", "  [Individual]x", "\t[individual]"];
    const issues = summaries.map((summary, index) => ytIssue(index + 1, { summary }));

    assert.deepEqual(excludedOf(issues), [
      [1, true],
      [2, true],
      [3, true],
      [4, true],
    ]);
  });

  it("excludes every descendant of an issue with the prefix, of any Type and at any depth", () => {
    const issues = [...INDIVIDUAL_EPIC, story(50, under(32)), task(51, under(50)), bug(52, under(51))];

    assert.ok(excludedOf(issues).every(([, excluded]) => excluded));
  });

  it("excludes nothing above or beside an excluded issue", () => {
    const issues = [epic(1), story(2, under(1)), story(3, { ...under(1), ...FILTERED }), task(4, under(2))];

    assert.deepEqual(excludedOf(issues), [
      [1, false],
      [2, false],
      [3, true],
      [4, false],
    ]);
  });

  it("matches the prefix on an ancestor in any case and after leading whitespace", () => {
    for (const summary of ["[INDIVIDUAL] Epic", "   [Individual] Epic", "\t[individual]Epic"]) {
      assert.deepEqual(excludedOf([epic(1, { summary }), story(2, under(1)), task(3, under(2))]), [
        [1, true],
        [2, true],
        [3, true],
      ]);
    }
  });

  it("inherits from a resolved ancestor too", () => {
    assert.deepEqual(excludedOf([epic(1, { ...FILTERED, ...RESOLVED }), task(2, under(1))]), [
      [1, true],
      [2, true],
    ]);
  });

  it("uses the configured prefix for ancestors as well", () => {
    const issues = [epic(1, { summary: "[SOLO] Mine" }), task(2, under(1)), epic(3, FILTERED), task(4, under(3))];

    assert.deepEqual(excludedOf(issues, "[Solo]"), [
      [1, true],
      [2, true],
      [3, false],
      [4, false],
    ]);
  });

  it("ignores summaries that only resemble the prefix, such as the typo [invididual]", () => {
    const issues = [epic(33, { summary: "[invididual] Data Structures & Algorithms" }), task(34, under(33))];

    assert.deepEqual(excludedOf(issues), [
      [33, false],
      [34, false],
    ]);
  });

  it("cannot see past a parent outside the scan (D5)", () => {
    assert.deepEqual(excludedOf([task(2, { parentId: "OTHER-1" })]), [[2, false]]);
  });

  it("follows parent links around a cycle, so every member and every tail below it inherits", () => {
    // YT-2's parent is the prefixed YT-1, and YT-7's walk goes 5 -> 6 (prefixed) around the cycle.
    const issues = [
      story(1, { ...under(2), ...FILTERED }),
      story(2, under(1)),
      task(3, under(1)),
      story(5, under(6)),
      story(6, { ...under(5), ...FILTERED }),
      task(7, under(5)),
    ];

    assert.ok(excludedOf(issues).every(([, excluded]) => excluded));
  });

  it("excludes nothing on or below a cycle without the prefix, nor a self-parent", () => {
    const issues = [story(1, under(2)), story(2, under(1)), task(3, under(1)), task(4, under(4))];

    assert.ok(excludedOf(issues).every(([, excluded]) => !excluded));
  });
});

describe("planActions: inherited exclusion (F3)", () => {
  it("filters an excluded epic and the tasks under it, creating nothing (CUI-32, CUI-46, CUI-47)", () => {
    const result = plan(INDIVIDUAL_EPIC);

    assert.deepEqual(result.actions, []);
    assert.deepEqual(counts(result), { scanned: 3, filtered: 3, unchanged: 0, capped: 0 });
  });

  it("filters grandchildren of an excluded epic, of any Type", () => {
    const issues = [epic(1, FILTERED), story(2, under(1)), task(3, under(2)), bug(4, under(2)), ytIssue(5, under(3))];

    const result = plan(issues);

    assert.deepEqual(result.actions, []);
    assert.deepEqual(counts(result), { scanned: 5, filtered: 5, unchanged: 0, capped: 0 });
  });

  it("still mirrors a sibling tree under an epic without the prefix", () => {
    const issues = [epic(1, FILTERED), story(2, under(1)), epic(3), story(4, under(3)), task(5, under(4))];

    const result = plan(issues);

    assert.deepEqual(describeActions(result.actions), [
      "createMilestone 3",
      "create 4 type=Feature milestone=YT-3",
      "create 5 type=Task milestone=YT-3 parent=YT-4",
    ]);
    assert.deepEqual(counts(result), { scanned: 5, filtered: 2, unchanged: 0, capped: 0 });
  });

  it("filters a task without the prefix under an excluded story, and counts it as filtered", () => {
    const issues = [epic(1), story(2, { ...under(1), ...FILTERED }), task(3, under(2))];

    const result = plan(issues, { milestones: milestoneIndex(ghMilestone(3, "[CUI-1] Issue 1")) });

    assert.deepEqual(result.actions, []);
    assert.deepEqual(counts(result), { scanned: 3, filtered: 2, unchanged: 1, capped: 0 });
  });

  it("never syncs the existing mirror of an excluded parent, nor its children's (F2)", () => {
    // Both would need an update (no type), the task a setParent too.
    const issues = [story(2, FILTERED), task(3, under(2))];
    const index = mirrors([2, mirror(12)], [3, mirror(13)]);

    const result = plan(issues, { mirrors: index });

    assert.deepEqual(result.actions, []);
    assert.deepEqual(counts(result), { scanned: 2, filtered: 2, unchanged: 0, capped: 0 });
  });

  it("never closes the milestone or mirrors of an excluded tree once it is resolved (F2)", () => {
    // The milestone's legacy title is outdated too, and is not renamed either.
    const issues = [epic(1, { ...FILTERED, ...RESOLVED }), story(2, { ...under(1), ...RESOLVED }), task(3, under(2))];
    const index = mirrors([2, mirror(12)], [3, mirror(13, { typeName: "Task" })]);

    const result = plan(issues, { mirrors: index, milestones: milestoneIndex(ghMilestone(3, "[YT-1] Epic")) });

    assert.deepEqual(result.actions, []);
    assert.deepEqual(counts(result), { scanned: 3, filtered: 3, unchanged: 0, capped: 0 });
  });

  it("does not inherit through a parent outside the scan (D5)", () => {
    const result = plan([task(2, { parentId: "OTHER-1" })]);

    assert.deepEqual(describeActions(result.actions), ["create 2 type=Task"]);
    assert.equal(result.filtered, 0);
  });

  it("inherits around a parent cycle and into a tail below it, still warning about the cycle", () => {
    // YT-3 and YT-4 are each other's parent, only YT-3 has the prefix; YT-5 hangs below YT-4.
    const excludedCycle = [story(3, { ...under(4), ...FILTERED }), story(4, under(3)), task(5, under(4))];
    const plainCycle = [story(6, under(7)), story(7, under(6))];

    const result = plan([...excludedCycle, ...plainCycle]);

    assert.deepEqual(describeActions(result.actions), ["create 6 type=Feature", "create 7 type=Feature"]);
    assert.deepEqual(counts(result), { scanned: 5, filtered: 3, unchanged: 0, capped: 0 });
    assert.deepEqual(result.warnings, [
      "CUI-4: parent chain loops back to CUI-3",
      "CUI-7: parent chain loops back to CUI-6",
    ]);
  });

  it("counts inherited exclusions outside the cap, never as capped", () => {
    const issues = [epic(1, FILTERED), task(2, under(1)), ytIssue(3), ytIssue(4)];

    const result = plan(issues, { maxWrites: 1 });

    assert.deepEqual(describeActions(result.actions), ["create 3"]);
    assert.deepEqual(counts(result), { scanned: 4, filtered: 2, unchanged: 0, capped: 1 });
  });

  it("never picks an excluded issue as parent or milestone, even for a repeated idReadable", () => {
    // Inconsistent input the YouTrack read rejects (R4): YT-6 and YT-9 reuse CUI-5's id, so
    // their walks stop before CUI-5. Task YT-7 and epic YT-8 sit under the excluded CUI-5,
    // so they are excluded (F3) and their mirror and milestone must not be used.
    const issues = [
      epic(5, FILTERED),
      task(6, { idReadable: "CUI-5", parentId: "CUI-7" }),
      task(7, under(5)),
      epic(8, under(5)),
      task(9, { idReadable: "CUI-5", parentId: "CUI-8" }),
    ];
    const options = { mirrors: mirrors([7, mirror(17)]), milestones: milestoneIndex(ghMilestone(4, "[YT-8] Epic")) };

    const result = plan(issues, options);

    assert.deepEqual(describeActions(result.actions), ["create 6 type=Task", "create 9 type=Task"]);
    assert.deepEqual(counts(result), { scanned: 5, filtered: 3, unchanged: 0, capped: 0 });
  });
});

describe("planActions: mirrors that sit under an excluded issue's mirror or milestone", () => {
  it("detaches a mirror from an excluded parent's mirror when YouTrack has it elsewhere", () => {
    // Task YT-3 moved in YouTrack from the excluded story YT-2 to the top level.
    const issues = [story(2, FILTERED), task(3)];
    const index = mirrors([2, mirror(12)], [3, mirror(13, { typeName: "Task", parentNumber: 12 })]);

    const result = plan(issues, { mirrors: index });

    assert.deepEqual(describeActions(result.actions), ["removeParent 3 #13 from #12 (YT-2)"]);
  });

  it("clears an excluded epic's milestone from a mirror whose issue left that epic", () => {
    const issues = [epic(1, FILTERED), task(3)];
    const index = mirrors([3, mirror(13, { typeName: "Task", milestoneNumber: 3 })]);

    const result = plan(issues, { mirrors: index, milestones: milestoneIndex(ghMilestone(3, "[YT-1] Epic")) });

    assert.deepEqual(describeActions(result.actions), ["update 3 #13 milestone=none"]);
  });
});
