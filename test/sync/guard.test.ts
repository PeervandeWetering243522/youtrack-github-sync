import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_MAX_FETCHES, DEFAULT_RETRY_DELAY_MS } from "../../src/http.ts";
import { formatSummary, runSync, SyncFailedError } from "../../src/sync.ts";
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
  MILESTONES_PATH,
  openMilestonesOfResolvedEpics,
  openMirrorsOfResolved,
  pauses,
  rejection,
  summary,
  writeCalls,
  ytRow,
} from "./fixtures.ts";
import type { Override } from "./fixtures.ts";

// Workers Free allows 50 subrequests; the client allows DEFAULT_MAX_FETCHES (45). Every run
// reads 4 times (GitHub issues, the repository, GitHub milestones, YouTrack). Milestone writes
// run first, then creates, then closes (docs/11 §1.4).

/** Every PATCH (issue or milestone close) fails once with a 502 and succeeds on the retry: 2 fetches each. */
const flakyPatch: Override = (call, attempt) =>
  call.method === "PATCH" && attempt === 0 ? json(502, { message: "Bad Gateway" }) : undefined;

/** flakyPatch, except for milestone #n, which succeeds at once (1 fetch). */
const flakyPatchExceptMilestone =
  (milestoneNumber: number): Override =>
  (call, attempt) =>
    call.url.pathname === `${MILESTONES_PATH}/${String(milestoneNumber)}` ? undefined : flakyPatch(call, attempt);

const guardWarning = `fetch guard of ${String(DEFAULT_MAX_FETCHES)} reached`;

