import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FetchBudgetExceededError, HttpError } from "../../src/http.ts";
import type { JsonValue } from "../../src/json.ts";
import { fetchProjectIssues } from "../../src/youtrack.ts";
import {
  BASE_URL,
  FAKE_MAX_FETCHES,
  FIRST_PAGE_URL,
  SOURCE,
  assertOnlyIssueGets,
  failAfter,
  issueRow,
  issueRows,
  schemaError,
  serveBodies,
  skipsOf,
  withoutFields,
} from "./fixtures.ts";

// ---------------------------------------------------------------------------
// fetchProjectIssues: malformed responses fail the whole scan
// ---------------------------------------------------------------------------

describe("fetchProjectIssues: schema errors", () => {
  const nonArrayBodies: readonly { readonly body: JsonValue; readonly kind: string }[] = [
    { body: { error: "bad_request", error_description: "nope" }, kind: "object" },
    { body: null, kind: "null" },
    { body: "[]", kind: "string" },
    { body: 0, kind: "number" },
  ];
  for (const { body, kind } of nonArrayBodies) {
    it(`throws YouTrackSchemaError when the body is a JSON ${kind}`, async () => {
      // Arrange
      const fake = serveBodies([body]);

      // Act + Assert
      await assert.rejects(
        fetchProjectIssues(fake.http, SOURCE),
        schemaError(new RegExp(`page at \\$skip=0 must be a JSON array, got ${kind}$`)),
      );
      assert.equal(fake.requests.length, 1);
      assertOnlyIssueGets(fake.requests);
    });
  }

  it("throws YouTrackSchemaError when a later page is not an array", async () => {
    // Arrange
    const fake = serveBodies([issueRows(1, 100), { unexpected: true }]);

    // Act + Assert
    await assert.rejects(
      fetchProjectIssues(fake.http, SOURCE),
      schemaError(/page at \$skip=100 must be a JSON array, got object$/),
    );
    assert.equal(fake.requests.length, 2);
    assertOnlyIssueGets(fake.requests);
  });

  it("stops paging at the first invalid row, even on a full page", async () => {
    // Arrange
    const page = [...issueRows(1, 50), withoutFields(issueRow(51), ["summary"]), ...issueRows(52, 49)];
    const fake = serveBodies([page, issueRows(101, 1)]);

    // Act + Assert
    await assert.rejects(
      fetchProjectIssues(fake.http, SOURCE),
      schemaError(/^YouTrack issue "CUI-51" is missing field\(s\) "summary"$/),
    );
    assert.equal(fake.requests.length, 1);
    assertOnlyIssueGets(fake.requests);
  });

  it("rejects a row with a wrong type on a later page", async () => {
    // Arrange
    const fake = serveBodies([issueRows(1, 100), [issueRow(101, { resolved: "yesterday" })]]);

    // Act + Assert
    await assert.rejects(
      fetchProjectIssues(fake.http, SOURCE),
      schemaError(/^YouTrack issue "CUI-101": field "resolved" must be a safe integer or null, got string$/),
    );
    assert.equal(fake.requests.length, 2);
    assertOnlyIssueGets(fake.requests);
  });

  it("rejects a page containing a row that is not an object", async () => {
    // Arrange
    const fake = serveBodies([[issueRow(1), null, issueRow(3)]]);

    // Act + Assert
    await assert.rejects(
      fetchProjectIssues(fake.http, SOURCE),
      schemaError(/^YouTrack issue row must be a JSON object, got null$/),
    );
  });

  it("fails the whole scan on a non-positive numberInProject", async () => {
    // Arrange
    const fake = serveBodies([[issueRow(1), issueRow(2, { numberInProject: 0 })]]);

    // Act + Assert
    await assert.rejects(
      fetchProjectIssues(fake.http, SOURCE),
      schemaError(/^YouTrack issue "CUI-2": field "numberInProject" must be a positive safe integer/),
    );
  });
});

// ---------------------------------------------------------------------------
// fetchProjectIssues: HTTP client errors propagate unchanged
// ---------------------------------------------------------------------------

describe("fetchProjectIssues: HTTP errors", () => {
  it("propagates an HttpError from the first request unchanged", async () => {
    // Arrange
    const failure = new HttpError("GET", FIRST_PAGE_URL, 400, "invalid query");
    const fake = failAfter([], failure);

    // Act + Assert
    await assert.rejects(fetchProjectIssues(fake.http, SOURCE), (error) => error === failure);
    assert.equal(fake.requests.length, 1);
    assertOnlyIssueGets(fake.requests);
  });

  it("propagates an HttpError from a later page and makes no further requests", async () => {
    // Arrange
    const failure = new HttpError("GET", `${BASE_URL}/api/issues`, 503, "unavailable");
    const fake = failAfter([issueRows(1, 100)], failure);

    // Act + Assert
    await assert.rejects(fetchProjectIssues(fake.http, SOURCE), (error) => error === failure);
    assert.deepEqual(skipsOf(fake.requests), ["0", "100"]);
    assertOnlyIssueGets(fake.requests);
  });

  it("propagates a FetchBudgetExceededError from the HTTP client", async () => {
    // Arrange
    const failure = new FetchBudgetExceededError(FAKE_MAX_FETCHES);
    const fake = failAfter([issueRows(1, 100), issueRows(101, 100)], failure);

    // Act + Assert
    await assert.rejects(fetchProjectIssues(fake.http, SOURCE), (error) => error === failure);
    assert.equal(fake.requests.length, 3);
    assertOnlyIssueGets(fake.requests);
  });
});
