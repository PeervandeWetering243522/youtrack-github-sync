import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_MAX_FETCHES, DEFAULT_RETRY_DELAY_MS } from "../src/http.ts";
import { formatSummary, runSync, SyncFailedError } from "../src/sync.ts";
import {
  config,
  harness,
  isCreate,
  ISSUES_PATH,
  json,
  LABELS_PATH,
  LAST_EXISTING_NUMBER,
  lastLine,
  messages,
  openMirrorsOfResolved,
  pauses,
  rejection,
  RESOLVED_AT,
  summary,
  writeCalls,
  ytRow,
} from "./sync-harness.ts";
import type { Override } from "./sync-harness.ts";

// Workers Free allows 50 subrequests; the client allows DEFAULT_MAX_FETCHES (45).

/** Every PATCH fails once with a 502 and succeeds on the retry: 2 fetches per close. */
const flakyPatch: Override = (call, attempt) =>
  call.method === "PATCH" && attempt === 0 ? json(502, { message: "Bad Gateway" }) : undefined;

const guardWarning = `fetch guard of ${String(DEFAULT_MAX_FETCHES)} reached`;

describe("runSync fetch guard", () => {
  it("caps the remaining actions instead of failing when the budget runs out before a write", async () => {
    // Arrange: 2 reads + 21 closes x 2 fetches = 44; the YT-22 create takes the 45th, so the
    // YT-23 close cannot even start: it and the two closes after it are capped.
    const world = openMirrorsOfResolved(25);
    const { deps, calls, lines } = harness({
      githubIssues: world.githubIssues.filter((issue) => issue["number"] !== LAST_EXISTING_NUMBER + 22),
      youtrackRows: world.youtrackRows.map((row) => (row["numberInProject"] === 22 ? ytRow(22) : row)),
      override: flakyPatch,
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.equal(calls.length, DEFAULT_MAX_FETCHES);
    assert.deepEqual(result, summary({ scanned: 25, created: 1, closed: 21, capped: 3, fetches: DEFAULT_MAX_FETCHES }));
    assert.ok(messages(lines, "warn").some((line) => line.includes(guardWarning)));
    assert.equal(lastLine(lines).level, "info");
  });

  it("records a close whose retry the budget cannot pay for as failed, caps the rest and throws", async () => {
    // Arrange: 2 reads + 21 closes x 2 fetches = 44; the YT-22 close spends the 45th on a 502
    // and cannot retry. It really failed (decision A10); YT-23..25 are capped.
    const { deps, calls, lines, sleeps } = harness({ ...openMirrorsOfResolved(25), override: flakyPatch });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.equal(calls.length, DEFAULT_MAX_FETCHES);
    assert.equal(error.failures.length, 1);
    assert.match(error.failures[0] ?? "", /^close YT-22 #122 failed: PATCH .*\/issues\/122 -> HTTP 502/);
    assert.deepEqual(
      error.summary,
      summary({ scanned: 25, closed: 21, capped: 3, failed: 1, fetches: DEFAULT_MAX_FETCHES }),
    );
    // 21 retries waited for; the unaffordable one was not.
    assert.equal(sleeps.filter((ms) => ms === DEFAULT_RETRY_DELAY_MS).length, 21);
    assert.ok(messages(lines, "warn").some((line) => line.includes(guardWarning)));
    assert.deepEqual(lastLine(lines), { level: "error", message: formatSummary(error.summary, "failed") });
  });

  it("records a label re-add whose retry the budget cannot pay for as failed", async () => {
    // Arrange: closes #101..#120 need a retry, #121 does not: 2 + 40 + 1 = 43 fetches. The YT-22
    // create takes the 44th; its label re-add spends the 45th on a 502 and cannot retry.
    const world = openMirrorsOfResolved(21);
    const lastClosePath = `/${String(LAST_EXISTING_NUMBER + 21)}`;
    const { deps, lines } = harness({
      githubIssues: world.githubIssues,
      youtrackRows: [...world.youtrackRows, ytRow(22)],
      createdLabels: [],
      override: (call, attempt) => {
        if (LABELS_PATH.test(call.url.pathname)) return json(502, { message: "Bad Gateway" });
        return call.url.pathname.endsWith(lastClosePath) ? undefined : flakyPatch(call, attempt);
      },
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.match(error.failures[0] ?? "", /^label YT-22 #101 failed: POST .* -> HTTP 502/);
    assert.deepEqual(
      error.summary,
      summary({ scanned: 22, created: 1, closed: 21, failed: 1, fetches: DEFAULT_MAX_FETCHES }),
    );
    assert.ok(!messages(lines, "warn").some((line) => line.includes("not re-added (fetch guard reached)")));
  });

  it("caps a create+close pair whose close no longer fits, and does not pause for it", async () => {
    // Arrange: 44 fetches for 21 closes, the YT-22 create takes the 45th.
    const world = openMirrorsOfResolved(21);
    const { deps, sleeps } = harness({
      githubIssues: world.githubIssues,
      youtrackRows: [...world.youtrackRows, ytRow(22, { resolved: RESOLVED_AT })],
      override: flakyPatch,
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(result, summary({ scanned: 22, created: 1, closed: 21, capped: 1, fetches: DEFAULT_MAX_FETCHES }));
    // 22 writes were sent (21 gaps); the refused close gets no pause.
    assert.equal(pauses(sleeps), 21);
  });

  it("caps a create the budget refuses, sends nothing for it and still ends ok", async () => {
    // Arrange: closes #101..#121 need a retry, #122 does not: 2 + 42 + 1 = 45 fetches, so the
    // YT-23 create is refused before anything is sent.
    const world = openMirrorsOfResolved(22);
    const lastClosePath = `/${String(LAST_EXISTING_NUMBER + 22)}`;
    const { deps, calls, lines } = harness({
      githubIssues: world.githubIssues,
      youtrackRows: [...world.youtrackRows, ytRow(23)],
      override: (call, attempt) => (call.url.pathname.endsWith(lastClosePath) ? undefined : flakyPatch(call, attempt)),
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.equal(calls.length, DEFAULT_MAX_FETCHES);
    assert.ok(!calls.some(isCreate), "no create may be sent");
    assert.deepEqual(result, summary({ scanned: 23, closed: 22, capped: 1, fetches: DEFAULT_MAX_FETCHES }));
    assert.ok(messages(lines, "warn").some((line) => line.includes(guardWarning)));
    assert.equal(lastLine(lines).level, "info");
  });

  it("skips and caps the pending close when the budget refuses the label re-add", async () => {
    // Arrange: 2 reads + 21 closes x 2 fetches = 44; the YT-22 create takes the 45th and comes
    // back without the label, so the re-add is refused, and the close after it must not be tried.
    const world = openMirrorsOfResolved(21);
    const { deps, calls, lines } = harness({
      githubIssues: world.githubIssues,
      youtrackRows: [...world.youtrackRows, ytRow(22, { resolved: RESOLVED_AT })],
      createdLabels: [],
      override: flakyPatch,
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.equal(calls.length, DEFAULT_MAX_FETCHES);
    assert.equal(writeCalls(calls).at(-1), `POST ${ISSUES_PATH}`);
    assert.deepEqual(result, summary({ scanned: 22, created: 1, closed: 21, capped: 1, fetches: DEFAULT_MAX_FETCHES }));
    const warnings = messages(lines, "warn");
    assert.ok(warnings.some((line) => /YT-22 #\d+ .*not re-added \(fetch guard reached\)/.test(line)));
    assert.ok(warnings.some((line) => line.includes(guardWarning)));
    assert.equal(lastLine(lines).level, "info");
  });

  it("warns when the budget runs out on a label re-add with no close pending", async () => {
    // Arrange
    const world = openMirrorsOfResolved(21);
    const { deps, lines } = harness({
      githubIssues: world.githubIssues,
      youtrackRows: [...world.youtrackRows, ytRow(22)],
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
    assert.ok(messages(lines, "warn").some((line) => /YT-22 #101 .*not re-added \(fetch guard reached\)/.test(line)));
  });
});
