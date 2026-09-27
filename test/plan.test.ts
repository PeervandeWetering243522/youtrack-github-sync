import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GitHubIssue, IssueState } from "../src/github.ts";
import { buildMirrorIndex, planActions, writeCost } from "../src/plan.ts";
import type { Action, MirrorIndex, MirrorRef, Plan } from "../src/plan.ts";
import type { YouTrackIssue } from "../src/youtrack.ts";

// ---------------------------------------------------------------------------
// Fixtures (all frozen, so any mutation by the code under test throws)
// ---------------------------------------------------------------------------

const LABEL = "youtrack";
const PREFIX = "[team]";
const RESOLVED_AT = 1_758_000_000_000;

function ghIssue(issueNumber: number, title: string, overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  const labelNames = Object.freeze([...(overrides.labelNames ?? [LABEL])]);
  return Object.freeze({ number: issueNumber, title, state: "open", isPullRequest: false, ...overrides, labelNames });
}

function unlabelled(issueNumber: number, title: string, overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return ghIssue(issueNumber, title, { ...overrides, labelNames: [] });
}

function ytIssue(numberInProject: number, overrides: Partial<YouTrackIssue> = {}): YouTrackIssue {
  return Object.freeze({
    idReadable: `CUI-${String(numberInProject)}`,
    numberInProject,
    summary: `${PREFIX} Issue ${String(numberInProject)}`,
    description: null,
    resolved: null,
    updated: 0,
    ...overrides,
  });
}

function resolvedIssue(numberInProject: number, overrides: Partial<YouTrackIssue> = {}): YouTrackIssue {
  return ytIssue(numberInProject, { resolved: RESOLVED_AT, ...overrides });
}

function mirror(issueNumber: number, state: IssueState = "open", hasLabel = true): MirrorRef {
  return Object.freeze({ issueNumber, state, hasLabel });
}

/** A Map whose mutators throw, since Object.freeze does not stop Map#set. */
function lockedMap<K, V>(entries: readonly (readonly [K, V])[]): ReadonlyMap<K, V> {
  const refuse = (): never => {
    throw new TypeError("input map is read-only");
  };
  return Object.freeze(Object.assign(new Map(entries), { set: refuse, delete: refuse, clear: refuse }));
}

const NO_MIRRORS: MirrorIndex = lockedMap<number, MirrorRef>([]);

function plan(
  youtrackIssues: readonly YouTrackIssue[],
  options: { readonly mirrors?: MirrorIndex; readonly maxWrites?: number; readonly titlePrefix?: string } = {},
): Plan {
  return planActions({
    youtrackIssues: Object.freeze([...youtrackIssues]),
    mirrors: options.mirrors ?? NO_MIRRORS,
    titlePrefix: options.titlePrefix ?? PREFIX,
    maxWrites: options.maxWrites ?? 30,
  });
}

/** Compact view of actions: "create 3", "close 5 -> #12". */
function describeActions(actions: readonly Action[]): readonly string[] {
  return actions.map((action) => {
    const n = String(action.issue.numberInProject);
    return action.kind === "close" ? `close ${n} -> #${String(action.mirror.issueNumber)}` : `create ${n}`;
  });
}

function assertCountsAddUp(result: Plan): void {
  assert.equal(result.scanned, result.filtered + result.unchanged + result.actions.length + result.capped);
}

// ---------------------------------------------------------------------------
// buildMirrorIndex
// ---------------------------------------------------------------------------

