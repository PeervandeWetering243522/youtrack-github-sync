/**
 * runSync with mirror titles named after the YouTrack id (decision N1) and kept in sync on
 * every run (N2), end to end over the fake fetch. The legacy `[YT-n]` titles of older mirrors
 * and milestones are still found, then renamed, never duplicated.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isString } from "../../src/json.ts";
import type { JsonObject } from "../../src/json.ts";
import { ELLIPSIS, MAX_TITLE_LENGTH } from "../../src/mirror.ts";
import { formatSummary, runSync, SyncFailedError } from "../../src/sync.ts";
import {
  bodiesOf,
  bodyOf,
  config,
  createBodies,
  ghIssue,
  ghMilestone,
  GITHUB_TOKEN,
  harness,
  ISSUES_PATH,
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
import type { Override, RecordedCall, World } from "./fixtures.ts";

const EPIC = ytRow(33, { type: "Epic", summary: "[team] Epic 33" });
const RESOLVED_EPIC = ytRow(33, { type: "Epic", summary: "[team] Epic 33", resolved: RESOLVED_AT });
const MILESTONE_7 = ghMilestone(7, "[CUI-33] [team] Epic 33");
/** Milestone #7 of epic CUI-33 as an older version titled it. */
const LEGACY_MILESTONE_7 = ghMilestone(7, "[YT-33] [team] Epic 33");
const story = (n: number, parent?: number): ReturnType<typeof ytRow> =>
  ytRow(n, { type: "User Story", ...(parent === undefined ? {} : { parent }) });

