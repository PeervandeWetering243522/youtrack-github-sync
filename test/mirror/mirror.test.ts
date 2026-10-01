/**
 * Matching rules in src/mirror.ts: the YouTrack link, the [<project>-n] title marker
 * (and the legacy [YT-n] one, N1), the mirror title and the summary prefix. Formatting
 * is tested in format.test.ts and cut.test.ts, neutralising in inline.test.ts and
 * blocks.test.ts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ELLIPSIS,
  MAX_TITLE_LENGTH,
  formatMirror,
  hasTitlePrefix,
  mirrorTitle,
  parseMirrorTitle,
  youtrackIssueUrl,
} from "../../src/mirror.ts";
import { BASE_URL, ISSUE_URL, makeIssue } from "./fixtures.ts";

/** The configured YouTrack project of most cases below. */
const PROJECT = "CUI";
/** Built from code points, so the odd characters below are named, not invisible or look-alikes. */
const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);
const KELVIN_SIGN = String.fromCodePoint(0x212a);
const FULLWIDTH_CUI = String.fromCodePoint(0xff23, 0xff35, 0xff29);

describe("youtrackIssueUrl", () => {
  it("joins the base URL, /issue/ and the readable id", () => {
    assert.equal(youtrackIssueUrl(BASE_URL, "CUI-7"), ISSUE_URL);
  });
});

describe("parseMirrorTitle", () => {
  it("returns the number from a [<project>-n] prefix", () => {
    assert.equal(parseMirrorTitle("[CUI-12] [team] Fix", PROJECT), 12);
    assert.equal(parseMirrorTitle("[CUI-12] x", PROJECT), 12);
    assert.equal(parseMirrorTitle("[CUI-12]", PROJECT), 12);
    assert.equal(parseMirrorTitle("[CUI-3]no space", PROJECT), 3);
  });

  it("compares the project ASCII-case-insensitively, either way round", () => {
    assert.equal(parseMirrorTitle("[cui-12] x", "CUI"), 12);
    assert.equal(parseMirrorTitle("[Cui-12] x", "CUI"), 12);
    assert.equal(parseMirrorTitle("[CUI-12] x", "cui"), 12);
  });

  it("still matches the legacy [YT-n] prefix for any project, so old mirrors are found (and renamed)", () => {
    for (const project of ["CUI", "cui", "ABC", "MY-PROJ", "MY_PROJ", "YT"]) {
      assert.equal(parseMirrorTitle("[YT-12] [team] Fix", project), 12, project);
      assert.equal(parseMirrorTitle("[YT-12]", project), 12, project);
      assert.equal(parseMirrorTitle("[YT-3]no space", project), 3, project);
    }
  });

  it("matches the legacy prefix in upper case only, unless the project itself is YT", () => {
    // "[yt-1]" was never a mirror title, so it is not one now either.
    assert.equal(parseMirrorTitle("[yt-1] x", PROJECT), null);
    assert.equal(parseMirrorTitle("[Yt-1] x", PROJECT), null);
    assert.equal(parseMirrorTitle("[yt-1] x", "YT"), 1);
  });

  it("returns null for another project's ids", () => {
    for (const title of ["[ABC-12] x", "[CU-12] x", "[CUIX-12] x", "[XCUI-12] x", "[CUI_-12] x", "[CUI1-12] x"]) {
      assert.equal(parseMirrorTitle(title, PROJECT), null, title);
    }
    assert.equal(parseMirrorTitle("[CUI-12] x", "ABC"), null);
  });

  it("takes everything up to the last dash before the number as the project, so - and _ in it work", () => {
    assert.equal(parseMirrorTitle("[MY-PROJ-3] x", "MY-PROJ"), 3);
    assert.equal(parseMirrorTitle("[my-proj-3] x", "MY-PROJ"), 3);
    assert.equal(parseMirrorTitle("[MY_PROJ-3] x", "MY_PROJ"), 3);
    for (const title of ["[MY-3] x", "[PROJ-3] x", "[MY_PROJ-3] x", "[MY-PROJ-X-3] x"]) {
      assert.equal(parseMirrorTitle(title, "MY-PROJ"), null, title);
    }
    assert.equal(parseMirrorTitle("[MY-PROJ-3] x", "MY"), null);
    assert.equal(parseMirrorTitle("[MY-PROJ-3] x", "PROJ"), null);
  });

  it("returns null unless the prefix is at the very start and well-formed", () => {
    for (const id of ["CUI", "YT"]) {
      for (const title of [
        "",
        ` [${id}-1] x`,
        `Re: [${id}-1] x`,
        `${BYTE_ORDER_MARK}[${id}-1] x`,
        `[${id}-] x`,
        `[${id}-1a] x`,
        `[${id}--1] x`,
        `[${id}--3] x`,
        `[${id}-+3] x`,
        `[${id}-1.5] x`,
        `[${id}-١٢] x`,
        `[${id} 1] x`,
        `[${id}1] x`,
        `[${id}-1 x`,
        `${id}-1 x`,
        "[-1] x",
      ]) {
        assert.equal(parseMirrorTitle(title, PROJECT), null, title);
      }
    }
  });

  it("rejects zero in any spelling", () => {
    for (const title of ["[CUI-0] x", "[CUI-000] x", "[YT-0] x", "[YT-000] x"]) {
      assert.equal(parseMirrorTitle(title, PROJECT), null, title);
    }
  });

  it("accepts leading zeros (documented choice: [CUI-007] is issue 7)", () => {
    assert.equal(parseMirrorTitle("[CUI-007] x", PROJECT), 7);
    assert.equal(parseMirrorTitle("[YT-007] x", PROJECT), 7);
  });

  it("accepts safe integers only", () => {
    for (const id of ["CUI", "YT"]) {
      assert.equal(parseMirrorTitle(`[${id}-${String(Number.MAX_SAFE_INTEGER)}]`, PROJECT), Number.MAX_SAFE_INTEGER);
      assert.equal(parseMirrorTitle(`[${id}-9007199254740992]`, PROJECT), null);
      assert.equal(parseMirrorTitle(`[${id}-${"9".repeat(400)}]`, PROJECT), null);
    }
  });

  it("never lets a non-ASCII look-alike match, in the title or in the project", () => {
    // U+212A KELVIN SIGN lower-cases to "k" in Unicode, but only A-Z is folded here.
    assert.equal(KELVIN_SIGN.toLowerCase(), "k", "the look-alike a Unicode fold would accept");
    assert.equal(parseMirrorTitle("[KI-3] x", "KI"), 3);
    assert.equal(parseMirrorTitle("[ki-3] x", "KI"), 3);
    assert.equal(parseMirrorTitle(`[${KELVIN_SIGN}I-3] x`, "KI"), null);
    assert.equal(parseMirrorTitle("[KI-3] x", `${KELVIN_SIGN}I`), null);
    assert.equal(parseMirrorTitle("[ki-3] x", `${KELVIN_SIGN}I`), null);
    assert.equal(parseMirrorTitle(`[${FULLWIDTH_CUI}-3] x`, PROJECT), null, "fullwidth letters");
  });

  it("round-trips titles built by formatMirror, truncated or not", () => {
    for (const summary of ["[team] Fix", "x".repeat(600)]) {
      const { title } = formatMirror(makeIssue({ idReadable: "CUI-4321", numberInProject: 4321, summary }), BASE_URL);
      assert.equal(parseMirrorTitle(title, PROJECT), 4321);
    }
  });

  it("round-trips a title whose idReadable differs in case from the configured project", () => {
    const { title } = formatMirror(makeIssue({ idReadable: "cui-9", numberInProject: 9 }), BASE_URL);
    assert.equal(parseMirrorTitle(title, PROJECT), 9);
  });
});

