import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { listAllMilestones, parseGitHubMilestone } from "../src/github/milestones.ts";
import type { GitHubMilestone } from "../src/github/milestones.ts";
import { HttpError } from "../src/http.ts";
import {
  EXPECTED_HEADERS,
  FIRST_MILESTONES_PAGE_URL,
  SECOND_MILESTONES_PAGE_URL,
  TARGET,
  TOKEN,
  createFakeHttp,
  milestoneJson,
  requestAt,
  schemaError,
  withoutKey,
} from "./github-fixtures.ts";

// ---------------------------------------------------------------------------
// parseGitHubMilestone
// ---------------------------------------------------------------------------

describe("parseGitHubMilestone", () => {
  it("keeps only number, title and state", () => {
    // Act
    const milestone = parseGitHubMilestone(milestoneJson({ number: 4, title: "[YT-9] Business", description: "d" }));

    // Assert
    const expected: GitHubMilestone = { number: 4, title: "[YT-9] Business", state: "open" };
    assert.deepEqual(milestone, expected);
  });

  it("parses a closed milestone", () => {
    assert.equal(parseGitHubMilestone(milestoneJson({ state: "closed" })).state, "closed");
  });

  it("keeps an empty or unusual title verbatim", () => {
    assert.equal(parseGitHubMilestone(milestoneJson({ title: "" })).title, "");
    assert.equal(parseGitHubMilestone(milestoneJson({ title: " [YT-1] ü 😀\n" })).title, " [YT-1] ü 😀\n");
  });

  it("accepts the largest safe milestone number", () => {
    assert.equal(
      parseGitHubMilestone(milestoneJson({ number: Number.MAX_SAFE_INTEGER })).number,
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("leaves the input untouched", () => {
    const raw = milestoneJson();
    const snapshot = structuredClone(raw);
    parseGitHubMilestone(raw);
    assert.deepEqual(raw, snapshot);
  });

  for (const value of [[], null, "milestone", 1, true]) {
    it(`rejects a milestone that is ${JSON.stringify(value)}`, () => {
      assert.throws(() => parseGitHubMilestone(value), schemaError(/^GitHub milestone must be a JSON object, got /));
    });
  }

  it("rejects a missing number", () => {
    assert.throws(
      () => parseGitHubMilestone(withoutKey(milestoneJson(), "number")),
      schemaError(/^GitHub milestone "number" must be a positive integer, got nothing$/),
    );
  });

  for (const value of [0, -1, 1.5, 2 ** 53, "1", null]) {
    it(`rejects number = ${JSON.stringify(value)}`, () => {
      assert.throws(
        () => parseGitHubMilestone(milestoneJson({ number: value })),
        schemaError(/"number" must be a positive integer/),
      );
    });
  }

  for (const value of [null, 1, ["t"]]) {
    it(`rejects title = ${JSON.stringify(value)} and names the milestone`, () => {
      assert.throws(
        () => parseGitHubMilestone(milestoneJson({ number: 5, title: value })),
        schemaError(/^GitHub milestone #5: "title" must be a string$/),
      );
    });
  }

  it("rejects a missing title", () => {
    assert.throws(
      () => parseGitHubMilestone(withoutKey(milestoneJson(), "title")),
      schemaError(/"title" must be a string/),
    );
  });

  for (const value of ["all", "Open", "CLOSED", "", null, 1]) {
    it(`rejects state = ${JSON.stringify(value)}`, () => {
      assert.throws(
        () => parseGitHubMilestone(milestoneJson({ number: 5, state: value })),
        schemaError(/^GitHub milestone #5: "state" must be "open" or "closed", got /),
      );
    });
  }

  it("rejects a missing state", () => {
    assert.throws(
      () => parseGitHubMilestone(withoutKey(milestoneJson(), "state")),
      schemaError(/"state" must be "open" or "closed", got nothing$/),
    );
  });
});

// ---------------------------------------------------------------------------
// listAllMilestones
// ---------------------------------------------------------------------------

describe("listAllMilestones", () => {
  it("GETs every milestone (state=all, 100 per page) with GitHub headers and retry-once", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: [milestoneJson()] }]);

    // Act
    const milestones = await listAllMilestones(fake.http, TARGET);

    // Assert
    assert.equal(fake.requests.length, 1);
    const request = requestAt(fake.requests, 0);
    assert.equal(request.method, "GET");
    assert.equal(request.url, FIRST_MILESTONES_PAGE_URL);
    assert.deepEqual(request.headers, EXPECTED_HEADERS);
    assert.equal(request.retry, "retry-once");
    assert.equal("body" in request, false);
    assert.deepEqual(milestones, [{ number: 1, title: "[YT-33] Epic", state: "open" }]);
  });

  it("returns an empty list for a repository without milestones", async () => {
    const fake = createFakeHttp([{ body: [] }]);
    assert.deepEqual(await listAllMilestones(fake.http, TARGET), []);
  });

  it('follows Link rel="next" verbatim and keeps the order across pages', async () => {
    // Arrange
    const fake = createFakeHttp([
      {
        body: [milestoneJson({ number: 3, title: "[YT-9] a" }), milestoneJson({ number: 1, state: "closed" })],
        link: `<${SECOND_MILESTONES_PAGE_URL}>; rel="next", <${SECOND_MILESTONES_PAGE_URL}>; rel="last"`,
      },
      { body: [milestoneJson({ number: 2, title: "[YT-40] b" })], link: `<${FIRST_MILESTONES_PAGE_URL}>; rel="prev"` },
    ]);

    // Act
    const milestones = await listAllMilestones(fake.http, TARGET);

    // Assert
    assert.deepEqual(
      fake.requests.map((request) => request.url),
      [FIRST_MILESTONES_PAGE_URL, SECOND_MILESTONES_PAGE_URL],
    );
    assert.ok(fake.requests.every((request) => request.method === "GET" && request.retry === "retry-once"));
    assert.deepEqual(milestones, [
      { number: 3, title: "[YT-9] a", state: "open" },
      { number: 1, title: "[YT-33] Epic", state: "closed" },
      { number: 2, title: "[YT-40] b", state: "open" },
    ]);
  });

  it("throws when a page links back to an already fetched page", async () => {
    // Arrange
    const fake = createFakeHttp([
      { body: [], link: `<${SECOND_MILESTONES_PAGE_URL}>; rel="next"` },
      { body: [], link: `<${FIRST_MILESTONES_PAGE_URL}>; rel="next"` },
    ]);

    // Act + Assert
    await assert.rejects(listAllMilestones(fake.http, TARGET), schemaError(/loops back to an already fetched page/));
    assert.equal(fake.requests.length, 2);
  });

  it("throws instead of following a rel=next outside api.github.com", async () => {
    const fake = createFakeHttp([{ body: [], link: '<https://evil.example.com/m2>; rel="next"' }]);
    await assert.rejects(listAllMilestones(fake.http, TARGET), schemaError(/points outside/));
    assert.equal(fake.requests.length, 1);
  });

  for (const [kind, body] of [
    ["object", { message: "Not Found" }],
    ["null (empty body)", null],
  ] as const) {
    it(`throws GitHubSchemaError when a page body is a JSON ${kind}`, async () => {
      const fake = createFakeHttp([{ body }]);
      await assert.rejects(listAllMilestones(fake.http, TARGET), schemaError(/milestones page must be a JSON array/));
    });
  }

  it("throws GitHubSchemaError for an invalid milestone on a later page", async () => {
    // Arrange
    const fake = createFakeHttp([
      { body: [milestoneJson()], link: `<${SECOND_MILESTONES_PAGE_URL}>; rel="next"` },
      { body: [milestoneJson({ number: 7, state: "all" })] },
    ]);

    // Act + Assert
    await assert.rejects(listAllMilestones(fake.http, TARGET), schemaError(/milestone #7: "state"/));
  });

  it("fails the whole listing when a later page request fails", async () => {
    // Arrange: a truncated list would hide existing milestones and create duplicates.
    const failure = new HttpError("GET", SECOND_MILESTONES_PAGE_URL, 502, "Bad Gateway");
    const fake = createFakeHttp(
      [{ body: [milestoneJson()], link: `<${SECOND_MILESTONES_PAGE_URL}>; rel="next"` }],
      failure,
    );

    // Act + Assert
    await assert.rejects(listAllMilestones(fake.http, TARGET), (error: Error) => error === failure);
    assert.equal(fake.requests.length, 2);
  });

  it("percent-encodes owner and repo and refuses a dot-segment owner before any request", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: [] }]);

    // Act
    await listAllMilestones(fake.http, { owner: "my org", repo: "a#b", token: TOKEN });

    // Assert
    assert.equal(
      requestAt(fake.requests, 0).url,
      "https://api.github.com/repos/my%20org/a%23b/milestones?state=all&per_page=100",
    );
    await assert.rejects(listAllMilestones(fake.http, { owner: "..", repo: "r", token: TOKEN }), RangeError);
    assert.equal(fake.requests.length, 1);
  });
});
