import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  describeJson,
  GITHUB_API_BASE,
  GITHUB_PAGE_SIZE,
  GitHubSchemaError,
  githubHeaders,
  githubRequest,
  issuesUrl,
  issueUrl,
  milestonesUrl,
  milestoneUrl,
  MIRROR_LABEL,
  positiveInteger,
  quote,
  repoUrl,
} from "../../src/github/client.ts";
import { EXPECTED_HEADERS, ISSUES_URL, MILESTONES_URL, TARGET, TOKEN } from "./fixtures.ts";

// ---------------------------------------------------------------------------
// Constants and errors
// ---------------------------------------------------------------------------

describe("GitHub client constants", () => {
  it("pins the API origin, page size and mirror label", () => {
    assert.equal(GITHUB_API_BASE, "https://api.github.com");
    assert.equal(GITHUB_PAGE_SIZE, 100);
    assert.equal(MIRROR_LABEL, "youtrack");
  });

  it("names GitHubSchemaError and keeps its message", () => {
    // Act
    const error = new GitHubSchemaError("bad shape");

    // Assert
    assert.ok(error instanceof Error);
    assert.equal(error.name, "GitHubSchemaError");
    assert.equal(error.message, "bad shape");
  });
});

// ---------------------------------------------------------------------------
// githubHeaders
// ---------------------------------------------------------------------------

describe("githubHeaders", () => {
  it("returns exactly Accept, Bearer Authorization and the pinned API version", () => {
    // Act
    const headers = githubHeaders(TOKEN);

    // Assert
    assert.deepEqual(headers, EXPECTED_HEADERS);
  });

  it("pins API version 2026-03-10", () => {
    assert.equal(githubHeaders(TOKEN)["X-GitHub-Api-Version"], "2026-03-10");
  });

  it("embeds the token verbatim after 'Bearer ' and adds no Content-Type or User-Agent", () => {
    // Act
    const headers = githubHeaders("github_pat_11A+/=x");

    // Assert
    assert.equal(headers["Authorization"], "Bearer github_pat_11A+/=x");
    assert.deepEqual(Object.keys(headers).sort(), ["Accept", "Authorization", "X-GitHub-Api-Version"]);
  });

  it("returns a fresh object on every call", () => {
    assert.notEqual(githubHeaders(TOKEN), githubHeaders(TOKEN));
  });
});

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

describe("repoUrl, issuesUrl and issueUrl", () => {
  it("build the repository, issues and single-issue URLs", () => {
    assert.equal(repoUrl(TARGET), "https://api.github.com/repos/BredaUniversityADSAI/mirror-repo");
    assert.equal(issuesUrl(TARGET), ISSUES_URL);
    assert.equal(issueUrl(TARGET, 7), `${ISSUES_URL}/7`);
  });

  it("percent-encodes owner and repo as one path segment each", () => {
    assert.equal(
      repoUrl({ owner: "a b", repo: "x/y?z", token: TOKEN }),
      "https://api.github.com/repos/a%20b/x%2Fy%3Fz",
    );
  });

  for (const name of ["", ".", ".."]) {
    it(`refuses owner or repo ${JSON.stringify(name)}, which URL parsing drops or collapses`, () => {
      assert.throws(() => repoUrl({ owner: name, repo: "r", token: TOKEN }), { name: "RangeError", message: /owner/ });
      assert.throws(() => repoUrl({ owner: "o", repo: name, token: TOKEN }), { name: "RangeError", message: /repo/ });
    });
  }

  for (const issueNumber of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    it(`issueUrl refuses issue number ${String(issueNumber)}`, () => {
      assert.throws(() => issueUrl(TARGET, issueNumber), { name: "RangeError", message: /issue number/ });
    });
  }

  it("reports a bad owner before a bad repo and quotes the refused value", () => {
    assert.throws(() => repoUrl({ owner: "..", repo: ".", token: TOKEN }), {
      name: "RangeError",
      message: 'GitHub owner must be a non-empty name other than "." and "..", got ".."',
    });
  });

  it("issuesUrl and issueUrl refuse a dot-segment owner or repo like repoUrl", () => {
    assert.throws(() => issuesUrl({ owner: ".", repo: "r", token: TOKEN }), { name: "RangeError", message: /owner/ });
    assert.throws(() => issueUrl({ owner: "o", repo: "..", token: TOKEN }, 1), { name: "RangeError", message: /repo/ });
  });

  it("issueUrl checks the issue number before owner and repo", () => {
    assert.throws(() => issueUrl({ owner: "", repo: "..", token: TOKEN }, 0), {
      name: "RangeError",
      message: /issue number/,
    });
  });

  it("keeps dotted names that are not dot segments as one path segment", () => {
    assert.equal(repoUrl({ owner: "...", repo: ".github", token: TOKEN }), "https://api.github.com/repos/.../.github");
  });

  it("accepts the largest safe issue number", () => {
    assert.equal(issueUrl(TARGET, Number.MAX_SAFE_INTEGER), `${ISSUES_URL}/9007199254740991`);
  });
});

