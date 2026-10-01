import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runSync, SyncFailedError } from "../../src/sync.ts";
import {
  config,
  ghIssue,
  ghMilestone,
  harness,
  ISSUES_PATH,
  issueId,
  json,
  messages,
  MILESTONES_PATH,
  onlyBody,
  rejection,
  RESOLVED_AT,
  summary,
  writeCalls,
  ytRow,
} from "./fixtures.ts";
import type { World } from "./fixtures.ts";

const EPIC = ytRow(33, { type: "Epic", summary: "[team] Epic 33" });
const MILESTONE_7 = ghMilestone(7, "[CUI-33] [team] Epic 33");
const story = (n: number, parent?: number): ReturnType<typeof ytRow> =>
  ytRow(n, { type: "User Story", ...(parent === undefined ? {} : { parent }) });

/** Stories CUI-35 (#21) and CUI-36 (#22); task CUI-40 (#25) sits under #21 but belongs under CUI-36. */
const REPARENT: World = {
  githubIssues: [
    ghIssue(21, "[CUI-35] [team] Task 35", { type: "Feature" }),
    ghIssue(22, "[CUI-36] [team] Task 36", { type: "Feature" }),
    ghIssue(25, "[CUI-40] [team] Task 40", { type: "Task", parent: 21 }),
  ],
  youtrackRows: [story(35), story(36), ytRow(40, { type: "Task", parent: 36 })],
};

