import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createHttpClient,
  DEFAULT_MAX_FETCHES,
  DEFAULT_MAX_RETRY_AFTER_MS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  FetchBudgetExceededError,
  HttpError,
  NetworkError,
  USER_AGENT,
  type HttpClient,
  type HttpClientOptions,
  type HttpRequest,
  type HttpResponse,
} from "../src/http.ts";
import type { JsonValue } from "../src/json.ts";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type RecordedCall = { readonly input: FetchInput; readonly init: FetchInit };
/** A scripted fetch outcome: resolve with the Response, or reject with the Error. */
type Outcome = Response | Error;
type Harness = {
  readonly client: HttpClient;
  readonly calls: readonly RecordedCall[];
  readonly waits: readonly number[];
};

const URL_ITEMS = "https://example.test/api/items";
const TOKEN = "secret-token-123";
const RETRY_DELAY_MS = 2_000;
const MAX_RETRY_AFTER_MS = 10_000;
const FIXED_NOW_MS = Date.parse("2026-09-25T10:00:00Z");
const MAX_TIMER_MS = 2_147_483_647;

const GET: HttpRequest = {
  method: "GET",
  url: URL_ITEMS,
  headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
  retry: "retry-once",
};
const POST: HttpRequest = { ...GET, method: "POST", body: { title: "Hello", labels: ["a"] }, retry: "no-retry" };

const BASE_OPTIONS = {
  userAgent: "test-agent/1.0",
  maxFetches: 10,
  timeoutMs: 1_000,
  retryDelayMs: RETRY_DELAY_MS,
  maxRetryAfterMs: MAX_RETRY_AFTER_MS,
} as const;

/** A fake fetch that replays `outcomes` in order and records every call. */
function scriptedFetch(outcomes: readonly Outcome[]): { readonly fetch: typeof fetch; readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fakeFetch: typeof fetch = (input, init) => {
    const outcome = outcomes[calls.length];
    calls.push({ input, init });
    if (outcome === undefined) {
      return Promise.reject(new Error("unexpected extra fetch"));
    }
    return outcome instanceof Response ? Promise.resolve(outcome) : Promise.reject(outcome);
  };
  return { fetch: fakeFetch, calls };
}

function harness(
  outcomes: readonly Outcome[],
  overrides: Partial<Omit<HttpClientOptions, "sleep">> = {},
): Harness {
  const fake = scriptedFetch(outcomes);
  const waits: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    waits.push(ms);
    return Promise.resolve();
  };
  const client = createHttpClient({ ...BASE_OPTIONS, fetch: fake.fetch, ...overrides, sleep });
  return { client, calls: fake.calls, waits };
}

function jsonResponse(status: number, body: JsonValue, headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function textResponse(status: number, text: string, headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(text, { status, headers });
}

function callAt(calls: readonly RecordedCall[], index: number): RecordedCall {
  const call = calls[index];
  assert.ok(call, `expected fetch call #${String(index)}`);
  return call;
}

function sentHeaders(call: RecordedCall): Headers {
  return new Headers(call.init?.headers);
}

/** Awaits a request that must fail and returns its error. */
async function rejection(promise: Promise<HttpResponse>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error, "expected an Error to be thrown");
    return error;
  }
  assert.fail("expected the request to reject");
}

type RetryRun = { readonly waits: readonly number[]; readonly fetches: number };

/** Sends a retry-once GET answered by `first` then a 200; reports the waits and fetch count. */
async function runRetry(first: Response): Promise<RetryRun> {
  const { client, calls, waits } = harness([first, jsonResponse(200, {})]);
  try {
    await client.request(GET);
  } catch (error) {
    assert.ok(error instanceof HttpError, "only the first response's HttpError may escape");
  }
  return { waits, fetches: calls.length };
}

/** A 429 carrying the given retry-after, then a 200. */
function runRetryAfter(retryAfter: string): Promise<RetryRun> {
  return runRetry(textResponse(429, "", { "retry-after": retryAfter }));
}

/** Runs `run` with the process clock in `zone`, restoring the original zone afterwards. */
async function inTimeZone(zone: string, run: () => Promise<void>): Promise<void> {
  const original = Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env["TZ"] = zone;
  try {
    await run();
  } finally {
    process.env["TZ"] = original;
  }
}

void describe("createHttpClient: successful responses", () => {
  void it("returns status, headers and parsed JSON body for a 2xx", async () => {
    // Arrange
    const { client } = harness([jsonResponse(200, { id: "2-1", tags: [1, 2] }, { "x-total": "7" })]);

    // Act
    const response = await client.request(GET);

    // Assert
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-total"), "7");
    assert.deepEqual(response.body, { id: "2-1", tags: [1, 2] });
  });

  void it("returns a null body for an empty response", async () => {
    const { client } = harness([new Response(null, { status: 204 })]);

    const response = await client.request(GET);

    assert.equal(response.status, 204);
    assert.equal(response.body, null);
  });

  void it("returns a null body for a 200 with an empty string body", async () => {
    const { client } = harness([textResponse(200, "", { "content-type": "application/json" })]);

    const response = await client.request(GET);

    assert.equal(response.status, 200);
    assert.equal(response.body, null);
  });

  void it("returns a null body for a whitespace-only response", async () => {
    const { client } = harness([textResponse(200, "  \n")]);

    const response = await client.request(GET);

    assert.equal(response.body, null);
  });

  void it("throws an Error naming method and URL for a 2xx with invalid JSON, excerpting at most 200 chars", async () => {
    const body = `<html>${"a".repeat(1_000)}`;
    const { client, calls } = harness([textResponse(200, body)]);

    const error = await rejection(client.request(GET));

    assert.ok(!(error instanceof HttpError));
    assert.match(error.message, /^GET https:\/\/example\.test\/api\/items -> HTTP 200: response is not valid JSON/);
    assert.ok(error.message.includes(`<html>${"a".repeat(194)}`));
    assert.ok(!error.message.includes("a".repeat(195)));
    assert.equal(calls.length, 1);
  });
});

