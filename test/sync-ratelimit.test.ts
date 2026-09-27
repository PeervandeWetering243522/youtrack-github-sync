import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatSummary, runSync, SyncFailedError, WRITE_PAUSE_MS } from "../src/sync.ts";
import {
  config,
  ghIssue,
  harness,
  isCreate,
  ISSUES_PATH,
  json,
  LABELS_PATH,
  lastLine,
  messages,
  rejection,
  RESOLVED_AT,
  summary,
  titleOf,
  writeCalls,
  ytRow,
} from "./sync-harness.ts";
import type { Override, World } from "./sync-harness.ts";

// A write GitHub rate-limits is recorded as failed and stops the write phase; the rest is
// capped (decision R7). Retrying or continuing while limited risks the integration (docs/03).

const exhausted = { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790276472" };
const primaryLimit = (status: number): Response =>
  json(status, { message: "API rate limit exceeded for user ID 1." }, exhausted);
const rateLimitWarning = /^GitHub rate limit hit; \d+ more action\(s\) capped$/;

/** Open mirrors #12 and #13 of resolved YT-1 and YT-2: two closes. */
const twoCloses: World = {
  githubIssues: [ghIssue(12, "[YT-1] [team] Task 1"), ghIssue(13, "[YT-2] [team] Task 2")],
  youtrackRows: [ytRow(1, { resolved: RESOLVED_AT }), ytRow(2, { resolved: RESOLVED_AT })],
};

describe("runSync GitHub rate limits: closes", () => {
  // A plain 403 was never retried; the 429 would have been, after DEFAULT_RETRY_DELAY_MS.
  for (const status of [403, 429]) {
    it(`stops after a close answered ${String(status)} with x-ratelimit-remaining 0, caps the rest and throws`, async () => {
      // Arrange
      const { deps, calls, lines, sleeps } = harness({
        ...twoCloses,
        override: (call) => (call.method === "PATCH" && call.url.pathname.endsWith("/12") ? primaryLimit(status) : undefined),
      });

      // Act
      const error = await rejection(runSync(config(), deps));

      // Assert
      assert.ok(error instanceof SyncFailedError);
      assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/12`]);
      const expected = new RegExp(`^close YT-1 #12 failed: PATCH .* -> HTTP ${String(status)}: .*API rate limit exceeded`);
      assert.match(error.failures[0] ?? "", expected);
      assert.deepEqual(error.summary, summary({ scanned: 2, capped: 1, failed: 1, fetches: 3 }));
      assert.deepEqual(sleeps, []);
      assert.deepEqual(messages(lines, "warn"), ["GitHub rate limit hit; 1 more action(s) capped"]);
      assert.deepEqual(lastLine(lines), { level: "error", message: formatSummary(error.summary, "failed") });
    });
  }

  it("keeps going after a plain 403 without rate-limit signals", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      ...twoCloses,
      override: (call) =>
        call.url.pathname.endsWith("/12") ? json(403, { message: "Resource not accessible by integration" }) : undefined,
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/12`, `PATCH ${ISSUES_PATH}/13`]);
    assert.deepEqual(error.summary, summary({ scanned: 2, closed: 1, failed: 1, fetches: 4 }));
    assert.ok(!messages(lines, "warn").some((line) => rateLimitWarning.test(line)));
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

describe("runSync GitHub rate limits: creates", () => {
  /** YT-1 and YT-2 need a create, YT-3 a close of #12. */
  const mixed: World = {
    githubIssues: [ghIssue(12, "[YT-3] [team] Task 3")],
    youtrackRows: [ytRow(1), ytRow(2), ytRow(3, { resolved: RESOLVED_AT })],
  };
  const onFirstCreate =
    (response: () => Response): Override =>
    (call) =>
      isCreate(call) && titleOf(call).startsWith("[YT-1]") ? response() : undefined;

  it("stops after a create answered 403 with retry-after 60 and caps the rest", async () => {
    // Arrange
    const limited = (): Response => json(403, { message: "You have exceeded a secondary rate limit." }, { "retry-after": "60" });
    const { deps, calls, lines } = harness({ ...mixed, override: onFirstCreate(limited) });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`]);
    assert.match(error.failures[0] ?? "", /^create YT-1 failed: POST .* -> HTTP 403/);
    assert.deepEqual(error.summary, summary({ scanned: 3, capped: 2, failed: 1, fetches: 3 }));
    assert.deepEqual(messages(lines, "warn"), ["GitHub rate limit hit; 2 more action(s) capped"]);
  });

  it("stops after a secondary-limit 403 that carries no rate-limit headers", async () => {
    // Arrange
    const limited = (): Response => json(403, { message: "You have exceeded a secondary rate limit." });
    const { deps, calls } = harness({ ...mixed, override: onFirstCreate(limited) });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`]);
    assert.equal(error.summary.capped, 2);
  });

  it("stops after the close of a create+close pair is rate-limited", async () => {
    // Arrange: YT-1 is resolved, so its create is followed by a close of #101.
    const { deps, calls } = harness({
      youtrackRows: [ytRow(1, { resolved: RESOLVED_AT }), ytRow(2)],
      override: (call) => (call.method === "PATCH" ? primaryLimit(403) : undefined),
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`, `PATCH ${ISSUES_PATH}/101`]);
    assert.deepEqual(error.summary, summary({ scanned: 2, created: 1, capped: 1, failed: 1, fetches: 4 }));
  });
});

describe("runSync GitHub rate limits: label re-adds", () => {
  const limitedLabels: Override = (call) => (LABELS_PATH.test(call.url.pathname) ? primaryLimit(429) : undefined);

  it("skips the pending close when the re-add is rate-limited, and caps it", async () => {
    // Arrange
    const { deps, calls, sleeps } = harness({
      youtrackRows: [ytRow(1, { resolved: RESOLVED_AT })],
      createdLabels: [],
      override: limitedLabels,
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`, `POST ${ISSUES_PATH}/101/labels`]);
    assert.match(error.failures[0] ?? "", /^label YT-1 #101 failed: POST .* -> HTTP 429/);
    assert.deepEqual(error.summary, summary({ scanned: 1, created: 1, capped: 1, failed: 1, fetches: 4 }));
    assert.deepEqual(sleeps, [WRITE_PAUSE_MS]);
  });

  it("caps the later actions when a re-add with no close pending is rate-limited", async () => {
    // Arrange
    const { deps, calls } = harness({ youtrackRows: [ytRow(1), ytRow(2)], createdLabels: [], override: limitedLabels });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`, `POST ${ISSUES_PATH}/101/labels`]);
    assert.deepEqual(error.summary, summary({ scanned: 2, created: 1, capped: 1, failed: 1, fetches: 4 }));
  });
});
