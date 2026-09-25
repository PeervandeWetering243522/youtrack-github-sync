import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GITHUB_API_VERSION,
  GitHubSchemaError,
  addLabel,
  closeIssue,
  createIssue,
  githubHeaders,
  listAllIssues,
  nextPageUrl,
  parseGitHubIssue,
} from "../src/github.ts";
import type { CreateIssueBody, GitHubIssue, GitHubTarget } from "../src/github.ts";
import { HttpError } from "../src/http.ts";
import type { HttpClient, HttpRequest, HttpResponse } from "../src/http.ts";
import { parseJson } from "../src/json.ts";
import type { JsonObject, JsonValue } from "../src/json.ts";

// node:test's describe/it return promises that the runner itself tracks; `void`
// marks them as handled for no-floating-promises without disabling the rule.

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOKEN = "ghp_test-token";
const TARGET: GitHubTarget = { owner: "BredaUniversityADSAI", repo: "mirror-repo", token: TOKEN };
const FAKE_MAX_FETCHES = 45;

/** URLs spelled out independently of the implementation. */
const ISSUES_URL = "https://api.github.com/repos/BredaUniversityADSAI/mirror-repo/issues";
const FIRST_PAGE_URL = `${ISSUES_URL}?state=all&per_page=100`;
/** GitHub's own page links use the numeric repository id. */
const SECOND_PAGE_URL = "https://api.github.com/repositories/123456/issues?state=all&per_page=100&page=2";

const EXPECTED_HEADERS = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${TOKEN}`,
  "X-GitHub-Api-Version": GITHUB_API_VERSION,
} as const;

function issueJson(fields: JsonObject = {}): JsonObject {
  return { number: 1, title: "[YT-1] First", state: "open", labels: [], ...fields };
}

function withoutKey(value: JsonObject, key: string): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

function schemaError(message: RegExp): { readonly name: string; readonly message: RegExp } {
  return { name: "GitHubSchemaError", message };
}

// ---------------------------------------------------------------------------
// Fake HttpClient: records every request, answers with canned responses
// ---------------------------------------------------------------------------

type CannedResponse = { readonly body: JsonValue; readonly link?: string; readonly status?: number };

type FakeHttp = {
  readonly http: HttpClient;
  readonly requests: readonly HttpRequest[];
};

/** Answers request n with `responses[n]`, or with `failure` once the canned responses run out. */
function createFakeHttp(responses: readonly CannedResponse[], failure?: Error): FakeHttp {
  const requests: HttpRequest[] = [];
  const http: HttpClient = {
    request: (request) => {
      requests.push(request);
      const canned = responses[requests.length - 1];
      if (canned === undefined) {
        return Promise.reject(failure ?? new Error(`unexpected request #${String(requests.length)}`));
      }
      return Promise.resolve(toResponse(canned));
    },
    fetchCount: () => requests.length,
    remainingFetches: () => FAKE_MAX_FETCHES - requests.length,
  };
  return { http, requests };
}

function toResponse(canned: CannedResponse): HttpResponse {
  const headers = new Headers(canned.link === undefined ? {} : { link: canned.link });
  return { status: canned.status ?? 200, headers, body: canned.body };
}

function requestAt(requests: readonly HttpRequest[], index: number): HttpRequest {
  const request = requests[index];
  assert.ok(request, `expected request #${String(index + 1)}`);
  return request;
}

function httpError(status: number): HttpError {
  return new HttpError("POST", ISSUES_URL, status, '{"message":"Validation Failed"}');
}

// ---------------------------------------------------------------------------
// githubHeaders
// ---------------------------------------------------------------------------

void describe("githubHeaders", () => {
  void it("returns exactly Accept, Bearer Authorization and the pinned API version", () => {
    // Act
    const headers = githubHeaders(TOKEN);

    // Assert
    assert.deepEqual(headers, EXPECTED_HEADERS);
  });

  void it("pins API version 2026-03-10", () => {
    assert.equal(githubHeaders(TOKEN)["X-GitHub-Api-Version"], "2026-03-10");
  });

  void it("embeds the token verbatim after 'Bearer ' and adds no Content-Type or User-Agent", () => {
    // Act
    const headers = githubHeaders("github_pat_11A+/=x");

    // Assert
    assert.equal(headers["Authorization"], "Bearer github_pat_11A+/=x");
    assert.deepEqual(Object.keys(headers).sort(), ["Accept", "Authorization", "X-GitHub-Api-Version"]);
  });

  void it("returns a fresh object on every call", () => {
    assert.notEqual(githubHeaders(TOKEN), githubHeaders(TOKEN));
  });
});

// ---------------------------------------------------------------------------
// parseGitHubIssue
// ---------------------------------------------------------------------------

