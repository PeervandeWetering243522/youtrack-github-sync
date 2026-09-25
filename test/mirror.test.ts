/**
 * Matching rules in src/mirror.ts: the YouTrack link, the [YT-n] title marker and
 * the summary prefix. Formatting is tested in mirror-format.test.ts and
 * mirror-cut.test.ts, neutralising in mirror-inline.test.ts and mirror-blocks.test.ts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatMirror, hasTitlePrefix, parseMirrorTitle, youtrackIssueUrl } from "../src/mirror.ts";
import { BASE_URL, ISSUE_URL, makeIssue } from "./mirror-helpers.ts";

describe("youtrackIssueUrl", () => {
  it("joins the base URL, /issue/ and the readable id", () => {
    assert.equal(youtrackIssueUrl(BASE_URL, "CUI-7"), ISSUE_URL);
  });
});

describe("parseMirrorTitle", () => {
  it("returns the number from a [YT-n] prefix", () => {
    assert.equal(parseMirrorTitle("[YT-12] [team] Fix"), 12);
    assert.equal(parseMirrorTitle("[YT-12]"), 12);
    assert.equal(parseMirrorTitle("[YT-3]no space"), 3);
  });

  it("returns null unless the prefix is at the very start and well-formed", () => {
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

  it("rejects zero in any spelling", () => {
    assert.equal(parseMirrorTitle("[YT-0] x"), null);
    assert.equal(parseMirrorTitle("[YT-000] x"), null);
  });

  it("accepts leading zeros (documented choice: [YT-007] is issue 7)", () => {
    assert.equal(parseMirrorTitle("[YT-007] x"), 7);
  });

  it("accepts safe integers only", () => {
    assert.equal(parseMirrorTitle(`[YT-${String(Number.MAX_SAFE_INTEGER)}]`), Number.MAX_SAFE_INTEGER);
    assert.equal(parseMirrorTitle("[YT-9007199254740992]"), null);
    assert.equal(parseMirrorTitle(`[YT-${"9".repeat(400)}]`), null);
  });

  it("round-trips titles built by formatMirror, truncated or not", () => {
    for (const summary of ["[team] Fix", "x".repeat(600)]) {
      const { title } = formatMirror(makeIssue({ numberInProject: 4321, summary }), BASE_URL);
      assert.equal(parseMirrorTitle(title), 4321);
    }
  });
});

describe("hasTitlePrefix", () => {
  it("matches case-insensitively", () => {
    assert.equal(hasTitlePrefix("[TEAM] Fix", "[team]"), true);
    assert.equal(hasTitlePrefix("[team]Fix", "[Team]"), true);
  });

  it("ignores leading whitespace in the summary and surrounding whitespace in the prefix", () => {
    assert.equal(hasTitlePrefix("   \t[team] Fix", "[team]"), true);
    assert.equal(hasTitlePrefix("[team] Fix", "  [team]  "), true);
  });

  it("rejects a prefix that is elsewhere or incomplete", () => {
    assert.equal(hasTitlePrefix("Fix [team]", "[team]"), false);
    assert.equal(hasTitlePrefix("[tea] Fix", "[team]"), false);
    assert.equal(hasTitlePrefix("", "[team]"), false);
  });

  it("treats an empty prefix as matching everything (config rejects it)", () => {
    assert.equal(hasTitlePrefix("anything", ""), true);
  });
});
