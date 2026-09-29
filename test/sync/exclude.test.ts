/** runSync with the exclude filter (decisions F1-F3), end to end over the fake fetch. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatSummary, runSync } from "../../src/sync.ts";
import {
  config,
  ghIssue,
  ghMilestone,
  harness,
  isCreate,
  ISSUES_PATH,
  messages,
  MILESTONES_PATH,
  RESOLVED_AT,
  summary,
  titleOf,
  writeCalls,
  ytRow,
} from "./fixtures.ts";
import type { World } from "./fixtures.ts";

describe("runSync exclude prefix (F1, F2)", () => {
  it("mirrors every summary except those starting with the configured exclude prefix, ignoring case", async () => {
    // Arrange
    const { deps, calls } = harness({
      youtrackRows: [
        ytRow(1, { summary: "[OPS] Deploy" }),
        ytRow(2, { summary: "[individual] Not excluded here" }),
        ytRow(3, { summary: "ops: missing brackets" }),
        ytRow(4, { summary: "  [ops] leading spaces" }),
      ],
    });

    // Act
    const result = await runSync(config({ excludePrefix: "[ops]" }), deps);

    // Assert
    assert.deepEqual(calls.filter(isCreate).map(titleOf), [
      "[YT-2] [individual] Not excluded here",
      "[YT-3] ops: missing brackets",
    ]);
    assert.equal(result.filtered, 2);
    assert.equal(result.created, 2);
  });

  it("leaves the open mirror of an issue that gained the exclude prefix alone (F2)", async () => {
    // Arrange: YT-1 was mirrored as #12, then renamed to "[individual] ..." and resolved.
    const { deps, calls } = harness({
      githubIssues: [ghIssue(12, "[YT-1] [team] Task 1")],
      youtrackRows: [ytRow(1, { summary: "[individual] Task 1", resolved: RESOLVED_AT })],
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), []);
    assert.deepEqual(result, summary({ scanned: 1, filtered: 1, fetches: 3 }));
  });
});

/**
 * Inherited exclusion end to end (decisions F1-F3), shaped like CUI today:
 * YT-32 "[Individual] ..." epic, open milestone #7    -> filtered (F1)
 * YT-46 task under YT-32, mirror #30 of the wrong type -> filtered (F3), not updated (F2)
 * YT-47 resolved task under YT-32, open mirror #31     -> filtered (F3), not closed (F2)
 * YT-9 epic, no milestone                              -> createMilestone
 * YT-10 task under YT-9                                -> create, Task, milestone of YT-9
 * YT-15 task, mirror #21 without a type                -> update: type Task
 */
const INDIVIDUAL_WORLD: World = {
  milestones: [ghMilestone(7, "[YT-32] [Individual] Data Structures and Algorithms")],
  githubIssues: [
    ghIssue(21, "[YT-15] Plan the sprint"),
    ghIssue(30, "[YT-46] Implement a linked list", { type: "Feature" }),
    ghIssue(31, "[YT-47] Big-O exercises", { type: "Task" }),
  ],
  youtrackRows: [
    ytRow(9, { type: "Epic", summary: "Business Understanding" }),
    ytRow(10, { type: "Task", parent: 9, summary: "Write the proposal" }),
    ytRow(15, { type: "Task", summary: "Plan the sprint" }),
    ytRow(32, { type: "Epic", summary: "[Individual] Data Structures and Algorithms" }),
    ytRow(46, { type: "Task", parent: 32, summary: "Implement a linked list" }),
    ytRow(47, { type: "Task", parent: 32, summary: "Big-O exercises", resolved: RESOLVED_AT }),
  ],
};

const COUNTS = { scanned: 6, created: 1, updated: 1, milestonesCreated: 1, filtered: 3 } as const;

describe("runSync inherited exclusion (F3)", () => {
  it("previews nothing for an excluded epic or the tasks under it", async () => {
    // Arrange
    const { deps, lines, calls } = harness(INDIVIDUAL_WORLD);

    // Act
    const result = await runSync(config({ dryRun: true }), deps);

    // Assert
    assert.deepEqual(messages(lines), [
      "[dry-run] would create milestone YT-9: [YT-9] Business Understanding",
      "[dry-run] would create YT-10 with type Task, milestone YT-9 (new): [YT-10] Write the proposal",
      "[dry-run] would update YT-15 #21: set type Task",
      formatSummary(result, "ok"),
    ]);
    assert.deepEqual(result, summary({ ...COUNTS, dryRun: true, fetches: 3 }));
    assert.deepEqual(writeCalls(calls), []);
  });

  it("writes only for issues outside the excluded tree, leaving its milestone and mirrors alone", async () => {
    // Arrange
    const { deps, calls } = harness(INDIVIDUAL_WORLD);

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${MILESTONES_PATH}`, `POST ${ISSUES_PATH}`, `PATCH ${ISSUES_PATH}/21`]);
    assert.deepEqual(result, summary({ ...COUNTS, fetches: 6 }));
  });

  it("follows the configured exclude prefix down the hierarchy too", async () => {
    // Arrange: with "[solo]" excluded instead, the "[Individual]" tree is mirrored as usual.
    const { deps, lines } = harness({
      youtrackRows: [
        ytRow(1, { type: "Epic", summary: "[SOLO] Mine" }),
        ytRow(2, { type: "Task", parent: 1, summary: "Only mine" }),
        ytRow(3, { type: "Epic", summary: "[Individual] Shared now" }),
        ytRow(4, { type: "Task", parent: 3, summary: "Shared task" }),
      ],
    });

    // Act
    const result = await runSync(config({ dryRun: true, excludePrefix: "[solo]" }), deps);

    // Assert
    assert.deepEqual(messages(lines).slice(0, -1), [
      "[dry-run] would create milestone YT-3: [YT-3] [Individual] Shared now",
      "[dry-run] would create YT-4 with type Task, milestone YT-3 (new): [YT-4] Shared task",
    ]);
    assert.equal(result.filtered, 2);
  });
});
