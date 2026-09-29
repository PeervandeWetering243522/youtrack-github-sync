import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MIRROR_LABEL } from "../src/github/client.ts";
import { USER_AGENT } from "../src/http.ts";
import { formatSummary, runSync, SyncFailedError, WRITE_PAUSE_MS } from "../src/sync.ts";
import {
  bodyOf,
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
} from "./sync-harness.ts";

// ---------------------------------------------------------------------------
// formatSummary
// ---------------------------------------------------------------------------

describe("formatSummary", () => {
  const sample = summary({
    dryRun: true,
    scanned: 29,
    filtered: 19,
    unchanged: 4,
    created: 5,
    closed: 3,
    updated: 6,
    milestonesCreated: 2,
    milestonesClosed: 1,
    labelsReAdded: 7,
    fetches: 8,
  });

  it("prints the headline counts, then the breakdown, then dryRun (decision R5, docs/11 §1.7)", () => {
    // Act
    const line = formatSummary(sample, "ok");

    // Assert
    assert.equal(
      line,
      "yt-gh-sync ok scanned=29 created=5 closed=3 updated=6 milestonesCreated=2 milestonesClosed=1 skipped=23 capped=0 failed=0 filtered=19 unchanged=4 labelsReAdded=7 fetches=8 dryRun=true",
    );
  });

  it("prints the failed outcome and non-zero failure counts", () => {
    // Act
    const line = formatSummary({ ...sample, dryRun: false, failed: 2, capped: 1 }, "failed");

    // Assert
    assert.match(line, /^yt-gh-sync failed scanned=29 /);
    assert.match(line, / skipped=23 capped=1 failed=2 /);
    assert.match(line, / dryRun=false$/);
  });
});

