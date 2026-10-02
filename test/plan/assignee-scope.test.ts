/**
 * Which issues take part in assignee sync (docs/13 §2.3; U7, U13, R9, F1-F3): the one
 * predicate the assignee stage and the planner share.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assigneeEligible } from "../../src/plan/assignee-scope.ts";
import type { MirrorIndex } from "../../src/plan/mirrors.ts";
import type { YouTrackIssue } from "../../src/youtrack.ts";
import {
  bug,
  closedMirror,
  epic,
  EXCLUDE_PREFIX,
  FILTERED,
  mirror,
  mirrors,
  NO_MIRRORS,
  resolvedIssue,
  story,
  task,
  under,
  ytIssue,
} from "./fixtures.ts";

function eligible(issues: readonly YouTrackIssue[], index: MirrorIndex = NO_MIRRORS): readonly number[] {
  const result = assigneeEligible({
    youtrackIssues: Object.freeze([...issues]),
    mirrors: index,
    excludePrefix: EXCLUDE_PREFIX,
  });
  return [...result].sort((a, b) => a - b);
}

describe("assigneeEligible: eligible issues", () => {
  it("includes an unresolved issue with an open mirror", () => {
    assert.deepEqual(eligible([ytIssue(5)], mirrors([5, mirror(12)])), [5]);
  });

  it("includes an unresolved issue without a mirror, which gets a create this run", () => {
    assert.deepEqual(eligible([ytIssue(5)]), [5]);
  });

  it("includes every non-epic kind: user story, bug, task and untyped", () => {
    const issues = [story(1), bug(2), task(3, under(1)), ytIssue(4)];

    assert.deepEqual(eligible(issues), [1, 2, 3, 4]);
  });
});

describe("assigneeEligible: issues left out", () => {
  it("leaves out an unresolved issue whose mirror is closed (U7), even one R10 would reopen", () => {
    assert.deepEqual(eligible([ytIssue(5)], mirrors([5, closedMirror(12, "github-actions[bot]")])), []);
  });

  it("leaves out a resolved issue, with or without a mirror", () => {
    assert.deepEqual(eligible([resolvedIssue(5), resolvedIssue(6)], mirrors([5, mirror(12)])), []);
  });

  it("leaves out an epic, with or without a milestone (U13)", () => {
    assert.deepEqual(eligible([epic(1), epic(2)], mirrors([2, mirror(12)])), []);
  });

  it("leaves out an issue excluded by its own prefix (F1)", () => {
    assert.deepEqual(eligible([ytIssue(5, FILTERED)], mirrors([5, mirror(12)])), []);
  });

  it("leaves out an issue excluded by an ancestor's prefix, an epic's included (F3)", () => {
    const issues = [epic(1, FILTERED), story(2, under(1)), task(3, under(2)), ytIssue(4)];

    assert.deepEqual(eligible(issues), [4]);
  });

  it("decides a repeated number by its first listed row, as the planner does", () => {
    const issues = [ytIssue(5), resolvedIssue(5)];

    assert.deepEqual(eligible(issues), [5]);
  });
});
