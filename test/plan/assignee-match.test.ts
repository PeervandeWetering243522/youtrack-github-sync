/**
 * The matching chain (U2, U14, U17; docs/13 §2.4) and the edge cases of docs/12 "Proposed
 * matching chain" that are pure: map, ID in an assignable login, commit author, email search,
 * pooling, ambiguity carry-over, steps that are off and failed lookups. Every person is a
 * placeholder.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  evaluateChain,
  finalOutcome,
  loginKey,
  LOOKUPS_OFF,
  matchAll,
  NO_LOOKUPS,
  withAnswer,
  withStepOff,
  withStepPaused,
} from "../../src/plan/assignee-match.ts";
import type { LookupAnswer, LookupState, LookupStep, ManualMap, MatchContext } from "../../src/plan/assignee-match.ts";
import type { PersonIdentity } from "../../src/utils/student-id.ts";

const JDOE: PersonIdentity = { login: "jdoe123456", email: "123456@buas.nl" };
/** jdoe with a second, non-BUas email: two lookup emails, jane@example.org first. */
const JDOE_TWO_EMAILS: PersonIdentity = { login: "jdoe123456", email: "jane@example.org" };
const STAFF: PersonIdentity = { login: "staffuser", email: "staff@example.org" };
const FOUND_NONE: LookupAnswer = { kind: "found", logins: [] };
const FAILED: LookupAnswer = { kind: "failed" };

function found(...logins: string[]): LookupAnswer {
  return { kind: "found", logins };
}

/** The answers as one LookupState, built with withAnswer in order. */
function answers(...entries: readonly (readonly [LookupStep, string, LookupAnswer])[]): LookupState {
  return entries.reduce((state, [step, email, answer]) => withAnswer(state, step, email, answer), NO_LOOKUPS);
}

function context(overrides: Partial<MatchContext> = {}): MatchContext {
  return { assignable: ["JaneDoe123456", "staffgh", "OtherDev"], map: new Map(), lookups: NO_LOOKUPS, ...overrides };
}

function mapOf(...entries: readonly (readonly [string, string | null])[]): ManualMap {
  return new Map(entries);
}

describe("evaluateChain: step a, the manual map (U14)", () => {
  it("matches the map target before any automatic step", () => {
    const state = evaluateChain(JDOE, context({ map: mapOf(["jdoe123456", "staffgh"]) }));

    assert.deepEqual(state, { kind: "matched", login: "staffgh", step: "map" });
  });

  it("finds the entry for a YouTrack login in another case", () => {
    const person = { login: "JDoe123456", email: null };

    assert.deepEqual(evaluateChain(person, context({ map: mapOf(["jdoe123456", "staffgh"]) })), {
      kind: "matched",
      login: "staffgh",
      step: "map",
    });
  });

  it("returns the assignable list's spelling of a target written in another case", () => {
    const state = evaluateChain(JDOE, context({ map: mapOf(["jdoe123456", "janedoe123456"]) }));

    assert.deepEqual(state, { kind: "matched", login: "JaneDoe123456", step: "map" });
  });

  it("blocks a user mapped to - even when an automatic step would match", () => {
    assert.deepEqual(evaluateChain(JDOE, context({ map: mapOf(["jdoe123456", null]) })), { kind: "blocked" });
  });

  it("stops at a target that cannot be assigned, without trying the automatic steps", () => {
    const state = evaluateChain(JDOE, context({ map: mapOf(["jdoe123456", "ghostuser"]) }));

    assert.deepEqual(state, { kind: "map-target-not-assignable" });
  });

  it("goes on to the automatic steps for a user without an entry", () => {
    const state = evaluateChain(JDOE, context({ map: mapOf(["staffuser", "staffgh"]) }));

    assert.deepEqual(state, { kind: "matched", login: "JaneDoe123456", step: "login-id" });
  });
});

