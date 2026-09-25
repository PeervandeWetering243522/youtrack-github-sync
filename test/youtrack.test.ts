import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FetchBudgetExceededError, HttpError, createHttpClient } from "../src/http.ts";
import type { HttpClient, HttpRequest, HttpResponse } from "../src/http.ts";
import { isJsonArray, isJsonObject, parseJson } from "../src/json.ts";
import type { JsonObject, JsonValue } from "../src/json.ts";
import {
  ISSUE_FIELDS,
  YOUTRACK_PAGE_SIZE,
  YouTrackSchemaError,
  fetchProjectIssues,
  issueFieldsParam,
  parseYouTrackIssue,
  projectQuery,
} from "../src/youtrack.ts";
import type { YouTrackIssue, YouTrackSource } from "../src/youtrack.ts";

// node:test's describe/it return promises that the runner itself tracks; `void`
// marks them as handled for no-floating-promises without disabling the rule.

// ---------------------------------------------------------------------------
// Fixtures (shaped like the live responses in docs/00-live-verification.md)
// ---------------------------------------------------------------------------

const BASE_URL = "https://youtrack.example.test";
const TOKEN = "test-token";
// Frozen: the module must never write to its source argument.
const SOURCE: YouTrackSource = Object.freeze({ baseUrl: BASE_URL, token: TOKEN, project: "CUI" });
const FAKE_MAX_FETCHES = 45;

/** A page URL up to its `$skip` value, spelled out independently of the implementation. */
const PAGE_URL_PREFIX =
  `${BASE_URL}/api/issues` +
  "?query=project%3A+CUI+sort+by%3A+%7Bissue+id%7D+asc" +
  "&fields=idReadable%2CnumberInProject%2Csummary%2Cdescription%2Cresolved%2Cupdated" +
  "&%24top=100&%24skip=";
const FIRST_PAGE_URL = `${PAGE_URL_PREFIX}0`;

/** The exact request expected for the page at `skip` of the SOURCE project. */
function expectedPageRequest(skip: number): HttpRequest {
  return {
    method: "GET",
    url: `${PAGE_URL_PREFIX}${String(skip)}`,
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
    retry: "retry-once",
  };
}

const UNRESOLVED_ROW: JsonObject = {
  idReadable: "CUI-31",
  summary: "[individual] Explore GH-YouTrack integrations",
  updated: 1790256733345,
  resolved: null,
  numberInProject: 31,
  description:
    "Probably gonna have Claude draft up a project to use API keys to have ideally bidirectional syncing",
  $type: "Issue",
};

const RESOLVED_ROW: JsonObject = {
  idReadable: "CUI-11",
  summary: "[Team] Audit and revise the research proposal",
  updated: 1790254466400,
  resolved: 1789644365309,
  numberInProject: 11,
  description:
    "Review Gabriel's draft, identify factual and structural issues, apply corrections, merge into the shared document.",
  $type: "Issue",
};

const NULL_DESCRIPTION_ROW: JsonObject = {
  idReadable: "CUI-30",
  summary: "Add finalized research proposal to github",
  updated: 1790254466396,
  resolved: null,
  numberInProject: 30,
  description: null,
  $type: "Issue",
};

/** A valid row for issue `numberInProject`; `overrides` replaces or adds keys. */
function issueRow(numberInProject: number, overrides: JsonObject = {}): JsonObject {
  return {
    idReadable: `CUI-${String(numberInProject)}`,
    summary: `[team] Issue ${String(numberInProject)}`,
    updated: 1789307190036 + numberInProject,
    resolved: null,
    numberInProject,
    description: null,
    $type: "Issue",
    ...overrides,
  };
}

/** `count` consecutive valid rows starting at issue `first`. */
function issueRows(first: number, count: number): readonly JsonObject[] {
  return Array.from({ length: count }, (_, offset) => issueRow(first + offset));
}

function withoutFields(row: JsonObject, fields: readonly string[]): JsonObject {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !fields.includes(key)));
}

function numbersOf(issues: readonly YouTrackIssue[]): readonly number[] {
  return issues.map((issue) => issue.numberInProject);
}

function range(first: number, count: number): readonly number[] {
  return Array.from({ length: count }, (_, offset) => first + offset);
}

function schemaError(message: RegExp): { readonly name: string; readonly message: RegExp } {
  return { name: "YouTrackSchemaError", message };
}

