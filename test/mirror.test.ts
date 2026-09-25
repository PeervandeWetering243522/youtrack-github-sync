import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ELLIPSIS,
  MAX_BODY_LENGTH,
  MAX_TITLE_LENGTH,
  formatMirror,
  hasTitlePrefix,
  neutraliseReferences,
  parseMirrorTitle,
  youtrackIssueUrl,
} from "../src/mirror.ts";
import type { YouTrackIssue } from "../src/youtrack.ts";

const BASE_URL = "https://yt.example";
const ISSUE_URL = "https://yt.example/issue/CUI-7";
const SEPARATOR = "\n\n---\n";
const FOOTER = `Mirrored from YouTrack: ${ISSUE_URL}`;
const TITLE_HEAD = `Title character limit hit, see the full YouTrack issue: ${ISSUE_URL}\n\n`;
function limitTail(url: string): string {
  return `${SEPARATOR}Mirrored from YouTrack: ${url}${SEPARATOR}Character limit hit, see the full YouTrack issue: ${url}`;
}
const LIMIT_TAIL = limitTail(ISSUE_URL);
/** Description characters that fit in front of LIMIT_TAIL when the title is not cut. */
const BUDGET = MAX_BODY_LENGTH - LIMIT_TAIL.length;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function makeIssue(overrides: Partial<YouTrackIssue> = {}): YouTrackIssue {
  return {
    idReadable: "CUI-7",
    numberInProject: 7,
    summary: "[team] Fix it",
    description: null,
    resolved: null,
    updated: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Independent checker: references GitHub would still link, per the A4 rules,
// in the text outside CommonMark code spans (spans may cross line breaks).

const PUNCTUATION = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const LIVE_REFERENCE = [
  /(?<![A-Za-z0-9_/@.-])@[A-Za-z0-9]/,
  /(?<![A-Za-z0-9_/@.-])#\d+(?![A-Za-z0-9_])/,
  /(?<![A-Za-z0-9_/@.-])[Gg][Hh]-\d+(?![A-Za-z0-9_])/,
  /(?<![A-Za-z0-9_/@.-])[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+#\d+(?![A-Za-z0-9_])/,
];

function closerEnd(text: string, from: number, length: number): number {
  let index = from;
  while (index < text.length) {
    if (text.charAt(index) !== "`") {
      index += 1;
      continue;
    }
    let end = index;
    while (text.charAt(end) === "`") end += 1;
    if (end - index === length) return end;
    index = end;
  }
  return -1;
}

/** A numeric character reference, or a named one for a character the references use. */
const CHARACTER_REFERENCE = /&(?:#(\d{1,7})|#[Xx]([\dA-Fa-f]{1,6})|(commat|num|sol|period|lowbar|UnderBar));/y;
const NAMED: Readonly<Record<string, string>> = { commat: "@", num: "#", sol: "/", period: ".", lowbar: "_", UnderBar: "_" };

function characterReferenceAt(text: string, index: number): { readonly char: string; readonly length: number } | null {
  CHARACTER_REFERENCE.lastIndex = index;
  const match = CHARACTER_REFERENCE.exec(text);
  if (match === null) return null;
  const [whole, decimal, hex, name] = match;
  const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hex ?? "", 16);
  const numeric = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "\u{FFFD}";
  return { char: name !== undefined ? (NAMED[name] ?? "") : numeric, length: whole.length };
}

function textOutsideCodeSpans(paragraph: string): readonly string[] {
  const pieces: string[] = [];
  let current = "";
  let index = 0;
  while (index < paragraph.length) {
    const char = paragraph.charAt(index);
    const next = paragraph.charAt(index + 1);
    const reference = char === "&" ? characterReferenceAt(paragraph, index) : null;
    if (char === "\\" && next !== "" && PUNCTUATION.includes(next)) {
      current += next;
      index += 2;
    } else if (reference !== null) {
      current += reference.char;
      index += reference.length;
    } else if (char !== "`") {
      current += char;
      index += 1;
    } else {
      let runEnd = index;
      while (paragraph.charAt(runEnd) === "`") runEnd += 1;
      const close = closerEnd(paragraph, runEnd, runEnd - index);
      if (close === -1) current += paragraph.slice(index, runEnd);
      else pieces.push(current);
      if (close !== -1) current = "";
      index = close === -1 ? runEnd : close;
    }
  }
  return [...pieces, current];
}

function indentOf(line: string): number {
  return /^ */.exec(line)?.[0].length ?? 0;
}

function paragraphs(markdown: string): readonly string[] {
  const result: string[] = [];
  let current: string[] = [];
  let fence: { readonly char: string; readonly length: number; readonly indent: number } | null = null;
  for (const line of markdown.split("\n")) {
    const trimmed = line.replace(/^[ \t]+/, "");
    const run = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];
    const rest = run === undefined ? "" : trimmed.slice(run.length);
    if (fence !== null) {
      const closes =
        run?.startsWith(fence.char) === true &&
        run.length >= fence.length &&
        rest.trim() === "" &&
        indentOf(line) <= fence.indent + 3;
      if (closes) fence = null;
    } else if (run !== undefined && !(run.startsWith("`") && rest.includes("`"))) {
      fence = { char: run.charAt(0), length: run.length, indent: indentOf(line) };
      result.push(current.join("\n"));
      current = [];
    } else if (line.trim() === "") {
      result.push(current.join("\n"));
      current = [];
    } else {
      current.push(line);
    }
  }
  return [...result, current.join("\n")].filter((paragraph) => paragraph !== "");
}

function liveReferences(markdown: string): readonly string[] {
  return paragraphs(markdown)
    .flatMap(textOutsideCodeSpans)
    .filter((piece) => LIVE_REFERENCE.some((pattern) => pattern.test(piece)));
}

/** Deterministic PRNG (mulberry32), so fuzz failures are reproducible. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FUZZ_ALPHABET = [
  "`", "``", "\\", "#", "1", "12", "@", "a", "b", " ", "/", ".", "-", "GH-", "gh-", "x/y#3",
  "@o/t", "\\#", "\\`", "é", "😀", "\n", "\n", "\n\n", "```", "~~~", "(", ")", "&#64;", "&", ";",
];

/**
 * The checker above knows top-level fences and blank lines only, so line starts
 * that could open a list item, block quote, indented code or an ATX heading are
 * dropped (block structure has its own tests below).
 */
function fuzzInputs(seed: number, count: number): readonly string[] {
  const random = prng(seed);
  const pick = (): string => FUZZ_ALPHABET[Math.floor(random() * FUZZ_ALPHABET.length)] ?? "";
  return Array.from({ length: count }, () =>
    Array.from({ length: 1 + Math.floor(random() * 30) }, pick)
      .join("")
      .replace(/^(?:[ \d.-]|#+(?=[ \t]|$))+/gm, ""),
  );
}

// ---------------------------------------------------------------------------

void describe("youtrackIssueUrl", () => {
  void it("joins the base URL, /issue/ and the readable id", () => {
    assert.equal(youtrackIssueUrl(BASE_URL, "CUI-7"), ISSUE_URL);
  });
});

void describe("parseMirrorTitle", () => {
  void it("returns the number from a [YT-n] prefix", () => {
    assert.equal(parseMirrorTitle("[YT-12] [team] Fix"), 12);
    assert.equal(parseMirrorTitle("[YT-12]"), 12);
    assert.equal(parseMirrorTitle("[YT-3]no space"), 3);
  });

  void it("returns null unless the prefix is at the very start and well-formed", () => {
    for (const title of [
      "",
      " [YT-1] x",
      "Re: [YT-1] x",
      "[yt-1] x",
      "[YT-] x",
      "[YT-1a] x",
      "[YT--1] x",
      "[YT-1.5] x",
      "[YT-١٢] x",
      "YT-1 x",
    ]) {
      assert.equal(parseMirrorTitle(title), null, title);
    }
  });

  void it("rejects zero in any spelling", () => {
    assert.equal(parseMirrorTitle("[YT-0] x"), null);
    assert.equal(parseMirrorTitle("[YT-000] x"), null);
  });

  void it("accepts leading zeros (documented choice: [YT-007] is issue 7)", () => {
    assert.equal(parseMirrorTitle("[YT-007] x"), 7);
  });

  void it("accepts safe integers only", () => {
    assert.equal(parseMirrorTitle(`[YT-${String(Number.MAX_SAFE_INTEGER)}]`), Number.MAX_SAFE_INTEGER);
    assert.equal(parseMirrorTitle("[YT-9007199254740992]"), null);
    assert.equal(parseMirrorTitle(`[YT-${"9".repeat(400)}]`), null);
  });

  void it("round-trips titles built by formatMirror, truncated or not", () => {
    for (const summary of ["[team] Fix", "x".repeat(600)]) {
      const { title } = formatMirror(makeIssue({ numberInProject: 4321, summary }), BASE_URL);
      assert.equal(parseMirrorTitle(title), 4321);
    }
  });
});

void describe("hasTitlePrefix", () => {
  void it("matches case-insensitively", () => {
    assert.equal(hasTitlePrefix("[TEAM] Fix", "[team]"), true);
    assert.equal(hasTitlePrefix("[team]Fix", "[Team]"), true);
  });

  void it("ignores leading whitespace in the summary and surrounding whitespace in the prefix", () => {
    assert.equal(hasTitlePrefix("   \t[team] Fix", "[team]"), true);
    assert.equal(hasTitlePrefix("[team] Fix", "  [team]  "), true);
  });

  void it("rejects a prefix that is elsewhere or incomplete", () => {
    assert.equal(hasTitlePrefix("Fix [team]", "[team]"), false);
    assert.equal(hasTitlePrefix("[tea] Fix", "[team]"), false);
    assert.equal(hasTitlePrefix("", "[team]"), false);
  });

  void it("treats an empty prefix as matching everything (config rejects it)", () => {
    assert.equal(hasTitlePrefix("anything", ""), true);
  });
});

void describe("neutraliseReferences", () => {
  void it("wraps every reference form in backticks", () => {
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

  void it("wraps references next to punctuation, emphasis and links", () => {
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

  void it("leaves emails, URLs, paths and glued words alone", () => {
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

  void it("leaves fenced code blocks untouched", () => {
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

  void it("only closes a fence with a bare run that is not indented too deeply", () => {
    assert.equal(neutraliseReferences("```js\n@a\n```py\n@b\n```\n@c"), "```js\n@a\n```py\n@b\n```\n`@c`");
    assert.equal(neutraliseReferences("```\n    ```\n@in\n```\n@out"), "```\n    ```\n@in\n```\n`@out`");
  });

  void it("treats a one-line ```code``` as inline code, not a fence", () => {
    assert.equal(neutraliseReferences("```code``` @bob\n@carol"), "```code``` `@bob`\n`@carol`");
  });

  void it("keeps carriage returns and handles CRLF fences", () => {
    assert.equal(neutraliseReferences("@a\r\n```\r\n@b\r\n```\r\n@c"), "`@a`\r\n```\r\n@b\r\n```\r\n`@c`");
  });

  void it("leaves inline code spans untouched", () => {
    assert.equal(neutraliseReferences("`@bob` and @carol"), "`@bob` and `@carol`");
    assert.equal(neutraliseReferences("`` a ` @b `` @c"), "`` a ` @b `` `@c`");
  });

  void it("uses a longer delimiter when a stray backtick could pair with a single one", () => {
    assert.equal(neutraliseReferences("a ` b @bob"), "a ` b ``@bob``");
  });

  void it("separates the delimiter from adjacent backticks with a space", () => {
    assert.equal(neutraliseReferences("`x`#1"), "`x` `#1`");
    assert.equal(neutraliseReferences("@bob`"), "``@bob`` `");
    assert.equal(neutraliseReferences("\\`@bob"), "\\` `@bob`");
  });

  void it("handles backslash escapes around and inside references", () => {
    assert.equal(neutraliseReferences("\\#12"), "`#12`");
    assert.equal(neutraliseReferences("\\\\#12"), "\\\\`#12`");
    assert.equal(neutraliseReferences("\\GH-1"), "\\\\`GH-1`");
    assert.equal(neutraliseReferences("@bob\\-x"), "`@bob-x`");
  });

  void it("wraps references written with character references, in their rendered form", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["&#64;bob, &#x40;Bob and &commat;carol", "`@bob`, `@Bob` and `@carol`"],
      ["&num;12 GH&#45;3 o&sol;r#4 &#35;5 @org&sol;t&lowbar;x", "`#12` `GH-3` `o/r#4` `#5` `@org/t_x`"],
      ["&#0;@bob caf&#233;#7", "&#0;`@bob` caf&#233;`#7`"],
      // An escaped "&" starts no reference, and 8 digits make none: both are plain text.
      ["\\&#64;bob &#12345678;", "\\&`#64`;bob &`#12345678`;"],
    ];
    for (const [input, expected] of cases) assert.equal(neutraliseReferences(input), expected, input);
  });

  void it("leaves other character references intact (they used to be cut apart)", () => {
    for (const input of ["&#8364; &#10003; &#x2014; &#35;x &#64; a&#64;b.com a&period;@bob `&#64;bob` &amp; &lt;"]) {
      assert.equal(neutraliseReferences(input), input, input);
    }
  });

  void it("treats _ as emphasis, not as part of a word (a deliberate departure from the A4 spec regex)", () => {
    // "_@bob_" renders <em>@bob</em>, which GitHub links; intraword "_" gets
    // wrapped too, which is harmless.
    assert.equal(neutraliseReferences("_@bob_ __#12__ snake_case_@x"), "_`@bob`_ __`#12`__ snake_case_`@x`");
  });

  void it("merges directly adjacent references into one span", () => {
    assert.equal(neutraliseReferences("#1#2"), "`#1#2`");
    assert.equal(neutraliseReferences("@bob#1"), "`@bob#1`");
  });

  void it("accounts for code spans that continue on the next line", () => {
    assert.equal(neutraliseReferences("a `b\nc @x` d"), "a `b\nc ``@x`` ` d");
    // The stray backtick on line 1 pairs with the first one on line 2 in CommonMark,
    // which exposes @bob; it is wrapped although it looks like inline code.
    assert.equal(neutraliseReferences("Use the ` key\nthen type `@bob hi`"), "Use the ` key\nthen type ` ``@bob`` hi`");
    // A blank line ends the paragraph, so line 3 is back to normal.
    assert.equal(neutraliseReferences("a ` b\n\n`@c` @d"), "a ` b\n\n`@c` `@d`");
  });

  void it("returns empty and blank input unchanged", () => {
    assert.equal(neutraliseReferences(""), "");
    assert.equal(neutraliseReferences(" \n\t\n"), " \n\t\n");
  });

  void it("is idempotent", () => {
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

  void it("leaves no live reference outside code (fuzzed, reproducible)", () => {
    for (const input of fuzzInputs(2, 3000)) {
      const output = neutraliseReferences(input);
      assert.deepEqual(liveReferences(output), [], JSON.stringify({ input, output }));
      assert.equal(neutraliseReferences(output), output, JSON.stringify(input));
    }
  });

  void it("finds references that the checker also sees in the raw input", () => {
    assert.notDeepEqual(liveReferences("ping @bob"), []);
    assert.deepEqual(liveReferences(neutraliseReferences("ping @bob")), []);
  });

  void it("stays fast on pathological input", () => {
    const input = `${"_".repeat(70_000)}#1 ${"` @a ".repeat(5_000)}${"\\#1 ".repeat(5_000)}`;
    const started = performance.now();
    const output = neutraliseReferences(input);
    assert.ok(performance.now() - started < 2_000);
    assert.ok(output.startsWith(`${"_".repeat(70_000)}\`#1\``));
  });
});

// Expected outputs below were cross-checked with commonmark.js 0.31 (the CommonMark
// reference parser): no reference stays live text and no code block changes.
void describe("neutraliseReferences block structure (CommonMark containers)", () => {
  function expectAll(cases: readonly (readonly [string, string])[]): void {
    for (const [input, expected] of cases) assert.equal(neutraliseReferences(input), expected, JSON.stringify(input));
  }

  void it("finds fences inside list items and block quotes", () => {
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

  void it("ends a fence when its list item or block quote ends", () => {
    expectAll([
      ["- step\n  ```\n  code @x\n@bob", "- step\n  ```\n  code @x\n`@bob`"],
      ["> ```\n@bob", "> ```\n`@bob`"],
    ]);
  });

  void it("treats an over-indented fence as text or indented code, never as a fence", () => {
    expectAll([
      ["Some text\n    ```\n@bob\n```", "Some text\n    ```\n`@bob`\n```"],
      ["\t```\n@bob", "\t```\n`@bob`"],
      ["a\n2. b\n    ```\n@c", "a\n2. b\n    ```\n`@c`"],
      ["a\n-\n    ```\n@c", "a\n-\n    ```\n`@c`"],
    ]);
  });

  void it("applies the list interruption rules (only an item starting at 1 may interrupt)", () => {
    expectAll([["a\n1. b\n    ```\n    @c\n    ```", "a\n1. b\n    ```\n    @c\n    ```"]]);
  });

  void it("leaves indented code blocks untouched", () => {
    expectAll([
      ["text\n\n    @dec\n\n@bob", "text\n\n    @dec\n\n`@bob`"],
      ["-      @code\n@bob", "-      @code\n`@bob`"],
      ["-\n\n    @x", "-\n\n    @x"],
      ["- a\n\n    @x", "- a\n\n    `@x`"],
    ]);
  });

  void it("copies HTML blocks and finds where they end", () => {
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

  void it("keeps paragraph boundaries at headings and thematic breaks", () => {
    expectAll([
      ["a `b\n---\n@c` d", "a `b\n---\n``@c`` ` d"],
      ["# `a\n@b` c", "# `a\n``@b`` ` c"],
      ["***\n@a\n___\n* * *", "***\n`@a`\n___\n* * *"],
    ]);
  });

  void it("follows a paragraph into lazy continuation lines", () => {
    expectAll([["> a `b\nc @x` d", "> a `b\nc ``@x`` ` d"]]);
  });

  void it("splits lines at a lone carriage return and keeps it", () => {
    expectAll([["@a\r```\r@b\r```\r@c", "`@a`\r```\r@b\r```\r`@c`"]]);
  });

  void it("handles fence info strings and longer fences", () => {
    expectAll([
      ["~~~ `@info` ~~~\n@code\n~~~\n@y", "~~~ `@info` ~~~\n@code\n~~~\n`@y`"],
      ["````\n```\n@x\n````\n@y", "````\n```\n@x\n````\n`@y`"],
    ]);
  });
});

void describe("formatMirror", () => {
  void it("formats title and body with a neutralised description", () => {
    const description = "Ping @bob about #12.\n\n```\n@keep #1\n```";
    const mirror = formatMirror(makeIssue({ description }), BASE_URL);
    assert.deepEqual(mirror, {
      title: "[YT-7] [team] Fix it",
      body: `Ping \`@bob\` about \`#12\`.\n\n\`\`\`\n@keep #1\n\`\`\`${SEPARATOR}${FOOTER}`,
      titleTruncated: false,
      bodyTruncated: false,
    });
  });

  void it("uses only the link line for a null or blank description", () => {
    for (const description of [null, "", "  \n\t "]) {
      const mirror = formatMirror(makeIssue({ description }), BASE_URL);
      assert.equal(mirror.body, FOOTER);
      assert.equal(mirror.bodyTruncated, false);
    }
  });

  void it("trims the summary and drops the space when it is empty", () => {
    assert.equal(formatMirror(makeIssue({ summary: "  [team] Fix  " }), BASE_URL).title, "[YT-7] [team] Fix");
    assert.equal(formatMirror(makeIssue({ summary: "   " }), BASE_URL).title, "[YT-7]");
  });

  void it("keeps a title of exactly MAX_TITLE_LENGTH", () => {
    const mirror = formatMirror(makeIssue({ summary: "x".repeat(MAX_TITLE_LENGTH - 7) }), BASE_URL);
    assert.equal(mirror.title.length, MAX_TITLE_LENGTH);
    assert.equal(mirror.titleTruncated, false);
    assert.equal(mirror.body, FOOTER);
  });

  void it("cuts a longer title, ends it with the ellipsis and notes it in the body", () => {
    const summary = "x".repeat(MAX_TITLE_LENGTH - 6);
    const mirror = formatMirror(makeIssue({ summary }), BASE_URL);
    assert.equal(mirror.title, `[YT-7] ${summary}`.slice(0, MAX_TITLE_LENGTH - 1) + ELLIPSIS);
    assert.equal(mirror.title.length, MAX_TITLE_LENGTH);
    assert.equal(mirror.titleTruncated, true);
    assert.equal(mirror.body, `${TITLE_HEAD}${FOOTER}`);
  });

  void it("never splits a surrogate pair when cutting the title", () => {
    const full = `[YT-7] ${"a".repeat(247)}😀b`;
    const mirror = formatMirror(makeIssue({ summary: full.slice(7) }), BASE_URL);
    assert.equal(mirror.title, full.slice(0, 254) + ELLIPSIS);
    assert.doesNotMatch(mirror.title, LONE_SURROGATE);
  });

  void it("keeps a body of exactly MAX_BODY_LENGTH and cuts one character more", () => {
    const fits = "a".repeat(MAX_BODY_LENGTH - SEPARATOR.length - FOOTER.length);
    const exact = formatMirror(makeIssue({ description: fits }), BASE_URL);
    assert.equal(exact.body.length, MAX_BODY_LENGTH);
    assert.equal(exact.bodyTruncated, false);
    const over = formatMirror(makeIssue({ description: `${fits}a` }), BASE_URL);
    assert.equal(over.body, "a".repeat(BUDGET) + LIMIT_TAIL);
    assert.equal(over.bodyTruncated, true);
  });

  void it("cuts a 70k description to exactly the limit", () => {
    const mirror = formatMirror(makeIssue({ description: "x".repeat(70_000) }), BASE_URL);
    assert.equal(mirror.body, "x".repeat(BUDGET) + LIMIT_TAIL);
    assert.equal(mirror.body.length, MAX_BODY_LENGTH);
  });

  void it("never splits a surrogate pair when cutting the body", () => {
    const split = formatMirror(makeIssue({ description: "a".repeat(BUDGET - 1) + "😀".repeat(5_000) }), BASE_URL);
    assert.equal(split.body, "a".repeat(BUDGET - 1) + LIMIT_TAIL);
    assert.doesNotMatch(split.body, LONE_SURROGATE);
    const whole = formatMirror(makeIssue({ description: "a".repeat(BUDGET - 2) + "😀".repeat(5_000) }), BASE_URL);
    assert.equal(whole.body, `${"a".repeat(BUDGET - 2)}😀${LIMIT_TAIL}`);
  });

  void it("cuts at line boundaries when no room is left for part of the next line", () => {
    const next = `\n${"b".repeat(100_000)}`;
    const cases: readonly (readonly [string, string])[] = [
      ["a".repeat(BUDGET), "a".repeat(BUDGET)],
      ["a".repeat(BUDGET - 1), "a".repeat(BUDGET - 1)],
      ["a".repeat(BUDGET - 3), `${"a".repeat(BUDGET - 3)}\nbb`],
    ];
    for (const [first, kept] of cases) {
      assert.equal(formatMirror(makeIssue({ description: first + next }), BASE_URL).body, kept + LIMIT_TAIL);
    }
  });

  void it("copies code verbatim and closes the fence when the cut falls inside it", () => {
    const description = `\`\`\`\n${"@x ".repeat(30_000)}`;
    const mirror = formatMirror(makeIssue({ description }), BASE_URL);
    assert.equal(mirror.body, `${description.slice(0, BUDGET - 4)}\n\`\`\`${LIMIT_TAIL}`);
    assert.equal(mirror.body.length, MAX_BODY_LENGTH);
  });

  void it("closes a fence with a closer as long as its opener, even when that shortens the cut", () => {
    const description = `Log:\n~~~~ text\n${"line @x #1\n".repeat(7_000)}`;
    const mirror = formatMirror(makeIssue({ description }), BASE_URL);
    const part = mirror.body.slice(0, -LIMIT_TAIL.length);
    assert.ok(mirror.body.endsWith(`\n~~~~${LIMIT_TAIL}`));
    assert.ok(part.startsWith("Log:\n~~~~ text\nline @x #1\n"));
    assert.ok(part.split("\n").slice(2, -1).every((line) => "line @x #1".startsWith(line)));
    assert.ok(mirror.body.length <= MAX_BODY_LENGTH && mirror.body.length > MAX_BODY_LENGTH - 12);
  });

  void it("leaves closing a fence inside a list item or quote to the separator", () => {
    for (const [prefix, content] of [["- ```\n", "  line @x\n"], ["> ```\n", "> line @x\n"]] as const) {
      const mirror = formatMirror(makeIssue({ description: prefix + content.repeat(8_000) }), BASE_URL);
      const lines = mirror.body.slice(0, -LIMIT_TAIL.length).split("\n");
      assert.ok(mirror.body.endsWith(LIMIT_TAIL));
      assert.ok(lines.slice(1).every((line) => content.startsWith(line)), prefix);
    }
  });

  void it("closes an HTML comment that the cut leaves open, so the notice stays visible", () => {
    const mirror = formatMirror(makeIssue({ description: `<!--\n${"hidden @x\n".repeat(8_000)}` }), BASE_URL);
    assert.ok(mirror.body.endsWith(`\n-->${LIMIT_TAIL}`));
    assert.ok(mirror.body.length <= MAX_BODY_LENGTH);
  });

  void it("drops whole lines when the recut lands in a block with a longer closer", () => {
    // Cut 1 ends in the "<pre" block (closer "\n</pre>"). Recutting 7 characters
    // earlier lands inside the 10-backtick fence, whose closer does not fit after
    // the partial line, so that line goes and the fence is closed after the filler.
    // (Before the fix the fence stayed open and the notice rendered as code.)
    const fence = "`".repeat(10);
    const filler = "x".repeat(BUDGET - 27);
    const description = `${fence}\n${filler}\n${fence}\n<pre\n${"y".repeat(100_000)}`;
    const mirror = formatMirror(makeIssue({ description }), BASE_URL);
    assert.equal(mirror.body, `${fence}\n${filler}\n${fence}${LIMIT_TAIL}`);
    assert.ok(mirror.body.length <= MAX_BODY_LENGTH);
  });

  void it("keeps nothing of the description when only a blank prefix fits", () => {
    // Choose the URL length so that exactly two description characters fit.
    const urlLength = (MAX_BODY_LENGTH - limitTail("").length - 2) / 2;
    const baseUrl = `${BASE_URL}/${"p".repeat(urlLength - `${BASE_URL}//issue/CUI-7`.length)}`;
    const url = youtrackIssueUrl(baseUrl, "CUI-7");
    assert.equal(url.length, urlLength);
    const mirror = formatMirror(makeIssue({ description: `\n\n${"x".repeat(70_000)}` }), baseUrl);
    assert.equal(mirror.body, limitTail(url));
    assert.equal(mirror.body.length, MAX_BODY_LENGTH - 2);
    assert.equal(mirror.bodyTruncated, true);
  });

  void it("does not truncate when character references make the rendered description short enough", () => {
    // Each "&#64;a " renders as "`@a` ": 7 source characters become 5.
    const description = "&#64;a ".repeat(9_500);
    const mirror = formatMirror(makeIssue({ description }), BASE_URL);
    assert.ok(description.length > MAX_BODY_LENGTH);
    assert.equal(mirror.bodyTruncated, false);
    assert.equal(mirror.body, `${"`@a` ".repeat(9_500)}${SEPARATOR}${FOOTER}`);
  });

  void it("never splits a surrogate pair when cutting a line whose references grow", () => {
    for (const unit of ["@b😀", "😀@b", "&#64;b😀"]) {
      const mirror = formatMirror(makeIssue({ description: unit.repeat(20_000) }), BASE_URL);
      const part = mirror.body.slice(0, -LIMIT_TAIL.length);
      assert.ok(mirror.body.endsWith(LIMIT_TAIL), unit);
      assert.doesNotMatch(mirror.body, LONE_SURROGATE, unit);
      assert.ok(part.length <= BUDGET && part.length > BUDGET - 8, unit);
      assert.equal(neutraliseReferences(part), part, unit);
    }
  });

  void it("keeps CRLF line endings and drops the blank line left by a cut", () => {
    const mirror = formatMirror(makeIssue({ description: `@a\r\n${"b\r\n".repeat(40_000)}` }), BASE_URL);
    const part = mirror.body.slice(0, -LIMIT_TAIL.length);
    assert.ok(part.startsWith("`@a`\r\nb\r\nb\r\n"));
    assert.ok(part.endsWith("\r\nb"));
    assert.ok(mirror.body.length <= MAX_BODY_LENGTH && mirror.body.length > MAX_BODY_LENGTH - 4);
  });

  void it("re-neutralises a cut that lands inside a code span", () => {
    const line = `${"x".repeat(BUDGET - 60)} \`${"@z ".repeat(100)}\``;
    const mirror = formatMirror(makeIssue({ description: `intro @a\n${line}` }), BASE_URL);
    const part = mirror.body.slice(0, -LIMIT_TAIL.length);
    const [first = "", last = ""] = part.split("\n");
    assert.equal(mirror.bodyTruncated, true);
    assert.equal(first, "intro `@a`");
    assert.match(last, /``@z``/);
    assert.deepEqual(liveReferences(part), []);
    const prefixLengths = Array.from({ length: 60 }, (_, offset) => BUDGET - 9 - offset);
    assert.ok(prefixLengths.some((length) => neutraliseReferences(line.slice(0, length)) === last));
    assert.ok(mirror.body.length <= MAX_BODY_LENGTH && mirror.body.length > MAX_BODY_LENGTH - 8);
  });

  void it("does not truncate when escapes make the rendered description short enough", () => {
    const description = "\\@a\\-\\-\\-\\-\\-b ".repeat(4_500);
    const mirror = formatMirror(makeIssue({ description }), BASE_URL);
    assert.ok(description.length > MAX_BODY_LENGTH);
    assert.equal(mirror.bodyTruncated, false);
    assert.equal(mirror.body, `${"`@a-----b` ".repeat(4_500)}${SEPARATOR}${FOOTER}`);
  });

  void it("fills the space left when the start of a cut line renders shorter than its source", () => {
    // Line 1 grows by wrapping, so line 2 gets less room than its source length;
    // its escapes shrink, its tail grows, so the fitting cut is searched both ways.
    const shrinking = "\\@a\\-\\-\\-\\-\\-b ".repeat(2_000);
    const description = `${"@a ".repeat(6_000)}\n${shrinking}${"@a ".repeat(6_000)}`;
    const mirror = formatMirror(makeIssue({ description }), BASE_URL);
    const part = mirror.body.slice(0, -LIMIT_TAIL.length);
    assert.ok(mirror.body.endsWith(LIMIT_TAIL));
    assert.ok(part.length > BUDGET - 12 && part.length <= BUDGET);
    assert.equal(neutraliseReferences(part), part);
    assert.deepEqual(liveReferences(part), []);
  });

  void it("truncates when only the neutralised description overflows", () => {
    const description = "@b ".repeat(20_000);
    const mirror = formatMirror(makeIssue({ description }), BASE_URL);
    assert.equal(mirror.bodyTruncated, true);
    assert.ok(mirror.body.endsWith(LIMIT_TAIL));
    assert.ok(mirror.body.length <= MAX_BODY_LENGTH);
    const part = mirror.body.slice(0, -LIMIT_TAIL.length);
    assert.ok(part.length > BUDGET - 10);
    assert.equal(neutraliseReferences(part), part);
    assert.deepEqual(liveReferences(part), []);
  });

  void it("combines the title notice with body truncation", () => {
    const mirror = formatMirror(makeIssue({ summary: "s".repeat(300), description: "d".repeat(70_000) }), BASE_URL);
    const budget = MAX_BODY_LENGTH - TITLE_HEAD.length - LIMIT_TAIL.length;
    assert.equal(mirror.body, TITLE_HEAD + "d".repeat(budget) + LIMIT_TAIL);
    assert.equal(mirror.titleTruncated, true);
    assert.equal(mirror.bodyTruncated, true);
  });

  void it("keeps the hard limit even with an absurdly long base URL", () => {
    const baseUrl = `${BASE_URL}/${"p".repeat(70_000)}`;
    for (const description of [null, "d".repeat(70_000)]) {
      const mirror = formatMirror(makeIssue({ description }), baseUrl);
      assert.equal(mirror.body.length, MAX_BODY_LENGTH);
      assert.equal(mirror.bodyTruncated, true);
    }
  });

  void it("does not modify its input", () => {
    const issue = Object.freeze(makeIssue({ summary: "x".repeat(400), description: "@a ".repeat(30_000) }));
    const copy = { ...issue };
    formatMirror(issue, BASE_URL);
    assert.deepEqual(issue, copy);
  });
});