describe("evaluateChain: step b, the ID in an assignable login", () => {
  it("matches jdoe123456 in YouTrack to JaneDoe123456 on GitHub", () => {
    assert.deepEqual(evaluateChain(JDOE, context()), { kind: "matched", login: "JaneDoe123456", step: "login-id" });
  });

  it("matches through the email ID when the YouTrack login has none", () => {
    const person = { login: "staffuser", email: "123456@buas.nl" };

    assert.deepEqual(evaluateChain(person, context()), { kind: "matched", login: "JaneDoe123456", step: "login-id" });
  });

  it("still uses the email ID when the login has two runs", () => {
    const person = { login: "ab123456cd654321", email: "234567@buas.nl" };

    const state = evaluateChain(person, context({ assignable: ["JaneDoe123456", "dev234567"] }));

    assert.deepEqual(state, { kind: "matched", login: "dev234567", step: "login-id" });
  });

  it("uses both IDs when login and email disagree: one assignable login matches, two are ambiguous", () => {
    const person = { login: "jdoe123456", email: "234567@buas.nl" };

    assert.deepEqual(evaluateChain(person, context({ assignable: ["dev234567"] })), {
      kind: "matched",
      login: "dev234567",
      step: "login-id",
    });
    assert.deepEqual(evaluateChain(person, context({ assignable: ["JaneDoe123456", "dev234567"] })), {
      kind: "needs-lookup",
      step: "commit",
      email: "234567@buas.nl",
      ambiguous: true,
    });
  });

  it("ignores a GitHub login with two runs or a 7-digit run", () => {
    const state = evaluateChain(JDOE, context({ assignable: ["ab123456cd654321", "jdoe1234567"] }));

    assert.deepEqual(state, { kind: "needs-lookup", step: "commit", email: "123456@buas.nl", ambiguous: false });
  });

  it("takes no ID from an anonymized YouTrack login, so a user without email ends unmatched", () => {
    const person = { login: "Anonymized123456", email: null };

    assert.deepEqual(evaluateChain(person, context()), { kind: "unmatched" });
  });
});

