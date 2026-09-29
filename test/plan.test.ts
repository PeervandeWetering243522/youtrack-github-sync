import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planActions, writeCost } from "../src/plan.ts";
import type { Action } from "../src/plan.ts";
import {
  assertCountsAddUp,
  describeActions,
  epic,
  lockedMap,
  mirror,
  NO_MILESTONES,
  plan,
  PREFIX,
  resolvedIssue,
  task,
  ytIssue,
} from "./plan-fixtures.ts";

/** The create action planActions makes for an issue with no Type, no parent and no epic. */
function plainCreate(issue: ReturnType<typeof ytIssue>): Action {
  return { kind: "create", issue, githubType: null, milestoneEpic: null, parentYt: null };
}

// ---------------------------------------------------------------------------
// writeCost
// ---------------------------------------------------------------------------

describe("writeCost", () => {
  it("costs 1 for a create", () => {
    assert.equal(writeCost(plainCreate(ytIssue(1))), 1);
  });

  it("costs 1 for a create that also sets milestone, type and parent", () => {
    const action: Action = { kind: "create", issue: task(3), githubType: "Task", milestoneEpic: 1, parentYt: 2 };

    assert.equal(writeCost(action), 1);
  });

  it("costs 1 for a close", () => {
    assert.equal(writeCost({ kind: "close", issue: resolvedIssue(1), mirror: mirror(12) }), 1);
  });

  it("costs 1 for each milestone write", () => {
    const milestone = { milestoneNumber: 3, state: "open" } as const;

    assert.equal(writeCost({ kind: "createMilestone", issue: epic(9) }), 1);
    assert.equal(writeCost({ kind: "closeMilestone", issue: epic(9), milestone }), 1);
  });

  it("costs 1 for an update, even one that changes milestone and type together", () => {
    const action: Action = { kind: "update", issue: task(5), mirror: mirror(12), milestoneEpic: 9, githubType: "Task" };

    assert.equal(writeCost(action), 1);
  });

  it("costs 1 for setting or removing a parent", () => {
    const issue = task(5);

    assert.equal(writeCost({ kind: "setParent", issue, mirror: mirror(12), parentYt: 2 }), 1);
    assert.equal(writeCost({ kind: "removeParent", issue, mirror: mirror(12), parentNumber: 20, parentYt: 2 }), 1);
  });
});

// ---------------------------------------------------------------------------
// planActions (issues without a Type or parent: the pre-hierarchy rules)
// ---------------------------------------------------------------------------

