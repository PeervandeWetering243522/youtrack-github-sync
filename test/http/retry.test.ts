import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HttpError, NetworkError } from "../../src/http.ts";
import {
  callAt,
  FIXED_NOW_MS,
  GET,
  harness,
  jsonResponse,
  POST,
  rejection,
  RETRY_DELAY_MS,
  runRetry,
  textResponse,
  URL_ITEMS,
} from "./fixtures.ts";

describe("createHttpClient: status classification", () => {
  const cases: readonly { readonly status: number; readonly retried: boolean }[] = [
    { status: 300, retried: false },
    { status: 307, retried: false },
    { status: 308, retried: false },
    { status: 400, retried: false },
    { status: 401, retried: false },
    { status: 404, retried: false },
    { status: 422, retried: false },
    { status: 428, retried: false },
    { status: 429, retried: true },
    { status: 430, retried: false },
    { status: 499, retried: false },
    { status: 500, retried: true },
    { status: 504, retried: true },
    { status: 599, retried: true },
  ];

  for (const { status, retried } of cases) {
    it(`${retried ? "retries" : "does not retry"} HTTP ${String(status)}`, async () => {
      const run = await runRetry(textResponse(status, "x"));

      assert.deepEqual(run, retried ? { waits: [RETRY_DELAY_MS], fetches: 2 } : { waits: [], fetches: 1 });
    });
  }

  it("treats 299 as success", async () => {
    const { client } = harness([jsonResponse(299, { edge: true })]);

    const response = await client.request(GET);

    assert.equal(response.status, 299);
    assert.deepEqual(response.body, { edge: true });
  });

  it("does not retry a 3xx even when it carries retry-after", async () => {
    const run = await runRetry(textResponse(307, "", { "retry-after": "1", location: "https://example.test/x" }));

    assert.deepEqual(run, { waits: [], fetches: 1 });
  });

  it("reports an opaque status-0 response as HttpError 0 without retrying", async () => {
    const { client, calls } = harness([Response.error(), jsonResponse(200, {})]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 0);
    assert.equal(error.bodyExcerpt, "");
    assert.equal(calls.length, 1);
  });

  it("does not retry a 403 whose retry-after exceeds maxRetryAfterMs", async () => {
    const run = await runRetry(textResponse(403, "secondary rate limit", { "retry-after": "60" }));

    assert.deepEqual(run, { waits: [], fetches: 1 });
  });

  it("does not retry a 429 with retry-after under the no-retry policy", async () => {
    const { client, calls, waits } = harness([textResponse(429, "", { "retry-after": "1" }), jsonResponse(201, {})]);

    const error = await rejection(client.request(POST));

    assert.ok(error instanceof HttpError);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });

  it("returns the retry's status and headers, not the first response's", async () => {
    const { client } = harness([
      textResponse(503, "", { "x-attempt": "1" }),
      jsonResponse(201, { n: 2 }, { "x-attempt": "2" }),
    ]);

    const response = await client.request(GET);

    assert.equal(response.status, 201);
    assert.equal(response.headers.get("x-attempt"), "2");
  });
});

