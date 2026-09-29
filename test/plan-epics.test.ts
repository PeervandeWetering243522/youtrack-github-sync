import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
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
  ytIssue,
} from "./plan-fixtures.ts";

const RESOLVED = { resolved: RESOLVED_AT } as const;

describe("planActions: epics become milestones (H1, H2, R9)", () => {
  it("creates a milestone for an eligible unresolved epic without one", () => {
    const issue = epic(9);

    const result = plan([issue]);

    assert.deepEqual(result.actions, [{ kind: "createMilestone", issue }]);
    assert.deepEqual(counts(result), { scanned: 1, filtered: 0, unchanged: 0, capped: 0 });
  });

  it("never creates a milestone for an already-resolved epic, and counts it as unchanged (R9)", () => {
    const result = plan([epic(9, RESOLVED)]);

    assert.deepEqual(result.actions, []);
    assert.deepEqual(counts(result), { scanned: 1, filtered: 0, unchanged: 1, capped: 0 });
  });

  it("filters an epic without the title prefix, with or without a milestone (H2, R2)", () => {
    const milestones = milestoneIndex(ghMilestone(3, "[YT-9] Old"));

    const result = plan([epic(9, { ...FILTERED, ...RESOLVED }), epic(10, FILTERED)], { milestones });

    assert.deepEqual(result.actions, []);
    assert.deepEqual(counts(result), { scanned: 2, filtered: 2, unchanged: 0, capped: 0 });
  });

  it("closes the open milestone of a resolved epic, carrying the index's ref", () => {
    const issue = epic(9, RESOLVED);
    const milestones = milestoneIndex(ghMilestone(3, "[YT-9] Epic"));

    const result = plan([issue], { milestones });

    assert.deepEqual(result.actions, [
      { kind: "closeMilestone", issue, milestone: { milestoneNumber: 3, state: "open" } },
    ]);
    const [action] = result.actions;
    assert.equal(action?.kind === "closeMilestone" ? action.milestone : null, milestones.index.get(9));
  });

  it("leaves the closed milestone of a resolved epic unchanged", () => {
    const milestones = milestoneIndex(ghMilestone(3, "[YT-9] Epic", "closed"));

    const result = plan([epic(9, RESOLVED)], { milestones });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 1);
  });

  it("never reopens the closed milestone of an unresolved epic (D7)", () => {
    const milestones = milestoneIndex(ghMilestone(3, "[YT-9] Epic", "closed"));

    const result = plan([epic(9)], { milestones });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 1);
  });

  it("never renames a milestone whose epic summary changed (D7)", () => {
    const milestones = milestoneIndex(ghMilestone(3, "[YT-9] Old name"));

    const result = plan([epic(9, { summary: "[team] A completely new name" })], { milestones });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 1);
  });

  it("uses the winning duplicate milestone to decide a close", () => {
    const milestones = milestoneIndex(ghMilestone(5, "[YT-9] Copy"), ghMilestone(3, "[YT-9] First", "closed"));

    const result = plan([epic(9, RESOLVED)], { milestones });

    assert.deepEqual(result.actions, []);
  });

  it("ignores an issue mirror of an epic: no close, no update, and the milestone is still created", () => {
    const issues = [epic(9), epic(10, RESOLVED)];
    const index = mirrors([9, mirror(21, { typeName: "Bug" })], [10, mirror(22)]);

    const result = plan(issues, { mirrors: index });

    assert.deepEqual(describeActions(result.actions), ["createMilestone 9"]);
    assert.equal(result.unchanged, 1);
  });

  it("ignores a milestone of a non-epic: the issue gets an issue mirror and the milestone is not closed", () => {
    const milestones = milestoneIndex(ghMilestone(3, "[YT-9] Was an epic"), ghMilestone(4, "[YT-10] Was an epic"));

    const result = plan([story(9), story(10, RESOLVED)], { milestones });

    assert.deepEqual(describeActions(result.actions), ["create 9 type=Feature"]);
    assert.equal(result.unchanged, 1);
  });

  it("matches the Epic type exactly: another spelling is an issue without a type (D3)", () => {
    const result = plan([ytIssue(9, { type: "epic" }), ytIssue(10, { type: "Epic " })]);

    assert.deepEqual(describeActions(result.actions), ["create 9", "create 10"]);
  });

  it("orders milestone creates and closes together by epic number", () => {
    const milestones = milestoneIndex(ghMilestone(3, "[YT-4] Epic"), ghMilestone(4, "[YT-8] Epic"));
    const issues = [epic(8, RESOLVED), epic(6), epic(4, RESOLVED), epic(2)];

    const result = plan(issues, { milestones });

    assert.deepEqual(describeActions(result.actions), [
      "createMilestone 2",
      "closeMilestone 4 -> m3",
      "createMilestone 6",
      "closeMilestone 8 -> m4",
    ]);
  });

  it("counts each milestone write against the cap", () => {
    const result = plan([epic(1), epic(2), epic(3)], { maxWrites: 2 });

    assert.deepEqual(describeActions(result.actions), ["createMilestone 1", "createMilestone 2"]);
    assert.deepEqual(counts(result), { scanned: 3, filtered: 0, unchanged: 0, capped: 1 });
  });
});
