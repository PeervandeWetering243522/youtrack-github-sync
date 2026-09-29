import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FetchBudgetExceededError, HttpError, createHttpClient } from "../../src/http.ts";
import type { HttpClient } from "../../src/http.ts";
import type { JsonValue } from "../../src/json.ts";
import { fetchProjectIssues } from "../../src/youtrack.ts";
import {
  FIRST_PAGE_URL,
  RESOLVED_ROW,
  SOURCE,
  TOKEN,
  expectedPageRequest,
  issueRow,
  issueRows,
  numbersOf,
  range,
  schemaError,
} from "./fixtures.ts";

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

describe("fetchProjectIssues over the real HttpClient", () => {
  it("sends every page through fetch as a bodiless GET with auth and accept headers", async () => {
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

  it("is stopped by the fetch budget when the server ignores $skip (no endless loop)", async () => {
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

  it("fails on HTTP 400 (bad query) after one fetch instead of returning no issues", async () => {
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

  it("retries a 503 page once (retry-once) and completes the scan", async () => {
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

  it("treats an empty 200 body (parsed as null) as a schema error", async () => {
    // Arrange
    const client = realClient(() => new Response("", { status: 200 }), 10);

    // Act + Assert
    await assert.rejects(
      fetchProjectIssues(client.http, SOURCE),
      schemaError(/page at \$skip=0 must be a JSON array, got null$/),
    );
  });

  it("fails on a row from another project and makes no further fetch", async () => {
    // Arrange: a full first page whose last row belongs to another project (decision R4).
    const rows = [...issueRows(1, 99), issueRow(100, { idReadable: "OTHER-100" })];
    const client = realClient(() => jsonResponse(200, rows), 10);

    // Act + Assert
    await assert.rejects(
      fetchProjectIssues(client.http, SOURCE),
      schemaError(/^YouTrack issue "OTHER-100": idReadable must be "CUI-100"/),
    );
    assert.equal(client.calls.length, 1);
  });
});
