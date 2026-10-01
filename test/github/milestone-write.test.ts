import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { closeMilestone, createMilestone, renameMilestone } from "../../src/github/milestones.ts";
import type { NewMilestone } from "../../src/github/milestones.ts";
import { HttpError } from "../../src/http.ts";
import {
  EXPECTED_HEADERS,
  MILESTONES_URL,
  TARGET,
  TOKEN,
  createFakeHttp,
  milestoneJson,
  requestAt,
  schemaError,
} from "./fixtures.ts";

// ---------------------------------------------------------------------------
// createMilestone
// ---------------------------------------------------------------------------

describe("createMilestone", () => {
  const input: NewMilestone = {
    title: "[CUI-33] Data Structures",
    description: "Epic text\n\n---\nMirrored from YouTrack: https://youtrack.example.test/issue/CUI-33",
  };
  const created = milestoneJson({ number: 6, title: input.title, description: input.description });

  it("POSTs exactly title and description to the milestones URL with no-retry", async () => {
    // Arrange
    const fake = createFakeHttp([{ status: 201, body: created }]);

    // Act
    await createMilestone(fake.http, TARGET, input);

    // Assert
    assert.equal(fake.requests.length, 1);
    const request = requestAt(fake.requests, 0);
    assert.equal(request.method, "POST");
    assert.equal(request.url, MILESTONES_URL);
    assert.deepEqual(request.headers, EXPECTED_HEADERS);
    assert.equal(request.retry, "no-retry");
    assert.deepEqual(request.body, { title: input.title, description: input.description });
  });

  it("returns the milestone parsed from the 201 response (its number, not the request's)", async () => {
    const fake = createFakeHttp([{ status: 201, body: created }]);
    assert.deepEqual(await createMilestone(fake.http, TARGET, input), { number: 6, title: input.title, state: "open" });
  });

  it("sends an empty description as an empty string", async () => {
    const fake = createFakeHttp([{ status: 201, body: created }]);
    await createMilestone(fake.http, TARGET, { title: "[CUI-1] t", description: "" });
    assert.deepEqual(requestAt(fake.requests, 0).body, { title: "[CUI-1] t", description: "" });
  });

  it("sends no keys beyond title and description, even if the caller's object has more", async () => {
    // Arrange: a wider object is assignable to NewMilestone; state or due_on must never leak into the create.
    const wider = { ...input, state: "closed", due_on: "2027-01-01T00:00:00Z" };
    const fake = createFakeHttp([{ status: 201, body: created }]);

    // Act
    await createMilestone(fake.http, TARGET, wider);

    // Assert
    assert.deepEqual(Object.keys(requestAt(fake.requests, 0).body ?? {}), ["title", "description"]);
  });

  for (const status of [200, 202, 204]) {
    it(`rejects HTTP ${String(status)} even with a valid body (only 201 proves a create)`, async () => {
      // Arrange
      const fake = createFakeHttp([{ status, body: created }]);

      // Act + Assert
      await assert.rejects(
        createMilestone(fake.http, TARGET, input),
        schemaError(new RegExp(`create milestone must answer HTTP 201, got HTTP ${String(status)}`)),
      );
      assert.equal(fake.requests.length, 1);
    });
  }

  for (const [kind, body] of [
    ["null", null],
    ["array", [created]],
    ["object without number", { message: "ok" }],
  ] as const) {
    it(`throws GitHubSchemaError for a 201 whose body is a JSON ${kind}`, async () => {
      const fake = createFakeHttp([{ status: 201, body }]);
      await assert.rejects(createMilestone(fake.http, TARGET, input), schemaError(/GitHub milestone/));
    });
  }

  it("propagates an HttpError (e.g. 422 already_exists) without retrying", async () => {
    // Arrange
    const failure = new HttpError("POST", MILESTONES_URL, 422, '{"errors":[{"code":"already_exists"}]}');
    const fake = createFakeHttp([], failure);

    // Act + Assert
    await assert.rejects(createMilestone(fake.http, TARGET, input), (error: Error) => error === failure);
    assert.equal(fake.requests.length, 1);
  });

  it("does not mutate the caller's input", async () => {
    const frozen = Object.freeze({ ...input });
    const fake = createFakeHttp([{ status: 201, body: created }]);
    await createMilestone(fake.http, TARGET, frozen);
    assert.deepEqual(frozen, input);
  });

  it("percent-encodes owner and repo and refuses a dot-segment repo before sending", async () => {
    // Arrange
    const fake = createFakeHttp([{ status: 201, body: created }]);

    // Act
    await createMilestone(fake.http, { owner: "o w", repo: "r#1", token: TOKEN }, input);

    // Assert
    assert.equal(requestAt(fake.requests, 0).url, "https://api.github.com/repos/o%20w/r%231/milestones");
    await assert.rejects(createMilestone(fake.http, { owner: "o", repo: ".", token: TOKEN }, input), RangeError);
    assert.equal(fake.requests.length, 1);
  });
});

