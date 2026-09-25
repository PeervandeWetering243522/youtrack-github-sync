import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createHttpClient,
  DEFAULT_MAX_FETCHES,
  DEFAULT_MAX_RETRY_AFTER_MS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  USER_AGENT,
} from "../src/http.ts";
import type { HttpClientOptions } from "../src/http.ts";
import { BASE_OPTIONS, MAX_TIMER_MS, scriptedFetch } from "./http-harness.ts";

describe("createHttpClient: option validation", () => {
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
    it(`rejects ${name} = ${String(Object.values(overrides)[0])} with a RangeError`, () => {
      const options = { ...BASE_OPTIONS, fetch: scriptedFetch([]).fetch, sleep: noSleep, ...overrides };

      assert.throws(() => createHttpClient(options), { name: "RangeError", message: new RegExp(name) });
    });
  }

  it("lists every invalid option in one error", () => {
    const options = { ...BASE_OPTIONS, fetch: scriptedFetch([]).fetch, sleep: noSleep, maxFetches: -1, timeoutMs: 0 };

    assert.throws(() => createHttpClient(options), { message: /maxFetches.*; timeoutMs/ });
  });

  it("accepts the exported defaults", () => {
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

  it("accepts the largest delay timers honour for timeoutMs and maxRetryAfterMs", () => {
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
