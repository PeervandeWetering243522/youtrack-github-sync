import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildMirrorIndex, mirrorNumbers } from "../src/plan/mirrors.ts";
import { ghIssue, LABEL, mirror, mirrors, unlabelled } from "./plan-fixtures.ts";

describe("buildMirrorIndex: matching", () => {
  it("returns an empty index and no warnings for an empty list", () => {
    const result = buildMirrorIndex(Object.freeze([]), LABEL);

    assert.equal(result.index.size, 0);
    assert.deepEqual(result.warnings, []);
  });

  it("indexes a labelled mirror by the number in its title, keeping state and label", () => {
    const issues = Object.freeze([ghIssue(12, "[YT-5] Fix it"), ghIssue(13, "[YT-6] Done", { state: "closed" })]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(
      [...result.index.entries()],
      [
        [5, mirror(12)],
        [6, mirror(13, { state: "closed" })],
      ],
    );
    assert.deepEqual(result.warnings, []);
  });

  it("ignores titles that are not mirror titles", () => {
    const issues = Object.freeze([
      ghIssue(1, "Fix [YT-3] later"),
      ghIssue(2, "[yt-3] lower case"),
      ghIssue(3, "[YT-0] zero"),
      ghIssue(4, " [YT-3] leading space"),
      ghIssue(5, "[YT-] no number"),
    ]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.equal(result.index.size, 0);
    assert.deepEqual(result.warnings, []);
  });

  it("ignores pull requests, even labelled ones with a lower number", () => {
    const issues = Object.freeze([ghIssue(3, "[YT-5] PR", { isPullRequest: true }), ghIssue(12, "[YT-5] Fix it")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(result.index.get(5), mirror(12));
    assert.deepEqual(result.warnings, []);
  });

  it("gives no mirror when only a pull request carries the title", () => {
    const issues = Object.freeze([ghIssue(3, "[YT-5] PR", { isPullRequest: true })]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.equal(result.index.has(5), false);
    assert.deepEqual(result.warnings, []);
  });

  it("uses the given label name, not other labels", () => {
    const issues = Object.freeze([ghIssue(12, "[YT-5] Fix it", { labelNames: ["bug", "YouTrack-ish"] })]);

    const result = buildMirrorIndex(issues, "mirror");

    assert.equal(result.index.get(5)?.hasLabel, false);
    assert.deepEqual(result.warnings, ['YT-5: #12 matched by title only (no "mirror" label)']);
  });

  it("does not report an issue listed twice as its own duplicate", () => {
    const issue = ghIssue(12, "[YT-5] Fix it");

    const result = buildMirrorIndex(Object.freeze([issue, issue]), LABEL);

    assert.deepEqual(result.index.get(5), mirror(12));
    assert.deepEqual(result.warnings, []);
  });

  it("keeps the first copy of an issue listed twice with a changed state", () => {
    const issues = Object.freeze([ghIssue(12, "[YT-5] Fix it"), ghIssue(12, "[YT-5] Fix it", { state: "closed" })]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(result.index.get(5), mirror(12));
    assert.deepEqual(result.warnings, []);
  });

  it("matches the label case-insensitively, as GitHub does (docs/03, gotcha 14)", () => {
    const issues = Object.freeze([
      ghIssue(12, "[YT-5] Upper", { labelNames: ["YouTrack"] }),
      ghIssue(13, "[YT-6] Shout", { labelNames: ["bug", "YOUTRACK"] }),
    ]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.equal(result.index.get(5)?.hasLabel, true);
    assert.equal(result.index.get(6)?.hasLabel, true);
    assert.deepEqual(result.warnings, []);
  });

  it("does not count a label that merely contains the name", () => {
    const issues = Object.freeze([
      ghIssue(12, "[YT-5] Fix it", { labelNames: ["youtrack-old", " youtrack", "you track"] }),
    ]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.equal(result.index.get(5)?.hasLabel, false);
  });

  it("parses the mirror number from the title, tolerating leading zeros", () => {
    const issues = Object.freeze([ghIssue(12, "[YT-007] Padded"), ghIssue(13, "[YT-10]"), ghIssue(14, "[YT-9]x")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual([...result.index.keys()], [7, 9, 10]);
  });
});

describe("buildMirrorIndex: hierarchy fields", () => {
  it("copies id, milestone, type and parent from the GitHub issue", () => {
    const issues = Object.freeze([
      ghIssue(12, "[YT-5] Task", { id: 777, milestoneNumber: 3, typeName: "Task", parentNumber: 11 }),
      ghIssue(13, "[YT-6] Story", { typeName: "Feature", parentIsForeign: true }),
    ]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(
      result.index.get(5),
      mirror(12, { id: 777, milestoneNumber: 3, typeName: "Task", parentNumber: 11 }),
    );
    assert.deepEqual(result.index.get(6), mirror(13, { typeName: "Feature", parentIsForeign: true }));
  });

  it("takes every field from the winning duplicate, none from the ignored one", () => {
    const issues = Object.freeze([
      unlabelled(9, "[YT-5] Loser", { milestoneNumber: 1, typeName: "Bug", parentNumber: 2 }),
      ghIssue(21, "[YT-5] Winner", { state: "closed", milestoneNumber: 4 }),
    ]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(result.index.get(5), mirror(21, { state: "closed", milestoneNumber: 4 }));
  });

  it("keeps a verbatim type name, whatever its case", () => {
    const issues = Object.freeze([ghIssue(12, "[YT-5] Task", { typeName: "task" })]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.equal(result.index.get(5)?.typeName, "task");
  });
});

describe("buildMirrorIndex: precedence and warnings", () => {
  it("prefers a labelled candidate over an unlabelled one with a lower number", () => {
    const issues = Object.freeze([unlabelled(12, "[YT-5] Old"), ghIssue(15, "[YT-5] New")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(result.index.get(5), mirror(15));
    assert.deepEqual(result.warnings, ["YT-5: 2 GitHub issues match; using #15 (labelled), ignoring #12"]);
  });

  it("picks the lowest issue number among labelled candidates, whatever the list order", () => {
    const issues = Object.freeze([ghIssue(15, "[YT-5] B", { state: "closed" }), ghIssue(12, "[YT-5] A")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(result.index.get(5), mirror(12));
    assert.deepEqual(result.warnings, ["YT-5: 2 GitHub issues match; using #12 (labelled), ignoring #15"]);
  });

  it("picks the lowest issue number among unlabelled candidates and warns about both", () => {
    const issues = Object.freeze([unlabelled(20, "[YT-7] B"), unlabelled(18, "[YT-7] A")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(result.index.get(7), mirror(18, { hasLabel: false }));
    assert.deepEqual(result.warnings, [
      'YT-7: #18 matched by title only (no "youtrack" label)',
      "YT-7: 2 GitHub issues match; using #18 (unlabelled), ignoring #20",
    ]);
  });

  it("adds one warning per extra candidate", () => {
    const issues = Object.freeze([unlabelled(9, "[YT-5] A"), ghIssue(30, "[YT-5] C"), ghIssue(21, "[YT-5] B")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.equal(result.index.get(5)?.issueNumber, 21);
    assert.deepEqual(result.warnings, [
      "YT-5: 3 GitHub issues match; using #21 (labelled), ignoring #30",
      "YT-5: 3 GitHub issues match; using #21 (labelled), ignoring #9",
    ]);
  });

  it("warns when the only match is unlabelled, and still uses it", () => {
    const issues = Object.freeze([unlabelled(12, "[YT-5] Fix it", { state: "closed" })]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(result.index.get(5), mirror(12, { state: "closed", hasLabel: false }));
    assert.deepEqual(result.warnings, ['YT-5: #12 matched by title only (no "youtrack" label)']);
  });

  it("orders warnings by YouTrack number, whatever the list order", () => {
    const issues = Object.freeze([unlabelled(40, "[YT-9] Later"), unlabelled(41, "[YT-2] Earlier")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(result.warnings, [
      'YT-2: #41 matched by title only (no "youtrack" label)',
      'YT-9: #40 matched by title only (no "youtrack" label)',
    ]);
  });

  it("compares issue numbers numerically, not as text", () => {
    const issues = Object.freeze([ghIssue(100, "[YT-5] A"), ghIssue(99, "[YT-5] B")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.equal(result.index.get(5)?.issueNumber, 99);
    assert.deepEqual(result.warnings, ["YT-5: 2 GitHub issues match; using #99 (labelled), ignoring #100"]);
  });

  it("orders warnings by YouTrack number numerically, not as text", () => {
    const issues = Object.freeze([unlabelled(1, "[YT-10] Ten"), unlabelled(2, "[YT-9] Nine")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(result.warnings, [
      'YT-9: #2 matched by title only (no "youtrack" label)',
      'YT-10: #1 matched by title only (no "youtrack" label)',
    ]);
  });

  it("keeps duplicate groups of different YouTrack numbers apart", () => {
    const issues = Object.freeze([
      ghIssue(31, "[YT-6] B"),
      ghIssue(20, "[YT-5] A"),
      unlabelled(30, "[YT-6] C"),
      ghIssue(21, "[YT-5] D"),
      ghIssue(40, "[YT-7] Alone"),
    ]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(
      [...result.index.entries()].map(([numberInProject, ref]) => [numberInProject, ref.issueNumber]),
      [
        [5, 20],
        [6, 31],
        [7, 40],
      ],
    );
    assert.deepEqual(result.warnings, [
      "YT-5: 2 GitHub issues match; using #20 (labelled), ignoring #21",
      "YT-6: 2 GitHub issues match; using #31 (labelled), ignoring #30",
    ]);
  });

  it("uses a closed labelled mirror over an open unlabelled one", () => {
    const issues = Object.freeze([
      unlabelled(12, "[YT-5] Open copy"),
      ghIssue(15, "[YT-5] Closed", { state: "closed" }),
    ]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(result.index.get(5), mirror(15, { state: "closed" }));
  });

  it("never puts issue titles into warnings", () => {
    const issues = Object.freeze([unlabelled(12, "[YT-5] secret-title"), unlabelled(13, "[YT-5] secret-title")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.equal(result.warnings.length, 2);
    assert.ok(result.warnings.every((warning) => !warning.includes("secret-title")));
  });

  it("leaves its frozen input untouched", () => {
    const issues = Object.freeze([ghIssue(15, "[YT-5] B"), unlabelled(12, "[YT-5] A"), ghIssue(3, "[YT-1] C")]);
    const snapshot = structuredClone(issues);

    buildMirrorIndex(issues, LABEL);

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
    const { index } = buildMirrorIndex(Object.freeze([ghIssue(12, "[YT-5] A"), ghIssue(13, "[YT-5] B")]), LABEL);

    assert.deepEqual([...mirrorNumbers(index).entries()], [[12, 5]]);
  });
});