describe("runSync summary", () => {
  it("counts skipped as filtered plus unchanged", async () => {
    // Arrange: MIXED_WORLD has one issue without the prefix and three that need nothing
    // (YT-2 is resolved without a mirror, decision R9).
    const { deps } = harness(MIXED_WORLD);

    // Act
    const result = await runSync(config({ dryRun: true }), deps);

    // Assert
    assert.equal(result.filtered, 1);
    assert.equal(result.unchanged, 3);
    assert.equal(result.skipped, 4);
  });
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

describe("runSync in dry run", () => {
  it("sends only GETs and still reports what would be created and closed", async () => {
    // Arrange
    const { deps, calls } = harness(MIXED_WORLD);

    // Act
    const result = await runSync(config({ dryRun: true }), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), []);
    assert.ok(calls.every((call) => call.method === "GET"));
    // Three reads: GitHub issues, GitHub milestones, the YouTrack scan.
    assert.deepEqual(
      result,
      summary({ dryRun: true, scanned: 6, filtered: 1, unchanged: 3, created: 1, closed: 1, fetches: 3 }),
    );
  });

  it("logs each intended write with its title, then the ok summary", async () => {
    // Arrange
    const { deps, lines } = harness(MIXED_WORLD);

    // Act
    const result = await runSync(config({ dryRun: true }), deps);

    // Assert
    assert.deepEqual(messages(lines), [
      "[dry-run] would create YT-1: [YT-1] [team] Task 1",
      "[dry-run] would close YT-3 #12",
      formatSummary(result, "ok"),
    ]);
    assert.equal(lastLine(lines).level, "info");
  });

  it("never sleeps, since nothing is written", async () => {
    // Arrange
    const { deps, sleeps } = harness(MIXED_WORLD);

    // Act
    await runSync(config({ dryRun: true }), deps);

    // Assert
    assert.deepEqual(sleeps, []);
  });

  it("applies the write cap to the preview as well", async () => {
    // Arrange: the YT-1 create fits; the YT-3 close does not.
    const { deps, calls, lines } = harness(MIXED_WORLD);

    // Act
    const result = await runSync(config({ dryRun: true, maxWritesPerRun: 1 }), deps);

    // Assert
    assert.equal(result.created, 1);
    assert.equal(result.closed, 0);
    assert.equal(result.capped, 1);
    assert.deepEqual(writeCalls(calls), []);
    assert.ok(!messages(lines).some((line) => line.includes("would close")));
  });
});

// ---------------------------------------------------------------------------
// Real mode
// ---------------------------------------------------------------------------

describe("runSync with writes enabled", () => {
  it("creates unresolved issues, closes open mirrors of resolved ones, oldest first", async () => {
    // Arrange
    const { deps, calls } = harness(MIXED_WORLD);

    // Act
    const result = await runSync(config(), deps);

    // Assert: YT-2 (resolved, no mirror) gets no mirror (decision R9).
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`, `PATCH ${ISSUES_PATH}/12`]);
    assert.deepEqual(calls.filter(isCreate).map(titleOf), ["[YT-1] [team] Task 1"]);
    assert.deepEqual(result, summary({ scanned: 6, filtered: 1, unchanged: 3, created: 1, closed: 1, fetches: 5 }));
  });

  it("reads GitHub issues, then GitHub milestones, then YouTrack, before any write", async () => {
    // Arrange
    const { deps, calls } = harness(MIXED_WORLD);

    // Act
    await runSync(config(), deps);

    // Assert
    const reads = calls.slice(0, 3).map((call) => `${call.method} ${call.url.origin}${call.url.pathname}`);
    assert.deepEqual(reads, [
      `GET ${GITHUB_ORIGIN}${ISSUES_PATH}`,
      `GET ${GITHUB_ORIGIN}${MILESTONES_PATH}`,
      `GET ${YOUTRACK_BASE_URL}/api/issues`,
    ]);
    const milestones = calls[1];
    assert.ok(milestones, "expected the milestones read");
    assert.equal(milestones.url.searchParams.get("state"), "all");
    assert.equal(milestones.url.searchParams.get("per_page"), "100");
  });

  it("never creates a mirror for an issue that is already resolved (R9)", async () => {
    // Arrange
    const { deps, calls, lines } = harness({ youtrackRows: [ytRow(1, { resolved: RESOLVED_AT }), ytRow(2)] });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(calls.filter(isCreate).map(titleOf), ["[YT-2] [team] Task 2"]);
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`]);
    assert.equal(result.unchanged, 1);
    assert.ok(!messages(lines).some((line) => line.includes("YT-1")));
  });

  it("sends the mirror title, body and label on create and completed on close", async () => {
    // Arrange
    const { deps, calls } = harness(MIXED_WORLD);

    // Act
    await runSync(config(), deps);

    // Assert
    const create = bodyOf(calls.find(isCreate));
    assert.equal(create["title"], "[YT-1] [team] Task 1");
    assert.deepEqual(create["labels"], [MIRROR_LABEL]);
    assert.equal(create["body"], `Details of task 1\n\n---\nMirrored from YouTrack: ${YOUTRACK_BASE_URL}/issue/CUI-1`);
    const close = bodyOf(calls.find((call) => call.method === "PATCH"));
    assert.deepEqual(close, { state: "closed", state_reason: "completed" });
  });

  it("logs one line per write and ends with the ok summary", async () => {
    // Arrange
    const { deps, lines } = harness(MIXED_WORLD);

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(messages(lines), ["create YT-1 -> #101", "close YT-3 #12", formatSummary(result, "ok")]);
  });

  it("pauses WRITE_PAUSE_MS between writes, not before the first one", async () => {
    // Arrange
    const { deps, sleeps } = harness({
      ...MIXED_WORLD,
      youtrackRows: [...(MIXED_WORLD.youtrackRows ?? []), ytRow(7), ytRow(8)],
    });

    // Act
    await runSync(config(), deps);

    // Assert: 4 writes (YT-1, YT-3, YT-7, YT-8), 3 gaps.
    assert.deepEqual(sleeps, [WRITE_PAUSE_MS, WRITE_PAUSE_MS, WRITE_PAUSE_MS]);
  });

  it("does not sleep at all for a single write", async () => {
    // Arrange
    const { deps, sleeps, calls } = harness({ youtrackRows: [ytRow(1)] });

    // Act
    await runSync(config(), deps);

    // Assert
    assert.equal(writeCalls(calls).length, 1);
    assert.deepEqual(sleeps, []);
  });

  it("sends YouTrack only GET /api/issues with the project query and its own token", async () => {
    // Arrange
    const { deps, calls } = harness(MIXED_WORLD);

    // Act
    await runSync(config(), deps);

    // Assert
    const youtrackCalls = calls.filter((call) => call.url.origin === YOUTRACK_BASE_URL);
    assert.equal(youtrackCalls.length, 1);
    for (const call of youtrackCalls) {
      assert.equal(call.method, "GET");
      assert.equal(call.url.pathname, "/api/issues");
      assert.equal(call.url.searchParams.get("query"), "project: CUI sort by: {issue id} asc");
      assert.equal(call.headers.get("authorization"), `Bearer ${YOUTRACK_TOKEN}`);
    }
  });

  it("sends the GitHub token only to GitHub and a User-Agent on every call", async () => {
    // Arrange
    const { deps, calls } = harness(MIXED_WORLD);

    // Act
    await runSync(config(), deps);

    // Assert
    for (const call of calls) {
      const expectedToken = call.url.origin === GITHUB_ORIGIN ? GITHUB_TOKEN : YOUTRACK_TOKEN;
      assert.equal(call.headers.get("authorization"), `Bearer ${expectedToken}`);
      assert.equal(call.headers.get("user-agent"), USER_AGENT);
    }
    assert.ok(calls.every((call) => call.url.origin === GITHUB_ORIGIN || call.url.origin === YOUTRACK_BASE_URL));
  });

  it("scans every YouTrack page until a short one", async () => {
    // Arrange: 101 rows = a full page of 100 plus a page of 1.
    const rows = Array.from({ length: 101 }, (_, index) => ytRow(index + 1, { summary: "no prefix" }));
    const { deps, calls } = harness({ youtrackRows: rows });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    const skips = calls
      .filter((call) => call.url.origin === YOUTRACK_BASE_URL)
      .map((call) => call.url.searchParams.get("$skip"));
    assert.deepEqual(skips, ["0", "100"]);
    assert.equal(result.scanned, 101);
    assert.equal(result.filtered, 101);
  });

  it("logs mirror index warnings and treats an unlabelled title match as the mirror", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      githubIssues: [ghIssue(20, "[YT-1] [team] Task 1", { labels: [] })],
      youtrackRows: [ytRow(1)],
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), []);
    assert.equal(result.unchanged, 1);
    const warnings = messages(lines, "warn");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /YT-1: #20 matched by title only/);
  });

  it("mirrors only summaries starting with the configured prefix, ignoring case", async () => {
    // Arrange
    const { deps, calls } = harness({
      youtrackRows: [
        ytRow(1, { summary: "[OPS] Deploy" }),
        ytRow(2, { summary: "[team] Not ours" }),
        ytRow(3, { summary: "ops: missing brackets" }),
        ytRow(4, { summary: "  [ops] leading spaces" }),
      ],
    });

    // Act
    const result = await runSync(config({ titlePrefix: "[ops]" }), deps);

    // Assert
    assert.deepEqual(calls.filter(isCreate).map(titleOf), ["[YT-1] [OPS] Deploy", "[YT-4] [ops] leading spaces"]);
    assert.equal(result.filtered, 2);
    assert.equal(result.created, 2);
  });
});