/** Freezes a JSON value and everything inside it, so any write to it throws (ES modules are strict). */
function deepFreeze<T extends JsonValue>(value: T): T {
  if (isJsonArray(value)) {
    for (const item of value) deepFreeze(item);
  } else if (isJsonObject(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
  }
  Object.freeze(value);
  return value;
}

// ---------------------------------------------------------------------------
// Fake HttpClient: records every request, answers with canned responses
// ---------------------------------------------------------------------------

type Responder = (request: HttpRequest, callIndex: number) => Promise<HttpResponse>;

type FakeHttp = {
  readonly http: HttpClient;
  readonly requests: readonly HttpRequest[];
};

function createFakeHttp(respond: Responder): FakeHttp {
  const requests: HttpRequest[] = [];
  const http: HttpClient = {
    request: (request) => {
      requests.push(request);
      return respond(request, requests.length - 1);
    },
    fetchCount: () => requests.length,
    remainingFetches: () => FAKE_MAX_FETCHES - requests.length,
  };
  return { http, requests };
}

function okResponse(body: JsonValue): HttpResponse {
  return { status: 200, headers: new Headers(), body };
}

/** Serves `firstBodies` in order, then rejects every later request with `failure`. */
function failAfter(firstBodies: readonly JsonValue[], failure: Error): FakeHttp {
  return createFakeHttp((_request, callIndex) => {
    const body = firstBodies[callIndex];
    return body === undefined ? Promise.reject(failure) : Promise.resolve(okResponse(body));
  });
}

/** Answers request n with `bodies[n]`; a request beyond the canned bodies fails the test. */
function serveBodies(bodies: readonly JsonValue[]): FakeHttp {
  return failAfter(bodies, new Error("unexpected request beyond the canned responses"));
}

function skipsOf(requests: readonly HttpRequest[]): readonly (string | null)[] {
  return requests.map((request) => new URL(request.url).searchParams.get("$skip"));
}

/** The GET-only rule: every request is a bodiless GET to {baseUrl}/api/issues. */
function assertOnlyIssueGets(requests: readonly HttpRequest[]): void {
  assert.ok(requests.length > 0, "expected at least one request");
  for (const request of requests) {
    const url = new URL(request.url);
    assert.equal(request.method, "GET");
    assert.equal(`${url.origin}${url.pathname}`, `${BASE_URL}/api/issues`);
    assert.equal("body" in request, false);
  }
}

// ---------------------------------------------------------------------------
// issueFieldsParam / projectQuery
// ---------------------------------------------------------------------------

void describe("issueFieldsParam", () => {
  void it("joins ISSUE_FIELDS with commas in declaration order", () => {
    // Act
    const fields = issueFieldsParam();

    // Assert
    assert.equal(fields, "idReadable,numberInProject,summary,description,resolved,updated");
    assert.equal(fields, ISSUE_FIELDS.join(","));
  });
});

void describe("projectQuery", () => {
  void it("builds the exact project query sorted by issue id ascending", () => {
    assert.equal(projectQuery("CUI"), "project: CUI sort by: {issue id} asc");
  });

  void it("interpolates the given project shortName unchanged", () => {
    assert.equal(projectQuery("ABC_2-x"), "project: ABC_2-x sort by: {issue id} asc");
  });
});

// ---------------------------------------------------------------------------
// parseYouTrackIssue
// ---------------------------------------------------------------------------

void describe("parseYouTrackIssue", () => {
  void it("parses the live unresolved row (CUI-31) and drops $type", () => {
    // Act
    const issue = parseYouTrackIssue(UNRESOLVED_ROW);

    // Assert
    assert.deepEqual(issue, {
      idReadable: "CUI-31",
      numberInProject: 31,
      summary: "[individual] Explore GH-YouTrack integrations",
      description:
        "Probably gonna have Claude draft up a project to use API keys to have ideally bidirectional syncing",
      resolved: null,
      updated: 1790256733345,
    });
  });

  void it("parses the live resolved row (CUI-11) with its resolved timestamp", () => {
    // Act
    const issue = parseYouTrackIssue(RESOLVED_ROW);

    // Assert
    assert.equal(issue.idReadable, "CUI-11");
    assert.equal(issue.resolved, 1789644365309);
    assert.equal(issue.updated, 1790254466400);
  });

  void it("parses the live row with a null description (CUI-30)", () => {
    // Act
    const issue = parseYouTrackIssue(NULL_DESCRIPTION_ROW);

    // Assert
    assert.equal(issue.description, null);
    assert.equal(issue.resolved, null);
    assert.equal(issue.numberInProject, 30);
  });

  void it("accepts an empty-string description", () => {
    // Act
    const issue = parseYouTrackIssue(issueRow(5, { description: "" }));

    // Assert
    assert.equal(issue.description, "");
  });

  void it("returns a new object with exactly the ISSUE_FIELDS keys and leaves the input untouched", () => {
    // Arrange
    const row = issueRow(8, { customFields: [{ name: "State" }] });
    const snapshot = structuredClone(row);

    // Act
    const issue = parseYouTrackIssue(row);

    // Assert
    assert.notEqual(issue, row);
    assert.deepEqual(Object.keys(issue), [...ISSUE_FIELDS]);
    assert.deepEqual(row, snapshot);
  });

  for (const field of ISSUE_FIELDS) {
    void it(`throws YouTrackSchemaError naming the missing "${field}" field`, () => {
      // Arrange
      const row = withoutFields(issueRow(12), [field]);

      // Act + Assert
      assert.throws(
        () => parseYouTrackIssue(row),
        schemaError(new RegExp(`^YouTrack issue .+ is missing field\\(s\\) "${field}"$`)),
      );
    });
  }

  void it("names every missing field at once", () => {
    // Arrange
    const row = withoutFields(issueRow(12), ["summary", "updated"]);

    // Act + Assert
    assert.throws(
      () => parseYouTrackIssue(row),
      schemaError(/^YouTrack issue "CUI-12" is missing field\(s\) "summary", "updated"$/),
    );
  });

  void it("throws an instance of YouTrackSchemaError (an Error subclass)", () => {
    assert.throws(() => parseYouTrackIssue(null), (error) => {
      assert.ok(error instanceof YouTrackSchemaError);
      assert.ok(error instanceof Error);
      assert.equal(error.name, "YouTrackSchemaError");
      return true;
    });
  });

  const nonObjectRows: readonly { readonly row: JsonValue; readonly kind: string }[] = [
    { row: null, kind: "null" },
    { row: [issueRow(1)], kind: "array" },
    { row: "CUI-1", kind: "string" },
    { row: 1, kind: "number" },
    { row: true, kind: "boolean" },
  ];
  for (const { row, kind } of nonObjectRows) {
    void it(`rejects a row that is a JSON ${kind}`, () => {
      assert.throws(
        () => parseYouTrackIssue(row),
        schemaError(new RegExp(`^YouTrack issue row must be a JSON object, got ${kind}$`)),
      );
    });
  }

  const wrongTypes: readonly {
    readonly field: (typeof ISSUE_FIELDS)[number];
    readonly value: JsonValue;
    readonly expected: string;
    readonly got: string;
  }[] = [
    { field: "idReadable", value: 31, expected: "a string", got: "number" },
    { field: "idReadable", value: null, expected: "a string", got: "null" },
    { field: "summary", value: null, expected: "a string", got: "null" },
    { field: "summary", value: ["x"], expected: "a string", got: "array" },
    { field: "numberInProject", value: "31", expected: "a positive safe integer", got: "string" },
    { field: "numberInProject", value: 31.5, expected: "a positive safe integer", got: "non-safe-integer number" },
    { field: "numberInProject", value: null, expected: "a positive safe integer", got: "null" },
    { field: "updated", value: 2 ** 53, expected: "a safe integer", got: "non-safe-integer number" },
    { field: "updated", value: "1790256733345", expected: "a safe integer", got: "string" },
    { field: "updated", value: null, expected: "a safe integer", got: "null" },
    { field: "resolved", value: true, expected: "a safe integer or null", got: "boolean" },
    { field: "resolved", value: 1.5, expected: "a safe integer or null", got: "non-safe-integer number" },
    { field: "resolved", value: "1789644365309", expected: "a safe integer or null", got: "string" },
    { field: "description", value: 42, expected: "a string or null", got: "number" },
    { field: "description", value: { text: "x" }, expected: "a string or null", got: "object" },
    { field: "description", value: false, expected: "a string or null", got: "boolean" },
    // "non-positive integer" is only meaningful for numberInProject; elsewhere a 0 is just a number.
    { field: "idReadable", value: 0, expected: "a string", got: "number" },
    { field: "summary", value: -1, expected: "a string", got: "number" },
    { field: "description", value: 0, expected: "a string or null", got: "number" },
    { field: "numberInProject", value: 2 ** 53, expected: "a positive safe integer", got: "non-safe-integer number" },
    { field: "numberInProject", value: -1.5, expected: "a positive safe integer", got: "non-safe-integer number" },
    { field: "numberInProject", value: false, expected: "a positive safe integer", got: "boolean" },
    { field: "updated", value: { at: 1 }, expected: "a safe integer", got: "object" },
    { field: "resolved", value: [1789644365309], expected: "a safe integer or null", got: "array" },
  ];
  for (const { field, value, expected, got } of wrongTypes) {
    void it(`rejects ${field} = ${JSON.stringify(value)}`, () => {
      // Arrange
      const row = issueRow(7, { [field]: value });

      // Act + Assert
      assert.throws(
        () => parseYouTrackIssue(row),
        schemaError(new RegExp(`: field "${field}" must be ${expected}, got ${got}$`)),
      );
    });
  }

  void it("labels errors with the row's idReadable", () => {
    assert.throws(
      () => parseYouTrackIssue(issueRow(7, { updated: null })),
      schemaError(/^YouTrack issue "CUI-7": field "updated"/),
    );
  });

  void it("falls back to numberInProject in the label when idReadable is unusable", () => {
    assert.throws(
      () => parseYouTrackIssue(issueRow(7, { idReadable: 7 })),
      schemaError(/^YouTrack issue numberInProject=7: field "idReadable" must be a string, got number$/),
    );
  });

  void it("uses a generic label when neither identifier is usable", () => {
    assert.throws(
      () => parseYouTrackIssue(issueRow(7, { idReadable: null, numberInProject: null })),
      schemaError(/^YouTrack issue row: field "idReadable"/),
    );
  });

  void it("never puts description or summary text into error messages", () => {
    // Arrange
    const secret = "SECRET-TEXT-do-not-log";
    const rows: readonly JsonObject[] = [
      withoutFields(issueRow(9, { description: secret, summary: secret }), ["updated"]),
      issueRow(9, { description: secret, summary: secret, resolved: "yes" }),
      issueRow(9, { description: secret, numberInProject: "9" }),
      issueRow(9, { description: { text: secret }, summary: secret }),
    ];

    // Act + Assert
    for (const row of rows) {
      assert.throws(() => parseYouTrackIssue(row), (error) => {
        assert.ok(error instanceof YouTrackSchemaError);
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      });
    }
  });

  // [YT-0] / [YT--3] titles are never read back by parseMirrorTitle (positive only),
  // so accepting these would create a new duplicate mirror on every run.
  const nonPositiveNumbers: readonly { readonly label: string; readonly value: number }[] = [
    { label: "0", value: 0 },
    { label: "-0", value: -0 },
    { label: "-3", value: -3 },
    { label: "-(2^53 - 1)", value: -Number.MAX_SAFE_INTEGER },
  ];
  for (const { label, value } of nonPositiveNumbers) {
    void it(`rejects the non-positive numberInProject ${label}`, () => {
      assert.throws(
        () => parseYouTrackIssue(issueRow(3, { numberInProject: value })),
        schemaError(
          /^YouTrack issue "CUI-3": field "numberInProject" must be a positive safe integer, got non-positive integer$/,
        ),
      );
    });
  }

  void it("rejects a non-positive numberInProject that arrives as JSON text", () => {
    // Arrange
    const row = parseJson(
      '{"idReadable":"CUI-0","numberInProject":-0,"summary":"s","description":null,"resolved":null,"updated":1}',
    );

    // Act + Assert
    assert.throws(() => parseYouTrackIssue(row), schemaError(/field "numberInProject" must be a positive/));
  });

  void it("accepts the integer boundaries: numberInProject 1 and 2^53 - 1 timestamps", () => {
    // Act
    const first = parseYouTrackIssue(issueRow(1));
    const largest = parseYouTrackIssue(
      issueRow(2, {
        numberInProject: Number.MAX_SAFE_INTEGER,
        updated: Number.MAX_SAFE_INTEGER,
        resolved: Number.MAX_SAFE_INTEGER,
      }),
    );

    // Assert
    assert.equal(first.numberInProject, 1);
    assert.equal(largest.numberInProject, Number.MAX_SAFE_INTEGER);
    assert.equal(largest.updated, Number.MAX_SAFE_INTEGER);
    assert.equal(largest.resolved, Number.MAX_SAFE_INTEGER);
  });

  void it("rejects a resolved timestamp just past the negative safe-integer range", () => {
    assert.throws(
      () => parseYouTrackIssue(issueRow(4, { resolved: -(2 ** 53) })),
      schemaError(/field "resolved" must be a safe integer or null, got non-safe-integer number$/),
    );
  });

  void it("reports a missing field before any wrong type in the same row", () => {
    // Arrange
    const row = withoutFields(issueRow(4, { idReadable: 4, resolved: "never" }), ["updated"]);

    // Act + Assert
    assert.throws(
      () => parseYouTrackIssue(row),
      schemaError(/^YouTrack issue numberInProject=4 is missing field\(s\) "updated"$/),
    );
  });

  void it("reports the first wrong field in ISSUE_FIELDS order", () => {
    assert.throws(
      () => parseYouTrackIssue(issueRow(4, { updated: "later", summary: 5 })),
      schemaError(/^YouTrack issue "CUI-4": field "summary" must be a string, got number$/),
    );
  });

  void it("JSON-escapes the idReadable label so it cannot forge log lines", () => {
    // Arrange
    const row = issueRow(6, { idReadable: 'CUI-6\n[fake] "quoted"', resolved: "x" });

    // Act + Assert
    assert.throws(() => parseYouTrackIssue(row), (error) => {
      assert.ok(error instanceof YouTrackSchemaError);
      assert.doesNotMatch(error.message, /\n/);
      assert.ok(error.message.startsWith('YouTrack issue "CUI-6\\n[fake] \\"quoted\\"": field "resolved"'));
      return true;
    });
  });

  void it("does not accept a field supplied only through a JSON __proto__ key", () => {
    // Arrange: JSON.parse makes "__proto__" an own key, so "summary" is really absent.
    const row = parseJson(
      '{"__proto__":{"summary":"inherited?"},"idReadable":"CUI-2","numberInProject":2,' +
        '"description":null,"resolved":null,"updated":1}',
    );

    // Act + Assert
    assert.throws(
      () => parseYouTrackIssue(row),
      schemaError(/^YouTrack issue "CUI-2" is missing field\(s\) "summary"$/),
    );
  });

  void it("drops a JSON __proto__ key and returns a plain object", () => {
    // Arrange
    const row = parseJson(
      '{"__proto__":{"polluted":true},"idReadable":"CUI-2","numberInProject":2,"summary":"s",' +
        '"description":null,"resolved":null,"updated":1}',
    );

    // Act
    const issue = parseYouTrackIssue(row);

    // Assert
    assert.equal(Object.getPrototypeOf(issue), Object.prototype);
    assert.deepEqual(Object.keys(issue), [...ISSUE_FIELDS]);
    assert.equal("polluted" in issue, false);
  });

  void it("parses a deep-frozen row without writing to it", () => {
    // Arrange
    const row = deepFreeze(issueRow(10, { description: "text", resolved: 1789644365309 }));

    // Act
    const issue = parseYouTrackIssue(row);

    // Assert
    assert.equal(issue.description, "text");
    assert.equal(issue.resolved, 1789644365309);
  });
});

// ---------------------------------------------------------------------------
// fetchProjectIssues
// ---------------------------------------------------------------------------

void describe("fetchProjectIssues", () => {
  void it("requests the first page with the exact URL, headers and retry policy", async () => {
    // Arrange
    const fake = serveBodies([[UNRESOLVED_ROW]]);

    // Act
    await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    const [request] = fake.requests;
    assert.deepEqual(request, {
      method: "GET",
      url: FIRST_PAGE_URL,
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
      retry: "retry-once",
    });
  });

  void it("only ever sends bodiless GET requests to {baseUrl}/api/issues", async () => {
    // Arrange
    const fake = serveBodies([issueRows(1, 100), issueRows(101, 100), issueRows(201, 5)]);

    // Act
    await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    assert.equal(fake.requests.length, 3);
    assertOnlyIssueGets(fake.requests);
  });

  void it("returns the parsed issues of a single short page with one request", async () => {
    // Arrange
    const fake = serveBodies([[RESOLVED_ROW, NULL_DESCRIPTION_ROW, UNRESOLVED_ROW]]);

    // Act
    const issues = await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    assert.equal(fake.requests.length, 1);
    assert.deepEqual(
      issues.map((issue) => issue.idReadable),
      ["CUI-11", "CUI-30", "CUI-31"],
    );
    assert.equal(issues[1]?.description, null);
    assertOnlyIssueGets(fake.requests);
  });

  void it("returns no issues for an empty project after one request", async () => {
    // Arrange
    const fake = serveBodies([[]]);

    // Act
    const issues = await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    assert.deepEqual(issues, []);
    assert.deepEqual(skipsOf(fake.requests), ["0"]);
    assertOnlyIssueGets(fake.requests);
  });

  void it("pages a 100-row page followed by a 5-row page and stops", async () => {
    // Arrange
    const fake = serveBodies([issueRows(1, 100), issueRows(101, 5)]);

    // Act
    const issues = await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    assert.deepEqual(numbersOf(issues), range(1, 105));
    assert.deepEqual(skipsOf(fake.requests), ["0", "100"]);
    for (const request of fake.requests) {
      assert.equal(new URL(request.url).searchParams.get("$top"), String(YOUTRACK_PAGE_SIZE));
    }
    assertOnlyIssueGets(fake.requests);
  });

  void it("fetches one more (empty) page after a page of exactly 100 rows", async () => {
    // Arrange
    const fake = serveBodies([issueRows(1, 100), []]);

    // Act
    const issues = await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    assert.deepEqual(numbersOf(issues), range(1, 100));
    assert.deepEqual(skipsOf(fake.requests), ["0", "100"]);
    assertOnlyIssueGets(fake.requests);
  });

  void it("keeps the first occurrence of a numberInProject repeated across pages", async () => {
    // Arrange
    const repeated = issueRow(100, { summary: "[team] repeated on page 2" });
    const fake = serveBodies([issueRows(1, 100), [repeated, ...issueRows(101, 4)]]);

    // Act
    const issues = await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    assert.deepEqual(numbersOf(issues), range(1, 104));
    assert.equal(issues.find((issue) => issue.numberInProject === 100)?.summary, "[team] Issue 100");
    assertOnlyIssueGets(fake.requests);
  });

  void it("keeps the first occurrence of a numberInProject repeated within a page", async () => {
    // Arrange
    const fake = serveBodies([[issueRow(1), issueRow(2), issueRow(1, { summary: "[team] duplicate" })]]);

    // Act
    const issues = await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    assert.deepEqual(numbersOf(issues), [1, 2]);
    assert.equal(issues[0]?.summary, "[team] Issue 1");
    assertOnlyIssueGets(fake.requests);
  });

  const nonArrayBodies: readonly { readonly body: JsonValue; readonly kind: string }[] = [
    { body: { error: "bad_request", error_description: "nope" }, kind: "object" },
    { body: null, kind: "null" },
    { body: "[]", kind: "string" },
    { body: 0, kind: "number" },
  ];
  for (const { body, kind } of nonArrayBodies) {
    void it(`throws YouTrackSchemaError when the body is a JSON ${kind}`, async () => {
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

  void it("throws YouTrackSchemaError when a later page is not an array", async () => {
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

  void it("stops paging at the first invalid row, even on a full page", async () => {
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

  void it("rejects a row with a wrong type on a later page", async () => {
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

  void it("propagates an HttpError from the first request unchanged", async () => {
    // Arrange
    const failure = new HttpError("GET", FIRST_PAGE_URL, 400, "invalid query");
    const fake = failAfter([], failure);

    // Act + Assert
    await assert.rejects(fetchProjectIssues(fake.http, SOURCE), (error) => error === failure);
    assert.equal(fake.requests.length, 1);
    assertOnlyIssueGets(fake.requests);
  });

  void it("propagates an HttpError from a later page and makes no further requests", async () => {
    // Arrange
    const failure = new HttpError("GET", `${BASE_URL}/api/issues`, 503, "unavailable");
    const fake = failAfter([issueRows(1, 100)], failure);

    // Act + Assert
    await assert.rejects(fetchProjectIssues(fake.http, SOURCE), (error) => error === failure);
    assert.deepEqual(skipsOf(fake.requests), ["0", "100"]);
    assertOnlyIssueGets(fake.requests);
  });

  void it("propagates a FetchBudgetExceededError from the HTTP client", async () => {
    // Arrange
    const failure = new FetchBudgetExceededError(FAKE_MAX_FETCHES);
    const fake = failAfter([issueRows(1, 100), issueRows(101, 100)], failure);

    // Act + Assert
    await assert.rejects(fetchProjectIssues(fake.http, SOURCE), (error) => error === failure);
    assert.equal(fake.requests.length, 3);
    assertOnlyIssueGets(fake.requests);
  });

  void it("sends exactly the expected request for every page of a multi-page scan", async () => {
    // Arrange
    const fake = serveBodies([issueRows(1, 100), issueRows(101, 100), issueRows(201, 5)]);

    // Act
    await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    assert.deepEqual(fake.requests, [0, 100, 200].map(expectedPageRequest));
  });

  void it("keeps a base URL path prefix in front of /api/issues", async () => {
    // Arrange
    const source: YouTrackSource = { ...SOURCE, baseUrl: "https://host.example.test/youtrack" };
    const fake = serveBodies([[]]);

    // Act
    await fetchProjectIssues(fake.http, source);

    // Assert
    assert.equal(fake.requests.length, 1);
    assert.match(fake.requests[0]?.url ?? "", /^https:\/\/host\.example\.test\/youtrack\/api\/issues\?query=/);
  });

  void it("puts the token verbatim in the Authorization header and never in the URL", async () => {
    // Arrange: a perm- token (this instance's format) with URL-significant characters.
    const token = "perm-cm9vdA==.dG9r+ZW4=.rNZ38ije7uiWwnUT";
    const fake = serveBodies([issueRows(1, 100), []]);

    // Act
    await fetchProjectIssues(fake.http, { ...SOURCE, token });

    // Assert
    for (const request of fake.requests) {
      assert.equal(request.headers["Authorization"], `Bearer ${token}`);
      assert.equal(request.url.includes(token), false);
      assert.equal(request.url.includes(encodeURIComponent(token)), false);
      assert.equal(request.url.includes("dG9r"), false);
    }
  });

  void it("sends only the query, fields, $top and $skip parameters", async () => {
    // Arrange
    const fake = serveBodies([issueRows(1, 100), issueRows(101, 1)]);

    // Act
    await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    for (const request of fake.requests) {
      const url = new URL(request.url);
      assert.deepEqual([...url.searchParams.keys()], ["query", "fields", "$top", "$skip"]);
      assert.equal(url.searchParams.get("query"), "project: CUI sort by: {issue id} asc");
      assert.equal(url.searchParams.get("fields"), issueFieldsParam());
      assert.equal(url.hash, "");
    }
  });

  void it("advances $skip by raw rows, so a full page with repeats still fetches the next page", async () => {
    // Arrange: 100 rows, only 99 distinct (issue 1 repeated at the end).
    const firstPage = [...issueRows(1, 99), issueRow(1, { summary: "[team] repeat" })];
    const fake = serveBodies([firstPage, issueRows(100, 3)]);

    // Act
    const issues = await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    assert.deepEqual(skipsOf(fake.requests), ["0", "100"]);
    assert.deepEqual(numbersOf(issues), range(1, 102));
    assert.equal(issues[0]?.summary, "[team] Issue 1");
  });

  void it("stops after a single page one row short of $top", async () => {
    // Arrange
    const fake = serveBodies([issueRows(1, YOUTRACK_PAGE_SIZE - 1)]);

    // Act
    const issues = await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    assert.deepEqual(numbersOf(issues), range(1, 99));
    assert.deepEqual(skipsOf(fake.requests), ["0"]);
  });

  void it("stops after a full page followed by a page one row short of $top", async () => {
    // Arrange
    const fake = serveBodies([issueRows(1, 100), issueRows(101, 99)]);

    // Act
    const issues = await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    assert.deepEqual(numbersOf(issues), range(1, 199));
    assert.deepEqual(skipsOf(fake.requests), ["0", "100"]);
  });

  void it("pages two full pages and a trailing empty page with $skip 0, 100, 200", async () => {
    // Arrange
    const fake = serveBodies([issueRows(1, 100), issueRows(101, 100), []]);

    // Act
    const issues = await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    assert.deepEqual(numbersOf(issues), range(1, 200));
    assert.deepEqual(skipsOf(fake.requests), ["0", "100", "200"]);
  });

  void it("advances $skip by 100 past a full page made only of repeats", async () => {
    // Arrange: page 2 repeats page 1 entirely (a de-duplicated count would stay at 100).
    const fake = serveBodies([issueRows(1, 100), issueRows(1, 100), issueRows(201, 2)]);

    // Act
    const issues = await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    assert.deepEqual(skipsOf(fake.requests), ["0", "100", "200"]);
    assert.deepEqual(numbersOf(issues), [...range(1, 100), 201, 202]);
  });

  void it("keeps paging after an oversized page (server ignored $top), skipping what it has", async () => {
    // Arrange
    const fake = serveBodies([issueRows(1, 150), issueRows(151, 2)]);

    // Act
    const issues = await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    assert.deepEqual(skipsOf(fake.requests), ["0", "150"]);
    assert.deepEqual(numbersOf(issues), range(1, 152));
    assertOnlyIssueGets(fake.requests);
  });

  void it("requests pages one at a time, never before the previous page has arrived", async () => {
    // Arrange: hold every response until the test releases it.
    const release: ((response: HttpResponse) => void)[] = [];
    const fake = createFakeHttp(
      () =>
        new Promise<HttpResponse>((resolve) => {
          release.push(resolve);
        }),
    );
    const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

    // Act
    const scan = fetchProjectIssues(fake.http, SOURCE);
    await flush();
    const requestsWhileFirstPending = fake.requests.length;
    release[0]?.(okResponse(issueRows(1, 100)));
    await flush();
    const requestsWhileSecondPending = fake.requests.length;
    release[1]?.(okResponse([]));
    const issues = await scan;

    // Assert
    assert.equal(requestsWhileFirstPending, 1);
    assert.equal(requestsWhileSecondPending, 2);
    assert.equal(issues.length, 100);
  });

  void it("keeps the server's row order (no re-sorting)", async () => {
    // Arrange
    const fake = serveBodies([[issueRow(3), issueRow(1), issueRow(2)]]);

    // Act
    const issues = await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    assert.deepEqual(numbersOf(issues), [3, 1, 2]);
  });

  void it("rejects a page containing a row that is not an object", async () => {
    // Arrange
    const fake = serveBodies([[issueRow(1), null, issueRow(3)]]);

    // Act + Assert
    await assert.rejects(
      fetchProjectIssues(fake.http, SOURCE),
      schemaError(/^YouTrack issue row must be a JSON object, got null$/),
    );
  });

  void it("fails the whole scan on a non-positive numberInProject", async () => {
    // Arrange
    const fake = serveBodies([[issueRow(1), issueRow(2, { numberInProject: 0 })]]);

    // Act + Assert
    await assert.rejects(
      fetchProjectIssues(fake.http, SOURCE),
      schemaError(/^YouTrack issue "CUI-2": field "numberInProject" must be a positive safe integer/),
    );
  });

  void it("reads deep-frozen response bodies without writing to them", async () => {
    // Arrange
    const bodies = deepFreeze([issueRows(1, 100), [issueRow(100, { summary: "[team] repeat" }), issueRow(101)]]);
    const snapshot = structuredClone(bodies);
    const fake = serveBodies(bodies);

    // Act
    const issues = await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    assert.deepEqual(numbersOf(issues), range(1, 101));
    assert.deepEqual(bodies, snapshot);
  });
});

// ---------------------------------------------------------------------------
// fetchProjectIssues over the real HttpClient (src/http.ts) and a fake fetch
// ---------------------------------------------------------------------------

type FetchInput = Parameters<typeof fetch>[0];
type FetchCall = { readonly url: string; readonly init: Parameters<typeof fetch>[1] };
type RealClient = {
  readonly http: HttpClient;
  readonly calls: readonly FetchCall[];
  readonly waits: readonly number[];
};

const REAL_RETRY_DELAY_MS = 2_000;

function urlOf(input: FetchInput): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/** createHttpClient over a fake fetch that answers call n with `respond(url, n)`. */
function realClient(respond: (url: URL, callIndex: number) => Response, maxFetches: number): RealClient {
  const calls: FetchCall[] = [];
  const waits: number[] = [];
  const fakeFetch: typeof fetch = (input, init) => {
    const url = urlOf(input);
    calls.push({ url, init });
    return Promise.resolve(respond(new URL(url), calls.length - 1));
  };
  const http = createHttpClient({
    fetch: fakeFetch,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    userAgent: "youtrack-test",
    maxFetches,
    timeoutMs: 1_000,
    retryDelayMs: REAL_RETRY_DELAY_MS,
    maxRetryAfterMs: 10_000,
  });
  return { http, calls, waits };
}

function jsonResponse(status: number, body: JsonValue): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

void describe("fetchProjectIssues over the real HttpClient", () => {
  void it("sends every page through fetch as a bodiless GET with auth and accept headers", async () => {
    // Arrange
    const client = realClient(
      (url) => jsonResponse(200, url.searchParams.get("$skip") === "0" ? issueRows(1, 100) : issueRows(101, 5)),
      10,
    );

    // Act
    const issues = await fetchProjectIssues(client.http, SOURCE);

    // Assert
    assert.deepEqual(numbersOf(issues), range(1, 105));
    assert.deepEqual(
      client.calls.map((call) => call.url),
      [expectedPageRequest(0).url, expectedPageRequest(100).url],
    );
    for (const { init } of client.calls) {
      assert.ok(init, "fetch must receive a RequestInit");
      const headers = new Headers(init.headers);
      assert.equal(init.method, "GET");
      assert.equal(init.body, undefined);
      assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
      assert.equal(headers.get("accept"), "application/json");
    }
  });

  void it("is stopped by the fetch budget when the server ignores $skip (no endless loop)", async () => {
    // Arrange: every request gets the same full page back.
    const maxFetches = 4;
    const client = realClient(() => jsonResponse(200, issueRows(1, 100)), maxFetches);

    // Act + Assert
    await assert.rejects(fetchProjectIssues(client.http, SOURCE), FetchBudgetExceededError);
    assert.equal(client.calls.length, maxFetches);
    assert.deepEqual(
      client.calls.map((call) => new URL(call.url).searchParams.get("$skip")),
      ["0", "100", "200", "300"],
    );
  });

  void it("fails on HTTP 400 (bad query) after one fetch instead of returning no issues", async () => {
    // Arrange
    const client = realClient(
      () => jsonResponse(400, { error: "invalid_query", error_description: "Can't parse search query" }),
      10,
    );

    // Act + Assert
    await assert.rejects(fetchProjectIssues(client.http, SOURCE), (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 400);
      assert.equal(error.method, "GET");
      return true;
    });
    assert.equal(client.calls.length, 1);
    assert.deepEqual(client.waits, []);
  });

  void it("retries a 503 page once (retry-once) and completes the scan", async () => {
    // Arrange
    const client = realClient(
      (_url, callIndex) =>
        callIndex === 0 ? jsonResponse(503, { error: "unavailable" }) : jsonResponse(200, [RESOLVED_ROW]),
      10,
    );

    // Act
    const issues = await fetchProjectIssues(client.http, SOURCE);

    // Assert
    assert.deepEqual(
      issues.map((issue) => issue.idReadable),
      ["CUI-11"],
    );
    assert.deepEqual(
      client.calls.map((call) => call.url),
      [FIRST_PAGE_URL, FIRST_PAGE_URL],
    );
    assert.deepEqual(client.waits, [REAL_RETRY_DELAY_MS]);
  });

  void it("treats an empty 200 body (parsed as null) as a schema error", async () => {
    // Arrange
    const client = realClient(() => new Response("", { status: 200 }), 10);

    // Act + Assert
    await assert.rejects(
      fetchProjectIssues(client.http, SOURCE),
      schemaError(/page at \$skip=0 must be a JSON array, got null$/),
    );
  });
});
