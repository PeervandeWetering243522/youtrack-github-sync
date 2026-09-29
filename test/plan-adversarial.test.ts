import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { writeCost } from "../src/plan.ts";
import type { Action } from "../src/plan.ts";
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
  ytIssue,
} from "./plan-fixtures.ts";

// Adversarial cases: YouTrack numbers, GitHub issue numbers and milestone numbers share one
// range here on purpose, so any mix-up between them changes the plan.

const RESOLVED = { resolved: RESOLVED_AT } as const;

describe("planActions: YouTrack and GitHub numbers are never confused", () => {
  /** Story YT-1 -> #2 and story YT-2 -> #1: each mirror's number is the other story's YouTrack number. */
  const crossed = mirrors(
    [1, mirror(2, { typeName: "Feature" })],
    [2, mirror(1, { typeName: "Feature" })],
    [5, mirror(12, { typeName: "Task", parentNumber: 1 })],
    [6, mirror(13, { typeName: "Task", parentNumber: 2 })],
    [7, mirror(14, { typeName: "Task", parentNumber: 1 })],
  );

  it("reads a current parent by its GitHub number, not as a YouTrack number", () => {
    const issues = [story(1), story(2), task(5, under(1)), task(6, under(1)), task(7)];

    const result = plan(issues, { mirrors: crossed });

    // #1 is YT-2's mirror: YT-5 moves, YT-6 (under #2 = YT-1) stays, YT-7 leaves #1 (YT-2).
    assert.deepEqual(describeActions(result.actions), [
      "setParent 5 #12 under YT-1",
      "removeParent 7 #14 from #1 (YT-2)",
    ]);
    assert.deepEqual(counts(result), { scanned: 5, filtered: 0, unchanged: 3, capped: 0 });
  });

  it("reads a current milestone by its GitHub number, not as an epic number", () => {
    // Milestone #2 mirrors epic YT-1 and #1 mirrors YT-2; #6 is hand-made (epic YT-6 has none).
    const milestones = milestoneIndex(
      ghMilestone(2, "[YT-1] One"),
      ghMilestone(1, "[YT-2] Two"),
      ghMilestone(6, "Sprint 6"),
      ghMilestone(4, "[YT-3] Three"),
    );
    const issues = [epic(1), epic(2), epic(6, FILTERED), bug(7, under(1)), bug(8, under(1)), bug(9), bug(10)];
    const index = mirrors(
      [7, mirror(17, { typeName: "Bug", milestoneNumber: 1 })],
      [8, mirror(18, { typeName: "Bug", milestoneNumber: 2 })],
      [9, mirror(19, { typeName: "Bug", milestoneNumber: 6 })],
      [10, mirror(20, { typeName: "Bug", milestoneNumber: 4 })],
    );

    const result = plan(issues, { mirrors: index, milestones });

    // YT-7 sits in YT-2's milestone; YT-8 is right; #6 is hand-made (left alone);
    // #4 is YT-3's mirror milestone, which YT-10 no longer belongs to.
    assert.deepEqual(describeActions(result.actions), ["update 7 #17 milestone=YT-1", "update 10 #20 milestone=none"]);
  });

  it("keeps a milestone that is hand-made even when its number is an epic's with a milestone", () => {
    // Milestone #1 is hand-made; epic YT-1's mirror milestone is #2.
    const milestones = milestoneIndex(ghMilestone(2, "[YT-1] One"), ghMilestone(1, "Sprint 1"));

    const result = plan([epic(1), bug(5)], {
      mirrors: mirrors([5, mirror(12, { typeName: "Bug", milestoneNumber: 1 })]),
      milestones,
    });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 2);
  });

  it("carries the parent's GitHub number, not its YouTrack number, in a removeParent", () => {
    const issue = task(7);

    const result = plan([story(1), story(2), issue], { mirrors: crossed });

    const removal = result.actions.find((action) => action.kind === "removeParent");
    assert.deepEqual(removal, {
      kind: "removeParent",
      issue,
      mirror: crossed.get(7),
      parentNumber: 1,
      parentYt: 2,
    });
  });
});

describe("planActions: closed mirrors lose mirror-owned links too (D8)", () => {
  it("clears a mirror milestone and a mirror parent of a closed mirror, without reopening or closing it", () => {
    const milestones = milestoneIndex(ghMilestone(3, "[YT-1] Epic"));
    const index = mirrors(
      [2, mirror(21, { typeName: "Feature" })],
      [5, mirror(12, { state: "closed", typeName: "Task", milestoneNumber: 3, parentNumber: 21 })],
    );

    const result = plan([epic(1), story(2), task(5, RESOLVED)], { mirrors: index, milestones });

    assert.deepEqual(describeActions(result.actions), [
      "update 5 #12 milestone=none",
      "removeParent 5 #12 from #21 (YT-2)",
    ]);
  });
});

