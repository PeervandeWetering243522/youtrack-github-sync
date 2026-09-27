import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EMPTY_STATE, blockCloser, classifyLine } from "../../src/utils/markdown-blocks.ts";
import type { BlockState, ClassifiedLine } from "../../src/utils/markdown-blocks.ts";

/** Classifies `lines` in order and returns every classification. */
function classifyAll(lines: readonly string[]): readonly ClassifiedLine[] {
  const result: ClassifiedLine[] = [];
  let state = EMPTY_STATE;
  for (const line of lines) {
    const classified = classifyLine(state, line);
    result.push(classified);
    state = classified.state;
  }
  return result;
}

function stateAfter(markdown: string): BlockState {
  return classifyAll(markdown.split("\n")).at(-1)?.state ?? EMPTY_STATE;
}

describe("classifyLine", () => {
  it("tells code, text and blank lines apart and tracks a fence until it closes", () => {
    const lines = classifyAll(["intro", "```js", "@x", "```", "", "after"]);
    assert.deepEqual(
      lines.map((line) => line.kind),
      ["text", "code", "code", "code", "blank", "text"],
    );
    assert.equal(lines[2]?.state.leaf?.kind, "fence");
    assert.equal(lines[3]?.state.leaf, null);
  });

  it("marks paragraph continuation lines as joining", () => {
    const lines = classifyAll(["a", "b", "", "c"]);
    assert.deepEqual(
      lines.map((line) => line.joins),
      [false, true, false, false],
    );
  });

  it("opens containers for block quotes and list items", () => {
    const quote = stateAfter("> text");
    const item = stateAfter("- text");
    assert.deepEqual(
      quote.containers.map((container) => container.kind),
      ["quote"],
    );
    assert.deepEqual(
      item.containers.map((container) => container.kind),
      ["item"],
    );
    assert.equal(quote.leaf?.kind, "paragraph");
  });
});

describe("blockCloser", () => {
  it("closes a top-level fence with its own character and length", () => {
    assert.equal(blockCloser(stateAfter("```\ncode")), "\n```");
    assert.equal(blockCloser(stateAfter("````` js\ncode")), "\n`````");
    assert.equal(blockCloser(stateAfter("~~~~\ncode\n~~~")), "\n~~~~");
  });

  it("closes HTML blocks of kinds 1-5 with a matching end marker", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["<script>\nx", "\n</pre>"],
      ["<!--\nx", "\n-->"],
      ["<?php\nx", "\n?>"],
      ["<!DOCTYPE\nx", "\n>"],
      ["<![CDATA[\nx", "\n]]>"],
    ];
    for (const [markdown, closer] of cases) assert.equal(blockCloser(stateAfter(markdown)), closer, markdown);
  });

  it("returns nothing when no block is open, or a blank line or an unindented line ends it", () => {
    for (const markdown of [
      "",
      "text",
      "```\nx\n```",
      "<!-- x -->",
      "<div>\nx",
      "    code",
      "- ```\n  x",
      "> ```\n> x",
    ]) {
      assert.equal(blockCloser(stateAfter(markdown)), "", markdown);
    }
    assert.equal(blockCloser(EMPTY_STATE), "");
  });
});
