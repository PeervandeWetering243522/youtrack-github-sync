import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { countBelow, cutUtf16 } from "../../src/utils/text.ts";

describe("cutUtf16", () => {
  it("returns text that fits unchanged", () => {
    assert.equal(cutUtf16("abc", 3), "abc");
    assert.equal(cutUtf16("abc", 10), "abc");
    assert.equal(cutUtf16("", 0), "");
  });

  it("keeps the first maxLength units", () => {
    assert.equal(cutUtf16("abcdef", 4), "abcd");
    assert.equal(cutUtf16("a😀b", 3), "a😀");
  });

  it("drops a high surrogate the cut would leave alone", () => {
    assert.equal(cutUtf16("a😀b", 2), "a");
    assert.equal(cutUtf16("😀", 1), "");
  });

  it("returns an empty string for a zero or negative length", () => {
    assert.equal(cutUtf16("abc", 0), "");
    assert.equal(cutUtf16("abc", -5), "");
  });
});

describe("countBelow", () => {
  it("counts the ascending values below the limit", () => {
    const values = [1, 3, 5];
    const counts = [0, 1, 2, 5, 6].map((limit) => countBelow(values, limit));
    assert.deepEqual(counts, [0, 0, 1, 2, 3]);
  });

  it("handles empty lists and repeated values", () => {
    assert.equal(countBelow([], 10), 0);
    assert.equal(countBelow([2, 2, 2], 2), 0);
    assert.equal(countBelow([2, 2, 2], 3), 3);
  });
});
