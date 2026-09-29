import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHttpClient, FetchBudgetExceededError, HttpError, NetworkError } from "../../src/http.ts";
import type { HttpClientOptions, HttpRequest, HttpResponse } from "../../src/http.ts";
import type { JsonValue } from "../../src/json.ts";
import {
  BASE_OPTIONS,
  callAt,
  GET,
  harness,
  jsonResponse,
  POST,
  rejection,
  scriptedFetch,
  sentHeaders,
  textResponse,
  TOKEN,
  URL_ITEMS,
} from "./fixtures.ts";

describe("createHttpClient: successful responses", () => {
  it("returns status, headers and parsed JSON body for a 2xx", async () => {
    // Arrange
    const { client } = harness([jsonResponse(200, { id: "2-1", tags: [1, 2] }, { "x-total": "7" })]);

    // Act
    const response = await client.request(GET);

    // Assert
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-total"), "7");
    assert.deepEqual(response.body, { id: "2-1", tags: [1, 2] });
  });

  it("returns a null body for an empty response", async () => {
    const { client } = harness([new Response(null, { status: 204 })]);

    const response = await client.request(GET);

    assert.equal(response.status, 204);
    assert.equal(response.body, null);
  });

  it("returns a null body for a 200 with an empty string body", async () => {
    const { client } = harness([textResponse(200, "", { "content-type": "application/json" })]);

    const response = await client.request(GET);

    assert.equal(response.status, 200);
    assert.equal(response.body, null);
  });

  it("returns a null body for a whitespace-only response", async () => {
    const { client } = harness([textResponse(200, "  \n")]);

    const response = await client.request(GET);

    assert.equal(response.body, null);
  });

  it("throws an Error naming method and URL for a 2xx with invalid JSON, excerpting at most 200 chars", async () => {
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

describe("createHttpClient: request shape", () => {
  it("sends caller headers plus User-Agent, and no body or Content-Type without a body", async () => {
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

  it("serialises a JSON body and sets Content-Type", async () => {
    const { client, calls } = harness([jsonResponse(201, { number: 5 })]);

    const response = await client.request(POST);

    const call = callAt(calls, 0);
    assert.equal(response.status, 201);
    assert.equal(call.init?.method, "POST");
    assert.equal(call.init.body, JSON.stringify({ title: "Hello", labels: ["a"] }));
    assert.equal(sentHeaders(call).get("content-type"), "application/json");
  });

  it("serialises a JSON null body instead of omitting it", async () => {
    const { client, calls } = harness([jsonResponse(200, {})]);

    await client.request({ ...GET, method: "PATCH", body: null });

    assert.equal(callAt(calls, 0).init?.body, "null");
  });

  it("calls fetch unbound, since the Workers global fetch rejects a foreign `this` (Illegal invocation)", async () => {
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

  it("passes a fresh, unaborted timeout signal and manual redirect handling", async () => {
    const { client, calls } = harness([jsonResponse(200, {})]);

    await client.request(GET);

    const init = callAt(calls, 0).init;
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.redirect, "manual");
  });

  it("does not mutate the caller's headers", async () => {
    const headers = Object.freeze({ Authorization: `Bearer ${TOKEN}` });
    const { client } = harness([jsonResponse(201, {})]);

    await client.request({ ...POST, headers });

    assert.deepEqual(headers, { Authorization: `Bearer ${TOKEN}` });
  });

  it("replaces a caller User-Agent spelled in another case instead of joining both", async () => {
    const { client, calls } = harness([jsonResponse(200, {})]);

    await client.request({ ...GET, headers: { ...GET.headers, "user-agent": "caller/0.1" } });

    assert.equal(sentHeaders(callAt(calls, 0)).get("user-agent"), "test-agent/1.0");
  });

  it("replaces a caller content-type when a JSON body is sent", async () => {
    const { client, calls } = harness([jsonResponse(201, {})]);

    await client.request({ ...POST, headers: { ...POST.headers, "content-type": "text/plain" } });

    assert.equal(sentHeaders(callAt(calls, 0)).get("content-type"), "application/json");
  });

  it("keeps a caller Content-Type when there is no body", async () => {
    const { client, calls } = harness([jsonResponse(200, {})]);

    await client.request({ ...GET, headers: { ...GET.headers, "Content-Type": "application/merge-patch+json" } });

    assert.equal(sentHeaders(callAt(calls, 0)).get("content-type"), "application/merge-patch+json");
  });

  it("sends the identical body and headers on the retry", async () => {
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

  it("works with a deeply frozen request across a retry", async () => {
    const body: JsonValue = Object.freeze({ labels: Object.freeze(["youtrack"]) });
    const headers = Object.freeze({ ...GET.headers });
    const request: HttpRequest = Object.freeze({ ...GET, method: "POST", headers, body });
    const { client, calls } = harness([textResponse(500, ""), jsonResponse(200, [])]);

    const response = await client.request(request);

    assert.deepEqual(response.body, []);
    assert.equal(calls.length, 2);
    assert.deepEqual(request.body, { labels: ["youtrack"] });
  });

  it("throws a body JSON cannot represent without calling fetch or spending budget", async () => {
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

  it("aborts a hanging fetch after timeoutMs and reports a NetworkError", async () => {
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

describe("createHttpClient: fetch budget", () => {
  it("starts with zero fetches and the full budget remaining", () => {
    const { client } = harness([]);

    assert.equal(client.fetchCount(), 0);
    assert.equal(client.remainingFetches(), 10);
  });

  it("throws FetchBudgetExceededError without calling fetch once the budget is spent", async () => {
    const { client, calls } = harness([jsonResponse(200, {}), jsonResponse(200, {})], { maxFetches: 1 });
    await client.request(GET);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof FetchBudgetExceededError);
    assert.equal(error.maxFetches, 1);
    assert.equal(calls.length, 1);
    assert.equal(client.fetchCount(), 1);
    assert.equal(client.remainingFetches(), 0);
  });

  it("never calls fetch with a zero budget", async () => {
    const { client, calls } = harness([jsonResponse(200, {})], { maxFetches: 0 });

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof FetchBudgetExceededError);
    assert.equal(calls.length, 0);
  });

  it("counts retries against the budget", async () => {
    const { client } = harness([textResponse(500, "boom"), jsonResponse(200, {})], { maxFetches: 5 });

    await client.request(GET);

    assert.equal(client.fetchCount(), 2);
    assert.equal(client.remainingFetches(), 3);
  });

  it("skips the wait and throws the first HttpError when the retry cannot be afforded", async () => {
    // The request was sent and failed: that is a failure, not a request the budget refused.
    const { client, calls, waits } = harness([textResponse(500, "boom"), jsonResponse(200, {})], { maxFetches: 1 });

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 500);
    assert.equal(error.bodyExcerpt, "boom");
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });

  it("throws the first NetworkError when the retry after a network failure cannot be afforded", async () => {
    const { client, calls, waits } = harness([new TypeError("fetch failed"), jsonResponse(200, {})], { maxFetches: 1 });

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof NetworkError);
    assert.equal(error.message, `GET ${URL_ITEMS} failed: fetch failed`);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });

  it("does not wait for a retry-after the budget cannot pay for", async () => {
    const { client, calls, waits } = harness([textResponse(429, "slow down", { "retry-after": "3" })], {
      maxFetches: 1,
    });

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 429);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });

  it("lets the retry spend the last unit of budget", async () => {
    const { client, calls } = harness([textResponse(500, "boom"), jsonResponse(200, { ok: true })], { maxFetches: 2 });

    const response = await client.request(GET);

    assert.deepEqual(response.body, { ok: true });
    assert.equal(calls.length, 2);
    assert.equal(client.remainingFetches(), 0);
  });

  it("throws the first failure when an earlier request left no budget for the retry", async () => {
    const { client, calls, waits } = harness([jsonResponse(200, {}), textResponse(503, "")], { maxFetches: 2 });
    await client.request(GET);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 503);
    assert.equal(calls.length, 2);
    assert.equal(client.fetchCount(), 2);
    assert.equal(client.remainingFetches(), 0);
    assert.deepEqual(waits, []);
  });

  it("throws the first failure after the wait when a concurrent request spent the last unit", async () => {
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
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 500);
    assert.equal(error.bodyExcerpt, "boom");
    assert.deepEqual((await other).body, { n: 2 });
    assert.equal(fake.calls.length, 2);
    assert.equal(client.remainingFetches(), 0);
  });

  it("shares one budget between concurrent requests", async () => {
    const { client, calls } = harness([jsonResponse(200, { n: 1 }), jsonResponse(200, { n: 2 })], { maxFetches: 1 });

    const first = client.request(GET);
    const second = client.request(GET);

    assert.deepEqual((await first).body, { n: 1 });
    assert.ok((await rejection(second)) instanceof FetchBudgetExceededError);
    assert.equal(calls.length, 1);
  });
});
