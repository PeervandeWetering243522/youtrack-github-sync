import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { nextPageUrl } from "../../src/github/link.ts";
import { schemaError } from "./fixtures.ts";

// nextPageUrl is what listAllPages calls for every issue and milestone page, so these tests cover production paging.
// Host checks and error-message redaction are in link-host.test.ts.

// ---------------------------------------------------------------------------
// nextPageUrl: RFC 8288 Link header parsing
// ---------------------------------------------------------------------------

describe("nextPageUrl", () => {
  it("returns null without a Link header", () => {
    assert.equal(nextPageUrl(null), null);
  });

  it("returns null for an empty or blank Link header", () => {
    assert.equal(nextPageUrl(""), null);
    assert.equal(nextPageUrl("   "), null);
  });

  it("returns null on the last page (only prev and first links)", () => {
    // Arrange
    const link =
      '<https://api.github.com/repositories/1/issues?page=1>; rel="prev", ' +
      '<https://api.github.com/repositories/1/issues?page=1>; rel="first"';

    // Act + Assert
    assert.equal(nextPageUrl(link), null);
  });

  it('returns null for a single rel="prev" entry', () => {
    assert.equal(nextPageUrl('<https://api.github.com/repositories/1/issues?page=1>; rel="prev"'), null);
  });

  it("returns the next URL verbatim from a typical GitHub header with several entries", () => {
    // Arrange
    const link =
      '<https://api.github.com/repositories/1/issues?state=all&per_page=100&page=1>; rel="prev", ' +
      '<https://api.github.com/repositories/1/issues?state=all&per_page=100&page=3>; rel="next", ' +
      '<https://api.github.com/repositories/1/issues?state=all&per_page=100&page=5>; rel="last", ' +
      '<https://api.github.com/repositories/1/issues?state=all&per_page=100&page=1>; rel="first"';

    // Act + Assert
    assert.equal(nextPageUrl(link), "https://api.github.com/repositories/1/issues?state=all&per_page=100&page=3");
  });

  it("finds next when it is the first entry", () => {
    const link = '<https://api.github.com/a?page=2>; rel="next", <https://api.github.com/a?page=9>; rel="last"';
    assert.equal(nextPageUrl(link), "https://api.github.com/a?page=2");
  });

  for (const rel of ["next last", "last next", "first  next\tlast"]) {
    it(`accepts next among several space-separated relation types (rel="${rel}")`, () => {
      assert.equal(nextPageUrl(`<https://api.github.com/p2>; rel="${rel}"`), "https://api.github.com/p2");
    });
  }

  it("does not match relation types that merely contain 'next'", () => {
    assert.equal(nextPageUrl('<https://api.github.com/p2>; rel="nextpage prev-next"'), null);
  });

  it("accepts an unquoted rel token and ignores case", () => {
    assert.equal(nextPageUrl("<https://api.github.com/p2>; rel=next"), "https://api.github.com/p2");
    assert.equal(nextPageUrl('<https://api.github.com/p2>; REL="Next"'), "https://api.github.com/p2");
  });

  it("tolerates extra params before and after rel and missing whitespace", () => {
    // Arrange
    const link = '<https://api.github.com/p2>;type="application/json";rel="next";title=page2;hreflang=en';

    // Act + Assert
    assert.equal(nextPageUrl(link), "https://api.github.com/p2");
  });

  it("uses only the first rel param of an entry (RFC 8288)", () => {
    assert.equal(nextPageUrl('<https://api.github.com/p2>; rel="prev"; rel="next"'), null);
  });

  it("keeps the first rel param when a later one disagrees", () => {
    assert.equal(nextPageUrl('<https://api.github.com/p2>; rel="next"; rel="prev"'), "https://api.github.com/p2");
  });

  for (const params of ['; rel; rel="next"', '; REL ; rel="next"', "; rel\t;rel=next"]) {
    it(`treats a value-less first rel as the only rel, ignoring a later rel="next" (${JSON.stringify(params)})`, () => {
      // Before the fix a value-less `rel` was skipped and the second rel param was used.
      assert.equal(nextPageUrl(`<https://api.github.com/p2>${params}`), null);
    });
  }

  it("skips value-less params that are not rel", () => {
    assert.equal(nextPageUrl('<https://api.github.com/p2>; crossorigin; rel="next"'), "https://api.github.com/p2");
  });

  it("does not treat single quotes as quoting (rel='next' is the token 'next' with quotes)", () => {
    assert.equal(nextPageUrl("<https://api.github.com/p2>; rel='next'"), null);
  });

  it("does not unquote a rel value whose quotes are themselves escaped", () => {
    assert.equal(nextPageUrl(String.raw`<https://api.github.com/p2>; rel="\"next\""`), null);
  });

  it("finds next when the Link field arrives as two header lines (Headers joins them with ', ')", () => {
    // Arrange
    const headers = new Headers();
    headers.append("Link", '<https://api.github.com/p1>; rel="prev"');
    headers.append("link", '<https://api.github.com/p3>; rel="next"');

    // Act + Assert
    assert.equal(nextPageUrl(headers.get("link")), "https://api.github.com/p3");
  });

  it("ignores empty list elements between entries", () => {
    assert.equal(nextPageUrl(' , ,<https://api.github.com/p2>; rel="next",, '), "https://api.github.com/p2");
  });

  it("ignores rel=next hidden inside a quoted param, even one containing commas and semicolons", () => {
    // Arrange
    const link =
      '<https://api.github.com/p1>; title="a, b; rel=next", ' +
      '<https://api.github.com/p2>; title="say \\"hi; rel=next\\""; rel="next"';

    // Act + Assert
    assert.equal(nextPageUrl(link), "https://api.github.com/p2");
  });

  it("keeps commas and semicolons inside the <URL>", () => {
    const link = '<https://api.github.com/search?q=a,b;c&page=2>; rel="next"';
    assert.equal(nextPageUrl(link), "https://api.github.com/search?q=a,b;c&page=2");
  });

  it("skips malformed entries and still finds a valid next link", () => {
    const link = 'garbage; rel="next", ; rel="next", <https://api.github.com/p2>; rel="next"';
    assert.equal(nextPageUrl(link), "https://api.github.com/p2");
  });

  it("returns null when an entry has no rel param at all", () => {
    assert.equal(nextPageUrl('<https://api.github.com/p2>; title="next"'), null);
  });

  it("parses GitHub's real cursor-style header (next + prev, %3D in the cursor) verbatim", () => {
    // Arrange: shape observed live in docs/03-github-rest-api.md section 2.
    const next =
      "https://api.github.com/repositories/1296269/issues?state=all&per_page=2&after=Y3Vyc29yOnYyOpLPAAABoNO8tbjPAAAAAUv4y2A%3D&page=3";
    const prev =
      "https://api.github.com/repositories/1296269/issues?state=all&per_page=2&page=1&before=Y3Vyc29yOnYyOpLPAAABoNQhS7jPAAAAAUwOoDs%3D";

    // Act + Assert
    assert.equal(nextPageUrl(`<${next}>; rel="next", <${prev}>; rel="prev"`), next);
    assert.equal(nextPageUrl(`<${prev}>; rel="prev", <${next}>; rel="next"`), next);
  });

  it("does not let a stray '<' in an unquoted param swallow the following entry", () => {
    const link = '<https://api.github.com/p1>; title=a<b, <https://api.github.com/p2>; rel="next"';
    assert.equal(nextPageUrl(link), "https://api.github.com/p2");
  });

  it("does not attribute a later rel=\"next\" to an earlier prev link after a stray '<'", () => {
    // Arrange: previously the prev URL p1 came back as "next", re-fetching an old page.
    const link = '<https://api.github.com/p1>; title=a<b; rel="prev", <https://api.github.com/p3>; rel="next"';

    // Act + Assert
    assert.equal(nextPageUrl(link), "https://api.github.com/p3");
  });

  it("treats a '\"' in the middle of a token as a plain character, not the start of a quoted string", () => {
    const link = '<https://api.github.com/p1>; title=a"b, <https://api.github.com/p2>; rel="next"';
    assert.equal(nextPageUrl(link), "https://api.github.com/p2");
  });

  it("keeps '<', '>' and ',' inside a quoted param value", () => {
    const link = '<https://api.github.com/p1>; title="<x, y>"; rel="prev", <https://api.github.com/p2>; rel="next"';
    assert.equal(nextPageUrl(link), "https://api.github.com/p2");
  });

  it("does not treat a '\"' inside the <URL> as the start of a quoted string", () => {
    const link = '<https://api.github.com/a"b,c>; rel="prev", <https://api.github.com/p2>; rel="next"';
    assert.equal(nextPageUrl(link), "https://api.github.com/p2");
  });

  it("accepts whitespace and tabs around ';' and '=' (RFC 8288 OWS/BWS)", () => {
    assert.equal(nextPageUrl('<https://api.github.com/p2>\t;\trel = "next"'), "https://api.github.com/p2");
    assert.equal(nextPageUrl("<https://api.github.com/p2> ; rel =\tnext"), "https://api.github.com/p2");
  });

  it("accepts an unquoted rel value directly followed by the next entry's comma", () => {
    const link = "<https://api.github.com/p2>;rel=next,<https://api.github.com/p9>;rel=last";
    assert.equal(nextPageUrl(link), "https://api.github.com/p2");
  });

  it("returns null for an empty rel value or a rel param without a value", () => {
    assert.equal(nextPageUrl('<https://api.github.com/p2>; rel=""'), null);
    assert.equal(nextPageUrl("<https://api.github.com/p2>; rel"), null);
  });

  it("throws, rather than treating it as the last page, for a rel param with '=' but no value", () => {
    assert.throws(() => nextPageUrl("<https://api.github.com/p2>; rel="), schemaError(/Link header does not parse/));
  });

  it("throws, rather than treating it as the last page, for an unterminated <URL>", () => {
    assert.throws(
      () => nextPageUrl('<https://api.github.com/p2; rel="next"'),
      schemaError(/Link header does not parse/),
    );
  });

  it("trims whitespace inside the angle brackets", () => {
    assert.equal(nextPageUrl('<  https://api.github.com/p2 >; rel="next"'), "https://api.github.com/p2");
  });

  it("returns the URL of an entry whose rel is quoted with escaped characters", () => {
    assert.equal(nextPageUrl('<https://api.github.com/p2>; rel="\\n\\ext"'), "https://api.github.com/p2");
  });

  it("parses a 400,000-character malformed header in linear time", { timeout: 5_000 }, () => {
    // Arrange: many stray quotes and angle brackets must not trigger backtracking or rescans.
    const noise = '"<'.repeat(200_000);
    const link = `<https://api.github.com/p1>; title=${noise}, <https://api.github.com/p2>; rel="next"`;

    // Act + Assert
    assert.equal(nextPageUrl(link), "https://api.github.com/p2");
  });
});

