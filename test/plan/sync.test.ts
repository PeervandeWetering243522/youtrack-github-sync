import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatMirror } from "../../src/mirror.ts";
import { writeCost } from "../../src/plan.ts";
import { buildMirrorIndex } from "../../src/plan/mirrors.ts";
import {
  bug,
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
  RESOLVED_AT,
  story,
  task,
  titled,
  under,
  unlabelled,
  ytIssue,
} from "./fixtures.ts";

const RESOLVED = { resolved: RESOLVED_AT } as const;
/** Epic YT-1 -> milestone #3, epic YT-2 -> milestone #4, both titled as desired; #7 is a hand-made milestone. */
const MILESTONES = milestoneIndex(
  ghMilestone(3, "[CUI-1] Issue 1"),
  ghMilestone(4, "[CUI-2] Issue 2"),
  ghMilestone(7, "Sprint 7"),
);

describe("planActions: milestone sync (H4, H5, D2)", () => {
  it("sets the nearest epic's milestone on a mirror without one", () => {
    const issue = bug(5, under(1));
    const ref = titled(5, mirror(12, { typeName: "Bug" }));

    const result = plan([epic(1), issue], { mirrors: mirrors([5, ref]), milestones: MILESTONES });

    assert.deepEqual(result.actions, [{ kind: "update", issue, mirror: ref, milestoneEpic: 1 }]);
    assert.deepEqual(counts(result), { scanned: 2, filtered: 0, unchanged: 1, capped: 0 });
  });

  it("leaves a mirror already in the desired milestone unchanged", () => {
    const ref = mirror(12, { typeName: "Bug", milestoneNumber: 3 });

    const result = plan([epic(1), bug(5, under(1))], { mirrors: mirrors([5, ref]), milestones: MILESTONES });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 2);
  });

  it("moves a mirror from another epic's milestone to the desired one", () => {
    const ref = mirror(12, { milestoneNumber: 4 });

    const result = plan([epic(1), epic(2), ytIssue(5, under(1))], {
      mirrors: mirrors([5, ref]),
      milestones: MILESTONES,
    });

    assert.deepEqual(describeActions(result.actions), ["update 5 #12 milestone=YT-1"]);
  });

  it("replaces a hand-made milestone when YouTrack wants a mirrored one (D2)", () => {
    const ref = mirror(12, { milestoneNumber: 7 });

    const result = plan([epic(1), ytIssue(5, under(1))], { mirrors: mirrors([5, ref]), milestones: MILESTONES });

    assert.deepEqual(describeActions(result.actions), ["update 5 #12 milestone=YT-1"]);
  });

  it("sets a milestone that is created in the same run, after its create (D4)", () => {
    const ref = mirror(12, { milestoneNumber: 7 });

    const result = plan([epic(9), ytIssue(5, under(9))], { mirrors: mirrors([5, ref]), milestones: MILESTONES });

    assert.deepEqual(describeActions(result.actions), ["createMilestone 9", "update 5 #12 milestone=YT-9"]);
  });

  it("clears a mirrored milestone when the issue no longer has an epic with one", () => {
    const issues = [epic(1), ytIssue(5), ytIssue(6, { parentId: "OTHER-1" }), epic(8, RESOLVED), ytIssue(9, under(8))];
    const index = mirrors(
      [5, mirror(12, { milestoneNumber: 3 })],
      [6, mirror(13, { milestoneNumber: 4 })],
      [9, mirror(14, { milestoneNumber: 3 })],
    );

    const result = plan(issues, { mirrors: index, milestones: MILESTONES });

    assert.deepEqual(describeActions(result.actions), [
      "update 5 #12 milestone=none",
      "update 6 #13 milestone=none",
      "update 9 #14 milestone=none",
    ]);
  });

  it("clears a milestone from a higher epic: only the nearest epic counts (D1)", () => {
    // Epic YT-6 was resolved before it got a milestone (R9), so it never gets one.
    const issues = [epic(1), epic(6, { ...under(1), ...RESOLVED }), ytIssue(5, under(6))];

    const result = plan(issues, { mirrors: mirrors([5, mirror(12, { milestoneNumber: 3 })]), milestones: MILESTONES });

    assert.deepEqual(describeActions(result.actions), ["update 5 #12 milestone=none"]);
  });

  it("leaves a hand-made milestone alone when no mirrored one is wanted (D2)", () => {
    const result = plan([ytIssue(5)], {
      mirrors: mirrors([5, mirror(12, { milestoneNumber: 7 })]),
      milestones: MILESTONES,
    });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 1);
  });

  it("treats a losing duplicate milestone like a hand-made one", () => {
    const milestones = milestoneIndex(ghMilestone(3, "[CUI-1] Issue 1"), ghMilestone(5, "[CUI-1] Copy"));

    const kept = plan([ytIssue(5)], { mirrors: mirrors([5, mirror(12, { milestoneNumber: 5 })]), milestones });
    const moved = plan([epic(1), ytIssue(5, under(1))], {
      mirrors: mirrors([5, mirror(12, { milestoneNumber: 5 })]),
      milestones,
    });

    assert.deepEqual(kept.actions, []);
    assert.deepEqual(describeActions(moved.actions), ["update 5 #12 milestone=YT-1"]);
  });

  it("clears the milestone of a mirror whose epic's milestone now belongs to a non-epic", () => {
    const issues = [story(1), ytIssue(5, under(1))];
    const index = mirrors([1, mirror(11, { typeName: "Feature" })], [5, mirror(12, { milestoneNumber: 3 })]);

    const result = plan(issues, { mirrors: index, milestones: MILESTONES });

    assert.deepEqual(describeActions(result.actions), ["update 5 #12 milestone=none"]);
  });
});

