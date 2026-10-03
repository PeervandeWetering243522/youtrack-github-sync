/**
 * The identity redactor (U8, docs/13 §2.11): logins and emails in any case, raw, URL-encoded
 * and quoted as the lookup URLs spell them, never inside a longer word. Every person is a
 * placeholder.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { identityRedactor, MIN_IDENTITY_CHARS, PERSON_REDACTED } from "../../src/utils/identity-redact.ts";

const P = PERSON_REDACTED;

describe("identity redaction constants", () => {
  it("keeps the placeholder and threshold of docs/13 §2.11", () => {
    assert.equal(PERSON_REDACTED, "[person]");
    assert.equal(MIN_IDENTITY_CHARS, 3);
  });
});

describe("identityRedactor", () => {
  it("replaces every occurrence, in any case", () => {
    const redact = identityRedactor(["JaneDoe123456"]);

    assert.equal(redact("JaneDoe123456 janedoe123456 JANEDOE123456"), `${P} ${P} ${P}`);
  });

  it("replaces the URL-encoded and quoted forms the lookup URLs carry", () => {
    const redact = identityRedactor(["123456@buas.nl"]);

    assert.equal(
      redact("GET https://api.github.com/repos/acme/mirror/commits?author=123456%40buas.nl&per_page=1"),
      `GET https://api.github.com/repos/acme/mirror/commits?author=${P}&per_page=1`,
    );
    assert.equal(
      redact("GET https://api.github.com/search/users?q=%22123456%40BUAS.NL%22+in%3Aemail+type%3Auser&per_page=100"),
      `GET https://api.github.com/search/users?q=${P}+in%3Aemail+type%3Auser&per_page=100`,
    );
  });

  it("scrubs a 422 body that names logins and emails", () => {
    const redact = identityRedactor(["JaneDoe123456", "jdoe123456", "123456@buas.nl"]);
    const body =
      '{"message":"Validation Failed","errors":[{"value":"JaneDoe123456","field":"assignees"}],"x":"jdoe123456 <123456@buas.nl>"}';

    assert.equal(
      redact(body),
      `{"message":"Validation Failed","errors":[{"value":"${P}","field":"assignees"}],"x":"${P} <${P}>"}`,
    );
  });

  it("never redacts inside a longer word, but a longer identity given wins over a shorter one", () => {
    assert.equal(
      identityRedactor(["jdoe"])("jdoe1234567 xjdoe jdoe-123456 jdoe_x"),
      `jdoe1234567 xjdoe ${P}-123456 ${P}_x`,
    );
    assert.equal(identityRedactor(["jdoe", "jdoe-123456"])("jdoe1234567 jdoe-123456 jdoe"), `jdoe1234567 ${P} ${P}`);
  });

  it("treats regex metacharacters in an identity literally", () => {
    const redact = identityRedactor(["jane.doe+x@buas.nl", "a(b)c"]);

    assert.equal(redact("jane.doe+x@buas.nl janeXdoe+x@buas.nl a(b)c abc"), `${P} janeXdoe+x@buas.nl ${P} abc`);
    assert.equal(redact("author=jane.doe%2Bx%40buas.nl"), `author=${P}`);
  });

  it("ignores identities under 3 characters", () => {
    const redact = identityRedactor(["ab", "x", "", "abc"]);

    assert.equal(redact("ab x abc"), `ab x ${P}`);
  });

  it("returns the text unchanged without identities", () => {
    assert.equal(identityRedactor([])("jdoe123456 123456@buas.nl"), "jdoe123456 123456@buas.nl");
  });

  it("gives the same result on every call (the global regex keeps no state)", () => {
    const redact = identityRedactor(["jdoe123456"]);

    assert.equal(redact("a jdoe123456"), `a ${P}`);
    assert.equal(redact("a jdoe123456"), `a ${P}`);
  });

  it("keeps an identity with a lone surrogate, which has no URL-encoded form", () => {
    const odd = "jdoe\uD800";

    assert.equal(identityRedactor([odd, "jdoe123456"])(`${odd} jdoe123456`), `${P} ${P}`);
  });

  it("does not mutate the identities list", () => {
    const identities = Object.freeze(["abc", "jdoe123456", "abc"]);

    identityRedactor(identities);

    assert.deepEqual(identities, ["abc", "jdoe123456", "abc"]);
  });
});