describe("createHttpClient: primary rate limit (x-ratelimit-remaining: 0)", () => {
  const exhausted = { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1790276472" };

  it("does not retry a 429 without retry-after, since only x-ratelimit-reset would help", async () => {
    const run = await runRetry(textResponse(429, "API rate limit exceeded", exhausted));

    assert.deepEqual(run, { waits: [], fetches: 1 });
  });

  it("does not retry a 403 without retry-after", async () => {
    const run = await runRetry(textResponse(403, "API rate limit exceeded", exhausted));

    assert.deepEqual(run, { waits: [], fetches: 1 });
  });

  it("throws the rate-limited response as an HttpError", async () => {
    const { client, calls } = harness([jsonResponse(429, { message: "API rate limit exceeded" }, exhausted)]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 429);
    assert.match(error.bodyExcerpt, /API rate limit exceeded/);
    assert.equal(calls.length, 1);
  });

  it("does not retry a 403 whose retry-after is unusable", async () => {
    const run = await runRetry(textResponse(403, "", { ...exhausted, "retry-after": "soon" }));

    assert.deepEqual(run, { waits: [], fetches: 1 });
  });

  it("does not retry a 429 whose retry-after is unusable", async () => {
    const run = await runRetry(textResponse(429, "", { ...exhausted, "retry-after": "later" }));

    assert.deepEqual(run, { waits: [], fetches: 1 });
  });

  it("does not retry when retry-after exceeds maxRetryAfterMs", async () => {
    const run = await runRetry(textResponse(403, "", { ...exhausted, "retry-after": "11" }));

    assert.deepEqual(run, { waits: [], fetches: 1 });
  });

  it("retries a 403 after a usable retry-after within maxRetryAfterMs", async () => {
    const run = await runRetry(textResponse(403, "", { ...exhausted, "retry-after": "2" }));

    assert.deepEqual(run, { waits: [2_000], fetches: 2 });
  });

  it("retries a 429 after a usable retry-after HTTP-date within maxRetryAfterMs", async (t) => {
    t.mock.method(Date, "now", () => FIXED_NOW_MS);

    const run = await runRetry(textResponse(429, "", { ...exhausted, "retry-after": "Fri, 25 Sep 2026 10:00:04 GMT" }));

    assert.deepEqual(run, { waits: [4_000], fetches: 2 });
  });

  it("still retries a 429 with requests remaining after retryDelayMs", async () => {
    const run = await runRetry(textResponse(429, "", { "x-ratelimit-remaining": "12" }));

    assert.deepEqual(run, { waits: [RETRY_DELAY_MS], fetches: 2 });
  });

  it("still retries a 5xx that reports no requests remaining", async () => {
    const run = await runRetry(textResponse(503, "", exhausted));

    assert.deepEqual(run, { waits: [RETRY_DELAY_MS], fetches: 2 });
  });
});

describe("createHttpClient: retry-once policy", () => {
  it("retries a 500 once after retryDelayMs and returns the success", async () => {
    const { client, calls, waits } = harness([textResponse(500, "boom"), jsonResponse(200, { ok: true })]);

    const response = await client.request(GET);

    assert.deepEqual(response.body, { ok: true });
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [RETRY_DELAY_MS]);
  });

  it("sends a new timeout signal on the retry", async () => {
    const { client, calls } = harness([textResponse(502, ""), jsonResponse(200, {})]);

    await client.request(GET);

    assert.notEqual(callAt(calls, 0).init?.signal, callAt(calls, 1).init?.signal);
  });

  it("honours retry-after delta-seconds on a 429", async () => {
    const { client, waits } = harness([textResponse(429, "slow down", { "retry-after": "3" }), jsonResponse(200, {})]);

    await client.request(GET);

    assert.deepEqual(waits, [3_000]);
  });

  it("honours retry-after on a 503", async () => {
    const { client, waits } = harness([textResponse(503, "", { "retry-after": " 1 " }), jsonResponse(200, {})]);

    await client.request(GET);

    assert.deepEqual(waits, [1_000]);
  });

  it("honours a retry-after HTTP-date relative to now", async (t) => {
    t.mock.method(Date, "now", () => FIXED_NOW_MS);
    const retryAfter = "Fri, 25 Sep 2026 10:00:05 GMT";
    const { client, waits } = harness([textResponse(429, "", { "retry-after": retryAfter }), jsonResponse(200, {})]);

    await client.request(GET);

    assert.deepEqual(waits, [5_000]);
  });

  it("retries immediately when the retry-after HTTP-date is in the past", async (t) => {
    t.mock.method(Date, "now", () => FIXED_NOW_MS);
    const retryAfter = "Fri, 25 Sep 2026 09:59:00 GMT";
    const { client, waits } = harness([textResponse(503, "", { "retry-after": retryAfter }), jsonResponse(200, {})]);

    await client.request(GET);

    assert.deepEqual(waits, [0]);
  });

  it("falls back to retryDelayMs for an unusable retry-after", async () => {
    const { client, waits } = harness([textResponse(429, "", { "retry-after": "soon" }), jsonResponse(200, {})]);

    await client.request(GET);

    assert.deepEqual(waits, [RETRY_DELAY_MS]);
  });

  it("falls back to retryDelayMs for a well-formed but impossible HTTP-date", async () => {
    const retryAfter = "Fri, 32 Sep 2026 10:00:05 GMT";
    const { client, waits } = harness([textResponse(503, "", { "retry-after": retryAfter }), jsonResponse(200, {})]);

    await client.request(GET);

    assert.deepEqual(waits, [RETRY_DELAY_MS]);
  });

  it("does not accept loosely formatted dates as retry-after", async () => {
    const { client, waits } = harness([textResponse(429, "", { "retry-after": "5.5" }), jsonResponse(200, {})]);

    await client.request(GET);

    assert.deepEqual(waits, [RETRY_DELAY_MS]);
  });

  it("does not retry when retry-after exceeds maxRetryAfterMs", async () => {
    const { client, calls, waits } = harness([textResponse(429, "later", { "retry-after": "11" })]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 429);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });

  it("does not retry when retryDelayMs itself exceeds maxRetryAfterMs", async () => {
    const { client, calls } = harness([textResponse(500, "boom")], { retryDelayMs: 20_000 });

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.equal(calls.length, 1);
  });

  it("does not retry a 403 without retry-after", async () => {
    const { client, calls, waits } = harness([jsonResponse(403, { message: "Forbidden" }), jsonResponse(200, {})]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 403);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });

  it("retries a 403 that carries retry-after (secondary rate limit)", async () => {
    const { client, waits } = harness([textResponse(403, "", { "retry-after": "2" }), jsonResponse(200, {})]);

    const response = await client.request(GET);

    assert.equal(response.status, 200);
    assert.deepEqual(waits, [2_000]);
  });

  it("does not retry other 4xx responses", async () => {
    const { client, calls } = harness([jsonResponse(400, { error: "bad query" }), jsonResponse(200, {})]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 400);
    assert.equal(calls.length, 1);
  });

  it("throws HttpError with the retry's status when the retry also fails", async () => {
    const { client, calls } = harness([textResponse(500, "first"), textResponse(503, "second")]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 503);
    assert.equal(error.bodyExcerpt, "second");
    assert.equal(calls.length, 2);
  });

  it("retries a network error and then throws NetworkError with the reason", async () => {
    const { client, calls, waits } = harness([new TypeError("fetch failed"), new TypeError("fetch failed again")]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof NetworkError);
    assert.equal(error.method, "GET");
    assert.equal(error.url, URL_ITEMS);
    assert.equal(error.message, `GET ${URL_ITEMS} failed: fetch failed again`);
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [RETRY_DELAY_MS]);
  });

  it("throws HttpError when a network error is followed by a 500", async () => {
    const { client, calls } = harness([new TypeError("fetch failed"), textResponse(500, "down")]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 500);
    assert.equal(calls.length, 2);
  });

  it("throws NetworkError when a 500 is followed by a network error", async () => {
    const { client, calls } = harness([textResponse(500, "down"), new TypeError("fetch failed")]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof NetworkError);
    assert.equal(error.message, `GET ${URL_ITEMS} failed: fetch failed`);
    assert.equal(calls.length, 2);
  });

  it("recovers when the retry after a network error succeeds", async () => {
    const { client, waits } = harness([new TypeError("fetch failed"), jsonResponse(200, { ok: 1 })]);

    const response = await client.request(GET);

    assert.deepEqual(response.body, { ok: 1 });
    assert.deepEqual(waits, [RETRY_DELAY_MS]);
  });
});

describe("createHttpClient: no-retry policy", () => {
  it("does not retry a 500", async () => {
    const { client, calls, waits } = harness([textResponse(500, "boom"), jsonResponse(201, {})]);

    const error = await rejection(client.request(POST));

    assert.ok(error instanceof HttpError);
    assert.equal(error.method, "POST");
    assert.equal(error.status, 500);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });

  it("does not retry a 403 carrying retry-after", async () => {
    const { client, calls, waits } = harness([textResponse(403, "", { "retry-after": "1" }), jsonResponse(201, {})]);

    const error = await rejection(client.request(POST));

    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 403);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });

  it("does not retry a network error", async () => {
    const { client, calls, waits } = harness([new TypeError("fetch failed"), jsonResponse(201, {})]);

    const error = await rejection(client.request(POST));

    assert.ok(error instanceof NetworkError);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });
});
