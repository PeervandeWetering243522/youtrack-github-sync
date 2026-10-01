import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_RETRY_DELAY_MS, HttpError } from "../../src/http.ts";
import { formatSummary, runSync, SyncFailedError } from "../../src/sync.ts";
import {
  config,
  ghIssue,
  GITHUB_ORIGIN,
  GITHUB_TOKEN,
  harness,
  isCreate,
  ISSUES_PATH,
  json,
  lastLine,
  messages,
  MILESTONES_PATH,
  MIXED_WORLD,
  rejection,
  RESOLVED_AT,
  summary,
  titleOf,
  writeCalls,
  YOUTRACK_BASE_URL,
  YOUTRACK_TOKEN,
  ytRow,
} from "./fixtures.ts";
import type { Override, World } from "./fixtures.ts";

// ---------------------------------------------------------------------------
// Write cap
// ---------------------------------------------------------------------------

describe("runSync write cap", () => {
  it("sends the actions that fit, in order, then stops without a warning", async () => {
    // Arrange: CUI-1 and CUI-2 fit in a cap of 2; CUI-3 comes after them and waits.
    const { deps, calls, lines } = harness({ youtrackRows: [ytRow(1), ytRow(2), ytRow(3)] });

    // Act
    const result = await runSync(config({ maxWritesPerRun: 2 }), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`, `POST ${ISSUES_PATH}`]);
    assert.deepEqual(calls.filter(isCreate).map(titleOf), ["[CUI-1] [team] Task 1", "[CUI-2] [team] Task 2"]);
    assert.equal(result.created, 2);
    assert.equal(result.capped, 1);
    assert.equal(result.failed, 0);
    assert.deepEqual(messages(lines, "warn"), []);
  });

  it("spends no write on a resolved issue without a mirror under a cap of 1 (R9)", async () => {
    // Arrange
    const { deps, calls } = harness({ youtrackRows: [ytRow(1, { resolved: RESOLVED_AT }), ytRow(2), ytRow(3)] });

    // Act
    const result = await runSync(config({ maxWritesPerRun: 1 }), deps);

    // Assert
    assert.deepEqual(calls.filter(isCreate).map(titleOf), ["[CUI-2] [team] Task 2"]);
    assert.deepEqual(result, summary({ scanned: 3, unchanged: 1, created: 1, capped: 1, fetches: 4 }));
  });

  it("creates before it closes under a cap of 1, even for a lower issue number (docs/11 §1.4)", async () => {
    // Arrange: #50 is the open mirror of resolved CUI-1; CUI-2 needs a create.
    const { deps, calls } = harness({
      githubIssues: [ghIssue(50, "[CUI-1] [team] Task 1")],
      youtrackRows: [ytRow(1, { resolved: RESOLVED_AT }), ytRow(2)],
    });

    // Act
    const result = await runSync(config({ maxWritesPerRun: 1 }), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`]);
    assert.equal(result.created, 1);
    assert.equal(result.closed, 0);
    assert.equal(result.capped, 1);
  });

  it("writes nothing with a cap of zero", async () => {
    // Arrange
    const { deps, calls } = harness(MIXED_WORLD);

    // Act
    const result = await runSync(config({ maxWritesPerRun: 0 }), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), []);
    assert.equal(result.capped, 2);
  });
});

// ---------------------------------------------------------------------------
// Write failures (decision A10)
// ---------------------------------------------------------------------------

