import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addSubIssue, removeSubIssue } from "../../src/github/sub-issues.ts";
import { HttpError } from "../../src/http.ts";
import { EXPECTED_HEADERS, ISSUES_URL, TARGET, TOKEN, createFakeHttp, issueJson, requestAt } from "./fixtures.ts";

const CHILD_ID = 3_400_000_025;
const BAD_IDS = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53] as const;

// ---------------------------------------------------------------------------
// addSubIssue
// ---------------------------------------------------------------------------

describe("addSubIssue", () => {
  for (const replaceParent of [true, false]) {
    it(`POSTs sub_issue_id and replace_parent ${String(replaceParent)} to the parent's sub_issues with retry-once`, async () => {
      // Arrange
      const fake = createFakeHttp([{ status: 201, body: issueJson({ number: 24 }) }]);

      // Act
      await addSubIssue(fake.http, TARGET, 24, CHILD_ID, replaceParent);

      // Assert
      assert.equal(fake.requests.length, 1);
      const request = requestAt(fake.requests, 0);
      assert.equal(request.method, "POST");
      assert.equal(request.url, `${ISSUES_URL}/24/sub_issues`);
      assert.deepEqual(request.headers, EXPECTED_HEADERS);
      assert.equal(request.retry, "retry-once");
      assert.deepEqual(request.body, { sub_issue_id: CHILD_ID, replace_parent: replaceParent });
    });
  }

  it("serialises sub_issue_id as a JSON integer, not a string", async () => {
    // Arrange
    const fake = createFakeHttp([{ status: 201, body: null }]);

    // Act
    await addSubIssue(fake.http, TARGET, 24, CHILD_ID, true);

    // Assert
    assert.equal(JSON.stringify(requestAt(fake.requests, 0).body), '{"sub_issue_id":3400000025,"replace_parent":true}');
  });

  it("does not validate the response body", async () => {
    const fake = createFakeHttp([{ status: 201, body: null }]);
    await addSubIssue(fake.http, TARGET, 24, CHILD_ID, false);
    assert.equal(fake.requests.length, 1);
  });

  it("accepts the largest safe child id", async () => {
    const fake = createFakeHttp([{ status: 201, body: null }]);
    await addSubIssue(fake.http, TARGET, 24, Number.MAX_SAFE_INTEGER, true);
    assert.deepEqual(requestAt(fake.requests, 0).body, { sub_issue_id: Number.MAX_SAFE_INTEGER, replace_parent: true });
  });

  for (const childId of BAD_IDS) {
    it(`refuses child id ${String(childId)} before sending anything`, async () => {
      const fake = createFakeHttp([]);
      await assert.rejects(addSubIssue(fake.http, TARGET, 24, childId, true), {
        name: "RangeError",
        message: /GitHub sub-issue id must be a positive integer/,
      });
      assert.equal(fake.requests.length, 0);
    });
  }

  for (const parentNumber of [0, -1, 1.5, Number.NaN]) {
    it(`refuses parent number ${String(parentNumber)} before sending anything`, async () => {
      const fake = createFakeHttp([]);
      await assert.rejects(addSubIssue(fake.http, TARGET, parentNumber, CHILD_ID, true), {
        name: "RangeError",
        message: /issue number/,
      });
      assert.equal(fake.requests.length, 0);
    });
  }

  it("percent-encodes owner and repo and refuses a dot-segment repo", async () => {
    // Arrange
    const fake = createFakeHttp([{ status: 201, body: null }]);

    // Act
    await addSubIssue(fake.http, { owner: "o w", repo: "r#1", token: TOKEN }, 3, CHILD_ID, true);

    // Assert
    assert.equal(requestAt(fake.requests, 0).url, "https://api.github.com/repos/o%20w/r%231/issues/3/sub_issues");
    await assert.rejects(
      addSubIssue(fake.http, { owner: "o", repo: "..", token: TOKEN }, 3, CHILD_ID, true),
      RangeError,
    );
    assert.equal(fake.requests.length, 1);
  });

  it("propagates an HttpError (e.g. 422 for a 101st sub-issue)", async () => {
    const failure = new HttpError("POST", `${ISSUES_URL}/24/sub_issues`, 422, '{"message":"Validation Failed"}');
    const fake = createFakeHttp([], failure);
    await assert.rejects(addSubIssue(fake.http, TARGET, 24, CHILD_ID, true), (error: Error) => error === failure);
  });
});

// ---------------------------------------------------------------------------
// removeSubIssue
// ---------------------------------------------------------------------------

describe("removeSubIssue", () => {
  it("DELETEs the parent's sub_issue with a JSON body of sub_issue_id and retry-once", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: issueJson({ number: 24 }) }]);

    // Act
    await removeSubIssue(fake.http, TARGET, 24, CHILD_ID);

    // Assert
    assert.equal(fake.requests.length, 1);
    const request = requestAt(fake.requests, 0);
    assert.equal(request.method, "DELETE");
    assert.equal(request.url, `${ISSUES_URL}/24/sub_issue`);
    assert.deepEqual(request.headers, EXPECTED_HEADERS);
    assert.equal(request.retry, "retry-once");
    assert.equal(JSON.stringify(request.body), '{"sub_issue_id":3400000025}');
  });

  it("does not validate the response body", async () => {
    const fake = createFakeHttp([{ body: null }]);
    await removeSubIssue(fake.http, TARGET, 24, CHILD_ID);
    assert.equal(fake.requests.length, 1);
  });

  for (const childId of BAD_IDS) {
    it(`refuses child id ${String(childId)} before sending anything`, async () => {
      const fake = createFakeHttp([]);
      await assert.rejects(removeSubIssue(fake.http, TARGET, 24, childId), {
        name: "RangeError",
        message: /GitHub sub-issue id must be a positive integer/,
      });
      assert.equal(fake.requests.length, 0);
    });
  }

  it("refuses a bad parent number before sending anything", async () => {
    const fake = createFakeHttp([]);
    await assert.rejects(removeSubIssue(fake.http, TARGET, 0, CHILD_ID), {
      name: "RangeError",
      message: /issue number/,
    });
    assert.equal(fake.requests.length, 0);
  });

  it("percent-encodes owner and repo in the DELETE URL", async () => {
    const fake = createFakeHttp([{ body: null }]);
    await removeSubIssue(fake.http, { owner: "o w", repo: "r?x", token: TOKEN }, 3, CHILD_ID);
    assert.equal(requestAt(fake.requests, 0).url, "https://api.github.com/repos/o%20w/r%3Fx/issues/3/sub_issue");
  });

  it("propagates an HttpError (e.g. 404 when the child is not a sub-issue of that parent)", async () => {
    const failure = new HttpError("DELETE", `${ISSUES_URL}/24/sub_issue`, 404, '{"message":"Not Found"}');
    const fake = createFakeHttp([], failure);
    await assert.rejects(removeSubIssue(fake.http, TARGET, 24, CHILD_ID), (error: Error) => error === failure);
  });
});