void describe("parseGitHubIssue", () => {
  void it("parses an open issue into the minimal typed shape", () => {
    // Arrange
    const raw = issueJson({ number: 42, title: "[YT-7] Fix it", body: "ignored", id: 999, labels: ["youtrack"] });

    // Act
    const issue = parseGitHubIssue(raw);

    // Assert
    const expected: GitHubIssue = {
      number: 42,
      title: "[YT-7] Fix it",
      state: "open",
      labelNames: ["youtrack"],
      isPullRequest: false,
    };
    assert.deepEqual(issue, expected);
  });

  void it("parses a closed issue", () => {
    assert.equal(parseGitHubIssue(issueJson({ state: "closed" })).state, "closed");
  });

  void it("accepts an empty title", () => {
    assert.equal(parseGitHubIssue(issueJson({ title: "" })).title, "");
  });

  void it("reads label names from both string and object label forms, in order", () => {
    // Arrange
    const labels: JsonValue = ["plain", { id: 1, name: "youtrack", color: "6f42c1", description: null }, "bug"];

    // Act
    const issue = parseGitHubIssue(issueJson({ labels }));

    // Assert
    assert.deepEqual(issue.labelNames, ["plain", "youtrack", "bug"]);
  });

  void it("ignores label items that are neither strings nor objects with a string name", () => {
    // Arrange
    const labels: JsonValue = [null, 3, true, ["nested"], {}, { name: null }, { name: 5 }, { id: 2 }, { name: "kept" }];

    // Act
    const issue = parseGitHubIssue(issueJson({ labels }));

    // Assert
    assert.deepEqual(issue.labelNames, ["kept"]);
  });

  void it("flags items with a non-null pull_request object as pull requests", () => {
    const raw = issueJson({ pull_request: { url: "https://api.github.com/repos/o/r/pulls/1", merged_at: null } });
    assert.equal(parseGitHubIssue(raw).isPullRequest, true);
  });

  void it("treats a missing pull_request key as a plain issue", () => {
    assert.equal(parseGitHubIssue(issueJson()).isPullRequest, false);
  });

  void it("treats a null pull_request value as a plain issue", () => {
    assert.equal(parseGitHubIssue(issueJson({ pull_request: null })).isPullRequest, false);
  });

  void it("leaves the input object untouched", () => {
    // Arrange
    const raw = issueJson({ labels: ["a", { name: "b" }] });
    const snapshot = structuredClone(raw);

    // Act
    parseGitHubIssue(raw);

    // Assert
    assert.deepEqual(raw, snapshot);
  });

  for (const [kind, value] of [
    ["array", []],
    ["null", null],
    ["string", "issue"],
    ["number", 1],
    ["boolean", true],
  ] as const) {
    void it(`rejects a value that is a JSON ${kind}`, () => {
      assert.throws(() => parseGitHubIssue(value), schemaError(/must be a JSON object/));
    });
  }

  void it("rejects an object without a number", () => {
    assert.throws(() => parseGitHubIssue(withoutKey(issueJson(), "number")), schemaError(/"number".*got nothing/));
  });

  for (const value of [0, -3, 1.5, 2 ** 53, "12", null]) {
    void it(`rejects number = ${JSON.stringify(value)}`, () => {
      assert.throws(() => parseGitHubIssue(issueJson({ number: value })), schemaError(/"number" must be a positive integer/));
    });
  }

  for (const value of [null, 12, ["t"]]) {
    void it(`rejects title = ${JSON.stringify(value)} and names the issue number`, () => {
      assert.throws(
        () => parseGitHubIssue(issueJson({ number: 9, title: value })),
        schemaError(/#9: "title" must be a string/),
      );
    });
  }

  void it("rejects a missing title", () => {
    assert.throws(() => parseGitHubIssue(withoutKey(issueJson(), "title")), schemaError(/"title" must be a string/));
  });

  for (const value of ["OPEN", "Closed", "merged", "open ", " closed", "", null, 1, ["open"]]) {
    void it(`rejects state = ${JSON.stringify(value)}`, () => {
      assert.throws(
        () => parseGitHubIssue(issueJson({ number: 5, state: value })),
        schemaError(/#5: "state" must be "open" or "closed"/),
      );
    });
  }

  void it("rejects a missing state", () => {
    assert.throws(() => parseGitHubIssue(withoutKey(issueJson(), "state")), schemaError(/"state".*got nothing/));
  });

  void it("quotes at most 40 characters of an unexpected state string", () => {
    // Arrange
    const longState = "x".repeat(500);

    // Act + Assert
    assert.throws(
      () => parseGitHubIssue(issueJson({ state: longState })),
      (error: Error) => error.message.includes(`"${"x".repeat(40)}"`) && !error.message.includes("x".repeat(41)),
    );
  });

  for (const value of [null, "youtrack", { name: "youtrack" }]) {
    void it(`rejects labels = ${JSON.stringify(value)}`, () => {
      assert.throws(
        () => parseGitHubIssue(issueJson({ number: 3, labels: value })),
        schemaError(/#3: "labels" must be an array/),
      );
    });
  }

  void it("rejects a missing labels key", () => {
    assert.throws(() => parseGitHubIssue(withoutKey(issueJson(), "labels")), schemaError(/"labels" must be an array/));
  });

  void it("throws an instance of GitHubSchemaError (an Error subclass)", () => {
    assert.throws(
      () => parseGitHubIssue(null),
      (error: Error) => error instanceof GitHubSchemaError && error.name === "GitHubSchemaError",
    );
  });

  void it("rejects number = -0", () => {
    assert.throws(() => parseGitHubIssue(issueJson({ number: -0 })), schemaError(/"number" must be a positive integer/));
  });

  void it("accepts the largest safe integer as number and a JSON 3.0 as 3", () => {
    assert.equal(parseGitHubIssue(issueJson({ number: Number.MAX_SAFE_INTEGER })).number, Number.MAX_SAFE_INTEGER);
    assert.equal(parseGitHubIssue(parseJson('{"number":3.0,"title":"t","state":"open","labels":[]}')).number, 3);
  });

  for (const [value, description] of [
    [true, "got boolean true"],
    [[1], "got an array"],
    [{ n: 1 }, "got an object"],
    [null, "got null"],
    ["12", 'got string "12"'],
    [1.5, "got number 1.5"],
  ] as const) {
    void it(`describes a bad number ${JSON.stringify(value)} as "${description}"`, () => {
      assert.throws(
        () => parseGitHubIssue(issueJson({ number: value })),
        (error: Error) => error.message.endsWith(description),
      );
    });
  }

  void it("describes a non-object issue by its JSON kind", () => {
    assert.throws(() => parseGitHubIssue([]), schemaError(/must be a JSON object, got an array$/));
    assert.throws(() => parseGitHubIssue("x"), schemaError(/must be a JSON object, got string "x"$/));
  });

  void it("cuts an echoed string on a code point boundary, never leaving half an emoji", () => {
    // Arrange: 51 code points; the first 40 are "a" + 39 emoji. A 40-unit UTF-16 slice would end mid-emoji.
    const state = `a${"😀".repeat(50)}`;

    // Act + Assert
    assert.throws(
      () => parseGitHubIssue(issueJson({ state })),
      (error: Error) => error.message.endsWith(`got string "a${"😀".repeat(39)}"`) && !error.message.includes("\\ud"),
    );
  });

  void it("escapes control characters of an echoed string, so a log line cannot be split", () => {
    assert.throws(
      () => parseGitHubIssue(issueJson({ state: "open\nFAKE LOG LINE" })),
      (error: Error) => !error.message.includes("\n") && error.message.includes(String.raw`"open\nFAKE LOG LINE"`),
    );
  });

  void it("treats a present, non-null pull_request of any JSON type as a pull request", () => {
    const values: readonly JsonValue[] = [{}, false, 0, "", []];
    for (const pullRequest of values) {
      assert.equal(parseGitHubIssue(issueJson({ pull_request: pullRequest })).isPullRequest, true);
    }
  });

  void it("keeps label names verbatim: case, whitespace, unicode, duplicates and empty names", () => {
    // Arrange
    const labels: JsonValue = ["YouTrack", " youtrack ", { name: "ü 😀" }, "youtrack", "youtrack", { name: "" }];

    // Act
    const issue = parseGitHubIssue(issueJson({ labels }));

    // Assert
    assert.deepEqual(issue.labelNames, ["YouTrack", " youtrack ", "ü 😀", "youtrack", "youtrack", ""]);
  });

  void it("is not fooled by __proto__ keys from JSON.parse", () => {
    // Arrange: JSON.parse creates own "__proto__" properties; nothing may be read through them.
    const raw = parseJson(
      '{"number":1,"title":"t","state":"open","labels":[{"__proto__":{"name":"youtrack"}}],"__proto__":{"pull_request":{}}}',
    );

    // Act
    const issue = parseGitHubIssue(raw);

    // Assert
    assert.equal(issue.isPullRequest, false);
    assert.deepEqual(issue.labelNames, []);
    const fresh: JsonObject = {};
    assert.equal(fresh["pull_request"], undefined);
  });

  void it("keeps a long or oddly encoded title verbatim (no trimming, truncation or normalisation)", () => {
    // Arrange: 300 astral code points, a lone surrogate from a JSON escape and surrounding spaces.
    const raw = parseJson(`{"number":1,"title":" [YT-1] ${"😀".repeat(300)} \\ud800 e\\u0301 ","state":"open","labels":[]}`);

    // Act
    const issue = parseGitHubIssue(raw);

    // Assert
    assert.equal(issue.title, ` [YT-1] ${"😀".repeat(300)} \uD800 é `);
  });

  void it("returns a new labelNames array that does not alias the input labels", () => {
    // Arrange
    const labels: JsonValue = ["a", "b"];

    // Act
    const issue = parseGitHubIssue(issueJson({ labels }));

    // Assert
    assert.notEqual(issue.labelNames, labels);
  });
});

// ---------------------------------------------------------------------------
// nextPageUrl
// ---------------------------------------------------------------------------

void describe("nextPageUrl", () => {
  void it("returns null without a Link header", () => {
    assert.equal(nextPageUrl(null), null);
  });

  void it("returns null for an empty or blank Link header", () => {
    assert.equal(nextPageUrl(""), null);
    assert.equal(nextPageUrl("   "), null);
  });

  void it("returns null on the last page (only prev and first links)", () => {
    // Arrange
    const link =
      '<https://api.github.com/repositories/1/issues?page=1>; rel="prev", ' +
      '<https://api.github.com/repositories/1/issues?page=1>; rel="first"';

    // Act + Assert
    assert.equal(nextPageUrl(link), null);
  });

  void it("returns null for a single rel=\"prev\" entry", () => {
    assert.equal(nextPageUrl('<https://api.github.com/repositories/1/issues?page=1>; rel="prev"'), null);
  });

  void it("returns the next URL verbatim from a typical GitHub header with several entries", () => {
    // Arrange
    const link =
      '<https://api.github.com/repositories/1/issues?state=all&per_page=100&page=1>; rel="prev", ' +
      '<https://api.github.com/repositories/1/issues?state=all&per_page=100&page=3>; rel="next", ' +
      '<https://api.github.com/repositories/1/issues?state=all&per_page=100&page=5>; rel="last", ' +
      '<https://api.github.com/repositories/1/issues?state=all&per_page=100&page=1>; rel="first"';

    // Act + Assert
    assert.equal(nextPageUrl(link), "https://api.github.com/repositories/1/issues?state=all&per_page=100&page=3");
  });

  void it("finds next when it is the first entry", () => {
    const link = '<https://api.github.com/a?page=2>; rel="next", <https://api.github.com/a?page=9>; rel="last"';
    assert.equal(nextPageUrl(link), "https://api.github.com/a?page=2");
  });

  for (const rel of ["next last", "last next", "first  next\tlast"]) {
    void it(`accepts next among several space-separated relation types (rel="${rel}")`, () => {
      assert.equal(nextPageUrl(`<https://api.github.com/p2>; rel="${rel}"`), "https://api.github.com/p2");
    });
  }

  void it("does not match relation types that merely contain 'next'", () => {
    assert.equal(nextPageUrl('<https://api.github.com/p2>; rel="nextpage prev-next"'), null);
  });

  void it("accepts an unquoted rel token and ignores case", () => {
    assert.equal(nextPageUrl("<https://api.github.com/p2>; rel=next"), "https://api.github.com/p2");
    assert.equal(nextPageUrl('<https://api.github.com/p2>; REL="Next"'), "https://api.github.com/p2");
  });

  void it("tolerates extra params before and after rel and missing whitespace", () => {
    // Arrange
    const link = '<https://api.github.com/p2>;type="application/json";rel="next";title=page2;hreflang=en';

    // Act + Assert
    assert.equal(nextPageUrl(link), "https://api.github.com/p2");
  });

  void it("uses only the first rel param of an entry (RFC 8288)", () => {
    assert.equal(nextPageUrl('<https://api.github.com/p2>; rel="prev"; rel="next"'), null);
  });

  void it("keeps the first rel param when a later one disagrees", () => {
    assert.equal(nextPageUrl('<https://api.github.com/p2>; rel="next"; rel="prev"'), "https://api.github.com/p2");
  });

  for (const params of ['; rel; rel="next"', '; REL ; rel="next"', '; rel\t;rel=next']) {
    void it(`treats a value-less first rel as the only rel, ignoring a later rel="next" (${JSON.stringify(params)})`, () => {
      // Before the fix a value-less `rel` was skipped and the second rel param was used.
      assert.equal(nextPageUrl(`<https://api.github.com/p2>${params}`), null);
    });
  }

  void it("skips value-less params that are not rel", () => {
    assert.equal(nextPageUrl('<https://api.github.com/p2>; crossorigin; rel="next"'), "https://api.github.com/p2");
  });

  void it("does not treat single quotes as quoting (rel='next' is the token 'next' with quotes)", () => {
    assert.equal(nextPageUrl("<https://api.github.com/p2>; rel='next'"), null);
  });

  void it("does not unquote a rel value whose quotes are themselves escaped", () => {
    assert.equal(nextPageUrl(String.raw`<https://api.github.com/p2>; rel="\"next\""`), null);
  });

  void it("finds next when the Link field arrives as two header lines (Headers joins them with ', ')", () => {
    // Arrange
    const headers = new Headers();
    headers.append("Link", '<https://api.github.com/p1>; rel="prev"');
    headers.append("link", '<https://api.github.com/p3>; rel="next"');

    // Act + Assert
    assert.equal(nextPageUrl(headers.get("link")), "https://api.github.com/p3");
  });

  void it("ignores empty list elements between entries", () => {
    assert.equal(nextPageUrl(' , ,<https://api.github.com/p2>; rel="next",, '), "https://api.github.com/p2");
  });

  void it("ignores rel=next hidden inside a quoted param, even one containing commas and semicolons", () => {
    // Arrange
    const link =
      '<https://api.github.com/p1>; title="a, b; rel=next", ' +
      '<https://api.github.com/p2>; title="say \\"hi; rel=next\\""; rel="next"';

    // Act + Assert
    assert.equal(nextPageUrl(link), "https://api.github.com/p2");
  });

  void it("keeps commas and semicolons inside the <URL>", () => {
    const link = '<https://api.github.com/search?q=a,b;c&page=2>; rel="next"';
    assert.equal(nextPageUrl(link), "https://api.github.com/search?q=a,b;c&page=2");
  });

  void it("skips malformed entries and still finds a valid next link", () => {
    const link = 'garbage; rel="next", ; rel="next", <https://api.github.com/p2>; rel="next"';
    assert.equal(nextPageUrl(link), "https://api.github.com/p2");
  });

  void it("returns null when an entry has no rel param at all", () => {
    assert.equal(nextPageUrl('<https://api.github.com/p2>; title="next"'), null);
  });

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
    void it(`rejects a next link outside https://api.github.com/ (${JSON.stringify(url)})`, () => {
      assert.equal(nextPageUrl(`<${url}>; rel="next"`), null);
    });
  }

  void it("returns null when the first next link is foreign, without falling back to a later one", () => {
    const link = '<https://evil.example.com/p2>; rel="next", <https://api.github.com/p2>; rel="next"';
    assert.equal(nextPageUrl(link), null);
  });

  void it("parses GitHub's real cursor-style header (next + prev, %3D in the cursor) verbatim", () => {
    // Arrange: shape observed live in docs/03-github-rest-api.md section 2.
    const next =
      "https://api.github.com/repositories/1296269/issues?state=all&per_page=2&after=Y3Vyc29yOnYyOpLPAAABoNO8tbjPAAAAAUv4y2A%3D&page=3";
    const prev =
      "https://api.github.com/repositories/1296269/issues?state=all&per_page=2&page=1&before=Y3Vyc29yOnYyOpLPAAABoNQhS7jPAAAAAUwOoDs%3D";

    // Act + Assert
    assert.equal(nextPageUrl(`<${next}>; rel="next", <${prev}>; rel="prev"`), next);
    assert.equal(nextPageUrl(`<${prev}>; rel="prev", <${next}>; rel="next"`), next);
  });

  void it("does not let a stray '<' in an unquoted param swallow the following entry", () => {
    const link = '<https://api.github.com/p1>; title=a<b, <https://api.github.com/p2>; rel="next"';
    assert.equal(nextPageUrl(link), "https://api.github.com/p2");
  });

  void it("does not attribute a later rel=\"next\" to an earlier prev link after a stray '<'", () => {
    // Arrange: previously the prev URL p1 came back as "next", re-fetching an old page.
    const link = '<https://api.github.com/p1>; title=a<b; rel="prev", <https://api.github.com/p3>; rel="next"';

    // Act + Assert
    assert.equal(nextPageUrl(link), "https://api.github.com/p3");
  });

  void it("treats a '\"' in the middle of a token as a plain character, not the start of a quoted string", () => {
    const link = '<https://api.github.com/p1>; title=a"b, <https://api.github.com/p2>; rel="next"';
    assert.equal(nextPageUrl(link), "https://api.github.com/p2");
  });

  void it("keeps '<', '>' and ',' inside a quoted param value", () => {
    const link = '<https://api.github.com/p1>; title="<x, y>"; rel="prev", <https://api.github.com/p2>; rel="next"';
    assert.equal(nextPageUrl(link), "https://api.github.com/p2");
  });

  void it("does not treat a '\"' inside the <URL> as the start of a quoted string", () => {
    const link = '<https://api.github.com/a"b,c>; rel="prev", <https://api.github.com/p2>; rel="next"';
    assert.equal(nextPageUrl(link), "https://api.github.com/p2");
  });

  void it("accepts whitespace and tabs around ';' and '=' (RFC 8288 OWS/BWS)", () => {
    assert.equal(nextPageUrl('<https://api.github.com/p2>\t;\trel = "next"'), "https://api.github.com/p2");
    assert.equal(nextPageUrl("<https://api.github.com/p2> ; rel =\tnext"), "https://api.github.com/p2");
  });

  void it("accepts an unquoted rel value directly followed by the next entry's comma", () => {
    const link = "<https://api.github.com/p2>;rel=next,<https://api.github.com/p9>;rel=last";
    assert.equal(nextPageUrl(link), "https://api.github.com/p2");
  });

  void it("returns null for an empty rel value or a rel param without a value", () => {
    assert.equal(nextPageUrl('<https://api.github.com/p2>; rel=""'), null);
    assert.equal(nextPageUrl("<https://api.github.com/p2>; rel"), null);
    assert.equal(nextPageUrl("<https://api.github.com/p2>; rel="), null);
  });

  void it("returns null for an unterminated <URL>", () => {
    assert.equal(nextPageUrl('<https://api.github.com/p2; rel="next"'), null);
  });

  void it("trims whitespace inside the angle brackets", () => {
    assert.equal(nextPageUrl('<  https://api.github.com/p2 >; rel="next"'), "https://api.github.com/p2");
  });

  void it("returns the URL of an entry whose rel is quoted with escaped characters", () => {
    assert.equal(nextPageUrl('<https://api.github.com/p2>; rel="\\n\\ext"'), "https://api.github.com/p2");
  });

  for (const url of ["https://api.github.com/@evil.example/p2", "https://api.github.com/../../evil.example/p2"]) {
    void it(`accepts ${JSON.stringify(url)} because the host is still api.github.com`, () => {
      // Act
      const next = nextPageUrl(`<${url}>; rel="next"`);

      // Assert: the prefix ends with "/", so nothing after it can change the host.
      assert.equal(next, url);
      assert.equal(new URL(url).host, "api.github.com");
    });
  }

  void it("rejects a backslash right after the host", () => {
    assert.equal(nextPageUrl('<https://api.github.com\\@evil.example/p2>; rel="next"'), null);
  });

  void it("parses a 400,000-character malformed header in linear time", { timeout: 5_000 }, () => {
    // Arrange: many stray quotes and angle brackets must not trigger backtracking or rescans.
    const noise = '"<'.repeat(200_000);
    const link = `<https://api.github.com/p1>; title=${noise}, <https://api.github.com/p2>; rel="next"`;

    // Act + Assert
    assert.equal(nextPageUrl(link), "https://api.github.com/p2");
  });
});

// ---------------------------------------------------------------------------
// listAllIssues
// ---------------------------------------------------------------------------

void describe("listAllIssues", () => {
  void it("GETs the unfiltered first page with GitHub headers and retry-once", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: [issueJson()] }]);

    // Act
    await listAllIssues(fake.http, TARGET);

    // Assert
    assert.equal(fake.requests.length, 1);
    const request = requestAt(fake.requests, 0);
    assert.equal(request.method, "GET");
    assert.equal(request.url, FIRST_PAGE_URL);
    assert.deepEqual(request.headers, EXPECTED_HEADERS);
    assert.equal(request.retry, "retry-once");
    assert.equal("body" in request, false);
  });

  void it("percent-encodes owner and repo in the path", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: [] }]);
    const target: GitHubTarget = { owner: "my org", repo: "a/b#c?d", token: TOKEN };

    // Act
    await listAllIssues(fake.http, target);

    // Assert
    assert.equal(
      requestAt(fake.requests, 0).url,
      "https://api.github.com/repos/my%20org/a%2Fb%23c%3Fd/issues?state=all&per_page=100",
    );
  });

  void it("returns an empty list for an empty repository", async () => {
    const fake = createFakeHttp([{ body: [] }]);
    assert.deepEqual(await listAllIssues(fake.http, TARGET), []);
  });

  void it("follows Link rel=\"next\" verbatim across two pages and keeps order, PRs flagged", async () => {
    // Arrange
    const fake = createFakeHttp([
      {
        body: [issueJson({ number: 30, title: "[YT-3] c", labels: ["youtrack"] }), issueJson({ number: 29, pull_request: {} })],
        link: `<${SECOND_PAGE_URL}>; rel="next", <${SECOND_PAGE_URL}>; rel="last"`,
      },
      {
        body: [issueJson({ number: 2, title: "[YT-1] a", state: "closed", labels: [{ name: "youtrack" }] })],
        link: `<${FIRST_PAGE_URL}>; rel="prev", <${FIRST_PAGE_URL}>; rel="first"`,
      },
    ]);

    // Act
    const issues = await listAllIssues(fake.http, TARGET);

    // Assert
    assert.deepEqual(
      fake.requests.map((request) => request.url),
      [FIRST_PAGE_URL, SECOND_PAGE_URL],
    );
    assert.ok(fake.requests.every((request) => request.method === "GET" && request.retry === "retry-once"));
    assert.deepEqual(issues, [
      { number: 30, title: "[YT-3] c", state: "open", labelNames: ["youtrack"], isPullRequest: false },
      { number: 29, title: "[YT-1] First", state: "open", labelNames: [], isPullRequest: true },
      { number: 2, title: "[YT-1] a", state: "closed", labelNames: ["youtrack"], isPullRequest: false },
    ]);
  });

  void it("throws instead of silently stopping when rel=next points to a foreign host", async () => {
    // Arrange: a truncated list would hide existing mirrors and make sync create duplicates.
    const fake = createFakeHttp([{ body: [issueJson()], link: '<https://evil.example.com/steal>; rel="next"' }]);

    // Act + Assert
    await assert.rejects(
      listAllIssues(fake.http, TARGET),
      schemaError(/rel="next" points outside https:\/\/api\.github\.com\/: "https:\/\/evil\.example\.com\/steal"/),
    );
    assert.equal(fake.requests.length, 1);
  });

  for (const url of ["", "/repositories/1/issues?page=2", "http://api.github.com/repositories/1/issues?page=2"]) {
    void it(`throws on an untrusted rel=next URL ${JSON.stringify(url)} without requesting it`, async () => {
      const fake = createFakeHttp([{ body: [issueJson()], link: `<${url}>; rel="next"` }]);
      await assert.rejects(listAllIssues(fake.http, TARGET), schemaError(/points outside/));
      assert.equal(fake.requests.length, 1);
    });
  }

  void it("quotes at most 40 characters of a rejected next URL", async () => {
    // Arrange
    const longUrl = `https://evil.example.com/${"a".repeat(500)}`;
    const fake = createFakeHttp([{ body: [], link: `<${longUrl}>; rel="next"` }]);

    // Act + Assert
    await assert.rejects(
      listAllIssues(fake.http, TARGET),
      (error: Error) => error.message.includes(`"${longUrl.slice(0, 40)}"`) && !error.message.includes(longUrl.slice(0, 41)),
    );
  });

  void it("sends GitHub headers and retry-once on every page, not just the first", async () => {
    // Arrange
    const fake = createFakeHttp([
      { body: [issueJson({ number: 2 })], link: `<${SECOND_PAGE_URL}>; rel="next"` },
      { body: [issueJson({ number: 1 })] },
    ]);

    // Act
    await listAllIssues(fake.http, TARGET);

    // Assert
    const second = requestAt(fake.requests, 1);
    assert.deepEqual(second.headers, EXPECTED_HEADERS);
    assert.equal(second.retry, "retry-once");
    assert.equal("body" in second, false);
  });

  void it("follows three pages, including an empty middle page, in order", async () => {
    // Arrange
    const thirdPageUrl = "https://api.github.com/repositories/123456/issues?state=all&per_page=100&after=Y3Vy%3D&page=3";
    const fake = createFakeHttp([
      { body: [issueJson({ number: 3 })], link: `<${SECOND_PAGE_URL}>; rel="next"` },
      { body: [], link: `<${thirdPageUrl}>; rel="next", <${FIRST_PAGE_URL}>; rel="prev"` },
      { body: [issueJson({ number: 1 })], link: `<${SECOND_PAGE_URL}>; rel="prev"` },
    ]);

    // Act
    const issues = await listAllIssues(fake.http, TARGET);

    // Assert
    assert.deepEqual(
      fake.requests.map((request) => request.url),
      [FIRST_PAGE_URL, SECOND_PAGE_URL, thirdPageUrl],
    );
    assert.deepEqual(
      issues.map((issue) => issue.number),
      [3, 1],
    );
  });

  void it("throws on a longer loop (page 3 links back to page 2)", async () => {
    // Arrange
    const thirdPageUrl = `${SECOND_PAGE_URL}&page=3`;
    const fake = createFakeHttp([
      { body: [], link: `<${SECOND_PAGE_URL}>; rel="next"` },
      { body: [], link: `<${thirdPageUrl}>; rel="next"` },
      { body: [], link: `<${SECOND_PAGE_URL}>; rel="next"` },
    ]);

    // Act + Assert
    await assert.rejects(listAllIssues(fake.http, TARGET), schemaError(/loops back to an already fetched page/));
    assert.equal(fake.requests.length, 3);
  });

  void it("handles a page with 200,000 items without overflowing the call stack", { timeout: 20_000 }, async () => {
    // Arrange: push(...page) would pass every item as a function argument and throw RangeError.
    const hugePage = Array.from({ length: 200_000 }, (_, index) => issueJson({ number: index + 1 }));
    const fake = createFakeHttp([{ body: hugePage }]);

    // Act
    const issues = await listAllIssues(fake.http, TARGET);

    // Assert
    assert.equal(issues.length, 200_000);
    assert.equal(issues.at(-1)?.number, 200_000);
  });

  for (const [owner, repo] of [
    ["", "mirror-repo"],
    [".", "mirror-repo"],
    ["BredaUniversityADSAI", ".."],
    ["..", ".."],
  ] as const) {
    void it(`rejects owner/repo ${JSON.stringify(`${owner}/${repo}`)} that URL parsing would collapse`, async () => {
      // Arrange: "/repos/../../issues" would be normalised to GET /issues (every repo of the user).
      const fake = createFakeHttp([{ body: [] }]);

      // Act + Assert
      await assert.rejects(listAllIssues(fake.http, { owner, repo, token: TOKEN }), RangeError);
      assert.equal(fake.requests.length, 0);
    });
  }

  for (const repo of [".github", "...", "a..b"]) {
    void it(`keeps the dotted repo name ${JSON.stringify(repo)} (not a dot segment) as one path segment`, async () => {
      // Arrange
      const fake = createFakeHttp([{ body: [] }]);

      // Act
      await listAllIssues(fake.http, { owner: "o", repo, token: TOKEN });

      // Assert
      const url = requestAt(fake.requests, 0).url;
      assert.equal(url, `https://api.github.com/repos/o/${repo}/issues?state=all&per_page=100`);
      assert.equal(new URL(url).pathname, `/repos/o/${repo}/issues`);
    });
  }

  void it("throws when a page links back to itself", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: [issueJson()], link: `<${FIRST_PAGE_URL}>; rel="next"` }]);

    // Act + Assert
    await assert.rejects(listAllIssues(fake.http, TARGET), schemaError(/loops back/));
    assert.equal(fake.requests.length, 1);
  });

  void it("throws when a later page links back to an earlier one", async () => {
    // Arrange
    const fake = createFakeHttp([
      { body: [issueJson({ number: 1 })], link: `<${SECOND_PAGE_URL}>; rel="next"` },
      { body: [issueJson({ number: 2 })], link: `<${FIRST_PAGE_URL}>; rel="next"` },
    ]);

    // Act + Assert
    await assert.rejects(listAllIssues(fake.http, TARGET), schemaError(/loops back/));
    assert.equal(fake.requests.length, 2);
  });

  for (const [kind, body] of [
    ["object", { message: "Not Found" }],
    ["null (empty body)", null],
    ["string", "issues"],
  ] as const) {
    void it(`throws GitHubSchemaError when a page body is a JSON ${kind}`, async () => {
      const fake = createFakeHttp([{ body }]);
      await assert.rejects(listAllIssues(fake.http, TARGET), schemaError(/issues page must be a JSON array/));
    });
  }

  void it("throws GitHubSchemaError when an item on a later page is invalid", async () => {
    // Arrange
    const fake = createFakeHttp([
      { body: [issueJson()], link: `<${SECOND_PAGE_URL}>; rel="next"` },
      { body: [issueJson({ number: 7, state: "draft" })] },
    ]);

    // Act + Assert
    await assert.rejects(listAllIssues(fake.http, TARGET), schemaError(/#7: "state"/));
  });

  void it("propagates an error from the http client unchanged", async () => {
    // Arrange
    const failure = new HttpError("GET", FIRST_PAGE_URL, 401, '{"message":"Bad credentials"}');
    const fake = createFakeHttp([], failure);

    // Act + Assert
    await assert.rejects(listAllIssues(fake.http, TARGET), (error: Error) => error === failure);
  });

  void it("fails the whole listing, with no partial result, when a later page request fails", async () => {
    // Arrange: a truncated list would hide mirrors on the missing page and cause duplicates.
    const failure = new HttpError("GET", SECOND_PAGE_URL, 502, "Bad Gateway");
    const fake = createFakeHttp([{ body: [issueJson()], link: `<${SECOND_PAGE_URL}>; rel="next"` }], failure);

    // Act + Assert
    await assert.rejects(listAllIssues(fake.http, TARGET), (error: Error) => error === failure);
    assert.deepEqual(
      fake.requests.map((request) => request.url),
      [FIRST_PAGE_URL, SECOND_PAGE_URL],
    );
  });

  void it("throws when a later page's rel=next is foreign, without requesting it", async () => {
    // Arrange
    const fake = createFakeHttp([
      { body: [issueJson({ number: 2 })], link: `<${SECOND_PAGE_URL}>; rel="next"` },
      { body: [issueJson({ number: 1 })], link: '<https://api.github.com.evil.example/p3>; rel="next"' },
    ]);

    // Act + Assert
    await assert.rejects(listAllIssues(fake.http, TARGET), schemaError(/points outside/));
    assert.equal(fake.requests.length, 2);
  });

  void it("stops at the first invalid item without requesting the next page", async () => {
    // Arrange
    const fake = createFakeHttp([
      { body: [issueJson({ number: 2 }), issueJson({ number: 1, labels: null })], link: `<${SECOND_PAGE_URL}>; rel="next"` },
      { body: [] },
    ]);

    // Act + Assert
    await assert.rejects(listAllIssues(fake.http, TARGET), schemaError(/#1: "labels" must be an array/));
    assert.equal(fake.requests.length, 1);
  });

  void it("detects a loop even when the Link URL is padded with whitespace inside <...>", async () => {
    // Arrange
    const fake = createFakeHttp([
      { body: [], link: `<${SECOND_PAGE_URL}>; rel="next"` },
      { body: [], link: `<  ${SECOND_PAGE_URL}\t>; rel="next"` },
    ]);

    // Act + Assert
    await assert.rejects(listAllIssues(fake.http, TARGET), schemaError(/loops back/));
    assert.equal(fake.requests.length, 2);
  });

  void it("follows a next link that is also the last link, then stops on a page without next", async () => {
    // Arrange: GitHub's page-2-of-2 shape: only prev/first on the final page.
    const fake = createFakeHttp([
      { body: [issueJson({ number: 2 })], link: `<${SECOND_PAGE_URL}>; rel="next last"` },
      { body: [issueJson({ number: 1 })], link: `<${FIRST_PAGE_URL}>; rel="prev first"` },
    ]);

    // Act
    const issues = await listAllIssues(fake.http, TARGET);

    // Assert
    assert.deepEqual(
      issues.map((issue) => issue.number),
      [2, 1],
    );
    assert.equal(fake.requests.length, 2);
  });

  void it("refuses an owner that cannot be percent-encoded (lone surrogate) before any request", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: [] }]);

    // Act + Assert
    await assert.rejects(listAllIssues(fake.http, { owner: "o\uD800", repo: "r", token: TOKEN }), Error);
    assert.equal(fake.requests.length, 0);
  });
});

