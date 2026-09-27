import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MIN_SECRET_CHARS, REDACTED, redactedExcerpt, secretRedactor } from "../../src/utils/redact.ts";

const TOKEN = "ghp_abcdefghijklmnop";

describe("secret redaction constants", () => {
  it("keeps the placeholder and threshold the logs and error texts rely on", () => {
    assert.equal(REDACTED, "[redacted]");
    assert.equal(MIN_SECRET_CHARS, 8);
  });
});

describe("secretRedactor", () => {
  it("replaces every occurrence of each secret with the placeholder", () => {
    const redact = secretRedactor([TOKEN, "perm:xyz.123"]);

    assert.equal(redact(`a ${TOKEN} b ${TOKEN} c perm:xyz.123`), `a ${REDACTED} b ${REDACTED} c ${REDACTED}`);
  });

  it("replaces the longest secret first, so a secret containing another is removed whole", () => {
    const short = "abcdefgh";
    const long = `${short}-rest-of-it`;

    const redacted = secretRedactor([short, long])(`x ${long} y ${short}`);

    assert.equal(redacted, `x ${REDACTED} y ${REDACTED}`);
  });

  it("ignores secrets shorter than MIN_SECRET_CHARS", () => {
    const short = "a".repeat(MIN_SECRET_CHARS - 1);
    const exact = "b".repeat(MIN_SECRET_CHARS);

    const redacted = secretRedactor([short, exact, ""])(`${short} ${exact}`);

    assert.equal(redacted, `${short} ${REDACTED}`);
  });

  it("returns the text unchanged when there are no secrets", () => {
    assert.equal(secretRedactor([])(`plain ${TOKEN}`), `plain ${TOKEN}`);
  });

  it("handles a secret listed twice", () => {
    assert.equal(secretRedactor([TOKEN, TOKEN])(`${TOKEN}!`), `${REDACTED}!`);
  });

  it("does not mutate the secrets list", () => {
    const secrets = Object.freeze(["short", TOKEN, `${TOKEN}-longer`]);

    secretRedactor(secrets);

    assert.deepEqual(secrets, ["short", TOKEN, `${TOKEN}-longer`]);
  });
});

describe("redactedExcerpt", () => {
  it("redacts before cutting, so a secret straddling the cut leaks no prefix", () => {
    const excerpt = redactedExcerpt(secretRedactor([TOKEN]), `abc${TOKEN}`, 8);

    assert.equal(excerpt, "abc[reda");
  });

  it("keeps text within the limit whole", () => {
    assert.equal(redactedExcerpt(secretRedactor([TOKEN]), `ok ${TOKEN}`, 100), `ok ${REDACTED}`);
  });

  it("does not end in the first half of a cut surrogate pair", () => {
    assert.equal(redactedExcerpt(secretRedactor([]), "a😀b", 2), "a");
    assert.equal(redactedExcerpt(secretRedactor([]), "a😀b", 3), "a😀");
  });
});
