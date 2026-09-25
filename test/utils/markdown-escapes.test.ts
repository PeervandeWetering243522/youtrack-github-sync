import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isEscaped, resolveEscapes, sourceOffset } from "../../src/utils/markdown-escapes.ts";

describe("resolveEscapes", () => {
  it("resolves escapes and character references to one character each", () => {
    const { plain, shifts } = resolveEscapes("a\\#1 &#64;b &commat;c &#x2014;");
    // Non-ASCII (and invalid) references cannot be part of a reference: U+FFFD stands in.
    assert.equal(plain, "a#1 @b @c \u{FFFD}");
    assert.deepEqual(shifts, { at: [1, 4, 7, 10], total: [1, 5, 12, 19] });
  });

  it("leaves text without resolvable tokens alone", () => {
    for (const text of ["plain", "&amp; &lt;", "&#12345678;", "\\a \\1", "trailing \\"]) {
      assert.deepEqual(resolveEscapes(text), { plain: text, shifts: { at: [], total: [] } }, text);
    }
  });

  it("decodes &#0; as the replacement stand-in", () => {
    assert.equal(resolveEscapes("&#0;@").plain, "\u{FFFD}@");
  });
});

describe("sourceOffset", () => {
  it("maps plain offsets back to the source, not skipping a token at the offset itself", () => {
    const source = "a\\#1 &#64;b";
    const { plain, shifts } = resolveEscapes(source);
    assert.equal(plain, "a#1 @b");
    const offsets = [0, 1, 2, 4, 5, plain.length].map((offset) => sourceOffset(shifts, offset));
    assert.deepEqual(offsets, [0, 1, 3, 5, 10, source.length]);
  });
});

describe("isEscaped", () => {
  it("is true after an odd run of backslashes only", () => {
    assert.equal(isEscaped("#", 0), false);
    assert.equal(isEscaped("\\#", 1), true);
    assert.equal(isEscaped("\\\\#", 2), false);
    assert.equal(isEscaped("\\\\\\#", 3), true);
  });
});
