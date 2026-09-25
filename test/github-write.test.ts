import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addLabel, closeIssue, createIssue } from "../src/github.ts";
import type { CreateIssueBody, GitHubTarget } from "../src/github.ts";
import {
  EXPECTED_HEADERS,
  ISSUES_URL,
  TARGET,
  TOKEN,
  createFakeHttp,
  httpError,
  issueJson,
  requestAt,
  schemaError,
} from "./github-fixtures.ts";

// ---------------------------------------------------------------------------
// createIssue
// ---------------------------------------------------------------------------

describe("createIssue", () => {
  const body: CreateIssueBody = {
    title: "[YT-12] Mirror me",
    body: "Some text\n\n---\nMirrored from YouTrack: https://youtrack.example.test/issue/CUI-12",
    labels: ["youtrack"],
  };
  const created = issueJson({ number: 101, title: "[YT-12] Mirror me", labels: [{ id: 5, name: "youtrack" }] });

  it("POSTs the body unchanged to the issues URL with no-retry", async () => {
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

  it("returns the created issue parsed from the 201 response", async () => {
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

  it("reports a dropped label as an empty labelNames list", async () => {
    const fake = createFakeHttp([{ status: 201, body: issueJson({ number: 102, labels: [] }) }]);
    assert.deepEqual((await createIssue(fake.http, TARGET, body)).labelNames, []);
  });

  it("sends a title-only body without adding keys", async () => {
    // Arrange
    const fake = createFakeHttp([{ status: 201, body: created }]);

    // Act
    await createIssue(fake.http, TARGET, { title: "[YT-1] Only a title" });

    // Assert
    assert.deepEqual(requestAt(fake.requests, 0).body, { title: "[YT-1] Only a title" });
  });

  it("throws GitHubSchemaError when the response is not an issue", async () => {
    const fake = createFakeHttp([{ status: 201, body: { message: "ok" } }]);
    await assert.rejects(createIssue(fake.http, TARGET, body), schemaError(/"number"/));
  });

  for (const [kind, responseBody] of [
    ["null (empty 201 body)", null],
    ["array", [created]],
  ] as const) {
    it(`throws GitHubSchemaError for a 201 whose body is a JSON ${kind}`, async () => {
      const fake = createFakeHttp([{ status: 201, body: responseBody }]);
      await assert.rejects(createIssue(fake.http, TARGET, body), schemaError(/must be a JSON object/));
    });
  }

  it("returns the issue number from the response, not from the request", async () => {
    // Arrange: sync records the new mirror under this number (docs/03 section 10).
    const fake = createFakeHttp([{ status: 201, body: issueJson({ number: 4242, title: "server title" }) }]);

    // Act
    const issue = await createIssue(fake.http, TARGET, { title: "[YT-1] client title" });

    // Assert
    assert.equal(issue.number, 4242);
    assert.equal(issue.title, "server title");
  });

  it("propagates an HttpError (e.g. 422) without retrying", async () => {
    // Arrange
    const failure = httpError(422);
    const fake = createFakeHttp([], failure);

    // Act + Assert
    await assert.rejects(createIssue(fake.http, TARGET, body), (error: Error) => error === failure);
    assert.equal(fake.requests.length, 1);
  });

  for (const status of [200, 202]) {
    it(`rejects a ${String(status)} response even with a valid issue body (only 201 proves a create)`, async () => {
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

  it("checks the status before the body (204 with an empty body)", async () => {
    const fake = createFakeHttp([{ status: 204, body: null }]);
    await assert.rejects(createIssue(fake.http, TARGET, body), schemaError(/got HTTP 204/));
  });

  it("does not mutate the caller's body", async () => {
    // Arrange
    const input: CreateIssueBody = { title: "[YT-3] t", body: "b", labels: ["youtrack", { name: "x" }] };
    const snapshot = structuredClone(input);
    const fake = createFakeHttp([{ status: 201, body: created }]);

    // Act
    await createIssue(fake.http, TARGET, input);

    // Assert
    assert.deepEqual(input, snapshot);
  });

  it("passes label objects and a numeric title through unchanged", async () => {
    // Arrange: both forms are allowed by GitHub's create schema.
    const input: CreateIssueBody = { title: 42, labels: [{ name: "youtrack" }, "bug"] };
    const fake = createFakeHttp([{ status: 201, body: created }]);

    // Act
    await createIssue(fake.http, TARGET, input);

    // Assert
    assert.deepEqual(requestAt(fake.requests, 0).body, { title: 42, labels: [{ name: "youtrack" }, "bug"] });
  });

  it("percent-encodes owner and repo in the create URL", async () => {
    // Arrange
    const fake = createFakeHttp([{ status: 201, body: created }]);

    // Act
    await createIssue(fake.http, { owner: "o w", repo: "r#1", token: TOKEN }, body);

    // Assert
    assert.equal(requestAt(fake.requests, 0).url, "https://api.github.com/repos/o%20w/r%231/issues");
  });

  it("refuses a dot-segment repo before sending the create", async () => {
    const fake = createFakeHttp([{ status: 201, body: created }]);
    await assert.rejects(createIssue(fake.http, { owner: "o", repo: ".", token: TOKEN }, body), RangeError);
    assert.equal(fake.requests.length, 0);
  });

  it("returns a pull-request flag and closed state as reported by the response", async () => {
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
// closeIssue
// ---------------------------------------------------------------------------

describe("closeIssue", () => {
  it("PATCHes the issue with state closed / completed and retry-once", async () => {
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

  it("does not validate the PATCH response body", async () => {
    const fake = createFakeHttp([{ body: null }]);
    await closeIssue(fake.http, TARGET, 7);
    assert.equal(fake.requests.length, 1);
  });

  it("propagates an HttpError from the client", async () => {
    const failure = httpError(404);
    const fake = createFakeHttp([], failure);
    await assert.rejects(closeIssue(fake.http, TARGET, 7), (error: Error) => error === failure);
  });

  for (const issueNumber of [0, -0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
    it(`rejects issue number ${Object.is(issueNumber, -0) ? "-0" : String(issueNumber)} before sending anything`, async () => {
      const fake = createFakeHttp([]);
      await assert.rejects(closeIssue(fake.http, TARGET, issueNumber), RangeError);
      assert.equal(fake.requests.length, 0);
    });
  }

  it("accepts the largest safe issue number", async () => {
    const fake = createFakeHttp([{ body: null }]);
    await closeIssue(fake.http, TARGET, Number.MAX_SAFE_INTEGER);
    assert.equal(requestAt(fake.requests, 0).url, `${ISSUES_URL}/9007199254740991`);
  });

  it("percent-encodes owner and repo in the PATCH URL", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: null }]);

    // Act
    await closeIssue(fake.http, { owner: "o w", repo: "r?x", token: TOKEN }, 4);

    // Assert
    assert.equal(requestAt(fake.requests, 0).url, "https://api.github.com/repos/o%20w/r%3Fx/issues/4");
  });

  it("refuses a dot-segment owner before sending the PATCH", async () => {
    const fake = createFakeHttp([{ body: null }]);
    await assert.rejects(closeIssue(fake.http, { owner: "..", repo: "r", token: TOKEN }, 4), RangeError);
    assert.equal(fake.requests.length, 0);
  });
});

// ---------------------------------------------------------------------------
// addLabel
// ---------------------------------------------------------------------------

describe("addLabel", () => {
  it("POSTs {labels: [label]} to the issue's labels URL with retry-once", async () => {
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

  it("uses the encoded owner/repo path of the target", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: [] }]);
    const target: GitHubTarget = { owner: "o w", repo: "r/x", token: TOKEN };

    // Act
    await addLabel(fake.http, target, 3, "youtrack");

    // Assert
    assert.equal(requestAt(fake.requests, 0).url, "https://api.github.com/repos/o%20w/r%2Fx/issues/3/labels");
  });

  it("propagates an HttpError from the client", async () => {
    const failure = httpError(403);
    const fake = createFakeHttp([], failure);
    await assert.rejects(addLabel(fake.http, TARGET, 12, "youtrack"), (error: Error) => error === failure);
  });

  for (const issueNumber of [0, -12, 12.5, Number.NaN, Number.NEGATIVE_INFINITY, 2 ** 53]) {
    it(`rejects issue number ${String(issueNumber)} before sending anything`, async () => {
      const fake = createFakeHttp([]);
      await assert.rejects(addLabel(fake.http, TARGET, issueNumber, "youtrack"), RangeError);
      assert.equal(fake.requests.length, 0);
    });
  }

  it("sends an unusual label verbatim in the body and never in the URL", async () => {
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