describe("planActions: decisions", () => {
  it("creates a mirror for an unresolved issue without one", () => {
    const issue = ytIssue(3);

    const result = plan([issue]);

    assert.deepEqual(result.actions, [plainCreate(issue)]);
    assert.deepEqual(
      { ...result, actions: [] },
      { actions: [], scanned: 1, filtered: 0, unchanged: 0, capped: 0, warnings: [] },
    );
  });

  it("never creates a mirror for an already-resolved issue, and counts it as unchanged (R9)", () => {
    const result = plan([resolvedIssue(3)]);

    assert.deepEqual(result, { actions: [], scanned: 1, filtered: 0, unchanged: 1, capped: 0, warnings: [] });
  });

  it("creates only the unresolved issues of a project with no mirrors (R9)", () => {
    const issues = [resolvedIssue(1), ytIssue(2), resolvedIssue(3), ytIssue(4)];

    const result = plan(issues);

    assert.deepEqual(describeActions(result.actions), ["create 2", "create 4"]);
    assert.equal(result.unchanged, 2);
    assertCountsAddUp(result);
  });

  it("closes an open mirror of a resolved issue", () => {
    const issue = resolvedIssue(5);
    const ref = mirror(12);

    const result = plan([issue], { mirrors: lockedMap([[5, ref]]) });

    assert.deepEqual(result.actions, [{ kind: "close", issue, mirror: ref }]);
    assert.equal(result.unchanged, 0);
  });

  it("leaves an open mirror of an unresolved issue unchanged", () => {
    const result = plan([ytIssue(5)], { mirrors: lockedMap([[5, mirror(12)]]) });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 1);
  });

  it("leaves a closed mirror of a resolved issue unchanged", () => {
    const result = plan([resolvedIssue(5)], { mirrors: lockedMap([[5, mirror(12, { state: "closed" })]]) });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 1);
  });

  it("never reopens a closed mirror of an unresolved issue", () => {
    const result = plan([ytIssue(5)], { mirrors: lockedMap([[5, mirror(12, { state: "closed" })]]) });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 1);
  });

  it("treats an unlabelled mirror like a labelled one", () => {
    const ref = mirror(12, { hasLabel: false });

    const result = plan([resolvedIssue(5)], { mirrors: lockedMap([[5, ref]]) });

    assert.deepEqual(describeActions(result.actions), ["close 5 -> #12"]);
  });

  it("returns an empty plan for no issues", () => {
    const result = plan([]);

    assert.deepEqual(result, { actions: [], scanned: 0, filtered: 0, unchanged: 0, capped: 0, warnings: [] });
  });

  it("treats a resolved timestamp of 0 as resolved (null is the only unresolved value)", () => {
    const withoutMirror = resolvedIssue(3, { resolved: 0 });
    const withMirror = resolvedIssue(4, { resolved: 0 });

    const result = plan([withoutMirror, withMirror], { mirrors: lockedMap([[4, mirror(12)]]) });

    assert.deepEqual(describeActions(result.actions), ["close 4 -> #12"]);
    assert.equal(result.unchanged, 1);
  });

  it("puts the index's own mirror ref into a close action", () => {
    const ref = mirror(12);

    const result = plan([resolvedIssue(5)], { mirrors: lockedMap([[5, ref]]) });

    const [action] = result.actions;
    assert.equal(action?.kind === "close" ? action.mirror : null, ref);
  });

  it("ignores mirrors whose YouTrack issue is not in the scan", () => {
    const mirrors = lockedMap([
      [4, mirror(10)],
      [99, mirror(11)],
    ]);

    const result = plan([ytIssue(5)], { mirrors });

    assert.deepEqual(describeActions(result.actions), ["create 5"]);
    assert.deepEqual(
      { ...result, actions: [] },
      { actions: [], scanned: 1, filtered: 0, unchanged: 0, capped: 0, warnings: [] },
    );
  });

  it("plans one action for an issue listed twice, from its first copy", () => {
    const first = ytIssue(5);
    const issues = [ytIssue(9), first, resolvedIssue(5), ytIssue(2)];

    const result = plan(issues);

    assert.deepEqual(describeActions(result.actions), ["create 2", "create 5", "create 9"]);
    assert.equal(result.actions[1]?.issue, first);
    assert.equal(result.scanned, 3);
    assertCountsAddUp(result);
  });
});

