/**
 * runSync reopening its own closes (decision R10), end to end over the fake fetch: a closed
 * mirror of an unresolved YouTrack issue is reopened only when its GitHub `closed_by` login is
 * REOPEN_CLOSED_BY. Milestones are never reopened.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_RETRY_DELAY_MS } from "../../src/http.ts";
import { formatSummary, runSync, SyncFailedError } from "../../src/sync.ts";
import {
  bodiesOf,
  config,
  ghIssue,
  ghMilestone,
  harness,
  ISSUES_PATH,
  json,
  lastLine,
  messages,
  onlyBody,
  rejection,
  RESOLVED_AT,
  summary,
  writeCalls,
  ytRow,
} from "./fixtures.ts";
import type { World } from "./fixtures.ts";

const ACTIONS_BOT = "github-actions[bot]";
const REOPEN_BODY = { state: "open", state_reason: "reopened" } as const;

/**
 * CUI-1 unresolved, closed mirror #12 closed by ACTIONS_BOT -> reopen
 * CUI-2 unresolved, closed mirror #13 closed by a person    -> unchanged
 * CUI-3 resolved, open mirror #14                           -> close
 * CUI-4 unresolved, closed mirror #15 without closed_by     -> unchanged
 */
const REOPEN_WORLD: World = {
  githubIssues: [
    ghIssue(12, "[CUI-1] [team] Task 1", { state: "closed", closedBy: ACTIONS_BOT }),
    ghIssue(13, "[CUI-2] [team] Task 2", { state: "closed", closedBy: "a-person" }),
    ghIssue(14, "[CUI-3] [team] Task 3"),
    ghIssue(15, "[CUI-4] [team] Task 4", { state: "closed", closedBy: null }),
  ],
  youtrackRows: [ytRow(1), ytRow(2), ytRow(3, { resolved: RESOLVED_AT }), ytRow(4)],
};

/** Only CUI-1 and its closed mirror #12, closed by ACTIONS_BOT: one reopen. */
const ONE_REOPEN: World = {
  githubIssues: [ghIssue(12, "[CUI-1] [team] Task 1", { state: "closed", closedBy: ACTIONS_BOT })],
  youtrackRows: [ytRow(1)],
};

const exhausted = { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790276472" };

describe("runSync reopen (R10)", () => {
  it("PATCHes the mirror REOPEN_CLOSED_BY closed back to open/reopened and logs it", async () => {
    // Arrange
    const { deps, calls, lines } = harness(REOPEN_WORLD);

    // Act
    const result = await runSync(config({ reopenClosedBy: ACTIONS_BOT }), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/12`, `PATCH ${ISSUES_PATH}/14`]);
    assert.deepEqual(onlyBody(calls, "PATCH", `${ISSUES_PATH}/12`), REOPEN_BODY);
    assert.deepEqual(onlyBody(calls, "PATCH", `${ISSUES_PATH}/14`), { state: "closed", state_reason: "completed" });
    assert.deepEqual(messages(lines, "info").slice(0, 2), ["reopen CUI-1 #12", "close CUI-3 #14"]);
    assert.deepEqual(result, summary({ scanned: 4, reopened: 1, closed: 1, unchanged: 2, fetches: 5 }));
  });

  it("ends with a summary line that shows reopened=1 right after closed", async () => {
    // Arrange
    const { deps, lines } = harness(REOPEN_WORLD);

    // Act
    const result = await runSync(config({ reopenClosedBy: ACTIONS_BOT }), deps);

    // Assert
    const line = formatSummary(result, "ok");
    assert.deepEqual(lastLine(lines), { level: "info", message: line });
    assert.match(line, / closed=1 reopened=1 updated=0 /);
  });

  it("matches the closer's login ASCII-case-insensitively", async () => {
    // Arrange
    const { deps, calls } = harness({
      githubIssues: [ghIssue(12, "[CUI-1] [team] Task 1", { state: "closed", closedBy: "GitHub-Actions[bot]" })],
      youtrackRows: [ytRow(1)],
    });

    // Act
    const result = await runSync(config({ reopenClosedBy: "github-actions[BOT]" }), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/12`]);
    assert.equal(result.reopened, 1);
  });

  it('logs "[dry-run] would reopen" in a dry run and sends nothing', async () => {
    // Arrange
    const { deps, calls, lines } = harness(REOPEN_WORLD);

    // Act
    const result = await runSync(config({ dryRun: true, reopenClosedBy: ACTIONS_BOT }), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), []);
    assert.ok(calls.every((call) => call.method === "GET"));
    assert.deepEqual(messages(lines, "info").slice(0, 2), [
      "[dry-run] would reopen CUI-1 #12",
      "[dry-run] would close CUI-3 #14",
    ]);
    assert.deepEqual(result, summary({ dryRun: true, scanned: 4, reopened: 1, closed: 1, unchanged: 2, fetches: 3 }));
  });

  it("reopens nothing while REOPEN_CLOSED_BY is unset", async () => {
    // Arrange
    const { deps, calls, lines } = harness(REOPEN_WORLD);

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/14`]);
    assert.ok(!messages(lines).some((message) => message.includes("reopen CUI")));
    assert.deepEqual(result, summary({ scanned: 4, closed: 1, unchanged: 3, fetches: 4 }));
    assert.match(lastLine(lines).message, / reopened=0 /);
  });

  it("updates the title of a closed mirror first, then reopens it, in two PATCHes", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      githubIssues: [ghIssue(12, "[CUI-1] Old summary", { state: "closed", closedBy: ACTIONS_BOT })],
      youtrackRows: [ytRow(1)],
    });

    // Act
    const result = await runSync(config({ reopenClosedBy: ACTIONS_BOT }), deps);

    // Assert
    assert.deepEqual(bodiesOf(calls, "PATCH", `${ISSUES_PATH}/12`), [{ title: "[CUI-1] [team] Task 1" }, REOPEN_BODY]);
    assert.deepEqual(messages(lines, "info").slice(0, 2), ["update CUI-1 #12: set title", "reopen CUI-1 #12"]);
    assert.deepEqual(result, summary({ scanned: 1, updated: 1, reopened: 1, fetches: 5 }));
  });

  it("counts a reopen against the write cap, after the writes that come before it", async () => {
    // Arrange
    const { deps, calls } = harness(REOPEN_WORLD);

    // Act
    const result = await runSync(config({ reopenClosedBy: ACTIONS_BOT, maxWritesPerRun: 1 }), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/12`]);
    assert.deepEqual(result, summary({ scanned: 4, reopened: 1, capped: 1, unchanged: 2, fetches: 4 }));
  });

  it("never reopens the closed milestone of an unresolved epic", async () => {
    // Arrange
    const { deps, calls } = harness({
      milestones: [ghMilestone(7, "[CUI-33] [team] Epic 33", "closed")],
      youtrackRows: [ytRow(33, { type: "Epic", summary: "[team] Epic 33" })],
    });

    // Act
    const result = await runSync(config({ reopenClosedBy: ACTIONS_BOT }), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), []);
    assert.deepEqual(result, summary({ scanned: 1, unchanged: 1, fetches: 3 }));
  });

  it("never reopens the closed mirror of an excluded issue (F2)", async () => {
    // Arrange
    const { deps, calls } = harness({
      githubIssues: [ghIssue(12, "[CUI-1] [individual] Mine", { state: "closed", closedBy: ACTIONS_BOT })],
      youtrackRows: [ytRow(1, { summary: "[individual] Mine" })],
    });

    // Act
    const result = await runSync(config({ reopenClosedBy: ACTIONS_BOT }), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), []);
    assert.deepEqual(result, summary({ scanned: 1, filtered: 1, fetches: 3 }));
  });
});

