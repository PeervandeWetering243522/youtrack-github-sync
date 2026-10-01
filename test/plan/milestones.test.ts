import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GitHubMilestone } from "../../src/github/milestones.ts";
import { buildMilestoneIndex } from "../../src/plan/milestones.ts";
import type { MilestoneIndexResult } from "../../src/plan/milestones.ts";
import { ghMilestone, PROJECT } from "./fixtures.ts";

function build(...milestones: readonly GitHubMilestone[]): MilestoneIndexResult {
  return buildMilestoneIndex(Object.freeze([...milestones]), PROJECT);
}

describe("buildMilestoneIndex: matching", () => {
  it("returns empty maps and no warnings for an empty list", () => {
    const result = build();

    assert.equal(result.index.size, 0);
    assert.equal(result.byNumber.size, 0);
    assert.deepEqual(result.warnings, []);
  });

  it("indexes each milestone by the epic number in its title, keeping number, title and state", () => {
    const result = build(ghMilestone(3, "[CUI-9] Epic nine"), ghMilestone(4, "[CUI-33] Done", "closed"));

    assert.deepEqual(
      [...result.index.entries()],
      [
        [9, { milestoneNumber: 3, title: "[CUI-9] Epic nine", state: "open" }],
        [33, { milestoneNumber: 4, title: "[CUI-33] Done", state: "closed" }],
      ],
    );
    assert.deepEqual(result.warnings, []);
  });

  it("maps each indexed milestone number back to its epic number", () => {
    const result = build(ghMilestone(3, "[CUI-9] Epic nine"), ghMilestone(4, "[CUI-33] Done", "closed"));

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
      ghMilestone(2, "[yt-3] lower-case legacy id"),
      ghMilestone(3, "[CUI-0] zero"),
      ghMilestone(4, " [CUI-3] leading space"),
      ghMilestone(5, "Release [CUI-3]"),
      ghMilestone(6, "[CUI-] no number"),
    );

    assert.equal(result.index.size, 0);
    assert.equal(result.byNumber.size, 0);
    assert.deepEqual(result.warnings, []);
  });

  it("parses the epic number like an issue title, tolerating leading zeros and no summary", () => {
    const result = build(ghMilestone(7, "[CUI-007] Padded"), ghMilestone(8, "[CUI-10]"), ghMilestone(9, "[CUI-9]x"));

    assert.deepEqual([...result.index.keys()], [7, 9, 10]);
  });

  it("keeps a milestone listed twice once, from its first copy, without a warning", () => {
    const result = build(ghMilestone(3, "[CUI-9] Epic"), ghMilestone(3, "[CUI-9] Renamed", "closed"));

    assert.deepEqual(result.index.get(9), { milestoneNumber: 3, title: "[CUI-9] Epic", state: "open" });
    assert.deepEqual(result.warnings, []);
  });

  it("leaves its frozen input untouched", () => {
    const milestones = Object.freeze([ghMilestone(5, "[CUI-9] B"), ghMilestone(3, "[YT-9] A")]);
    const snapshot = structuredClone(milestones);

    buildMilestoneIndex(milestones, PROJECT);

    assert.deepEqual(milestones, snapshot);
  });
});