void describe("createHttpClient: request shape", () => {
  void it("sends caller headers plus User-Agent, and no body or Content-Type without a body", async () => {
    const { client, calls } = harness([jsonResponse(200, [])]);

    await client.request(GET);

    const call = callAt(calls, 0);
    const headers = sentHeaders(call);
    assert.equal(call.input, URL_ITEMS);
    assert.equal(call.init?.method, "GET");
    assert.equal(headers.get("user-agent"), "test-agent/1.0");
    assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.has("content-type"), false);
    assert.equal(call.init.body, undefined);
  });

  void it("serialises a JSON body and sets Content-Type", async () => {
    const { client, calls } = harness([jsonResponse(201, { number: 5 })]);

    const response = await client.request(POST);

    const call = callAt(calls, 0);
    assert.equal(response.status, 201);
    assert.equal(call.init?.method, "POST");
    assert.equal(call.init.body, JSON.stringify({ title: "Hello", labels: ["a"] }));
    assert.equal(sentHeaders(call).get("content-type"), "application/json");
  });

  void it("serialises a JSON null body instead of omitting it", async () => {
    const { client, calls } = harness([jsonResponse(200, {})]);

    await client.request({ ...GET, method: "PATCH", body: null });

    assert.equal(callAt(calls, 0).init?.body, "null");
  });

  void it("calls fetch unbound, since the Workers global fetch rejects a foreign `this` (Illegal invocation)", async () => {
    // Mirrors workerd, which was checked locally: `({ fetch }).fetch(url)` throws, a detached call does not.
    const receivers: boolean[] = [];
    function workersLikeFetch(this: HttpClientOptions | undefined): Promise<Response> {
      receivers.push(this === undefined);
      return this === undefined
        ? Promise.resolve(jsonResponse(200, { ok: true }))
        : Promise.reject(new TypeError("Illegal invocation: function called with incorrect `this` reference."));
    }
    const { client } = harness([], { fetch: workersLikeFetch });

    const response = await client.request(GET);

    assert.deepEqual(response.body, { ok: true });
    assert.deepEqual(receivers, [true]);
  });

  void it("passes a fresh, unaborted timeout signal and manual redirect handling", async () => {
    const { client, calls } = harness([jsonResponse(200, {})]);

    await client.request(GET);

    const init = callAt(calls, 0).init;
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.redirect, "manual");
  });

  void it("does not mutate the caller's headers", async () => {
    const headers = Object.freeze({ Authorization: `Bearer ${TOKEN}` });
    const { client } = harness([jsonResponse(201, {})]);

    await client.request({ ...POST, headers });

    assert.deepEqual(headers, { Authorization: `Bearer ${TOKEN}` });
  });

  void it("replaces a caller User-Agent spelled in another case instead of joining both", async () => {
    const { client, calls } = harness([jsonResponse(200, {})]);

    await client.request({ ...GET, headers: { ...GET.headers, "user-agent": "caller/0.1" } });

    assert.equal(sentHeaders(callAt(calls, 0)).get("user-agent"), "test-agent/1.0");
  });

  void it("replaces a caller content-type when a JSON body is sent", async () => {
    const { client, calls } = harness([jsonResponse(201, {})]);

    await client.request({ ...POST, headers: { ...POST.headers, "content-type": "text/plain" } });

    assert.equal(sentHeaders(callAt(calls, 0)).get("content-type"), "application/json");
  });

  void it("keeps a caller Content-Type when there is no body", async () => {
    const { client, calls } = harness([jsonResponse(200, {})]);

    await client.request({ ...GET, headers: { ...GET.headers, "Content-Type": "application/merge-patch+json" } });

    assert.equal(sentHeaders(callAt(calls, 0)).get("content-type"), "application/merge-patch+json");
  });

  void it("sends the identical body and headers on the retry", async () => {
    const patch: HttpRequest = { ...GET, method: "PATCH", body: { state: "closed", state_reason: "completed" } };
    const { client, calls } = harness([textResponse(502, ""), jsonResponse(200, {})]);

    await client.request(patch);

    const [first, second] = [callAt(calls, 0), callAt(calls, 1)];
    assert.equal(second.input, URL_ITEMS);
    assert.equal(first.init?.body, JSON.stringify({ state: "closed", state_reason: "completed" }));
    assert.equal(second.init?.body, first.init.body);
    assert.equal(second.init.method, "PATCH");
    assert.deepEqual([...sentHeaders(second)], [...sentHeaders(first)]);
  });

  void it("works with a deeply frozen request across a retry", async () => {
    const body: JsonValue = Object.freeze({ labels: Object.freeze(["youtrack"]) });
    const headers = Object.freeze({ ...GET.headers });
    const request: HttpRequest = Object.freeze({ ...GET, method: "POST", headers, body });
    const { client, calls } = harness([textResponse(500, ""), jsonResponse(200, [])]);

    const response = await client.request(request);

    assert.deepEqual(response.body, []);
    assert.equal(calls.length, 2);
    assert.deepEqual(request.body, { labels: ["youtrack"] });
  });

  void it("throws a body JSON cannot represent without calling fetch or spending budget", async () => {
    const cyclic: Record<string, JsonValue> = {};
    cyclic["self"] = cyclic;
    const { client, calls, waits } = harness([jsonResponse(200, {})]);

    const error = await rejection(client.request({ ...GET, method: "POST", body: cyclic }));

    assert.ok(error instanceof TypeError);
    assert.ok(!(error instanceof NetworkError));
    assert.equal(calls.length, 0);
    assert.equal(client.fetchCount(), 0);
    assert.deepEqual(waits, []);
  });

  void it("aborts a hanging fetch after timeoutMs and reports a NetworkError", async () => {
    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal, "expected a signal");
        // AbortSignal.timeout's timer is unref'd in Node; this ref'd guard keeps the
        // event loop alive until it fires (and fails the test if it never does).
        const guard = setTimeout(() => {
          reject(new Error("timeout signal never fired"));
        }, 2_000);
        signal.addEventListener("abort", () => {
          clearTimeout(guard);
          reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        });
      });
    const { client } = harness([], { fetch: hangingFetch, timeoutMs: 10 });

    const error = await rejection(client.request({ ...GET, retry: "no-retry" }));

    assert.ok(error instanceof NetworkError);
    assert.match(error.message, /^GET https:\/\/example\.test\/api\/items failed: .*timeout/i);
  });
});

