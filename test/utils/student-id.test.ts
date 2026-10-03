/**
 * Student IDs and lookup emails (U17, docs/13 §2.4): the ID rule, the Anonymi rule, the
 * buas.nl-only email ID and the addresses the commit and email lookups may send. Every
 * person is a placeholder.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BUAS_EMAIL_DOMAIN,
  isUsableEmail,
  lookupEmails,
  singleStudentId,
  studentIds,
} from "../../src/utils/student-id.ts";

describe("singleStudentId", () => {
  it("finds the one 6-digit run in the login shapes seen live", () => {
    for (const login of ["jdoe123456", "JaneDoe123456", "jdoe-123456", "jdoe123456_buas", "123456"]) {
      assert.equal(singleStudentId(login), "123456", login);
    }
  });

  it("finds no ID for 5- or 7-digit runs, two runs or no digits", () => {
    for (const text of ["jdoe12345", "jdoe1234567", "ab123456cd654321", "staffuser", ""]) {
      assert.equal(singleStudentId(text), null, text);
    }
  });

  it("keeps the ID a string, so a leading 0 survives", () => {
    assert.equal(singleStudentId("jdoe012345"), "012345");
  });

  it("counts only ASCII digits", () => {
    assert.equal(singleStudentId("jdoe١٢٣٤٥٦"), null);
  });

  it("gives the same answer on every call (the global regex keeps no state)", () => {
    assert.equal(singleStudentId("jdoe123456"), "123456");
    assert.equal(singleStudentId("jdoe123456"), "123456");
  });
});

describe("isUsableEmail", () => {
  it("accepts plain addresses", () => {
    for (const email of ["123456@buas.nl", "Jane.Doe+x@example.org", "j_d-o%e@sub.buas.nl"]) {
      assert.equal(isUsableEmail(email), true, email);
    }
  });

  it("rejects anything that could become a username or break out of a quoted search term", () => {
    for (const email of ["jdoe123456", "a@b@buas.nl", '"x"@buas.nl', "jane doe@buas.nl", "a,b@buas.nl", "", "@"]) {
      assert.equal(isUsableEmail(email), false, email);
    }
  });
});

describe("studentIds", () => {
  it("takes the login's ID", () => {
    assert.deepEqual(studentIds({ login: "jdoe123456", email: null }), ["123456"]);
  });

  it("takes no login ID from an anonymized login, in any case", () => {
    for (const login of ["Anonymized123456", "anonymi123456", "ANONYMIZED_123456"]) {
      assert.deepEqual(studentIds({ login, email: null }), [], login);
    }
  });

  it("still takes the email ID of an anonymized login", () => {
    assert.deepEqual(studentIds({ login: "Anonymized123456", email: "234567@buas.nl" }), ["234567"]);
  });

  it("takes the email ID only for exactly buas.nl, in any case", () => {
    assert.deepEqual(studentIds({ login: "staffuser", email: "123456@buas.nl" }), ["123456"]);
    assert.deepEqual(studentIds({ login: "staffuser", email: "123456@BUAS.NL" }), ["123456"]);
    assert.deepEqual(studentIds({ login: "staffuser", email: "123456@student.buas.nl" }), []);
    assert.deepEqual(studentIds({ login: "staffuser", email: "123456@buas.nl.example.org" }), []);
    assert.deepEqual(studentIds({ login: "staffuser", email: "123456@example.org" }), []);
  });

  it("takes no ID from a noreply address with an ID-like number", () => {
    const email = "123456+staffuser@users.noreply.github.com";

    assert.deepEqual(studentIds({ login: "staffuser", email }), []);
  });

  it("needs exactly one @ and exactly one run in the local part", () => {
    assert.deepEqual(studentIds({ login: "staffuser", email: "123456@x@buas.nl" }), []);
    assert.deepEqual(studentIds({ login: "staffuser", email: "123456.654321@buas.nl" }), []);
    assert.deepEqual(studentIds({ login: "staffuser", email: "jdoe1234567@buas.nl" }), []);
    assert.deepEqual(studentIds({ login: "staffuser", email: "buas.nl" }), []);
  });

  it("takes the email ID when the login has two runs", () => {
    assert.deepEqual(studentIds({ login: "ab123456cd654321", email: "234567@buas.nl" }), ["234567"]);
  });

  it("gives both IDs, login first, when they differ", () => {
    assert.deepEqual(studentIds({ login: "jdoe123456", email: "234567@buas.nl" }), ["123456", "234567"]);
  });

  it("gives one ID when they agree", () => {
    assert.deepEqual(studentIds({ login: "jdoe123456", email: "123456@buas.nl" }), ["123456"]);
  });
});

describe("lookupEmails", () => {
  it("builds the buas.nl address when the email is null", () => {
    assert.deepEqual(lookupEmails({ login: "jdoe123456", email: null }), [`123456@${BUAS_EMAIL_DOMAIN}`]);
  });

  it("gives nothing for a login without an ID and no email", () => {
    assert.deepEqual(lookupEmails({ login: "staffuser", email: null }), []);
  });

  it("puts the YouTrack email first, then one built address per ID", () => {
    const person = { login: "jdoe123456", email: "Jane.Doe@Example.org" };

    assert.deepEqual(lookupEmails(person), ["jane.doe@example.org", "123456@buas.nl"]);
  });

  it("lowercases and deduplicates, so a buas.nl email and its built twin are one", () => {
    assert.deepEqual(lookupEmails({ login: "jdoe123456", email: "123456@BUAS.nl" }), ["123456@buas.nl"]);
  });

  it("gives every ID's address when login and email disagree", () => {
    const person = { login: "jdoe123456", email: "234567@buas.nl" };

    assert.deepEqual(lookupEmails(person), ["234567@buas.nl", "123456@buas.nl"]);
  });

  it("drops an unusable YouTrack email but keeps the IDs it gives", () => {
    assert.deepEqual(lookupEmails({ login: "staffuser", email: "a@b@buas.nl" }), []);
    assert.deepEqual(lookupEmails({ login: "staffuser", email: '"x"@example.org' }), []);
    assert.deepEqual(lookupEmails({ login: "jdoe123456", email: "jane doe@example.org" }), ["123456@buas.nl"]);
    assert.deepEqual(lookupEmails({ login: "staffuser", email: " 234567@buas.nl" }), ["234567@buas.nl"]);
  });

  it("keeps a usable noreply address as a lookup key, without an ID from it", () => {
    const email = "123456+staffuser@users.noreply.github.com";

    assert.deepEqual(lookupEmails({ login: "staffuser", email }), [email]);
  });

  it("lowercases the YouTrack email", () => {
    assert.deepEqual(lookupEmails({ login: "staffuser", email: "STAFF@EXAMPLE.ORG" }), ["staff@example.org"]);
  });
});
