/**
 * Desired assignees, owned logins and the diff (U4, U6, U15; docs/13 §2.6), and the
 * aggregated and none-matched warnings (U3; §2.10, §5). Every person is a placeholder.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loginKey } from "../../src/plan/assignee-match.ts";
import type { MatchOutcome } from "../../src/plan/assignee-match.ts";
import {
  assigneeDiff,
  assigneeWarning,
  desiredAssignees,
  GITHUB_MAX_ASSIGNEES,
  noneMatchedWarning,
  ownedLogins,
} from "../../src/plan/assignees.ts";
import type { CurrentAssignee, NamedPerson } from "../../src/plan/assignees.ts";

const JANE: MatchOutcome = { kind: "matched", login: "JaneDoe123456", step: "login-id" };
const OTHER: MatchOutcome = { kind: "matched", login: "OtherDev", step: "commit" };
const UNMATCHED: MatchOutcome = { kind: "unmatched" };
const BLOCKED: MatchOutcome = { kind: "blocked" };
const NOTHING = { add: [], remove: [], notAdded: 0 } as const;

function person(name: string, login: string): NamedPerson {
  return { name, login, email: null };
}

/** Outcomes keyed the way matchAll keys them. */
function outcomesOf(...entries: readonly (readonly [NamedPerson, MatchOutcome])[]): ReadonlyMap<string, MatchOutcome> {
  return new Map(entries.map(([named, outcome]) => [loginKey(named.login), outcome]));
}

function user(login: string): CurrentAssignee {
  return { login, type: "User" };
}

function staff(count: number): readonly CurrentAssignee[] {
  return Array.from({ length: count }, (_, index) => user(`staffuser${String(index)}`));
}

const P_JANE = person("CUI-12", "jdoe123456");
const P_OTHER = person("CUI-15", "otheruser");
const P_STAFF = person("CUI-20", "staffuser");

describe("desiredAssignees", () => {
  const outcomes = outcomesOf([P_JANE, JANE], [P_OTHER, OTHER], [P_STAFF, UNMATCHED]);

  it("gives the matched logins of the users in the value's order, as the list spells them", () => {
    assert.deepEqual(desiredAssignees([P_OTHER, P_STAFF, P_JANE], outcomes), ["OtherDev", "JaneDoe123456"]);
  });

  it("finds a user in another case and drops a login two users share", () => {
    const twin = person("CUI-12", "jdoe-123456");
    const shared = new Map([...outcomes, [loginKey(twin.login), JANE]]);

    assert.deepEqual(desiredAssignees([{ ...P_JANE, login: "JDOE123456" }, twin], shared), ["JaneDoe123456"]);
  });

  it("is empty for an unassigned issue or one whose users did not match", () => {
    assert.deepEqual(desiredAssignees([], outcomes), []);
    assert.deepEqual(desiredAssignees([P_STAFF, person("CUI-21", "nooutcome")], outcomes), []);
  });
});

describe("ownedLogins", () => {
  it("owns every matched login once, lowercased, and nothing for anyone else", () => {
    const outcomes = outcomesOf(
      [P_JANE, JANE],
      [person("CUI-13", "jdoe-123456"), JANE],
      [P_OTHER, OTHER],
      [P_STAFF, UNMATCHED],
      [person("CUI-22", "blockeduser"), BLOCKED],
      [person("CUI-23", "unsureuser"), { kind: "ambiguous" }],
      [person("CUI-24", "laterusers"), { kind: "not-looked-up" }],
      [person("CUI-25", "mappeduser"), { kind: "map-target-not-assignable" }],
    );

    assert.deepEqual([...ownedLogins(outcomes)], ["janedoe123456", "otherdev"]);
  });
});

describe("assigneeDiff", () => {
  const OWNED = new Set(["janedoe123456", "otherdev"]);

  it("adds a desired login the issue lacks", () => {
    assert.deepEqual(assigneeDiff([], ["JaneDoe123456"], OWNED), { add: ["JaneDoe123456"], remove: [], notAdded: 0 });
  });

  it("removes an owned User the issue should not have, adding the replacement (reassignment)", () => {
    assert.deepEqual(assigneeDiff([user("OtherDev")], ["JaneDoe123456"], OWNED), {
      add: ["JaneDoe123456"],
      remove: ["OtherDev"],
      notAdded: 0,
    });
  });

  it("removes with the issue's spelling", () => {
    const diff = assigneeDiff([user("otherdev"), user("JaneDoe123456")], ["JaneDoe123456"], OWNED);

    assert.deepEqual(diff, { add: [], remove: ["otherdev"], notAdded: 0 });
  });

  it("changes nothing when nothing is desired, so a matched assignee stays (U6)", () => {
    assert.deepEqual(assigneeDiff([user("OtherDev")], [], OWNED), NOTHING);
    assert.deepEqual(assigneeDiff([], [], OWNED), NOTHING);
  });

  it("keeps an owned login that is desired, compared ignoring case", () => {
    assert.deepEqual(assigneeDiff([user("janedoe123456")], ["JaneDoe123456"], OWNED), NOTHING);
  });

  it("never removes or re-sends a Bot or an assignee without a type", () => {
    const current = [
      { login: "OtherDev", type: "Bot" },
      { login: "JaneDoe123456", type: "" },
    ];

    assert.deepEqual(assigneeDiff(current, ["JaneDoe123456"], OWNED), NOTHING);
  });

  it("never removes a User nobody matched this run (staff, or a student who left the list)", () => {
    assert.deepEqual(assigneeDiff([user("staffgh"), user("leftorg123456")], ["JaneDoe123456"], OWNED), {
      add: ["JaneDoe123456"],
      remove: [],
      notAdded: 0,
    });
  });

  it("cuts adds to the free slots counted before removes, and says how many it cut", () => {
    const desired = ["JaneDoe123456", "OtherDev", "ThirdDev"];

    assert.deepEqual(assigneeDiff(staff(9), desired, OWNED), { add: ["JaneDoe123456"], remove: [], notAdded: 2 });
    assert.deepEqual(assigneeDiff(staff(GITHUB_MAX_ASSIGNEES), desired, OWNED), { ...NOTHING, notAdded: 3 });
    assert.deepEqual(assigneeDiff(staff(12), desired, OWNED), { ...NOTHING, notAdded: 3 });
    assert.deepEqual(assigneeDiff([...staff(9), user("OtherDev")], ["JaneDoe123456"], OWNED), {
      add: [],
      remove: ["OtherDev"],
      notAdded: 1,
    });
  });

  it("keeps GitHub's limit of 10", () => {
    assert.equal(GITHUB_MAX_ASSIGNEES, 10);
  });
});