void describe("createHttpClient: fetch budget", () => {
  void it("starts with zero fetches and the full budget remaining", () => {
    const { client } = harness([]);

    assert.equal(client.fetchCount(), 0);
    assert.equal(client.remainingFetches(), 10);
  });

  void it("throws FetchBudgetExceededError without calling fetch once the budget is spent", async () => {
    const { client, calls } = harness([jsonResponse(200, {}), jsonResponse(200, {})], { maxFetches: 1 });
    await client.request(GET);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof FetchBudgetExceededError);
    assert.equal(error.maxFetches, 1);
    assert.equal(calls.length, 1);
    assert.equal(client.fetchCount(), 1);
    assert.equal(client.remainingFetches(), 0);
  });

  void it("never calls fetch with a zero budget", async () => {
    const { client, calls } = harness([jsonResponse(200, {})], { maxFetches: 0 });

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof FetchBudgetExceededError);
    assert.equal(calls.length, 0);
  });

  void it("counts retries against the budget", async () => {
    const { client } = harness([textResponse(500, "boom"), jsonResponse(200, {})], { maxFetches: 5 });

    await client.request(GET);

    assert.equal(client.fetchCount(), 2);
    assert.equal(client.remainingFetches(), 3);
  });

  void it("skips the wait and throws FetchBudgetExceededError when the retry cannot be afforded", async () => {
    const { client, calls, waits } = harness([textResponse(500, "boom"), jsonResponse(200, {})], { maxFetches: 1 });

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof FetchBudgetExceededError);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });

  void it("lets the retry spend the last unit of budget", async () => {
    const { client, calls } = harness([textResponse(500, "boom"), jsonResponse(200, { ok: true })], { maxFetches: 2 });

    const response = await client.request(GET);

    assert.deepEqual(response.body, { ok: true });
    assert.equal(calls.length, 2);
    assert.equal(client.remainingFetches(), 0);
  });

  void it("reports the spent budget after an earlier request used it up", async () => {
    const { client, calls, waits } = harness([jsonResponse(200, {}), textResponse(503, "")], { maxFetches: 2 });
    await client.request(GET);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof FetchBudgetExceededError);
    assert.equal(calls.length, 2);
    assert.equal(client.fetchCount(), 2);
    assert.equal(client.remainingFetches(), 0);
    assert.deepEqual(waits, []);
  });

  void it("throws FetchBudgetExceededError after the wait when a concurrent request spent the last unit", async () => {
    const fake = scriptedFetch([textResponse(500, "boom"), jsonResponse(200, { n: 2 }), jsonResponse(200, { n: 3 })]);
    const concurrent: Promise<HttpResponse>[] = [];
    const client = createHttpClient({
      ...BASE_OPTIONS,
      fetch: fake.fetch,
      maxFetches: 2,
      sleep: () => {
        concurrent.push(client.request({ ...GET, retry: "no-retry" }));
        return Promise.resolve();
      },
    });

    const error = await rejection(client.request(GET));

    const [other] = concurrent;
    assert.ok(other, "expected the sleep to start a concurrent request");
    assert.ok(error instanceof FetchBudgetExceededError);
    assert.deepEqual((await other).body, { n: 2 });
    assert.equal(fake.calls.length, 2);
    assert.equal(client.remainingFetches(), 0);
  });

  void it("shares one budget between concurrent requests", async () => {
    const { client, calls } = harness([jsonResponse(200, { n: 1 }), jsonResponse(200, { n: 2 })], { maxFetches: 1 });

    const first = client.request(GET);
    const second = client.request(GET);

    assert.deepEqual((await first).body, { n: 1 });
    assert.ok((await rejection(second)) instanceof FetchBudgetExceededError);
    assert.equal(calls.length, 1);
  });
});

