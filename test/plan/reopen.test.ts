import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { writeCost } from "../../src/plan.ts";
import { buildMirrorIndex } from "../../src/plan/mirrors.ts";
import {
  ACTIONS_BOT,
  assertCountsAddUp,
  bug,
  closedMirror,
  counts,
  describeActions,
  desiredTitle,
  epic,
  FILTERED,
  ghIssue,
  ghMilestone,
  LABEL,
  lockedMap,
  milestoneIndex,
  mirror,
  mirrors,
  plan,
  PROJECT,
  resolvedIssue,
  story,
  task,
  under,
  unlabelled,
  ytIssue,
} from "./fixtures.ts";

const REOPEN = { reopenClosedBy: ACTIONS_BOT } as const;

describe("planActions: reopening own closes (R10)", () => {
  it("reopens a closed mirror of an unresolved issue that REOPEN_CLOSED_BY closed", () => {
    const issue = ytIssue(5);
    const index = mirrors([5, closedMirror(12, ACTIONS_BOT)]);

    const result = plan([issue], { ...REOPEN, mirrors: index });

    assert.deepEqual(result.actions, [{ kind: "reopen", issue, mirror: index.get(5) }]);
    assert.deepEqual(counts(result), { scanned: 1, filtered: 0, unchanged: 0, capped: 0 });
    assert.deepEqual(result.warnings, []);
  });

  it("reopens the mirror of every non-epic kind: user story, bug, task and untyped", () => {
    const issues = [story(1), bug(2), task(3), ytIssue(4)];
    const index = mirrors(
      [1, closedMirror(11, ACTIONS_BOT, { typeName: "Feature" })],
      [2, closedMirror(12, ACTIONS_BOT, { typeName: "Bug" })],
      [3, closedMirror(13, ACTIONS_BOT, { typeName: "Task" })],
      [4, closedMirror(14, ACTIONS_BOT)],
    );

    const result = plan(issues, { ...REOPEN, mirrors: index });

    assert.deepEqual(describeActions(result.actions), [
      "reopen 1 -> #11",
      "reopen 2 -> #12",
      "reopen 3 -> #13",
      "reopen 4 -> #14",
    ]);
    assertCountsAddUp(result);
  });

  it("compares the logins ASCII-case-insensitively, as GitHub does", () => {
    const issues = [ytIssue(1), ytIssue(2), ytIssue(3)];
    const index = mirrors(
      [1, closedMirror(11, "GitHub-Actions[bot]")],
      [2, closedMirror(12, "GITHUB-ACTIONS[BOT]")],
      [3, closedMirror(13, "github-actions[bot]")],
    );

    const lower = plan(issues, { mirrors: index, reopenClosedBy: "github-actions[bot]" });
    const upper = plan(issues, { mirrors: index, reopenClosedBy: "GITHUB-actions[bot]" });

    const all = ["reopen 1 -> #11", "reopen 2 -> #12", "reopen 3 -> #13"];
    assert.deepEqual(describeActions(lower.actions), all);
    assert.deepEqual(describeActions(upper.actions), all);
  });

  it("does not fold non-ASCII look-alikes, spaces or extra characters into a match", () => {
    const closers = [
      "github-actions",
      "github-actions[bot] ",
      " github-actions[bot]",
      "github-actions[bot]2",
      "xgithub-actions[bot]",
      // U+0131 (dotless i) upper-cases to "I", so a toUpperCase comparison would match it.
      "gıthub-actions[bot]",
      // U+FF47: fullwidth "g".
      "ｇithub-actions[bot]",
    ];
    const issues = closers.map((_, offset) => ytIssue(offset + 1));
    const index = mirrors(...closers.map((closer, offset) => [offset + 1, closedMirror(offset + 11, closer)] as const));

    const result = plan(issues, { ...REOPEN, mirrors: index });
    // U+212A (Kelvin sign) lower-cases to "k", so a toLowerCase comparison would match it.
    const kelvin = plan([ytIssue(1)], { mirrors: mirrors([1, closedMirror(11, "Kbot")]), reopenClosedBy: "kbot" });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, closers.length);
    assert.deepEqual(kelvin.actions, []);
  });

  it("leaves a mirror that another login closed, or that has no reported closer, closed", () => {
    const issues = [ytIssue(5), ytIssue(6), ytIssue(7)];
    const index = mirrors(
      [5, closedMirror(12, "a-person")],
      [6, closedMirror(13, null)],
      [7, closedMirror(14, "renovate[bot]")],
    );

    const result = plan(issues, { ...REOPEN, mirrors: index });

    assert.deepEqual(result.actions, []);
    assert.deepEqual(counts(result), { scanned: 3, filtered: 0, unchanged: 3, capped: 0 });
  });

  it("never reopens while REOPEN_CLOSED_BY is unset, whoever closed the mirror", () => {
    const index = mirrors([5, closedMirror(12, ACTIONS_BOT)], [6, closedMirror(13, "a-person")]);

    const unset = plan([ytIssue(5), ytIssue(6)], { mirrors: index });
    const explicitNull = plan([ytIssue(5), ytIssue(6)], { mirrors: index, reopenClosedBy: null });

    assert.deepEqual(unset.actions, []);
    assert.deepEqual(explicitNull.actions, []);
    assert.equal(unset.unchanged, 2);
  });

  it("never reopens an open mirror, whatever its closedBy says (an earlier close and reopen)", () => {
    const index = mirrors([5, mirror(12, { closedBy: ACTIONS_BOT })]);

    const result = plan([ytIssue(5)], { ...REOPEN, mirrors: index });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 1);
  });

  it("never reopens the closed mirror of a resolved issue", () => {
    const index = mirrors([5, closedMirror(12, ACTIONS_BOT)]);

    const result = plan([resolvedIssue(5)], { ...REOPEN, mirrors: index });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 1);
  });

  it("still closes, and does not reopen, the open mirror of a resolved issue", () => {
    const index = mirrors([5, mirror(12, { closedBy: ACTIONS_BOT })]);

    const result = plan([resolvedIssue(5)], { ...REOPEN, mirrors: index });

    assert.deepEqual(describeActions(result.actions), ["close 5 -> #12"]);
  });

  it("never reopens the mirror of an excluded issue or of an issue below one (F2, F3)", () => {
    const issues = [ytIssue(5, FILTERED), story(6, FILTERED), task(7, under(6)), epic(8, FILTERED), task(9, under(8))];
    const index = mirrors(
      [5, closedMirror(15, ACTIONS_BOT)],
      [7, closedMirror(17, ACTIONS_BOT)],
      [9, closedMirror(19, ACTIONS_BOT)],
    );

    const result = plan(issues, { ...REOPEN, mirrors: index });

    assert.deepEqual(result.actions, []);
    assert.deepEqual(counts(result), { scanned: 5, filtered: 5, unchanged: 0, capped: 0 });
  });

  it("reopens a title-only (unlabelled) mirror by the same rule as a labelled one", () => {
    const githubIssues = Object.freeze([
      unlabelled(12, desiredTitle(5), { state: "closed", closedBy: ACTIONS_BOT }),
      unlabelled(13, desiredTitle(6), { state: "closed", closedBy: "a-person" }),
      ghIssue(14, desiredTitle(7), { state: "closed", closedBy: ACTIONS_BOT }),
    ]);
    const { index, warnings } = buildMirrorIndex(githubIssues, LABEL, PROJECT);

    const result = plan([ytIssue(5), ytIssue(6), ytIssue(7)], { ...REOPEN, mirrors: lockedMap(index) });

    assert.equal(warnings.length, 2);
    assert.deepEqual(describeActions(result.actions), ["reopen 5 -> #12", "reopen 7 -> #14"]);
    assert.equal(result.unchanged, 1);
  });

  it("syncs title, type and parent first, then reopens, when both are due", () => {
    const issues = [story(1), ytIssue(5, { summary: "Renamed" }), task(7, under(1))];
    const index = mirrors(
      [1, mirror(11, { typeName: "Feature" })],
      [5, closedMirror(12, ACTIONS_BOT, { title: "[CUI-5] Old" })],
      [7, closedMirror(17, ACTIONS_BOT)],
    );

    const result = plan(issues, { ...REOPEN, mirrors: index });

    assert.deepEqual(describeActions(result.actions), [
      "update 5 #12 title",
      "update 7 #17 type=Task",
      "setParent 7 #17 under YT-1",
      "reopen 5 -> #12",
      "reopen 7 -> #17",
    ]);
    const update = result.actions[0];
    assert.equal(update?.kind === "update" ? update.title : null, "[CUI-5] Renamed");
  });

  it("sorts reopens with the closes, by YouTrack number, after every sync write", () => {
    const issues = [
      ytIssue(6, { summary: "Renamed" }),
      resolvedIssue(4),
      ytIssue(3),
      ytIssue(5, { summary: "Renamed" }),
      epic(2),
      ytIssue(1),
    ];
    const index = mirrors(
      [3, closedMirror(13, ACTIONS_BOT)],
      [4, mirror(14)],
      [5, mirror(15, { title: "[CUI-5] Old" })],
      [6, closedMirror(16, ACTIONS_BOT, { title: "[CUI-6] Old" })],
    );

    const result = plan(issues, { ...REOPEN, mirrors: index });

    assert.deepEqual(describeActions(result.actions), [
      "createMilestone 2",
      "create 1",
      "update 5 #15 title",
      "update 6 #16 title",
      "reopen 3 -> #13",
      "close 4 -> #14",
      "reopen 6 -> #16",
    ]);
  });

  it("costs one write", () => {
    const index = mirrors([5, closedMirror(12, ACTIONS_BOT)]);

    const [action] = plan([ytIssue(5)], { ...REOPEN, mirrors: index }).actions;

    assert.ok(action?.kind === "reopen", "expected one reopen");
    assert.equal(writeCost(action), 1);
  });

  it("is capped like any other write, and nothing after the cap jumps ahead", () => {
    const issues = [ytIssue(1), resolvedIssue(2), ytIssue(3)];
    const index = mirrors([1, closedMirror(11, ACTIONS_BOT)], [2, mirror(12)], [3, closedMirror(13, ACTIONS_BOT)]);

    const two = plan(issues, { ...REOPEN, mirrors: index, maxWrites: 2 });
    const none = plan(issues, { ...REOPEN, mirrors: index, maxWrites: 0 });

    assert.deepEqual(describeActions(two.actions), ["reopen 1 -> #11", "close 2 -> #12"]);
    assert.equal(two.capped, 1);
    assertCountsAddUp(two);
    assert.deepEqual(none.actions, []);
    assert.equal(none.capped, 3);
    assertCountsAddUp(none);
  });

  it("is capped behind the sync writes that come before it", () => {
    const index = mirrors([5, closedMirror(12, ACTIONS_BOT, { title: "[CUI-5] Old" })]);

    const result = plan([ytIssue(5)], { ...REOPEN, mirrors: index, maxWrites: 1 });

    assert.deepEqual(describeActions(result.actions), ["update 5 #12 title"]);
    assert.equal(result.capped, 1);
  });
});

