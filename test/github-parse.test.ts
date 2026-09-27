import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GitHubSchemaError, githubHeaders, parseGitHubIssue } from "../src/github.ts";
import type { GitHubIssue } from "../src/github.ts";
import { parseJson } from "../src/json.ts";
import type { JsonObject, JsonValue } from "../src/json.ts";
import { EXPECTED_HEADERS, TOKEN, issueJson, schemaError, withoutKey } from "./github-fixtures.ts";

// ---------------------------------------------------------------------------
// githubHeaders
// ---------------------------------------------------------------------------

describe("githubHeaders", () => {
  it("returns exactly Accept, Bearer Authorization and the pinned API version", () => {
    // Act
    const headers = githubHeaders(TOKEN);

    // Assert
    assert.deepEqual(headers, EXPECTED_HEADERS);
  });

  it("pins API version 2026-03-10", () => {
    assert.equal(githubHeaders(TOKEN)["X-GitHub-Api-Version"], "2026-03-10");
  });

  it("embeds the token verbatim after 'Bearer ' and adds no Content-Type or User-Agent", () => {
    // Act
    const headers = githubHeaders("github_pat_11A+/=x");

    // Assert
    assert.equal(headers["Authorization"], "Bearer github_pat_11A+/=x");
    assert.deepEqual(Object.keys(headers).sort(), ["Accept", "Authorization", "X-GitHub-Api-Version"]);
  });

  it("returns a fresh object on every call", () => {
    assert.notEqual(githubHeaders(TOKEN), githubHeaders(TOKEN));
  });
});

// ---------------------------------------------------------------------------
// parseGitHubIssue: valid shapes, labels, pull requests
// ---------------------------------------------------------------------------

