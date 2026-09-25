import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NO_FACTS, mergeFacts, renderTextLine } from "../../src/utils/markdown-inline.ts";
import type { RunFacts } from "../../src/utils/markdown-inline.ts";

describe("renderTextLine", () => {
  it("wraps references outside the line's code spans", () => {
    assert.deepEqual(renderTextLine("a @b #1", NO_FACTS), { output: "a `@b` `#1`", facts: NO_FACTS });
    assert.equal(renderTextLine("`@b` @c", NO_FACTS).output, "`@b` `@c`");
  });

  it("reports unmatched and unpaired backtick runs for later lines", () => {
    const { facts } = renderTextLine("a ` b ``c``", NO_FACTS);
    assert.deepEqual([...facts.literal], [1]);
    assert.deepEqual([...facts.unpaired], [1]);
  });

  it("picks a delimiter length that earlier unpaired runs of the paragraph do not have", () => {
    const earlier = renderTextLine("a ` b", NO_FACTS).facts;
    assert.equal(renderTextLine("@c", earlier).output, "``@c``");
    assert.equal(renderTextLine("@c", NO_FACTS).output, "`@c`");
  });
});

describe("mergeFacts", () => {
  it("unites both sets without modifying its inputs", () => {
    const a: RunFacts = { literal: new Set([1]), unpaired: new Set([1]) };
    const b: RunFacts = { literal: new Set([2]), unpaired: new Set([3]) };
    const merged = mergeFacts(a, b);
    assert.deepEqual([...merged.literal], [1, 2]);
    assert.deepEqual([...merged.unpaired], [1, 3]);
    assert.deepEqual([...a.literal, ...a.unpaired, ...b.literal, ...b.unpaired], [1, 1, 2, 3]);
  });
});
