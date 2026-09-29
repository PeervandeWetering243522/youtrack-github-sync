import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { writeCost } from "../src/plan.ts";
import {
  assertCountsAddUp,
  describeActions,
  FILTERED,
  lockedMap,
  mirror,
  plan,
  resolvedIssue,
  ytIssue,
} from "./plan-fixtures.ts";

// Issues without a Type or parent: every issue needs at most one action (the pre-hierarchy
// rules), so scanned = filtered + unchanged + actions + capped holds throughout.

describe("planActions: write cap", () => {
  it("takes every action when their costs exactly fill the cap", () => {
    const issues = [ytIssue(1), ytIssue(2), resolvedIssue(3)];
    const mirrors = lockedMap([[3, mirror(20)]]);

    const result = plan(issues, { mirrors, maxWrites: 3 });

    assert.deepEqual(describeActions(result.actions), ["create 1", "create 2", "close 3 -> #20"]);
    assert.equal(result.capped, 0);
    assertCountsAddUp(result);
  });

  it("stops at the first action that does not fit; it and the rest count as capped", () => {
    const issues = [ytIssue(1), ytIssue(2), resolvedIssue(3), ytIssue(4)];
    const mirrors = lockedMap([[3, mirror(20)]]);

    const result = plan(issues, { mirrors, maxWrites: 2 });

    assert.deepEqual(describeActions(result.actions), ["create 1", "create 2"]);
    assert.equal(result.capped, 2);
    assertCountsAddUp(result);
  });

  it("spends no write on a resolved issue without a mirror, so it never blocks the cap (R9)", () => {
    const issues = [resolvedIssue(1), ytIssue(2), ytIssue(3)];

    const result = plan(issues, { maxWrites: 1 });

    assert.deepEqual(describeActions(result.actions), ["create 2"]);
    assert.deepEqual(
      { ...result, actions: [] },
      { actions: [], scanned: 3, filtered: 0, unchanged: 1, capped: 1, warnings: [] },
    );
  });

  it("does not let a later action jump ahead of one that does not fit", () => {
    const issues = [ytIssue(1), resolvedIssue(2), ytIssue(3)];
    const mirrors = lockedMap([[2, mirror(20)]]);

    const result = plan(issues, { mirrors, maxWrites: 1 });

    // Order: create 1, create 3, close 2. Only the first fits; the rest are capped in order.
    assert.deepEqual(describeActions(result.actions), ["create 1"]);
    assert.equal(result.capped, 2);
    assertCountsAddUp(result);
  });

  it("plans nothing and caps every action when maxWrites is 0", () => {
    const issues = [ytIssue(1), resolvedIssue(2), ytIssue(3, FILTERED)];

    const result = plan(issues, { mirrors: lockedMap([[2, mirror(20)]]), maxWrites: 0 });

    assert.deepEqual(result, { actions: [], scanned: 3, filtered: 1, unchanged: 0, capped: 2, warnings: [] });
  });

  it("reports nothing capped when maxWrites is 0 but nothing needs doing", () => {
    const result = plan([ytIssue(1)], { mirrors: lockedMap([[1, mirror(9)]]), maxWrites: 0 });

    assert.deepEqual(result, { actions: [], scanned: 1, filtered: 0, unchanged: 1, capped: 0, warnings: [] });
  });

  it("caps everything when maxWrites is not a number (fails closed)", () => {
    const result = plan([ytIssue(1)], { maxWrites: Number.NaN });

    assert.deepEqual(result.actions, []);
    assert.equal(result.capped, 1);
  });

  it("caps everything when maxWrites is negative", () => {
    const result = plan([ytIssue(1), ytIssue(2)], { maxWrites: -1 });

    assert.deepEqual(result.actions, []);
    assert.equal(result.capped, 2);
  });

  it("takes the first action in execution order under a cap of 1: creates before closes", () => {
    const issues = [resolvedIssue(1), ytIssue(2)];

    const result = plan(issues, { mirrors: lockedMap([[1, mirror(101)]]), maxWrites: 1 });

    assert.deepEqual(describeActions(result.actions), ["create 2"]);
    assert.equal(result.capped, 1);
  });

  it("takes the oldest close first when only closes are due", () => {
    const issues = [resolvedIssue(2), resolvedIssue(1)];
    const mirrors = lockedMap([
      [1, mirror(101)],
      [2, mirror(102)],
    ]);

    const result = plan(issues, { mirrors, maxWrites: 1 });

    assert.deepEqual(describeActions(result.actions), ["close 1 -> #101"]);
    assert.equal(result.capped, 1);
  });

  it("takes every action under an unlimited cap", () => {
    const issues = [resolvedIssue(1), resolvedIssue(2), ytIssue(3)];

    const result = plan(issues, { mirrors: lockedMap([[1, mirror(101)]]), maxWrites: Number.POSITIVE_INFINITY });

    assert.deepEqual(describeActions(result.actions), ["create 3", "close 1 -> #101"]);
    assert.equal(result.capped, 0);
    assert.equal(result.unchanged, 1);
  });

  it("caps by the order of numberInProject, not input order", () => {
    const issues = [ytIssue(30), ytIssue(10), ytIssue(20)];

    const result = plan(issues, { maxWrites: 2 });

    assert.deepEqual(describeActions(result.actions), ["create 10", "create 20"]);
    assert.equal(result.capped, 1);
  });

  it("plans the longest in-order prefix that fits, for every cap from 0 to 8", () => {
    const issues = [ytIssue(1), resolvedIssue(2), ytIssue(3), resolvedIssue(4), ytIssue(5), resolvedIssue(6)];
    const mirrors = lockedMap([
      [4, mirror(20)],
      [6, mirror(21)],
    ]);
    const everything = describeActions(plan(issues, { mirrors, maxWrites: Number.POSITIVE_INFINITY }).actions);
    assert.deepEqual(everything, ["create 1", "create 3", "create 5", "close 4 -> #20", "close 6 -> #21"]);

    for (let maxWrites = 0; maxWrites <= 8; maxWrites += 1) {
      const result = plan(issues, { mirrors, maxWrites });

      const count = Math.min(maxWrites, everything.length);
      const used = result.actions.reduce((total, action) => total + writeCost(action), 0);
      assert.equal(used, count, `maxWrites=${String(maxWrites)}`);
      assert.deepEqual(describeActions(result.actions), everything.slice(0, count), `maxWrites=${String(maxWrites)}`);
      assert.equal(result.capped, everything.length - count);
      assert.equal(result.unchanged, 1);
      assertCountsAddUp(result);
    }
  });
});