describe("evaluateChain: steps c and d, the lookups", () => {
  it("waits for the commit lookup of a login without an ID, with the real email", () => {
    assert.deepEqual(evaluateChain(STAFF, context()), {
      kind: "needs-lookup",
      step: "commit",
      email: "staff@example.org",
      ambiguous: false,
    });
  });

  it("matches at step c with the list's spelling", () => {
    const lookups = answers(["commit", "staff@example.org", found("StaffGH")]);

    assert.deepEqual(evaluateChain(STAFF, context({ lookups })), { kind: "matched", login: "staffgh", step: "commit" });
  });

  it("goes on to step d when step c finds nothing, and matches there", () => {
    const waiting = answers(["commit", "staff@example.org", FOUND_NONE]);
    const lookups = withAnswer(waiting, "search", "staff@example.org", found("staffgh"));

    assert.deepEqual(evaluateChain(STAFF, context({ lookups: waiting })), {
      kind: "needs-lookup",
      step: "search",
      email: "staff@example.org",
      ambiguous: false,
    });
    assert.deepEqual(evaluateChain(STAFF, context({ lookups })), { kind: "matched", login: "staffgh", step: "search" });
  });

  it("ends unmatched when every step answered with nothing", () => {
    const lookups = answers(["commit", "staff@example.org", FOUND_NONE], ["search", "staff@example.org", FOUND_NONE]);

    assert.deepEqual(evaluateChain(STAFF, context({ lookups })), { kind: "unmatched" });
  });

  it("ignores results outside the assignable list", () => {
    const lookups = answers(
      ["commit", "staff@example.org", found("outsider")],
      ["search", "staff@example.org", found("outsider", "Stranger")],
    );

    assert.deepEqual(evaluateChain(STAFF, context({ lookups })), { kind: "unmatched" });
  });

  it("pools a step over every email and deduplicates one login found twice", () => {
    const lookups = answers(
      ["commit", "jane@example.org", found("staffgh")],
      ["commit", "123456@buas.nl", found("STAFFGH")],
    );

    const state = evaluateChain(JDOE_TWO_EMAILS, context({ assignable: ["staffgh"], lookups }));

    assert.deepEqual(state, { kind: "matched", login: "staffgh", step: "commit" });
  });

  it("waits for a step's second email even when the first already found a login", () => {
    const lookups = answers(["commit", "jane@example.org", found("staffgh")]);

    assert.deepEqual(evaluateChain(JDOE_TWO_EMAILS, context({ assignable: ["staffgh"], lookups })), {
      kind: "needs-lookup",
      step: "commit",
      email: "123456@buas.nl",
      ambiguous: false,
    });
  });

  it("skips a step that is off for the run as a step with no result", () => {
    const commitOff = withStepOff(NO_LOOKUPS, "commit");
    const bothOff = withStepOff(commitOff, "search");

    assert.deepEqual(evaluateChain(STAFF, context({ lookups: commitOff })), {
      kind: "needs-lookup",
      step: "search",
      email: "staff@example.org",
      ambiguous: false,
    });
    assert.deepEqual(evaluateChain(STAFF, context({ lookups: bothOff })), { kind: "unmatched" });
  });

  it("keeps the answers a step got before it was turned off", () => {
    const lookups = withStepOff(answers(["commit", "staff@example.org", found("staffgh")]), "commit");

    assert.deepEqual(evaluateChain(STAFF, context({ lookups })), { kind: "matched", login: "staffgh", step: "commit" });
  });

  it("ends not-looked-up when a rate limit paused a step before its lookup was sent", () => {
    const paused = withStepPaused(answers(["commit", "staff@example.org", FOUND_NONE]), "search");

    assert.deepEqual(finalOutcome(evaluateChain(STAFF, context({ lookups: paused }))), { kind: "not-looked-up" });
  });

  it("keeps the answers a paused step got, and its matches", () => {
    const lookups = withStepPaused(
      answers(["commit", "staff@example.org", FOUND_NONE], ["search", "staff@example.org", found("staffgh")]),
      "search",
    );

    assert.deepEqual(evaluateChain(STAFF, context({ lookups })), { kind: "matched", login: "staffgh", step: "search" });
  });

  it("waits for an email a paused step never searched, so the emails answered so far match nobody", () => {
    // The search for the second email could have found SchoolB, which makes the person ambiguous.
    const lookups = withStepPaused(
      answers(
        ["commit", "jane@example.org", FOUND_NONE],
        ["commit", "123456@buas.nl", FOUND_NONE],
        ["search", "jane@example.org", found("PersonalA")],
      ),
      "search",
    );
    const paused = context({ assignable: ["PersonalA", "SchoolB"], lookups });

    assert.deepEqual(evaluateChain(JDOE_TWO_EMAILS, paused), {
      kind: "needs-lookup",
      step: "search",
      email: "123456@buas.nl",
      ambiguous: false,
    });
    assert.deepEqual(matchAll([JDOE_TWO_EMAILS], paused).get("jdoe123456"), { kind: "not-looked-up" });
  });

  it("ends ambiguous, not matched, when a paused step never searched an email of an ambiguous person", () => {
    const lookups = withStepPaused(
      answers(
        ["commit", "jane@example.org", FOUND_NONE],
        ["commit", "123456@buas.nl", FOUND_NONE],
        ["search", "jane@example.org", found("JaneDoe123456")],
      ),
      "search",
    );
    const paused = context({ assignable: ["JaneDoe123456", "jdoe-123456"], lookups });

    assert.deepEqual(matchAll([JDOE_TWO_EMAILS], paused).get("jdoe123456"), { kind: "ambiguous" });
  });

  it("decides a paused step whose every email was answered: unmatched without a hit, a failed one from the rest", () => {
    const noHit = withStepPaused(
      answers(["commit", "staff@example.org", FOUND_NONE], ["search", "staff@example.org", FOUND_NONE]),
      "search",
    );
    const oneFailed = withStepPaused(
      answers(
        ["commit", "jane@example.org", FOUND_NONE],
        ["commit", "123456@buas.nl", FOUND_NONE],
        ["search", "jane@example.org", FAILED],
        ["search", "123456@buas.nl", found("staffgh")],
      ),
      "search",
    );

    assert.deepEqual(evaluateChain(STAFF, context({ lookups: noHit })), { kind: "unmatched" });
    assert.deepEqual(evaluateChain(JDOE_TWO_EMAILS, context({ assignable: ["staffgh"], lookups: oneFailed })), {
      kind: "matched",
      login: "staffgh",
      step: "search",
    });
  });

  it("decides a step from the other email when one lookup failed", () => {
    const lookups = answers(["commit", "jane@example.org", FAILED], ["commit", "123456@buas.nl", found("staffgh")]);

    const state = evaluateChain(JDOE_TWO_EMAILS, context({ assignable: ["staffgh"], lookups }));

    assert.deepEqual(state, { kind: "matched", login: "staffgh", step: "commit" });
  });

  it("ends not-looked-up, not unmatched, when a failed lookup left the person without a match", () => {
    const lookups = answers(
      ["commit", "jane@example.org", FAILED],
      ["commit", "123456@buas.nl", FOUND_NONE],
      ["search", "jane@example.org", FOUND_NONE],
      ["search", "123456@buas.nl", FOUND_NONE],
    );

    const state = evaluateChain(JDOE_TWO_EMAILS, context({ assignable: ["staffgh"], lookups }));

    assert.deepEqual(state, { kind: "not-looked-up" });
  });

  it("needs no lookup and ends unmatched for a person without any lookup email", () => {
    assert.deepEqual(evaluateChain({ login: "staffuser", email: null }, context()), { kind: "unmatched" });
  });
});

