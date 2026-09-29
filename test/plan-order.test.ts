import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { writeCost } from "../src/plan.ts";
import {
  bug,
  counts,
  describeActions,
  epic,
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
} from "./plan-fixtures.ts";

const RESOLVED = { resolved: RESOLVED_AT } as const;

/** One of everything, listed out of order. */
const ISSUES = Object.freeze([
  task(1, under(2)),
  task(2, under(10)),
  epic(3, RESOLVED),
  bug(4),
  bug(5, RESOLVED),
  story(6),
  task(7, under(20)),
  task(8, under(10)),
  story(9),
  story(10, under(20)),
  epic(20),
]);
const MIRRORS = mirrors(
  [5, mirror(15, { typeName: "Bug" })],
  [6, mirror(16)],
  [8, mirror(18, { typeName: "Task" })],
  [9, mirror(19, { typeName: "Feature", parentNumber: 16 })],
);
const MILESTONES = milestoneIndex(ghMilestone(5, "[YT-3] Epic three"));

const FULL_ORDER = [
  // 1. milestones, by epic number
  "closeMilestone 3 -> m5",
  "createMilestone 20",
  // 2. non-task creates by number, then task creates by depth, then number
  "create 4 type=Bug",
  "create 10 type=Feature milestone=YT-20",
  "create 7 type=Task milestone=YT-20",
  "create 2 type=Task milestone=YT-20 parent=YT-10",
  "create 1 type=Task milestone=YT-20 parent=YT-2",
  // 3. sync by number; an issue's update comes before its parent change
  "update 6 #16 type=Feature",
  "update 8 #18 milestone=YT-20",
  "setParent 8 #18 under YT-10",
  "removeParent 9 #19 from #16 (YT-6)",
  // 4. closes by number
  "close 5 -> #15",
];

describe("planActions: execution order (docs/11 §1.4)", () => {
  it("orders milestones, then creates (tasks by depth), then sync, then closes", () => {
    const result = plan(ISSUES, { mirrors: MIRRORS, milestones: MILESTONES });

    assert.deepEqual(describeActions(result.actions), FULL_ORDER);
    assert.deepEqual(counts(result), { scanned: 11, filtered: 0, unchanged: 0, capped: 0 });
  });

  it("gives the same order whatever the input order", () => {
    const result = plan([...ISSUES].reverse(), { mirrors: MIRRORS, milestones: MILESTONES });

    assert.deepEqual(describeActions(result.actions), FULL_ORDER);
  });

  it("creates a parent task before its child, even when the child has the lower number (D4)", () => {
    const result = plan([task(1, under(2)), task(2, under(3)), task(3)]);

    assert.deepEqual(describeActions(result.actions), [
      "create 3 type=Task",
      "create 2 type=Task parent=YT-3",
      "create 1 type=Task parent=YT-2",
    ]);
  });

  it("counts epics and unmirrored ancestors in the depth, and breaks depth ties by number", () => {
    const issues = [epic(1), task(9, under(1)), task(4, under(1)), task(3, under(4)), task(2)];

    const result = plan(issues, { milestones: milestoneIndex(ghMilestone(1, "[YT-1] Epic")) });

    assert.deepEqual(describeActions(result.actions), [
      "create 2 type=Task",
      "create 4 type=Task milestone=YT-1",
      "create 9 type=Task milestone=YT-1",
      "create 3 type=Task milestone=YT-1 parent=YT-4",
    ]);
  });

  it("puts every story, bug and untyped create before any task create", () => {
    const result = plan([task(1), story(2), task(3), bug(4)]);

    assert.deepEqual(describeActions(result.actions), [
      "create 2 type=Feature",
      "create 4 type=Bug",
      "create 1 type=Task",
      "create 3 type=Task",
    ]);
  });
});

