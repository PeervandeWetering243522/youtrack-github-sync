/**
 * runSync keeping mirror bodies and milestone descriptions in sync with YouTrack (decision N4),
 * end to end over the fake fetch: a changed description, or a body edited on GitHub, is written
 * back on open and closed mirrors alike, in the same PATCH as the other sync fields, and never
 * appears in a log line (R3). Milestone descriptions go in the milestone PATCH.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { JsonObject } from "../../src/json.ts";
import { formatMirror } from "../../src/mirror.ts";
import { formatSummary, runSync } from "../../src/sync.ts";
import { parseYouTrackIssue } from "../../src/youtrack.ts";
import {
  config,
  ghIssue,
  ghMilestone,
  harness,
  isRead,
  ISSUES_PATH,
  json,
  messages,
  MILESTONES_PATH,
  onlyBody,
  RESOLVED_AT,
  summary,
  writeCalls,
  YOUTRACK_BASE_URL,
  ytRow,
} from "./fixtures.ts";

/** Wording only YouTrack has, so a log line that carries the description is easy to spot. */
const NEW_TEXT = "Rewritten acceptance criteria, marker 7f3a";
const ROW = ytRow(5, { description: NEW_TEXT });
const EPIC_ROW = ytRow(33, { type: "Epic", summary: "[team] Epic 33", description: NEW_TEXT });

/** The body formatMirror makes of `row`: what the mirror should hold. */
function desiredBody(row: JsonObject): string {
  return formatMirror(parseYouTrackIssue(row), YOUTRACK_BASE_URL).body;
}

/** Mirror #21 of CUI-5 as GitHub lists it, with `body`. */
function mirrorWith(body: string | null, fields: JsonObject = {}): JsonObject {
  return { ...ghIssue(21, "[CUI-5] [team] Task 5"), body, ...fields };
}

