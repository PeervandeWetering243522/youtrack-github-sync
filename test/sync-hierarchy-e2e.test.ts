import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatSummary, runSync } from "../src/sync.ts";
import {
  config,
  createBodies,
  ghIssue,
  ghMilestone,
  harness,
  ISSUES_PATH,
  issueId,
  messages,
  MILESTONES_PATH,
  onlyBody,
  RESOLVED_AT,
  summary,
  writeCalls,
  ytRow,
} from "./sync-harness.ts";
import type { World } from "./sync-harness.ts";

/**
 * One world that needs every action kind (docs/11 §1.3), in execution order (§1.4):
 * YT-33 resolved epic, open milestone #7      -> closeMilestone
 * YT-34 new epic                              -> createMilestone (#201 in a real run)
 * YT-35 new story under YT-34                 -> create, Feature, milestone of YT-34 (#101)
 * YT-40 new task under YT-35                  -> create, Task, milestone of YT-34, parent YT-35 (#102)
 * YT-41 task #25 top-level, under YT-36 (#22) -> setParent
 * YT-42 task #26 under #22, no parent now     -> removeParent
 * YT-43 bug #27 under YT-33, no milestone     -> update: milestone #7, type Bug
 * YT-45 story #29 under YT-34                 -> update: milestone of YT-34
 * YT-46 task #30 top-level, under YT-35       -> update: milestone of YT-34, then setParent
 * YT-44 resolved story, open mirror #28       -> close
 * YT-36 story #22                             -> unchanged
 */
const EVERY_KIND: World = {
  milestones: [ghMilestone(7, "[YT-33] [team] Epic 33")],
  githubIssues: [
    ghIssue(22, "[YT-36] [team] Task 36", { type: "Feature" }),
    ghIssue(25, "[YT-41] [team] Task 41", { type: "Task" }),
    ghIssue(26, "[YT-42] [team] Task 42", { type: "Task", parent: 22 }),
    ghIssue(27, "[YT-43] [team] Task 43"),
    ghIssue(28, "[YT-44] [team] Task 44", { type: "Feature" }),
    ghIssue(29, "[YT-45] [team] Task 45", { type: "Feature" }),
    ghIssue(30, "[YT-46] [team] Task 46", { type: "Task" }),
  ],
  youtrackRows: [
    ytRow(33, { type: "Epic", summary: "[team] Epic 33", resolved: RESOLVED_AT }),
    ytRow(34, { type: "Epic", summary: "[team] Epic 34" }),
    ytRow(35, { type: "User Story", parent: 34 }),
    ytRow(36, { type: "User Story" }),
    ytRow(40, { type: "Task", parent: 35 }),
    ytRow(41, { type: "Task", parent: 36 }),
    ytRow(42, { type: "Task" }),
    ytRow(43, { type: "Bug", parent: 33 }),
    ytRow(44, { type: "User Story", resolved: RESOLVED_AT }),
    ytRow(45, { type: "User Story", parent: 34 }),
    ytRow(46, { type: "Task", parent: 35 }),
  ],
};

const COUNTS = {
  scanned: 11,
  created: 2,
  closed: 1,
  updated: 6,
  milestonesCreated: 1,
  milestonesClosed: 1,
  unchanged: 1,
} as const;

describe("runSync hierarchy, dry run", () => {
  it("previews every action kind in execution order, with titles for creates only", async () => {
    // Arrange
    const { deps, lines } = harness(EVERY_KIND);

    // Act
    const result = await runSync(config({ dryRun: true }), deps);

    // Assert: a milestone or mirror created in this run has no GitHub number yet ("(new)").
    assert.deepEqual(messages(lines), [
      "[dry-run] would close milestone YT-33 #7",
      "[dry-run] would create milestone YT-34: [YT-34] [team] Epic 34",
      "[dry-run] would create YT-35 with type Feature, milestone YT-34 (new): [YT-35] [team] Task 35",
      "[dry-run] would create YT-40 with type Task, milestone YT-34 (new), parent YT-35 (new): [YT-40] [team] Task 40",
      "[dry-run] would move YT-41 #25 under YT-36 #22",
      "[dry-run] would detach YT-42 #26 from parent YT-36 #22",
      "[dry-run] would update YT-43 #27: set milestone YT-33 #7, set type Bug",
      "[dry-run] would update YT-45 #29: set milestone YT-34 (new)",
      "[dry-run] would update YT-46 #30: set milestone YT-34 (new)",
      "[dry-run] would move YT-46 #30 under YT-35 (new)",
      "[dry-run] would close YT-44 #28",
      formatSummary(result, "ok"),
    ]);
  });

  it("sends only the three reads and never sleeps", async () => {
    // Arrange
    const { deps, calls, sleeps } = harness(EVERY_KIND);

    // Act
    await runSync(config({ dryRun: true }), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), []);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.method === "GET"));
    assert.deepEqual(sleeps, []);
  });

  it("ends with the full summary line (docs/11 §1.7)", async () => {
    // Arrange
    const { deps, lines } = harness(EVERY_KIND);

    // Act
    const result = await runSync(config({ dryRun: true }), deps);

    // Assert
    assert.deepEqual(result, summary({ ...COUNTS, dryRun: true, fetches: 3 }));
    assert.equal(
      messages(lines).at(-1),
      "yt-gh-sync ok scanned=11 created=2 closed=1 updated=6 milestonesCreated=1 milestonesClosed=1 skipped=1 capped=0 failed=0 filtered=0 unchanged=1 labelsReAdded=0 fetches=3 dryRun=true",
    );
  });
});

