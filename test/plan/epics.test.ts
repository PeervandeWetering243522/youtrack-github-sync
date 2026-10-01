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
  under,
  ytIssue,
} from "./fixtures.ts";

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

  it("filters an epic with the exclude prefix, with or without a milestone (F1, F2)", () => {
    // The milestone's title is outdated too, and it is still left alone.
    const milestones = milestoneIndex(ghMilestone(3, "[YT-9] Old"));

    const result = plan([epic(9, { ...FILTERED, ...RESOLVED }), epic(10, FILTERED)], { milestones });

    assert.deepEqual(result.actions, []);
    assert.deepEqual(counts(result), { scanned: 2, filtered: 2, unchanged: 0, capped: 0 });
  });

  it("closes the open milestone of a resolved epic, carrying the index's ref", () => {
    const issue = epic(9, RESOLVED);
    const milestones = milestoneIndex(ghMilestone(3, "[CUI-9] Issue 9"));

    const result = plan([issue], { milestones });

    assert.deepEqual(result.actions, [
      { kind: "closeMilestone", issue, milestone: { milestoneNumber: 3, title: "[CUI-9] Issue 9", state: "open" } },
    ]);
    const [action] = result.actions;
    assert.equal(action?.kind === "closeMilestone" ? action.milestone : null, milestones.index.get(9));
  });

  it("leaves the closed milestone of a resolved epic unchanged", () => {
    const milestones = milestoneIndex(ghMilestone(3, "[CUI-9] Issue 9", "closed"));

    const result = plan([epic(9, RESOLVED)], { milestones });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 1);
  });

  it("never reopens the closed milestone of an unresolved epic (D7)", () => {
    const milestones = milestoneIndex(ghMilestone(3, "[CUI-9] Issue 9", "closed"));

    const result = plan([epic(9)], { milestones });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 1);
  });

  it("renames a milestone whose epic summary changed, and nothing more (N2, D7)", () => {
    // Before N2 this was never renamed (D7); the description still never changes.
    const issue = epic(9, { summary: "A completely new name" });
    const milestones = milestoneIndex(ghMilestone(3, "[CUI-9] Old name"));

    const result = plan([issue], { milestones });

    assert.deepEqual(result.actions, [
      { kind: "renameMilestone", issue, milestone: milestones.index.get(9), title: "[CUI-9] A completely new name" },
    ]);
    assert.equal(result.unchanged, 0);
  });

  it("uses the winning duplicate milestone to decide a close", () => {
    const milestones = milestoneIndex(ghMilestone(5, "[CUI-9] Copy"), ghMilestone(3, "[CUI-9] Issue 9", "closed"));

    const result = plan([epic(9, RESOLVED)], { milestones });

    assert.deepEqual(result.actions, []);
  });

  it("ignores an issue mirror of an epic: no close, no update, and the milestone is still created", () => {
    const issues = [epic(9), epic(10, RESOLVED)];
    const index = mirrors([9, mirror(21, { typeName: "Bug" })], [10, mirror(22, { title: "[YT-10] Old title" })]);

    const result = plan(issues, { mirrors: index });

    assert.deepEqual(describeActions(result.actions), ["createMilestone 9"]);
    assert.equal(result.unchanged, 1);
  });

  it("ignores a milestone of a non-epic: the issue gets an issue mirror and the milestone is not closed", () => {
    // Nor renamed: only an epic's milestone gets the epic's title (N2).
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
    const milestones = milestoneIndex(ghMilestone(3, "[CUI-4] Issue 4"), ghMilestone(4, "[CUI-8] Issue 8"));
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

describe("planActions: milestone titles are kept in sync (N1, N2)", () => {
  it("renames an open milestone to the epic's mirror title, carrying the index's ref", () => {
    const issue = epic(9, { summary: "New name" });
    const milestones = milestoneIndex(ghMilestone(3, "[CUI-9] Old name"));

    const result = plan([issue], { milestones });

    assert.deepEqual(result.actions, [
      {
        kind: "renameMilestone",
        issue,
        milestone: { milestoneNumber: 3, title: "[CUI-9] Old name", state: "open" },
        title: "[CUI-9] New name",
      },
    ]);
    const [action] = result.actions;
    assert.equal(action?.kind === "renameMilestone" ? action.milestone : null, milestones.index.get(9));
  });

  it("renames a closed milestone too, without reopening it (D7)", () => {
    const milestones = milestoneIndex(
      ghMilestone(3, "[CUI-9] Old", "closed"),
      ghMilestone(4, "[CUI-10] Old", "closed"),
    );

    const result = plan([epic(9), epic(10, RESOLVED)], { milestones });

    assert.deepEqual(describeActions(result.actions), ["renameMilestone 9 -> m3", "renameMilestone 10 -> m4"]);
    assert.deepEqual(
      result.actions.map((action) => (action.kind === "renameMilestone" ? action.title : null)),
      ["[CUI-9] Issue 9", "[CUI-10] Issue 10"],
    );
  });

  it("renames a legacy [YT-n] milestone to the YouTrack id (N1)", () => {
    const milestones = milestoneIndex(ghMilestone(3, "[YT-9] Issue 9"));

    const result = plan([epic(9)], { milestones });

    assert.deepEqual(describeActions(result.actions), ["renameMilestone 9 -> m3"]);
    assert.equal(result.actions[0]?.kind === "renameMilestone" ? result.actions[0].title : null, "[CUI-9] Issue 9");
  });

  it("renames, then closes, the open milestone of a resolved epic with an outdated title", () => {
    const milestones = milestoneIndex(ghMilestone(3, "[YT-9] Issue 9"));

    const result = plan([epic(9, RESOLVED)], { milestones });

    assert.deepEqual(describeActions(result.actions), ["renameMilestone 9 -> m3", "closeMilestone 9 -> m3"]);
    assert.deepEqual(counts(result), { scanned: 1, filtered: 0, unchanged: 0, capped: 0 });
  });

  it("leaves a milestone whose title is already the epic's unchanged", () => {
    const milestones = milestoneIndex(ghMilestone(3, "[CUI-9] Issue 9"), ghMilestone(4, "[CUI-10] Issue 10", "closed"));

    const result = plan([epic(9), epic(10)], { milestones });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 2);
  });

  it("compares titles exactly, so a milestone matched case-insensitively is still renamed", () => {
    const milestones = milestoneIndex(ghMilestone(3, "[cui-9] Issue 9"), ghMilestone(4, "[CUI-10] issue 10"));

    const result = plan([epic(9), epic(10)], { milestones });

    assert.deepEqual(describeActions(result.actions), ["renameMilestone 9 -> m3", "renameMilestone 10 -> m4"]);
  });

  it("does not rename the winning milestone to a title a duplicate already has, which GitHub would refuse", () => {
    const milestones = milestoneIndex(ghMilestone(3, "[YT-9] Old"), ghMilestone(4, "[CUI-9] Issue 9"));

    const result = plan([epic(9)], { milestones });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 1);
    assert.equal(milestones.warnings.length, 1, "the duplicate is still warned about");
  });

  it("treats a duplicate's title that differs only in case as taken too", () => {
    const milestones = milestoneIndex(ghMilestone(3, "[YT-9] Old"), ghMilestone(4, "[cui-9] issue 9"));

    const result = plan([epic(9)], { milestones });

    assert.deepEqual(result.actions, []);
  });

  it("skips the rename when the winner and a duplicate share the title's case-folded key, whatever the listing order", () => {
    const first = milestoneIndex(ghMilestone(3, "[cui-9] issue 9"), ghMilestone(4, "[CUI-9] Issue 9"));
    const second = milestoneIndex(ghMilestone(4, "[CUI-9] Issue 9"), ghMilestone(3, "[cui-9] issue 9"));

    assert.deepEqual(plan([epic(9)], { milestones: first }).actions, []);
    assert.deepEqual(plan([epic(9)], { milestones: second }).actions, []);
  });

  it("still closes a resolved epic's milestone when its rename is skipped", () => {
    const milestones = milestoneIndex(ghMilestone(3, "[YT-9] Old"), ghMilestone(4, "[CUI-9] Issue 9"));

    const result = plan([epic(9, RESOLVED)], { milestones });

    assert.deepEqual(describeActions(result.actions), ["closeMilestone 9 -> m3"]);
  });

  it("wants the title formatMirror gives a new milestone: trimmed summary, or the bare id", () => {
    const milestones = milestoneIndex(ghMilestone(3, "[CUI-9] Padded"), ghMilestone(4, "[CUI-10]"));

    const result = plan([epic(9, { summary: "  Padded  " }), epic(10, { summary: "" })], { milestones });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 2);
  });

  it("never renames the milestone of an excluded epic, nor of one under it (F1, F3, F2)", () => {
    const milestones = milestoneIndex(ghMilestone(3, "[YT-9] Old"), ghMilestone(4, "[CUI-10] Old"));

    const result = plan([epic(9, FILTERED), epic(10, under(9))], { milestones });

    assert.deepEqual(result.actions, []);
    assert.deepEqual(counts(result), { scanned: 2, filtered: 2, unchanged: 0, capped: 0 });
  });

  it("never renames a losing duplicate milestone", () => {
    const milestones = milestoneIndex(ghMilestone(3, "[CUI-9] Issue 9"), ghMilestone(5, "[YT-9] Old copy"));

    const result = plan([epic(9)], { milestones });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 1);
  });

  it("counts each rename against the cap, a rename and its close separately", () => {
    const milestones = milestoneIndex(
      ghMilestone(3, "[YT-1] Issue 1"),
      ghMilestone(4, "[YT-2] Issue 2"),
      ghMilestone(5, "[YT-3] Issue 3"),
    );

    const renames = plan([epic(1), epic(2), epic(3)], { milestones, maxWrites: 2 });
    const closing = plan([epic(1, RESOLVED)], { milestones, maxWrites: 1 });

    assert.deepEqual(describeActions(renames.actions), ["renameMilestone 1 -> m3", "renameMilestone 2 -> m4"]);
    assert.deepEqual(counts(renames), { scanned: 3, filtered: 0, unchanged: 0, capped: 1 });
    assert.deepEqual(describeActions(closing.actions), ["renameMilestone 1 -> m3"]);
    assert.deepEqual(counts(closing), { scanned: 1, filtered: 0, unchanged: 0, capped: 1 });
  });
});
