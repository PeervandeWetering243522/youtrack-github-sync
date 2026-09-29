/**
 * Shared fixtures for the createHttpClient tests (test/http/*.test.ts): a scripted fake
 * fetch, a recording sleep and small response and assertion helpers.
 */

import assert from "node:assert/strict";

import { createHttpClient, HttpError } from "../../src/http.ts";
import type { HttpClient, HttpClientOptions, HttpRequest, HttpResponse } from "../../src/http.ts";
import type { JsonValue } from "../../src/json.ts";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

export type RecordedCall = { readonly input: FetchInput; readonly init: FetchInit };
/** A scripted fetch outcome: resolve with the Response, or reject with the Error. */
export type Outcome = Response | Error;
export type Harness = {
  readonly client: HttpClient;
  readonly calls: readonly RecordedCall[];
  readonly waits: readonly number[];
};

export const URL_ITEMS = "https://example.test/api/items";
export const TOKEN = "secret-token-123";
export const RETRY_DELAY_MS = 2_000;
export const MAX_RETRY_AFTER_MS = 10_000;
export const FIXED_NOW_MS = Date.parse("2026-09-25T10:00:00Z");
export const MAX_TIMER_MS = 2_147_483_647;

export const GET: HttpRequest = {
  method: "GET",
  url: URL_ITEMS,
  headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
  retry: "retry-once",
};
export const POST: HttpRequest = { ...GET, method: "POST", body: { title: "Hello", labels: ["a"] }, retry: "no-retry" };

export const BASE_OPTIONS = {
  userAgent: "test-agent/1.0",
  maxFetches: 10,
  timeoutMs: 1_000,
  retryDelayMs: RETRY_DELAY_MS,
  maxRetryAfterMs: MAX_RETRY_AFTER_MS,
} as const;

/** A fake fetch that replays `outcomes` in order and records every call. */
export function scriptedFetch(outcomes: readonly Outcome[]): {
  readonly fetch: typeof fetch;
  readonly calls: RecordedCall[];
} {
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

export function harness(
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

export function jsonResponse(
  status: number,
  body: JsonValue,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function textResponse(status: number, text: string, headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(text, { status, headers });
}

/** A response without a content-type header (a string body would get text/plain). */
export function untypedResponse(status: number, text: string): Response {
  return new Response(new TextEncoder().encode(text), { status });
}

/** A response with the given status whose body stream fails when read. */
export function brokenBodyResponse(status: number, headers: Readonly<Record<string, string>> = {}): Response {
  const brokenStream = new ReadableStream({
    start(controller) {
      controller.error(new Error("stream reset"));
    },
  });
  return new Response(brokenStream, { status, headers });
}

export function callAt(calls: readonly RecordedCall[], index: number): RecordedCall {
  const call = calls[index];
  assert.ok(call, `expected fetch call #${String(index)}`);
  return call;
}

export function sentHeaders(call: RecordedCall): Headers {
  return new Headers(call.init?.headers);
}

/** Awaits a request that must fail and returns its error. */
export async function rejection(promise: Promise<HttpResponse>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error, "expected an Error to be thrown");
    return error;
  }
  assert.fail("expected the request to reject");
}

export type RetryRun = { readonly waits: readonly number[]; readonly fetches: number };

/** Sends a retry-once GET answered by `first` then a 200; reports the waits and fetch count. */
export async function runRetry(first: Response): Promise<RetryRun> {
  const { client, calls, waits } = harness([first, jsonResponse(200, {})]);
  try {
    await client.request(GET);
  } catch (error) {
    assert.ok(error instanceof HttpError, "only the first response's HttpError may escape");
  }
  return { waits, fetches: calls.length };
}

/** A 429 carrying the given retry-after, then a 200. */
export function runRetryAfter(retryAfter: string): Promise<RetryRun> {
  return runRetry(textResponse(429, "", { "retry-after": retryAfter }));
}

/** Runs `run` with the process clock in `zone`, restoring the original zone afterwards. */
export async function inTimeZone(zone: string, run: () => Promise<void>): Promise<void> {
  const original = Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env["TZ"] = zone;
  try {
    await run();
  } finally {
    process.env["TZ"] = original;
  }
}