describe("planActions: type sync (H6, D3)", () => {
  it("sets the type of a mirror without one", () => {
    const result = plan([story(1), bug(2), task(3)], {
      mirrors: mirrors([1, mirror(11)], [2, mirror(12)], [3, mirror(13)]),
    });

    assert.deepEqual(describeActions(result.actions), [
      "update 1 #11 type=Feature",
      "update 2 #12 type=Bug",
      "update 3 #13 type=Task",
    ]);
  });

  it("changes a type that differs, compared exactly", () => {
    const index = mirrors([1, mirror(11, { typeName: "Task" })], [2, mirror(12, { typeName: "task" })]);

    const result = plan([story(1), task(2)], { mirrors: index });

    assert.deepEqual(describeActions(result.actions), ["update 1 #11 type=Feature", "update 2 #12 type=Task"]);
  });

  it("leaves a matching type unchanged", () => {
    const result = plan([bug(2)], { mirrors: mirrors([2, mirror(12, { typeName: "Bug" })]) });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 1);
  });

  it("never clears or changes a type when the desired type is none (D3)", () => {
    const issues = [ytIssue(1), ytIssue(2, { type: "Feature Request" })];
    const index = mirrors([1, mirror(11, { typeName: "Bug" })], [2, mirror(12, { typeName: "Epic" })]);

    const result = plan(issues, { mirrors: index });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 2);
  });

  it("carries a milestone and a type change in one update", () => {
    const issue = task(5, under(1));
    const ref = titled(5, mirror(12, { typeName: "Bug", milestoneNumber: 7 }));

    const result = plan([epic(1), issue], { mirrors: mirrors([5, ref]), milestones: MILESTONES });

    assert.deepEqual(result.actions, [{ kind: "update", issue, mirror: ref, milestoneEpic: 1, githubType: "Task" }]);
  });

  it("puts only the changed field into an update", () => {
    const issue = task(5);

    const result = plan([issue], { mirrors: mirrors([5, mirror(12)]) });

    assert.deepEqual(Object.keys(result.actions[0] ?? {}).sort(), ["githubType", "issue", "kind", "mirror"]);
  });
});