describe("buildMirrorIndex: matching", () => {
  it("returns an empty index and no warnings for an empty list", () => {
    const result = buildMirrorIndex(Object.freeze([]), LABEL);

    assert.equal(result.index.size, 0);
    assert.deepEqual(result.warnings, []);
  });

  it("indexes a labelled mirror by the number in its title, keeping state and label", () => {
    const issues = Object.freeze([ghIssue(12, "[YT-5] Fix it"), ghIssue(13, "[YT-6] Done", { state: "closed" })]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(
      [...result.index.entries()],
      [
        [5, { issueNumber: 12, state: "open", hasLabel: true }],
        [6, { issueNumber: 13, state: "closed", hasLabel: true }],
      ],
    );
    assert.deepEqual(result.warnings, []);
  });

  it("ignores titles that are not mirror titles", () => {
    const issues = Object.freeze([
      ghIssue(1, "Fix [YT-3] later"),
      ghIssue(2, "[yt-3] lower case"),
      ghIssue(3, "[YT-0] zero"),
      ghIssue(4, " [YT-3] leading space"),
      ghIssue(5, "[YT-] no number"),
    ]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.equal(result.index.size, 0);
    assert.deepEqual(result.warnings, []);
  });

  it("ignores pull requests, even labelled ones with a lower number", () => {
    const issues = Object.freeze([ghIssue(3, "[YT-5] PR", { isPullRequest: true }), ghIssue(12, "[YT-5] Fix it")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(result.index.get(5), { issueNumber: 12, state: "open", hasLabel: true });
    assert.deepEqual(result.warnings, []);
  });

  it("gives no mirror when only a pull request carries the title", () => {
    const issues = Object.freeze([ghIssue(3, "[YT-5] PR", { isPullRequest: true })]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.equal(result.index.has(5), false);
    assert.deepEqual(result.warnings, []);
  });

  it("uses the given label name, not other labels", () => {
    const issues = Object.freeze([ghIssue(12, "[YT-5] Fix it", { labelNames: ["bug", "YouTrack-ish"] })]);

    const result = buildMirrorIndex(issues, "mirror");

    assert.equal(result.index.get(5)?.hasLabel, false);
    assert.deepEqual(result.warnings, ['YT-5: #12 matched by title only (no "mirror" label)']);
  });

  it("does not report an issue listed twice as its own duplicate", () => {
    const issue = ghIssue(12, "[YT-5] Fix it");

    const result = buildMirrorIndex(Object.freeze([issue, issue]), LABEL);

    assert.deepEqual(result.index.get(5), { issueNumber: 12, state: "open", hasLabel: true });
    assert.deepEqual(result.warnings, []);
  });

  it("keeps the first copy of an issue listed twice with a changed state", () => {
    const issues = Object.freeze([ghIssue(12, "[YT-5] Fix it"), ghIssue(12, "[YT-5] Fix it", { state: "closed" })]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(result.index.get(5), { issueNumber: 12, state: "open", hasLabel: true });
    assert.deepEqual(result.warnings, []);
  });

  it("matches the label case-insensitively, as GitHub does (docs/03, gotcha 14)", () => {
    const issues = Object.freeze([
      ghIssue(12, "[YT-5] Upper", { labelNames: ["YouTrack"] }),
      ghIssue(13, "[YT-6] Shout", { labelNames: ["bug", "YOUTRACK"] }),
    ]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.equal(result.index.get(5)?.hasLabel, true);
    assert.equal(result.index.get(6)?.hasLabel, true);
    assert.deepEqual(result.warnings, []);
  });

  it("does not count a label that merely contains the name", () => {
    const issues = Object.freeze([ghIssue(12, "[YT-5] Fix it", { labelNames: ["youtrack-old", " youtrack", "you track"] })]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.equal(result.index.get(5)?.hasLabel, false);
  });

  it("parses the mirror number from the title, tolerating leading zeros", () => {
    const issues = Object.freeze([ghIssue(12, "[YT-007] Padded"), ghIssue(13, "[YT-10]"), ghIssue(14, "[YT-9]x")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual([...result.index.keys()], [7, 9, 10]);
  });
});

describe("buildMirrorIndex: precedence and warnings", () => {
  it("prefers a labelled candidate over an unlabelled one with a lower number", () => {
    const issues = Object.freeze([unlabelled(12, "[YT-5] Old"), ghIssue(15, "[YT-5] New")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(result.index.get(5), { issueNumber: 15, state: "open", hasLabel: true });
    assert.deepEqual(result.warnings, ["YT-5: 2 GitHub issues match; using #15 (labelled), ignoring #12"]);
  });

  it("picks the lowest issue number among labelled candidates, whatever the list order", () => {
    const issues = Object.freeze([ghIssue(15, "[YT-5] B", { state: "closed" }), ghIssue(12, "[YT-5] A")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(result.index.get(5), { issueNumber: 12, state: "open", hasLabel: true });
    assert.deepEqual(result.warnings, ["YT-5: 2 GitHub issues match; using #12 (labelled), ignoring #15"]);
  });

  it("picks the lowest issue number among unlabelled candidates and warns about both", () => {
    const issues = Object.freeze([unlabelled(20, "[YT-7] B"), unlabelled(18, "[YT-7] A")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(result.index.get(7), { issueNumber: 18, state: "open", hasLabel: false });
    assert.deepEqual(result.warnings, [
      'YT-7: #18 matched by title only (no "youtrack" label)',
      "YT-7: 2 GitHub issues match; using #18 (unlabelled), ignoring #20",
    ]);
  });

  it("adds one warning per extra candidate", () => {
    const issues = Object.freeze([unlabelled(9, "[YT-5] A"), ghIssue(30, "[YT-5] C"), ghIssue(21, "[YT-5] B")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.equal(result.index.get(5)?.issueNumber, 21);
    assert.deepEqual(result.warnings, [
      "YT-5: 3 GitHub issues match; using #21 (labelled), ignoring #30",
      "YT-5: 3 GitHub issues match; using #21 (labelled), ignoring #9",
    ]);
  });

  it("warns when the only match is unlabelled, and still uses it", () => {
    const issues = Object.freeze([unlabelled(12, "[YT-5] Fix it", { state: "closed" })]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(result.index.get(5), { issueNumber: 12, state: "closed", hasLabel: false });
    assert.deepEqual(result.warnings, ['YT-5: #12 matched by title only (no "youtrack" label)']);
  });

  it("orders warnings by YouTrack number, whatever the list order", () => {
    const issues = Object.freeze([unlabelled(40, "[YT-9] Later"), unlabelled(41, "[YT-2] Earlier")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(result.warnings, [
      'YT-2: #41 matched by title only (no "youtrack" label)',
      'YT-9: #40 matched by title only (no "youtrack" label)',
    ]);
  });

  it("compares issue numbers numerically, not as text", () => {
    const issues = Object.freeze([ghIssue(100, "[YT-5] A"), ghIssue(99, "[YT-5] B")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.equal(result.index.get(5)?.issueNumber, 99);
    assert.deepEqual(result.warnings, ["YT-5: 2 GitHub issues match; using #99 (labelled), ignoring #100"]);
  });

  it("orders warnings by YouTrack number numerically, not as text", () => {
    const issues = Object.freeze([unlabelled(1, "[YT-10] Ten"), unlabelled(2, "[YT-9] Nine")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(result.warnings, [
      'YT-9: #2 matched by title only (no "youtrack" label)',
      'YT-10: #1 matched by title only (no "youtrack" label)',
    ]);
  });

  it("keeps duplicate groups of different YouTrack numbers apart", () => {
    const issues = Object.freeze([
      ghIssue(31, "[YT-6] B"),
      ghIssue(20, "[YT-5] A"),
      unlabelled(30, "[YT-6] C"),
      ghIssue(21, "[YT-5] D"),
      ghIssue(40, "[YT-7] Alone"),
    ]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(
      [...result.index.entries()].map(([numberInProject, ref]) => [numberInProject, ref.issueNumber]),
      [
        [5, 20],
        [6, 31],
        [7, 40],
      ],
    );
    assert.deepEqual(result.warnings, [
      "YT-5: 2 GitHub issues match; using #20 (labelled), ignoring #21",
      "YT-6: 2 GitHub issues match; using #31 (labelled), ignoring #30",
    ]);
  });

  it("uses a closed labelled mirror over an open unlabelled one", () => {
    const issues = Object.freeze([unlabelled(12, "[YT-5] Open copy"), ghIssue(15, "[YT-5] Closed", { state: "closed" })]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(result.index.get(5), { issueNumber: 15, state: "closed", hasLabel: true });
  });

  it("never puts issue titles into warnings", () => {
    const issues = Object.freeze([unlabelled(12, "[YT-5] secret-title"), unlabelled(13, "[YT-5] secret-title")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.equal(result.warnings.length, 2);
    assert.ok(result.warnings.every((warning) => !warning.includes("secret-title")));
  });

  it("leaves its frozen input untouched", () => {
    const issues = Object.freeze([ghIssue(15, "[YT-5] B"), unlabelled(12, "[YT-5] A"), ghIssue(3, "[YT-1] C")]);
    const snapshot = structuredClone(issues);

    buildMirrorIndex(issues, LABEL);

    assert.deepEqual(issues, snapshot);
  });
});

// ---------------------------------------------------------------------------
// writeCost
// ---------------------------------------------------------------------------

describe("writeCost", () => {
  it("costs 1 for a create", () => {
    assert.equal(writeCost({ kind: "create", issue: ytIssue(1) }), 1);
  });

  it("costs 1 for a close", () => {
    assert.equal(writeCost({ kind: "close", issue: resolvedIssue(1), mirror: mirror(12) }), 1);
  });
});

// ---------------------------------------------------------------------------
// planActions
// ---------------------------------------------------------------------------

describe("planActions: decisions", () => {
  it("creates a mirror for an unresolved issue without one", () => {
    const issue = ytIssue(3);

    const result = plan([issue]);

    assert.deepEqual(result.actions, [{ kind: "create", issue }]);
    assert.deepEqual({ ...result, actions: [] }, { actions: [], scanned: 1, filtered: 0, unchanged: 0, capped: 0 });
  });

  it("never creates a mirror for an already-resolved issue, and counts it as unchanged (R9)", () => {
    const result = plan([resolvedIssue(3)]);

    assert.deepEqual(result, { actions: [], scanned: 1, filtered: 0, unchanged: 1, capped: 0 });
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
    const ref = mirror(12, "open");

    const result = plan([issue], { mirrors: lockedMap([[5, ref]]) });

    assert.deepEqual(result.actions, [{ kind: "close", issue, mirror: ref }]);
    assert.equal(result.unchanged, 0);
  });

  it("leaves an open mirror of an unresolved issue unchanged", () => {
    const result = plan([ytIssue(5)], { mirrors: lockedMap([[5, mirror(12, "open")]]) });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 1);
  });

  it("leaves a closed mirror of a resolved issue unchanged", () => {
    const result = plan([resolvedIssue(5)], { mirrors: lockedMap([[5, mirror(12, "closed")]]) });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 1);
  });

  it("never reopens a closed mirror of an unresolved issue", () => {
    const result = plan([ytIssue(5)], { mirrors: lockedMap([[5, mirror(12, "closed")]]) });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 1);
  });

  it("treats an unlabelled mirror like a labelled one", () => {
    const ref = mirror(12, "open", false);

    const result = plan([resolvedIssue(5)], { mirrors: lockedMap([[5, ref]]) });

    assert.deepEqual(describeActions(result.actions), ["close 5 -> #12"]);
  });

  it("returns an empty plan for no issues", () => {
    const result = plan([]);

    assert.deepEqual(result, { actions: [], scanned: 0, filtered: 0, unchanged: 0, capped: 0 });
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
      [4, mirror(10, "open")],
      [99, mirror(11, "open")],
    ]);

    const result = plan([ytIssue(5)], { mirrors });

    assert.deepEqual(describeActions(result.actions), ["create 5"]);
    assert.deepEqual({ ...result, actions: [] }, { actions: [], scanned: 1, filtered: 0, unchanged: 0, capped: 0 });
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

    assert.deepEqual(result, { actions: [], scanned: 2, filtered: 2, unchanged: 0, capped: 0 });
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
      [5, mirror(12, "open")],
      [6, mirror(13, "open")],
    ]);

    const result = plan(issues, { mirrors });

    assert.deepEqual(result, { actions: [], scanned: 2, filtered: 2, unchanged: 0, capped: 0 });
  });

  it("counts filtered issues outside the cap, never as capped", () => {
    const issues = [ytIssue(1, { summary: "Other" }), ytIssue(2), ytIssue(3, { summary: "Other" }), ytIssue(4)];

    const result = plan(issues, { maxWrites: 1 });

    assert.deepEqual(describeActions(result.actions), ["create 2"]);
    assert.deepEqual({ ...result, actions: [] }, { actions: [], scanned: 4, filtered: 2, unchanged: 0, capped: 1 });
  });
});

describe("planActions: order and counts", () => {
  it("orders actions by ascending numberInProject regardless of input order", () => {
    const issues = [ytIssue(9), resolvedIssue(2), ytIssue(27), resolvedIssue(5), ytIssue(1)];
    const mirrors = lockedMap([[5, mirror(40)]]);

    const result = plan(issues, { mirrors });

    assert.deepEqual(describeActions(result.actions), ["create 1", "close 5 -> #40", "create 9", "create 27"]);
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
      [4, mirror(10, "open")],
      [5, mirror(11, "open")],
      [6, mirror(12, "closed")],
    ]);

    const result = plan(issues, { mirrors, maxWrites: 1 });

    // YT-3 (resolved, no mirror), YT-5 and YT-6 are unchanged; YT-4's close is capped.
    assert.deepEqual(describeActions(result.actions), ["create 2"]);
    assert.deepEqual({ ...result, actions: [] }, { actions: [], scanned: 7, filtered: 2, unchanged: 3, capped: 1 });
    assertCountsAddUp(result);
  });
});

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
    assert.deepEqual({ ...result, actions: [] }, { actions: [], scanned: 3, filtered: 0, unchanged: 1, capped: 1 });
  });

  it("does not let a later action jump ahead of a close that does not fit", () => {
    const issues = [ytIssue(1), resolvedIssue(2), ytIssue(3)];
    const mirrors = lockedMap([[2, mirror(20)]]);

    const result = plan(issues, { mirrors, maxWrites: 1 });

    assert.deepEqual(describeActions(result.actions), ["create 1"]);
    assert.equal(result.capped, 2);
    assertCountsAddUp(result);
  });

  it("plans nothing and caps every action when maxWrites is 0", () => {
    const issues = [ytIssue(1), resolvedIssue(2), ytIssue(3, { summary: "Other" })];

    const result = plan(issues, { mirrors: lockedMap([[2, mirror(20)]]), maxWrites: 0 });

    assert.deepEqual(result, { actions: [], scanned: 3, filtered: 1, unchanged: 0, capped: 2 });
  });

  it("reports nothing capped when maxWrites is 0 but nothing needs doing", () => {
    const result = plan([ytIssue(1)], { mirrors: lockedMap([[1, mirror(9)]]), maxWrites: 0 });

    assert.deepEqual(result, { actions: [], scanned: 1, filtered: 0, unchanged: 1, capped: 0 });
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

  it("takes the oldest action first under a cap of 1, even when it is a close", () => {
    const issues = [resolvedIssue(1), ytIssue(2)];

    const result = plan(issues, { mirrors: lockedMap([[1, mirror(101)]]), maxWrites: 1 });

    assert.deepEqual(describeActions(result.actions), ["close 1 -> #101"]);
    assert.equal(result.capped, 1);
  });

  it("takes every action under an unlimited cap", () => {
    const issues = [resolvedIssue(1), resolvedIssue(2), ytIssue(3)];

    const result = plan(issues, { mirrors: lockedMap([[1, mirror(101)]]), maxWrites: Number.POSITIVE_INFINITY });

    assert.deepEqual(describeActions(result.actions), ["close 1 -> #101", "create 3"]);
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
    assert.deepEqual(everything, ["create 1", "create 3", "close 4 -> #20", "create 5", "close 6 -> #21"]);

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

describe("planActions: immutability", () => {
  it("leaves frozen issues, their order and a locked mirror map untouched", () => {
    const issues = Object.freeze([resolvedIssue(9), ytIssue(2), resolvedIssue(5)]);
    const mirrors = lockedMap([[5, mirror(40)]]);
    const issuesBefore = structuredClone(issues);
    const mirrorsBefore = structuredClone([...mirrors.entries()]);

    const result = planActions({ youtrackIssues: issues, mirrors, titlePrefix: PREFIX, maxWrites: 30 });

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
