import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runSync, SyncFailedError, WRITE_PAUSE_MS } from "../src/sync.ts";
import {
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
  onlyBody,
  rejection,
  RESOLVED_AT,
  summary,
  titleOf,
  writeCalls,
  ytRow,
} from "./sync-harness.ts";
import type { Override, RecordedCall } from "./sync-harness.ts";

const EPIC = ytRow(33, { type: "Epic", summary: "[team] Epic 33" });
const STORY = ytRow(35, { type: "User Story" });
/** A task under the story, and a sub-task under that task with a LOWER number (created after it by depth). */
const TASK = ytRow(40, { type: "Task", parent: 35 });
const SUB_TASK = ytRow(38, { type: "Task", parent: 40 });

/** A fresh 422 each time (a Response body can be read only once). */
const unprocessable = (): Response => json(422, { message: "Validation Failed" });

/** Fails the create of the issue whose mirror title starts with `prefix`, e.g. "[YT-35]". */
const failCreateOf =
  (prefix: string): Override =>
  (call) =>
    isCreate(call) && titleOf(call).startsWith(prefix) ? unprocessable() : undefined;

const isMilestoneCreate = (call: RecordedCall): boolean =>
  call.method === "POST" && call.url.pathname === MILESTONES_PATH;

describe("runSync hierarchy creates across several task levels", () => {
  it("creates a sub-task after its parent task, with the id of that same-run create", async () => {
    // Arrange
    const { deps, calls, lines } = harness({ youtrackRows: [STORY, TASK, SUB_TASK] });

    // Act
    const result = await runSync(config(), deps);

    // Assert: YT-35 -> #101, YT-40 -> #102, YT-38 -> #103.
    const bodies = createBodies(calls);
    assert.deepEqual(calls.filter(isCreate).map(titleOf), [
      "[YT-35] [team] Task 35",
      "[YT-40] [team] Task 40",
      "[YT-38] [team] Task 38",
    ]);
    assert.ok(!("parent_issue_id" in (bodies[0] ?? {})));
    assert.equal(bodies[1]?.["parent_issue_id"], issueId(101));
    assert.equal(bodies[2]?.["parent_issue_id"], issueId(102));
    assert.deepEqual(result, summary({ scanned: 3, created: 3, fetches: 6 }));
    assert.deepEqual(messages(lines).slice(0, 3), [
      "create YT-35 with type Feature -> #101",
      "create YT-40 with type Task, parent YT-35 #101 -> #102",
      "create YT-38 with type Task, parent YT-40 #102 -> #103",
    ]);
    assert.deepEqual(messages(lines, "warn"), []);
  });

  it("previews the same creates in dry run, naming each same-run parent (new)", async () => {
    // Arrange
    const { deps, calls, lines } = harness({ youtrackRows: [STORY, TASK, SUB_TASK] });

    // Act
    await runSync(config({ dryRun: true }), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), []);
    assert.deepEqual(messages(lines).slice(0, 3), [
      "[dry-run] would create YT-35 with type Feature: [YT-35] [team] Task 35",
      "[dry-run] would create YT-40 with type Task, parent YT-35 (new): [YT-40] [team] Task 40",
      "[dry-run] would create YT-38 with type Task, parent YT-40 (new): [YT-38] [team] Task 38",
    ]);
  });

  it("caps every waiting level below a failed create, not fails it, and still runs the unrelated create", async () => {
    // Arrange: creates run YT-35, YT-50 (issues), then YT-40, YT-38 (tasks by depth).
    const { deps, calls, lines } = harness({
      youtrackRows: [STORY, TASK, SUB_TASK, ytRow(50)],
      override: failCreateOf("[YT-35]"),
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(calls.filter(isCreate).map(titleOf), ["[YT-35] [team] Task 35", "[YT-50] [team] Task 50"]);
    assert.equal(error.failures.length, 1);
    assert.deepEqual(error.summary, summary({ scanned: 4, created: 1, capped: 2, failed: 1, fetches: 5 }));
    assert.deepEqual(messages(lines, "warn"), [
      "create YT-40 capped: the mirror of YT-35 was not created in this run",
      "create YT-38 capped: the mirror of YT-40 was not created in this run",
    ]);
  });
});

describe("runSync hierarchy ids and numbers", () => {
  it("sends the REST ids GitHub reported, never ids derived from issue numbers", async () => {
    // Arrange: ids unrelated to the numbers, from the list and from both create answers.
    const answers: Override = (call) => {
      if (!isCreate(call)) return undefined;
      if (titleOf(call).startsWith("[YT-35]")) {
        return json(201, { ...ghIssue(150, "[YT-35] [team] Task 35", { type: "Feature" }), id: 555 });
      }
      return json(201, { ...ghIssue(151, "[YT-40] [team] Task 40", { type: "Task", parent: 150 }), id: 556 });
    };
    const { deps, calls, lines } = harness({
      githubIssues: [
        { ...ghIssue(22, "[YT-36] [team] Task 36", { type: "Feature" }), id: 888 },
        { ...ghIssue(25, "[YT-41] [team] Task 41", { type: "Task" }), id: 777 },
        { ...ghIssue(26, "[YT-42] [team] Task 42", { type: "Task", parent: 22 }), id: 666 },
      ],
      youtrackRows: [
        STORY,
        ytRow(36, { type: "User Story" }),
        TASK,
        ytRow(41, { type: "Task", parent: 36 }),
        ytRow(42, { type: "Task" }),
      ],
      override: answers,
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert: the parent is named by its number in the URL, the child by its id in the body.
    assert.equal(createBodies(calls)[1]?.["parent_issue_id"], 555);
    assert.deepEqual(onlyBody(calls, "POST", `${ISSUES_PATH}/22/sub_issues`), {
      sub_issue_id: 777,
      replace_parent: true,
    });
    assert.deepEqual(onlyBody(calls, "DELETE", `${ISSUES_PATH}/22/sub_issue`), { sub_issue_id: 666 });
    assert.deepEqual(result, summary({ scanned: 5, created: 2, updated: 2, unchanged: 1, fetches: 7 }));
    assert.deepEqual(messages(lines, "warn"), []);
  });
});

describe("runSync hierarchy dependencies that do not resolve (D4)", () => {
  it("caps the updates waiting for a failed milestone create but still moves the task", async () => {
    // Arrange: story #22 and task #25 both belong in the milestone of new epic YT-33; the
    // task also belongs under #22.
    const { deps, calls, lines } = harness({
      githubIssues: [
        ghIssue(22, "[YT-36] [team] Task 36", { type: "Feature" }),
        ghIssue(25, "[YT-40] [team] Task 40", { type: "Task" }),
      ],
      youtrackRows: [EPIC, ytRow(36, { type: "User Story", parent: 33 }), ytRow(40, { type: "Task", parent: 36 })],
      override: (call) => (isMilestoneCreate(call) ? unprocessable() : undefined),
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(writeCalls(calls), [`POST ${MILESTONES_PATH}`, `POST ${ISSUES_PATH}/22/sub_issues`]);
    assert.deepEqual(onlyBody(calls, "POST", `${ISSUES_PATH}/22/sub_issues`), {
      sub_issue_id: issueId(25),
      replace_parent: true,
    });
    assert.deepEqual(error.summary, summary({ scanned: 3, updated: 1, capped: 2, failed: 1, fetches: 5 }));
    assert.deepEqual(messages(lines, "warn"), [
      "update YT-36 #22 capped: the milestone of YT-33 was not created in this run",
      "update YT-40 #25 capped: the milestone of YT-33 was not created in this run",
    ]);
  });

  it("fails a milestone create answered 201 with a body that is not a milestone, and caps what waits", async () => {
    // Arrange
    const { deps, calls } = harness({
      youtrackRows: [EPIC, ytRow(35, { type: "User Story", parent: 33 })],
      override: (call) =>
        isMilestoneCreate(call) ? json(201, { number: 5, title: "[YT-33] x", state: "gone" }) : undefined,
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert: the milestone may exist; the next run finds it by title.
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(writeCalls(calls), [`POST ${MILESTONES_PATH}`]);
    assert.match(error.failures[0] ?? "", /^create milestone YT-33 failed: GitHub milestone #5: "state" must be/);
    assert.deepEqual(error.summary, summary({ scanned: 2, capped: 1, failed: 1, fetches: 4 }));
  });

  it("fails an issue create answered 201 without an id, and caps the task that waits for it", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      youtrackRows: [STORY, TASK],
      override: (call) =>
        isCreate(call) ? json(201, { number: 101, title: "[YT-35] x", state: "open", labels: [] }) : undefined,
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`]);
    assert.match(error.failures[0] ?? "", /^create YT-35 failed: GitHub issue #101: "id" must be a positive integer/);
    assert.deepEqual(error.summary, summary({ scanned: 2, capped: 1, failed: 1, fetches: 4 }));
    assert.deepEqual(messages(lines, "warn"), ["create YT-40 capped: the mirror of YT-35 was not created in this run"]);
  });
});

describe("runSync hierarchy write failures", () => {
  it("records a failed update without retrying a 422, still runs the next action, and fails the run", async () => {
    // Arrange: #21 needs its type (update); #50 is the open mirror of resolved YT-50 (close).
    const { deps, calls } = harness({
      githubIssues: [ghIssue(21, "[YT-35] [team] Task 35"), ghIssue(50, "[YT-50] [team] Task 50")],
      youtrackRows: [STORY, ytRow(50, { resolved: RESOLVED_AT })],
      override: (call) =>
        call.method === "PATCH" && call.url.pathname === `${ISSUES_PATH}/21` ? unprocessable() : undefined,
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/21`, `PATCH ${ISSUES_PATH}/50`]);
    assert.match(error.failures[0] ?? "", /^update YT-35 #21 failed: PATCH .*\/issues\/21 -> HTTP 422/);
    assert.deepEqual(error.summary, summary({ scanned: 2, closed: 1, failed: 1, fetches: 5 }));
  });

  it("stops after a rate-limited milestone close and caps the rest", async () => {
    // Arrange
    const exhausted = { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790276472" };
    const { deps, calls, lines } = harness({
      milestones: [ghMilestone(7, "[YT-33] [team] Epic 33"), ghMilestone(8, "[YT-34] [team] Epic 34")],
      youtrackRows: [
        ytRow(33, { type: "Epic", summary: "[team] Epic 33", resolved: RESOLVED_AT }),
        ytRow(34, { type: "Epic", summary: "[team] Epic 34", resolved: RESOLVED_AT }),
      ],
      override: (call) =>
        call.method === "PATCH" && call.url.pathname === `${MILESTONES_PATH}/7`
          ? json(429, { message: "API rate limit exceeded" }, exhausted)
          : undefined,
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(writeCalls(calls), [`PATCH ${MILESTONES_PATH}/7`]);
    assert.match(error.failures[0] ?? "", /^close milestone YT-33 #7 failed: PATCH .* -> HTTP 429/);
    assert.deepEqual(error.summary, summary({ scanned: 2, capped: 1, failed: 1, fetches: 4 }));
    assert.deepEqual(messages(lines, "warn"), ["GitHub rate limit hit; 1 more action(s) capped"]);
  });
});

describe("runSync hierarchy silent drops", () => {
  const PARENT_21 = ghIssue(21, "[YT-35] [team] Task 35", { type: "Feature" });

  it("re-adds a dropped label and only warns about a dropped parent on the same create", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      githubIssues: [PARENT_21],
      youtrackRows: [STORY, TASK],
      createdLabels: [],
      createDrops: ["parent_issue_id"],
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`, `POST ${ISSUES_PATH}/101/labels`]);
    assert.deepEqual(result, summary({ scanned: 2, created: 1, unchanged: 1, labelsReAdded: 1, fetches: 5 }));
    assert.deepEqual(messages(lines).slice(0, 3), [
      "create YT-40 with type Task, parent YT-35 #21 -> #101",
      "YT-40 #101: GitHub dropped parent #21 on create; the next run's sync repairs this",
      "label YT-40 #101",
    ]);
  });

  it("repairs the dropped parent on the next run with one move", async () => {
    // Arrange: the second run lists #101 as the first run's create left it (no parent).
    const { deps, calls } = harness({
      githubIssues: [PARENT_21, ghIssue(101, "[YT-40] [team] Task 40", { type: "Task" })],
      youtrackRows: [STORY, TASK],
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}/21/sub_issues`]);
    assert.deepEqual(onlyBody(calls, "POST", `${ISSUES_PATH}/21/sub_issues`), {
      sub_issue_id: issueId(101),
      replace_parent: true,
    });
    assert.deepEqual(result, summary({ scanned: 2, updated: 1, unchanged: 1, fetches: 4 }));
  });
});

describe("runSync hierarchy never touches what the mirror does not own", () => {
  it("leaves a hand-made milestone, a closed epic milestone and its title alone (D2, D7)", async () => {
    // Arrange: "Sprint 1" is hand-made; milestone #7 of unresolved epic YT-33 is closed and
    // titled differently from what formatMirror would give it now.
    const { deps, calls } = harness({
      milestones: [ghMilestone(9, "Sprint 1"), ghMilestone(7, "[YT-33] old title", "closed")],
      githubIssues: [ghIssue(21, "[YT-35] [team] Task 35", { type: "Feature", milestone: 9 })],
      youtrackRows: [EPIC, STORY],
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), []);
    assert.deepEqual(result, summary({ scanned: 2, unchanged: 2, fetches: 3 }));
  });
});

describe("runSync hierarchy pacing and retries", () => {
  it("pauses between real writes only: not before the first, nor for an action that waits", async () => {
    // Arrange: the milestone create fails, the story and task creates wait for it, #50 is closed.
    const { deps, calls, sleeps } = harness({
      githubIssues: [ghIssue(50, "[YT-50] [team] Task 50")],
      youtrackRows: [EPIC, ytRow(35, { type: "User Story", parent: 33 }), TASK, ytRow(50, { resolved: RESOLVED_AT })],
      override: (call) => (isMilestoneCreate(call) ? unprocessable() : undefined),
    });

    // Act
    await rejection(runSync(config(), deps));

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${MILESTONES_PATH}`, `PATCH ${ISSUES_PATH}/50`]);
    assert.deepEqual(sleeps, [WRITE_PAUSE_MS]);
  });

  it("retries a sub-issue move and a detach once after a 5xx (both idempotent)", async () => {
    // Arrange: YT-41 (#25) moves under YT-36 (#22); YT-42 (#26) leaves #22.
    const { deps, calls } = harness({
      githubIssues: [
        ghIssue(22, "[YT-36] [team] Task 36", { type: "Feature" }),
        ghIssue(25, "[YT-41] [team] Task 41", { type: "Task" }),
        ghIssue(26, "[YT-42] [team] Task 42", { type: "Task", parent: 22 }),
      ],
      youtrackRows: [
        ytRow(36, { type: "User Story" }),
        ytRow(41, { type: "Task", parent: 36 }),
        ytRow(42, { type: "Task" }),
      ],
      override: (call, attempt) => (call.method !== "GET" && attempt === 0 ? json(502, {}) : undefined),
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [
      `POST ${ISSUES_PATH}/22/sub_issues`,
      `POST ${ISSUES_PATH}/22/sub_issues`,
      `DELETE ${ISSUES_PATH}/22/sub_issue`,
      `DELETE ${ISSUES_PATH}/22/sub_issue`,
    ]);
    assert.deepEqual(result, summary({ scanned: 3, updated: 2, unchanged: 1, fetches: 7 }));
  });

  it("never retries a milestone create answered with a 5xx", async () => {
    // Arrange
    const { deps, calls } = harness({
      youtrackRows: [EPIC],
      override: (call) => (isMilestoneCreate(call) ? json(502, { message: "Bad Gateway" }) : undefined),
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(writeCalls(calls), [`POST ${MILESTONES_PATH}`]);
    assert.match(error.failures[0] ?? "", /^create milestone YT-33 failed: POST .* -> HTTP 502/);
  });
});
