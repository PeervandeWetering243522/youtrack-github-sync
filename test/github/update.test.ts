import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { updateIssue } from "../../src/github/issues.ts";
import type { IssueUpdate } from "../../src/github/issues.ts";
import {
  EXPECTED_HEADERS,
  ISSUES_URL,
  TARGET,
  TOKEN,
  createFakeHttp,
  httpError,
  issueJson,
  parentUrl,
  requestAt,
  schemaError,
} from "./fixtures.ts";

const TITLE = "[CUI-15] Fix login";
const UPDATED = issueJson({ number: 21, id: 55, title: TITLE, milestone: { number: 2 }, type: { name: "Task" } });

describe("updateIssue", () => {
  it("PATCHes milestone and type in one request with retry-once", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: UPDATED }]);

    // Act
    await updateIssue(fake.http, TARGET, 21, { milestone: 2, type: "Task" });

    // Assert
    assert.equal(fake.requests.length, 1);
    const request = requestAt(fake.requests, 0);
    assert.equal(request.method, "PATCH");
    assert.equal(request.url, `${ISSUES_URL}/21`);
    assert.deepEqual(request.headers, EXPECTED_HEADERS);
    assert.equal(request.retry, "retry-once");
    assert.deepEqual(request.body, { milestone: 2, type: "Task" });
    assert.equal(JSON.stringify(request.body), '{"milestone":2,"type":"Task"}');
  });

  it("sends only the milestone when no type is given", async () => {
    const fake = createFakeHttp([{ body: UPDATED }]);
    await updateIssue(fake.http, TARGET, 21, { milestone: 3 });
    assert.deepEqual(requestAt(fake.requests, 0).body, { milestone: 3 });
  });

  for (const type of ["Feature", "Bug", "Task"] as const) {
    it(`sends only the type ${type} when no milestone is given`, async () => {
      const fake = createFakeHttp([{ body: UPDATED }]);
      await updateIssue(fake.http, TARGET, 21, { type });
      assert.deepEqual(requestAt(fake.requests, 0).body, { type });
    });
  }

  it("clears the milestone with an explicit JSON null", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: UPDATED }]);

    // Act
    await updateIssue(fake.http, TARGET, 21, { milestone: null });

    // Assert
    const sent = requestAt(fake.requests, 0).body;
    assert.deepEqual(sent, { milestone: null });
    assert.equal(JSON.stringify(sent), '{"milestone":null}');
  });

  it("clears the milestone and sets the type in the same request", async () => {
    const fake = createFakeHttp([{ body: UPDATED }]);
    await updateIssue(fake.http, TARGET, 21, { milestone: null, type: "Bug" });
    assert.equal(JSON.stringify(requestAt(fake.requests, 0).body), '{"milestone":null,"type":"Bug"}');
  });

  it("PATCHes only the title, with retry-once, when nothing else changes (N2)", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: UPDATED }]);

    // Act
    await updateIssue(fake.http, TARGET, 21, { title: TITLE });

    // Assert
    assert.equal(fake.requests.length, 1);
    const request = requestAt(fake.requests, 0);
    assert.equal(request.method, "PATCH");
    assert.equal(request.url, `${ISSUES_URL}/21`);
    assert.deepEqual(request.headers, EXPECTED_HEADERS);
    assert.equal(request.retry, "retry-once");
    assert.equal(JSON.stringify(request.body), '{"title":"[CUI-15] Fix login"}');
  });

  it("PATCHes title, milestone and type in one request", async () => {
    const fake = createFakeHttp([{ body: UPDATED }]);
    await updateIssue(fake.http, TARGET, 21, { title: TITLE, milestone: 2, type: "Task" });
    assert.equal(fake.requests.length, 1);
    assert.deepEqual(requestAt(fake.requests, 0).body, { title: TITLE, milestone: 2, type: "Task" });
  });

  it("sends the title with only a milestone, or with only a type", async () => {
    const fake = createFakeHttp([{ body: UPDATED }, { body: UPDATED }]);
    await updateIssue(fake.http, TARGET, 21, { title: TITLE, milestone: null });
    await updateIssue(fake.http, TARGET, 21, { title: TITLE, type: "Bug" });
    assert.equal(JSON.stringify(requestAt(fake.requests, 0).body), '{"title":"[CUI-15] Fix login","milestone":null}');
    assert.equal(JSON.stringify(requestAt(fake.requests, 1).body), '{"title":"[CUI-15] Fix login","type":"Bug"}');
  });

  it("sends the title exactly as given, without trimming or escaping it", async () => {
    const title = ' [CUI-15] "quoted" <b>ü</b> 😀 @bob #3 … ';
    const fake = createFakeHttp([{ body: UPDATED }]);
    await updateIssue(fake.http, TARGET, 21, { title });
    assert.deepEqual(requestAt(fake.requests, 0).body, { title });
  });

  it("returns the title from the response, so the caller can see whether it was applied", async () => {
    const response = issueJson({ number: 21, id: 55, title: "[YT-15] Fix login" });
    const fake = createFakeHttp([{ body: response }]);
    const issue = await updateIssue(fake.http, TARGET, 21, { title: TITLE });
    assert.equal(issue.title, "[YT-15] Fix login");
  });

  it("returns the issue parsed from the response against the target repository", async () => {
    // Arrange
    const response = issueJson({
      number: 21,
      id: 55,
      milestone: null,
      type: { name: "Bug" },
      parent_issue_url: parentUrl(9),
    });
    const fake = createFakeHttp([{ body: response }]);

    // Act
    const issue = await updateIssue(fake.http, TARGET, 21, { milestone: null, type: "Bug" });

    // Assert
    assert.deepEqual(
      [issue.number, issue.id, issue.milestoneNumber, issue.typeName, issue.parentNumber, issue.parentIsForeign],
      [21, 55, null, "Bug", 9, false],
    );
  });

  for (const [kind, responseBody] of [
    ["null (empty body)", null],
    ["object without number", { message: "ok" }],
    ["array", [UPDATED]],
  ] as const) {
    it(`throws GitHubSchemaError for a response body that is a JSON ${kind}`, async () => {
      const fake = createFakeHttp([{ body: responseBody }]);
      await assert.rejects(updateIssue(fake.http, TARGET, 21, { type: "Task" }), schemaError(/GitHub issue/));
    });
  }

  it("refuses an update with none of title, milestone and type before sending anything", async () => {
    const fake = createFakeHttp([{ body: UPDATED }]);
    await assert.rejects(updateIssue(fake.http, TARGET, 21, {}), {
      name: "RangeError",
      message: "GitHub issue update needs a title, milestone or type to change",
    });
    assert.equal(fake.requests.length, 0);
  });

  it("refuses a bad milestone number even next to a title, before sending anything", async () => {
    const fake = createFakeHttp([{ body: UPDATED }]);
    await assert.rejects(updateIssue(fake.http, TARGET, 21, { title: TITLE, milestone: 0 }), {
      name: "RangeError",
      message: /GitHub milestone number must be a positive integer/,
    });
    assert.equal(fake.requests.length, 0);
  });

  for (const milestone of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
    it(`refuses milestone ${String(milestone)} before sending anything (JSON would turn NaN into null)`, async () => {
      const fake = createFakeHttp([{ body: UPDATED }]);
      await assert.rejects(updateIssue(fake.http, TARGET, 21, { milestone, type: "Task" }), {
        name: "RangeError",
        message: /GitHub milestone number must be a positive integer/,
      });
      assert.equal(fake.requests.length, 0);
    });
  }

  for (const issueNumber of [0, -1, 1.5, Number.NaN]) {
    it(`refuses issue number ${String(issueNumber)} before sending anything`, async () => {
      const fake = createFakeHttp([{ body: UPDATED }]);
      await assert.rejects(updateIssue(fake.http, TARGET, issueNumber, { type: "Task" }), {
        name: "RangeError",
        message: /issue number/,
      });
      assert.equal(fake.requests.length, 0);
    });
  }

  it("percent-encodes owner and repo in the PATCH URL", async () => {
    const fake = createFakeHttp([{ body: UPDATED }]);
    await updateIssue(fake.http, { owner: "o w", repo: "r#1", token: TOKEN }, 4, { type: "Task" });
    assert.equal(requestAt(fake.requests, 0).url, "https://api.github.com/repos/o%20w/r%231/issues/4");
  });

  it("propagates an HttpError from the client", async () => {
    const failure = httpError(422);
    const fake = createFakeHttp([], failure);
    await assert.rejects(updateIssue(fake.http, TARGET, 21, { type: "Task" }), (error: Error) => error === failure);
    assert.equal(fake.requests.length, 1);
  });

  it("does not mutate or alias the caller's patch", async () => {
    // Arrange
    const patch: IssueUpdate = Object.freeze({ title: TITLE, milestone: 2, type: "Task" });
    const fake = createFakeHttp([{ body: UPDATED }]);

    // Act
    await updateIssue(fake.http, TARGET, 21, patch);

    // Assert
    assert.deepEqual(patch, { title: TITLE, milestone: 2, type: "Task" });
    assert.notEqual(requestAt(fake.requests, 0).body, patch);
  });
});