void describe("createHttpClient: option validation", () => {
  const invalidOptions: readonly (readonly [string, Partial<HttpClientOptions>])[] = [
    ["maxFetches", { maxFetches: Number.NaN }],
    ["maxFetches", { maxFetches: -1 }],
    ["maxFetches", { maxFetches: 1.5 }],
    ["maxFetches", { maxFetches: Number.POSITIVE_INFINITY }],
    ["timeoutMs", { timeoutMs: 0 }],
    ["timeoutMs", { timeoutMs: 1.5 }],
    ["timeoutMs", { timeoutMs: Number.NaN }],
    // Node clamps timer delays above 2^31 - 1 ms to 1 ms: every request would time out at once.
    ["timeoutMs", { timeoutMs: MAX_TIMER_MS + 1 }],
    ["retryDelayMs", { retryDelayMs: -1 }],
    ["retryDelayMs", { retryDelayMs: Number.NaN }],
    ["retryDelayMs", { retryDelayMs: Number.POSITIVE_INFINITY }],
    ["maxRetryAfterMs", { maxRetryAfterMs: Number.NaN }],
    ["maxRetryAfterMs", { maxRetryAfterMs: -1 }],
    ["maxRetryAfterMs", { maxRetryAfterMs: MAX_TIMER_MS + 1 }],
  ];
  const noSleep = (): Promise<void> => Promise.resolve();

  for (const [name, overrides] of invalidOptions) {
    void it(`rejects ${name} = ${String(Object.values(overrides)[0])} with a RangeError`, () => {
      const options = { ...BASE_OPTIONS, fetch: scriptedFetch([]).fetch, sleep: noSleep, ...overrides };

      assert.throws(() => createHttpClient(options), { name: "RangeError", message: new RegExp(name) });
    });
  }

  void it("lists every invalid option in one error", () => {
    const options = { ...BASE_OPTIONS, fetch: scriptedFetch([]).fetch, sleep: noSleep, maxFetches: -1, timeoutMs: 0 };

    assert.throws(() => createHttpClient(options), { message: /maxFetches.*; timeoutMs/ });
  });

  void it("accepts the exported defaults", () => {
    const client = createHttpClient({
      fetch: scriptedFetch([]).fetch,
      sleep: noSleep,
      userAgent: USER_AGENT,
      maxFetches: DEFAULT_MAX_FETCHES,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      retryDelayMs: DEFAULT_RETRY_DELAY_MS,
      maxRetryAfterMs: DEFAULT_MAX_RETRY_AFTER_MS,
    });

    assert.equal(client.remainingFetches(), DEFAULT_MAX_FETCHES);
  });

  void it("accepts the largest delay timers honour for timeoutMs and maxRetryAfterMs", () => {
    const options = {
      ...BASE_OPTIONS,
      fetch: scriptedFetch([]).fetch,
      sleep: noSleep,
      timeoutMs: MAX_TIMER_MS,
      maxRetryAfterMs: MAX_TIMER_MS,
    };

    assert.equal(createHttpClient(options).fetchCount(), 0);
  });
});

void describe("createHttpClient: status classification", () => {
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
    void it(`${retried ? "retries" : "does not retry"} HTTP ${String(status)}`, async () => {
      const run = await runRetry(textResponse(status, "x"));

      assert.deepEqual(run, retried ? { waits: [RETRY_DELAY_MS], fetches: 2 } : { waits: [], fetches: 1 });
    });
  }

  void it("treats 299 as success", async () => {
    const { client } = harness([jsonResponse(299, { edge: true })]);

    const response = await client.request(GET);

    assert.equal(response.status, 299);
    assert.deepEqual(response.body, { edge: true });
  });

  void it("does not retry a 3xx even when it carries retry-after", async () => {
    const run = await runRetry(textResponse(307, "", { "retry-after": "1", location: "https://example.test/x" }));

    assert.deepEqual(run, { waits: [], fetches: 1 });
  });

  void it("reports an opaque status-0 response as HttpError 0 without retrying", async () => {
    const { client, calls } = harness([Response.error(), jsonResponse(200, {})]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 0);
    assert.equal(error.bodyExcerpt, "");
    assert.equal(calls.length, 1);
  });

  void it("does not retry a 403 whose retry-after exceeds maxRetryAfterMs", async () => {
    const run = await runRetry(textResponse(403, "secondary rate limit", { "retry-after": "60" }));

    assert.deepEqual(run, { waits: [], fetches: 1 });
  });

  void it("does not retry a 429 with retry-after under the no-retry policy", async () => {
    const { client, calls, waits } = harness([textResponse(429, "", { "retry-after": "1" }), jsonResponse(201, {})]);

    const error = await rejection(client.request(POST));

    assert.ok(error instanceof HttpError);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });

  void it("returns the retry's status and headers, not the first response's", async () => {
    const { client } = harness([
      textResponse(503, "", { "x-attempt": "1" }),
      jsonResponse(201, { n: 2 }, { "x-attempt": "2" }),
    ]);

    const response = await client.request(GET);

    assert.equal(response.status, 201);
    assert.equal(response.headers.get("x-attempt"), "2");
  });
});

