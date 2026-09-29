import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { HttpResponse } from "../src/http.ts";
import { YOUTRACK_PAGE_SIZE, fetchProjectIssues, issueFieldsParam } from "../src/youtrack.ts";
import type { YouTrackSource } from "../src/youtrack.ts";
import {
  FIRST_PAGE_URL,
  NULL_DESCRIPTION_ROW,
  RESOLVED_ROW,
  SOURCE,
  TOKEN,
  UNRESOLVED_ROW,
  assertOnlyIssueGets,
  createFakeHttp,
  deepFreeze,
  expectedPageRequest,
  issueRow,
  issueRows,
  numbersOf,
  okResponse,
  range,
  serveBodies,
  skipsOf,
} from "./youtrack-fixtures.ts";

// ---------------------------------------------------------------------------
// fetchProjectIssues: requests sent
// ---------------------------------------------------------------------------

describe("fetchProjectIssues: requests", () => {
  it("requests the first page with the exact URL, headers and retry policy", async () => {
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

  it("only ever sends bodiless GET requests to {baseUrl}/api/issues", async () => {
    // Arrange
    const fake = serveBodies([issueRows(1, 100), issueRows(101, 100), issueRows(201, 5)]);

    // Act
    await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    assert.equal(fake.requests.length, 3);
    assertOnlyIssueGets(fake.requests);
  });

  it("sends exactly the expected request for every page of a multi-page scan", async () => {
    // Arrange
    const fake = serveBodies([issueRows(1, 100), issueRows(101, 100), issueRows(201, 5)]);

    // Act
    await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    assert.deepEqual(fake.requests, [0, 100, 200].map(expectedPageRequest));
  });

  it("keeps a base URL path prefix in front of /api/issues", async () => {
    // Arrange
    const source: YouTrackSource = { ...SOURCE, baseUrl: "https://host.example.test/youtrack" };
    const fake = serveBodies([[]]);

    // Act
    await fetchProjectIssues(fake.http, source);

    // Assert
    assert.equal(fake.requests.length, 1);
    assert.match(fake.requests[0]?.url ?? "", /^https:\/\/host\.example\.test\/youtrack\/api\/issues\?query=/);
  });

  it("puts the token verbatim in the Authorization header and never in the URL", async () => {
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

  it("sends only the query, fields, customFields, $top and $skip parameters", async () => {
    // Arrange
    const fake = serveBodies([issueRows(1, 100), issueRows(101, 1)]);

    // Act
    await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    for (const request of fake.requests) {
      const url = new URL(request.url);
      assert.deepEqual([...url.searchParams.keys()], ["query", "fields", "customFields", "$top", "$skip"]);
      assert.equal(url.searchParams.get("query"), "project: CUI sort by: {issue id} asc");
      assert.equal(url.searchParams.get("fields"), issueFieldsParam());
      assert.deepEqual(url.searchParams.getAll("customFields"), ["Type"]);
      assert.equal(url.hash, "");
    }
  });

  it("requests pages one at a time, never before the previous page has arrived", async () => {
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
});

// ---------------------------------------------------------------------------
// fetchProjectIssues: paging, de-duplication and results
// ---------------------------------------------------------------------------

describe("fetchProjectIssues: paging and results", () => {
  it("returns the parsed issues of a single short page with one request", async () => {
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

  it("returns no issues for an empty project after one request", async () => {
    // Arrange
    const fake = serveBodies([[]]);

    // Act
    const issues = await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    assert.deepEqual(issues, []);
    assert.deepEqual(skipsOf(fake.requests), ["0"]);
    assertOnlyIssueGets(fake.requests);
  });

  it("pages a 100-row page followed by a 5-row page and stops", async () => {
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

  it("fetches one more (empty) page after a page of exactly 100 rows", async () => {
    // Arrange
    const fake = serveBodies([issueRows(1, 100), []]);

    // Act
    const issues = await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    assert.deepEqual(numbersOf(issues), range(1, 100));
    assert.deepEqual(skipsOf(fake.requests), ["0", "100"]);
    assertOnlyIssueGets(fake.requests);
  });

  it("keeps the first occurrence of a numberInProject repeated across pages", async () => {
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

  it("keeps the first occurrence of a numberInProject repeated within a page", async () => {
    // Arrange
    const fake = serveBodies([[issueRow(1), issueRow(2), issueRow(1, { summary: "[team] duplicate" })]]);

    // Act
    const issues = await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    assert.deepEqual(numbersOf(issues), [1, 2]);
    assert.equal(issues[0]?.summary, "[team] Issue 1");
    assertOnlyIssueGets(fake.requests);
  });

  it("advances $skip by raw rows, so a full page with repeats still fetches the next page", async () => {
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

  it("stops after a single page one row short of $top", async () => {
    // Arrange
    const fake = serveBodies([issueRows(1, YOUTRACK_PAGE_SIZE - 1)]);

    // Act
    const issues = await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    assert.deepEqual(numbersOf(issues), range(1, 99));
    assert.deepEqual(skipsOf(fake.requests), ["0"]);
  });

  it("stops after a full page followed by a page one row short of $top", async () => {
    // Arrange
    const fake = serveBodies([issueRows(1, 100), issueRows(101, 99)]);

    // Act
    const issues = await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    assert.deepEqual(numbersOf(issues), range(1, 199));
    assert.deepEqual(skipsOf(fake.requests), ["0", "100"]);
  });

  it("pages two full pages and a trailing empty page with $skip 0, 100, 200", async () => {
    // Arrange
    const fake = serveBodies([issueRows(1, 100), issueRows(101, 100), []]);

    // Act
    const issues = await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    assert.deepEqual(numbersOf(issues), range(1, 200));
    assert.deepEqual(skipsOf(fake.requests), ["0", "100", "200"]);
  });

  it("advances $skip by 100 past a full page made only of repeats", async () => {
    // Arrange: page 2 repeats page 1 entirely (a de-duplicated count would stay at 100).
    const fake = serveBodies([issueRows(1, 100), issueRows(1, 100), issueRows(201, 2)]);

    // Act
    const issues = await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    assert.deepEqual(skipsOf(fake.requests), ["0", "100", "200"]);
    assert.deepEqual(numbersOf(issues), [...range(1, 100), 201, 202]);
  });

  it("keeps paging after an oversized page (server ignored $top), skipping what it has", async () => {
    // Arrange
    const fake = serveBodies([issueRows(1, 150), issueRows(151, 2)]);

    // Act
    const issues = await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    assert.deepEqual(skipsOf(fake.requests), ["0", "150"]);
    assert.deepEqual(numbersOf(issues), range(1, 152));
    assertOnlyIssueGets(fake.requests);
  });

  it("keeps the server's row order (no re-sorting)", async () => {
    // Arrange
    const fake = serveBodies([[issueRow(3), issueRow(1), issueRow(2)]]);

    // Act
    const issues = await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    assert.deepEqual(numbersOf(issues), [3, 1, 2]);
  });

  it("reads deep-frozen response bodies without writing to them", async () => {
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
