import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { listAllPages } from "../src/github/pages.ts";
import { isInteger, isJsonArray } from "../src/json.ts";
import type { JsonValue } from "../src/json.ts";
import { EXPECTED_HEADERS, TARGET, createFakeHttp, requestAt, schemaError } from "./github-fixtures.ts";

const FIRST = "https://api.github.com/repos/BredaUniversityADSAI/mirror-repo/things?per_page=100";
const SECOND = "https://api.github.com/repositories/123456/things?per_page=100&page=2";

/** Pages of JSON integers; anything else is a parse error. */
function integers(body: JsonValue): readonly number[] {
  if (!isJsonArray(body) || !body.every(isInteger)) {
    throw new Error("not a page of integers");
  }
  return body.filter(isInteger);
}

describe("listAllPages", () => {
  it("GETs the first URL verbatim with GitHub headers and retry-once, and parses its body", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: [1, 2] }]);

    // Act
    const items = await listAllPages(fake.http, TARGET, FIRST, integers);

    // Assert
    const request = requestAt(fake.requests, 0);
    assert.equal(request.method, "GET");
    assert.equal(request.url, FIRST);
    assert.deepEqual(request.headers, EXPECTED_HEADERS);
    assert.equal(request.retry, "retry-once");
    assert.equal("body" in request, false);
    assert.deepEqual(items, [1, 2]);
  });

  it("concatenates the pages in order, including empty ones", async () => {
    // Arrange
    const third = `${SECOND}&page=3`;
    const fake = createFakeHttp([
      { body: [3], link: `<${SECOND}>; rel="next"` },
      { body: [], link: `<${third}>; rel="next"` },
      { body: [1, 2] },
    ]);

    // Act
    const items = await listAllPages(fake.http, TARGET, FIRST, integers);

    // Assert
    assert.deepEqual(items, [3, 1, 2]);
    assert.deepEqual(
      fake.requests.map((request) => request.url),
      [FIRST, SECOND, third],
    );
  });

  it("stops at the first page parsePage rejects, without requesting the next one", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: ["x"], link: `<${SECOND}>; rel="next"` }, { body: [] }]);

    // Act + Assert
    await assert.rejects(listAllPages(fake.http, TARGET, FIRST, integers), /not a page of integers/);
    assert.equal(fake.requests.length, 1);
  });

  it("throws GitHubSchemaError when rel=next returns to the first URL", async () => {
    const fake = createFakeHttp([{ body: [], link: `<${FIRST}>; rel="next"` }]);
    await assert.rejects(listAllPages(fake.http, TARGET, FIRST, integers), schemaError(/loops back/));
    assert.equal(fake.requests.length, 1);
  });
});