// ---------------------------------------------------------------------------
// renameMilestone
// ---------------------------------------------------------------------------

describe("renameMilestone", () => {
  const title = "[CUI-33] Data Structures";

  it("PATCHes exactly the title with retry-once, like closeMilestone", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: milestoneJson({ number: 6, title }) }]);

    // Act
    await renameMilestone(fake.http, TARGET, 6, title);

    // Assert
    assert.equal(fake.requests.length, 1);
    const request = requestAt(fake.requests, 0);
    assert.equal(request.method, "PATCH");
    assert.equal(request.url, `${MILESTONES_URL}/6`);
    assert.deepEqual(request.headers, EXPECTED_HEADERS);
    assert.equal(request.retry, "retry-once");
    assert.equal(JSON.stringify(request.body), '{"title":"[CUI-33] Data Structures"}');
  });

  it("never sends a state or description, so a closed milestone stays closed (D7)", async () => {
    const fake = createFakeHttp([{ body: milestoneJson({ number: 6, title, state: "closed" }) }]);
    await renameMilestone(fake.http, TARGET, 6, title);
    assert.deepEqual(Object.keys(requestAt(fake.requests, 0).body ?? {}), ["title"]);
  });

  it("sends the title exactly as given, without trimming or escaping it", async () => {
    const odd = ' [CUI-33] "quoted" <b>ü</b> 😀 @bob #3 … ';
    const fake = createFakeHttp([{ body: null }]);
    await renameMilestone(fake.http, TARGET, 6, odd);
    assert.deepEqual(requestAt(fake.requests, 0).body, { title: odd });
  });

  it("does not validate the response body", async () => {
    const fake = createFakeHttp([{ body: null }]);
    await renameMilestone(fake.http, TARGET, 6, title);
    assert.equal(fake.requests.length, 1);
  });

  for (const milestoneNumber of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
    it(`refuses milestone number ${String(milestoneNumber)} before sending anything`, async () => {
      const fake = createFakeHttp([]);
      await assert.rejects(renameMilestone(fake.http, TARGET, milestoneNumber, title), {
        name: "RangeError",
        message: /GitHub milestone number must be a positive integer/,
      });
      assert.equal(fake.requests.length, 0);
    });
  }

  it("percent-encodes owner and repo in the PATCH URL", async () => {
    const fake = createFakeHttp([{ body: null }]);
    await renameMilestone(fake.http, { owner: "o w", repo: "r?x", token: TOKEN }, 2, title);
    assert.equal(requestAt(fake.requests, 0).url, "https://api.github.com/repos/o%20w/r%3Fx/milestones/2");
  });

  it("propagates an HttpError from the client", async () => {
    const failure = new HttpError("PATCH", `${MILESTONES_URL}/6`, 422, '{"message":"Validation Failed"}');
    const fake = createFakeHttp([], failure);
    await assert.rejects(renameMilestone(fake.http, TARGET, 6, title), (error: Error) => error === failure);
    assert.equal(fake.requests.length, 1);
  });
});

// ---------------------------------------------------------------------------
// closeMilestone
// ---------------------------------------------------------------------------

describe("closeMilestone", () => {
  it("PATCHes the milestone with state closed and retry-once", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: milestoneJson({ number: 6, state: "closed" }) }]);

    // Act
    await closeMilestone(fake.http, TARGET, 6);

    // Assert
    assert.equal(fake.requests.length, 1);
    const request = requestAt(fake.requests, 0);
    assert.equal(request.method, "PATCH");
    assert.equal(request.url, `${MILESTONES_URL}/6`);
    assert.deepEqual(request.headers, EXPECTED_HEADERS);
    assert.equal(request.retry, "retry-once");
    assert.deepEqual(request.body, { state: "closed" });
  });

  it("does not validate the response body", async () => {
    const fake = createFakeHttp([{ body: null }]);
    await closeMilestone(fake.http, TARGET, 6);
    assert.equal(fake.requests.length, 1);
  });

  for (const milestoneNumber of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
    it(`refuses milestone number ${String(milestoneNumber)} before sending anything`, async () => {
      const fake = createFakeHttp([]);
      await assert.rejects(closeMilestone(fake.http, TARGET, milestoneNumber), {
        name: "RangeError",
        message: /GitHub milestone number must be a positive integer/,
      });
      assert.equal(fake.requests.length, 0);
    });
  }

  it("percent-encodes owner and repo in the PATCH URL", async () => {
    const fake = createFakeHttp([{ body: null }]);
    await closeMilestone(fake.http, { owner: "o w", repo: "r?x", token: TOKEN }, 2);
    assert.equal(requestAt(fake.requests, 0).url, "https://api.github.com/repos/o%20w/r%3Fx/milestones/2");
  });

  it("propagates an HttpError from the client", async () => {
    const failure = new HttpError("PATCH", `${MILESTONES_URL}/6`, 404, '{"message":"Not Found"}');
    const fake = createFakeHttp([], failure);
    await assert.rejects(closeMilestone(fake.http, TARGET, 6), (error: Error) => error === failure);
  });
});
