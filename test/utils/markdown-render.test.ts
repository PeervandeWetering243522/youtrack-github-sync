import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NO_FACTS } from "../../src/utils/markdown-inline.ts";
import { closerAfter, joinLines, renderLine, renderLines } from "../../src/utils/markdown-render.ts";

describe("renderLines", () => {
  it("splits at every CommonMark line ending and keeps each one", () => {
    const lines = renderLines("a\r\nb\rc\n");
    assert.deepEqual(
      lines.map((line) => [line.source, line.ending]),
      [["a", "\r\n"], ["b", "\r"], ["c", "\n"], ["", ""]],
    );
  });

  it("passes each line the block state the line before it left", () => {
    const [open, code, close] = renderLines("```\n@x\n```");
    assert.ok(open !== undefined && code !== undefined && close !== undefined);
    assert.equal(open.after.leaf?.kind, "fence");
    assert.deepEqual(code.before, open.after);
    assert.equal(code.output, "@x");
    assert.equal(close.after.leaf, null);
  });
});

describe("joinLines", () => {
  it("round-trips text without references", () => {
    for (const text of ["", "a", "a\r\nb\rc\n", "```\ncode\n```\n\n- item"]) {
      assert.equal(joinLines(renderLines(text)), text, JSON.stringify(text));
    }
  });
});

describe("renderLine", () => {
  it("renders a line in the context it is given", () => {
    const [fence] = renderLines("```");
    assert.ok(fence !== undefined);
    assert.equal(renderLine("@x", "", fence.after, NO_FACTS).line.output, "@x");
    assert.equal(renderLine("@x", "", fence.before, NO_FACTS).line.output, "`@x`");
  });
});

describe("closerAfter", () => {
  it("closes the block the last line leaves open", () => {
    assert.equal(closerAfter([]), "");
    assert.equal(closerAfter(renderLines("```\n@x")), "\n```");
    assert.equal(closerAfter(renderLines("```\n@x\n```")), "");
    assert.equal(closerAfter(renderLines("<!--\n@x\n")), "\n-->");
  });
});
