import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RUN_DEADLINE_MS, runSync, WRITE_PAUSE_MS } from "../src/sync.ts";
import { config, harness, ISSUES_PATH, lastLine, messages, MIXED_WORLD, summary, writeCalls } from "./sync-harness.ts";

// The harness clock starts at 0 and moves only by what the run sleeps. In MIXED_WORLD the
// YT-1 create starts at 0, the YT-2 create+close pair at 0 (its writes at 1 s and 2 s) and
// the YT-3 close at 2 s (decision R8: no action starts at or after the deadline).

const deadlineWarning = (count: number): string => `run deadline reached; ${String(count)} more action(s) capped`;

describe("runSync run deadline", () => {
  it("is 8 minutes", () => {
    assert.equal(RUN_DEADLINE_MS, 8 * 60 * 1_000);
  });

  it("caps the actions that would start at or after the deadline and ends ok", async () => {
    // Arrange
    const { deps, calls, lines } = harness({ ...MIXED_WORLD, deadline: 2 * WRITE_PAUSE_MS });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`, `POST ${ISSUES_PATH}`, `PATCH ${ISSUES_PATH}/102`]);
    assert.deepEqual(
      result,
      summary({ scanned: 6, filtered: 1, unchanged: 2, created: 2, closed: 1, capped: 1, fetches: 5 }),
    );
    assert.deepEqual(messages(lines, "warn"), [deadlineWarning(1)]);
    assert.equal(lastLine(lines).level, "info");
  });

  it("finishes a create+close pair that started before the deadline", async () => {
    // Arrange: the pair starts at 0 and its close is sent at 2 s, well past the deadline.
    const { deps, calls, lines } = harness({ ...MIXED_WORLD, deadline: 1 });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls).at(-1), `PATCH ${ISSUES_PATH}/102`);
    assert.equal(result.closed, 1);
    assert.equal(result.capped, 1);
    assert.deepEqual(messages(lines, "warn"), [deadlineWarning(1)]);
  });

  it("writes nothing and warns once when the deadline has already passed", async () => {
    // Arrange
    const { deps, calls, lines } = harness({ ...MIXED_WORLD, deadline: 0 });

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
    const { deps, calls, lines } = harness({ ...MIXED_WORLD, deadline: 2 * WRITE_PAUSE_MS + 1 });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.equal(writeCalls(calls).length, 4);
    assert.equal(result.capped, 0);
    assert.deepEqual(messages(lines, "warn"), []);
  });

  it("does not limit the dry-run preview, which sends no writes", async () => {
    // Arrange
    const { deps, lines } = harness({ ...MIXED_WORLD, deadline: 0 });

    // Act
    const result = await runSync(config({ dryRun: true }), deps);

    // Assert
    assert.equal(result.created, 2);
    assert.equal(result.closed, 2);
    assert.equal(result.capped, 0);
    assert.deepEqual(messages(lines, "warn"), []);
  });
});