describe("planActions: task parent sync (H3, H5, D2)", () => {
  /** Story YT-1 -> #11, story YT-2 -> #21, both typed. */
  const parents = [story(1), story(2)];
  const parentMirrors = [
    [1, mirror(11, { typeName: "Feature" })],
    [2, mirror(21, { typeName: "Feature" })],
  ] as const;

  function syncTask(fields: Parameters<typeof mirror>[1], extra: readonly ReturnType<typeof story>[] = []): string[] {
    const index = mirrors(...parentMirrors, [5, mirror(12, { typeName: "Task", ...fields })]);
    return [...describeActions(plan([...parents, ...extra, task(5, under(1))], { mirrors: index }).actions)];
  }

  it("puts a top-level task mirror under its parent's mirror", () => {
    assert.deepEqual(syncTask({}), ["setParent 5 #12 under YT-1"]);
  });

  it("leaves a task already under its parent's mirror unchanged", () => {
    assert.deepEqual(syncTask({ parentNumber: 11 }), []);
  });

  it("moves a task from another mirror to its parent's mirror", () => {
    assert.deepEqual(syncTask({ parentNumber: 21 }), ["setParent 5 #12 under YT-1"]);
  });

  it("replaces a hand-made or foreign parent when YouTrack wants a mirrored one (D2)", () => {
    assert.deepEqual(syncTask({ parentNumber: 99 }), ["setParent 5 #12 under YT-1"]);
    assert.deepEqual(syncTask({ parentIsForeign: true }), ["setParent 5 #12 under YT-1"]);
  });

  it("carries the setParent shape with the parent's YouTrack number", () => {
    const issue = task(5, under(1));
    const ref = titled(5, mirror(12, { typeName: "Task" }));

    const result = plan([story(1), issue], { mirrors: mirrors([1, mirror(11, { typeName: "Feature" })], [5, ref]) });

    assert.deepEqual(result.actions, [{ kind: "setParent", issue, mirror: ref, parentYt: 1 }]);
  });

  it("moves a task under a parent created in the same run, after its create (D4)", () => {
    const issues = [story(3), task(5, under(3))];

    const result = plan(issues, { mirrors: mirrors([5, mirror(12, { typeName: "Task", parentNumber: 21 })]) });

    assert.deepEqual(describeActions(result.actions), ["create 3 type=Feature", "setParent 5 #12 under YT-3"]);
  });

  it("removes a task from a mirror parent when it should be top-level", () => {
    const issue = task(5, under(9));
    const ref = titled(5, mirror(12, { typeName: "Task", parentNumber: 21 }));
    const index = mirrors([2, mirror(21, { typeName: "Feature" })], [5, ref]);

    const result = plan([story(2), epic(9, RESOLVED), issue], { mirrors: index });

    assert.deepEqual(result.actions, [{ kind: "removeParent", issue, mirror: ref, parentNumber: 21, parentYt: 2 }]);
  });

  it("removes a mirror parent whose YouTrack issue is not in the scan", () => {
    const index = mirrors([40, mirror(21)], [5, mirror(12, { typeName: "Task", parentNumber: 21 })]);

    const result = plan([task(5)], { mirrors: index });

    assert.deepEqual(describeActions(result.actions), ["removeParent 5 #12 from #21 (YT-40)"]);
  });

  it("leaves a hand-made or foreign parent alone when no parent is wanted (D2)", () => {
    const index = mirrors(
      [5, mirror(12, { typeName: "Task", parentNumber: 99 })],
      [6, mirror(13, { typeName: "Task", parentIsForeign: true })],
    );

    const result = plan([task(5), task(6)], { mirrors: index });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 2);
  });

  it("treats a losing duplicate issue as a hand-made parent", () => {
    const githubIssues = Object.freeze([
      ghIssue(21, "[CUI-2] Story"),
      ghIssue(22, "[CUI-2] Story copy"),
      ghIssue(12, desiredTitle(5), { typeName: "Task", parentNumber: 22 }),
    ]);
    const { index } = buildMirrorIndex(githubIssues, LABEL, PROJECT);

    const result = plan([task(5)], { mirrors: lockedMap(index) });

    assert.deepEqual(result.actions, []);
  });
});

describe("planActions: stories, bugs and untyped issues are top-level (H9)", () => {
  it("removes them from a mirror parent", () => {
    const issues = [story(1), story(5, under(1)), bug(6, under(1)), ytIssue(7, under(1))];
    const index = mirrors(
      [1, mirror(11, { typeName: "Feature" })],
      [5, mirror(12, { typeName: "Feature", parentNumber: 11 })],
      [6, mirror(13, { typeName: "Bug", parentNumber: 11 })],
      [7, mirror(14, { parentNumber: 11 })],
    );

    const result = plan(issues, { mirrors: index });

    assert.deepEqual(describeActions(result.actions), [
      "removeParent 5 #12 from #11 (YT-1)",
      "removeParent 6 #13 from #11 (YT-1)",
      "removeParent 7 #14 from #11 (YT-1)",
    ]);
  });

  it("leaves them under a hand-made or foreign parent (D2)", () => {
    const index = mirrors(
      [5, mirror(12, { typeName: "Feature", parentNumber: 99 })],
      [6, mirror(13, { typeName: "Bug", parentIsForeign: true })],
    );

    const result = plan([story(5), bug(6)], { mirrors: index });

    assert.deepEqual(result.actions, []);
  });
});