void describe("createHttpClient: retry-once policy", () => {
  void it("retries a 500 once after retryDelayMs and returns the success", async () => {
    const { client, calls, waits } = harness([textResponse(500, "boom"), jsonResponse(200, { ok: true })]);

    const response = await client.request(GET);

    assert.deepEqual(response.body, { ok: true });
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [RETRY_DELAY_MS]);
  });

  void it("sends a new timeout signal on the retry", async () => {
    const { client, calls } = harness([textResponse(502, ""), jsonResponse(200, {})]);

    await client.request(GET);

    assert.notEqual(callAt(calls, 0).init?.signal, callAt(calls, 1).init?.signal);
  });

  void it("honours retry-after delta-seconds on a 429", async () => {
    const { client, waits } = harness([textResponse(429, "slow down", { "retry-after": "3" }), jsonResponse(200, {})]);

    await client.request(GET);

    assert.deepEqual(waits, [3_000]);
  });

  void it("honours retry-after on a 503", async () => {
    const { client, waits } = harness([textResponse(503, "", { "retry-after": " 1 " }), jsonResponse(200, {})]);

    await client.request(GET);

    assert.deepEqual(waits, [1_000]);
  });

  void it("honours a retry-after HTTP-date relative to now", async (t) => {
    t.mock.method(Date, "now", () => FIXED_NOW_MS);
    const retryAfter = "Fri, 25 Sep 2026 10:00:05 GMT";
    const { client, waits } = harness([textResponse(429, "", { "retry-after": retryAfter }), jsonResponse(200, {})]);

    await client.request(GET);

    assert.deepEqual(waits, [5_000]);
  });

  void it("retries immediately when the retry-after HTTP-date is in the past", async (t) => {
    t.mock.method(Date, "now", () => FIXED_NOW_MS);
    const retryAfter = "Fri, 25 Sep 2026 09:59:00 GMT";
    const { client, waits } = harness([textResponse(503, "", { "retry-after": retryAfter }), jsonResponse(200, {})]);

    await client.request(GET);

    assert.deepEqual(waits, [0]);
  });

  void it("falls back to retryDelayMs for an unusable retry-after", async () => {
    const { client, waits } = harness([textResponse(429, "", { "retry-after": "soon" }), jsonResponse(200, {})]);

    await client.request(GET);

    assert.deepEqual(waits, [RETRY_DELAY_MS]);
  });

  void it("falls back to retryDelayMs for a well-formed but impossible HTTP-date", async () => {
    const retryAfter = "Fri, 32 Sep 2026 10:00:05 GMT";
    const { client, waits } = harness([textResponse(503, "", { "retry-after": retryAfter }), jsonResponse(200, {})]);

    await client.request(GET);

    assert.deepEqual(waits, [RETRY_DELAY_MS]);
  });

  void it("does not accept loosely formatted dates as retry-after", async () => {
    const { client, waits } = harness([textResponse(429, "", { "retry-after": "5.5" }), jsonResponse(200, {})]);

    await client.request(GET);

    assert.deepEqual(waits, [RETRY_DELAY_MS]);
  });

  void it("does not retry when retry-after exceeds maxRetryAfterMs", async () => {
    const { client, calls, waits } = harness([textResponse(429, "later", { "retry-after": "11" })]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 429);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });

  void it("does not retry when retryDelayMs itself exceeds maxRetryAfterMs", async () => {
    const { client, calls } = harness([textResponse(500, "boom")], { retryDelayMs: 20_000 });

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.equal(calls.length, 1);
  });

  void it("does not retry a 403 without retry-after", async () => {
    const { client, calls, waits } = harness([jsonResponse(403, { message: "Forbidden" }), jsonResponse(200, {})]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 403);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });

  void it("retries a 403 that carries retry-after (secondary rate limit)", async () => {
    const { client, waits } = harness([textResponse(403, "", { "retry-after": "2" }), jsonResponse(200, {})]);

    const response = await client.request(GET);

    assert.equal(response.status, 200);
    assert.deepEqual(waits, [2_000]);
  });

  void it("does not retry other 4xx responses", async () => {
    const { client, calls } = harness([jsonResponse(400, { error: "bad query" }), jsonResponse(200, {})]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 400);
    assert.equal(calls.length, 1);
  });

  void it("throws HttpError with the retry's status when the retry also fails", async () => {
    const { client, calls } = harness([textResponse(500, "first"), textResponse(503, "second")]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 503);
    assert.equal(error.bodyExcerpt, "second");
    assert.equal(calls.length, 2);
  });

  void it("retries a network error and then throws NetworkError with the reason", async () => {
    const { client, calls, waits } = harness([new TypeError("fetch failed"), new TypeError("fetch failed again")]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof NetworkError);
    assert.equal(error.method, "GET");
    assert.equal(error.url, URL_ITEMS);
    assert.equal(error.message, `GET ${URL_ITEMS} failed: fetch failed again`);
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [RETRY_DELAY_MS]);
  });

  void it("throws HttpError when a network error is followed by a 500", async () => {
    const { client, calls } = harness([new TypeError("fetch failed"), textResponse(500, "down")]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 500);
    assert.equal(calls.length, 2);
  });

  void it("throws NetworkError when a 500 is followed by a network error", async () => {
    const { client, calls } = harness([textResponse(500, "down"), new TypeError("fetch failed")]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof NetworkError);
    assert.equal(error.message, `GET ${URL_ITEMS} failed: fetch failed`);
    assert.equal(calls.length, 2);
  });

  void it("recovers when the retry after a network error succeeds", async () => {
    const { client, waits } = harness([new TypeError("fetch failed"), jsonResponse(200, { ok: 1 })]);

    const response = await client.request(GET);

    assert.deepEqual(response.body, { ok: 1 });
    assert.deepEqual(waits, [RETRY_DELAY_MS]);
  });
});