describe("mirrorTitle", () => {
  it("equals the title formatMirror gives, cut or not", () => {
    const summaries = ["[team] Fix it", "  [team] Fix  ", "   ", "x".repeat(600), `${"a".repeat(246)}😀b`];
    for (const summary of summaries) {
      const issue = makeIssue({ summary });
      assert.equal(mirrorTitle(issue), formatMirror(issue, BASE_URL).title, summary);
    }
  });

  it("cuts a long title to MAX_TITLE_LENGTH, ending with the ellipsis", () => {
    const title = mirrorTitle(makeIssue({ summary: "x".repeat(600) }));
    assert.equal(title.length, MAX_TITLE_LENGTH);
    assert.equal(title, `[CUI-7] ${"x".repeat(MAX_TITLE_LENGTH - 9)}${ELLIPSIS}`);
  });

  it("takes the prefix from idReadable verbatim (N1), whatever numberInProject says", () => {
    assert.equal(mirrorTitle({ idReadable: "CUI-24", summary: "Fix login" }), "[CUI-24] Fix login");
    assert.equal(mirrorTitle({ idReadable: "cui-24", summary: "Fix login" }), "[cui-24] Fix login");
    assert.equal(mirrorTitle({ idReadable: "MY-PROJ-3", summary: "x" }), "[MY-PROJ-3] x");
    assert.equal(mirrorTitle(makeIssue({ idReadable: "CUI-24", numberInProject: 7 })), "[CUI-24] [team] Fix it");
  });

  it("differs from a legacy [YT-n] title that still finds the same issue, so the sync renames it (N2)", () => {
    const legacy = "[YT-7] [team] Fix it";
    const issue = makeIssue();
    assert.equal(parseMirrorTitle(legacy, PROJECT), issue.numberInProject);
    assert.equal(mirrorTitle(issue), "[CUI-7] [team] Fix it");
    assert.notEqual(mirrorTitle(issue), legacy);
    assert.equal(parseMirrorTitle(mirrorTitle(issue), PROJECT), issue.numberInProject);
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