const exhausted = { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790276472" };

/** A PATCH of milestone #7 that renames it (its body has a title), not the one that closes it. */
const isRenameOf7 = (call: RecordedCall): boolean =>
  call.method === "PATCH" && call.url.pathname === `${MILESTONES_PATH}/7` && bodyOf(call)["title"] !== undefined;

/** Answers every PATCH with `issue` as it was, so the response shows none of the changes. */
const answerPatchWith =
  (issue: JsonObject): Override =>
  (call) =>
    call.method === "PATCH" ? json(200, issue) : undefined;

/** The `title` of a request body; fails the test unless it is a string. */
function titleIn(body: JsonObject | undefined): string {
  const title = body?.["title"];
  assert.ok(isString(title), "expected a string title");
  return title;
}

describe("runSync legacy [YT-n] mirrors (N1)", () => {
  it("renames a legacy mirror with exactly its new title and creates no duplicate", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      githubIssues: [ghIssue(21, "[YT-35] [team] Task 35", { type: "Feature" })],
      youtrackRows: [story(35)],
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/21`]);
    assert.deepEqual(onlyBody(calls, "PATCH", `${ISSUES_PATH}/21`), { title: "[CUI-35] [team] Task 35" });
    assert.deepEqual(result, summary({ scanned: 1, updated: 1, fetches: 4 }));
    assert.deepEqual(messages(lines), ["update CUI-35 #21: set title", formatSummary(result, "ok")]);
  });

  it("sends the new title with the milestone and type in one PATCH", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      milestones: [MILESTONE_7],
      githubIssues: [ghIssue(21, "[YT-35] [team] Task 35")],
      youtrackRows: [EPIC, story(35, 33)],
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/21`]);
    assert.deepEqual(onlyBody(calls, "PATCH", `${ISSUES_PATH}/21`), {
      title: "[CUI-35] [team] Task 35",
      milestone: 7,
      type: "Feature",
    });
    assert.deepEqual(result, summary({ scanned: 2, updated: 1, unchanged: 1, fetches: 4 }));
    assert.ok(messages(lines).includes("update CUI-35 #21: set title, set milestone CUI-33 #7, set type Feature"));
  });

  it("finds a legacy milestone by its title and renames it with a PATCH of only its title, counted as updated", async () => {
    // Arrange: the story's mirror already sits in milestone #7.
    const { deps, calls, lines } = harness({
      milestones: [LEGACY_MILESTONE_7],
      githubIssues: [ghIssue(21, "[CUI-35] [team] Task 35", { type: "Feature", milestone: 7 })],
      youtrackRows: [EPIC, story(35, 33)],
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert: no second milestone, and the mirror keeps milestone #7.
    assert.deepEqual(writeCalls(calls), [`PATCH ${MILESTONES_PATH}/7`]);
    assert.deepEqual(onlyBody(calls, "PATCH", `${MILESTONES_PATH}/7`), { title: "[CUI-33] [team] Epic 33" });
    assert.deepEqual(result, summary({ scanned: 2, updated: 1, unchanged: 1, fetches: 4 }));
    assert.deepEqual(messages(lines), ["rename milestone CUI-33 #7", formatSummary(result, "ok")]);
  });

  it("renames, then closes, the legacy milestone of a resolved epic, before any create", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      milestones: [LEGACY_MILESTONE_7],
      youtrackRows: [ytRow(1), RESOLVED_EPIC],
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [
      `PATCH ${MILESTONES_PATH}/7`,
      `PATCH ${MILESTONES_PATH}/7`,
      `POST ${ISSUES_PATH}`,
    ]);
    assert.deepEqual(bodiesOf(calls, "PATCH", `${MILESTONES_PATH}/7`), [
      { title: "[CUI-33] [team] Epic 33" },
      { state: "closed" },
    ]);
    assert.deepEqual(result, summary({ scanned: 2, created: 1, updated: 1, milestonesClosed: 1, fetches: 6 }));
    assert.deepEqual(messages(lines).slice(0, 3), [
      "rename milestone CUI-33 #7",
      "close milestone CUI-33 #7",
      "create CUI-1 -> #101",
    ]);
  });

  it("uses the lowest-numbered mirror when a legacy and a new title both match, renames it and warns", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      githubIssues: [
        ghIssue(21, "[YT-35] [team] Task 35", { type: "Feature" }),
        ghIssue(22, "[CUI-35] [team] Task 35", { type: "Feature" }),
      ],
      youtrackRows: [story(35)],
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/21`]);
    assert.equal(result.created, 0);
    assert.deepEqual(messages(lines, "warn"), ["CUI-35: 2 GitHub issues match; using #21 (labelled), ignoring #22"]);
  });

  it("matches the project id in any case and renames the mirror to the YouTrack id", async () => {
    // Arrange
    const { deps, calls } = harness({
      githubIssues: [ghIssue(21, "[cui-35] [team] Task 35", { type: "Feature" })],
      youtrackRows: [story(35)],
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/21`]);
    assert.deepEqual(onlyBody(calls, "PATCH", `${ISSUES_PATH}/21`), { title: "[CUI-35] [team] Task 35" });
    assert.equal(result.created, 0);
  });

  it("treats a title with another project's id as no mirror and creates one", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      githubIssues: [ghIssue(21, "[ABC-35] [team] Task 35", { type: "Feature" })],
      youtrackRows: [story(35)],
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`]);
    assert.deepEqual(createBodies(calls).map(titleIn), ["[CUI-35] [team] Task 35"]);
    assert.deepEqual(result, summary({ scanned: 1, created: 1, fetches: 4 }));
    assert.deepEqual(messages(lines, "warn"), []);
  });

  it("names titles, log lines and warnings after the configured project", async () => {
    // Arrange: project DEMO. #12 is the unlabelled legacy mirror of task DEMO-5 under epic
    // DEMO-1; #13 has a CUI id, so it is no mirror of DEMO-6.
    const { deps, calls, lines } = harness({
      milestones: [ghMilestone(1, "[YT-1] [team] Epic 1")],
      githubIssues: [
        ghIssue(12, "[YT-5] [team] Task 5", { labels: [] }),
        ghIssue(13, "[CUI-6] [team] Task 6", { type: "Feature" }),
      ],
      youtrackRows: [
        ytRow(1, { project: "DEMO", type: "Epic", summary: "[team] Epic 1" }),
        ytRow(5, { project: "DEMO", type: "Task", parent: 1 }),
        ytRow(6, { project: "DEMO", type: "User Story" }),
      ],
    });

    // Act
    const result = await runSync(config({ youtrackProject: "DEMO" }), deps);

    // Assert
    assert.deepEqual(bodiesOf(calls, "PATCH", `${MILESTONES_PATH}/1`), [{ title: "[DEMO-1] [team] Epic 1" }]);
    assert.deepEqual(createBodies(calls).map(titleIn), ["[DEMO-6] [team] Task 6"]);
    assert.deepEqual(onlyBody(calls, "PATCH", `${ISSUES_PATH}/12`), {
      title: "[DEMO-5] [team] Task 5",
      milestone: 1,
      type: "Task",
    });
    assert.deepEqual(result, summary({ scanned: 3, created: 1, updated: 2, fetches: 6 }));
    assert.deepEqual(messages(lines), [
      'DEMO-5: #12 matched by title only (no "youtrack" label)',
      "rename milestone DEMO-1 #1",
      "create DEMO-6 with type Feature -> #101",
      "update DEMO-5 #12: set title, set milestone DEMO-1 #1, set type Task",
      formatSummary(result, "ok"),
    ]);
  });
});

describe("runSync title sync (N2)", () => {
  it("syncs a title edited in YouTrack onto a closed mirror without reopening it (D8)", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      githubIssues: [ghIssue(21, "[CUI-35] [team] Old summary", { state: "closed", type: "Feature" })],
      youtrackRows: [ytRow(35, { type: "User Story", summary: "[team] New summary", resolved: RESOLVED_AT })],
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/21`]);
    assert.deepEqual(onlyBody(calls, "PATCH", `${ISSUES_PATH}/21`), { title: "[CUI-35] [team] New summary" });
    assert.deepEqual(result, summary({ scanned: 1, updated: 1, fetches: 4 }));
    assert.ok(messages(lines).includes("update CUI-35 #21: set title"));
  });

  it("syncs the title of an open mirror of a resolved issue, then closes it", async () => {
    // Arrange
    const { deps, calls } = harness({
      githubIssues: [ghIssue(21, "[CUI-35] [team] Old summary", { type: "Feature" })],
      youtrackRows: [ytRow(35, { type: "User Story", summary: "[team] New summary", resolved: RESOLVED_AT })],
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(bodiesOf(calls, "PATCH", `${ISSUES_PATH}/21`), [
      { title: "[CUI-35] [team] New summary" },
      { state: "closed", state_reason: "completed" },
    ]);
    assert.deepEqual(result, summary({ scanned: 1, updated: 1, closed: 1, fetches: 5 }));
  });

  it("renames the milestone of an epic whose summary was edited, open or closed, and never reopens one", async () => {
    // Arrange: #7 is open for unresolved CUI-33; #8 is already closed for resolved CUI-34.
    const { deps, calls } = harness({
      milestones: [ghMilestone(7, "[CUI-33] [team] Old epic"), ghMilestone(8, "[CUI-34] [team] Old epic", "closed")],
      youtrackRows: [EPIC, ytRow(34, { type: "Epic", summary: "[team] Epic 34", resolved: RESOLVED_AT })],
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`PATCH ${MILESTONES_PATH}/7`, `PATCH ${MILESTONES_PATH}/8`]);
    assert.deepEqual(onlyBody(calls, "PATCH", `${MILESTONES_PATH}/7`), { title: "[CUI-33] [team] Epic 33" });
    assert.deepEqual(onlyBody(calls, "PATCH", `${MILESTONES_PATH}/8`), { title: "[CUI-34] [team] Epic 34" });
    assert.deepEqual(result, summary({ scanned: 2, updated: 2, fetches: 5 }));
  });

  it("leaves what an earlier run created alone, also when the title was cut or the summary padded", async () => {
    // Arrange: a first run creates the milestone and mirrors; the second run lists them.
    const long = `[team] ${"x".repeat(MAX_TITLE_LENGTH)}`;
    const rows = [
      ytRow(1, { type: "Epic", summary: long }),
      ytRow(2, { summary: long }),
      ytRow(3, { summary: "  [team] padded  " }),
    ];
    const first = harness({ youtrackRows: rows });
    await runSync(config(), first.deps);
    const milestoneTitle = titleIn(onlyBody(first.calls, "POST", MILESTONES_PATH));
    const [cutTitle = "", paddedTitle = ""] = createBodies(first.calls).map(titleIn);
    // The first run cut both long titles and trimmed the padded summary.
    assert.ok(milestoneTitle.endsWith(ELLIPSIS) && milestoneTitle.length === MAX_TITLE_LENGTH);
    assert.ok(cutTitle.endsWith(ELLIPSIS) && cutTitle.length === MAX_TITLE_LENGTH);
    assert.equal(paddedTitle, "[CUI-3] [team] padded");
    const second = harness({
      milestones: [ghMilestone(201, milestoneTitle)],
      githubIssues: [ghIssue(101, cutTitle), ghIssue(102, paddedTitle)],
      youtrackRows: rows,
    });

    // Act
    const result = await runSync(config(), second.deps);

    // Assert
    assert.deepEqual(writeCalls(second.calls), []);
    assert.deepEqual(result, summary({ scanned: 3, unchanged: 3, fetches: 3 }));
  });

  it("caps a title sync that waits for a failed milestone create, title included (D4)", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      githubIssues: [ghIssue(21, "[YT-35] [team] Task 35", { type: "Feature" })],
      youtrackRows: [EPIC, story(35, 33)],
      override: (call) => (call.method === "POST" ? json(422, { message: "Validation Failed" }) : undefined),
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert: the next run sends title and milestone together, once the milestone exists.
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(writeCalls(calls), [`POST ${MILESTONES_PATH}`]);
    assert.deepEqual(error.summary, summary({ scanned: 2, capped: 1, failed: 1, fetches: 4 }));
    assert.deepEqual(messages(lines, "warn"), [
      "update CUI-35 #21 capped: the milestone of CUI-33 was not created in this run",
    ]);
  });
});