describe("evaluateChain: ambiguity carry-over", () => {
  const TWINS = ["JaneDoe123456", "jdoe-123456", "staffgh", "OtherDev"];

  it("makes two GitHub logins with one ID ambiguous at step b and goes on", () => {
    assert.deepEqual(evaluateChain(JDOE, context({ assignable: TWINS })), {
      kind: "needs-lookup",
      step: "commit",
      email: "123456@buas.nl",
      ambiguous: true,
    });
  });

  it("settles the ambiguity with a later single login among the candidates", () => {
    const lookups = answers(["commit", "123456@buas.nl", found("JDOE-123456")]);

    const state = evaluateChain(JDOE, context({ assignable: TWINS, lookups }));

    assert.deepEqual(state, { kind: "matched", login: "jdoe-123456", step: "commit" });
  });

  it("ends ambiguous on a later single login outside the candidates, without waiting for step d", () => {
    const lookups = answers(["commit", "123456@buas.nl", found("staffgh")]);

    assert.deepEqual(evaluateChain(JDOE, context({ assignable: TWINS, lookups })), { kind: "ambiguous" });
  });

  it("ends ambiguous when no later step settles it", () => {
    const lookups = answers(["commit", "123456@buas.nl", FOUND_NONE], ["search", "123456@buas.nl", FOUND_NONE]);

    assert.deepEqual(evaluateChain(JDOE, context({ assignable: TWINS, lookups })), { kind: "ambiguous" });
  });

  it("keeps the first ambiguous set as the candidates when a later step is ambiguous too", () => {
    const ambiguousCommit = answers(
      ["commit", "jane@example.org", found("staffgh")],
      ["commit", "123456@buas.nl", found("OtherDev")],
      ["search", "123456@buas.nl", FOUND_NONE],
    );
    const inFirst = withAnswer(ambiguousCommit, "search", "jane@example.org", found("jdoe-123456"));
    const inSecondOnly = withAnswer(ambiguousCommit, "search", "jane@example.org", found("staffgh"));

    assert.deepEqual(evaluateChain(JDOE_TWO_EMAILS, context({ assignable: TWINS, lookups: inFirst })), {
      kind: "matched",
      login: "jdoe-123456",
      step: "search",
    });
    assert.deepEqual(evaluateChain(JDOE_TWO_EMAILS, context({ assignable: TWINS, lookups: inSecondOnly })), {
      kind: "ambiguous",
    });
  });

  it("starts the candidates at the first ambiguous lookup step", () => {
    const lookups = answers(
      ["commit", "jane@example.org", found("staffgh")],
      ["commit", "123456@buas.nl", found("OtherDev")],
      ["search", "jane@example.org", found("otherdev")],
      ["search", "123456@buas.nl", FOUND_NONE],
    );

    const state = evaluateChain(JDOE_TWO_EMAILS, context({ assignable: ["staffgh", "OtherDev"], lookups }));

    assert.deepEqual(state, { kind: "matched", login: "OtherDev", step: "search" });
  });
});