describe("planActions: title prefix filter", () => {
  it("skips issues whose summary lacks the prefix, even without a mirror", () => {
    const issues = [ytIssue(1, { summary: "Fix [team] later" }), resolvedIssue(2, { summary: "Unrelated" })];

    const result = plan(issues);

    assert.deepEqual(result, { actions: [], scanned: 2, filtered: 2, unchanged: 0, capped: 0, warnings: [] });
  });

  it("matches the prefix case-insensitively and after leading whitespace", () => {
    const issues = [
      ytIssue(1, { summary: "[TEAM] Upper" }),
      ytIssue(2, { summary: "  [Team] Mixed" }),
      ytIssue(3, { summary: "[team]no space" }),
    ];

    const result = plan(issues, { titlePrefix: "[Team]" });

    assert.deepEqual(describeActions(result.actions), ["create 1", "create 2", "create 3"]);
    assert.equal(result.filtered, 0);
  });

  it("uses the configured prefix", () => {
    const issues = [ytIssue(1, { summary: "[ops] Deploy" }), ytIssue(2, { summary: "[team] Other" })];

    const result = plan(issues, { titlePrefix: "[ops]" });

    assert.deepEqual(describeActions(result.actions), ["create 1"]);
    assert.equal(result.filtered, 1);
  });

  it("filters an issue that lost its prefix, even with an open mirror to close", () => {
    const issues = [resolvedIssue(5, { summary: "Renamed" }), ytIssue(6, { summary: "" })];
    const mirrors = lockedMap([
      [5, mirror(12)],
      [6, mirror(13)],
    ]);

    const result = plan(issues, { mirrors });

    assert.deepEqual(result, { actions: [], scanned: 2, filtered: 2, unchanged: 0, capped: 0, warnings: [] });
  });

  it("counts filtered issues outside the cap, never as capped", () => {
    const issues = [ytIssue(1, { summary: "Other" }), ytIssue(2), ytIssue(3, { summary: "Other" }), ytIssue(4)];

    const result = plan(issues, { maxWrites: 1 });

    assert.deepEqual(describeActions(result.actions), ["create 2"]);
    assert.deepEqual(
      { ...result, actions: [] },
      { actions: [], scanned: 4, filtered: 2, unchanged: 0, capped: 1, warnings: [] },
    );
  });
});

describe("planActions: order and counts", () => {
  it("orders actions by ascending numberInProject within each phase, regardless of input order", () => {
    const issues = [ytIssue(9), resolvedIssue(2), ytIssue(27), resolvedIssue(5), ytIssue(1)];
    const mirrors = lockedMap([[5, mirror(40)]]);

    const result = plan(issues, { mirrors });

    // Creates come before closes (docs/11 §1.4), each group ascending.
    assert.deepEqual(describeActions(result.actions), ["create 1", "create 9", "create 27", "close 5 -> #40"]);
    assert.equal(result.unchanged, 1);
  });

  it("adds up scanned = filtered + unchanged + actions + capped on a mixed project", () => {
    const issues = [
      ytIssue(1, { summary: "No prefix" }),
      ytIssue(2),
      resolvedIssue(3),
      resolvedIssue(4),
      ytIssue(5),
      resolvedIssue(6),
      ytIssue(7, { summary: "Other" }),
    ];
    const mirrors = lockedMap([
      [4, mirror(10)],
      [5, mirror(11)],
      [6, mirror(12, { state: "closed" })],
    ]);

    const result = plan(issues, { mirrors, maxWrites: 1 });

    // YT-3 (resolved, no mirror), YT-5 and YT-6 are unchanged; YT-4's close is capped.
    assert.deepEqual(describeActions(result.actions), ["create 2"]);
    assert.deepEqual(
      { ...result, actions: [] },
      { actions: [], scanned: 7, filtered: 2, unchanged: 3, capped: 1, warnings: [] },
    );
    assertCountsAddUp(result);
  });
});

describe("planActions: immutability", () => {
  it("leaves frozen issues, their order and a locked mirror map untouched", () => {
    const issues = Object.freeze([resolvedIssue(9), ytIssue(2), resolvedIssue(5)]);
    const mirrors = lockedMap([[5, mirror(40)]]);
    const issuesBefore = structuredClone(issues);
    const mirrorsBefore = structuredClone([...mirrors.entries()]);

    const result = planActions({
      youtrackIssues: issues,
      mirrors,
      milestones: NO_MILESTONES,
      titlePrefix: PREFIX,
      maxWrites: 30,
    });

    assert.deepEqual(issues, issuesBefore);
    assert.deepEqual([...mirrors.entries()], mirrorsBefore);
    assert.deepEqual(describeActions(result.actions), ["create 2", "close 5 -> #40"]);
  });

  it("returns the input issue objects in its actions, not copies", () => {
    const issue = ytIssue(4);

    const result = plan([issue]);

    assert.equal(result.actions[0]?.issue, issue);
  });
});