describe("parseGitHubIssue", () => {
  it("parses an open issue into the minimal typed shape", () => {
    // Arrange
    const raw = issueJson({ number: 42, title: "[YT-7] Fix it", body: "ignored", id: 999, labels: ["youtrack"] });

    // Act
    const issue = parseGitHubIssue(raw);

    // Assert
    const expected: GitHubIssue = {
      number: 42,
      title: "[YT-7] Fix it",
      state: "open",
      labelNames: ["youtrack"],
      isPullRequest: false,
    };
    assert.deepEqual(issue, expected);
  });

  it("parses a closed issue", () => {
    assert.equal(parseGitHubIssue(issueJson({ state: "closed" })).state, "closed");
  });

  it("accepts an empty title", () => {
    assert.equal(parseGitHubIssue(issueJson({ title: "" })).title, "");
  });

  it("reads label names from both string and object label forms, in order", () => {
    // Arrange
    const labels: JsonValue = ["plain", { id: 1, name: "youtrack", color: "6f42c1", description: null }, "bug"];

    // Act
    const issue = parseGitHubIssue(issueJson({ labels }));

    // Assert
    assert.deepEqual(issue.labelNames, ["plain", "youtrack", "bug"]);
  });

  it("ignores label items that are neither strings nor objects with a string name", () => {
    // Arrange
    const labels: JsonValue = [null, 3, true, ["nested"], {}, { name: null }, { name: 5 }, { id: 2 }, { name: "kept" }];

    // Act
    const issue = parseGitHubIssue(issueJson({ labels }));

    // Assert
    assert.deepEqual(issue.labelNames, ["kept"]);
  });

  it("flags items with a non-null pull_request object as pull requests", () => {
    const raw = issueJson({ pull_request: { url: "https://api.github.com/repos/o/r/pulls/1", merged_at: null } });
    assert.equal(parseGitHubIssue(raw).isPullRequest, true);
  });

  it("treats a missing pull_request key as a plain issue", () => {
    assert.equal(parseGitHubIssue(issueJson()).isPullRequest, false);
  });

  it("treats a null pull_request value as a plain issue", () => {
    assert.equal(parseGitHubIssue(issueJson({ pull_request: null })).isPullRequest, false);
  });

  it("leaves the input object untouched", () => {
    // Arrange
    const raw = issueJson({ labels: ["a", { name: "b" }] });
    const snapshot = structuredClone(raw);

    // Act
    parseGitHubIssue(raw);

    // Assert
    assert.deepEqual(raw, snapshot);
  });

  it("treats a present, non-null pull_request of any JSON type as a pull request", () => {
    const values: readonly JsonValue[] = [{}, false, 0, "", []];
    for (const pullRequest of values) {
      assert.equal(parseGitHubIssue(issueJson({ pull_request: pullRequest })).isPullRequest, true);
    }
  });

  it("keeps label names verbatim: case, whitespace, unicode, duplicates and empty names", () => {
    // Arrange: callers (plan.ts, sync/execute.ts) compare label names case-insensitively themselves.
    const labels: JsonValue = ["YouTrack", " youtrack ", { name: "ü 😀" }, "youtrack", "youtrack", { name: "" }];

    // Act
    const issue = parseGitHubIssue(issueJson({ labels }));

    // Assert
    assert.deepEqual(issue.labelNames, ["YouTrack", " youtrack ", "ü 😀", "youtrack", "youtrack", ""]);
  });

  it("is not fooled by __proto__ keys from JSON.parse", () => {
    // Arrange: JSON.parse creates own "__proto__" properties; nothing may be read through them.
    const raw = parseJson(
      '{"number":1,"title":"t","state":"open","labels":[{"__proto__":{"name":"youtrack"}}],"__proto__":{"pull_request":{}}}',
    );

    // Act
    const issue = parseGitHubIssue(raw);

    // Assert
    assert.equal(issue.isPullRequest, false);
    assert.deepEqual(issue.labelNames, []);
    const fresh: JsonObject = {};
    assert.equal(fresh["pull_request"], undefined);
  });

  it("keeps a long or oddly encoded title verbatim (no trimming, truncation or normalisation)", () => {
    // Arrange: 300 astral code points, a lone surrogate from a JSON escape and surrounding spaces.
    const raw = parseJson(
      `{"number":1,"title":" [YT-1] ${"😀".repeat(300)} \\ud800 e\\u0301 ","state":"open","labels":[]}`,
    );

    // Act
    const issue = parseGitHubIssue(raw);

    // Assert
    assert.equal(issue.title, ` [YT-1] ${"😀".repeat(300)} \uD800 é `);
  });

  it("returns a new labelNames array that does not alias the input labels", () => {
    // Arrange
    const labels: JsonValue = ["a", "b"];

    // Act
    const issue = parseGitHubIssue(issueJson({ labels }));

    // Assert
    assert.notEqual(issue.labelNames, labels);
  });

  it("accepts the largest safe integer as number and a JSON 3.0 as 3", () => {
    assert.equal(parseGitHubIssue(issueJson({ number: Number.MAX_SAFE_INTEGER })).number, Number.MAX_SAFE_INTEGER);
    assert.equal(parseGitHubIssue(parseJson('{"number":3.0,"title":"t","state":"open","labels":[]}')).number, 3);
  });
});

// ---------------------------------------------------------------------------
// parseGitHubIssue: rejected shapes and error messages
// ---------------------------------------------------------------------------

