/**
 * neutraliseReferences() at the inline level (src/utils/markdown-inline.ts and
 * markdown-escapes.ts, reached through src/mirror.ts): reference forms, code
 * spans, escapes, character references, plus top-level fences and fuzzing.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { neutraliseReferences } from "../../src/mirror.ts";
import { fuzzInputs, liveReferences } from "./fixtures.ts";

describe("neutraliseReferences", () => {
  it("wraps every reference form in backticks", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["@alice", "`@alice`"],
      ["@org/team-x", "`@org/team-x`"],
      ["#123", "`#123`"],
      ["GH-123", "`GH-123`"],
      ["gh-9", "`gh-9`"],
      ["owner/repo#5", "`owner/repo#5`"],
      ["jlord/sheetsee.js#26", "`jlord/sheetsee.js#26`"],
      ["Ask @bob about #12 and GH-3.", "Ask `@bob` about `#12` and `GH-3`."],
    ];
    for (const [input, expected] of cases) assert.equal(neutraliseReferences(input), expected, input);
  });

  it("wraps references next to punctuation, emphasis and links", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["(#12)", "(`#12`)"],
      ["#12.", "`#12`."],
      ["a, @b; #3!", "a, `@b`; `#3`!"],
      ["**#12**", "**`#12`**"],
      ["_#12_", "_`#12`_"],
      ["_foo_#1", "_foo_`#1`"],
      ["[#12](https://x.org)", "[`#12`](https://x.org)"],
      ["ping @org/team.", "ping `@org/team`."],
      ["@org/...", "`@org`/..."],
    ];
    for (const [input, expected] of cases) assert.equal(neutraliseReferences(input), expected, input);
  });

  it("leaves emails, URLs, paths and glued words alone", () => {
    for (const input of [
      "mail a@b.com or bob.smith@example.org",
      "https://x.org/p#12 and https://x.org/#12",
      "https://medium.com/@user/post",
      "see a/b/c#1 and path/to/file#12",
      "foo#1 issue#5 #12abc GH-12a x-GH-1 user.@bob",
      "@ # # heading GH- gh-x C# 5",
    ]) {
      assert.equal(neutraliseReferences(input), input, input);
    }
  });

  it("leaves fenced code blocks untouched", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["```\n@bob #1\n```\n@carol", "```\n@bob #1\n```\n`@carol`"],
      ["~~~python\n@dec\n~~~\n@x", "~~~python\n@dec\n~~~\n`@x`"],
      ["~~~\n```\n@bob\n~~~\n@x", "~~~\n```\n@bob\n~~~\n`@x`"],
      ["````\n```\n@bob\n````\n@carol", "````\n```\n@bob\n````\n`@carol`"],
      ["- step\n    ```\n    @dec\n    ```\n@out", "- step\n    ```\n    @dec\n    ```\n`@out`"],
      ["```\n@bob never closed", "```\n@bob never closed"],
    ];
    for (const [input, expected] of cases) assert.equal(neutraliseReferences(input), expected, input);
  });

  it("only closes a fence with a bare run that is not indented too deeply", () => {
    assert.equal(neutraliseReferences("```js\n@a\n```py\n@b\n```\n@c"), "```js\n@a\n```py\n@b\n```\n`@c`");
    assert.equal(neutraliseReferences("```\n    ```\n@in\n```\n@out"), "```\n    ```\n@in\n```\n`@out`");
  });

  it("treats a one-line ```code``` as inline code, not a fence", () => {
    assert.equal(neutraliseReferences("```code``` @bob\n@carol"), "```code``` `@bob`\n`@carol`");
  });

  it("keeps carriage returns and handles CRLF fences", () => {
    assert.equal(neutraliseReferences("@a\r\n```\r\n@b\r\n```\r\n@c"), "`@a`\r\n```\r\n@b\r\n```\r\n`@c`");
  });

  it("leaves inline code spans untouched", () => {
    assert.equal(neutraliseReferences("`@bob` and @carol"), "`@bob` and `@carol`");
    assert.equal(neutraliseReferences("`` a ` @b `` @c"), "`` a ` @b `` `@c`");
  });

  it("uses a longer delimiter when a stray backtick could pair with a single one", () => {
    assert.equal(neutraliseReferences("a ` b @bob"), "a ` b ``@bob``");
  });

  it("separates the delimiter from adjacent backticks with a space", () => {
    assert.equal(neutraliseReferences("`x`#1"), "`x` `#1`");
    assert.equal(neutraliseReferences("@bob`"), "``@bob`` `");
    assert.equal(neutraliseReferences("\\`@bob"), "\\` `@bob`");
  });

  it("handles backslash escapes around and inside references", () => {
    assert.equal(neutraliseReferences("\\#12"), "`#12`");
    assert.equal(neutraliseReferences("\\\\#12"), "\\\\`#12`");
    assert.equal(neutraliseReferences("\\GH-1"), "\\\\`GH-1`");
    assert.equal(neutraliseReferences("@bob\\-x"), "`@bob-x`");
  });

  it("wraps references written with character references, in their rendered form", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["&#64;bob, &#x40;Bob and &commat;carol", "`@bob`, `@Bob` and `@carol`"],
      ["&num;12 GH&#45;3 o&sol;r#4 &#35;5 @org&sol;t&lowbar;x", "`#12` `GH-3` `o/r#4` `#5` `@org/t_x`"],
      ["&#0;@bob caf&#233;#7", "&#0;`@bob` caf&#233;`#7`"],
      // An escaped "&" starts no reference, and 8 digits make none: both are plain text.
      ["\\&#64;bob &#12345678;", "\\&`#64`;bob &`#12345678`;"],
    ];
    for (const [input, expected] of cases) assert.equal(neutraliseReferences(input), expected, input);
  });

  it("leaves other character references intact (they used to be cut apart)", () => {
    for (const input of ["&#8364; &#10003; &#x2014; &#35;x &#64; a&#64;b.com a&period;@bob `&#64;bob` &amp; &lt;"]) {
      assert.equal(neutraliseReferences(input), input, input);
    }
  });

  it("treats _ as emphasis, not as part of a word (a deliberate departure from the A4 spec regex)", () => {
    // "_@bob_" renders <em>@bob</em>, which GitHub links; intraword "_" gets
    // wrapped too, which is harmless.
    assert.equal(neutraliseReferences("_@bob_ __#12__ snake_case_@x"), "_`@bob`_ __`#12`__ snake_case_`@x`");
  });

  it("merges directly adjacent references into one span", () => {
    assert.equal(neutraliseReferences("#1#2"), "`#1#2`");
    assert.equal(neutraliseReferences("@bob#1"), "`@bob#1`");
  });

  it("accounts for code spans that continue on the next line", () => {
    assert.equal(neutraliseReferences("a `b\nc @x` d"), "a `b\nc ``@x`` ` d");
    // The stray backtick on line 1 pairs with the first one on line 2 in CommonMark,
    // which exposes @bob; it is wrapped although it looks like inline code.
    assert.equal(neutraliseReferences("Use the ` key\nthen type `@bob hi`"), "Use the ` key\nthen type ` ``@bob`` hi`");
    // A blank line ends the paragraph, so line 3 is back to normal.
    assert.equal(neutraliseReferences("a ` b\n\n`@c` @d"), "a ` b\n\n`@c` `@d`");
  });

  it("returns empty and blank input unchanged", () => {
    assert.equal(neutraliseReferences(""), "");
    assert.equal(neutraliseReferences(" \n\t\n"), " \n\t\n");
  });

  it("is idempotent", () => {
    const corpus = [
      "`@alice` and ``@bob`` #1",
      "a ` b @bob\nc `@d` e",
      "\\`@x \\\\#2 \\GH-3 `y`@z",
      "```\n@a\n```\n@b",
      ...fuzzInputs(1, 500),
    ];
    for (const input of corpus) {
      const once = neutraliseReferences(input);
      assert.equal(neutraliseReferences(once), once, JSON.stringify(input));
    }
  });

  it("leaves no live reference outside code (fuzzed, reproducible)", () => {
    for (const input of fuzzInputs(2, 3000)) {
      const output = neutraliseReferences(input);
      assert.deepEqual(liveReferences(output), [], JSON.stringify({ input, output }));
      assert.equal(neutraliseReferences(output), output, JSON.stringify(input));
    }
  });

  it("finds references that the checker also sees in the raw input", () => {
    assert.notDeepEqual(liveReferences("ping @bob"), []);
    assert.deepEqual(liveReferences(neutraliseReferences("ping @bob")), []);
  });

  it("stays fast on pathological input", () => {
    const input = `${"_".repeat(70_000)}#1 ${"` @a ".repeat(5_000)}${"\\#1 ".repeat(5_000)}`;
    const started = performance.now();
    const output = neutraliseReferences(input);
    assert.ok(performance.now() - started < 2_000);
    assert.ok(output.startsWith(`${"_".repeat(70_000)}\`#1\``));
  });
});