// ---------------------------------------------------------------------------
// createIssue
// ---------------------------------------------------------------------------

void describe("createIssue", () => {
  const body: CreateIssueBody = {
    title: "[YT-12] Mirror me",
    body: "Some text\n\n---\nMirrored from YouTrack: https://youtrack.example.test/issue/CUI-12",
    labels: ["youtrack"],
  };
  const created = issueJson({ number: 101, title: "[YT-12] Mirror me", labels: [{ id: 5, name: "youtrack" }] });

  void it("POSTs the body unchanged to the issues URL with no-retry", async () => {
    // Arrange
    const fake = createFakeHttp([{ status: 201, body: created }]);

    // Act
    await createIssue(fake.http, TARGET, body);

    // Assert
    assert.equal(fake.requests.length, 1);
    const request = requestAt(fake.requests, 0);
    assert.equal(request.method, "POST");
    assert.equal(request.url, ISSUES_URL);
    assert.deepEqual(request.headers, EXPECTED_HEADERS);
    assert.equal(request.retry, "no-retry");
    assert.deepEqual(request.body, {
      title: "[YT-12] Mirror me",
      body: "Some text\n\n---\nMirrored from YouTrack: https://youtrack.example.test/issue/CUI-12",
      labels: ["youtrack"],
    });
  });

  void it("returns the created issue parsed from the 201 response", async () => {
    // Arrange
    const fake = createFakeHttp([{ status: 201, body: created }]);

    // Act
    const issue = await createIssue(fake.http, TARGET, body);

    // Assert
    assert.deepEqual(issue, {
      number: 101,
      title: "[YT-12] Mirror me",
      state: "open",
      labelNames: ["youtrack"],
      isPullRequest: false,
    });
  });

  void it("reports a dropped label as an empty labelNames list", async () => {
    const fake = createFakeHttp([{ status: 201, body: issueJson({ number: 102, labels: [] }) }]);
    assert.deepEqual((await createIssue(fake.http, TARGET, body)).labelNames, []);
  });

  void it("sends a title-only body without adding keys", async () => {
    // Arrange
    const fake = createFakeHttp([{ status: 201, body: created }]);

    // Act
    await createIssue(fake.http, TARGET, { title: "[YT-1] Only a title" });

    // Assert
    assert.deepEqual(requestAt(fake.requests, 0).body, { title: "[YT-1] Only a title" });
  });

  void it("throws GitHubSchemaError when the response is not an issue", async () => {
    const fake = createFakeHttp([{ status: 201, body: { message: "ok" } }]);
    await assert.rejects(createIssue(fake.http, TARGET, body), schemaError(/"number"/));
  });

  for (const [kind, responseBody] of [
    ["null (empty 201 body)", null],
    ["array", [created]],
  ] as const) {
    void it(`throws GitHubSchemaError for a 201 whose body is a JSON ${kind}`, async () => {
      const fake = createFakeHttp([{ status: 201, body: responseBody }]);
      await assert.rejects(createIssue(fake.http, TARGET, body), schemaError(/must be a JSON object/));
    });
  }

  void it("returns the issue number from the response, not from the request", async () => {
    // Arrange: sync records the new mirror under this number (docs/03 section 10).
    const fake = createFakeHttp([{ status: 201, body: issueJson({ number: 4242, title: "server title" }) }]);

    // Act
    const issue = await createIssue(fake.http, TARGET, { title: "[YT-1] client title" });

    // Assert
    assert.equal(issue.number, 4242);
    assert.equal(issue.title, "server title");
  });

  void it("propagates an HttpError (e.g. 422) without retrying", async () => {
    // Arrange
    const failure = httpError(422);
    const fake = createFakeHttp([], failure);

    // Act + Assert
    await assert.rejects(createIssue(fake.http, TARGET, body), (error: Error) => error === failure);
    assert.equal(fake.requests.length, 1);
  });

  for (const status of [200, 202]) {
    void it(`rejects a ${String(status)} response even with a valid issue body (only 201 proves a create)`, async () => {
      // Arrange
      const fake = createFakeHttp([{ status, body: created }]);

      // Act + Assert
      await assert.rejects(
        createIssue(fake.http, TARGET, body),
        schemaError(new RegExp(`must answer HTTP 201, got HTTP ${String(status)}`)),
      );
      assert.equal(fake.requests.length, 1);
    });
  }

  void it("checks the status before the body (204 with an empty body)", async () => {
    const fake = createFakeHttp([{ status: 204, body: null }]);
    await assert.rejects(createIssue(fake.http, TARGET, body), schemaError(/got HTTP 204/));
  });

  void it("does not mutate the caller's body", async () => {
    // Arrange
    const input: CreateIssueBody = { title: "[YT-3] t", body: "b", labels: ["youtrack", { name: "x" }] };
    const snapshot = structuredClone(input);
    const fake = createFakeHttp([{ status: 201, body: created }]);

    // Act
    await createIssue(fake.http, TARGET, input);

    // Assert
    assert.deepEqual(input, snapshot);
  });

  void it("passes label objects and a numeric title through unchanged", async () => {
    // Arrange: both forms are allowed by GitHub's create schema.
    const input: CreateIssueBody = { title: 42, labels: [{ name: "youtrack" }, "bug"] };
    const fake = createFakeHttp([{ status: 201, body: created }]);

    // Act
    await createIssue(fake.http, TARGET, input);

    // Assert
    assert.deepEqual(requestAt(fake.requests, 0).body, { title: 42, labels: [{ name: "youtrack" }, "bug"] });
  });

  void it("percent-encodes owner and repo in the create URL", async () => {
    // Arrange
    const fake = createFakeHttp([{ status: 201, body: created }]);

    // Act
    await createIssue(fake.http, { owner: "o w", repo: "r#1", token: TOKEN }, body);

    // Assert
    assert.equal(requestAt(fake.requests, 0).url, "https://api.github.com/repos/o%20w/r%231/issues");
  });

  void it("refuses a dot-segment repo before sending the create", async () => {
    const fake = createFakeHttp([{ status: 201, body: created }]);
    await assert.rejects(createIssue(fake.http, { owner: "o", repo: ".", token: TOKEN }, body), RangeError);
    assert.equal(fake.requests.length, 0);
  });

  void it("returns a pull-request flag and closed state as reported by the response", async () => {
    // Arrange
    const fake = createFakeHttp([{ status: 201, body: issueJson({ number: 5, state: "closed", pull_request: null }) }]);

    // Act
    const issue = await createIssue(fake.http, TARGET, body);

    // Assert
    assert.equal(issue.state, "closed");
    assert.equal(issue.isPullRequest, false);
  });
});