describe("runSync write failures", () => {
  const failFirstCreate: Override = (call) =>
    isCreate(call) && titleOf(call).startsWith("[CUI-1]") ? json(422, { message: "Validation Failed" }) : undefined;

  it("records a failed create, runs the rest, then throws", async () => {
    // Arrange
    const world: World = {
      githubIssues: [ghIssue(12, "[CUI-3] [team] Task 3")],
      youtrackRows: [ytRow(1), ytRow(2), ytRow(3, { resolved: RESOLVED_AT })],
      override: failFirstCreate,
    };
    const { deps, calls } = harness(world);

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`, `POST ${ISSUES_PATH}`, `PATCH ${ISSUES_PATH}/12`]);
    assert.equal(error.failures.length, 1);
    assert.match(error.failures[0] ?? "", /^create CUI-1 failed: POST https:\/\/api\.github\.com\/.* -> HTTP 422/);
    assert.deepEqual(error.summary, summary({ scanned: 3, created: 1, closed: 1, failed: 1, fetches: 6 }));
  });

  it("logs the failure and then the failed summary as the last line", async () => {
    // Arrange
    const { deps, lines } = harness({ youtrackRows: [ytRow(1), ytRow(2)], override: failFirstCreate });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(lastLine(lines), { level: "error", message: formatSummary(error.summary, "failed") });
    assert.match(messages(lines, "error")[0] ?? "", /^create CUI-1 failed: /);
    assert.ok(messages(lines, "info").includes("create CUI-2 -> #101"));
  });

  it("records a failed close and continues", async () => {
    // Arrange
    const { deps, calls } = harness({
      githubIssues: [ghIssue(12, "[CUI-1] [team] Task 1"), ghIssue(13, "[CUI-2] [team] Task 2")],
      youtrackRows: [ytRow(1, { resolved: RESOLVED_AT }), ytRow(2, { resolved: RESOLVED_AT })],
      override: (call) => (call.url.pathname.endsWith("/12") ? json(404, { message: "Not Found" }) : undefined),
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.match(error.failures[0] ?? "", /^close CUI-1 #12 failed: PATCH .* -> HTTP 404/);
    assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/12`, `PATCH ${ISSUES_PATH}/13`]);
    assert.equal(error.summary.closed, 1);
  });

  it("never retries a create that failed on the network", async () => {
    // Arrange
    const { deps, calls } = harness({
      youtrackRows: [ytRow(1)],
      override: (call) => (isCreate(call) ? new TypeError("fetch failed") : undefined),
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.equal(calls.filter(isCreate).length, 1);
    assert.match(error.failures[0] ?? "", /^create CUI-1 failed: POST .* failed: fetch failed/);
  });

  it("retries a close once after a 5xx and counts it as done", async () => {
    // Arrange
    const { deps, calls, sleeps } = harness({
      githubIssues: [ghIssue(12, "[CUI-1] [team] Task 1")],
      youtrackRows: [ytRow(1, { resolved: RESOLVED_AT })],
      override: (call, attempt) =>
        call.method === "PATCH" && attempt === 0 ? json(503, { message: "busy" }) : undefined,
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.equal(writeCalls(calls).length, 2);
    assert.equal(result.closed, 1);
    assert.equal(result.failed, 0);
    assert.deepEqual(sleeps, [DEFAULT_RETRY_DELAY_MS]);
  });
});

// ---------------------------------------------------------------------------
// Read failures
// ---------------------------------------------------------------------------

describe("runSync read failures", () => {
  it("rethrows a GitHub list error after a failed summary, before touching YouTrack", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      ...MIXED_WORLD,
      override: (call) => (call.url.origin === GITHUB_ORIGIN ? json(401, { message: "Bad credentials" }) : undefined),
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 401);
    assert.equal(calls.length, 1);
    assert.deepEqual(lastLine(lines), { level: "error", message: formatSummary(summary({ fetches: 1 }), "failed") });
  });

  it("rethrows a GitHub milestones list error after a failed summary, before touching YouTrack", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      ...MIXED_WORLD,
      override: (call) => (call.url.pathname === MILESTONES_PATH ? json(404, { message: "Not Found" }) : undefined),
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 404);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.url.origin === GITHUB_ORIGIN && call.method === "GET"));
    assert.deepEqual(lastLine(lines), { level: "error", message: formatSummary(summary({ fetches: 2 }), "failed") });
  });

  it("rethrows a GitHub milestone that is not shaped like one", async () => {
    // Arrange
    const { deps, calls } = harness({ ...MIXED_WORLD, milestones: [{ number: 1, title: "[CUI-1] x", state: "gone" }] });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.equal(error.name, "GitHubSchemaError");
    assert.deepEqual(writeCalls(calls), []);
  });

  it("rethrows a YouTrack 400 and writes nothing", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      ...MIXED_WORLD,
      override: (call) =>
        call.url.origin === YOUTRACK_BASE_URL
          ? json(400, { error: "invalid_query", error_description: "bad" })
          : undefined,
    });

    // Act
    const error = await rejection(runSync(config({ dryRun: true }), deps));

    // Assert
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 400);
    assert.deepEqual(writeCalls(calls), []);
    const failed = formatSummary(summary({ dryRun: true, fetches: 3 }), "failed");
    assert.deepEqual(lastLine(lines), { level: "error", message: failed });
  });

  it("rethrows a YouTrack row that lacks a requested field", async () => {
    // Arrange
    const row = Object.fromEntries(Object.entries(ytRow(1)).filter(([key]) => key !== "resolved"));
    const { deps, calls } = harness({ youtrackRows: [row] });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.equal(error.name, "YouTrackSchemaError");
    assert.deepEqual(writeCalls(calls), []);
  });
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

describe("runSync secrets", () => {
  /** Issue text and an error body that both contain the tokens. */
  const leakyWorld: World = {
    youtrackRows: [ytRow(1, { summary: `[team] leaked ${GITHUB_TOKEN}` }), ytRow(2)],
    override: (call) =>
      isCreate(call) && titleOf(call).startsWith("[CUI-2]")
        ? json(422, { message: `bad ${YOUTRACK_TOKEN} and ${GITHUB_TOKEN}` })
        : undefined,
  };

  function assertNoTokens(texts: readonly string[]): void {
    for (const text of texts) {
      assert.ok(!text.includes(GITHUB_TOKEN), `GitHub token leaked: ${text.slice(0, 40)}`);
      assert.ok(!text.includes(YOUTRACK_TOKEN), `YouTrack token leaked: ${text.slice(0, 40)}`);
    }
  }

  it("never logs a token, even when issue text or error bodies contain one", async () => {
    // Arrange
    const { deps, lines } = harness(leakyWorld);

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assertNoTokens([...messages(lines), error.message, ...error.failures]);
    assert.ok(messages(lines, "error").some((line) => line.includes("[redacted]")));
  });

  it("never logs a token in dry run", async () => {
    // Arrange
    const { deps, lines } = harness(leakyWorld);

    // Act
    await runSync(config({ dryRun: true }), deps);

    // Assert
    assertNoTokens(messages(lines));
    assert.ok(messages(lines).includes("[dry-run] would create CUI-1: [CUI-1] [team] leaked [redacted]"));
  });

  it("never logs a token when a read fails", async () => {
    // Arrange
    const { deps, lines } = harness({
      override: (call) => (call.url.origin === GITHUB_ORIGIN ? new TypeError(`bad header ${GITHUB_TOKEN}`) : undefined),
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assertNoTokens([...messages(lines), error.message]);
  });
});