describe("milestonesUrl and milestoneUrl", () => {
  it("build the milestones and single-milestone URLs", () => {
    assert.equal(milestonesUrl(TARGET), MILESTONES_URL);
    assert.equal(milestoneUrl(TARGET, 6), `${MILESTONES_URL}/6`);
    assert.equal(milestoneUrl(TARGET, Number.MAX_SAFE_INTEGER), `${MILESTONES_URL}/9007199254740991`);
  });

  it("percent-encode owner and repo and refuse dot segments like repoUrl", () => {
    assert.equal(
      milestonesUrl({ owner: "a b", repo: "x", token: TOKEN }),
      "https://api.github.com/repos/a%20b/x/milestones",
    );
    assert.throws(() => milestonesUrl({ owner: "o", repo: "..", token: TOKEN }), {
      name: "RangeError",
      message: /repo/,
    });
    assert.throws(() => milestoneUrl({ owner: ".", repo: "r", token: TOKEN }, 1), {
      name: "RangeError",
      message: /owner/,
    });
  });

  for (const milestoneNumber of [0, -1, 1.5, Number.NaN, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    it(`milestoneUrl refuses milestone number ${String(milestoneNumber)} before checking owner and repo`, () => {
      assert.throws(() => milestoneUrl({ owner: "", repo: "", token: TOKEN }, milestoneNumber), {
        name: "RangeError",
        message: `GitHub milestone number must be a positive integer, got ${String(milestoneNumber)}`,
      });
    });
  }
});

describe("positiveInteger", () => {
  it("returns a positive safe integer unchanged", () => {
    assert.equal(positiveInteger("GitHub thing", 1), 1);
    assert.equal(positiveInteger("GitHub thing", Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  });

  for (const value of [0, -0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
    it(`throws a RangeError naming the value for ${Object.is(value, -0) ? "-0" : String(value)}`, () => {
      assert.throws(() => positiveInteger("GitHub thing", value), {
        name: "RangeError",
        message: `GitHub thing must be a positive integer, got ${String(value)}`,
      });
    });
  }

  it("keeps issueUrl's message for a bad issue number", () => {
    assert.throws(() => issueUrl(TARGET, 0), {
      name: "RangeError",
      message: "GitHub issue number must be a positive integer, got 0",
    });
  });
});

// ---------------------------------------------------------------------------
// githubRequest
// ---------------------------------------------------------------------------

describe("githubRequest", () => {
  it("builds a request with GitHub headers and no body key when no body is given", () => {
    // Act
    const request = githubRequest(TARGET, "GET", ISSUES_URL, "retry-once");

    // Assert
    assert.deepEqual(request, { method: "GET", url: ISSUES_URL, headers: EXPECTED_HEADERS, retry: "retry-once" });
    assert.ok(!("body" in request));
  });

  it("passes a JSON body through unchanged, including null", () => {
    assert.deepEqual(githubRequest(TARGET, "POST", ISSUES_URL, "no-retry", { title: "t" }).body, { title: "t" });
    assert.equal(githubRequest(TARGET, "PATCH", ISSUES_URL, "retry-once", null).body, null);
  });

  for (const body of [0, false, ""] as const) {
    it(`keeps the falsy body ${JSON.stringify(body)} (only undefined leaves the key out)`, () => {
      // Act
      const request = githubRequest(TARGET, "POST", ISSUES_URL, "no-retry", body);

      // Assert
      assert.ok("body" in request);
      assert.equal(request.body, body);
    });
  }

  it("uses the target's own token and passes method, URL and retry through", () => {
    // Act
    const request = githubRequest({ ...TARGET, token: "other-token" }, "PATCH", "https://example.test/x", "no-retry");

    // Assert
    assert.equal(request.headers["Authorization"], "Bearer other-token");
    assert.equal(request.method, "PATCH");
    assert.equal(request.url, "https://example.test/x");
    assert.equal(request.retry, "no-retry");
  });
});

// ---------------------------------------------------------------------------
// Error-message helpers
// ---------------------------------------------------------------------------

describe("describeJson", () => {
  for (const [value, expected] of [
    [undefined, "nothing"],
    [null, "null"],
    [[1], "an array"],
    [{ a: 1 }, "an object"],
    ["abc", 'string "abc"'],
    ["", 'string ""'],
    [[], "an array"],
    [{}, "an object"],
    [42, "number 42"],
    [-1.5, "number -1.5"],
    [false, "boolean false"],
  ] as const) {
    it(`describes ${value === undefined ? "undefined" : JSON.stringify(value)} as ${JSON.stringify(expected)}`, () => {
      assert.equal(describeJson(value), expected);
    });
  }

  it("quotes only the start of a long string", () => {
    assert.equal(describeJson("x".repeat(100)), `string ${JSON.stringify("x".repeat(40))}`);
  });
});

describe("quote", () => {
  it("JSON-quotes the text", () => {
    assert.equal(quote('a"b\n'), '"a\\"b\\n"');
  });

  it("keeps at most 40 code points and never half an emoji", () => {
    assert.equal(quote("x".repeat(100)), JSON.stringify("x".repeat(40)));
    assert.equal(quote("\u{1F600}".repeat(50)), JSON.stringify("\u{1F600}".repeat(40)));
  });

  it("counts code points, not UTF-16 units, when emoji start at an odd offset", () => {
    assert.equal(quote(`x${"\u{1F600}".repeat(50)}`), JSON.stringify(`x${"\u{1F600}".repeat(39)}`));
    assert.equal(quote(`${"x".repeat(39)}\u{1F600}tail`), JSON.stringify(`${"x".repeat(39)}\u{1F600}`));
  });

  it("quotes an empty string and escapes a lone surrogate", () => {
    assert.equal(quote(""), '""');
    assert.equal(quote("a\uD800"), '"a\\ud800"');
  });
});
