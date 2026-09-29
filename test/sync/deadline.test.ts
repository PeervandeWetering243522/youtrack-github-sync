import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RUN_DEADLINE_MS, runSync, WRITE_PAUSE_MS } from "../../src/sync.ts";
import {
  config,
  harness,
  ISSUES_PATH,
  lastLine,
  messages,
  MIXED_WORLD,
  summary,
  writeCalls,
  ytRow,
} from "./fixtures.ts";
import type { World } from "./fixtures.ts";

// The harness clock starts at 0 and moves only by what the run sleeps. In DEADLINE_WORLD the
// YT-1 create starts at 0, the YT-7 create at 0 (its write sent at 1 s, after the pause) and the
// YT-3 close at 1 s, since creates run before closes (docs/11 §1.4; decision R8: no action
// starts at or after the deadline).
const DEADLINE_WORLD: World = { ...MIXED_WORLD, youtrackRows: [...(MIXED_WORLD.youtrackRows ?? []), ytRow(7)] };

const deadlineWarning = (count: number): string => `run deadline reached; ${String(count)} more action(s) capped`;

describe("runSync run deadline", () => {
  it("is 8 minutes", () => {
    assert.equal(RUN_DEADLINE_MS, 8 * 60 * 1_000);
  });

  it("caps the actions that would start at or after the deadline and ends ok", async () => {
    // Arrange
    const { deps, calls, lines } = harness({ ...DEADLINE_WORLD, deadline: WRITE_PAUSE_MS });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`, `POST ${ISSUES_PATH}`]);
    assert.deepEqual(result, summary({ scanned: 7, filtered: 1, unchanged: 3, created: 2, capped: 1, fetches: 5 }));
    assert.deepEqual(messages(lines, "warn"), [deadlineWarning(1)]);
    assert.equal(lastLine(lines).level, "info");
  });

  it("finishes an action that started before the deadline, including its label re-add", async () => {
    // Arrange: the YT-1 create starts at 0 and its re-add is sent at 1 s, past the deadline;
    // the YT-7 create and YT-3 close would start at 1 s and are capped.
    const { deps, calls, lines } = harness({ ...DEADLINE_WORLD, createdLabels: [], deadline: 1 });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`, `POST ${ISSUES_PATH}/101/labels`]);
    assert.equal(result.labelsReAdded, 1);
    assert.equal(result.capped, 2);
    assert.deepEqual(messages(lines, "warn"), [deadlineWarning(2)]);
  });

  it("writes nothing and warns once when the deadline has already passed", async () => {
    // Arrange
    const { deps, calls, lines } = harness({ ...DEADLINE_WORLD, deadline: 0 });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), []);
    assert.equal(result.capped, 3);
    assert.equal(result.failed, 0);
    assert.deepEqual(messages(lines, "warn"), [deadlineWarning(3)]);
  });

  it("runs everything when the deadline is not reached", async () => {
    // Arrange
    const { deps, calls, lines } = harness({ ...DEADLINE_WORLD, deadline: WRITE_PAUSE_MS + 1 });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.equal(writeCalls(calls).length, 3);
    assert.equal(result.capped, 0);
    assert.deepEqual(messages(lines, "warn"), []);
  });

  it("does not limit the dry-run preview, which sends no writes", async () => {
    // Arrange
    const { deps, lines } = harness({ ...DEADLINE_WORLD, deadline: 0 });

    // Act
    const result = await runSync(config({ dryRun: true }), deps);

    // Assert
    assert.equal(result.created, 2);
    assert.equal(result.closed, 1);
    assert.equal(result.capped, 0);
    assert.deepEqual(messages(lines, "warn"), []);
  });
});