// ---------------------------------------------------------------------------
// closeIssue / addLabel
// ---------------------------------------------------------------------------

void describe("closeIssue", () => {
  void it("PATCHes the issue with state closed / completed and retry-once", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: issueJson({ number: 7, state: "closed" }) }]);

    // Act
    await closeIssue(fake.http, TARGET, 7);

    // Assert
    assert.equal(fake.requests.length, 1);
    const request = requestAt(fake.requests, 0);
    assert.equal(request.method, "PATCH");
    assert.equal(request.url, `${ISSUES_URL}/7`);
    assert.deepEqual(request.headers, EXPECTED_HEADERS);
    assert.equal(request.retry, "retry-once");
    assert.deepEqual(request.body, { state: "closed", state_reason: "completed" });
  });

  void it("does not validate the PATCH response body", async () => {
    const fake = createFakeHttp([{ body: null }]);
    await closeIssue(fake.http, TARGET, 7);
    assert.equal(fake.requests.length, 1);
  });

  void it("propagates an HttpError from the client", async () => {
    const failure = httpError(404);
    const fake = createFakeHttp([], failure);
    await assert.rejects(closeIssue(fake.http, TARGET, 7), (error: Error) => error === failure);
  });

  for (const issueNumber of [0, -0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
    void it(`rejects issue number ${Object.is(issueNumber, -0) ? "-0" : String(issueNumber)} before sending anything`, async () => {
      const fake = createFakeHttp([]);
      await assert.rejects(closeIssue(fake.http, TARGET, issueNumber), RangeError);
      assert.equal(fake.requests.length, 0);
    });
  }

  void it("accepts the largest safe issue number", async () => {
    const fake = createFakeHttp([{ body: null }]);
    await closeIssue(fake.http, TARGET, Number.MAX_SAFE_INTEGER);
    assert.equal(requestAt(fake.requests, 0).url, `${ISSUES_URL}/9007199254740991`);
  });

  void it("percent-encodes owner and repo in the PATCH URL", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: null }]);

    // Act
    await closeIssue(fake.http, { owner: "o w", repo: "r?x", token: TOKEN }, 4);

    // Assert
    assert.equal(requestAt(fake.requests, 0).url, "https://api.github.com/repos/o%20w/r%3Fx/issues/4");
  });

  void it("refuses a dot-segment owner before sending the PATCH", async () => {
    const fake = createFakeHttp([{ body: null }]);
    await assert.rejects(closeIssue(fake.http, { owner: "..", repo: "r", token: TOKEN }, 4), RangeError);
    assert.equal(fake.requests.length, 0);
  });
});