describe("planActions: update shape", () => {
  it("cannot express an update that changes nothing (checked by npm run typecheck)", () => {
    // @ts-expect-error -- an update must carry a milestone or a type change
    const empty: Action = { kind: "update", issue: task(5), mirror: mirror(12) };
    const typeOnly: Action = { kind: "update", issue: task(5), mirror: mirror(12), githubType: "Task" };

    assert.equal(writeCost(empty) + writeCost(typeOnly), 2);
  });

  it("carries a null milestoneEpic (clear) as a present key, and no type key", () => {
    const issue = bug(5);
    const ref = mirror(12, { typeName: "Bug", milestoneNumber: 3 });

    const result = plan([issue], {
      mirrors: mirrors([5, ref]),
      milestones: milestoneIndex(ghMilestone(3, "[YT-1] E")),
    });

    assert.deepEqual(result.actions, [{ kind: "update", issue, mirror: ref, milestoneEpic: null }]);
    assert.deepEqual(Object.keys(result.actions[0] ?? {}).sort(), ["issue", "kind", "milestoneEpic", "mirror"]);
  });

  it("never plans an update that changes nothing", () => {
    const milestones = milestoneIndex(ghMilestone(3, "[YT-1] E"), ghMilestone(4, "Hand-made"));
    const issues = [epic(1), story(2, under(1)), ytIssue(3), ytIssue(4, under(1)), task(5, under(2))];
    const index = mirrors(
      [2, mirror(12, { typeName: "Feature", milestoneNumber: 3 })],
      [3, mirror(13, { typeName: "Bug", milestoneNumber: 4 })],
      [4, mirror(14, { typeName: "Feature", milestoneNumber: 3 })],
      [5, mirror(15, { typeName: "Task", milestoneNumber: 3, parentNumber: 12 })],
    );

    const result = plan(issues, { mirrors: index, milestones });

    assert.deepEqual(result.actions, []);
    assert.deepEqual(counts(result), { scanned: 5, filtered: 0, unchanged: 5, capped: 0 });
  });
});

describe("planActions: dependencies under the cap (D4)", () => {
  it("caps a setParent whose parent's create is capped", () => {
    const issues = [story(3), task(5, under(3))];

    const result = plan(issues, { mirrors: mirrors([5, mirror(12, { typeName: "Task" })]), maxWrites: 1 });

    assert.deepEqual(describeActions(result.actions), ["create 3 type=Feature"]);
    assert.equal(result.capped, 1);
  });

  it("never lets an independent create jump ahead of a dependent one that is capped (A2)", () => {
    // YT-4 needs no milestone, but it comes after YT-3, which waits for YT-2's capped milestone.
    const issues = [epic(1), epic(2), story(3, under(2)), story(4)];

    const result = plan(issues, { maxWrites: 1 });

    assert.deepEqual(describeActions(result.actions), ["createMilestone 1"]);
    assert.deepEqual(counts(result), { scanned: 4, filtered: 0, unchanged: 0, capped: 3 });
  });

  it("orders a new epic, story and task chain milestone first, then parent before child", () => {
    const issues = [task(1, under(3)), task(2, under(1)), story(3, under(4)), epic(4)];

    const result = plan(issues);

    assert.deepEqual(describeActions(result.actions), [
      "createMilestone 4",
      "create 3 type=Feature milestone=YT-4",
      "create 1 type=Task milestone=YT-4 parent=YT-3",
      "create 2 type=Task milestone=YT-4 parent=YT-1",
    ]);
  });

  it("closes a resolved epic's milestone and still gives it to an unresolved child", () => {
    const milestones = milestoneIndex(ghMilestone(3, "[YT-1] Epic"));

    const result = plan([epic(1, RESOLVED), story(2, under(1))], { milestones });

    assert.deepEqual(describeActions(result.actions), [
      "closeMilestone 1 -> m3",
      "create 2 type=Feature milestone=YT-1",
    ]);
  });
});

describe("planActions: repeated and odd hierarchy rows", () => {
  it("takes an issue's parent from its first listed copy, for itself and for its children", () => {
    const issues = [task(5, under(1)), story(1), story(2), task(5, under(2)), task(6, under(5))];

    const result = plan(issues, { mirrors: mirrors([1, mirror(11, { typeName: "Feature" })]) });

    assert.deepEqual(describeActions(result.actions), [
      "create 2 type=Feature",
      "create 5 type=Task parent=YT-1",
      "create 6 type=Task parent=YT-5",
    ]);
  });

  it("takes a self-parented task out of its mirror parent and warns", () => {
    const index = mirrors(
      [1, mirror(11, { typeName: "Feature" })],
      [5, mirror(12, { typeName: "Task", parentNumber: 11 })],
    );

    const result = plan([story(1), task(5, under(5))], { mirrors: index });

    assert.deepEqual(describeActions(result.actions), ["removeParent 5 #12 from #11 (YT-1)"]);
    assert.deepEqual(result.warnings, ["YT-5: parent chain loops back to YT-5"]);
  });

  it("gives an epic nested in a mirrored epic its own milestone, and its children that one (D1)", () => {
    const milestones = milestoneIndex(ghMilestone(3, "[YT-1] Outer"));

    const result = plan([epic(1), epic(2, under(1)), story(5, under(2))], { milestones });

    assert.deepEqual(describeActions(result.actions), ["createMilestone 2", "create 5 type=Feature milestone=YT-2"]);
  });
});
