import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  bug,
  describeActions,
  epic,
  FILTERED,
  ghMilestone,
  milestoneIndex,
  mirror,
  mirrors,
  plan,
  RESOLVED_AT,
  resolvedIssue,
  story,
  task,
  under,
  ytIssue,
} from "./plan-fixtures.ts";

const RESOLVED = { resolved: RESOLVED_AT } as const;
/** Epic YT-1 with open milestone #3. */
const EPIC_1_MILESTONE = milestoneIndex(ghMilestone(3, "[YT-1] Epic"));
/** Story YT-1's mirror #11, already of type Feature (so it needs no update). */
const STORY_1_MIRRORED = mirrors([1, mirror(11, { typeName: "Feature" })]);

describe("planActions: create carries the GitHub type (H6, D3)", () => {
  it("gives a story Feature, a bug Bug and a task Task", () => {
    const result = plan([story(1), bug(2), task(3)]);

    assert.deepEqual(describeActions(result.actions), [
      "create 1 type=Feature",
      "create 2 type=Bug",
      "create 3 type=Task",
    ]);
  });

  it("gives an issue without a Type, or with an unmapped one, no type", () => {
    const result = plan([ytIssue(1), ytIssue(2, { type: "Feature Request" }), ytIssue(3, { type: "task" })]);

    assert.deepEqual(describeActions(result.actions), ["create 1", "create 2", "create 3"]);
  });

  it("carries the whole create shape", () => {
    const issue = task(5, under(2));
    const result = plan([epic(1), story(2, under(1)), issue], { mirrors: mirrors([2, mirror(20)]) });

    assert.deepEqual(
      result.actions.find(({ kind }) => kind === "create"),
      {
        kind: "create",
        issue,
        githubType: "Task",
        milestoneEpic: 1,
        parentYt: 2,
      },
    );
  });
});

describe("planActions: create carries the milestone of the nearest epic (H4, D1, D4)", () => {
  it("uses the milestone of the parent epic", () => {
    const result = plan([epic(1), story(2, under(1))], { milestones: EPIC_1_MILESTONE });

    assert.deepEqual(describeActions(result.actions), ["create 2 type=Feature milestone=YT-1"]);
  });

  it("inherits it through story and task levels", () => {
    const issues = [epic(1), story(2, under(1)), task(3, under(2)), task(4, under(3))];

    const result = plan(issues, { milestones: EPIC_1_MILESTONE });

    assert.deepEqual(describeActions(result.actions), [
      "create 2 type=Feature milestone=YT-1",
      "create 3 type=Task milestone=YT-1 parent=YT-2",
      "create 4 type=Task milestone=YT-1 parent=YT-3",
    ]);
  });

  it("waits for a milestone created in the same run (D4)", () => {
    const result = plan([epic(1), bug(2, under(1))]);

    assert.deepEqual(describeActions(result.actions), ["createMilestone 1", "create 2 type=Bug milestone=YT-1"]);
  });

  it("gives no milestone when the nearest epic has none and gets none (resolved, R9)", () => {
    const issues = [epic(1, RESOLVED), story(2, under(1)), epic(3, RESOLVED), story(4, under(3))];

    const result = plan(issues);

    assert.deepEqual(describeActions(result.actions), ["create 2 type=Feature", "create 4 type=Feature"]);
  });

  it("plans nothing under an excluded epic: its issues are excluded too (F3)", () => {
    const issues = [epic(3, FILTERED), story(4, under(3))];

    const result = plan(issues);

    assert.deepEqual(describeActions(result.actions), []);
    assert.equal(result.filtered, 2);
  });

  it("never searches past the nearest epic, even when a higher one has a milestone (D1)", () => {
    const issues = [epic(1), epic(2, { ...under(1), ...RESOLVED }), story(3, under(2))];

    const result = plan(issues, { milestones: EPIC_1_MILESTONE });

    assert.deepEqual(describeActions(result.actions), ["create 3 type=Feature"]);
  });

  it("uses an existing milestone of a resolved epic, even a closed one", () => {
    const milestones = milestoneIndex(ghMilestone(3, "[YT-1] Epic", "closed"), ghMilestone(4, "[YT-5] Epic"));
    const issues = [epic(1, RESOLVED), story(2, under(1)), epic(5, RESOLVED), story(6, under(5))];

    const result = plan(issues, { milestones });

    // Epic YT-5's open milestone is closed in the same run; the story still gets it.
    assert.deepEqual(describeActions(result.actions), [
      "closeMilestone 5 -> m4",
      "create 2 type=Feature milestone=YT-1",
      "create 6 type=Feature milestone=YT-5",
    ]);
  });

  it("gives no milestone to an issue whose parent is in another project (D5)", () => {
    const result = plan([epic(1), story(2, { parentId: "OTHER-1" })], { milestones: EPIC_1_MILESTONE });

    assert.deepEqual(describeActions(result.actions), ["create 2 type=Feature"]);
  });
});