void describe("createHttpClient: no-retry policy", () => {
  void it("does not retry a 500", async () => {
    const { client, calls, waits } = harness([textResponse(500, "boom"), jsonResponse(201, {})]);

    const error = await rejection(client.request(POST));

    assert.ok(error instanceof HttpError);
    assert.equal(error.method, "POST");
    assert.equal(error.status, 500);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });

  void it("does not retry a 403 carrying retry-after", async () => {
    const { client, calls, waits } = harness([textResponse(403, "", { "retry-after": "1" }), jsonResponse(201, {})]);

    const error = await rejection(client.request(POST));

    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 403);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });

  void it("does not retry a network error", async () => {
    const { client, calls, waits } = harness([new TypeError("fetch failed"), jsonResponse(201, {})]);

    const error = await rejection(client.request(POST));

    assert.ok(error instanceof NetworkError);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });
});

void describe("createHttpClient: retry-after parsing", () => {
  void it("waits exactly maxRetryAfterMs when retry-after equals the cap", async () => {
    assert.deepEqual(await runRetryAfter("10"), { waits: [MAX_RETRY_AFTER_MS], fetches: 2 });
  });

  void it("retries immediately for retry-after 0", async () => {
    assert.deepEqual(await runRetryAfter("0"), { waits: [0], fetches: 2 });
  });

  void it("does not retry for an absurdly large delta-seconds value", async () => {
    assert.deepEqual(await runRetryAfter("99999999999999999999"), { waits: [], fetches: 1 });
  });

  void it("parses an obsolete rfc850 date", async (t) => {
    t.mock.method(Date, "now", () => FIXED_NOW_MS);

    assert.deepEqual(await runRetryAfter("Friday, 25-Sep-26 10:00:07 GMT"), { waits: [7_000], fetches: 2 });
  });

  void it("reads an rfc850 two-digit year more than 50 years ahead as the previous century", async (t) => {
    t.mock.method(Date, "now", () => FIXED_NOW_MS);

    // 2076 is exactly 50 years ahead (far future: no retry); 77 means 1977 (past: retry now).
    assert.deepEqual(await runRetryAfter("Friday, 25-Sep-76 10:00:00 GMT"), { waits: [], fetches: 1 });
    assert.deepEqual(await runRetryAfter("Saturday, 25-Sep-77 10:00:00 GMT"), { waits: [0], fetches: 2 });
  });

  void it("reads an rfc850 date even one second more than 50 years ahead as the previous century", async (t) => {
    t.mock.method(Date, "now", () => FIXED_NOW_MS);

    // 2076-09-25T10:00:01Z is 50 years and 1 s ahead, so RFC 9110 makes it 1976 (past: retry now).
    assert.deepEqual(await runRetryAfter("Friday, 25-Sep-76 10:00:01 GMT"), { waits: [0], fetches: 2 });
  });

  void it("reads an rfc850 two-digit year as the next century when that is within 50 years", async (t) => {
    t.mock.method(Date, "now", () => Date.parse("2080-06-01T00:00:00Z"));

    // In 2080, "10" is 2110 (30 years ahead: far future, no retry), not 2010 (past: retry now).
    assert.deepEqual(await runRetryAfter("Sunday, 01-Jun-10 00:00:00 GMT"), { waits: [], fetches: 1 });
  });

  void it("reads an rfc850 date across a century rollover", async (t) => {
    t.mock.method(Date, "now", () => Date.parse("2099-12-31T23:59:58Z"));

    assert.deepEqual(await runRetryAfter("Friday, 01-Jan-00 00:00:03 GMT"), { waits: [5_000], fetches: 2 });
  });

  void it("parses an obsolete asctime date as UTC regardless of the local time zone", async (t) => {
    t.mock.method(Date, "now", () => FIXED_NOW_MS);

    await inTimeZone("Pacific/Kiritimati", async () => {
      assert.equal(new Date(FIXED_NOW_MS).getTimezoneOffset(), -14 * 60, "time zone switch did not apply");
      assert.deepEqual(await runRetryAfter("Fri Sep 25 10:00:03 2026"), { waits: [3_000], fetches: 2 });
    });
  });

  void it("parses an asctime date with a space-padded day", async (t) => {
    t.mock.method(Date, "now", () => Date.parse("2026-09-05T10:00:00Z"));

    assert.deepEqual(await runRetryAfter("Sat Sep  5 10:00:04 2026"), { waits: [4_000], fetches: 2 });
  });

  void it("accepts a leap second", async (t) => {
    t.mock.method(Date, "now", () => Date.parse("2026-09-25T23:59:55Z"));

    assert.deepEqual(await runRetryAfter("Fri, 25 Sep 2026 23:59:60 GMT"), { waits: [5_000], fetches: 2 });
  });

  void it("accepts 29 February in a leap year", async (t) => {
    t.mock.method(Date, "now", () => Date.parse("2028-02-29T10:00:00Z"));

    assert.deepEqual(await runRetryAfter("Tue, 29 Feb 2028 10:00:03 GMT"), { waits: [3_000], fetches: 2 });
  });

  void it("does not retry when the HTTP-date is further away than maxRetryAfterMs", async (t) => {
    t.mock.method(Date, "now", () => FIXED_NOW_MS);

    assert.deepEqual(await runRetryAfter("Fri, 25 Sep 2026 10:00:11 GMT"), { waits: [], fetches: 1 });
  });

  // Each of these would give a different wait (or none) if handed to Date.parse.
  const unusable = [
    "-1",
    "1.5",
    "+3",
    "3 s",
    "Fri, 25 Sep 2026 10:00:05 UTC",
    "Fri, 25 Sep 26 10:00:05 GMT",
    "fri, 25 Sep 2026 10:00:05 GMT",
    "Fri, 25 sep 2026 10:00:05 GMT",
    "Fri, 25 Foo 2026 10:00:05 GMT",
    "Fri, 00 Sep 2026 10:00:05 GMT",
    "Thu, 31 Sep 2026 10:00:05 GMT",
    "Sat, 29 Feb 2027 10:00:05 GMT",
    "Fri, 25 Sep 2026 24:00:00 GMT",
    "Fri, 25 Sep 2026 10:60:00 GMT",
    "Fri, 25 Sep 2026 10:00:61 GMT",
    "Fri, 25 Sep 2026 10:00:05 GMT trailing",
    "Friday, 25-Sep-2026 10:00:05 GMT",
    "Fri Sep 25 10:00:05 26",
  ];

  for (const value of unusable) {
    void it(`falls back to retryDelayMs for retry-after ${JSON.stringify(value)}`, async (t) => {
      t.mock.method(Date, "now", () => FIXED_NOW_MS);

      assert.deepEqual(await runRetryAfter(value), { waits: [RETRY_DELAY_MS], fetches: 2 });
    });
  }
});