describe("planActions: closed mirrors are synced too (D8)", () => {
  it("syncs milestone, type and parent of a closed mirror without reopening it", () => {
    const issues = [epic(1), story(2), task(5, { ...under(2), ...RESOLVED })];
    const index = mirrors([2, mirror(21, { typeName: "Feature" })], [5, mirror(12, { state: "closed" })]);

    const result = plan(issues, { mirrors: index, milestones: MILESTONES });

    assert.deepEqual(describeActions(result.actions), ["update 5 #12 type=Task", "setParent 5 #12 under YT-2"]);
  });

  it("syncs a closed mirror of a reopened issue without reopening it", () => {
    const index = mirrors([5, mirror(12, { state: "closed" })]);

    const result = plan([bug(5)], { mirrors: index });

    assert.deepEqual(describeActions(result.actions), ["update 5 #12 type=Bug"]);
  });

  it("syncs an open mirror of a resolved issue before closing it", () => {
    const issues = [story(1), epic(2), task(5, { ...under(1), ...RESOLVED })];
    const index = mirrors([1, mirror(11, { typeName: "Feature" })], [5, mirror(12, { milestoneNumber: 4 })]);

    const result = plan(issues, { mirrors: index, milestones: MILESTONES });

    assert.deepEqual(describeActions(result.actions), [
      "update 5 #12 milestone=none type=Task",
      "setParent 5 #12 under YT-1",
      "close 5 -> #12",
    ]);
    assert.deepEqual(counts(result), { scanned: 3, filtered: 0, unchanged: 2, capped: 0 });
  });

  it("never syncs the mirror of an excluded issue (F2)", () => {
    const issues = [epic(1), story(2), task(5, { ...under(2), ...FILTERED })];
    const index = mirrors([2, mirror(21, { typeName: "Feature" })], [5, mirror(12)]);

    const result = plan(issues, { mirrors: index, milestones: MILESTONES });

    assert.deepEqual(result.actions, []);
    assert.deepEqual(counts(result), { scanned: 3, filtered: 1, unchanged: 2, capped: 0 });
  });
});