describe("planActions: a task's GitHub parent (H3, H9)", () => {
  it("is the mirror of its parent story, bug, task or untyped issue", () => {
    const issues = [story(1), bug(2), task(3), ytIssue(4), task(5, under(1)), task(6, under(2))];
    const index = mirrors(
      [1, mirror(11, { typeName: "Feature" })],
      [2, mirror(12, { typeName: "Bug" })],
      [3, mirror(13, { typeName: "Task" })],
      [4, mirror(14)],
    );

    const result = plan([...issues, task(7, under(3)), task(8, under(4))], { mirrors: index });

    assert.deepEqual(describeActions(result.actions), [
      "create 5 type=Task parent=YT-1",
      "create 6 type=Task parent=YT-2",
      "create 7 type=Task parent=YT-3",
      "create 8 type=Task parent=YT-4",
    ]);
  });

  it("is a parent created earlier in the same run (D4)", () => {
    const result = plan([story(1), task(2, under(1)), task(3, under(2))]);

    assert.deepEqual(describeActions(result.actions), [
      "create 1 type=Feature",
      "create 2 type=Task parent=YT-1",
      "create 3 type=Task parent=YT-2",
    ]);
  });

  it("skips ancestors that are never mirrored (resolved without a mirror, R9)", () => {
    const issues = [story(1), task(2, { ...under(1), ...RESOLVED }), task(3, { ...under(2), ...RESOLVED })];

    const result = plan([...issues, task(4, under(3))], { mirrors: STORY_1_MIRRORED });

    assert.deepEqual(describeActions(result.actions), ["create 4 type=Task parent=YT-1"]);
    assert.equal(result.unchanged, 3);
  });

  it("counts the mirror of a resolved ancestor as mirrored, even a closed one", () => {
    const issues = [story(3, RESOLVED), task(4, under(3))];
    const index = mirrors([3, mirror(13, { state: "closed", typeName: "Feature" })]);

    const result = plan(issues, { mirrors: index });

    assert.deepEqual(describeActions(result.actions), ["create 4 type=Task parent=YT-3"]);
  });

  it("stops at the first epic: a task directly under an epic is top-level", () => {
    const issues = [story(1), epic(2, under(1)), task(3, under(2)), story(4, under(2)), task(5, under(4))];

    const result = plan(issues, { mirrors: STORY_1_MIRRORED });

    assert.deepEqual(describeActions(result.actions), [
      "createMilestone 2",
      "create 4 type=Feature milestone=YT-2",
      "create 3 type=Task milestone=YT-2",
      "create 5 type=Task milestone=YT-2 parent=YT-4",
    ]);
  });

  it("is none when no ancestor is mirrored", () => {
    const result = plan([story(1, RESOLVED), task(2, under(1)), task(3, { parentId: "CUI-99" })]);

    // YT-3's parent is not in the scan, so it has depth 0 and is created before YT-2 (depth 1).
    assert.deepEqual(describeActions(result.actions), ["create 3 type=Task", "create 2 type=Task"]);
  });

  it("is none for a parent in another project, even with a same-numbered mirror (D5)", () => {
    const result = plan([task(2, { parentId: "OTHER-1" })], { mirrors: STORY_1_MIRRORED });

    assert.deepEqual(describeActions(result.actions), ["create 2 type=Task"]);
  });

  it("finds a parent whose idReadable differs only in ASCII case", () => {
    const result = plan([story(1), task(2, { parentId: "cui-1" })], { mirrors: STORY_1_MIRRORED });

    assert.deepEqual(describeActions(result.actions), ["create 2 type=Task parent=YT-1"]);
  });

  it("is never set for stories, bugs or untyped issues, even under a mirrored parent (H9)", () => {
    const issues = [story(1), story(2, under(1)), bug(3, under(1)), ytIssue(4, under(1))];

    const result = plan(issues, { mirrors: STORY_1_MIRRORED });

    assert.deepEqual(describeActions(result.actions), ["create 2 type=Feature", "create 3 type=Bug", "create 4"]);
  });

  it("ignores a parent cycle: tasks on it are top-level and a warning names it", () => {
    const issues = [task(2, under(3)), task(3, under(2)), task(4, under(3))];

    const result = plan(issues);

    assert.deepEqual(describeActions(result.actions), [
      "create 2 type=Task",
      "create 3 type=Task",
      "create 4 type=Task parent=YT-3",
    ]);
    assert.deepEqual(result.warnings, ["YT-3: parent chain loops back to YT-2"]);
  });

  it("never creates a mirror for a resolved task, whatever its parent (R9)", () => {
    const result = plan([story(1), resolvedIssue(2, { ...under(1), type: "Task" })]);

    assert.deepEqual(describeActions(result.actions), ["create 1 type=Feature"]);
    assert.equal(result.unchanged, 1);
  });
});