void describe("createHttpClient: failures", () => {
  void it("treats a 3xx as an HttpError without following or retrying it", async () => {
    const moved = jsonResponse(301, { message: "Moved Permanently" }, { location: "https://example.test/new" });
    const { client, calls, waits } = harness([moved, jsonResponse(200, {})]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 301);
    assert.equal(error.url, URL_ITEMS);
    assert.match(error.bodyExcerpt, /Moved Permanently/);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });

  void it("limits the HttpError body excerpt to 500 chars", async () => {
    const { client } = harness([textResponse(404, "b".repeat(2_000))]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.equal(error.bodyExcerpt, "b".repeat(500));
    assert.equal(error.message, `GET ${URL_ITEMS} -> HTTP 404: ${"b".repeat(500)}`);
  });

  void it("includes the cause of a network error in the reason", async () => {
    const failure = new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND example.test") });
    const { client } = harness([failure], {});

    const error = await rejection(client.request({ ...GET, retry: "no-retry" }));

    assert.ok(error instanceof NetworkError);
    assert.match(error.message, /failed: fetch failed \(getaddrinfo ENOTFOUND example\.test\)$/);
  });

  void it("uses the cause's code when the cause has an empty message (dual-stack connect failure)", async () => {
    const cause = Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" });
    const { client } = harness([new TypeError("fetch failed", { cause })]);

    const error = await rejection(client.request({ ...GET, retry: "no-retry" }));

    assert.ok(error instanceof NetworkError);
    assert.equal(error.message, `GET ${URL_ITEMS} failed: fetch failed (ECONNREFUSED)`);
  });

  void it("falls back to the cause's name when it has neither message nor string code", async () => {
    const cause = Object.assign(new AggregateError([], ""), { code: 111 });
    const { client } = harness([new TypeError("fetch failed", { cause })]);

    const error = await rejection(client.request({ ...GET, retry: "no-retry" }));

    assert.equal(error.message, `GET ${URL_ITEMS} failed: fetch failed (AggregateError)`);
  });

  void it("uses the error's name when a thrown Error has no message", async () => {
    const { client } = harness([new TypeError("")]);

    const error = await rejection(client.request({ ...GET, retry: "no-retry" }));

    assert.equal(error.message, `GET ${URL_ITEMS} failed: TypeError`);
  });

  void it("does not end the HttpError excerpt in half a surrogate pair", async () => {
    const { client } = harness([textResponse(500, `a${"😀".repeat(300)}`)]);

    const error = await rejection(client.request({ ...GET, retry: "no-retry" }));

    assert.ok(error instanceof HttpError);
    assert.equal(error.bodyExcerpt, `a${"😀".repeat(249)}`);
  });

  void it("keeps a pair that ends exactly at the excerpt limit", async () => {
    const { client } = harness([textResponse(500, "😀".repeat(251))]);

    const error = await rejection(client.request({ ...GET, retry: "no-retry" }));

    assert.ok(error instanceof HttpError);
    assert.equal(error.bodyExcerpt, "😀".repeat(250));
  });

  void it("does not end the invalid-JSON excerpt in half a surrogate pair", async () => {
    const { client } = harness([textResponse(200, `<${"😀".repeat(150)}`)]);

    const error = await rejection(client.request(GET));

    assert.ok(error.message.endsWith(`: <${"😀".repeat(99)}`));
  });

  void it("stringifies a non-Error rejection", async () => {
    const throwingFetch: typeof fetch = () =>
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- covers non-Error rejections
      Promise.reject("socket hang up");
    const { client } = harness([], { fetch: throwingFetch });

    const error = await rejection(client.request({ ...GET, retry: "no-retry" }));

    assert.ok(error instanceof NetworkError);
    assert.equal(error.message, `GET ${URL_ITEMS} failed: socket hang up`);
  });

  void it("treats a failure while reading the body as a network error", async () => {
    const brokenStream = new ReadableStream({
      start(controller) {
        controller.error(new Error("stream reset"));
      },
    });
    const { client } = harness([new Response(brokenStream, { status: 200 })]);

    const error = await rejection(client.request({ ...GET, retry: "no-retry" }));

    assert.ok(error instanceof NetworkError);
    assert.match(error.message, /stream reset/);
  });
});

void describe("createHttpClient: secret redaction", () => {
  void it("redacts header values quoted in a fetch error", async () => {
    const failure = new TypeError(`Headers.append: "Bearer ${TOKEN}" is an invalid header value.`);
    const { client } = harness([failure]);

    const error = await rejection(client.request({ ...GET, retry: "no-retry" }));

    assert.ok(error instanceof NetworkError);
    assert.ok(!error.message.includes(TOKEN));
    assert.equal(error.message, `GET ${URL_ITEMS} failed: Headers.append: "[redacted]" is an invalid header value.`);
  });

  void it("redacts a token part echoed without its scheme", async () => {
    const { client } = harness([jsonResponse(401, { message: `Bad credentials: ${TOKEN}` })]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.ok(!error.message.includes(TOKEN));
    assert.ok(!error.bodyExcerpt.includes(TOKEN));
    assert.match(error.bodyExcerpt, /Bad credentials: \[redacted\]/);
  });

  void it("redacts header values in an invalid-JSON error", async () => {
    const { client } = harness([textResponse(200, `token=${TOKEN} not json`)]);

    const error = await rejection(client.request(GET));

    assert.ok(!error.message.includes(TOKEN));
    assert.match(error.message, /token=\[redacted\] not json/);
  });

  void it("redacts before truncating, so a token straddling the cut leaks no prefix", async () => {
    const { client } = harness([textResponse(500, `${"x".repeat(495)}${TOKEN}`)]);

    const error = await rejection(client.request({ ...GET, retry: "no-retry" }));

    assert.ok(error instanceof HttpError);
    assert.equal(error.bodyExcerpt, `${"x".repeat(495)}[reda`);
  });

  void it("redacts every occurrence of a header value", async () => {
    const { client } = harness([textResponse(401, `${TOKEN} and again ${TOKEN}`)]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.equal(error.bodyExcerpt, "[redacted] and again [redacted]");
  });

  void it("redacts the raw value quoted by a real Headers validation error", async () => {
    const validatingFetch: typeof fetch = (input, init) =>
      Promise.resolve().then(() => {
        new Request(input, init);
        return jsonResponse(200, {});
      });
    const { client } = harness([], { fetch: validatingFetch });
    const headers = { Authorization: "Bearer perm-abc.def\nghi-jkl" };

    const error = await rejection(client.request({ ...GET, headers, retry: "no-retry" }));

    assert.ok(error instanceof NetworkError);
    assert.ok(!error.message.includes("perm-abc"));
    assert.ok(!error.message.includes("ghi-jkl"));
    assert.match(error.message, /\[redacted\]/);
  });

  void it("leaves short header values such as the auth scheme alone", async () => {
    const { client } = harness([textResponse(401, "Bearer realm=api")]);

    const error = await rejection(client.request({ ...GET, headers: { Authorization: "Bearer abc" } }));

    assert.ok(error instanceof HttpError);
    assert.equal(error.bodyExcerpt, "Bearer realm=api");
  });
});