describe("runSync body sync (N4)", () => {
  it("writes a changed YouTrack description to the mirror in one PATCH of only the body", async () => {
    // Arrange
    const { deps, calls, lines } = harness({ githubIssues: [mirrorWith("Old text")], youtrackRows: [ROW] });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/21`]);
    assert.deepEqual(onlyBody(calls, "PATCH", `${ISSUES_PATH}/21`), { body: desiredBody(ROW) });
    assert.deepEqual(result, summary({ scanned: 1, updated: 1, fetches: 5 }));
    assert.deepEqual(messages(lines), ["update CUI-5 #21: set body", formatSummary(result, "ok")]);
  });

  it("puts back a body edited or emptied on GitHub, on a closed mirror too, without reopening it", async () => {
    // Arrange
    const resolved = ytRow(5, { resolved: RESOLVED_AT });
    const { deps, calls } = harness({
      githubIssues: [
        mirrorWith("Edited on GitHub", { state: "closed" }),
        { ...ghIssue(22, "[CUI-6] [team] Task 6"), body: null },
      ],
      youtrackRows: [resolved, ytRow(6)],
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/21`, `PATCH ${ISSUES_PATH}/22`]);
    assert.deepEqual(onlyBody(calls, "PATCH", `${ISSUES_PATH}/21`), { body: desiredBody(resolved) });
    assert.deepEqual(onlyBody(calls, "PATCH", `${ISSUES_PATH}/22`), { body: desiredBody(ytRow(6)) });
    assert.deepEqual(result, summary({ scanned: 2, updated: 2, fetches: 6 }));
  });

  it("sends a new title and body in the same PATCH, one write", async () => {
    // Arrange
    const { deps, calls } = harness({
      githubIssues: [mirrorWith("Old text", { title: "[YT-5] [team] Task 5" })],
      youtrackRows: [ROW],
    });

    // Act
    const result = await runSync(config({ maxWritesPerRun: 1 }), deps);

    // Assert
    assert.deepEqual(onlyBody(calls, "PATCH", `${ISSUES_PATH}/21`), {
      title: "[CUI-5] [team] Task 5",
      body: desiredBody(ROW),
    });
    assert.deepEqual(result, summary({ scanned: 1, updated: 1, fetches: 5 }));
  });

  it("leaves a mirror whose body already matches alone", async () => {
    // Arrange
    const { deps, calls } = harness({ githubIssues: [mirrorWith(desiredBody(ROW))], youtrackRows: [ROW] });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.ok(calls.every(isRead));
    assert.deepEqual(result, summary({ scanned: 1, unchanged: 1, fetches: 4 }));
  });

  it("previews a body change without the text, and sends nothing (R3)", async () => {
    // Arrange
    const { deps, calls, lines } = harness({ githubIssues: [mirrorWith("Old text")], youtrackRows: [ROW] });

    // Act
    const result = await runSync(config({ dryRun: true }), deps);

    // Assert
    assert.ok(calls.every(isRead));
    assert.deepEqual(messages(lines), ["[dry-run] would update CUI-5 #21: set body", formatSummary(result, "ok")]);
    assert.deepEqual(result, summary({ dryRun: true, scanned: 1, updated: 1, fetches: 4 }));
  });

  it("warns when GitHub's answer does not show the new body, and the next run tries again", async () => {
    // Arrange
    const stale = mirrorWith("Old text");
    const { deps, calls, lines } = harness({
      githubIssues: [stale],
      youtrackRows: [ROW],
      override: (call) => (call.method === "PATCH" ? json(200, stale) : undefined),
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/21`]);
    assert.deepEqual(messages(lines, "warn"), [
      "CUI-5 #21: GitHub dropped the body on update; the next run tries again",
    ]);
    assert.deepEqual(result, summary({ scanned: 1, updated: 1, fetches: 5 }));
  });

  it("updates a milestone's description with a PATCH of only that key", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      milestones: [{ ...ghMilestone(7, "[CUI-33] [team] Epic 33"), description: "Old plan" }],
      youtrackRows: [EPIC_ROW],
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`PATCH ${MILESTONES_PATH}/7`]);
    assert.deepEqual(onlyBody(calls, "PATCH", `${MILESTONES_PATH}/7`), { description: desiredBody(EPIC_ROW) });
    assert.deepEqual(result, summary({ scanned: 1, updated: 1, fetches: 5 }));
    assert.deepEqual(messages(lines), ["update milestone CUI-33 #7: set description", formatSummary(result, "ok")]);
  });

  it("warns when GitHub's answer does not show a milestone's new title or description", async () => {
    // Arrange
    const stale = { ...ghMilestone(7, "[YT-33] [team] Epic 33"), description: "Old plan" };
    const { deps, lines } = harness({
      milestones: [stale],
      youtrackRows: [EPIC_ROW],
      override: (call) => (call.method === "PATCH" ? json(200, stale) : undefined),
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(messages(lines, "warn"), [
      "milestone CUI-33 #7: GitHub dropped the title, the description on update; the next run tries again",
    ]);
    assert.deepEqual(result, summary({ scanned: 1, updated: 1, fetches: 5 }));
  });

  it("renames a milestone and updates its description in one PATCH, previewed with the new title", async () => {
    // Arrange
    const world = {
      milestones: [{ ...ghMilestone(7, "[YT-33] [team] Epic 33"), description: null }],
      youtrackRows: [EPIC_ROW],
    };
    const preview = harness(world);
    const live = harness(world);

    // Act
    await runSync(config({ dryRun: true }), preview.deps);
    await runSync(config(), live.deps);

    // Assert
    assert.equal(
      messages(preview.lines)[0],
      "[dry-run] would update milestone CUI-33 #7: set title, set description: [CUI-33] [team] Epic 33",
    );
    assert.deepEqual(onlyBody(live.calls, "PATCH", `${MILESTONES_PATH}/7`), {
      title: "[CUI-33] [team] Epic 33",
      description: desiredBody(EPIC_ROW),
    });
  });

  it("never logs a description, whatever the run writes", async () => {
    // Arrange
    const world = {
      githubIssues: [mirrorWith("Old text")],
      milestones: [{ ...ghMilestone(7, "[CUI-33] [team] Epic 33"), description: "Old plan" }],
      youtrackRows: [ROW, EPIC_ROW],
    };
    const preview = harness(world);
    const live = harness(world);

    // Act
    await runSync(config({ dryRun: true }), preview.deps);
    await runSync(config(), live.deps);

    // Assert
    const all = [...messages(preview.lines), ...messages(live.lines)];
    assert.equal(all.length, 6);
    assert.ok(!all.some((line) => line.includes("marker 7f3a")));
  });
});