void describe("addLabel", () => {
  void it("POSTs {labels: [label]} to the issue's labels URL with retry-once", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: [{ id: 5, name: "youtrack" }] }]);

    // Act
    await addLabel(fake.http, TARGET, 12, "youtrack");

    // Assert
    assert.equal(fake.requests.length, 1);
    const request = requestAt(fake.requests, 0);
    assert.equal(request.method, "POST");
    assert.equal(request.url, `${ISSUES_URL}/12/labels`);
    assert.deepEqual(request.headers, EXPECTED_HEADERS);
    assert.equal(request.retry, "retry-once");
    assert.deepEqual(request.body, { labels: ["youtrack"] });
  });

  void it("uses the encoded owner/repo path of the target", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: [] }]);
    const target: GitHubTarget = { owner: "o w", repo: "r/x", token: TOKEN };

    // Act
    await addLabel(fake.http, target, 3, "youtrack");

    // Assert
    assert.equal(requestAt(fake.requests, 0).url, "https://api.github.com/repos/o%20w/r%2Fx/issues/3/labels");
  });

  void it("propagates an HttpError from the client", async () => {
    const failure = httpError(403);
    const fake = createFakeHttp([], failure);
    await assert.rejects(addLabel(fake.http, TARGET, 12, "youtrack"), (error: Error) => error === failure);
  });

  for (const issueNumber of [0, -12, 12.5, Number.NaN, Number.NEGATIVE_INFINITY, 2 ** 53]) {
    void it(`rejects issue number ${String(issueNumber)} before sending anything`, async () => {
      const fake = createFakeHttp([]);
      await assert.rejects(addLabel(fake.http, TARGET, issueNumber, "youtrack"), RangeError);
      assert.equal(fake.requests.length, 0);
    });
  }

  void it("sends an unusual label verbatim in the body and never in the URL", async () => {
    // Arrange
    const label = "good first issue/ü 😀?#";
    const fake = createFakeHttp([{ body: [] }]);

    // Act
    await addLabel(fake.http, TARGET, 12, label);

    // Assert
    const request = requestAt(fake.requests, 0);
    assert.equal(request.url, `${ISSUES_URL}/12/labels`);
    assert.deepEqual(request.body, { labels: [label] });
  });
});
