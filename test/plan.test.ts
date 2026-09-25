import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GitHubIssue, IssueState } from "../src/github.ts";
import { buildMirrorIndex, planActions, writeCost } from "../src/plan.ts";
import type { Action, MirrorIndex, MirrorRef, Plan } from "../src/plan.ts";
import type { YouTrackIssue } from "../src/youtrack.ts";

// node:test's describe/it return promises that the runner itself tracks; `void`
// marks them as handled for no-floating-promises without disabling the rule.

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

/** Compact view of actions: "create 3", "create+close 4", "close 5 -> #12". */
function describeActions(actions: readonly Action[]): readonly string[] {
  return actions.map((action) => {
    const n = String(action.issue.numberInProject);
    if (action.kind === "close") return `close ${n} -> #${String(action.mirror.issueNumber)}`;
    return action.closeAfter ? `create+close ${n}` : `create ${n}`;
  });
}

function assertCountsAddUp(result: Plan): void {
  const needingAction = result.actions.length + result.capped;
  assert.equal(result.scanned, result.filtered + result.unchanged + needingAction);
}

// ---------------------------------------------------------------------------
// buildMirrorIndex
// ---------------------------------------------------------------------------

void describe("buildMirrorIndex: matching", () => {
  void it("returns an empty index and no warnings for an empty list", () => {
    const result = buildMirrorIndex(Object.freeze([]), LABEL);

    assert.equal(result.index.size, 0);
    assert.deepEqual(result.warnings, []);
  });

  void it("indexes a labelled mirror by the number in its title, keeping state and label", () => {
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

  void it("ignores titles that are not mirror titles", () => {
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

  void it("ignores pull requests, even labelled ones with a lower number", () => {
    const issues = Object.freeze([ghIssue(3, "[YT-5] PR", { isPullRequest: true }), ghIssue(12, "[YT-5] Fix it")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(result.index.get(5), { issueNumber: 12, state: "open", hasLabel: true });
    assert.deepEqual(result.warnings, []);
  });

  void it("gives no mirror when only a pull request carries the title", () => {
    const issues = Object.freeze([ghIssue(3, "[YT-5] PR", { isPullRequest: true })]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.equal(result.index.has(5), false);
    assert.deepEqual(result.warnings, []);
  });

  void it("uses the given label name, not other labels", () => {
    const issues = Object.freeze([ghIssue(12, "[YT-5] Fix it", { labelNames: ["bug", "YouTrack-ish"] })]);

    const result = buildMirrorIndex(issues, "mirror");

    assert.equal(result.index.get(5)?.hasLabel, false);
    assert.deepEqual(result.warnings, ['YT-5: #12 matched by title only (no "mirror" label)']);
  });

  void it("does not report an issue listed twice as its own duplicate", () => {
    const issue = ghIssue(12, "[YT-5] Fix it");

    const result = buildMirrorIndex(Object.freeze([issue, issue]), LABEL);

    assert.deepEqual(result.index.get(5), { issueNumber: 12, state: "open", hasLabel: true });
    assert.deepEqual(result.warnings, []);
  });

  void it("keeps the first copy of an issue listed twice with a changed state", () => {
    const issues = Object.freeze([ghIssue(12, "[YT-5] Fix it"), ghIssue(12, "[YT-5] Fix it", { state: "closed" })]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(result.index.get(5), { issueNumber: 12, state: "open", hasLabel: true });
    assert.deepEqual(result.warnings, []);
  });

  void it("matches the label case-insensitively, as GitHub does (docs/03, gotcha 14)", () => {
    const issues = Object.freeze([
      ghIssue(12, "[YT-5] Upper", { labelNames: ["YouTrack"] }),
      ghIssue(13, "[YT-6] Shout", { labelNames: ["bug", "YOUTRACK"] }),
    ]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.equal(result.index.get(5)?.hasLabel, true);
    assert.equal(result.index.get(6)?.hasLabel, true);
    assert.deepEqual(result.warnings, []);
  });

  void it("does not count a label that merely contains the name", () => {
    const issues = Object.freeze([ghIssue(12, "[YT-5] Fix it", { labelNames: ["youtrack-old", " youtrack", "you track"] })]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.equal(result.index.get(5)?.hasLabel, false);
  });

  void it("parses the mirror number from the title, tolerating leading zeros", () => {
    const issues = Object.freeze([ghIssue(12, "[YT-007] Padded"), ghIssue(13, "[YT-10]"), ghIssue(14, "[YT-9]x")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual([...result.index.keys()], [7, 9, 10]);
  });
});

void describe("buildMirrorIndex: precedence and warnings", () => {
  void it("prefers a labelled candidate over an unlabelled one with a lower number", () => {
    const issues = Object.freeze([unlabelled(12, "[YT-5] Old"), ghIssue(15, "[YT-5] New")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(result.index.get(5), { issueNumber: 15, state: "open", hasLabel: true });
    assert.deepEqual(result.warnings, ["YT-5: 2 GitHub issues match; using #15 (labelled), ignoring #12"]);
  });

  void it("picks the lowest issue number among labelled candidates, whatever the list order", () => {
    const issues = Object.freeze([ghIssue(15, "[YT-5] B", { state: "closed" }), ghIssue(12, "[YT-5] A")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(result.index.get(5), { issueNumber: 12, state: "open", hasLabel: true });
    assert.deepEqual(result.warnings, ["YT-5: 2 GitHub issues match; using #12 (labelled), ignoring #15"]);
  });

  void it("picks the lowest issue number among unlabelled candidates and warns about both", () => {
    const issues = Object.freeze([unlabelled(20, "[YT-7] B"), unlabelled(18, "[YT-7] A")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(result.index.get(7), { issueNumber: 18, state: "open", hasLabel: false });
    assert.deepEqual(result.warnings, [
      'YT-7: #18 matched by title only (no "youtrack" label)',
      "YT-7: 2 GitHub issues match; using #18 (unlabelled), ignoring #20",
    ]);
  });

  void it("adds one warning per extra candidate", () => {
    const issues = Object.freeze([unlabelled(9, "[YT-5] A"), ghIssue(30, "[YT-5] C"), ghIssue(21, "[YT-5] B")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.equal(result.index.get(5)?.issueNumber, 21);
    assert.deepEqual(result.warnings, [
      "YT-5: 3 GitHub issues match; using #21 (labelled), ignoring #30",
      "YT-5: 3 GitHub issues match; using #21 (labelled), ignoring #9",
    ]);
  });

  void it("warns when the only match is unlabelled, and still uses it", () => {
    const issues = Object.freeze([unlabelled(12, "[YT-5] Fix it", { state: "closed" })]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(result.index.get(5), { issueNumber: 12, state: "closed", hasLabel: false });
    assert.deepEqual(result.warnings, ['YT-5: #12 matched by title only (no "youtrack" label)']);
  });

  void it("orders warnings by YouTrack number, whatever the list order", () => {
    const issues = Object.freeze([unlabelled(40, "[YT-9] Later"), unlabelled(41, "[YT-2] Earlier")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(result.warnings, [
      'YT-2: #41 matched by title only (no "youtrack" label)',
      'YT-9: #40 matched by title only (no "youtrack" label)',
    ]);
  });

  void it("compares issue numbers numerically, not as text", () => {
    const issues = Object.freeze([ghIssue(100, "[YT-5] A"), ghIssue(99, "[YT-5] B")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.equal(result.index.get(5)?.issueNumber, 99);
    assert.deepEqual(result.warnings, ["YT-5: 2 GitHub issues match; using #99 (labelled), ignoring #100"]);
  });

  void it("orders warnings by YouTrack number numerically, not as text", () => {
    const issues = Object.freeze([unlabelled(1, "[YT-10] Ten"), unlabelled(2, "[YT-9] Nine")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(result.warnings, [
      'YT-9: #2 matched by title only (no "youtrack" label)',
      'YT-10: #1 matched by title only (no "youtrack" label)',
    ]);
  });

  void it("keeps duplicate groups of different YouTrack numbers apart", () => {
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

  void it("uses a closed labelled mirror over an open unlabelled one", () => {
    const issues = Object.freeze([unlabelled(12, "[YT-5] Open copy"), ghIssue(15, "[YT-5] Closed", { state: "closed" })]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.deepEqual(result.index.get(5), { issueNumber: 15, state: "closed", hasLabel: true });
  });

  void it("never puts issue titles into warnings", () => {
    const issues = Object.freeze([unlabelled(12, "[YT-5] secret-title"), unlabelled(13, "[YT-5] secret-title")]);

    const result = buildMirrorIndex(issues, LABEL);

    assert.equal(result.warnings.length, 2);
    assert.ok(result.warnings.every((warning) => !warning.includes("secret-title")));
  });

  void it("leaves its frozen input untouched", () => {
    const issues = Object.freeze([ghIssue(15, "[YT-5] B"), unlabelled(12, "[YT-5] A"), ghIssue(3, "[YT-1] C")]);
    const snapshot = structuredClone(issues);

    buildMirrorIndex(issues, LABEL);

    assert.deepEqual(issues, snapshot);
  });
});

// ---------------------------------------------------------------------------
// writeCost
// ---------------------------------------------------------------------------

void describe("writeCost", () => {
  void it("costs 1 for a create of an unresolved issue", () => {
    assert.equal(writeCost({ kind: "create", issue: ytIssue(1), closeAfter: false }), 1);
  });

  void it("costs 2 for a create that is closed right after", () => {
    assert.equal(writeCost({ kind: "create", issue: resolvedIssue(1), closeAfter: true }), 2);
  });

  void it("costs 1 for a close", () => {
    assert.equal(writeCost({ kind: "close", issue: resolvedIssue(1), mirror: mirror(12) }), 1);
  });
});

// ---------------------------------------------------------------------------
// planActions
// ---------------------------------------------------------------------------

void describe("planActions: decisions", () => {
  void it("creates a mirror for an unresolved issue without one, not closed after", () => {
    const issue = ytIssue(3);

    const result = plan([issue]);

    assert.deepEqual(result.actions, [{ kind: "create", issue, closeAfter: false }]);
    assert.deepEqual({ ...result, actions: [] }, { actions: [], scanned: 1, filtered: 0, unchanged: 0, capped: 0 });
  });

  void it("creates and then closes a mirror for a resolved issue without one", () => {
    const issue = resolvedIssue(3);

    const result = plan([issue]);

    assert.deepEqual(result.actions, [{ kind: "create", issue, closeAfter: true }]);
  });

  void it("closes an open mirror of a resolved issue", () => {
    const issue = resolvedIssue(5);
    const ref = mirror(12, "open");

    const result = plan([issue], { mirrors: lockedMap([[5, ref]]) });

    assert.deepEqual(result.actions, [{ kind: "close", issue, mirror: ref }]);
    assert.equal(result.unchanged, 0);
  });

  void it("leaves an open mirror of an unresolved issue unchanged", () => {
    const result = plan([ytIssue(5)], { mirrors: lockedMap([[5, mirror(12, "open")]]) });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 1);
  });

  void it("leaves a closed mirror of a resolved issue unchanged", () => {
    const result = plan([resolvedIssue(5)], { mirrors: lockedMap([[5, mirror(12, "closed")]]) });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 1);
  });

  void it("never reopens a closed mirror of an unresolved issue", () => {
    const result = plan([ytIssue(5)], { mirrors: lockedMap([[5, mirror(12, "closed")]]) });

    assert.deepEqual(result.actions, []);
    assert.equal(result.unchanged, 1);
  });

  void it("treats an unlabelled mirror like a labelled one", () => {
    const ref = mirror(12, "open", false);

    const result = plan([resolvedIssue(5)], { mirrors: lockedMap([[5, ref]]) });

    assert.deepEqual(describeActions(result.actions), ["close 5 -> #12"]);
  });

  void it("returns an empty plan for no issues", () => {
    const result = plan([]);

    assert.deepEqual(result, { actions: [], scanned: 0, filtered: 0, unchanged: 0, capped: 0 });
  });

  void it("treats a resolved timestamp of 0 as resolved (null is the only unresolved value)", () => {
    const withoutMirror = resolvedIssue(3, { resolved: 0 });
    const withMirror = resolvedIssue(4, { resolved: 0 });

    const result = plan([withoutMirror, withMirror], { mirrors: lockedMap([[4, mirror(12)]]) });

    assert.deepEqual(describeActions(result.actions), ["create+close 3", "close 4 -> #12"]);
  });

  void it("puts the index's own mirror ref into a close action", () => {
    const ref = mirror(12);

    const result = plan([resolvedIssue(5)], { mirrors: lockedMap([[5, ref]]) });

    const [action] = result.actions;
    assert.equal(action?.kind === "close" ? action.mirror : null, ref);
  });

  void it("ignores mirrors whose YouTrack issue is not in the scan", () => {
    const mirrors = lockedMap([
      [4, mirror(10, "open")],
      [99, mirror(11, "open")],
    ]);

    const result = plan([ytIssue(5)], { mirrors });

    assert.deepEqual(describeActions(result.actions), ["create 5"]);
    assert.deepEqual({ ...result, actions: [] }, { actions: [], scanned: 1, filtered: 0, unchanged: 0, capped: 0 });
  });

  void it("plans one action for an issue listed twice, from its first copy", () => {
    const first = ytIssue(5);
    const issues = [ytIssue(9), first, resolvedIssue(5), ytIssue(2)];

    const result = plan(issues);

    assert.deepEqual(describeActions(result.actions), ["create 2", "create 5", "create 9"]);
    assert.equal(result.actions[1]?.issue, first);
    assert.equal(result.scanned, 3);
    assertCountsAddUp(result);
  });
});

void describe("planActions: title prefix filter", () => {
  void it("skips issues whose summary lacks the prefix, even without a mirror", () => {
    const issues = [ytIssue(1, { summary: "Fix [team] later" }), resolvedIssue(2, { summary: "Unrelated" })];

    const result = plan(issues);

    assert.deepEqual(result, { actions: [], scanned: 2, filtered: 2, unchanged: 0, capped: 0 });
  });

  void it("matches the prefix case-insensitively and after leading whitespace", () => {
    const issues = [
      ytIssue(1, { summary: "[TEAM] Upper" }),
      ytIssue(2, { summary: "  [Team] Mixed" }),
      ytIssue(3, { summary: "[team]no space" }),
    ];

    const result = plan(issues, { titlePrefix: "[Team]" });

    assert.deepEqual(describeActions(result.actions), ["create 1", "create 2", "create 3"]);
    assert.equal(result.filtered, 0);
  });

  void it("uses the configured prefix", () => {
    const issues = [ytIssue(1, { summary: "[ops] Deploy" }), ytIssue(2, { summary: "[team] Other" })];

    const result = plan(issues, { titlePrefix: "[ops]" });

    assert.deepEqual(describeActions(result.actions), ["create 1"]);
    assert.equal(result.filtered, 1);
  });

  void it("filters an issue that lost its prefix, even with an open mirror to close", () => {
    const issues = [resolvedIssue(5, { summary: "Renamed" }), ytIssue(6, { summary: "" })];
    const mirrors = lockedMap([
      [5, mirror(12, "open")],
      [6, mirror(13, "open")],
    ]);

    const result = plan(issues, { mirrors });

    assert.deepEqual(result, { actions: [], scanned: 2, filtered: 2, unchanged: 0, capped: 0 });
  });

  void it("counts filtered issues outside the cap, never as capped", () => {
    const issues = [ytIssue(1, { summary: "Other" }), ytIssue(2), ytIssue(3, { summary: "Other" }), ytIssue(4)];

    const result = plan(issues, { maxWrites: 1 });

    assert.deepEqual(describeActions(result.actions), ["create 2"]);
    assert.deepEqual({ ...result, actions: [] }, { actions: [], scanned: 4, filtered: 2, unchanged: 0, capped: 1 });
  });
});

void describe("planActions: order and counts", () => {
  void it("orders actions by ascending numberInProject regardless of input order", () => {
    const issues = [ytIssue(9), resolvedIssue(2), ytIssue(27), resolvedIssue(5), ytIssue(1)];
    const mirrors = lockedMap([[5, mirror(40)]]);

    const result = plan(issues, { mirrors });

    assert.deepEqual(describeActions(result.actions), [
      "create 1",
      "create+close 2",
      "close 5 -> #40",
      "create 9",
      "create 27",
    ]);
  });

  void it("adds up scanned = filtered + unchanged + actions + capped on a mixed project", () => {
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

    const result = plan(issues, { mirrors, maxWrites: 3 });

    assert.deepEqual(describeActions(result.actions), ["create 2", "create+close 3"]);
    assert.deepEqual({ ...result, actions: [] }, { actions: [], scanned: 7, filtered: 2, unchanged: 2, capped: 1 });
    assertCountsAddUp(result);
  });
});

void describe("planActions: write cap", () => {
  void it("takes every action when their costs exactly fill the cap", () => {
    const issues = [ytIssue(1), resolvedIssue(2), resolvedIssue(3)];
    const mirrors = lockedMap([[3, mirror(20)]]);

    const result = plan(issues, { mirrors, maxWrites: 4 });

    assert.deepEqual(describeActions(result.actions), ["create 1", "create+close 2", "close 3 -> #20"]);
    assert.equal(result.capped, 0);
    assertCountsAddUp(result);
  });

  void it("stops at a create+close pair that does not fit, without splitting it", () => {
    const issues = [ytIssue(1), resolvedIssue(2), ytIssue(3)];

    const result = plan(issues, { maxWrites: 2 });

    assert.deepEqual(describeActions(result.actions), ["create 1"]);
    assert.equal(result.capped, 2);
    assertCountsAddUp(result);
  });

  void it("does not let a later, cheaper action jump ahead of one that does not fit", () => {
    const issues = [resolvedIssue(1), ytIssue(2), resolvedIssue(3)];
    const mirrors = lockedMap([[3, mirror(20)]]);

    const result = plan(issues, { mirrors, maxWrites: 1 });

    assert.deepEqual(result.actions, []);
    assert.equal(result.capped, 3);
    assertCountsAddUp(result);
  });

  void it("plans nothing and caps every action when maxWrites is 0", () => {
    const issues = [ytIssue(1), resolvedIssue(2), ytIssue(3, { summary: "Other" })];

    const result = plan(issues, { maxWrites: 0 });

    assert.deepEqual(result, { actions: [], scanned: 3, filtered: 1, unchanged: 0, capped: 2 });
  });

  void it("reports nothing capped when maxWrites is 0 but nothing needs doing", () => {
    const result = plan([ytIssue(1)], { mirrors: lockedMap([[1, mirror(9)]]), maxWrites: 0 });

    assert.deepEqual(result, { actions: [], scanned: 1, filtered: 0, unchanged: 1, capped: 0 });
  });

  void it("caps everything when maxWrites is not a number (fails closed)", () => {
    const result = plan([ytIssue(1)], { maxWrites: Number.NaN });

    assert.deepEqual(result.actions, []);
    assert.equal(result.capped, 1);
  });

  void it("caps everything when maxWrites is negative", () => {
    const result = plan([ytIssue(1), ytIssue(2)], { maxWrites: -1 });

    assert.deepEqual(result.actions, []);
    assert.equal(result.capped, 2);
  });

  void it("fills the cap exactly with a create+close pair that ends on the last write", () => {
    const issues = [ytIssue(1), resolvedIssue(2), ytIssue(3)];

    const result = plan(issues, { maxWrites: 3 });

    assert.deepEqual(describeActions(result.actions), ["create 1", "create+close 2"]);
    assert.equal(result.capped, 1);
    assertCountsAddUp(result);
  });

  void it("takes nothing when the very first action is a pair and only 1 write is allowed", () => {
    const issues = [resolvedIssue(1), ytIssue(2)];

    const result = plan(issues, { maxWrites: 1 });

    assert.deepEqual(result.actions, []);
    assert.equal(result.capped, 2);
  });

  void it("takes every action under an unlimited cap", () => {
    const issues = [resolvedIssue(1), resolvedIssue(2), ytIssue(3)];

    const result = plan(issues, { maxWrites: Number.POSITIVE_INFINITY });

    assert.deepEqual(describeActions(result.actions), ["create+close 1", "create+close 2", "create 3"]);
    assert.equal(result.capped, 0);
  });

  void it("caps by the order of numberInProject, not input order", () => {
    const issues = [ytIssue(30), ytIssue(10), ytIssue(20)];

    const result = plan(issues, { maxWrites: 2 });

    assert.deepEqual(describeActions(result.actions), ["create 10", "create 20"]);
    assert.equal(result.capped, 1);
  });

  void it("plans the longest in-order prefix that fits, for every cap from 0 to 12", () => {
    const issues = [resolvedIssue(1), ytIssue(2), resolvedIssue(3), resolvedIssue(4), ytIssue(5), resolvedIssue(6)];
    const mirrors = lockedMap([[4, mirror(20)]]);
    const everything = describeActions(plan(issues, { mirrors, maxWrites: Number.POSITIVE_INFINITY }).actions);
    // Cumulative cost after each action: 2, 3, 5, 6, 7, 9.
    const expectedCounts = [0, 0, 1, 2, 2, 3, 4, 5, 5, 6, 6, 6, 6];

    for (const [maxWrites, expectedCount] of expectedCounts.entries()) {
      const result = plan(issues, { mirrors, maxWrites });

      const used = result.actions.reduce((total, action) => total + writeCost(action), 0);
      assert.ok(used <= maxWrites, `maxWrites=${String(maxWrites)} used ${String(used)}`);
      assert.deepEqual(describeActions(result.actions), everything.slice(0, expectedCount));
      assert.equal(result.capped, 6 - expectedCount);
      assertCountsAddUp(result);
    }
  });
});

void describe("planActions: immutability", () => {
  void it("leaves frozen issues, their order and a locked mirror map untouched", () => {
    const issues = Object.freeze([resolvedIssue(9), ytIssue(2), resolvedIssue(5)]);
    const mirrors = lockedMap([[5, mirror(40)]]);
    const issuesBefore = structuredClone(issues);
    const mirrorsBefore = structuredClone([...mirrors.entries()]);

    const result = planActions({ youtrackIssues: issues, mirrors, titlePrefix: PREFIX, maxWrites: 30 });

    assert.deepEqual(issues, issuesBefore);
    assert.deepEqual([...mirrors.entries()], mirrorsBefore);
    assert.deepEqual(describeActions(result.actions), ["create 2", "close 5 -> #40", "create+close 9"]);
  });

  void it("returns the input issue objects in its actions, not copies", () => {
    const issue = ytIssue(4);

    const result = plan([issue]);

    assert.equal(result.actions[0]?.issue, issue);
  });
});