// ---------------------------------------------------------------------------
// nextPageUrl: a header without rel="next" must parse cleanly to count as the last page
// ---------------------------------------------------------------------------

const PREV = '<https://api.github.com/p1>; rel="prev"';
const DOES_NOT_PARSE = schemaError(/Link header does not parse/);

describe("nextPageUrl malformed headers", () => {
  for (const [what, link] of [
    [
      "an unclosed quote in an earlier entry hides the next entry",
      '<https://api.github.com/p1>; rel="prev, <https://api.github.com/p3>; rel="next"',
    ],
    [
      "a stray quote in a later param hides the next entry",
      `${PREV}; title="x, <https://api.github.com/p3>; rel="next"`,
    ],
    ["the header ends inside a quoted string", '<https://api.github.com/p1>; rel="prev'],
    ["the header ends inside a <URL>", `${PREV}, <https://api.github.com/p3; rel="next"`],
    ["an entry does not start with <URL>", `${PREV}, garbage; rel="next"`],
    ["a URL is not in angle brackets", 'https://api.github.com/p3; rel="next"'],
    ["text between '>' and the first ';'", '<https://api.github.com/p1>junk; rel="prev"'],
    ["text after a quoted value", '<https://api.github.com/p1>; rel="prev" junk'],
    ["the comma between two entries is missing", `${PREV} <https://api.github.com/p3>; rel="next"`],
    ["a param name that is not a token", `${PREV}; ti tle=x`],
    ["a param value that is neither a token nor a quoted string", `${PREV}; title=a<b`],
    ["an unterminated '<' inside the params", `${PREV}; <x`],
  ] as const) {
    it(`throws instead of reporting the last page when ${what}`, () => {
      assert.throws(() => nextPageUrl(link), DOES_NOT_PARSE);
    });
  }

  for (const link of [
    `${PREV};`,
    '<https://api.github.com/p1>;; rel="prev"',
    `${PREV}; title*=UTF-8''page%201; hreflang=en`,
    `${PREV}; crossorigin; title="a, b; <c>"`,
    `${PREV}; title="say \\"hi\\""`,
    `  ${PREV} ,, <https://api.github.com/p9>\t;\trel = last ,`,
  ]) {
    it(`returns null for the well-formed last-page header ${JSON.stringify(link)}`, () => {
      assert.equal(nextPageUrl(link), null);
    });
  }

  for (const [what, link] of [
    ["after it", '<https://api.github.com/p2>; rel="next", <https://api.github.com/p1>; rel="prev'],
    ["before it", 'garbage, <https://api.github.com/p2>; rel="next"'],
  ] as const) {
    it(`still follows a valid next link when another entry is malformed (${what})`, () => {
      // Pagination continues, so nothing is truncated; later pages are checked again.
      assert.equal(nextPageUrl(link), "https://api.github.com/p2");
    });
  }

  it("rejects a 400,000-character malformed header without next in linear time", { timeout: 5_000 }, () => {
    // Arrange: stray quotes, angle brackets and "@" (for the redaction) must not cause backtracking.
    const link = `${PREV}; title=${'"<@'.repeat(133_334)}`;

    // Act + Assert
    assert.throws(() => nextPageUrl(link), DOES_NOT_PARSE);
  });
});
