import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MIRROR_LABEL } from "../src/github/client.ts";
import { formatSummary, runSync, SyncFailedError, WRITE_PAUSE_MS } from "../src/sync.ts";
import {
  bodyOf,
  config,
  createBodies,
  ghIssue,
  ghMilestone,
  harness,
  isCreate,
  ISSUES_PATH,
  issueId,
  json,
  messages,
  MILESTONES_PATH,
  rejection,
  summary,
  titleOf,
  writeCalls,
  YOUTRACK_BASE_URL,
  ytRow,
} from "./sync-harness.ts";
import type { Override } from "./sync-harness.ts";

const EPIC = ytRow(33, { type: "Epic", summary: "[team] Epic 33" });
const STORY = ytRow(35, { type: "User Story", summary: "[team] Story 35", parent: 33 });
const TASK = ytRow(40, { type: "Task", summary: "[team] Task 40", parent: 35 });

/** Fails the create of the issue whose mirror title starts with `prefix`, e.g. "[YT-35]". */
const failCreateOf =
  (prefix: string): Override =>
  (call) =>
    isCreate(call) && titleOf(call).startsWith(prefix) ? json(422, { message: "Validation Failed" }) : undefined;

const failMilestoneCreate: Override = (call) =>
  call.method === "POST" && call.url.pathname === MILESTONES_PATH
    ? json(422, { message: "Validation Failed" })
    : undefined;

