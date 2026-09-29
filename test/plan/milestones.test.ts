import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GitHubMilestone } from "../../src/github/milestones.ts";
import { buildMilestoneIndex } from "../../src/plan/milestones.ts";
import type { MilestoneIndexResult } from "../../src/plan/milestones.ts";
import { ghMilestone } from "./fixtures.ts";

function build(...milestones: readonly GitHubMilestone[]): MilestoneIndexResult {
  return buildMilestoneIndex(Object.freeze([...milestones]));
}

describe("buildMilestoneIndex: matching", () => {
  it("returns empty maps and no warnings for an empty list", () => {
    const result = build();

    assert.equal(result.index.size, 0);
    assert.equal(result.byNumber.size, 0);
    assert.deepEqual(result.warnings, []);
  });

  it("indexes each milestone by the epic number in its title, keeping number and state", () => {
    const result = build(ghMilestone(3, "[YT-9] Epic nine"), ghMilestone(4, "[YT-33] Done", "closed"));

    assert.deepEqual(
      [...result.index.entries()],
      [
        [9, { milestoneNumber: 3, state: "open" }],
        [33, { milestoneNumber: 4, state: "closed" }],
      ],
    );
    assert.deepEqual(result.warnings, []);
  });

  it("maps each indexed milestone number back to its epic number", () => {
    const result = build(ghMilestone(3, "[YT-9] Epic nine"), ghMilestone(4, "[YT-33] Done", "closed"));

    assert.deepEqual(
      [...result.byNumber.entries()],
      [
        [3, 9],
        [4, 33],
      ],
    );
  });

  it("ignores milestones whose title is not a mirror title", () => {
    const result = build(
      ghMilestone(1, "Sprint 1"),
      ghMilestone(2, "[yt-3] lower case"),
      ghMilestone(3, "[YT-0] zero"),
      ghMilestone(4, " [YT-3] leading space"),
      ghMilestone(5, "Release [YT-3]"),
      ghMilestone(6, "[YT-] no number"),
    );

    assert.equal(result.index.size, 0);
    assert.equal(result.byNumber.size, 0);
    assert.deepEqual(result.warnings, []);
  });

  it("parses the epic number like an issue title, tolerating leading zeros and no summary", () => {
    const result = build(ghMilestone(7, "[YT-007] Padded"), ghMilestone(8, "[YT-10]"), ghMilestone(9, "[YT-9]x"));

    assert.deepEqual([...result.index.keys()], [7, 9, 10]);
  });

  it("keeps a milestone listed twice once, from its first copy, without a warning", () => {
    const result = build(ghMilestone(3, "[YT-9] Epic"), ghMilestone(3, "[YT-9] Epic", "closed"));

    assert.deepEqual(result.index.get(9), { milestoneNumber: 3, state: "open" });
    assert.deepEqual(result.warnings, []);
  });

  it("leaves its frozen input untouched", () => {
    const milestones = Object.freeze([ghMilestone(5, "[YT-9] B"), ghMilestone(3, "[YT-9] A")]);
    const snapshot = structuredClone(milestones);

    buildMilestoneIndex(milestones);

    assert.deepEqual(milestones, snapshot);
  });
});

describe("buildMilestoneIndex: duplicates", () => {
  it("uses the lowest milestone number, whatever the list order, and warns about the other", () => {
    const result = build(ghMilestone(5, "[YT-9] Later copy"), ghMilestone(3, "[YT-9] First"));

    assert.deepEqual(result.index.get(9), { milestoneNumber: 3, state: "open" });
    assert.deepEqual(result.warnings, ["YT-9: 2 GitHub milestones match; using milestone #3, ignoring milestone #5"]);
  });

  it("prefers the lowest number even when it is closed and the other is open", () => {
    const result = build(ghMilestone(5, "[YT-9] Open"), ghMilestone(3, "[YT-9] Closed", "closed"));

    assert.deepEqual(result.index.get(9), { milestoneNumber: 3, state: "closed" });
  });

  it("maps only the winner back to the epic; an ignored duplicate is not a mirror milestone", () => {
    const result = build(ghMilestone(5, "[YT-9] B"), ghMilestone(3, "[YT-9] A"));

    assert.deepEqual([...result.byNumber.entries()], [[3, 9]]);
  });

  it("adds one warning per extra milestone, in ascending milestone number", () => {
    const result = build(ghMilestone(30, "[YT-9] C"), ghMilestone(4, "[YT-9] A"), ghMilestone(21, "[YT-9] B"));

    assert.equal(result.index.get(9)?.milestoneNumber, 4);
    assert.deepEqual(result.warnings, [
      "YT-9: 3 GitHub milestones match; using milestone #4, ignoring milestone #21",
      "YT-9: 3 GitHub milestones match; using milestone #4, ignoring milestone #30",
    ]);
  });

  it("compares milestone numbers numerically, not as text", () => {
    const result = build(ghMilestone(100, "[YT-9] A"), ghMilestone(99, "[YT-9] B"));

    assert.equal(result.index.get(9)?.milestoneNumber, 99);
    assert.deepEqual(result.warnings, [
      "YT-9: 2 GitHub milestones match; using milestone #99, ignoring milestone #100",
    ]);
  });

  it("keeps duplicate groups of different epics apart and orders warnings by epic number", () => {
    const result = build(
      ghMilestone(8, "[YT-10] B"),
      ghMilestone(6, "[YT-9] B"),
      ghMilestone(7, "[YT-10] A"),
      ghMilestone(2, "[YT-9] A"),
      ghMilestone(1, "[YT-4] Alone"),
    );

    assert.deepEqual(
      [...result.index.entries()].map(([epicNumber, ref]) => [epicNumber, ref.milestoneNumber]),
      [
        [4, 1],
        [9, 2],
        [10, 7],
      ],
    );
    assert.deepEqual(result.warnings, [
      "YT-9: 2 GitHub milestones match; using milestone #2, ignoring milestone #6",
      "YT-10: 2 GitHub milestones match; using milestone #7, ignoring milestone #8",
    ]);
  });

  it("never puts milestone titles into warnings", () => {
    const result = build(ghMilestone(3, "[YT-9] secret-title"), ghMilestone(4, "[YT-9] secret-title"));

    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings.every((warning) => !warning.includes("secret-title")));
  });
});
