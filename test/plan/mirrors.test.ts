import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildMirrorIndex, mirrorNumbers } from "../../src/plan/mirrors.ts";
import { ghIssue, LABEL, mirror, mirrors, PROJECT, unlabelled } from "./fixtures.ts";

describe("buildMirrorIndex: matching", () => {
  it("returns an empty index and no warnings for an empty list", () => {
    const result = buildMirrorIndex(Object.freeze([]), LABEL, PROJECT);

    assert.equal(result.index.size, 0);
    assert.deepEqual(result.warnings, []);
  });

  it("indexes a labelled mirror by the number in its title, keeping title, state and label", () => {
    const issues = Object.freeze([ghIssue(12, "[CUI-5] Fix it"), ghIssue(13, "[CUI-6] Done", { state: "closed" })]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.deepEqual(
      [...result.index.entries()],
      [
        [5, mirror(12, { title: "[CUI-5] Fix it" })],
        [6, mirror(13, { title: "[CUI-6] Done", state: "closed" })],
      ],
    );
    assert.deepEqual(result.warnings, []);
  });

  it("ignores titles that are not mirror titles", () => {
    const issues = Object.freeze([
      ghIssue(1, "Fix [CUI-3] later"),
      ghIssue(2, "[yt-3] lower-case legacy id"),
      ghIssue(3, "[CUI-0] zero"),
      ghIssue(4, " [CUI-3] leading space"),
      ghIssue(5, "[CUI-] no number"),
      ghIssue(6, "[YT-0] legacy zero"),
    ]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.equal(result.index.size, 0);
    assert.deepEqual(result.warnings, []);
  });

  it("ignores pull requests, even labelled ones with a lower number", () => {
    const issues = Object.freeze([ghIssue(3, "[CUI-5] PR", { isPullRequest: true }), ghIssue(12, "[CUI-5] Fix it")]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.deepEqual(result.index.get(5), mirror(12, { title: "[CUI-5] Fix it" }));
    assert.deepEqual(result.warnings, []);
  });

  it("gives no mirror when only a pull request carries the title", () => {
    const issues = Object.freeze([ghIssue(3, "[CUI-5] PR", { isPullRequest: true })]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.equal(result.index.has(5), false);
    assert.deepEqual(result.warnings, []);
  });

  it("uses the given label name, not other labels", () => {
    const issues = Object.freeze([ghIssue(12, "[CUI-5] Fix it", { labelNames: ["bug", "YouTrack-ish"] })]);

    const result = buildMirrorIndex(issues, "mirror", PROJECT);

    assert.equal(result.index.get(5)?.hasLabel, false);
    assert.deepEqual(result.warnings, ['CUI-5: #12 matched by title only (no "mirror" label)']);
  });

  it("does not report an issue listed twice as its own duplicate", () => {
    const issue = ghIssue(12, "[CUI-5] Fix it");

    const result = buildMirrorIndex(Object.freeze([issue, issue]), LABEL, PROJECT);

    assert.deepEqual(result.index.get(5), mirror(12, { title: "[CUI-5] Fix it" }));
    assert.deepEqual(result.warnings, []);
  });

  it("keeps the first copy of an issue listed twice with a changed state", () => {
    const issues = Object.freeze([ghIssue(12, "[CUI-5] Fix it"), ghIssue(12, "[CUI-5] Fixed", { state: "closed" })]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.deepEqual(result.index.get(5), mirror(12, { title: "[CUI-5] Fix it" }));
    assert.deepEqual(result.warnings, []);
  });

  it("matches the label case-insensitively, as GitHub does (docs/03, gotcha 14)", () => {
    const issues = Object.freeze([
      ghIssue(12, "[CUI-5] Upper", { labelNames: ["YouTrack"] }),
      ghIssue(13, "[CUI-6] Shout", { labelNames: ["bug", "YOUTRACK"] }),
    ]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.equal(result.index.get(5)?.hasLabel, true);
    assert.equal(result.index.get(6)?.hasLabel, true);
    assert.deepEqual(result.warnings, []);
  });

  it("does not count a label that merely contains the name", () => {
    const issues = Object.freeze([
      ghIssue(12, "[CUI-5] Fix it", { labelNames: ["youtrack-old", " youtrack", "you track"] }),
    ]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.equal(result.index.get(5)?.hasLabel, false);
  });

  it("parses the mirror number from the title, tolerating leading zeros", () => {
    const issues = Object.freeze([ghIssue(12, "[CUI-007] Padded"), ghIssue(13, "[CUI-10]"), ghIssue(14, "[CUI-9]x")]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.deepEqual([...result.index.keys()], [7, 9, 10]);
  });
});

describe("buildMirrorIndex: project ids in titles (N1)", () => {
  it("matches the project's own ids and the legacy [YT-n] ids alike, keeping each title as listed", () => {
    const issues = Object.freeze([ghIssue(12, "[CUI-5] New style"), ghIssue(13, "[YT-6] Old style")]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    // The legacy title is kept, so the planner sees that it differs and renames it (N2).
    assert.deepEqual(
      [...result.index.entries()],
      [
        [5, mirror(12, { title: "[CUI-5] New style" })],
        [6, mirror(13, { title: "[YT-6] Old style" })],
      ],
    );
    assert.deepEqual(result.warnings, []);
  });

  it("ignores the ids of other projects, including ones that start or end like the project", () => {
    const issues = Object.freeze([
      ghIssue(1, "[ABC-3] Other project"),
      ghIssue(2, "[CU-3] Shorter id"),
      ghIssue(3, "[CUIX-3] Longer id"),
      ghIssue(4, "[XCUI-3] Longer id"),
      ghIssue(5, "[CUI-X-3] Dashed id"),
      ghIssue(6, "[YTX-3] Not the legacy id"),
    ]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.equal(result.index.size, 0);
    assert.deepEqual(result.warnings, []);
  });

  it("compares the project ASCII-case-insensitively, but the legacy YT id exactly", () => {
    const issues = Object.freeze([
      ghIssue(12, "[cui-5] Lower"),
      ghIssue(13, "[Cui-6] Mixed"),
      ghIssue(14, "[yt-7] Lower legacy"),
      ghIssue(15, "[Yt-8] Mixed legacy"),
    ]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.deepEqual([...result.index.keys()], [5, 6]);
    assert.equal(result.index.get(5)?.title, "[cui-5] Lower");
  });

  it("matches the configured project, whatever its case, and no other", () => {
    const issues = Object.freeze([
      ghIssue(12, "[ABC-3] Ours"),
      ghIssue(13, "[CUI-4] Theirs"),
      ghIssue(14, "[YT-5] Old"),
    ]);

    const upper = buildMirrorIndex(issues, LABEL, "ABC");
    const lower = buildMirrorIndex(issues, LABEL, "abc");

    assert.deepEqual([...upper.index.keys()], [3, 5]);
    assert.deepEqual([...lower.index.keys()], [3, 5]);
  });

  it("names warnings after the configured project, whatever id the title uses", () => {
    const issues = Object.freeze([unlabelled(12, "[cui-5] Lower"), unlabelled(13, "[YT-6] Legacy")]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.deepEqual(result.warnings, [
      'CUI-5: #12 matched by title only (no "youtrack" label)',
      'CUI-6: #13 matched by title only (no "youtrack" label)',
    ]);
  });

  it("names warnings after another configured project too", () => {
    const issues = Object.freeze([unlabelled(12, "[ABC-3] Ours")]);

    const result = buildMirrorIndex(issues, LABEL, "ABC");

    assert.deepEqual(result.warnings, ['ABC-3: #12 matched by title only (no "youtrack" label)']);
  });

  it("counts a legacy and a new title for the same number as duplicates, lowest number first", () => {
    const issues = Object.freeze([ghIssue(21, "[CUI-5] New"), ghIssue(20, "[YT-5] Old")]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.deepEqual(result.index.get(5), mirror(20, { title: "[YT-5] Old" }));
    assert.deepEqual(result.warnings, ["CUI-5: 2 GitHub issues match; using #20 (labelled), ignoring #21"]);
  });

  it("prefers a labelled new title over an unlabelled legacy one with a lower number", () => {
    const issues = Object.freeze([unlabelled(20, "[YT-5] Old"), ghIssue(21, "[CUI-5] New")]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.deepEqual(result.index.get(5), mirror(21, { title: "[CUI-5] New" }));
    assert.deepEqual(result.warnings, ["CUI-5: 2 GitHub issues match; using #21 (labelled), ignoring #20"]);
  });
});

describe("buildMirrorIndex: hierarchy fields", () => {
  it("copies id, title, milestone, type and parent from the GitHub issue", () => {
    const issues = Object.freeze([
      ghIssue(12, "[CUI-5] Task", { id: 777, milestoneNumber: 3, typeName: "Task", parentNumber: 11 }),
      ghIssue(13, "[CUI-6] Story", { typeName: "Feature", parentIsForeign: true }),
    ]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.deepEqual(
      result.index.get(5),
      mirror(12, { id: 777, title: "[CUI-5] Task", milestoneNumber: 3, typeName: "Task", parentNumber: 11 }),
    );
    assert.deepEqual(
      result.index.get(6),
      mirror(13, { title: "[CUI-6] Story", typeName: "Feature", parentIsForeign: true }),
    );
  });

  it("takes every field from the winning duplicate, none from the ignored one", () => {
    const issues = Object.freeze([
      unlabelled(9, "[CUI-5] Loser", { milestoneNumber: 1, typeName: "Bug", parentNumber: 2 }),
      ghIssue(21, "[CUI-5] Winner", { state: "closed", milestoneNumber: 4 }),
    ]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.deepEqual(result.index.get(5), mirror(21, { title: "[CUI-5] Winner", state: "closed", milestoneNumber: 4 }));
  });

  it("copies who closed the issue verbatim, from labelled and title-only mirrors alike (R10)", () => {
    const issues = Object.freeze([
      ghIssue(12, "[CUI-5] Task", { state: "closed", closedBy: "GitHub-Actions[bot]" }),
      unlabelled(13, "[CUI-6] Story", { state: "closed", closedBy: "someone" }),
      ghIssue(14, "[CUI-7] Open", { closedBy: null }),
    ]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.deepEqual(
      result.index.get(5),
      mirror(12, { title: "[CUI-5] Task", state: "closed", closedBy: "GitHub-Actions[bot]" }),
    );
    assert.deepEqual(
      result.index.get(6),
      mirror(13, { title: "[CUI-6] Story", state: "closed", hasLabel: false, closedBy: "someone" }),
    );
    assert.equal(result.index.get(7)?.closedBy, null);
  });

  it("takes the closer from the winning duplicate, not from the ignored one", () => {
    const issues = Object.freeze([
      unlabelled(9, "[CUI-5] Loser", { state: "closed", closedBy: "github-actions[bot]" }),
      ghIssue(21, "[CUI-5] Winner", { state: "closed", closedBy: "a-person" }),
    ]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.equal(result.index.get(5)?.closedBy, "a-person");
  });

  it("keeps a verbatim type name, whatever its case", () => {
    const issues = Object.freeze([ghIssue(12, "[CUI-5] Task", { typeName: "task" })]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.equal(result.index.get(5)?.typeName, "task");
  });

  it("copies the winner's assignees verbatim, Bots included, for the assignee diff (U4)", () => {
    const assignees = Object.freeze([
      Object.freeze({ login: "JaneDoe123456", type: "User" }),
      Object.freeze({ login: "helper-bot[bot]", type: "Bot" }),
    ]);
    const issues = Object.freeze([
      unlabelled(9, "[CUI-5] Loser", { assignees: Object.freeze([{ login: "staffuser", type: "User" }]) }),
      ghIssue(21, "[CUI-5] Winner", { assignees }),
    ]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.deepEqual(result.index.get(5), mirror(21, { title: "[CUI-5] Winner", assignees }));
  });

  it("gives a mirror without assignees an empty list", () => {
    const result = buildMirrorIndex(Object.freeze([ghIssue(12, "[CUI-5] Task")]), LABEL, PROJECT);

    assert.deepEqual(result.index.get(5)?.assignees, []);
  });
});

describe("buildMirrorIndex: precedence and warnings", () => {
  it("prefers a labelled candidate over an unlabelled one with a lower number", () => {
    const issues = Object.freeze([unlabelled(12, "[CUI-5] Old"), ghIssue(15, "[CUI-5] New")]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.deepEqual(result.index.get(5), mirror(15, { title: "[CUI-5] New" }));
    assert.deepEqual(result.warnings, ["CUI-5: 2 GitHub issues match; using #15 (labelled), ignoring #12"]);
  });

  it("picks the lowest issue number among labelled candidates, whatever the list order", () => {
    const issues = Object.freeze([ghIssue(15, "[CUI-5] B", { state: "closed" }), ghIssue(12, "[CUI-5] A")]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.deepEqual(result.index.get(5), mirror(12, { title: "[CUI-5] A" }));
    assert.deepEqual(result.warnings, ["CUI-5: 2 GitHub issues match; using #12 (labelled), ignoring #15"]);
  });

  it("picks the lowest issue number among unlabelled candidates and warns about both", () => {
    const issues = Object.freeze([unlabelled(20, "[CUI-7] B"), unlabelled(18, "[CUI-7] A")]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.deepEqual(result.index.get(7), mirror(18, { title: "[CUI-7] A", hasLabel: false }));
    assert.deepEqual(result.warnings, [
      'CUI-7: #18 matched by title only (no "youtrack" label)',
      "CUI-7: 2 GitHub issues match; using #18 (unlabelled), ignoring #20",
    ]);
  });

  it("adds one warning per extra candidate", () => {
    const issues = Object.freeze([unlabelled(9, "[CUI-5] A"), ghIssue(30, "[CUI-5] C"), ghIssue(21, "[CUI-5] B")]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.equal(result.index.get(5)?.issueNumber, 21);
    assert.deepEqual(result.warnings, [
      "CUI-5: 3 GitHub issues match; using #21 (labelled), ignoring #30",
      "CUI-5: 3 GitHub issues match; using #21 (labelled), ignoring #9",
    ]);
  });

  it("warns when the only match is unlabelled, and still uses it", () => {
    const issues = Object.freeze([unlabelled(12, "[CUI-5] Fix it", { state: "closed" })]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.deepEqual(result.index.get(5), mirror(12, { title: "[CUI-5] Fix it", state: "closed", hasLabel: false }));
    assert.deepEqual(result.warnings, ['CUI-5: #12 matched by title only (no "youtrack" label)']);
  });

  it("orders warnings by YouTrack number, whatever the list order", () => {
    const issues = Object.freeze([unlabelled(40, "[CUI-9] Later"), unlabelled(41, "[CUI-2] Earlier")]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.deepEqual(result.warnings, [
      'CUI-2: #41 matched by title only (no "youtrack" label)',
      'CUI-9: #40 matched by title only (no "youtrack" label)',
    ]);
  });

  it("compares issue numbers numerically, not as text", () => {
    const issues = Object.freeze([ghIssue(100, "[CUI-5] A"), ghIssue(99, "[CUI-5] B")]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.equal(result.index.get(5)?.issueNumber, 99);
    assert.deepEqual(result.warnings, ["CUI-5: 2 GitHub issues match; using #99 (labelled), ignoring #100"]);
  });

  it("orders warnings by YouTrack number numerically, not as text", () => {
    const issues = Object.freeze([unlabelled(1, "[CUI-10] Ten"), unlabelled(2, "[CUI-9] Nine")]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.deepEqual(result.warnings, [
      'CUI-9: #2 matched by title only (no "youtrack" label)',
      'CUI-10: #1 matched by title only (no "youtrack" label)',
    ]);
  });

  it("keeps duplicate groups of different YouTrack numbers apart", () => {
    const issues = Object.freeze([
      ghIssue(31, "[CUI-6] B"),
      ghIssue(20, "[CUI-5] A"),
      unlabelled(30, "[CUI-6] C"),
      ghIssue(21, "[CUI-5] D"),
      ghIssue(40, "[CUI-7] Alone"),
    ]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.deepEqual(
      [...result.index.entries()].map(([numberInProject, ref]) => [numberInProject, ref.issueNumber]),
      [
        [5, 20],
        [6, 31],
        [7, 40],
      ],
    );
    assert.deepEqual(result.warnings, [
      "CUI-5: 2 GitHub issues match; using #20 (labelled), ignoring #21",
      "CUI-6: 2 GitHub issues match; using #31 (labelled), ignoring #30",
    ]);
  });

  it("uses a closed labelled mirror over an open unlabelled one", () => {
    const issues = Object.freeze([
      unlabelled(12, "[CUI-5] Open copy"),
      ghIssue(15, "[CUI-5] Closed", { state: "closed" }),
    ]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.deepEqual(result.index.get(5), mirror(15, { title: "[CUI-5] Closed", state: "closed" }));
  });

  it("never puts issue titles into warnings", () => {
    const issues = Object.freeze([unlabelled(12, "[CUI-5] secret-title"), unlabelled(13, "[YT-5] secret-title")]);

    const result = buildMirrorIndex(issues, LABEL, PROJECT);

    assert.equal(result.warnings.length, 2);
    assert.ok(result.warnings.every((warning) => !warning.includes("secret-title")));
  });

  it("leaves its frozen input untouched", () => {
    const issues = Object.freeze([ghIssue(15, "[CUI-5] B"), unlabelled(12, "[YT-5] A"), ghIssue(3, "[CUI-1] C")]);
    const snapshot = structuredClone(issues);

    buildMirrorIndex(issues, LABEL, PROJECT);

    assert.deepEqual(issues, snapshot);
  });
});

describe("mirrorNumbers", () => {
  it("maps each mirror's GitHub issue number back to its YouTrack number", () => {
    const index = mirrors([5, mirror(12)], [6, mirror(40, { state: "closed" })]);

    assert.deepEqual(
      [...mirrorNumbers(index).entries()],
      [
        [12, 5],
        [40, 6],
      ],
    );
  });

  it("is empty for an empty index", () => {
    assert.equal(mirrorNumbers(mirrors()).size, 0);
  });

  it("maps only the index's winners, so an ignored duplicate is not a mirror", () => {
    const { index } = buildMirrorIndex(
      Object.freeze([ghIssue(12, "[CUI-5] A"), ghIssue(13, "[YT-5] B")]),
      LABEL,
      PROJECT,
    );

    assert.deepEqual([...mirrorNumbers(index).entries()], [[12, 5]]);
  });
});