describe("runSync title sync in dry run", () => {
  it("previews title syncs and milestone renames with their new titles and sends no writes", async () => {
    // Arrange: legacy milestone #1 of epic CUI-1; legacy mirrors #101 (CUI-5) and #102 (story
    // CUI-6 under CUI-1, with neither milestone nor type yet).
    const { deps, calls, lines } = harness({
      milestones: [ghMilestone(1, "[YT-1] [team] Epic 1")],
      githubIssues: [ghIssue(101, "[YT-5] [team] Task 5"), ghIssue(102, "[YT-6] [team] Task 6")],
      youtrackRows: [ytRow(1, { type: "Epic", summary: "[team] Epic 1" }), ytRow(5), story(6, 1)],
    });

    // Act
    const result = await runSync(config({ dryRun: true }), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), []);
    assert.ok(calls.every((call) => call.method === "GET"));
    assert.deepEqual(messages(lines), [
      "[dry-run] would rename milestone CUI-1 #1: [CUI-1] [team] Epic 1",
      "[dry-run] would update CUI-5 #101: set title: [CUI-5] [team] Task 5",
      "[dry-run] would update CUI-6 #102: set title, set milestone CUI-1 #1, set type Feature: [CUI-6] [team] Task 6",
      formatSummary(result, "ok"),
    ]);
    assert.deepEqual(result, summary({ dryRun: true, scanned: 3, updated: 3, fetches: 3 }));
  });

  it("redacts a token in a previewed title", async () => {
    // Arrange
    const { deps, lines } = harness({
      githubIssues: [ghIssue(12, "[YT-1] [team] old summary")],
      youtrackRows: [ytRow(1, { summary: `[team] leaked ${GITHUB_TOKEN}` })],
    });

    // Act
    await runSync(config({ dryRun: true }), deps);

    // Assert
    assert.ok(
      messages(lines).includes("[dry-run] would update CUI-1 #12: set title: [CUI-1] [team] leaked [redacted]"),
    );
    assert.ok(!messages(lines).some((line) => line.includes(GITHUB_TOKEN)));
  });
});

