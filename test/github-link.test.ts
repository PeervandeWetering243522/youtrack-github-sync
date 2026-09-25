import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { nextPageUrl } from "../src/github.ts";

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

  it("returns null for a single rel=\"prev\" entry", () => {
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

  for (const params of ['; rel; rel="next"', '; REL ; rel="next"', '; rel\t;rel=next']) {
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
    assert.equal(nextPageUrl("<https://api.github.com/p2>; rel="), null);
  });

  it("returns null for an unterminated <URL>", () => {
    assert.equal(nextPageUrl('<https://api.github.com/p2; rel="next"'), null);
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
// nextPageUrl: only https://api.github.com/ targets are followed
// ---------------------------------------------------------------------------

const API_ORIGIN = "https://api.github.com";

function nextOf(url: string): string | null {
  return nextPageUrl(`<${url}>; rel="next"`);
}

describe("nextPageUrl host check", () => {
  for (const url of [
    "https://evil.example.com/repos/o/r/issues?page=2",
    "http://api.github.com/repos/o/r/issues?page=2",
    "https://api.github.com.evil.example/repos?page=2",
    "https://api.github.com@evil.example/repos?page=2",
    "https://api.github.com:8443/repos?page=2",
    "https://API.GITHUB.COM/repos?page=2",
    "HTTPS://api.github.com/repos?page=2",
    "https://api.github.com./repos?page=2",
    "https://api.github.com%2F@evil.example/repos?page=2",
    "https:/api.github.com/repos?page=2",
    "//api.github.com/repos?page=2",
    "https://api.github.com?page=2",
    "https://api.github.com#/repos",
    "https://api.github.com",
    "/repositories/1/issues?page=2",
    "",
  ]) {
    it(`rejects a next link outside https://api.github.com/ (${JSON.stringify(url)})`, () => {
      assert.equal(nextPageUrl(`<${url}>; rel="next"`), null);
    });
  }

  it("returns null when the first next link is foreign, without falling back to a later one", () => {
    const link = '<https://evil.example.com/p2>; rel="next", <https://api.github.com/p2>; rel="next"';
    assert.equal(nextPageUrl(link), null);
  });

  for (const url of ["https://api.github.com/@evil.example/p2", "https://api.github.com/../../evil.example/p2"]) {
    it(`accepts ${JSON.stringify(url)} because the host is still api.github.com`, () => {
      // Act
      const next = nextPageUrl(`<${url}>; rel="next"`);

      // Assert: the prefix ends with "/", so nothing after it can change the host.
      assert.equal(next, url);
      assert.equal(new URL(url).host, "api.github.com");
    });
  }

  it("rejects a backslash right after the host", () => {
    assert.equal(nextPageUrl('<https://api.github.com\\@evil.example/p2>; rel="next"'), null);
  });

  for (const url of [
    "https://user:pass@api.github.com/p2",
    "https://user@api.github.com/p2",
    "https://:secret@api.github.com/p2",
    "https://evil.example@api.github.com/p2",
  ]) {
    it(`rejects userinfo even when the parsed host is api.github.com (${JSON.stringify(url)})`, () => {
      // Arrange: prove the URL really parses to GitHub's origin, so only the userinfo is at fault.
      const parsed = URL.parse(url);
      assert.ok(parsed);
      assert.equal(parsed.origin, API_ORIGIN);
      assert.notEqual(`${parsed.username}${parsed.password}`, "");

      // Act + Assert
      assert.equal(nextOf(url), null);
    });
  }

  for (const url of [
    "https://api%2Egithub.com/p2",
    "https://api\u3002github.com/p2",
    "https://\uFF41\uFF50\uFF49.github.com/p2",
    "https://api.git\thub.com/p2",
    "https://api.github.com\n/p2",
    "https://api.github.com:443/p2",
    "https:\\\\api.github.com/p2",
    "https:api.github.com/p2",
    "https:///api.github.com/p2",
    "hTTps://api.github.com/p2",
    "\u0001https://api.github.com/p2",
  ]) {
    it(`rejects the non-canonical spelling ${JSON.stringify(url)} although it parses to api.github.com`, () => {
      // Arrange: the WHATWG parser maps each of these onto GitHub; only the exact spelling is followed.
      assert.equal(URL.parse(url)?.origin, API_ORIGIN);

      // Act + Assert
      assert.equal(nextOf(url), null);
    });
  }

  it("never yields a URL whose parsed origin is not https://api.github.com or that carries userinfo", () => {
    // Arrange: every combination of a tricky authority and a tricky path/suffix.
    const authorities = [
      "https://api.github.com",
      "https://api.github.com.",
      "https://api.github.com:443",
      "https://user@api.github.com",
      "https://api.github.com@evil.example",
      "https://api.github.com%2F@evil.example",
      "https://evil.example#@api.github.com",
      "https://evil.example?@api.github.com",
      "https://evil.example\\@api.github.com",
      "https:\\\\api.github.com",
      "https:api.github.com",
      "http://api.github.com",
    ];
    const suffixes = [
      "/p2",
      "/@evil.example/p2",
      "/../../evil.example/p2",
      "/%2e%2e/%2e%2e/evil.example",
      "//evil.example/p2",
      "/\\evil.example/p2",
      "/\t@evil.example/p2",
      "/?next=https://evil.example/",
      "/#@evil.example",
      "\\@evil.example/p2",
      "@evil.example/p2",
      ".evil.example/p2",
      ":8443/p2",
    ];
    const candidates = authorities.flatMap((authority) => suffixes.map((suffix) => `${authority}${suffix}`));

    // Act
    const accepted = candidates.flatMap((url) => {
      const next = nextOf(url);
      return next === null ? [] : [{ url, next }];
    });

    // Assert: something is accepted (the check is not vacuous), and everything accepted is safe.
    assert.ok(accepted.length > 0);
    for (const { url, next } of accepted) {
      assert.equal(next, url, "the URL is returned verbatim");
      const parsed = URL.parse(next);
      const context = `accepted ${JSON.stringify(next)}`;
      assert.ok(parsed, context);
      assert.equal(parsed.origin, API_ORIGIN, context);
      assert.equal(parsed.username, "", context);
      assert.equal(parsed.password, "", context);
    }
  });
});
