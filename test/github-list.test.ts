import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { listAllIssues } from "../src/github.ts";
import type { GitHubTarget } from "../src/github.ts";
import { HttpError } from "../src/http.ts";
import {
  EXPECTED_HEADERS,
  FIRST_PAGE_URL,
  SECOND_PAGE_URL,
  TARGET,
  TOKEN,
  createFakeHttp,
  issueJson,
  requestAt,
  schemaError,
} from "./github-fixtures.ts";

// ---------------------------------------------------------------------------
// listAllIssues: requests and paging
// ---------------------------------------------------------------------------

describe("listAllIssues", () => {
  it("GETs the unfiltered first page with GitHub headers and retry-once", async () => {
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

  it("percent-encodes owner and repo in the path", async () => {
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

  it("returns an empty list for an empty repository", async () => {
    const fake = createFakeHttp([{ body: [] }]);
    assert.deepEqual(await listAllIssues(fake.http, TARGET), []);
  });

  it('follows Link rel="next" verbatim across two pages and keeps order, PRs flagged', async () => {
    // Arrange
    const fake = createFakeHttp([
      {
        body: [
          issueJson({ number: 30, title: "[YT-3] c", labels: ["youtrack"] }),
          issueJson({ number: 29, pull_request: {} }),
        ],
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

  it("sends GitHub headers and retry-once on every page, not just the first", async () => {
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

  it("follows three pages, including an empty middle page, in order", async () => {
    // Arrange
    const thirdPageUrl =
      "https://api.github.com/repositories/123456/issues?state=all&per_page=100&after=Y3Vy%3D&page=3";
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

  it("follows a next link that is also the last link, then stops on a page without next", async () => {
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

  it("handles a page with 200,000 items without overflowing the call stack", { timeout: 20_000 }, async () => {
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
    it(`rejects owner/repo ${JSON.stringify(`${owner}/${repo}`)} that URL parsing would collapse`, async () => {
      // Arrange: "/repos/../../issues" would be normalised to GET /issues (every repo of the user).
      const fake = createFakeHttp([{ body: [] }]);

      // Act + Assert
      await assert.rejects(listAllIssues(fake.http, { owner, repo, token: TOKEN }), RangeError);
      assert.equal(fake.requests.length, 0);
    });
  }

  for (const repo of [".github", "...", "a..b"]) {
    it(`keeps the dotted repo name ${JSON.stringify(repo)} (not a dot segment) as one path segment`, async () => {
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

  it("refuses an owner that cannot be percent-encoded (lone surrogate) before any request", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: [] }]);

    // Act + Assert
    await assert.rejects(listAllIssues(fake.http, { owner: "o\uD800", repo: "r", token: TOKEN }), Error);
    assert.equal(fake.requests.length, 0);
  });
});

// ---------------------------------------------------------------------------
// listAllIssues: untrusted or looping Link headers, bad pages, client errors
// ---------------------------------------------------------------------------

describe("listAllIssues failures", () => {
  it("throws instead of silently stopping when rel=next points to a foreign host", async () => {
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
    it(`throws on an untrusted rel=next URL ${JSON.stringify(url)} without requesting it`, async () => {
      const fake = createFakeHttp([{ body: [issueJson()], link: `<${url}>; rel="next"` }]);
      await assert.rejects(listAllIssues(fake.http, TARGET), schemaError(/points outside/));
      assert.equal(fake.requests.length, 1);
    });
  }

  for (const url of ["https://user:pass@api.github.com/p2", "https://api%2Egithub.com/p2", "https:api.github.com/p2"]) {
    it(`throws on a rel=next ${JSON.stringify(url)} that parses to api.github.com but is not canonical`, async () => {
      // Arrange
      const fake = createFakeHttp([{ body: [issueJson()], link: `<${url}>; rel="next"` }]);

      // Act + Assert
      await assert.rejects(listAllIssues(fake.http, TARGET), schemaError(/points outside/));
      assert.equal(fake.requests.length, 1);
    });
  }

  it("does not echo the userinfo of a rejected next URL", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: [], link: '<https://user:s3cr3t@api.github.com/p2>; rel="next"' }]);

    // Act + Assert
    await assert.rejects(
      listAllIssues(fake.http, TARGET),
      (error: Error) => error.message.includes('"https://***@api.github.com/p2"') && !error.message.includes("s3cr3t"),
    );
  });

  it("throws instead of silently stopping when a Link header without next does not parse", async () => {
    // Arrange: the unclosed quote swallows the rel="next" entry; stopping here would hide the
    // mirrors on page 2, and every run would create duplicates of them.
    const link = `<${FIRST_PAGE_URL}>; rel="prev, <${SECOND_PAGE_URL}>; rel="next"`;
    const fake = createFakeHttp([{ body: [issueJson()], link }, { body: [] }]);

    // Act + Assert
    await assert.rejects(listAllIssues(fake.http, TARGET), schemaError(/Link header does not parse/));
    assert.equal(fake.requests.length, 1);
  });

  it("quotes at most 40 characters of a rejected next URL", async () => {
    // Arrange
    const longUrl = `https://evil.example.com/${"a".repeat(500)}`;
    const fake = createFakeHttp([{ body: [], link: `<${longUrl}>; rel="next"` }]);

    // Act + Assert
    await assert.rejects(
      listAllIssues(fake.http, TARGET),
      (error: Error) =>
        error.message.includes(`"${longUrl.slice(0, 40)}"`) && !error.message.includes(longUrl.slice(0, 41)),
    );
  });

  it("throws when a later page's rel=next is foreign, without requesting it", async () => {
    // Arrange
    const fake = createFakeHttp([
      { body: [issueJson({ number: 2 })], link: `<${SECOND_PAGE_URL}>; rel="next"` },
      { body: [issueJson({ number: 1 })], link: '<https://api.github.com.evil.example/p3>; rel="next"' },
    ]);

    // Act + Assert
    await assert.rejects(listAllIssues(fake.http, TARGET), schemaError(/points outside/));
    assert.equal(fake.requests.length, 2);
  });

  it("throws on a longer loop (page 3 links back to page 2)", async () => {
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

  it("throws when a page links back to itself", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: [issueJson()], link: `<${FIRST_PAGE_URL}>; rel="next"` }]);

    // Act + Assert
    await assert.rejects(listAllIssues(fake.http, TARGET), schemaError(/loops back/));
    assert.equal(fake.requests.length, 1);
  });

  it("throws when a later page links back to an earlier one", async () => {
    // Arrange
    const fake = createFakeHttp([
      { body: [issueJson({ number: 1 })], link: `<${SECOND_PAGE_URL}>; rel="next"` },
      { body: [issueJson({ number: 2 })], link: `<${FIRST_PAGE_URL}>; rel="next"` },
    ]);

    // Act + Assert
    await assert.rejects(listAllIssues(fake.http, TARGET), schemaError(/loops back/));
    assert.equal(fake.requests.length, 2);
  });

  it("detects a loop even when the Link URL is padded with whitespace inside <...>", async () => {
    // Arrange
    const fake = createFakeHttp([
      { body: [], link: `<${SECOND_PAGE_URL}>; rel="next"` },
      { body: [], link: `<  ${SECOND_PAGE_URL}\t>; rel="next"` },
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
    it(`throws GitHubSchemaError when a page body is a JSON ${kind}`, async () => {
      const fake = createFakeHttp([{ body }]);
      await assert.rejects(listAllIssues(fake.http, TARGET), schemaError(/issues page must be a JSON array/));
    });
  }

  it("throws GitHubSchemaError when an item on a later page is invalid", async () => {
    // Arrange
    const fake = createFakeHttp([
      { body: [issueJson()], link: `<${SECOND_PAGE_URL}>; rel="next"` },
      { body: [issueJson({ number: 7, state: "draft" })] },
    ]);

    // Act + Assert
    await assert.rejects(listAllIssues(fake.http, TARGET), schemaError(/#7: "state"/));
  });

  it("stops at the first invalid item without requesting the next page", async () => {
    // Arrange
    const fake = createFakeHttp([
      {
        body: [issueJson({ number: 2 }), issueJson({ number: 1, labels: null })],
        link: `<${SECOND_PAGE_URL}>; rel="next"`,
      },
      { body: [] },
    ]);

    // Act + Assert
    await assert.rejects(listAllIssues(fake.http, TARGET), schemaError(/#1: "labels" must be an array/));
    assert.equal(fake.requests.length, 1);
  });

  it("propagates an error from the http client unchanged", async () => {
    // Arrange
    const failure = new HttpError("GET", FIRST_PAGE_URL, 401, '{"message":"Bad credentials"}');
    const fake = createFakeHttp([], failure);

    // Act + Assert
    await assert.rejects(listAllIssues(fake.http, TARGET), (error: Error) => error === failure);
  });

  it("fails the whole listing, with no partial result, when a later page request fails", async () => {
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
});
