import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_RETRY_DELAY_MS, HttpError } from "../src/http.ts";
import { formatSummary, runSync, SyncFailedError, WRITE_PAUSE_MS } from "../src/sync.ts";
import {
  config,
  ghIssue,
  GITHUB_ORIGIN,
  GITHUB_TOKEN,
  harness,
  isCreate,
  ISSUES_PATH,
  json,
  LABELS_PATH,
  lastLine,
  messages,
  MIXED_WORLD,
  rejection,
  RESOLVED_AT,
  summary,
  titleOf,
  writeCalls,
  YOUTRACK_BASE_URL,
  YOUTRACK_TOKEN,
  ytRow,
} from "./sync-harness.ts";
import type { Override, World } from "./sync-harness.ts";

// ---------------------------------------------------------------------------
// Write cap
// ---------------------------------------------------------------------------

describe("runSync write cap", () => {
  it("stops at the first action that does not fit and never splits a create+close pair", async () => {
    // Arrange: YT-1 create (1) fits; YT-2 create+close (2) would make 3; YT-3 comes after it.
    const { deps, calls } = harness({ youtrackRows: [ytRow(1), ytRow(2, { resolved: RESOLVED_AT }), ytRow(3)] });

    // Act
    const result = await runSync(config({ maxWritesPerRun: 2 }), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`]);
    assert.equal(result.created, 1);
    assert.equal(result.capped, 2);
    assert.equal(result.failed, 0);
  });

  it("writes nothing with a cap of zero", async () => {
    // Arrange
    const { deps, calls } = harness(MIXED_WORLD);

    // Act
    const result = await runSync(config({ maxWritesPerRun: 0 }), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), []);
    assert.equal(result.capped, 3);
  });
});

// ---------------------------------------------------------------------------
// Write failures (decision A10)
// ---------------------------------------------------------------------------

describe("runSync write failures", () => {
  const failFirstCreate: Override = (call) =>
    isCreate(call) && titleOf(call).startsWith("[YT-1]") ? json(422, { message: "Validation Failed" }) : undefined;

  it("records a failed create, skips its close, runs the rest, then throws", async () => {
    // Arrange: YT-1 is resolved, so its failed create must not be followed by a close.
    const world: World = {
      githubIssues: [ghIssue(12, "[YT-3] [team] Task 3")],
      youtrackRows: [ytRow(1, { resolved: RESOLVED_AT }), ytRow(2), ytRow(3, { resolved: RESOLVED_AT })],
      override: failFirstCreate,
    };
    const { deps, calls } = harness(world);

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`, `POST ${ISSUES_PATH}`, `PATCH ${ISSUES_PATH}/12`]);
    assert.equal(error.failures.length, 1);
    assert.match(error.failures[0] ?? "", /^create YT-1 failed: POST https:\/\/api\.github\.com\/.* -> HTTP 422/);
    assert.deepEqual(error.summary, summary({ scanned: 3, created: 1, closed: 1, failed: 1, fetches: 5 }));
  });

  it("logs the failure and then the failed summary as the last line", async () => {
    // Arrange
    const { deps, lines } = harness({ youtrackRows: [ytRow(1), ytRow(2)], override: failFirstCreate });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(lastLine(lines), { level: "error", message: formatSummary(error.summary, "failed") });
    assert.match(messages(lines, "error")[0] ?? "", /^create YT-1 failed: /);
    assert.ok(messages(lines, "info").includes("create YT-2 -> #101"));
  });

  it("records a failed close and continues", async () => {
    // Arrange
    const { deps, calls } = harness({
      githubIssues: [ghIssue(12, "[YT-1] [team] Task 1"), ghIssue(13, "[YT-2] [team] Task 2")],
      youtrackRows: [ytRow(1, { resolved: RESOLVED_AT }), ytRow(2, { resolved: RESOLVED_AT })],
      override: (call) => (call.url.pathname.endsWith("/12") ? json(404, { message: "Not Found" }) : undefined),
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.match(error.failures[0] ?? "", /^close YT-1 #12 failed: PATCH .* -> HTTP 404/);
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
    assert.match(error.failures[0] ?? "", /^create YT-1 failed: POST .* failed: fetch failed/);
  });

  it("retries a close once after a 5xx and counts it as done", async () => {
    // Arrange
    const { deps, calls, sleeps } = harness({
      githubIssues: [ghIssue(12, "[YT-1] [team] Task 1")],
      youtrackRows: [ytRow(1, { resolved: RESOLVED_AT })],
      override: (call, attempt) => (call.method === "PATCH" && attempt === 0 ? json(503, { message: "busy" }) : undefined),
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
// GitHub rate limits (docs/03)
// ---------------------------------------------------------------------------

describe("runSync GitHub rate limits", () => {
  const exhausted = { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790276472" };
  const rateLimited = (status: number): Response =>
    json(status, { message: "API rate limit exceeded for user ID 1." }, exhausted);

  // A plain 403 was never retried; the 429 would have been, after DEFAULT_RETRY_DELAY_MS.
  for (const status of [403, 429]) {
    it(`does not retry a close answered ${String(status)} with x-ratelimit-remaining 0, records it and throws`, async () => {
      // Arrange
      const { deps, calls, sleeps } = harness({
        githubIssues: [ghIssue(12, "[YT-1] [team] Task 1"), ghIssue(13, "[YT-2] [team] Task 2")],
        youtrackRows: [ytRow(1, { resolved: RESOLVED_AT }), ytRow(2, { resolved: RESOLVED_AT })],
        override: (call) =>
          call.method === "PATCH" && call.url.pathname.endsWith("/12") ? rateLimited(status) : undefined,
      });

      // Act
      const error = await rejection(runSync(config(), deps));

      // Assert
      assert.ok(error instanceof SyncFailedError);
      assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/12`, `PATCH ${ISSUES_PATH}/13`]);
      const expected = new RegExp(`^close YT-1 #12 failed: PATCH .* -> HTTP ${String(status)}: .*API rate limit exceeded`);
      assert.match(error.failures[0] ?? "", expected);
      assert.deepEqual(error.summary, summary({ scanned: 2, closed: 1, failed: 1, fetches: 4 }));
      assert.deepEqual(sleeps, [WRITE_PAUSE_MS]);
    });
  }

  it("does not retry a label re-add answered 429 with x-ratelimit-remaining 0, and still closes", async () => {
    // Arrange
    const { deps, calls, sleeps } = harness({
      youtrackRows: [ytRow(1, { resolved: RESOLVED_AT })],
      createdLabels: [],
      override: (call) => (LABELS_PATH.test(call.url.pathname) ? rateLimited(429) : undefined),
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(writeCalls(calls), [
      `POST ${ISSUES_PATH}`,
      `POST ${ISSUES_PATH}/101/labels`,
      `PATCH ${ISSUES_PATH}/101`,
    ]);
    assert.match(error.failures[0] ?? "", /^label YT-1 #101 failed: POST .* -> HTTP 429/);
    assert.equal(error.summary.closed, 1);
    assert.deepEqual(sleeps, [WRITE_PAUSE_MS, WRITE_PAUSE_MS]);
  });

  it("retries a rate-limited close once when retry-after is short enough to wait for", async () => {
    // Arrange
    const { deps, calls, sleeps } = harness({
      githubIssues: [ghIssue(12, "[YT-1] [team] Task 1")],
      youtrackRows: [ytRow(1, { resolved: RESOLVED_AT })],
      override: (call, attempt) =>
        call.method === "PATCH" && attempt === 0
          ? json(403, { message: "secondary rate limit" }, { ...exhausted, "retry-after": "3" })
          : undefined,
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.equal(writeCalls(calls).length, 2);
    assert.equal(result.closed, 1);
    assert.equal(result.failed, 0);
    assert.deepEqual(sleeps, [3_000]);
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

  it("rethrows a YouTrack 400 and writes nothing", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      ...MIXED_WORLD,
      override: (call) =>
        call.url.origin === YOUTRACK_BASE_URL ? json(400, { error: "invalid_query", error_description: "bad" }) : undefined,
    });

    // Act
    const error = await rejection(runSync(config({ dryRun: true }), deps));

    // Assert
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 400);
    assert.deepEqual(writeCalls(calls), []);
    const failed = formatSummary(summary({ dryRun: true, fetches: 2 }), "failed");
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
      isCreate(call) && titleOf(call).startsWith("[YT-2]")
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
    assert.ok(messages(lines).includes("[dry-run] would create YT-1: [YT-1] [team] leaked [redacted]"));
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
