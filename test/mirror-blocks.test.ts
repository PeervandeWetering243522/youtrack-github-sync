/**
 * neutraliseReferences() at the block level (src/utils/markdown-blocks.ts, reached
 * through src/mirror.ts): containers, fences, indented code, HTML blocks and
 * paragraph boundaries.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { neutraliseReferences } from "../src/mirror.ts";

// Expected outputs below were cross-checked with commonmark.js 0.31 (the CommonMark
// reference parser): no reference stays live text and no code block changes.
describe("neutraliseReferences block structure (CommonMark containers)", () => {
  function expectAll(cases: readonly (readonly [string, string])[]): void {
    for (const [input, expected] of cases) assert.equal(neutraliseReferences(input), expected, JSON.stringify(input));
  }

  it("finds fences inside list items and block quotes", () => {
    expectAll([
      ["- ```\n  @dec\n  ```\n@bob", "- ```\n  @dec\n  ```\n`@bob`"],
      ["1) ```\n   @dec\n   ```", "1) ```\n   @dec\n   ```"],
      ["-   item\n    ```\n    @dec\n    ```\n@bob", "-   item\n    ```\n    @dec\n    ```\n`@bob`"],
      ["10. step\n    ```\n    @dec\n    ```", "10. step\n    ```\n    @dec\n    ```"],
      ["- - ```\n    @dec\n    ```\n@x", "- - ```\n    @dec\n    ```\n`@x`"],
      ["> ```\n> @dec\n> ```\n@bob", "> ```\n> @dec\n> ```\n`@bob`"],
      [">```\n>@dec\n>```\n@x", ">```\n>@dec\n>```\n`@x`"],
      ["> - ```\n>   @dec\n>   ```\n> @x", "> - ```\n>   @dec\n>   ```\n> `@x`"],
      ["-\t```\n\t@dec\n\t```\n@bob", "-\t```\n\t@dec\n\t```\n`@bob`"],
    ]);
  });

  it("ends a fence when its list item or block quote ends", () => {
    expectAll([
      ["- step\n  ```\n  code @x\n@bob", "- step\n  ```\n  code @x\n`@bob`"],
      ["> ```\n@bob", "> ```\n`@bob`"],
    ]);
  });

  it("treats an over-indented fence as text or indented code, never as a fence", () => {
    expectAll([
      ["Some text\n    ```\n@bob\n```", "Some text\n    ```\n`@bob`\n```"],
      ["\t```\n@bob", "\t```\n`@bob`"],
      ["a\n2. b\n    ```\n@c", "a\n2. b\n    ```\n`@c`"],
      ["a\n-\n    ```\n@c", "a\n-\n    ```\n`@c`"],
    ]);
  });

  it("applies the list interruption rules (only an item starting at 1 may interrupt)", () => {
    expectAll([["a\n1. b\n    ```\n    @c\n    ```", "a\n1. b\n    ```\n    @c\n    ```"]]);
  });

  it("leaves indented code blocks untouched", () => {
    expectAll([
      ["text\n\n    @dec\n\n@bob", "text\n\n    @dec\n\n`@bob`"],
      ["-      @code\n@bob", "-      @code\n`@bob`"],
      ["-\n\n    @x", "-\n\n    @x"],
      ["- a\n\n    @x", "- a\n\n    `@x`"],
    ]);
  });

  it("copies HTML blocks and finds where they end", () => {
    expectAll([
      ["<!--\n```\n-->\n@bob", "<!--\n```\n-->\n`@bob`"],
      ["<div>\n@bob\n</div>\n\n@carol", "<div>\n@bob\n</div>\n\n`@carol`"],
      ["<pre>\n@bob\n\n@x\n</pre>\n@carol", "<pre>\n@bob\n\n@x\n</pre>\n`@carol`"],
      ["<custom-tag>\n```\n\n@bob\n```", "<custom-tag>\n```\n\n`@bob`\n```"],
      ["text\n<custom-tag>\n```\n@bob\n```", "text\n<custom-tag>\n```\n@bob\n```"],
      ["<?php\n@x\n?>\n@y", "<?php\n@x\n?>\n`@y`"],
      ["<!DOCTYPE html>\n@y", "<!DOCTYPE html>\n`@y`"],
      ["<![CDATA[\n@x\n]]>\n@y", "<![CDATA[\n@x\n]]>\n`@y`"],
      ["<script>@x</script>\n@y", "<script>@x</script>\n`@y`"],
    ]);
  });

  it("keeps paragraph boundaries at headings and thematic breaks", () => {
    expectAll([
      ["a `b\n---\n@c` d", "a `b\n---\n``@c`` ` d"],
      ["# `a\n@b` c", "# `a\n``@b`` ` c"],
      ["***\n@a\n___\n* * *", "***\n`@a`\n___\n* * *"],
    ]);
  });

  it("follows a paragraph into lazy continuation lines", () => {
    expectAll([["> a `b\nc @x` d", "> a `b\nc ``@x`` ` d"]]);
  });

  it("splits lines at a lone carriage return and keeps it", () => {
    expectAll([["@a\r```\r@b\r```\r@c", "`@a`\r```\r@b\r```\r`@c`"]]);
  });

  it("handles fence info strings and longer fences", () => {
    expectAll([
      ["~~~ `@info` ~~~\n@code\n~~~\n@y", "~~~ `@info` ~~~\n@code\n~~~\n`@y`"],
      ["````\n```\n@x\n````\n@y", "````\n```\n@x\n````\n`@y`"],
    ]);
  });
});
