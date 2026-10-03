/**
 * Assignee actions in the plan (docs/13 §2.6-2.7; U4-U7, U13, U15, D4, A3): which eligible
 * mirrors get addAssignees and removeAssignees, their phase after closes, the prefix cap and
 * GitHub's limit of 10 assignees. Every person is a placeholder.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_ASSIGNEES_PER_ISSUE } from "../../src/github/assignees.ts";
import type { GitHubAssignee } from "../../src/github/assignees.ts";
import { writeCost } from "../../src/plan.ts";
import type { Action } from "../../src/plan.ts";
import { GITHUB_MAX_ASSIGNEES } from "../../src/plan/assignees.ts";
import {
  ACTIONS_BOT,
  assertCountsAddUp,
  assigneeSync,
  closedMirror,
  counts,
  describeActions,
  epic,
  FILTERED,
  milestoneIndex,
  ghMilestone,
  mirror,
  mirrors,
  plan,
  resolvedIssue,
  story,
  task,
  under,
  ytIssue,
} from "./fixtures.ts";

const JANE = "JaneDoe123456";
const JDOE = "jdoe123456";

function user(login: string): GitHubAssignee {
  return Object.freeze({ login, type: "User" });
}

function bot(login: string): GitHubAssignee {
  return Object.freeze({ login, type: "Bot" });
}

function staff(count: number): readonly GitHubAssignee[] {
  return Object.freeze(Array.from({ length: count }, (_, index) => user(`staffuser${String(index)}`)));
}

function logins(count: number, prefix: string): readonly string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${String(index)}`);
}

describe("planActions: assignee actions on an existing open mirror", () => {
  it("adds the desired logins the mirror lacks, and counts the issue as changed", () => {
    const issue = ytIssue(5);
    const index = mirrors([5, mirror(12)]);

    const result = plan([issue], { mirrors: index, assignees: assigneeSync([[5, [JANE]]]) });

    assert.deepEqual(result.actions, [{ kind: "addAssignees", issue, logins: [JANE] }]);
    assert.deepEqual(counts(result), { scanned: 1, filtered: 0, unchanged: 0, capped: 0 });
    assert.deepEqual(result.warnings, []);
  });

  it("removes an owned User that is no longer desired, after adding the new one (a reassignment)", () => {
    const issue = ytIssue(5);
    const index = mirrors([5, mirror(12, { assignees: Object.freeze([user(JDOE)]) })]);

    const result = plan([issue], { mirrors: index, assignees: assigneeSync([[5, [JANE]]], [JANE, JDOE]) });

    assert.deepEqual(result.actions, [
      { kind: "addAssignees", issue, logins: [JANE] },
      { kind: "removeAssignees", issue, mirror: index.get(5), logins: [JDOE] },
    ]);
  });

  it("plans nothing when the mirror already holds the desired login in another case", () => {
    const index = mirrors([5, mirror(12, { assignees: Object.freeze([user("janedoe123456")]) })]);

    const result = plan([ytIssue(5)], { mirrors: index, assignees: assigneeSync([[5, [JANE]]]) });

    assert.deepEqual(result.actions, []);
    assert.deepEqual(counts(result), { scanned: 1, filtered: 0, unchanged: 1, capped: 0 });
  });

  it("never removes a Bot or a User nobody matched this run, such as staff (U4)", () => {
    const assignees = Object.freeze([user("staffuser"), bot("helper[bot]")]);
    const index = mirrors([5, mirror(12, { assignees })]);

    const result = plan([ytIssue(5)], { mirrors: index, assignees: assigneeSync([[5, [JANE]]]) });

    assert.deepEqual(describeActions(result.actions), [`addAssignees 5 +${JANE}`]);
  });

  it("leaves a mirror alone when its issue has no matched user, owned logins included (U6)", () => {
    const index = mirrors([5, mirror(12, { assignees: Object.freeze([user(JDOE)]) })]);

    const result = plan([ytIssue(5), ytIssue(6)], { mirrors: index, assignees: assigneeSync([[6, [JDOE]]]) });

    assert.deepEqual(describeActions(result.actions), [`create 6`, `addAssignees 6 +${JDOE}`]);
  });

  it("plans no assignee action at all with assignees null (switch off, field missing, list unreadable)", () => {
    const index = mirrors([5, mirror(12, { assignees: Object.freeze([user(JDOE)]) })]);

    const result = plan([ytIssue(5), ytIssue(6)], { mirrors: index, assignees: null });

    assert.deepEqual(describeActions(result.actions), ["create 6"]);
  });
});

describe("planActions: assignees of a mirror created this run", () => {
  it("creates the mirror, then adds its desired logins in the assignee phase (D4)", () => {
    const issue = story(5);

    const result = plan([issue], { assignees: assigneeSync([[5, [JANE, JDOE]]]) });

    assert.deepEqual(describeActions(result.actions), ["create 5 type=Feature", `addAssignees 5 +${JANE},${JDOE}`]);
    assert.deepEqual(result.actions[1], { kind: "addAssignees", issue, logins: [JANE, JDOE] });
    assert.deepEqual(counts(result), { scanned: 1, filtered: 0, unchanged: 0, capped: 0 });
  });

  it("adds to a task created under a parent created in the same run", () => {
    const issues = [story(1), task(2, under(1))];

    const result = plan(issues, { assignees: assigneeSync([[2, [JANE]]]) });

    assert.deepEqual(describeActions(result.actions), [
      "create 1 type=Feature",
      "create 2 type=Task parent=YT-1",
      `addAssignees 2 +${JANE}`,
    ]);
  });
});

describe("planActions: issues that never get assignee actions", () => {
  const sync = assigneeSync([
    [1, [JANE]],
    [2, [JANE]],
    [3, [JANE]],
    [4, [JANE]],
    [5, [JANE]],
  ]);

  it("leaves out a closed mirror (U7), a resolved issue, an epic (U13) and an excluded issue (F1)", () => {
    const issues = [ytIssue(1), resolvedIssue(2), epic(3), ytIssue(4, FILTERED)];
    const index = mirrors([1, closedMirror(11, "a-person")], [2, mirror(12)], [4, mirror(14)]);
    const milestones = milestoneIndex(ghMilestone(7, "[CUI-3] Issue 3"));

    const result = plan(issues, { mirrors: index, milestones, assignees: sync });

    assert.deepEqual(describeActions(result.actions), ["close 2 -> #12"]);
    assert.deepEqual(counts(result), { scanned: 4, filtered: 1, unchanged: 2, capped: 0 });
  });

  it("leaves out a closed mirror that R10 reopens this run: it gets its assignees next run", () => {
    const index = mirrors([5, closedMirror(15, ACTIONS_BOT)]);

    const result = plan([ytIssue(5)], { mirrors: index, reopenClosedBy: ACTIONS_BOT, assignees: sync });

    assert.deepEqual(describeActions(result.actions), ["reopen 5 -> #15"]);
  });

  it("leaves out an issue excluded by an ancestor (F3) and plans no create for it", () => {
    const issues = [story(1, FILTERED), task(2, under(1))];

    const result = plan(issues, { assignees: sync });

    assert.deepEqual(result.actions, []);
    assert.deepEqual(counts(result), { scanned: 2, filtered: 2, unchanged: 0, capped: 0 });
  });
});

describe("planActions: assignee phase and cap", () => {
  it("runs assignee writes last, after closes, by number, each issue's add before its remove", () => {
    const issues = [ytIssue(1), ytIssue(2), resolvedIssue(3), ytIssue(4)];
    const index = mirrors(
      [1, mirror(11, { assignees: Object.freeze([user("other123457")]) })],
      [2, mirror(12, { title: "[CUI-2] Old" })],
      [3, mirror(13)],
    );
    const sync = assigneeSync(
      [
        [1, [JANE]],
        [2, [JDOE]],
        [4, [JANE]],
      ],
      [JANE, JDOE, "other123457"],
    );

    const result = plan(issues, { mirrors: index, assignees: sync });

    assert.deepEqual(describeActions(result.actions), [
      "create 4",
      "update 2 #12 title",
      "close 3 -> #13",
      `addAssignees 1 +${JANE}`,
      "removeAssignees 1 #11 -other123457",
      `addAssignees 2 +${JDOE}`,
      `addAssignees 4 +${JANE}`,
    ]);
  });

  it("caps assignee writes first: the prefix cap reaches them last", () => {
    const issues = [ytIssue(1), resolvedIssue(2), ytIssue(3)];
    const index = mirrors([2, mirror(12)], [3, mirror(13)]);
    const sync = assigneeSync([
      [1, [JANE]],
      [3, [JDOE]],
    ]);

    const result = plan(issues, { mirrors: index, assignees: sync, maxWrites: 3 });

    assert.deepEqual(describeActions(result.actions), ["create 1", "close 2 -> #12", `addAssignees 1 +${JANE}`]);
    assert.equal(result.capped, 1);
  });

  it("costs one write per assignee action, whatever the number of logins", () => {
    const issue = ytIssue(5);
    const ref = mirrors([5, mirror(12)]).get(5);
    assert.ok(ref);
    const add: Action = { kind: "addAssignees", issue, logins: [JANE, JDOE] };
    const remove: Action = { kind: "removeAssignees", issue, mirror: ref, logins: [JANE, JDOE] };

    assert.equal(writeCost(add), 1);
    assert.equal(writeCost(remove), 1);
  });

  it("keeps the counts adding up when issues need only assignee writes", () => {
    const index = mirrors([1, mirror(11)], [2, mirror(12)]);

    const result = plan([ytIssue(1), ytIssue(2)], { mirrors: index, assignees: assigneeSync([[1, [JANE]]]) });

    assertCountsAddUp(result);
    assert.deepEqual(counts(result), { scanned: 2, filtered: 0, unchanged: 1, capped: 0 });
  });
});

describe("planActions: GitHub's limit of 10 assignees", () => {
  it("shares one limit with the GitHub client", () => {
    assert.equal(GITHUB_MAX_ASSIGNEES, MAX_ASSIGNEES_PER_ISSUE);
  });

  it("adds nothing to a full mirror and warns with ids and counts only", () => {
    const index = mirrors([9, mirror(40, { assignees: staff(10) })]);

    const result = plan([ytIssue(9)], { mirrors: index, assignees: assigneeSync([[9, [JANE]]]) });

    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.warnings, ["CUI-9 #40: 1 matched assignee not added: GitHub allows 10 per issue"]);
  });

  it("adds what fits, counting every current assignee before removes, and warns about the rest", () => {
    const assignees = Object.freeze([...staff(8), user(JDOE)]);
    const index = mirrors([9, mirror(40, { assignees })]);
    const sync = assigneeSync([[9, [JANE, "other123457", "third123458"]]], [JANE, JDOE, "other123457", "third123458"]);

    const result = plan([ytIssue(9)], { mirrors: index, assignees: sync });

    assert.deepEqual(describeActions(result.actions), [`addAssignees 9 +${JANE}`, `removeAssignees 9 #40 -${JDOE}`]);
    assert.deepEqual(result.warnings, ["CUI-9 #40: 2 matched assignees not added: GitHub allows 10 per issue"]);
  });

  it("cuts the adds of a mirror created this run to 10, naming it (new)", () => {
    const desired = logins(12, "student");

    const result = plan([ytIssue(9)], { assignees: assigneeSync([[9, desired]]) });

    assert.deepEqual(result.actions[1], {
      kind: "addAssignees",
      issue: result.actions[0]?.issue,
      logins: desired.slice(0, 10),
    });
    assert.deepEqual(result.warnings, ["CUI-9 (new): 2 matched assignees not added: GitHub allows 10 per issue"]);
  });

  it("puts the limit warnings after the milestone and parent-cycle warnings", () => {
    const issues = [task(1, under(2)), task(2, under(1)), ytIssue(9)];
    const index = mirrors([9, mirror(40, { assignees: staff(10) })]);

    const result = plan(issues, { mirrors: index, assignees: assigneeSync([[9, [JANE]]]) });

    assert.equal(result.warnings.length, 2);
    assert.match(result.warnings[0] ?? "", /parent chain loops back/);
    assert.equal(result.warnings[1], "CUI-9 #40: 1 matched assignee not added: GitHub allows 10 per issue");
  });
});
