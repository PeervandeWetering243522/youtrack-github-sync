import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HttpError } from "../../src/http.ts";
import { IncompleteIssueListError } from "../../src/plan/list-check.ts";
import { formatSummary, runSync } from "../../src/sync.ts";
import {
  config,
  ghIssue,
  harness,
  ISSUES_PATH,
  json,
  lastLine,
  MILESTONES_PATH,
  rejection,
  REPO_PATH,
  RESOLVED_AT,
  summary,
  writeCalls,
  ytRow,
} from "./fixtures.ts";
import type { Override, World } from "./fixtures.ts";

const CLOSED_MIRROR = ghIssue(13, "[CUI-2] [team] Task 2", { state: "closed" });

/** CUI-1 is unresolved and already has its open mirror #12; CUI-2 is resolved with closed mirror #13. */
const MIRRORED: World = {
  githubIssues: [ghIssue(12, "[CUI-1] [team] Task 1"), CLOSED_MIRROR],
  youtrackRows: [ytRow(1), ytRow(2, { resolved: RESOLVED_AT })],
};

/** Answers the issue list with `issues` instead of the world's own list, as GitHub did on 2026-10-22. */
function listAnswers(issues: World["githubIssues"]): Override {
  return (call) =>
    call.method === "GET" && call.url.pathname === ISSUES_PATH ? json(200, [...(issues ?? [])]) : undefined;
}

/** "GET /repos/acme/mirror/issues" etc. for every call, in order. */
function requestLines(calls: ReturnType<typeof harness>["calls"]): readonly string[] {
  return calls.map((call) => `${call.method} ${call.url.pathname}`);
}

describe("runSync issue list check (R11)", () => {
  it("reads the repository right after the issue list, before the milestones and YouTrack", async () => {
    // Arrange
    const { deps, calls } = harness(MIRRORED);

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(requestLines(calls), [
      `GET ${ISSUES_PATH}`,
      `GET ${REPO_PATH}`,
      `GET ${MILESTONES_PATH}`,
      "GET /api/issues",
    ]);
    assert.deepEqual(result, summary({ scanned: 2, unchanged: 2, fetches: 4 }));
  });

  it("creates no duplicate when GitHub answers the list without an open mirror, and fails the run", async () => {
    // Arrange: the list comes back 200 without #12, while the repository still reports it open.
    const { deps, calls, lines } = harness({ ...MIRRORED, override: listAnswers([CLOSED_MIRROR]) });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof IncompleteIssueListError);
    assert.equal(error.listed, 0);
    assert.equal(error.reported, 1);
    assert.deepEqual(writeCalls(calls), []);
    assert.deepEqual(requestLines(calls), [`GET ${ISSUES_PATH}`, `GET ${REPO_PATH}`]);
    assert.deepEqual(lastLine(lines), { level: "error", message: formatSummary(summary({ fetches: 2 }), "failed") });
  });

  it("fails an empty list of a repository with open issues the same way", async () => {
    // Arrange
    const { deps, calls } = harness({ ...MIRRORED, override: listAnswers([]) });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof IncompleteIssueListError);
    assert.deepEqual(writeCalls(calls), []);
  });

  it("fails a dry run too, so its preview never shows a duplicate create", async () => {
    // Arrange
    const { deps, lines } = harness({ ...MIRRORED, override: listAnswers([]) });

    // Act
    const error = await rejection(runSync(config({ dryRun: true }), deps));

    // Assert
    assert.ok(error instanceof IncompleteIssueListError);
    const failed = formatSummary(summary({ dryRun: true, fetches: 2 }), "failed");
    assert.deepEqual(lastLine(lines), { level: "error", message: failed });
  });

  it("carries on when the list holds more open items than the repository reports", async () => {
    // Arrange: an issue opened between the two reads; the count is the older one.
    const { deps, calls } = harness({ ...MIRRORED, openIssuesCount: 0 });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), []);
    assert.deepEqual(result, summary({ scanned: 2, unchanged: 2, fetches: 4 }));
  });

  it("rethrows a failed repository read after a failed summary, before touching the milestones", async () => {
    // Arrange: 502 on the first attempt and on the retry.
    const override: Override = (call) =>
      call.url.pathname === REPO_PATH ? json(502, { message: "Server Error" }) : undefined;
    const { deps, calls, lines } = harness({ ...MIRRORED, override });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 502);
    assert.deepEqual(requestLines(calls), [`GET ${ISSUES_PATH}`, `GET ${REPO_PATH}`, `GET ${REPO_PATH}`]);
    assert.deepEqual(lastLine(lines), { level: "error", message: formatSummary(summary({ fetches: 3 }), "failed") });
  });
});