describe("assigneeWarning", () => {
  const PERSONS = [
    person("ABC-12", "unmatcheda"),
    person("ABC-15", "unmatchedb"),
    person("ABC-20", "ambiguousa"),
    person("ABC-31", "laterusera"),
    person("ABC-7", "mappedusera"),
    person("ABC-8", "blockedusera"),
    person("ABC-9", "matchedusera"),
  ];
  const OUTCOMES = new Map<string, MatchOutcome>([
    ["unmatcheda", UNMATCHED],
    ["unmatchedb", UNMATCHED],
    ["ambiguousa", { kind: "ambiguous" }],
    ["laterusera", { kind: "not-looked-up" }],
    ["mappedusera", { kind: "map-target-not-assignable" }],
    ["blockedusera", BLOCKED],
    ["matchedusera", JANE],
  ]);

  it("names each category's persons by issue id, in a fixed order, then the notes", () => {
    const warning = assigneeWarning(PERSONS, OUTCOMES, [
      "commit lookups off: the token lacks Contents read (HTTP 403)",
    ]);

    assert.equal(
      warning,
      "assignees: 2 unmatched (ABC-12, ABC-15), 1 ambiguous (ABC-20), 1 not looked up (ABC-31), " +
        "1 mapped to a login that cannot be assigned (ABC-7); commit lookups off: the token lacks Contents read (HTTP 403)",
    );
  });

  it("leaves out empty categories and joins several notes", () => {
    const warning = assigneeWarning(PERSONS.slice(3, 4), OUTCOMES, ["email search off: GitHub rate limit", "x"]);

    assert.equal(warning, "assignees: 1 not looked up (ABC-31); email search off: GitHub rate limit; x");
  });

  it("names an issue once when two of its persons share a category", () => {
    const persons = [person("ABC-12", "unmatcheda"), person("ABC-12", "unmatchedb")];

    assert.equal(assigneeWarning(persons, OUTCOMES, []), "assignees: 2 unmatched (ABC-12)");
  });

  it("gives the notes alone when every person matched or is blocked", () => {
    assert.equal(
      assigneeWarning(PERSONS.slice(5), OUTCOMES, ["lookup budget of 5 used up"]),
      "assignees: lookup budget of 5 used up",
    );
  });

  it("is null when there is nothing to say; blocked people are never listed", () => {
    assert.equal(assigneeWarning(PERSONS.slice(5), OUTCOMES, []), null);
    assert.equal(assigneeWarning([], new Map(), []), null);
  });

  it("names nobody by login", () => {
    const warning = assigneeWarning(PERSONS, OUTCOMES, []) ?? "";

    for (const { login } of PERSONS) assert.equal(warning.includes(login), false, login);
  });
});

describe("noneMatchedWarning", () => {
  const ALL_MISSED = new Map<string, MatchOutcome>([
    ["unmatcheda", UNMATCHED],
    ["ambiguousa", { kind: "ambiguous" }],
    ["laterusera", { kind: "not-looked-up" }],
    ["mappedusera", { kind: "map-target-not-assignable" }],
    ["blockedusera", BLOCKED],
    ["matchedusera", JANE],
  ]);
  const MISSED = ["unmatcheda", "ambiguousa", "laterusera", "mappedusera"].map((login) => person("ABC-1", login));
  const BLOCKED_PERSON = person("ABC-2", "blockedusera");

  it("counts the persons who are not blocked when none of them matched", () => {
    assert.equal(
      noneMatchedWarning([...MISSED, BLOCKED_PERSON], ALL_MISSED),
      "assignees: none of the 4 YouTrack assignees matched a GitHub account; " +
        "if their YouTrack logins look anonymized, the YouTrack token may lack Read User Basic",
    );
    assert.equal(
      noneMatchedWarning(MISSED.slice(0, 1), ALL_MISSED),
      "assignees: none of the 1 YouTrack assignee matched a GitHub account; " +
        "if their YouTrack logins look anonymized, the YouTrack token may lack Read User Basic",
    );
  });

  it("is null once anyone matched, or when everyone is blocked or there is nobody", () => {
    assert.equal(noneMatchedWarning([...MISSED, person("ABC-3", "matchedusera")], ALL_MISSED), null);
    assert.equal(noneMatchedWarning([BLOCKED_PERSON], ALL_MISSED), null);
    assert.equal(noneMatchedWarning([], ALL_MISSED), null);
  });
});
