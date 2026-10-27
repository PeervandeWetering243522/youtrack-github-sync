import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseOpenIssuesCount, readOpenIssuesCount } from "../../src/github/repo.ts";
import { HttpError } from "../../src/http.ts";
import type { JsonValue } from "../../src/json.ts";
import { EXPECTED_HEADERS, REPO_URL, TARGET, createFakeHttp, requestAt, schemaError } from "./fixtures.ts";

/** A repository object with the keys around open_issues_count that GitHub also sends. */
function repoJson(openIssuesCount: JsonValue): JsonValue {
  return {
    id: 123_456,
    full_name: "BredaUniversityADSAI/mirror-repo",
    open_issues: 7,
    open_issues_count: openIssuesCount,
  };
}

// ---------------------------------------------------------------------------
// parseOpenIssuesCount
// ---------------------------------------------------------------------------

describe("parseOpenIssuesCount", () => {
  it("returns open_issues_count", () => {
    assert.equal(parseOpenIssuesCount(repoJson(59)), 59);
  });

  it("accepts a repository with nothing open", () => {
    assert.equal(parseOpenIssuesCount(repoJson(0)), 0);
  });

  for (const value of [[], null, "repo", 1, true]) {
    it(`rejects a repository that is ${JSON.stringify(value)}`, () => {
      assert.throws(() => parseOpenIssuesCount(value), schemaError(/^GitHub repository must be a JSON object, got /));
    });
  }

  it("rejects a repository without open_issues_count", () => {
    assert.throws(
      () => parseOpenIssuesCount({ id: 1 }),
      schemaError(/^GitHub repository "open_issues_count" must be a non-negative integer, got nothing$/),
    );
  });

  for (const value of [-1, 1.5, "59", null, Number.MAX_SAFE_INTEGER + 1]) {
    it(`rejects an open_issues_count of ${JSON.stringify(value)}`, () => {
      assert.throws(
        () => parseOpenIssuesCount(repoJson(value)),
        schemaError(/^GitHub repository "open_issues_count" must be a non-negative integer, got /),
      );
    });
  }
});

// ---------------------------------------------------------------------------
// readOpenIssuesCount
// ---------------------------------------------------------------------------

describe("readOpenIssuesCount", () => {
  it("GETs the repository with GitHub headers and retry-once, and returns its open_issues_count", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: repoJson(12) }]);

    // Act
    const count = await readOpenIssuesCount(fake.http, TARGET);

    // Assert
    assert.equal(count, 12);
    assert.equal(fake.requests.length, 1);
    const request = requestAt(fake.requests, 0);
    assert.equal(request.method, "GET");
    assert.equal(request.url, REPO_URL);
    assert.deepEqual(request.headers, EXPECTED_HEADERS);
    assert.equal(request.retry, "retry-once");
    assert.equal("body" in request, false);
  });

  it("rethrows the client's error unchanged", async () => {
    // Arrange
    const failure = new HttpError("GET", REPO_URL, 502, "");
    const fake = createFakeHttp([], failure);

    // Act / Assert
    await assert.rejects(readOpenIssuesCount(fake.http, TARGET), (error) => error === failure);
  });

  it("throws GitHubSchemaError for a body without a count", async () => {
    const fake = createFakeHttp([{ body: {} }]);
    await assert.rejects(readOpenIssuesCount(fake.http, TARGET), schemaError(/"open_issues_count"/));
  });
});