describe("planActions: cap and dependencies (A2, D4)", () => {
  it("plans the longest prefix of the execution order that fits, for every cap", () => {
    for (let maxWrites = 0; maxWrites <= FULL_ORDER.length + 1; maxWrites += 1) {
      const result = plan(ISSUES, { mirrors: MIRRORS, milestones: MILESTONES, maxWrites });

      const taken = Math.min(maxWrites, FULL_ORDER.length);
      const label = `maxWrites=${String(maxWrites)}`;
      assert.deepEqual(describeActions(result.actions), FULL_ORDER.slice(0, taken), label);
      assert.equal(
        result.actions.reduce((total, action) => total + writeCost(action), 0),
        taken,
        label,
      );
      assert.equal(result.capped, FULL_ORDER.length - taken, label);
      assert.equal(result.unchanged, 0, label);
    }
  });

  it("caps a child whose parent create is capped, instead of creating it top-level (D4)", () => {
    const result = plan([task(1, under(5)), story(5)], { maxWrites: 1 });

    assert.deepEqual(describeActions(result.actions), ["create 5 type=Feature"]);
    assert.equal(result.capped, 1);
  });

  it("caps a milestone update whose milestone create is capped (D4)", () => {
    const issues = [epic(1), epic(2), bug(3, under(2))];

    const result = plan(issues, { mirrors: mirrors([3, mirror(13, { typeName: "Bug" })]), maxWrites: 1 });

    assert.deepEqual(describeActions(result.actions), ["createMilestone 1"]);
    assert.equal(result.capped, 2);
  });

  it("counts capped actions, while an issue with several actions is still one scanned issue", () => {
    const issues = [story(1), task(5, { ...under(1), ...RESOLVED })];
    const index = mirrors([1, mirror(11, { typeName: "Feature" })], [5, mirror(12)]);

    const result = plan(issues, { mirrors: index, maxWrites: 1 });

    assert.deepEqual(describeActions(result.actions), ["update 5 #12 type=Task"]);
    assert.deepEqual(counts(result), { scanned: 2, filtered: 0, unchanged: 1, capped: 2 });
  });

  it("never counts filtered or unchanged issues as capped", () => {
    const issues = [epic(1, FILTERED), story(2, FILTERED), bug(3, RESOLVED), story(4)];

    const result = plan(issues, { mirrors: mirrors([4, mirror(14, { typeName: "Feature" })]), maxWrites: 0 });

    assert.deepEqual(result.actions, []);
    assert.deepEqual(counts(result), { scanned: 4, filtered: 2, unchanged: 2, capped: 0 });
  });
});

describe("planActions: warnings", () => {
  it("passes on the milestone index warnings, then one per parent cycle", () => {
    const milestones = milestoneIndex(ghMilestone(5, "[YT-3] Epic"), ghMilestone(6, "[YT-3] Copy"));
    const issues = [task(31, under(30)), task(30, under(31)), epic(3), task(8, under(8))];

    const result = plan(issues, { milestones });

    assert.deepEqual(result.warnings, [
      "YT-3: 2 GitHub milestones match; using milestone #5, ignoring milestone #6",
      "YT-8: parent chain loops back to YT-8",
      "YT-31: parent chain loops back to YT-30",
    ]);
  });

  it("walks filtered and resolved issues too, so their cycles are reported", () => {
    const issues = [story(1, { ...under(2), ...FILTERED }), story(2, { ...under(1), ...RESOLVED })];

    const result = plan(issues);

    assert.deepEqual(result.warnings, ["YT-2: parent chain loops back to YT-1"]);
    assert.equal(result.filtered, 1);
  });
});

describe("planActions: hierarchy inputs stay untouched", () => {
  it("leaves frozen issues and locked indexes as they were, and returns the input objects", () => {
    const before = structuredClone(ISSUES);
    const milestonesBefore = structuredClone([...MILESTONES.index.entries(), ...MILESTONES.byNumber.entries()]);

    const result = plan(ISSUES, { mirrors: MIRRORS, milestones: MILESTONES });

    assert.deepEqual(ISSUES, before);
    assert.deepEqual([...MILESTONES.index.entries(), ...MILESTONES.byNumber.entries()], milestonesBefore);
    assert.ok(result.actions.every((action) => ISSUES.includes(action.issue)));
    const close = result.actions.find((action) => action.kind === "closeMilestone");
    assert.equal(close?.kind === "closeMilestone" ? close.milestone : null, MILESTONES.index.get(3));
  });
});