describe("runSync fetch guard", () => {
  it("caps the remaining actions instead of failing when the budget runs out before a write", async () => {
    // Arrange: 4 reads + the CUI-24 create = 5; 20 closes x 2 fetches = 45, so the CUI-21 close
    // cannot even start: it and the two closes after it are capped.
    const world = openMirrorsOfResolved(23);
    const { deps, calls, lines } = harness({
      githubIssues: world.githubIssues,
      youtrackRows: [...world.youtrackRows, ytRow(24)],
      override: flakyPatch,
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.equal(calls.length, DEFAULT_MAX_FETCHES);
    assert.deepEqual(result, summary({ scanned: 24, created: 1, closed: 20, capped: 3, fetches: DEFAULT_MAX_FETCHES }));
    assert.ok(messages(lines, "warn").some((line) => line.includes(guardWarning)));
    assert.equal(lastLine(lines).level, "info");
  });

  it("records a close whose retry the budget cannot pay for as failed, caps the rest and throws", async () => {
    // Arrange: 4 reads + 20 closes x 2 fetches = 44; the CUI-21 close spends the 45th on a 502
    // and cannot retry. It really failed (decision A10); CUI-22..24 are capped.
    const world = openMirrorsOfResolved(24);
    const { deps, calls, lines, sleeps } = harness({
      githubIssues: world.githubIssues,
      youtrackRows: world.youtrackRows,
      override: flakyPatch,
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.equal(calls.length, DEFAULT_MAX_FETCHES);
    assert.equal(error.failures.length, 1);
    assert.match(error.failures[0] ?? "", /^close CUI-21 #121 failed: PATCH .*\/issues\/121 -> HTTP 502/);
    assert.deepEqual(
      error.summary,
      summary({ scanned: 24, closed: 20, capped: 3, failed: 1, fetches: DEFAULT_MAX_FETCHES }),
    );
    // 20 retries waited for; the unaffordable one was not.
    assert.equal(sleeps.filter((ms) => ms === DEFAULT_RETRY_DELAY_MS).length, 20);
    assert.ok(messages(lines, "warn").some((line) => line.includes(guardWarning)));
    assert.deepEqual(lastLine(lines), { level: "error", message: formatSummary(error.summary, "failed") });
  });

  it("records a label re-add whose retry the budget cannot pay for as failed", async () => {
    // Arrange: 4 reads + 19 milestone closes x 2 fetches + milestone #20 x 1 = 43. The CUI-21
    // create takes the 44th; its label re-add spends the 45th on a 502 and cannot retry.
    const world = openMilestonesOfResolvedEpics(20);
    const { deps, lines } = harness({
      milestones: world.milestones,
      youtrackRows: [...world.youtrackRows, ytRow(21)],
      createdLabels: [],
      override: (call, attempt) =>
        LABELS_PATH.test(call.url.pathname)
          ? json(502, { message: "Bad Gateway" })
          : flakyPatchExceptMilestone(20)(call, attempt),
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.match(error.failures[0] ?? "", /^label CUI-21 #101 failed: POST .* -> HTTP 502/);
    assert.deepEqual(
      error.summary,
      summary({ scanned: 21, created: 1, milestonesClosed: 20, failed: 1, fetches: DEFAULT_MAX_FETCHES }),
    );
    assert.ok(!messages(lines, "warn").some((line) => line.includes("not re-added (fetch guard reached)")));
  });

  it("caps the action after the budget ran out, and does not pause for it", async () => {
    // Arrange: 4 reads + the CUI-22 create = 5; 20 closes take the other 40, so the CUI-21
    // close is refused.
    const world = openMirrorsOfResolved(21);
    const { deps, sleeps } = harness({
      githubIssues: world.githubIssues,
      youtrackRows: [...world.youtrackRows, ytRow(22)],
      override: flakyPatch,
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(result, summary({ scanned: 22, created: 1, closed: 20, capped: 1, fetches: DEFAULT_MAX_FETCHES }));
    // 21 writes were sent (20 gaps); the refused close gets no pause.
    assert.equal(pauses(sleeps), 20);
  });

  it("caps a create the budget refuses, sends nothing for it and still ends ok", async () => {
    // Arrange: 4 reads + 20 milestone closes x 2 fetches + milestone #21 x 1 = 45, so the CUI-22
    // create is refused before anything is sent.
    const world = openMilestonesOfResolvedEpics(21);
    const { deps, calls, lines } = harness({
      milestones: world.milestones,
      youtrackRows: [...world.youtrackRows, ytRow(22)],
      override: flakyPatchExceptMilestone(21),
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.equal(calls.length, DEFAULT_MAX_FETCHES);
    assert.ok(!calls.some(isCreate), "no create may be sent");
    assert.deepEqual(result, summary({ scanned: 22, milestonesClosed: 21, capped: 1, fetches: DEFAULT_MAX_FETCHES }));
    assert.ok(messages(lines, "warn").some((line) => line.includes(guardWarning)));
    assert.equal(lastLine(lines).level, "info");
  });

  it("stops and caps the next action when the budget refuses the label re-add", async () => {
    // Arrange: 4 reads + 20 milestone closes x 2 fetches = 44; the CUI-21 create takes the 45th
    // and comes back without the label, so the re-add is refused, and the CUI-22 create must
    // not be tried.
    const world = openMilestonesOfResolvedEpics(20);
    const { deps, calls, lines } = harness({
      milestones: world.milestones,
      youtrackRows: [...world.youtrackRows, ytRow(21), ytRow(22)],
      createdLabels: [],
      override: flakyPatch,
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.equal(calls.length, DEFAULT_MAX_FETCHES);
    assert.equal(writeCalls(calls).at(-1), `POST ${ISSUES_PATH}`);
    assert.deepEqual(
      result,
      summary({ scanned: 22, created: 1, milestonesClosed: 20, capped: 1, fetches: DEFAULT_MAX_FETCHES }),
    );
    const warnings = messages(lines, "warn");
    assert.ok(warnings.some((line) => /CUI-21 #\d+ .*not re-added \(fetch guard reached\)/.test(line)));
    assert.ok(warnings.some((line) => line.includes(guardWarning)));
    assert.equal(lastLine(lines).level, "info");
  });

  it("warns when the budget runs out on a label re-add with no action left", async () => {
    // Arrange: as above, without CUI-22.
    const world = openMilestonesOfResolvedEpics(20);
    const { deps, lines } = harness({
      milestones: world.milestones,
      youtrackRows: [...world.youtrackRows, ytRow(21)],
      createdLabels: [],
      override: flakyPatch,
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.equal(result.created, 1);
    assert.equal(result.labelsReAdded, 0);
    assert.equal(result.capped, 0);
    assert.equal(result.failed, 0);
    assert.ok(messages(lines, "warn").some((line) => /CUI-21 #101 .*not re-added \(fetch guard reached\)/.test(line)));
  });

  it("caps a sub-issue move the budget refuses, like any other write", async () => {
    // Arrange: 4 reads + 20 milestone closes x 2 + milestone #21 x 1 = 45; the CUI-40 move under
    // #30 (its only action: #31 already has type Task and its title) is refused before anything
    // is sent.
    const world = openMilestonesOfResolvedEpics(21);
    const { deps, calls, lines, sleeps } = harness({
      milestones: world.milestones,
      githubIssues: [ghIssue(30, "[CUI-30] [team] Task 30"), ghIssue(31, "[CUI-40] [team] Task 40", { type: "Task" })],
      youtrackRows: [...world.youtrackRows, ytRow(30), ytRow(40, { type: "Task", parent: 30 })],
      override: flakyPatchExceptMilestone(21),
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert: 21 writes were sent (20 gaps); the refused move gets no pause.
    assert.equal(calls.length, DEFAULT_MAX_FETCHES);
    assert.ok(!calls.some((call) => call.url.pathname.endsWith("/sub_issues")));
    assert.deepEqual(
      result,
      summary({ scanned: 23, milestonesClosed: 21, unchanged: 1, capped: 1, fetches: DEFAULT_MAX_FETCHES }),
    );
    assert.equal(pauses(sleeps), 20);
    assert.ok(messages(lines, "warn").some((line) => line.includes(`${guardWarning}; 0 more action(s) capped`)));
    assert.equal(lastLine(lines).level, "info");
  });
});