describe("finalOutcome", () => {
  it("turns a wait into not-looked-up, or ambiguous when the chain was ambiguous so far", () => {
    assert.deepEqual(finalOutcome({ kind: "needs-lookup", step: "commit", email: "x@example.org", ambiguous: false }), {
      kind: "not-looked-up",
    });
    assert.deepEqual(finalOutcome({ kind: "needs-lookup", step: "search", email: "x@example.org", ambiguous: true }), {
      kind: "ambiguous",
    });
  });

  it("passes every settled state through", () => {
    const matched = { kind: "matched", login: "JaneDoe123456", step: "login-id" } as const;

    assert.deepEqual(finalOutcome(matched), matched);
    assert.deepEqual(finalOutcome({ kind: "unmatched" }), { kind: "unmatched" });
    assert.deepEqual(finalOutcome({ kind: "blocked" }), { kind: "blocked" });
  });
});

describe("matchAll", () => {
  it("matches two YouTrack users with one ID to the same login, keyed by their lowercased logins", () => {
    const outcomes = matchAll(
      [{ login: "JDoe123456", email: null }, { login: "jdoe-123456", email: null }, STAFF],
      context(),
    );

    assert.deepEqual(
      [...outcomes],
      [
        ["jdoe123456", { kind: "matched", login: "JaneDoe123456", step: "login-id" }],
        ["jdoe-123456", { kind: "matched", login: "JaneDoe123456", step: "login-id" }],
        ["staffuser", { kind: "not-looked-up" }],
      ],
    );
  });
});

describe("LOOKUPS_OFF", () => {
  it("settles every person by the map and step b alone, never waiting for a lookup", () => {
    const person = { login: "jane.doe", email: "jane.doe@example.org" };

    const outcomes = matchAll(
      [JDOE, STAFF, person],
      context({ map: mapOf(["staffuser", "staffgh"]), lookups: LOOKUPS_OFF }),
    );

    assert.deepEqual(
      [...outcomes],
      [
        ["jdoe123456", { kind: "matched", login: "JaneDoe123456", step: "login-id" }],
        ["staffuser", { kind: "matched", login: "staffgh", step: "map" }],
        ["jane.doe", { kind: "unmatched" }],
      ],
    );
  });
});

describe("lookup state", () => {
  it("keys answers by the A-Z lowercased email and never changes the state it is given", () => {
    const state = withAnswer(NO_LOOKUPS, "commit", "Staff@Example.ORG", found("staffgh"));
    const off = withStepOff(state, "search");
    const paused = withStepPaused(state, "commit");

    assert.deepEqual([...state.commit.keys()], ["staff@example.org"]);
    assert.deepEqual([...off.off], ["search"]);
    assert.deepEqual([...paused.paused], ["commit"]);
    assert.equal(NO_LOOKUPS.commit.size, 0);
    assert.equal(state.off.size, 0);
    assert.equal(state.paused.size, 0);
    assert.equal(state.search, NO_LOOKUPS.search);
  });

  it("lowercases A-Z only in keys", () => {
    assert.equal(loginKey("JaneDoe123456"), "janedoe123456");
    assert.equal(loginKey("JaneK"), "janeK");
  });
});
