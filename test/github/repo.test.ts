import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseOpenIssueCount, readOpenIssueCount } from "../../src/github/repo.ts";
import { HttpError } from "../../src/http.ts";
import { isJsonObject } from "../../src/json.ts";
import type { JsonValue } from "../../src/json.ts";
import { EXPECTED_HEADERS, GRAPHQL_URL, TARGET, createFakeHttp, requestAt, schemaError } from "./fixtures.ts";

/** GraphQL's answer to the open issue count query. */
function countJson(totalCount: JsonValue): JsonValue {
  return { data: { repository: { issues: { totalCount } } } };
}

/** GraphQL's answer for a repository the token cannot see (live shape, 2026-10-29). */
const NOT_FOUND = {
  data: { repository: null },
  errors: [
    {
      type: "NOT_FOUND",
      path: ["repository"],
      locations: [{ line: 1, column: 42 }],
      message: "Could not resolve to a Repository with the name 'BredaUniversityADSAI/mirror-repo'.",
    },
  ],
};

// ---------------------------------------------------------------------------
// parseOpenIssueCount
// ---------------------------------------------------------------------------

describe("parseOpenIssueCount", () => {
  it("returns totalCount", () => {
    assert.equal(parseOpenIssueCount(countJson(5)), 5);
  });

  it("accepts a repository with no open issue", () => {
    assert.equal(parseOpenIssueCount(countJson(0)), 0);
  });

  for (const value of [[], null, "answer", 1, true]) {
    it(`rejects an answer that is ${JSON.stringify(value)}`, () => {
      assert.throws(
        () => parseOpenIssueCount(value),
        schemaError(/^GitHub GraphQL answer must be a JSON object, got /),
      );
    });
  }

  it("rejects a missing repository by its error type, without echoing the error's message", () => {
    assert.throws(
      () => parseOpenIssueCount(NOT_FOUND),
      schemaError(/^GitHub GraphQL answered with errors \(first type: string "NOT_FOUND"\)$/),
    );
  });

  it("rejects an answer with errors even when it also carries a count", () => {
    const partial = { data: { repository: { issues: { totalCount: 5 } } }, errors: [{ type: "RATE_LIMITED" }] };
    assert.throws(
      () => parseOpenIssueCount(partial),
      schemaError(/^GitHub GraphQL answered with errors \(first type: string "RATE_LIMITED"\)$/),
    );
  });

  for (const errors of [[], "boom", [{ message: "no type" }]]) {
    it(`rejects errors of ${JSON.stringify(errors)}`, () => {
      assert.throws(() => parseOpenIssueCount({ errors }), schemaError(/^GitHub GraphQL answered with errors /));
    });
  }

  for (const body of [{}, { data: null }, { data: { repository: null } }, { data: { repository: { issues: [] } } }]) {
    it(`rejects ${JSON.stringify(body)}, which holds no count`, () => {
      assert.throws(
        () => parseOpenIssueCount(body),
        schemaError(
          /^GitHub GraphQL "data\.repository\.issues\.totalCount" must be a non-negative integer, got nothing$/,
        ),
      );
    });
  }

  for (const value of [-1, 1.5, "5", null, Number.MAX_SAFE_INTEGER + 1]) {
    it(`rejects a totalCount of ${JSON.stringify(value)}`, () => {
      assert.throws(
        () => parseOpenIssueCount(countJson(value)),
        schemaError(/^GitHub GraphQL "data\.repository\.issues\.totalCount" must be a non-negative integer, got /),
      );
    });
  }
});

// ---------------------------------------------------------------------------
// readOpenIssueCount
// ---------------------------------------------------------------------------

describe("readOpenIssueCount", () => {
  it("POSTs the count query to GraphQL with GitHub headers and retry-once, and returns its totalCount", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: countJson(5) }]);

    // Act
    const count = await readOpenIssueCount(fake.http, TARGET);

    // Assert
    assert.equal(count, 5);
    assert.equal(fake.requests.length, 1);
    const request = requestAt(fake.requests, 0);
    assert.equal(request.method, "POST");
    assert.equal(request.url, GRAPHQL_URL);
    assert.deepEqual(request.headers, EXPECTED_HEADERS);
    assert.equal(request.retry, "retry-once");
    assert.deepEqual(request.body, {
      query:
        "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { issues(states: OPEN) { totalCount } } }",
      variables: { owner: "BredaUniversityADSAI", name: "mirror-repo" },
    });
  });

  it("passes owner and repo as variables only, so a quote in them cannot change the query", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: countJson(0) }]);

    // Act
    await readOpenIssueCount(fake.http, { ...TARGET, owner: 'evil"){x}', repo: "r" });

    // Assert
    const body = requestAt(fake.requests, 0).body;
    assert.ok(isJsonObject(body));
    const query = body["query"];
    assert.ok(typeof query === "string");
    assert.equal(query.includes("evil"), false);
    assert.deepEqual(body["variables"], { owner: 'evil"){x}', name: "r" });
  });

  it("rethrows the client's error unchanged", async () => {
    // Arrange
    const failure = new HttpError("POST", GRAPHQL_URL, 502, "");
    const fake = createFakeHttp([], failure);

    // Act / Assert
    await assert.rejects(readOpenIssueCount(fake.http, TARGET), (error) => error === failure);
  });

  it("throws GitHubSchemaError for a 200 answer with errors", async () => {
    const fake = createFakeHttp([{ body: NOT_FOUND }]);
    await assert.rejects(readOpenIssueCount(fake.http, TARGET), schemaError(/"NOT_FOUND"/));
  });
});