describe("buildMilestoneIndex: project ids in titles (N1)", () => {
  it("matches the project's own ids and the legacy [YT-n] ids alike, keeping each title as listed", () => {
    const result = build(ghMilestone(3, "[CUI-9] New style"), ghMilestone(4, "[YT-10] Old style", "closed"));

    // The legacy title is kept, so the planner sees that it differs and renames it (N2).
    assert.deepEqual(
      [...result.index.entries()],
      [
        [9, { milestoneNumber: 3, title: "[CUI-9] New style", state: "open" }],
        [10, { milestoneNumber: 4, title: "[YT-10] Old style", state: "closed" }],
      ],
    );
    assert.deepEqual(result.warnings, []);
  });

  it("ignores the ids of other projects, including ones that start or end like the project", () => {
    const result = build(
      ghMilestone(1, "[ABC-3] Other project"),
      ghMilestone(2, "[CU-3] Shorter id"),
      ghMilestone(3, "[CUIX-3] Longer id"),
      ghMilestone(4, "[XCUI-3] Longer id"),
      ghMilestone(5, "[YTX-3] Not the legacy id"),
    );

    assert.equal(result.index.size, 0);
    assert.equal(result.byNumber.size, 0);
    assert.deepEqual(result.warnings, []);
  });

  it("compares the project ASCII-case-insensitively, but the legacy YT id exactly", () => {
    const result = build(
      ghMilestone(1, "[cui-5] Lower"),
      ghMilestone(2, "[Cui-6] Mixed"),
      ghMilestone(3, "[yt-7] Lower legacy"),
      ghMilestone(4, "[Yt-8] Mixed legacy"),
    );

    assert.deepEqual([...result.index.keys()], [5, 6]);
    assert.equal(result.index.get(5)?.title, "[cui-5] Lower");
  });

  it("matches the configured project, whatever its case, and no other", () => {
    const milestones = Object.freeze([
      ghMilestone(1, "[ABC-3] Ours"),
      ghMilestone(2, "[CUI-4] Theirs"),
      ghMilestone(3, "[YT-5] Old"),
    ]);

    const upper = buildMilestoneIndex(milestones, "ABC");
    const lower = buildMilestoneIndex(milestones, "abc");

    assert.deepEqual([...upper.index.keys()], [3, 5]);
    assert.deepEqual([...lower.index.keys()], [3, 5]);
  });

  it("counts a legacy and a new title for the same epic as duplicates, named after the project", () => {
    const result = build(ghMilestone(4, "[CUI-9] New"), ghMilestone(3, "[YT-9] Old"));

    assert.deepEqual(result.index.get(9), { milestoneNumber: 3, title: "[YT-9] Old", state: "open" });
    assert.deepEqual([...result.byNumber.entries()], [[3, 9]]);
    assert.deepEqual(result.warnings, ["CUI-9: 2 GitHub milestones match; using milestone #3, ignoring milestone #4"]);
  });

  it("names warnings after another configured project too", () => {
    const result = buildMilestoneIndex(
      Object.freeze([ghMilestone(1, "[abc-3] A"), ghMilestone(2, "[ABC-3] B")]),
      "ABC",
    );

    assert.deepEqual(result.warnings, ["ABC-3: 2 GitHub milestones match; using milestone #1, ignoring milestone #2"]);
  });
});

describe("buildMilestoneIndex: duplicates", () => {
  it("uses the lowest milestone number, whatever the list order, and warns about the other", () => {
    const result = build(ghMilestone(5, "[CUI-9] Later copy"), ghMilestone(3, "[CUI-9] First"));

    assert.deepEqual(result.index.get(9), { milestoneNumber: 3, title: "[CUI-9] First", state: "open" });
    assert.deepEqual(result.warnings, ["CUI-9: 2 GitHub milestones match; using milestone #3, ignoring milestone #5"]);
  });

  it("prefers the lowest number even when it is closed and the other is open", () => {
    const result = build(ghMilestone(5, "[CUI-9] Open"), ghMilestone(3, "[CUI-9] Closed", "closed"));

    assert.deepEqual(result.index.get(9), { milestoneNumber: 3, title: "[CUI-9] Closed", state: "closed" });
  });

  it("maps only the winner back to the epic; an ignored duplicate is not a mirror milestone", () => {
    const result = build(ghMilestone(5, "[CUI-9] B"), ghMilestone(3, "[CUI-9] A"));

    assert.deepEqual([...result.byNumber.entries()], [[3, 9]]);
  });

  it("adds one warning per extra milestone, in ascending milestone number", () => {
    const result = build(ghMilestone(30, "[CUI-9] C"), ghMilestone(4, "[CUI-9] A"), ghMilestone(21, "[CUI-9] B"));

    assert.equal(result.index.get(9)?.milestoneNumber, 4);
    assert.deepEqual(result.warnings, [
      "CUI-9: 3 GitHub milestones match; using milestone #4, ignoring milestone #21",
      "CUI-9: 3 GitHub milestones match; using milestone #4, ignoring milestone #30",
    ]);
  });

  it("compares milestone numbers numerically, not as text", () => {
    const result = build(ghMilestone(100, "[CUI-9] A"), ghMilestone(99, "[CUI-9] B"));

    assert.equal(result.index.get(9)?.milestoneNumber, 99);
    assert.deepEqual(result.warnings, [
      "CUI-9: 2 GitHub milestones match; using milestone #99, ignoring milestone #100",
    ]);
  });

  it("keeps duplicate groups of different epics apart and orders warnings by epic number", () => {
    const result = build(
      ghMilestone(8, "[CUI-10] B"),
      ghMilestone(6, "[CUI-9] B"),
      ghMilestone(7, "[CUI-10] A"),
      ghMilestone(2, "[CUI-9] A"),
      ghMilestone(1, "[CUI-4] Alone"),
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
      "CUI-9: 2 GitHub milestones match; using milestone #2, ignoring milestone #6",
      "CUI-10: 2 GitHub milestones match; using milestone #7, ignoring milestone #8",
    ]);
  });

  it("never puts milestone titles into warnings", () => {
    const result = build(ghMilestone(3, "[CUI-9] secret-title"), ghMilestone(4, "[YT-9] secret-title"));

    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings.every((warning) => !warning.includes("secret-title")));
  });
});