// ---------------------------------------------------------------------------
// Label re-add (decision A5)
// ---------------------------------------------------------------------------

/** YT-1 unresolved without a mirror (create #101), then YT-2 resolved with open mirror #50 (close). */
const CREATE_THEN_CLOSE = {
  githubIssues: [ghIssue(50, "[YT-2] [team] Task 2")],
  youtrackRows: [ytRow(1), ytRow(2, { resolved: RESOLVED_AT })],
};

describe("runSync label re-add", () => {
  it("re-adds the label when the 201 lacks it, before the next action", async () => {
    // Arrange
    const { deps, calls, lines } = harness({ ...CREATE_THEN_CLOSE, createdLabels: [] });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [
      `POST ${ISSUES_PATH}`,
      `POST ${ISSUES_PATH}/101/labels`,
      `PATCH ${ISSUES_PATH}/50`,
    ]);
    assert.deepEqual(bodyOf(calls.find((call) => LABELS_PATH.test(call.url.pathname))), { labels: [MIRROR_LABEL] });
    assert.equal(result.labelsReAdded, 1);
    assert.equal(result.closed, 1);
    assert.ok(messages(lines).includes("label YT-1 #101"));
  });

  it("accepts the label in another case without re-adding it", async () => {
    // Arrange
    const { deps, calls } = harness({ youtrackRows: [ytRow(1)], createdLabels: ["YouTrack"] });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`]);
    assert.equal(result.labelsReAdded, 0);
  });

  it("skips the re-add with a warning when the create used the last write", async () => {
    // Arrange
    const { deps, calls, lines } = harness({ youtrackRows: [ytRow(1)], createdLabels: [] });

    // Act
    const result = await runSync(config({ maxWritesPerRun: 1 }), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`]);
    assert.equal(result.labelsReAdded, 0);
    assert.equal(result.created, 1);
    assert.equal(result.capped, 0);
    assert.match(messages(lines, "warn")[0] ?? "", /YT-1 #101 was created without the "youtrack" label .*write cap/);
  });

  it("counts the re-add as a write, which can cap a later action", async () => {
    // Arrange
    const { deps, calls } = harness({ youtrackRows: [ytRow(1), ytRow(2)], createdLabels: [] });

    // Act
    const result = await runSync(config({ maxWritesPerRun: 2 }), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`, `POST ${ISSUES_PATH}/101/labels`]);
    assert.equal(result.created, 1);
    assert.equal(result.labelsReAdded, 1);
    assert.equal(result.capped, 1);
  });

  it("records a failed re-add, still runs the next action, and fails the run", async () => {
    // Arrange
    const { deps, calls } = harness({
      ...CREATE_THEN_CLOSE,
      createdLabels: [],
      override: (call) =>
        LABELS_PATH.test(call.url.pathname) ? json(422, { message: "Label does not exist" }) : undefined,
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.equal(error.failures.length, 1);
    assert.match(error.failures[0] ?? "", /^label YT-1 #101 failed: POST .* -> HTTP 422/);
    assert.equal(error.summary.closed, 1);
    assert.deepEqual(writeCalls(calls).at(-1), `PATCH ${ISSUES_PATH}/50`);
  });
});
