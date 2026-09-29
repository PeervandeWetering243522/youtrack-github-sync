/**
 * formatMirror() body truncation (src/mirror.ts and src/utils/markdown-cut.ts):
 * where the description is cut, how open blocks are closed, and that the cut
 * rendering stays neutralised and within MAX_BODY_LENGTH.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_BODY_LENGTH, formatMirror, neutraliseReferences, youtrackIssueUrl } from "../../src/mirror.ts";
import { BASE_URL, BUDGET, LIMIT_TAIL, LONE_SURROGATE, limitTail, liveReferences, makeIssue } from "./fixtures.ts";

describe("formatMirror body truncation", () => {
  it("cuts a 70k description to exactly the limit", () => {
    const mirror = formatMirror(makeIssue({ description: "x".repeat(70_000) }), BASE_URL);
    assert.equal(mirror.body, "x".repeat(BUDGET) + LIMIT_TAIL);
    assert.equal(mirror.body.length, MAX_BODY_LENGTH);
  });

  it("never splits a surrogate pair when cutting the body", () => {
    const split = formatMirror(makeIssue({ description: "a".repeat(BUDGET - 1) + "😀".repeat(5_000) }), BASE_URL);
    assert.equal(split.body, "a".repeat(BUDGET - 1) + LIMIT_TAIL);
    assert.doesNotMatch(split.body, LONE_SURROGATE);
    const whole = formatMirror(makeIssue({ description: "a".repeat(BUDGET - 2) + "😀".repeat(5_000) }), BASE_URL);
    assert.equal(whole.body, `${"a".repeat(BUDGET - 2)}😀${LIMIT_TAIL}`);
  });

  it("cuts at line boundaries when no room is left for part of the next line", () => {
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

  it("copies code verbatim and closes the fence when the cut falls inside it", () => {
    const description = `\`\`\`\n${"@x ".repeat(30_000)}`;
    const mirror = formatMirror(makeIssue({ description }), BASE_URL);
    assert.equal(mirror.body, `${description.slice(0, BUDGET - 4)}\n\`\`\`${LIMIT_TAIL}`);
    assert.equal(mirror.body.length, MAX_BODY_LENGTH);
  });

  it("closes a fence with a closer as long as its opener, even when that shortens the cut", () => {
    const description = `Log:\n~~~~ text\n${"line @x #1\n".repeat(7_000)}`;
    const mirror = formatMirror(makeIssue({ description }), BASE_URL);
    const part = mirror.body.slice(0, -LIMIT_TAIL.length);
    assert.ok(mirror.body.endsWith(`\n~~~~${LIMIT_TAIL}`));
    assert.ok(part.startsWith("Log:\n~~~~ text\nline @x #1\n"));
    assert.ok(
      part
        .split("\n")
        .slice(2, -1)
        .every((line) => "line @x #1".startsWith(line)),
    );
    assert.ok(mirror.body.length <= MAX_BODY_LENGTH && mirror.body.length > MAX_BODY_LENGTH - 12);
  });

  it("leaves closing a fence inside a list item or quote to the separator", () => {
    for (const [prefix, content] of [
      ["- ```\n", "  line @x\n"],
      ["> ```\n", "> line @x\n"],
    ] as const) {
      const mirror = formatMirror(makeIssue({ description: prefix + content.repeat(8_000) }), BASE_URL);
      const lines = mirror.body.slice(0, -LIMIT_TAIL.length).split("\n");
      assert.ok(mirror.body.endsWith(LIMIT_TAIL));
      assert.ok(
        lines.slice(1).every((line) => content.startsWith(line)),
        prefix,
      );
    }
  });

  it("closes an HTML comment that the cut leaves open, so the notice stays visible", () => {
    const mirror = formatMirror(makeIssue({ description: `<!--\n${"hidden @x\n".repeat(8_000)}` }), BASE_URL);
    assert.ok(mirror.body.endsWith(`\n-->${LIMIT_TAIL}`));
    assert.ok(mirror.body.length <= MAX_BODY_LENGTH);
  });

  it("drops whole lines when the recut lands in a block with a longer closer", () => {
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

  it("keeps nothing of the description when only a blank prefix fits", () => {
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

  it("never splits a surrogate pair when cutting a line whose references grow", () => {
    for (const unit of ["@b😀", "😀@b", "&#64;b😀"]) {
      const mirror = formatMirror(makeIssue({ description: unit.repeat(20_000) }), BASE_URL);
      const part = mirror.body.slice(0, -LIMIT_TAIL.length);
      assert.ok(mirror.body.endsWith(LIMIT_TAIL), unit);
      assert.doesNotMatch(mirror.body, LONE_SURROGATE, unit);
      assert.ok(part.length <= BUDGET && part.length > BUDGET - 8, unit);
      assert.equal(neutraliseReferences(part), part, unit);
    }
  });

  it("keeps CRLF line endings and drops the blank line left by a cut", () => {
    const mirror = formatMirror(makeIssue({ description: `@a\r\n${"b\r\n".repeat(40_000)}` }), BASE_URL);
    const part = mirror.body.slice(0, -LIMIT_TAIL.length);
    assert.ok(part.startsWith("`@a`\r\nb\r\nb\r\n"));
    assert.ok(part.endsWith("\r\nb"));
    assert.ok(mirror.body.length <= MAX_BODY_LENGTH && mirror.body.length > MAX_BODY_LENGTH - 4);
  });

  it("re-neutralises a cut that lands inside a code span", () => {
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

  it("fills the space left when the start of a cut line renders shorter than its source", () => {
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

  it("truncates when only the neutralised description overflows", () => {
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
});