describe("parseGitHubIssue rejections", () => {
  for (const [kind, value] of [
    ["array", []],
    ["null", null],
    ["string", "issue"],
    ["number", 1],
    ["boolean", true],
  ] as const) {
    it(`rejects a value that is a JSON ${kind}`, () => {
      assert.throws(() => parseGitHubIssue(value), schemaError(/must be a JSON object/));
    });
  }

  it("rejects an object without a number", () => {
    assert.throws(() => parseGitHubIssue(withoutKey(issueJson(), "number")), schemaError(/"number".*got nothing/));
  });

  for (const value of [0, -3, 1.5, 2 ** 53, "12", null]) {
    it(`rejects number = ${JSON.stringify(value)}`, () => {
      assert.throws(
        () => parseGitHubIssue(issueJson({ number: value })),
        schemaError(/"number" must be a positive integer/),
      );
    });
  }

  it("rejects number = -0", () => {
    assert.throws(
      () => parseGitHubIssue(issueJson({ number: -0 })),
      schemaError(/"number" must be a positive integer/),
    );
  });

  for (const value of [null, 12, ["t"]]) {
    it(`rejects title = ${JSON.stringify(value)} and names the issue number`, () => {
      assert.throws(
        () => parseGitHubIssue(issueJson({ number: 9, title: value })),
        schemaError(/#9: "title" must be a string/),
      );
    });
  }

  it("rejects a missing title", () => {
    assert.throws(() => parseGitHubIssue(withoutKey(issueJson(), "title")), schemaError(/"title" must be a string/));
  });

  for (const value of ["OPEN", "Closed", "merged", "open ", " closed", "", null, 1, ["open"]]) {
    it(`rejects state = ${JSON.stringify(value)}`, () => {
      assert.throws(
        () => parseGitHubIssue(issueJson({ number: 5, state: value })),
        schemaError(/#5: "state" must be "open" or "closed"/),
      );
    });
  }

  it("rejects a missing state", () => {
    assert.throws(() => parseGitHubIssue(withoutKey(issueJson(), "state")), schemaError(/"state".*got nothing/));
  });

  for (const value of [null, "youtrack", { name: "youtrack" }]) {
    it(`rejects labels = ${JSON.stringify(value)}`, () => {
      assert.throws(
        () => parseGitHubIssue(issueJson({ number: 3, labels: value })),
        schemaError(/#3: "labels" must be an array/),
      );
    });
  }

  it("rejects a missing labels key", () => {
    assert.throws(() => parseGitHubIssue(withoutKey(issueJson(), "labels")), schemaError(/"labels" must be an array/));
  });

  it("throws an instance of GitHubSchemaError (an Error subclass)", () => {
    assert.throws(
      () => parseGitHubIssue(null),
      (error: Error) => error instanceof GitHubSchemaError && error.name === "GitHubSchemaError",
    );
  });

  it("quotes at most 40 characters of an unexpected state string", () => {
    // Arrange
    const longState = "x".repeat(500);

    // Act + Assert
    assert.throws(
      () => parseGitHubIssue(issueJson({ state: longState })),
      (error: Error) => error.message.includes(`"${"x".repeat(40)}"`) && !error.message.includes("x".repeat(41)),
    );
  });

  for (const [value, description] of [
    [true, "got boolean true"],
    [[1], "got an array"],
    [{ n: 1 }, "got an object"],
    [null, "got null"],
    ["12", 'got string "12"'],
    [1.5, "got number 1.5"],
  ] as const) {
    it(`describes a bad number ${JSON.stringify(value)} as "${description}"`, () => {
      assert.throws(
        () => parseGitHubIssue(issueJson({ number: value })),
        (error: Error) => error.message.endsWith(description),
      );
    });
  }

  it("describes a non-object issue by its JSON kind", () => {
    assert.throws(() => parseGitHubIssue([]), schemaError(/must be a JSON object, got an array$/));
    assert.throws(() => parseGitHubIssue("x"), schemaError(/must be a JSON object, got string "x"$/));
  });

  it("cuts an echoed string on a code point boundary, never leaving half an emoji", () => {
    // Arrange: 51 code points; the first 40 are "a" + 39 emoji. A 40-unit UTF-16 slice would end mid-emoji.
    const state = `a${"😀".repeat(50)}`;

    // Act + Assert
    assert.throws(
      () => parseGitHubIssue(issueJson({ state })),
      (error: Error) => error.message.endsWith(`got string "a${"😀".repeat(39)}"`) && !error.message.includes("\\ud"),
    );
  });

  it("escapes control characters of an echoed string, so a log line cannot be split", () => {
    assert.throws(
      () => parseGitHubIssue(issueJson({ state: "open\nFAKE LOG LINE" })),
      (error: Error) => !error.message.includes("\n") && error.message.includes(String.raw`"open\nFAKE LOG LINE"`),
    );
  });
});