describe("runSync hierarchy, writes enabled", () => {
  it("sends every write in execution order", async () => {
    // Arrange
    const { deps, calls } = harness(EVERY_KIND);

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [
      `PATCH ${MILESTONES_PATH}/7`,
      `POST ${MILESTONES_PATH}`,
      `POST ${ISSUES_PATH}`,
      `POST ${ISSUES_PATH}`,
      `POST ${ISSUES_PATH}/22/sub_issues`,
      `DELETE ${ISSUES_PATH}/22/sub_issue`,
      `PATCH ${ISSUES_PATH}/27`,
      `PATCH ${ISSUES_PATH}/29`,
      `PATCH ${ISSUES_PATH}/30`,
      `POST ${ISSUES_PATH}/101/sub_issues`,
      `PATCH ${ISSUES_PATH}/28`,
    ]);
    assert.deepEqual(result, summary({ ...COUNTS, fetches: 14 }));
  });

  it("links same-run creates by the numbers and ids GitHub answered with", async () => {
    // Arrange
    const { deps, calls } = harness(EVERY_KIND);

    // Act
    await runSync(config(), deps);

    // Assert: milestone #201 and issue #101 (id issueId(101)) were created in this run.
    const [story, task] = createBodies(calls);
    assert.equal(story?.["milestone"], 201);
    assert.equal(story["type"], "Feature");
    assert.ok(!("parent_issue_id" in story));
    assert.equal(task?.["milestone"], 201);
    assert.equal(task["type"], "Task");
    assert.equal(task["parent_issue_id"], issueId(101));
    assert.deepEqual(onlyBody(calls, "PATCH", `${ISSUES_PATH}/29`), { milestone: 201 });
    assert.deepEqual(onlyBody(calls, "PATCH", `${ISSUES_PATH}/30`), { milestone: 201 });
    assert.deepEqual(onlyBody(calls, "POST", `${ISSUES_PATH}/101/sub_issues`), {
      sub_issue_id: issueId(30),
      replace_parent: true,
    });
  });

  it("sends the existing numbers and ids from the reads", async () => {
    // Arrange
    const { deps, calls } = harness(EVERY_KIND);

    // Act
    await runSync(config(), deps);

    // Assert
    assert.deepEqual(onlyBody(calls, "PATCH", `${MILESTONES_PATH}/7`), { state: "closed" });
    assert.deepEqual(onlyBody(calls, "POST", `${ISSUES_PATH}/22/sub_issues`), {
      sub_issue_id: issueId(25),
      replace_parent: true,
    });
    assert.deepEqual(onlyBody(calls, "DELETE", `${ISSUES_PATH}/22/sub_issue`), { sub_issue_id: issueId(26) });
    assert.deepEqual(onlyBody(calls, "PATCH", `${ISSUES_PATH}/27`), { milestone: 7, type: "Bug" });
  });

  it("logs one line per write with the resolved numbers, then the ok summary", async () => {
    // Arrange
    const { deps, lines } = harness(EVERY_KIND);

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(messages(lines), [
      "close milestone YT-33 #7",
      "create milestone YT-34 -> #201",
      "create YT-35 with type Feature, milestone YT-34 #201 -> #101",
      "create YT-40 with type Task, milestone YT-34 #201, parent YT-35 #101 -> #102",
      "move YT-41 #25 under YT-36 #22",
      "detach YT-42 #26 from parent YT-36 #22",
      "update YT-43 #27: set milestone YT-33 #7, set type Bug",
      "update YT-45 #29: set milestone YT-34 #201",
      "update YT-46 #30: set milestone YT-34 #201",
      "move YT-46 #30 under YT-35 #101",
      "close YT-44 #28",
      formatSummary(result, "ok"),
    ]);
  });
});