describe("runSync reopen failures (R10)", () => {
  it("records a failed reopen like a failed close and continues with the next write", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      ...REOPEN_WORLD,
      override: (call) =>
        call.method === "PATCH" && call.url.pathname.endsWith("/12") ? json(404, { message: "Not Found" }) : undefined,
    });

    // Act
    const error = await rejection(runSync(config({ reopenClosedBy: ACTIONS_BOT }), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.equal(error.failures.length, 1);
    assert.match(error.failures[0] ?? "", /^reopen CUI-1 #12 failed: PATCH .* -> HTTP 404/);
    assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/12`, `PATCH ${ISSUES_PATH}/14`]);
    assert.deepEqual(error.summary, summary({ scanned: 4, closed: 1, failed: 1, unchanged: 2, fetches: 5 }));
    assert.deepEqual(lastLine(lines), { level: "error", message: formatSummary(error.summary, "failed") });
  });

  it("retries a reopen once after a 5xx and counts it as done", async () => {
    // Arrange
    const { deps, calls, sleeps } = harness({
      ...ONE_REOPEN,
      override: (call, attempt) =>
        call.method === "PATCH" && attempt === 0 ? json(503, { message: "busy" }) : undefined,
    });

    // Act
    const result = await runSync(config({ reopenClosedBy: ACTIONS_BOT }), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/12`, `PATCH ${ISSUES_PATH}/12`]);
    assert.deepEqual(bodiesOf(calls, "PATCH", `${ISSUES_PATH}/12`), [REOPEN_BODY, REOPEN_BODY]);
    assert.deepEqual(result, summary({ scanned: 1, reopened: 1, fetches: 5 }));
    assert.deepEqual(sleeps, [DEFAULT_RETRY_DELAY_MS]);
  });

  for (const status of [403, 429]) {
    it(`stops after a reopen answered ${String(status)} with x-ratelimit-remaining 0, caps the rest and throws`, async () => {
      // Arrange
      const { deps, calls, lines, sleeps } = harness({
        ...REOPEN_WORLD,
        override: (call) =>
          call.method === "PATCH" && call.url.pathname.endsWith("/12")
            ? json(status, { message: "API rate limit exceeded for user ID 1." }, exhausted)
            : undefined,
      });

      // Act
      const error = await rejection(runSync(config({ reopenClosedBy: ACTIONS_BOT }), deps));

      // Assert
      assert.ok(error instanceof SyncFailedError);
      assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/12`]);
      const expected = new RegExp(
        `^reopen CUI-1 #12 failed: PATCH .* -> HTTP ${String(status)}: .*API rate limit exceeded`,
      );
      assert.match(error.failures[0] ?? "", expected);
      assert.deepEqual(error.summary, summary({ scanned: 4, capped: 1, failed: 1, unchanged: 2, fetches: 4 }));
      assert.deepEqual(sleeps, []);
      assert.deepEqual(messages(lines, "warn"), ["GitHub rate limit hit; 1 more action(s) capped"]);
      assert.deepEqual(lastLine(lines), { level: "error", message: formatSummary(error.summary, "failed") });
    });
  }
});

describe("formatSummary: reopened (R10)", () => {
  it("prints reopened right after closed", () => {
    const line = formatSummary(summary({ scanned: 9, closed: 2, reopened: 3, updated: 1 }), "ok");

    assert.match(line, /^yt-gh-sync ok scanned=9 created=0 closed=2 reopened=3 updated=1 milestonesCreated=0 /);
  });
});
