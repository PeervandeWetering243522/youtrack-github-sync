/**
 * Lookup planning (U17, docs/13 §2.5): the bound, the rotation over the persons who need a
 * lookup, depth-first order (step c, then d, then the next person) and one lookup per
 * (step, email). Every person is a placeholder.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LOOKUP_FETCH_RESERVE,
  LOOKUP_ROTATION_MS,
  lookupBudget,
  lookupOrder,
  MAX_LOOKUPS_PER_RUN,
  nextLookup,
  rotationIndex,
} from "../../src/plan/assignee-lookups.ts";
import type { PlannedLookup } from "../../src/plan/assignee-lookups.ts";
import { NO_LOOKUPS, withAnswer, withStepOff } from "../../src/plan/assignee-match.ts";
import type { LookupAnswer, MatchBasis, MatchContext } from "../../src/plan/assignee-match.ts";
import type { PersonIdentity } from "../../src/utils/student-id.ts";

type Named = PersonIdentity & { readonly name: string };

const BASIS: MatchBasis = {
  assignable: ["JaneDoe123456", "staffgh"],
  map: new Map([["mappeduser", "staffgh"]]),
};
/** Settled at step b (ID in JaneDoe123456). */
const BY_ID: Named = { name: "CUI-1", login: "jdoe123456", email: null };
/** Settled at step a (map). */
const BY_MAP: Named = { name: "CUI-2", login: "mappeduser", email: "mapped@example.org" };
const NEEDS_A: Named = { name: "CUI-3", login: "staffuser", email: "staff@example.org" };
const NEEDS_B: Named = { name: "CUI-4", login: "otheruser", email: "other@example.org" };
const NEEDS_C: Named = { name: "CUI-5", login: "thirduser", email: "third@example.org" };
/** Two lookup emails: its own, then the built 234567@buas.nl. */
const TWO_EMAILS: Named = { name: "CUI-6", login: "dev234567", email: "dev@example.org" };
const FOUND_NONE: LookupAnswer = { kind: "found", logins: [] };

/** Every lookup nextLookup asks for, answering each with `answer`, until it returns null. */
function drain(order: readonly PersonIdentity[], context: MatchContext, answer = FOUND_NONE): readonly PlannedLookup[] {
  const sent: PlannedLookup[] = [];
  let lookups = context.lookups;
  for (let next = nextLookup(order, context); next !== null; next = nextLookup(order, { ...context, lookups })) {
    sent.push(next);
    lookups = withAnswer(lookups, next.step, next.email, answer);
    assert.ok(sent.length <= 20, "nextLookup never stops");
  }
  return sent;
}

describe("lookup constants", () => {
  it("keeps the bound, reserve and rotation period of docs/13 §2.5", () => {
    assert.equal(MAX_LOOKUPS_PER_RUN, 5);
    assert.equal(LOOKUP_FETCH_RESERVE, 2);
    assert.equal(LOOKUP_ROTATION_MS, 10 * 60 * 1000);
  });
});

describe("lookupBudget", () => {
  it("leaves room for the write cap and the reserve, at most 5 (41 fetches left after the reads)", () => {
    assert.deepEqual(
      [30, 34, 38, 39, 40].map((writes) => lookupBudget(41, writes)),
      [5, 5, 1, 0, 0],
    );
  });

  it("is never negative", () => {
    assert.equal(lookupBudget(0, 30), 0);
    assert.equal(lookupBudget(-3, 0), 0);
  });
});

describe("rotationIndex", () => {
  it("counts whole 10-minute periods", () => {
    assert.deepEqual(
      [0, LOOKUP_ROTATION_MS - 1, LOOKUP_ROTATION_MS, 2 * LOOKUP_ROTATION_MS + 1].map(rotationIndex),
      [0, 0, 1, 2],
    );
  });
});

describe("lookupOrder", () => {
  const PERSONS = [BY_ID, NEEDS_A, BY_MAP, NEEDS_B, NEEDS_C];

  it("keeps only the persons that need a lookup, in input order, the same objects", () => {
    const order = lookupOrder(PERSONS, BASIS, 0);

    assert.deepEqual(
      order.map(({ name }) => name),
      ["CUI-3", "CUI-4", "CUI-5"],
    );
    assert.equal(order[0], NEEDS_A);
  });

  it("leaves out persons the map blocks", () => {
    const basis = { ...BASIS, map: new Map([["staffuser", null]]) };

    assert.deepEqual(
      lookupOrder([NEEDS_A, NEEDS_B], basis, 0).map(({ name }) => name),
      ["CUI-4"],
    );
  });

  it("rotates left by the index modulo the number of persons, so consecutive runs start elsewhere", () => {
    const firsts = [0, 1, 2, 3, 4].map((rotation) => lookupOrder(PERSONS, BASIS, rotation)[0]?.name);

    assert.deepEqual(firsts, ["CUI-3", "CUI-4", "CUI-5", "CUI-3", "CUI-4"]);
    assert.deepEqual(
      lookupOrder(PERSONS, BASIS, 2).map(({ name }) => name),
      ["CUI-5", "CUI-3", "CUI-4"],
    );
  });

  it("is empty when nobody needs a lookup", () => {
    assert.deepEqual(lookupOrder([BY_ID, BY_MAP], BASIS, 7), []);
    assert.deepEqual(lookupOrder([], BASIS, 7), []);
  });

  it("ignores lookup answers a full context may carry", () => {
    const context = { ...BASIS, lookups: withAnswer(NO_LOOKUPS, "commit", "staff@example.org", FOUND_NONE) };

    assert.equal(lookupOrder([NEEDS_A], context, 0)[0], NEEDS_A);
  });
});

describe("nextLookup", () => {
  it("goes depth-first: every step c email of a person, then their step d emails, then the next person", () => {
    const sent = drain([TWO_EMAILS, NEEDS_A], { ...BASIS, lookups: NO_LOOKUPS });

    assert.deepEqual(sent, [
      { step: "commit", email: "dev@example.org" },
      { step: "commit", email: "234567@buas.nl" },
      { step: "search", email: "dev@example.org" },
      { step: "search", email: "234567@buas.nl" },
      { step: "commit", email: "staff@example.org" },
      { step: "search", email: "staff@example.org" },
    ]);
  });

  it("moves on to the next person once one is matched", () => {
    const sent = drain([NEEDS_A, NEEDS_B], { ...BASIS, lookups: NO_LOOKUPS }, { kind: "found", logins: ["staffgh"] });

    assert.deepEqual(sent, [
      { step: "commit", email: "staff@example.org" },
      { step: "commit", email: "other@example.org" },
    ]);
  });

  it("looks an email shared by two persons up once per step", () => {
    const twin = { name: "CUI-7", login: "twinuser", email: "STAFF@example.org" };

    const sent = drain([NEEDS_A, twin], { ...BASIS, lookups: NO_LOOKUPS });

    assert.deepEqual(sent, [
      { step: "commit", email: "staff@example.org" },
      { step: "search", email: "staff@example.org" },
    ]);
  });

  it("skips a step that is off for the run", () => {
    const sent = drain([NEEDS_A], { ...BASIS, lookups: withStepOff(NO_LOOKUPS, "commit") });

    assert.deepEqual(sent, [{ step: "search", email: "staff@example.org" }]);
  });

  it("returns null when nobody waits", () => {
    assert.equal(nextLookup([BY_ID, BY_MAP], { ...BASIS, lookups: NO_LOOKUPS }), null);
    assert.equal(nextLookup([], { ...BASIS, lookups: NO_LOOKUPS }), null);
  });
});
