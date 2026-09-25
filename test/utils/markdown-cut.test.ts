import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fitRendered } from "../../src/utils/markdown-cut.ts";
import { joinLines, renderLines } from "../../src/utils/markdown-render.ts";

describe("fitRendered", () => {
  it("keeps the whole rendering when it fits", () => {
    assert.equal(fitRendered(renderLines("a @b\nc"), 100), "a `@b`\nc");
  });

  it("drops the blank lines a cut leaves at the end", () => {
    assert.equal(fitRendered(renderLines("a\n\n\nbbbbbbbb"), 4), "a");
  });

  it("cuts a line to a prefix whose rendering fits, never splitting a wrapped reference", () => {
    const kept = fitRendered(renderLines("xx @bob"), 6);
    assert.ok(kept.length <= 6);
    assert.ok("xx @bob".startsWith(kept));
    assert.equal(joinLines(renderLines(kept)), kept);
  });

  it("recuts to make room for the closer of a fence the cut leaves open", () => {
    const kept = fitRendered(renderLines(`\`\`\`\n${"a".repeat(20)}`), 12);
    assert.equal(kept, "```\naaaa\n```");
  });
});