describe("runSync hierarchy creates", () => {
  it("creates an epic's milestone, then its story and the story's task in one run", async () => {
    // Arrange
    const { deps, calls, lines } = harness({ youtrackRows: [EPIC, STORY, TASK] });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${MILESTONES_PATH}`, `POST ${ISSUES_PATH}`, `POST ${ISSUES_PATH}`]);
    assert.deepEqual(result, summary({ scanned: 3, created: 2, milestonesCreated: 1, fetches: 6 }));
    assert.deepEqual(messages(lines, "warn"), []);
    assert.deepEqual(messages(lines).slice(0, 3), [
      "create milestone YT-33 -> #201",
      "create YT-35 with type Feature, milestone YT-33 #201 -> #101",
      "create YT-40 with type Task, milestone YT-33 #201, parent YT-35 #101 -> #102",
    ]);
  });

  it("gives the milestone the epic's mirror title and body, and nothing else (H7, H10)", async () => {
    // Arrange
    const { deps, calls } = harness({ youtrackRows: [EPIC] });

    // Act
    await runSync(config(), deps);

    // Assert
    const milestone = bodyOf(calls.find((call) => call.method === "POST" && call.url.pathname === MILESTONES_PATH));
    assert.deepEqual(milestone, {
      title: "[YT-33] [team] Epic 33",
      description: `Details of task 33\n\n---\nMirrored from YouTrack: ${YOUTRACK_BASE_URL}/issue/CUI-33`,
    });
  });

  it("sends milestone, type and parent_issue_id with the create, from same-run creates", async () => {
    // Arrange
    const { deps, calls } = harness({ youtrackRows: [EPIC, STORY, TASK] });

    // Act
    await runSync(config(), deps);

    // Assert
    const [story, task] = createBodies(calls);
    assert.deepEqual(story, {
      title: "[YT-35] [team] Story 35",
      body: `Details of task 35\n\n---\nMirrored from YouTrack: ${YOUTRACK_BASE_URL}/issue/CUI-35`,
      labels: [MIRROR_LABEL],
      milestone: 201,
      type: "Feature",
    });
    assert.deepEqual(task, {
      title: "[YT-40] [team] Task 40",
      body: `Details of task 40\n\n---\nMirrored from YouTrack: ${YOUTRACK_BASE_URL}/issue/CUI-40`,
      labels: [MIRROR_LABEL],
      milestone: 201,
      type: "Task",
      parent_issue_id: issueId(101),
    });
  });

  it("takes an existing milestone number and parent id from the reads", async () => {
    // Arrange
    const { deps, calls } = harness({
      milestones: [ghMilestone(7, "[YT-33] [team] Epic 33")],
      githubIssues: [ghIssue(21, "[YT-35] [team] Story 35", { type: "Feature", milestone: 7 })],
      youtrackRows: [EPIC, STORY, TASK],
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`]);
    const [task] = createBodies(calls);
    assert.equal(task?.["milestone"], 7);
    assert.equal(task["parent_issue_id"], issueId(21));
    assert.deepEqual(result, summary({ scanned: 3, created: 1, unchanged: 2, fetches: 4 }));
  });

  it("sends no type for an issue without a known YouTrack type (D3)", async () => {
    // Arrange
    const { deps, calls } = harness({ youtrackRows: [ytRow(1, { type: "Spike" })] });

    // Act
    await runSync(config(), deps);

    // Assert
    const [create] = createBodies(calls);
    assert.deepEqual(Object.keys(create ?? {}), ["title", "body", "labels"]);
  });

  it("warns once, with no extra write, when GitHub drops milestone, type and parent on create", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      milestones: [ghMilestone(7, "[YT-33] [team] Epic 33")],
      githubIssues: [ghIssue(21, "[YT-35] [team] Story 35", { type: "Feature", milestone: 7 })],
      youtrackRows: [EPIC, STORY, TASK],
      createDrops: ["milestone", "type", "parent_issue_id"],
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`]);
    assert.deepEqual(messages(lines, "warn"), [
      "YT-40 #101: GitHub dropped milestone #7, type Task, parent #21 on create; the next run's sync repairs this",
    ]);
    assert.equal(result.created, 1);
    assert.equal(result.failed, 0);
  });
});

describe("runSync hierarchy creates that wait for a failed one (D4)", () => {
  it("caps a task, not fails it, when its parent's create fails, and runs the rest", async () => {
    // Arrange: creates run YT-35, YT-50 (issues), then YT-40 (task).
    const { deps, calls, lines } = harness({
      youtrackRows: [ytRow(35, { type: "User Story" }), TASK, ytRow(50)],
      override: failCreateOf("[YT-35]"),
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(calls.filter(isCreate).map(titleOf), ["[YT-35] [team] Task 35", "[YT-50] [team] Task 50"]);
    assert.equal(error.failures.length, 1);
    assert.match(error.failures[0] ?? "", /^create YT-35 failed: POST .* -> HTTP 422/);
    assert.deepEqual(error.summary, summary({ scanned: 3, created: 1, capped: 1, failed: 1, fetches: 5 }));
    assert.deepEqual(messages(lines, "warn"), ["create YT-40 capped: the mirror of YT-35 was not created in this run"]);
  });

  it("caps the epic's story and the story's task when the milestone create fails", async () => {
    // Arrange
    const { deps, calls, lines } = harness({ youtrackRows: [EPIC, STORY, TASK], override: failMilestoneCreate });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(writeCalls(calls), [`POST ${MILESTONES_PATH}`]);
    assert.match(error.failures[0] ?? "", /^create milestone YT-33 failed: POST .*\/milestones -> HTTP 422/);
    assert.deepEqual(error.summary, summary({ scanned: 3, capped: 2, failed: 1, fetches: 4 }));
    assert.deepEqual(messages(lines, "warn"), [
      "create YT-35 capped: the milestone of YT-33 was not created in this run",
      "create YT-40 capped: the milestone of YT-33 was not created in this run",
    ]);
  });

  it("never retries a milestone create that failed on the network", async () => {
    // Arrange
    const { deps, calls } = harness({
      youtrackRows: [EPIC],
      override: (call) =>
        call.method === "POST" && call.url.pathname === MILESTONES_PATH ? new TypeError("fetch failed") : undefined,
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.equal(writeCalls(calls).length, 1);
    assert.match(error.failures[0] ?? "", /^create milestone YT-33 failed: POST .* failed: fetch failed/);
  });

  it("stops on a rate-limited milestone create; what waits for it is capped by the stop", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      youtrackRows: [EPIC, STORY, TASK],
      override: (call) =>
        call.method === "POST" && call.url.pathname === MILESTONES_PATH
          ? json(403, { message: "You have exceeded a secondary rate limit." }, { "retry-after": "60" })
          : undefined,
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(writeCalls(calls), [`POST ${MILESTONES_PATH}`]);
    assert.deepEqual(error.summary, summary({ scanned: 3, capped: 2, failed: 1, fetches: 4 }));
    assert.deepEqual(messages(lines, "warn"), ["GitHub rate limit hit; 2 more action(s) capped"]);
  });

  it("does not start a task create after the run deadline, even though its parent was created", async () => {
    // Arrange: the milestone and story creates start at 0 (the story's write is sent at 1 s,
    // after the pause); the task would start at 1 s.
    const { deps, calls, lines } = harness({ youtrackRows: [EPIC, STORY, TASK], deadline: WRITE_PAUSE_MS });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${MILESTONES_PATH}`, `POST ${ISSUES_PATH}`]);
    assert.deepEqual(result, summary({ scanned: 3, created: 1, milestonesCreated: 1, capped: 1, fetches: 5 }));
    assert.deepEqual(messages(lines, "warn"), ["run deadline reached; 1 more action(s) capped"]);
  });
});

describe("runSync plan warnings", () => {
  it("logs milestone duplicates and YouTrack parent cycles, numbers only", async () => {
    // Arrange
    const { deps, lines } = harness({
      milestones: [ghMilestone(8, "[YT-33] [team] Epic 33"), ghMilestone(7, "[YT-33] copy")],
      youtrackRows: [EPIC, ytRow(60, { parent: 61, summary: "[team] secret 60" }), ytRow(61, { parent: 60 })],
    });

    // Act
    const result = await runSync(config({ dryRun: true }), deps);

    // Assert
    assert.deepEqual(messages(lines, "warn"), [
      "YT-33: 2 GitHub milestones match; using milestone #7, ignoring milestone #8",
      "YT-61: parent chain loops back to YT-60",
    ]);
    assert.ok(!messages(lines, "warn").some((line) => line.includes("secret")));
    assert.equal(messages(lines).at(-1), formatSummary(result, "ok"));
  });
});
