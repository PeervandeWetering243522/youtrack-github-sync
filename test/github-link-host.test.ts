import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GitHubSchemaError, nextPageUrl } from "../src/github.ts";
import { schemaError } from "./github-fixtures.ts";

// ---------------------------------------------------------------------------
// nextPageUrl: only https://api.github.com/ targets are followed; anything else throws
// (stopping instead would truncate the issue list and cause duplicate mirrors)
// ---------------------------------------------------------------------------

const API_ORIGIN = "https://api.github.com";
const OUTSIDE = schemaError(/rel="next" points outside https:\/\/api\.github\.com\//);

function nextOf(url: string): string | null {
  return nextPageUrl(`<${url}>; rel="next"`);
}

/** The message nextPageUrl throws for this Link header; fails the test if it does not throw a GitHubSchemaError. */
function errorMessageOf(linkHeader: string): string {
  try {
    nextPageUrl(linkHeader);
  } catch (error) {
    assert.ok(error instanceof GitHubSchemaError, `expected a GitHubSchemaError, got ${String(error)}`);
    return error.message;
  }
  assert.fail(`expected nextPageUrl to throw for ${JSON.stringify(linkHeader)}`);
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
    it(`throws on a next link outside https://api.github.com/ (${JSON.stringify(url)})`, () => {
      assert.throws(() => nextOf(url), OUTSIDE);
    });
  }

  it("throws when the first next link is foreign, without falling back to a later one", () => {
    const link = '<https://evil.example.com/p2>; rel="next", <https://api.github.com/p2>; rel="next"';
    assert.throws(() => nextPageUrl(link), OUTSIDE);
  });

  for (const url of ["https://api.github.com/@evil.example/p2", "https://api.github.com/../../evil.example/p2"]) {
    it(`accepts ${JSON.stringify(url)} because the host is still api.github.com`, () => {
      // Act
      const next = nextOf(url);

      // Assert: the prefix ends with "/", so nothing after it can change the host.
      assert.equal(next, url);
      assert.equal(new URL(url).host, "api.github.com");
    });
  }

  it("throws on a backslash right after the host", () => {
    assert.throws(() => nextPageUrl('<https://api.github.com\\@evil.example/p2>; rel="next"'), OUTSIDE);
  });

  for (const url of [
    "https://user:pass@api.github.com/p2",
    "https://user@api.github.com/p2",
    "https://:secret@api.github.com/p2",
    "https://evil.example@api.github.com/p2",
  ]) {
    it(`throws on userinfo even when the parsed host is api.github.com (${JSON.stringify(url)})`, () => {
      // Arrange: prove the URL really parses to GitHub's origin, so only the userinfo is at fault.
      const parsed = URL.parse(url);
      assert.ok(parsed);
      assert.equal(parsed.origin, API_ORIGIN);
      assert.notEqual(`${parsed.username}${parsed.password}`, "");

      // Act + Assert
      assert.throws(() => nextOf(url), OUTSIDE);
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
    it(`throws on the non-canonical spelling ${JSON.stringify(url)} although it parses to api.github.com`, () => {
      // Arrange: the WHATWG parser maps each of these onto GitHub; only the exact spelling is followed.
      assert.equal(URL.parse(url)?.origin, API_ORIGIN);

      // Act + Assert
      assert.throws(() => nextOf(url), OUTSIDE);
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

    // Act: a rejection is a GitHubSchemaError; anything else thrown fails the test.
    const accepted = candidates.flatMap((url) => {
      try {
        const next = nextOf(url);
        return next === null ? [] : [{ url, next }];
      } catch (error) {
        if (error instanceof GitHubSchemaError) {
          return [];
        }
        throw error;
      }
    });

    // Assert: something is accepted (the check is not vacuous), and everything accepted is safe.
    assert.ok(accepted.length > 0);
    assert.ok(accepted.length < candidates.length);
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

// ---------------------------------------------------------------------------
// nextPageUrl: error messages quote at most 40 characters and never echo userinfo
// ---------------------------------------------------------------------------

describe("nextPageUrl error messages", () => {
  it("quotes the start of a rejected next URL so the log shows where it pointed", () => {
    const message = errorMessageOf('<https://evil.example.com/steal>; rel="next"');
    assert.ok(message.includes('"https://evil.example.com/steal"'), message);
  });

  for (const url of [
    "https://user:s3cr3t@api.github.com/p2",
    "https://s3cr3t@evil.example/p2",
    "https://:s3cr3t@evil.example/p2",
    "https:s3cr3t@evil.example/p2",
    "https://s3cr3t@other@evil.example/p2",
    "https://s3cr3t:x@evil.example?q=1",
    "https://s3cr3t:x@evil.example#frag",
    "https://evil.example\\s3cr3t@api.github.com/p2",
    "foo://user\\s3cr3t@evil.example/p2",
  ]) {
    it(`does not echo the userinfo of a rejected next URL ${JSON.stringify(url)}`, () => {
      // Act
      const message = errorMessageOf(`<${url}>; rel="next"`);

      // Assert
      assert.ok(!message.includes("s3cr3t"), message);
      assert.ok(message.includes("***@"), message);
    });
  }

  it("removes userinfo before cutting to 40 characters, so a long secret is not half-echoed", () => {
    // Arrange: cutting first would keep "https://user:ssss..." with no "@" left to find.
    const url = `https://user:${"s".repeat(60)}@evil.example/p2`;

    // Act
    const message = errorMessageOf(`<${url}>; rel="next"`);

    // Assert
    assert.ok(!message.includes("user:"), message);
    assert.ok(!message.includes("sssss"), message);
    assert.ok(message.includes('"https://***@evil.example/p2"'), message);
  });

  it("does not echo userinfo from a Link header that does not parse", () => {
    // Arrange: an unterminated <URL> carrying credentials.
    const link = '<https://user:s3cr3t@evil.example/p2; rel="next"';

    // Act
    const message = errorMessageOf(link);

    // Assert
    assert.match(message, /Link header does not parse/);
    assert.ok(!message.includes("s3cr3t"), message);
    assert.ok(!message.includes("user:"), message);
  });

  it("hides userinfo of every URL in a Link header that does not parse, not only the first", () => {
    // Arrange: the second URL's credentials fall inside the 40 quoted characters.
    const link = '<https://a:s3cr3t@x/>, <https://b:t0ps3cr3t@y/; rel="prev"';

    // Act
    const message = errorMessageOf(link);

    // Assert
    assert.match(message, /Link header does not parse/);
    assert.ok(!message.includes("s3cr3t"), message);
    assert.ok(!message.includes("t0p"), message);
    assert.ok(message.includes('"<https://***@x/>, <https://***@y/;'), message);
  });

  it("quotes at most 40 characters of a Link header that does not parse", () => {
    // Arrange
    const link = `<https://api.github.com/${"a".repeat(500)}>; rel="prev`;

    // Act
    const message = errorMessageOf(link);

    // Assert
    assert.ok(message.includes(JSON.stringify(link.slice(0, 40))), message);
    assert.ok(!message.includes(link.slice(0, 41)), message);
  });
});