describe("runSync title sync and the write cap", () => {
  /** Rename of milestone #1 (milestones), create of CUI-7 (creates), title sync of #12 (sync). */
  const ONE_OF_EACH: World = {
    milestones: [ghMilestone(1, "[YT-1] [team] Epic 1")],
    githubIssues: [ghIssue(12, "[YT-5] [team] Task 5")],
    youtrackRows: [ytRow(1, { type: "Epic", summary: "[team] Epic 1" }), ytRow(5), ytRow(7)],
  };

  it("counts a milestone rename and a title sync as one write each", async () => {
    // Arrange
    const { deps, calls } = harness(ONE_OF_EACH);

    // Act
    const result = await runSync(config({ maxWritesPerRun: 2 }), deps);

    // Assert: the rename and the create fit; the title sync of #12 comes after them.
    assert.deepEqual(writeCalls(calls), [`PATCH ${MILESTONES_PATH}/1`, `POST ${ISSUES_PATH}`]);
    assert.deepEqual(result, summary({ scanned: 3, created: 1, updated: 1, capped: 1, fetches: 5 }));
  });

  it("applies the cap to previewed renames too", async () => {
    // Arrange
    const { deps, lines } = harness(ONE_OF_EACH);

    // Act
    const result = await runSync(config({ dryRun: true, maxWritesPerRun: 1 }), deps);

    // Assert
    assert.deepEqual(messages(lines).slice(0, -1), [
      "[dry-run] would rename milestone CUI-1 #1: [CUI-1] [team] Epic 1",
    ]);
    assert.deepEqual(result, summary({ dryRun: true, scanned: 3, updated: 1, capped: 2, fetches: 3 }));
  });

  it("spends one write on a title sync that also sets milestone and type", async () => {
    // Arrange
    const { deps, calls } = harness({
      milestones: [MILESTONE_7],
      githubIssues: [ghIssue(21, "[YT-35] [team] Task 35")],
      youtrackRows: [EPIC, story(35, 33)],
    });

    // Act
    const result = await runSync(config({ maxWritesPerRun: 1 }), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/21`]);
    assert.equal(result.updated, 1);
    assert.equal(result.capped, 0);
  });
});

describe("runSync title sync outcomes", () => {
  it("warns when GitHub answers a title sync with the old title, and still counts it", async () => {
    // Arrange
    const mirror = ghIssue(21, "[YT-35] [team] Task 35", { type: "Feature" });
    const { deps, calls, lines } = harness({
      githubIssues: [mirror],
      youtrackRows: [story(35)],
      override: answerPatchWith(mirror),
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert: no second write; the next run's plan sees the difference again.
    assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/21`]);
    assert.equal(result.updated, 1);
    assert.deepEqual(messages(lines, "warn"), [
      "CUI-35 #21: GitHub dropped the title on update; the next run tries again",
    ]);
  });

  it("names the title first among the changes GitHub dropped", async () => {
    // Arrange
    const mirror = ghIssue(21, "[YT-35] [team] Task 35");
    const { deps, lines } = harness({
      milestones: [MILESTONE_7],
      githubIssues: [mirror],
      youtrackRows: [EPIC, story(35, 33)],
      override: answerPatchWith(mirror),
    });

    // Act
    await runSync(config(), deps);

    // Assert
    assert.deepEqual(messages(lines, "warn"), [
      "CUI-35 #21: GitHub dropped the title, milestone #7, type Feature on update; the next run tries again",
    ]);
  });

  it("retries a milestone rename once after a 5xx (it is idempotent)", async () => {
    // Arrange
    const { deps, calls } = harness({
      milestones: [LEGACY_MILESTONE_7],
      youtrackRows: [EPIC],
      override: (call, attempt) => (call.method === "PATCH" && attempt === 0 ? json(502, {}) : undefined),
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`PATCH ${MILESTONES_PATH}/7`, `PATCH ${MILESTONES_PATH}/7`]);
    assert.equal(result.updated, 1);
    assert.equal(result.failed, 0);
  });

  it("records a failed milestone rename without retrying a 422, still closes the milestone, and fails the run", async () => {
    // Arrange
    const { deps, calls } = harness({
      milestones: [LEGACY_MILESTONE_7],
      youtrackRows: [RESOLVED_EPIC],
      override: (call) => (isRenameOf7(call) ? json(422, { message: "Validation Failed" }) : undefined),
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(bodiesOf(calls, "PATCH", `${MILESTONES_PATH}/7`), [
      { title: "[CUI-33] [team] Epic 33" },
      { state: "closed" },
    ]);
    assert.match(error.failures[0] ?? "", /^rename milestone CUI-33 #7 failed: PATCH .*\/milestones\/7 -> HTTP 422/);
    assert.deepEqual(error.summary, summary({ scanned: 1, milestonesClosed: 1, failed: 1, fetches: 5 }));
  });

  it("stops after a rate-limited milestone rename and caps the rest", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      milestones: [LEGACY_MILESTONE_7],
      youtrackRows: [RESOLVED_EPIC],
      override: (call) =>
        isRenameOf7(call) ? json(429, { message: "API rate limit exceeded" }, exhausted) : undefined,
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(writeCalls(calls), [`PATCH ${MILESTONES_PATH}/7`]);
    assert.deepEqual(error.summary, summary({ scanned: 1, capped: 1, failed: 1, fetches: 4 }));
    assert.deepEqual(messages(lines, "warn"), ["GitHub rate limit hit; 1 more action(s) capped"]);
  });
});

describe("runSync title sync and the exclude filter (F1-F3)", () => {
  /**
   * Every mirror and milestone has an outdated, legacy title:
   * CUI-4 "[individual]" issue, mirror #31           -> filtered (F1), title left alone (F2)
   * CUI-15 task, mirror #21                          -> update: title
   * CUI-32 "[Individual]" epic, milestone #7         -> filtered (F1), not renamed (F2)
   * CUI-46 task under CUI-32, mirror #30             -> filtered (F3), title left alone (F2)
   */
  const EXCLUDED_WORLD: World = {
    milestones: [ghMilestone(7, "[YT-32] [Individual] Data Structures and Algorithms")],
    githubIssues: [
      ghIssue(21, "[YT-15] Plan the sprint", { type: "Task" }),
      ghIssue(30, "[YT-46] Implement a linked list", { type: "Task" }),
      ghIssue(31, "[YT-4] [team] Before the prefix"),
    ],
    youtrackRows: [
      ytRow(4, { summary: "[individual] Task 4" }),
      ytRow(15, { type: "Task", summary: "Plan the sprint" }),
      ytRow(32, { type: "Epic", summary: "[Individual] Data Structures and Algorithms" }),
      ytRow(46, { type: "Task", parent: 32, summary: "Implement a linked list" }),
    ],
  };

  it("syncs only the title of the issue outside the excluded tree", async () => {
    // Arrange
    const { deps, calls } = harness(EXCLUDED_WORLD);

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/21`]);
    assert.deepEqual(onlyBody(calls, "PATCH", `${ISSUES_PATH}/21`), { title: "[CUI-15] Plan the sprint" });
    assert.deepEqual(result, summary({ scanned: 4, filtered: 3, updated: 1, fetches: 4 }));
  });

  it("previews no title sync or rename for excluded issues", async () => {
    // Arrange
    const { deps, lines } = harness(EXCLUDED_WORLD);

    // Act
    const result = await runSync(config({ dryRun: true }), deps);

    // Assert
    assert.deepEqual(messages(lines), [
      "[dry-run] would update CUI-15 #21: set title: [CUI-15] Plan the sprint",
      formatSummary(result, "ok"),
    ]);
  });
});
