/**
 * formatMirror() title and body layout (src/mirror.ts) when nothing or only the
 * title is cut, and the closer for a block the description leaves open. Body
 * truncation is tested in mirror-cut.test.ts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ELLIPSIS, MAX_BODY_LENGTH, MAX_TITLE_LENGTH, formatMirror, neutraliseReferences } from "../src/mirror.ts";
import {
  BASE_URL,
  BUDGET,
  FOOTER,
  LIMIT_TAIL,
  LONE_SURROGATE,
  ROOM,
  SEPARATOR,
  TITLE_HEAD,
  makeIssue,
} from "./mirror-helpers.ts";

describe("formatMirror", () => {
  it("formats title and body with a neutralised description", () => {
    const description = "Ping @bob about #12.\n\n```\n@keep #1\n```";
    const mirror = formatMirror(makeIssue({ description }), BASE_URL);
    assert.deepEqual(mirror, {
      title: "[YT-7] [team] Fix it",
      body: `Ping \`@bob\` about \`#12\`.\n\n\`\`\`\n@keep #1\n\`\`\`${SEPARATOR}${FOOTER}`,
      titleTruncated: false,
      bodyTruncated: false,
    });
  });

  it("uses only the link line for a null or blank description", () => {
    for (const description of [null, "", "  \n\t "]) {
      const mirror = formatMirror(makeIssue({ description }), BASE_URL);
      assert.equal(mirror.body, FOOTER);
      assert.equal(mirror.bodyTruncated, false);
    }
  });

  it("trims the summary and drops the space when it is empty", () => {
    assert.equal(formatMirror(makeIssue({ summary: "  [team] Fix  " }), BASE_URL).title, "[YT-7] [team] Fix");
    assert.equal(formatMirror(makeIssue({ summary: "   " }), BASE_URL).title, "[YT-7]");
  });

  it("keeps a title of exactly MAX_TITLE_LENGTH", () => {
    const mirror = formatMirror(makeIssue({ summary: "x".repeat(MAX_TITLE_LENGTH - 7) }), BASE_URL);
    assert.equal(mirror.title.length, MAX_TITLE_LENGTH);
    assert.equal(mirror.titleTruncated, false);
    assert.equal(mirror.body, FOOTER);
  });

  it("cuts a longer title, ends it with the ellipsis and notes it in the body", () => {
    const summary = "x".repeat(MAX_TITLE_LENGTH - 6);
    const mirror = formatMirror(makeIssue({ summary }), BASE_URL);
    assert.equal(mirror.title, `[YT-7] ${summary}`.slice(0, MAX_TITLE_LENGTH - 1) + ELLIPSIS);
    assert.equal(mirror.title.length, MAX_TITLE_LENGTH);
    assert.equal(mirror.titleTruncated, true);
    assert.equal(mirror.body, `${TITLE_HEAD}${FOOTER}`);
  });

  it("never splits a surrogate pair when cutting the title", () => {
    const full = `[YT-7] ${"a".repeat(247)}😀b`;
    const mirror = formatMirror(makeIssue({ summary: full.slice(7) }), BASE_URL);
    assert.equal(mirror.title, full.slice(0, 254) + ELLIPSIS);
    assert.doesNotMatch(mirror.title, LONE_SURROGATE);
  });

  it("keeps a body of exactly MAX_BODY_LENGTH and cuts one character more", () => {
    const fits = "a".repeat(MAX_BODY_LENGTH - SEPARATOR.length - FOOTER.length);
    const exact = formatMirror(makeIssue({ description: fits }), BASE_URL);
    assert.equal(exact.body.length, MAX_BODY_LENGTH);
    assert.equal(exact.bodyTruncated, false);
    const over = formatMirror(makeIssue({ description: `${fits}a` }), BASE_URL);
    assert.equal(over.body, "a".repeat(BUDGET) + LIMIT_TAIL);
    assert.equal(over.bodyTruncated, true);
  });

  it("does not truncate when character references make the rendered description short enough", () => {
    // Each "&#64;a " renders as "`@a` ": 7 source characters become 5.
    const description = "&#64;a ".repeat(9_500);
    const mirror = formatMirror(makeIssue({ description }), BASE_URL);
    assert.ok(description.length > MAX_BODY_LENGTH);
    assert.equal(mirror.bodyTruncated, false);
    assert.equal(mirror.body, `${"`@a` ".repeat(9_500)}${SEPARATOR}${FOOTER}`);
  });

  it("does not truncate when escapes make the rendered description short enough", () => {
    const description = "\\@a\\-\\-\\-\\-\\-b ".repeat(4_500);
    const mirror = formatMirror(makeIssue({ description }), BASE_URL);
    assert.ok(description.length > MAX_BODY_LENGTH);
    assert.equal(mirror.bodyTruncated, false);
    assert.equal(mirror.body, `${"`@a-----b` ".repeat(4_500)}${SEPARATOR}${FOOTER}`);
  });

  it("combines the title notice with body truncation", () => {
    const mirror = formatMirror(makeIssue({ summary: "s".repeat(300), description: "d".repeat(70_000) }), BASE_URL);
    const budget = MAX_BODY_LENGTH - TITLE_HEAD.length - LIMIT_TAIL.length;
    assert.equal(mirror.body, TITLE_HEAD + "d".repeat(budget) + LIMIT_TAIL);
    assert.equal(mirror.titleTruncated, true);
    assert.equal(mirror.bodyTruncated, true);
  });

  it("keeps the hard limit even with an absurdly long base URL", () => {
    const baseUrl = `${BASE_URL}/${"p".repeat(70_000)}`;
    for (const description of [null, "d".repeat(70_000)]) {
      const mirror = formatMirror(makeIssue({ description }), baseUrl);
      assert.equal(mirror.body.length, MAX_BODY_LENGTH);
      assert.equal(mirror.bodyTruncated, true);
    }
  });

  it("does not modify its input", () => {
    const issue = Object.freeze(makeIssue({ summary: "x".repeat(400), description: "@a ".repeat(30_000) }));
    const copy = { ...issue };
    formatMirror(issue, BASE_URL);
    assert.deepEqual(issue, copy);
  });
});

// A description that is not cut but leaves a top-level fence or HTML block (kinds
// 1-5) open used to swallow the separator and the link line into the block.
describe("formatMirror closes a block the description leaves open", () => {
  function bodyOf(description: string): string {
    const mirror = formatMirror(makeIssue({ description }), BASE_URL);
    assert.equal(mirror.bodyTruncated, false, JSON.stringify(description));
    return mirror.body;
  }

  it("closes an unclosed ``` fence before the separator", () => {
    assert.equal(bodyOf("Intro @a\n```\n@code #1"), `Intro \`@a\`\n\`\`\`\n@code #1\n\`\`\`${SEPARATOR}${FOOTER}`);
  });

  it("closes an unclosed ~~~~ fence with a closer as long as its opener", () => {
    // "~~~" is too short to close the four-tilde fence, so it stays code.
    assert.equal(bodyOf("~~~~ text\nline @x\n~~~"), `~~~~ text\nline @x\n~~~\n~~~~${SEPARATOR}${FOOTER}`);
  });

  it("closes an unclosed <!-- comment, so the link line stays visible", () => {
    assert.equal(bodyOf("Before @a\n\n<!--\nhidden @x"), `Before \`@a\`\n\n<!--\nhidden @x\n-->${SEPARATOR}${FOOTER}`);
  });

  it("adds nothing where the separator already ends the block", () => {
    const descriptions = ["- ```\n  @dec", "> ```\n> @dec", "    code @x", "<div>\n@x", "```\n@a\n```", "@a ` b"];
    for (const description of descriptions) {
      assert.equal(bodyOf(description), `${neutraliseReferences(description)}${SEPARATOR}${FOOTER}`, description);
    }
  });

  it("falls back to truncation when the closer no longer fits, keeping the hard limit", () => {
    for (const [opener, closer] of [
      ["```\n", "\n```"],
      ["<!--\n", "\n-->"],
    ] as const) {
      const fill = ROOM - opener.length - closer.length;
      const exact = formatMirror(makeIssue({ description: opener + "a".repeat(fill) }), BASE_URL);
      assert.equal(exact.body, `${opener}${"a".repeat(fill)}${closer}${SEPARATOR}${FOOTER}`, opener);
      assert.equal(exact.body.length, MAX_BODY_LENGTH, opener);
      assert.equal(exact.bodyTruncated, false, opener);
      const over = formatMirror(makeIssue({ description: opener + "a".repeat(fill + 1) }), BASE_URL);
      const kept = "a".repeat(BUDGET - opener.length - closer.length);
      assert.equal(over.body, `${opener}${kept}${closer}${LIMIT_TAIL}`, opener);
      assert.equal(over.body.length, MAX_BODY_LENGTH, opener);
      assert.equal(over.bodyTruncated, true, opener);
    }
  });
});
