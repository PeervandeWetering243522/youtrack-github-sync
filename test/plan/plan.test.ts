import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planActions, writeCost } from "../../src/plan.ts";
import type { Action } from "../../src/plan.ts";
import {
  assertCountsAddUp,
  describeActions,
  epic,
  EXCLUDE_PREFIX,
  mirror,
  mirrors,
  NO_MILESTONES,
  plan,
  resolvedIssue,
  task,
  titled,
  ytIssue,
} from "./fixtures.ts";

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
    assert.equal(writeCost({ kind: "close", issue: resolvedIssue(1), mirror: titled(1, mirror(12)) }), 1);
  });

  it("costs 1 for each milestone write, a rename included", () => {
    const milestone = { milestoneNumber: 3, title: "[YT-9] Old", state: "open" } as const;

    assert.equal(writeCost({ kind: "createMilestone", issue: epic(9) }), 1);
    assert.equal(writeCost({ kind: "renameMilestone", issue: epic(9), milestone, title: "[CUI-9] Issue 9" }), 1);
    assert.equal(writeCost({ kind: "closeMilestone", issue: epic(9), milestone }), 1);
  });

  it("costs 1 for an update, even one that changes title, milestone and type together", () => {
    const ref = titled(5, mirror(12));
    const both: Action = { kind: "update", issue: task(5), mirror: ref, milestoneEpic: 9, githubType: "Task" };
    const titleOnly: Action = { kind: "update", issue: task(5), mirror: ref, title: "[CUI-5] New" };
    const all: Action = {
      kind: "update",
      issue: task(5),
      mirror: ref,
      title: "[CUI-5] New",
      milestoneEpic: 9,
      githubType: "Task",
    };

    assert.equal(writeCost(both), 1);
    assert.equal(writeCost(titleOnly), 1);
    assert.equal(writeCost(all), 1);
  });

  it("costs 1 for setting or removing a parent", () => {
    const issue = task(5);
    const ref = titled(5, mirror(12));

    assert.equal(writeCost({ kind: "setParent", issue, mirror: ref, parentYt: 2 }), 1);
    assert.equal(writeCost({ kind: "removeParent", issue, mirror: ref, parentNumber: 20, parentYt: 2 }), 1);
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
    const ref = titled(5, mirror(12));

    const result = plan([issue], { mirrors: mirrors([5, ref]) });

    assert.deepEqual(result.actions, [{ kind: "close", issue, mirror: ref }]);
    assert.equal(result.unchanged, 0);
  });

  it("leaves an open mirror of an unresolved issue unchanged", () => {
    const result = plan([ytIssue(5)], { mirrors: mirrors([5, mirror(12)]) });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 1);
  });

  it("leaves a closed mirror of a resolved issue unchanged", () => {
    const result = plan([resolvedIssue(5)], { mirrors: mirrors([5, mirror(12, { state: "closed" })]) });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 1);
  });

  it("never reopens a closed mirror of an unresolved issue while REOPEN_CLOSED_BY is unset (R10)", () => {
    const result = plan([ytIssue(5)], { mirrors: mirrors([5, mirror(12, { state: "closed" })]) });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 1);
  });

  it("treats an unlabelled mirror like a labelled one", () => {
    const ref = mirror(12, { hasLabel: false });

    const result = plan([resolvedIssue(5)], { mirrors: mirrors([5, ref]) });

    assert.deepEqual(describeActions(result.actions), ["close 5 -> #12"]);
  });

  it("returns an empty plan for no issues", () => {
    const result = plan([]);

    assert.deepEqual(result, { actions: [], scanned: 0, filtered: 0, unchanged: 0, capped: 0, warnings: [] });
  });

  it("treats a resolved timestamp of 0 as resolved (null is the only unresolved value)", () => {
    const withoutMirror = resolvedIssue(3, { resolved: 0 });
    const withMirror = resolvedIssue(4, { resolved: 0 });

    const result = plan([withoutMirror, withMirror], { mirrors: mirrors([4, mirror(12)]) });

    assert.deepEqual(describeActions(result.actions), ["close 4 -> #12"]);
    assert.equal(result.unchanged, 1);
  });

  it("puts the index's own mirror ref into a close action", () => {
    const index = mirrors([5, mirror(12)]);

    const result = plan([resolvedIssue(5)], { mirrors: index });

    const [action] = result.actions;
    assert.equal(action?.kind === "close" ? action.mirror : null, index.get(5));
  });

  it("ignores mirrors whose YouTrack issue is not in the scan", () => {
    const index = mirrors([4, mirror(10)], [99, mirror(11)]);

    const result = plan([ytIssue(5)], { mirrors: index });

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

describe("planActions: exclude prefix filter (F1)", () => {
  it("mirrors an issue whose summary has no prefix, including an empty summary", () => {
    const issues = [ytIssue(1, { summary: "Plain summary" }), ytIssue(2, { summary: "" })];

    const result = plan(issues);

    assert.deepEqual(describeActions(result.actions), ["create 1", "create 2"]);
    assert.equal(result.filtered, 0);
  });

  it('mirrors a "[team]" issue: the old inclusion prefix is an ordinary summary now', () => {
    const issues = [ytIssue(1, { summary: "[team] Shared work" }), ytIssue(2, { summary: "[TEAM] Upper" })];

    const result = plan(issues);

    assert.deepEqual(describeActions(result.actions), ["create 1", "create 2"]);
    assert.equal(result.filtered, 0);
  });

  it("skips summaries starting with the exclude prefix, in any case and after leading whitespace", () => {
    const issues = [
      ytIssue(1, { summary: "[individual] Solo work" }),
      ytIssue(2, { summary: "[INDIVIDUAL] Upper" }),
      ytIssue(3, { summary: "  [Individual] x" }),
      ytIssue(4, { summary: "\t[individual]no space" }),
      resolvedIssue(5, { summary: "[individual] Done" }),
    ];

    const result = plan(issues);

    assert.deepEqual(result, { actions: [], scanned: 5, filtered: 5, unchanged: 0, capped: 0, warnings: [] });
  });

  it("mirrors summaries that only resemble the exclude prefix, such as the typo [invididual]", () => {
    const issues = [
      ytIssue(1, { summary: "[invididual] Data Structures & Algorithms" }),
      ytIssue(2, { summary: "Fix [individual] later" }),
      ytIssue(3, { summary: "[individua] cut short" }),
      ytIssue(4, { summary: "individual without brackets" }),
    ];

    const result = plan(issues);

    assert.deepEqual(describeActions(result.actions), ["create 1", "create 2", "create 3", "create 4"]);
    assert.equal(result.filtered, 0);
  });

  it("uses the configured exclude prefix instead of the default, whatever the case of either", () => {
    const issues = [
      ytIssue(1, { summary: "[SOLO] Mine" }),
      ytIssue(2, { summary: "[individual] Not excluded here" }),
      ytIssue(3, { summary: "Plain" }),
      ytIssue(4, { summary: "  [solo] lower" }),
    ];

    const result = plan(issues, { excludePrefix: "[Solo]" });

    assert.deepEqual(describeActions(result.actions), ["create 2", "create 3"]);
    assert.equal(result.filtered, 2);
  });

  it("ignores an issue that gained the exclude prefix after mirroring, leaving its mirror alone (F2)", () => {
    const issues = [
      resolvedIssue(5, { summary: "[individual] Renamed" }),
      ytIssue(6, { summary: "[Individual] Moved" }),
    ];
    // The mirrors' titles are outdated now as well, and still left alone.
    const index = mirrors([5, mirror(12)], [6, mirror(13)]);

    const result = plan(issues, { mirrors: index });

    assert.deepEqual(result, { actions: [], scanned: 2, filtered: 2, unchanged: 0, capped: 0, warnings: [] });
  });

  it("counts filtered issues outside the cap, never as capped", () => {
    const issues = [
      ytIssue(1, { summary: "[individual] Other" }),
      ytIssue(2),
      ytIssue(3, { summary: "[individual] Other" }),
      ytIssue(4),
    ];

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

    const result = plan(issues, { mirrors: mirrors([5, mirror(40)]) });

    // Creates come before closes (docs/11 §1.4), each group ascending.
    assert.deepEqual(describeActions(result.actions), ["create 1", "create 9", "create 27", "close 5 -> #40"]);
    assert.equal(result.unchanged, 1);
  });

  it("adds up scanned = filtered + unchanged + actions + capped on a mixed project", () => {
    const issues = [
      ytIssue(1, { summary: "[individual] Solo" }),
      ytIssue(2),
      resolvedIssue(3),
      resolvedIssue(4),
      ytIssue(5),
      resolvedIssue(6),
      ytIssue(7, { summary: "[individual] Other" }),
    ];
    const index = mirrors([4, mirror(10)], [5, mirror(11)], [6, mirror(12, { state: "closed" })]);

    const result = plan(issues, { mirrors: index, maxWrites: 1 });

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
    const index = mirrors([5, mirror(40)]);
    const issuesBefore = structuredClone(issues);
    const mirrorsBefore = structuredClone([...index.entries()]);

    const result = planActions({
      youtrackIssues: issues,
      mirrors: index,
      milestones: NO_MILESTONES,
      excludePrefix: EXCLUDE_PREFIX,
      maxWrites: 30,
      reopenClosedBy: null,
    });

    assert.deepEqual(issues, issuesBefore);
    assert.deepEqual([...index.entries()], mirrorsBefore);
    assert.deepEqual(describeActions(result.actions), ["create 2", "close 5 -> #40"]);
  });

  it("returns the input issue objects in its actions, not copies", () => {
    const issue = ytIssue(4);

    const result = plan([issue]);

    assert.equal(result.actions[0]?.issue, issue);
  });
});