describe("planActions: milestones are never reopened (R10, D7)", () => {
  it("leaves the closed milestone of an unresolved epic closed, even with REOPEN_CLOSED_BY set", () => {
    const milestones = milestoneIndex(ghMilestone(7, desiredTitle(3), "closed"));

    const result = plan([epic(3)], { ...REOPEN, milestones });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 1);
  });

  it("only renames the closed milestone of an unresolved epic whose summary changed", () => {
    const milestones = milestoneIndex(ghMilestone(7, "[CUI-3] Old", "closed"));

    const result = plan([epic(3)], { ...REOPEN, milestones });

    assert.deepEqual(describeActions(result.actions), ["renameMilestone 3 -> m7"]);
  });

  it("never reopens an epic's old issue mirror either; epics are only milestones", () => {
    const milestones = milestoneIndex(ghMilestone(7, desiredTitle(3)));
    const index = mirrors([3, closedMirror(12, ACTIONS_BOT)]);

    const result = plan([epic(3)], { ...REOPEN, mirrors: index, milestones });

    assert.deepEqual(result.actions, []);
  });

  it("still reopens a task mirror inside an epic's closed milestone, leaving the milestone alone", () => {
    const milestones = milestoneIndex(ghMilestone(7, desiredTitle(3), "closed"));
    const index = mirrors([5, closedMirror(12, ACTIONS_BOT, { typeName: "Task", milestoneNumber: 7 })]);

    const result = plan([epic(3), task(5, under(3))], { ...REOPEN, mirrors: index, milestones });

    assert.deepEqual(describeActions(result.actions), ["reopen 5 -> #12"]);
  });
});