const exhausted = { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790276472" };

describe("runSync hierarchy sync: parents", () => {
  it("moves a task mirror under its new parent's mirror with replace_parent", async () => {
    // Arrange
    const { deps, calls, lines } = harness(REPARENT);

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}/22/sub_issues`]);
    assert.deepEqual(onlyBody(calls, "POST", `${ISSUES_PATH}/22/sub_issues`), {
      sub_issue_id: issueId(25),
      replace_parent: true,
    });
    assert.deepEqual(result, summary({ scanned: 3, updated: 1, unchanged: 2, fetches: 4 }));
    assert.ok(messages(lines).includes("move CUI-40 #25 under CUI-36 #22"));
  });

  it("moves a task under a parent created earlier in the same run", async () => {
    // Arrange
    const { deps, calls } = harness({
      githubIssues: [ghIssue(25, "[CUI-40] [team] Task 40", { type: "Task" })],
      youtrackRows: [story(36), ytRow(40, { type: "Task", parent: 36 })],
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`, `POST ${ISSUES_PATH}/101/sub_issues`]);
    assert.deepEqual(onlyBody(calls, "POST", `${ISSUES_PATH}/101/sub_issues`), {
      sub_issue_id: issueId(25),
      replace_parent: true,
    });
    assert.deepEqual(result, summary({ scanned: 2, created: 1, updated: 1, fetches: 5 }));
  });

  it("caps the move, not fails it, when the new parent's create fails", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      githubIssues: [ghIssue(25, "[CUI-40] [team] Task 40", { type: "Task" })],
      youtrackRows: [story(36), ytRow(40, { type: "Task", parent: 36 })],
      override: (call) => (call.method === "POST" && call.url.pathname === ISSUES_PATH ? json(422, {}) : undefined),
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`]);
    assert.deepEqual(error.summary, summary({ scanned: 2, capped: 1, failed: 1, fetches: 4 }));
    assert.deepEqual(messages(lines, "warn"), [
      "move CUI-40 #25 capped: the mirror of CUI-36 was not created in this run",
    ]);
  });

  it("detaches a task mirror from a mirror parent it no longer has in YouTrack", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      githubIssues: [
        ghIssue(21, "[CUI-35] [team] Task 35", { type: "Feature" }),
        ghIssue(25, "[CUI-40] [team] Task 40", { type: "Task", parent: 21 }),
      ],
      youtrackRows: [story(35), ytRow(40, { type: "Task" })],
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`DELETE ${ISSUES_PATH}/21/sub_issue`]);
    assert.deepEqual(onlyBody(calls, "DELETE", `${ISSUES_PATH}/21/sub_issue`), { sub_issue_id: issueId(25) });
    assert.deepEqual(result, summary({ scanned: 2, updated: 1, unchanged: 1, fetches: 4 }));
    assert.ok(messages(lines).includes("detach CUI-40 #25 from parent CUI-35 #21"));
  });

  it("leaves a parent that is not a mirror alone (D2)", async () => {
    // Arrange: #90 is a hand-made issue.
    const { deps, calls } = harness({
      githubIssues: [ghIssue(25, "[CUI-40] [team] Task 40", { type: "Task", parent: 90 })],
      youtrackRows: [ytRow(40, { type: "Task" })],
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), []);
    assert.equal(result.unchanged, 1);
  });

  it("records a failed move, still runs the next action, and fails the run", async () => {
    // Arrange: plus the open mirror #50 of resolved CUI-50, closed after the move.
    const { deps, calls } = harness({
      ...REPARENT,
      githubIssues: [...(REPARENT.githubIssues ?? []), ghIssue(50, "[CUI-50] [team] Task 50")],
      youtrackRows: [...(REPARENT.youtrackRows ?? []), ytRow(50, { resolved: RESOLVED_AT })],
      override: (call) =>
        call.url.pathname.endsWith("/sub_issues") ? json(422, { message: "Validation Failed" }) : undefined,
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.match(error.failures[0] ?? "", /^move CUI-40 #25 under CUI-36 #22 failed: POST .*\/sub_issues -> HTTP 422/);
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}/22/sub_issues`, `PATCH ${ISSUES_PATH}/50`]);
    assert.equal(error.summary.closed, 1);
    assert.equal(error.summary.updated, 0);
  });

  it("stops after a rate-limited detach and caps the rest", async () => {
    // Arrange: the detach of CUI-40 runs before the close of #50.
    const { deps, calls, lines } = harness({
      githubIssues: [
        ghIssue(21, "[CUI-35] [team] Task 35", { type: "Feature" }),
        ghIssue(25, "[CUI-40] [team] Task 40", { type: "Task", parent: 21 }),
        ghIssue(50, "[CUI-50] [team] Task 50"),
      ],
      youtrackRows: [story(35), ytRow(40, { type: "Task" }), ytRow(50, { resolved: RESOLVED_AT })],
      override: (call) =>
        call.method === "DELETE" ? json(429, { message: "API rate limit exceeded" }, exhausted) : undefined,
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(writeCalls(calls), [`DELETE ${ISSUES_PATH}/21/sub_issue`]);
    assert.match(error.failures[0] ?? "", /^detach CUI-40 #25 from parent CUI-35 #21 failed: DELETE .* -> HTTP 429/);
    assert.deepEqual(error.summary, summary({ scanned: 3, unchanged: 1, capped: 1, failed: 1, fetches: 4 }));
    assert.deepEqual(messages(lines, "warn"), ["GitHub rate limit hit; 1 more action(s) capped"]);
  });
});

describe("runSync hierarchy sync: milestones and types", () => {
  it("closes the open milestone of a resolved epic", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      milestones: [MILESTONE_7],
      youtrackRows: [ytRow(33, { type: "Epic", summary: "[team] Epic 33", resolved: RESOLVED_AT })],
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`PATCH ${MILESTONES_PATH}/7`]);
    assert.deepEqual(onlyBody(calls, "PATCH", `${MILESTONES_PATH}/7`), { state: "closed" });
    assert.deepEqual(result, summary({ scanned: 1, milestonesClosed: 1, fetches: 4 }));
    assert.ok(messages(lines).includes("close milestone CUI-33 #7"));
  });

  it("retries a milestone close once after a 5xx", async () => {
    // Arrange
    const { deps, calls } = harness({
      milestones: [MILESTONE_7],
      youtrackRows: [ytRow(33, { type: "Epic", summary: "[team] Epic 33", resolved: RESOLVED_AT })],
      override: (call, attempt) => (call.method === "PATCH" && attempt === 0 ? json(502, {}) : undefined),
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.equal(writeCalls(calls).length, 2);
    assert.equal(result.milestonesClosed, 1);
    assert.equal(result.failed, 0);
  });

  it("sets milestone and type on a closed mirror too, without reopening it (D8)", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      milestones: [MILESTONE_7],
      githubIssues: [ghIssue(21, "[CUI-35] [team] Task 35", { state: "closed" })],
      youtrackRows: [EPIC, ytRow(35, { type: "User Story", parent: 33, resolved: RESOLVED_AT })],
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/21`]);
    assert.deepEqual(onlyBody(calls, "PATCH", `${ISSUES_PATH}/21`), { milestone: 7, type: "Feature" });
    assert.deepEqual(result, summary({ scanned: 2, updated: 1, unchanged: 1, fetches: 4 }));
    assert.ok(messages(lines).includes("update CUI-35 #21: set milestone CUI-33 #7, set type Feature"));
  });

  it("clears a mirror milestone when the issue left its epic", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      milestones: [MILESTONE_7],
      githubIssues: [ghIssue(21, "[CUI-35] [team] Task 35", { type: "Feature", milestone: 7 })],
      youtrackRows: [EPIC, story(35)],
    });

    // Act
    await runSync(config(), deps);

    // Assert
    assert.deepEqual(onlyBody(calls, "PATCH", `${ISSUES_PATH}/21`), { milestone: null });
    assert.ok(messages(lines).includes("update CUI-35 #21: clear milestone"));
    assert.deepEqual(messages(lines, "warn"), []);
  });

  it("sets a milestone created earlier in the same run", async () => {
    // Arrange
    const { deps, calls } = harness({
      githubIssues: [ghIssue(21, "[CUI-35] [team] Task 35", { type: "Feature" })],
      youtrackRows: [EPIC, story(35, 33)],
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${MILESTONES_PATH}`, `PATCH ${ISSUES_PATH}/21`]);
    assert.deepEqual(onlyBody(calls, "PATCH", `${ISSUES_PATH}/21`), { milestone: 201 });
    assert.deepEqual(result, summary({ scanned: 2, milestonesCreated: 1, updated: 1, fetches: 5 }));
  });

  it("caps the update, not fails it, when that milestone's create fails", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      githubIssues: [ghIssue(21, "[CUI-35] [team] Task 35", { type: "Feature" })],
      youtrackRows: [EPIC, story(35, 33)],
      override: (call) => (call.method === "POST" ? json(422, { message: "Validation Failed" }) : undefined),
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(writeCalls(calls), [`POST ${MILESTONES_PATH}`]);
    assert.deepEqual(error.summary, summary({ scanned: 2, capped: 1, failed: 1, fetches: 4 }));
    assert.deepEqual(messages(lines, "warn"), [
      "update CUI-35 #21 capped: the milestone of CUI-33 was not created in this run",
    ]);
  });

  it("runs a mirror's update, move and close in phase order", async () => {
    // Arrange: resolved task CUI-40 (#25, open, untyped, top-level) belongs under CUI-36 (#22).
    const { deps, calls } = harness({
      githubIssues: [
        ghIssue(22, "[CUI-36] [team] Task 36", { type: "Feature" }),
        ghIssue(25, "[CUI-40] [team] Task 40"),
      ],
      youtrackRows: [story(36), ytRow(40, { type: "Task", parent: 36, resolved: RESOLVED_AT })],
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [
      `PATCH ${ISSUES_PATH}/25`,
      `POST ${ISSUES_PATH}/22/sub_issues`,
      `PATCH ${ISSUES_PATH}/25`,
    ]);
    assert.deepEqual(result, summary({ scanned: 2, updated: 2, closed: 1, unchanged: 1, fetches: 6 }));
  });

  it("warns when GitHub answers an update without the change, and still counts it", async () => {
    // Arrange: the PATCH answer carries neither the milestone nor the type.
    const { deps, calls, lines } = harness({
      milestones: [MILESTONE_7],
      githubIssues: [ghIssue(21, "[CUI-35] [team] Task 35")],
      youtrackRows: [EPIC, story(35, 33)],
      override: (call) => (call.method === "PATCH" ? json(200, ghIssue(21, "[CUI-35] [team] Task 35")) : undefined),
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert: no second write; the next run's plan sees the difference again.
    assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/21`]);
    assert.equal(result.updated, 1);
    assert.deepEqual(messages(lines, "warn"), [
      "CUI-35 #21: GitHub dropped milestone #7, type Feature on update; the next run tries again",
    ]);
  });

  it("warns when GitHub answers a milestone clear with the milestone still set", async () => {
    // Arrange
    const mirror = ghIssue(21, "[CUI-35] [team] Task 35", { type: "Feature", milestone: 7 });
    const { deps, lines } = harness({
      milestones: [MILESTONE_7],
      githubIssues: [mirror],
      youtrackRows: [EPIC, story(35)],
      override: (call) => (call.method === "PATCH" ? json(200, mirror) : undefined),
    });

    // Act
    await runSync(config(), deps);

    // Assert
    assert.deepEqual(messages(lines, "warn"), [
      "CUI-35 #21: GitHub dropped the milestone removal on update; the next run tries again",
    ]);
  });

  it("retries a failed update once (it is idempotent)", async () => {
    // Arrange
    const { deps, calls } = harness({
      githubIssues: [ghIssue(21, "[CUI-35] [team] Task 35")],
      youtrackRows: [story(35)],
      override: (call, attempt) => (call.method === "PATCH" && attempt === 0 ? json(503, {}) : undefined),
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/21`, `PATCH ${ISSUES_PATH}/21`]);
    assert.equal(result.updated, 1);
    assert.equal(result.failed, 0);
  });
});