describe("planActions: title sync (N1, N2)", () => {
  it("updates the title of an open mirror whose YouTrack summary changed", () => {
    const issue = ytIssue(5, { summary: "New summary" });
    const index = mirrors([5, mirror(12, { title: "[CUI-5] Old summary" })]);

    const result = plan([issue], { mirrors: index });

    assert.deepEqual(result.actions, [{ kind: "update", issue, mirror: index.get(5), title: "[CUI-5] New summary" }]);
    assert.deepEqual(counts(result), { scanned: 1, filtered: 0, unchanged: 0, capped: 0 });
  });

  it("updates the title of a closed mirror too, without reopening it (D8)", () => {
    const issues = [ytIssue(5, { summary: "Reopened" }), ytIssue(6, { ...RESOLVED, summary: "Done" })];
    const index = mirrors(
      [5, mirror(12, { state: "closed", title: "[CUI-5] Old" })],
      [6, mirror(13, { state: "closed", title: "[CUI-6] Old" })],
    );

    const result = plan(issues, { mirrors: index });

    assert.deepEqual(describeActions(result.actions), ["update 5 #12 title", "update 6 #13 title"]);
    assert.deepEqual(
      result.actions.map((action) => (action.kind === "update" ? action.title : null)),
      ["[CUI-5] Reopened", "[CUI-6] Done"],
    );
  });

  it("leaves a mirror whose title is already the desired one unchanged", () => {
    const index = mirrors([5, mirror(12, { title: "[CUI-5] Issue 5" })], [6, mirror(13, { state: "closed" })]);

    const result = plan([ytIssue(5), ytIssue(6)], { mirrors: index });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 2);
  });

  it("renames a legacy [YT-n] mirror found by the index to the YouTrack id (N1)", () => {
    const { index } = buildMirrorIndex(Object.freeze([ghIssue(12, "[YT-5] Issue 5")]), LABEL, PROJECT);

    const result = plan([ytIssue(5)], { mirrors: lockedMap(index) });

    assert.deepEqual(describeActions(result.actions), ["update 5 #12 title"]);
    assert.equal(result.actions[0]?.kind === "update" ? result.actions[0].title : null, "[CUI-5] Issue 5");
  });

  it("renames an unlabelled legacy mirror like a labelled one, never creating a second mirror", () => {
    const { index } = buildMirrorIndex(Object.freeze([unlabelled(12, "[YT-5] Old")]), LABEL, PROJECT);

    const result = plan([ytIssue(5)], { mirrors: lockedMap(index) });

    assert.deepEqual(describeActions(result.actions), ["update 5 #12 title"]);
  });

  it("compares titles exactly, so a mirror matched case-insensitively is still renamed", () => {
    const index = mirrors(
      [5, mirror(12, { title: "[cui-5] Issue 5" })],
      [6, mirror(13, { title: "[CUI-6] issue 6" })],
      [7, mirror(14, { title: "[CUI-7]  Issue 7" })],
    );

    const result = plan([ytIssue(5), ytIssue(6), ytIssue(7)], { mirrors: index });

    assert.deepEqual(describeActions(result.actions), [
      "update 5 #12 title",
      "update 6 #13 title",
      "update 7 #14 title",
    ]);
  });

  it("wants the title formatMirror gave the mirror: trimmed, and cut for a long summary", () => {
    const padded = ytIssue(5, { summary: "  Padded  " });
    const long = ytIssue(6, { summary: "x".repeat(300) });
    const created = formatMirror(long, "https://youtrack.example");
    const index = mirrors(
      [5, mirror(12, { title: formatMirror(padded, "https://youtrack.example").title })],
      [6, mirror(13, { title: created.title })],
    );

    const result = plan([padded, long], { mirrors: index });

    assert.equal(created.titleTruncated, true);
    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 2);
  });

  it("carries title, milestone and type in one update that costs one write", () => {
    const issue = task(5, { ...under(1), summary: "Renamed" });
    const index = mirrors([5, mirror(12, { title: "[YT-5] Old", typeName: "Bug", milestoneNumber: 7 })]);

    const result = plan([epic(1), issue], { mirrors: index, milestones: MILESTONES, maxWrites: 1 });

    assert.deepEqual(result.actions, [
      { kind: "update", issue, mirror: index.get(5), title: "[CUI-5] Renamed", milestoneEpic: 1, githubType: "Task" },
    ]);
    assert.deepEqual(result.actions.map(writeCost), [1]);
    assert.deepEqual(counts(result), { scanned: 2, filtered: 0, unchanged: 1, capped: 0 });
  });

  it("puts only the title into a title-only update", () => {
    const index = mirrors([5, mirror(12, { title: "[CUI-5] Old" })]);

    const result = plan([ytIssue(5)], { mirrors: index });

    assert.deepEqual(Object.keys(result.actions[0] ?? {}).sort(), ["issue", "kind", "mirror", "title"]);
  });

  it("updates the title before the parent change and the close of the same mirror", () => {
    const issues = [story(1), task(5, { ...under(1), ...RESOLVED })];
    const index = mirrors(
      [1, mirror(11, { typeName: "Feature" })],
      [5, mirror(12, { title: "[YT-5] Issue 5", typeName: "Task" })],
    );

    const result = plan(issues, { mirrors: index });

    assert.deepEqual(describeActions(result.actions), [
      "update 5 #12 title",
      "setParent 5 #12 under YT-1",
      "close 5 -> #12",
    ]);
  });

  it("never updates the title of an excluded issue's mirror, nor of one below it (F1, F3, F2)", () => {
    const issues = [story(5, FILTERED), task(6, { ...under(5), summary: "Renamed" })];
    const index = mirrors(
      [5, mirror(12, { title: "[YT-5] Old", typeName: "Feature" })],
      [6, mirror(13, { title: "[CUI-6] Old", typeName: "Task" })],
    );

    const result = plan(issues, { mirrors: index });

    assert.deepEqual(result.actions, []);
    assert.deepEqual(counts(result), { scanned: 2, filtered: 2, unchanged: 0, capped: 0 });
  });
});
