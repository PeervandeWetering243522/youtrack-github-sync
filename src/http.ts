/**
 * Shared fetch wrapper used for both APIs: User-Agent, per-request timeout,
 * a hard fetch budget (Workers Free allows 50 subrequests per invocation),
 * a retry-once policy for safe requests, and typed errors.
 */

import type { JsonValue } from "./json.ts";

export type HttpMethod = "GET" | "POST" | "PATCH";

/**
 * "retry-once": on a network error, timeout, 5xx or 429, wait and try exactly once more.
 * "no-retry": used for non-idempotent writes (GitHub issue create).
 */
export type RetryPolicy = "retry-once" | "no-retry";

export type HttpRequest = {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: JsonValue;
  readonly retry: RetryPolicy;
};

export type HttpResponse = {
  readonly status: number;
  readonly headers: Headers;
  /** Parsed JSON body, or null for an empty body. */
  readonly body: JsonValue;
};

export type HttpClientOptions = {
  readonly fetch: typeof fetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly userAgent: string;
  /** Hard cap on fetch() calls for the whole run, retries included. */
  readonly maxFetches: number;
  readonly timeoutMs: number;
  /** Wait before the single retry, unless a usable retry-after header says otherwise. */
  readonly retryDelayMs: number;
  /** retry-after values above this are not waited for (the retry is skipped). */
  readonly maxRetryAfterMs: number;
};

export type HttpClient = {
  /** Resolves only for 2xx; otherwise throws HttpError / FetchBudgetExceededError / NetworkError. */
  readonly request: (request: HttpRequest) => Promise<HttpResponse>;
  /** Number of fetch() calls made so far (attempts, including retries). */
  readonly fetchCount: () => number;
  readonly remainingFetches: () => number;
};

export const DEFAULT_MAX_FETCHES = 45;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_RETRY_DELAY_MS = 2_000;
export const DEFAULT_MAX_RETRY_AFTER_MS = 10_000;
export const USER_AGENT = "youtrack-gh-mirror";

/** Non-2xx response after the retry policy was applied. `url` never contains credentials. */
export class HttpError extends Error {
  readonly status: number;
  readonly method: HttpMethod;
  readonly url: string;
  /** First ~500 chars of the response body, for logs. */
  readonly bodyExcerpt: string;

  constructor(method: HttpMethod, url: string, status: number, bodyExcerpt: string) {
    super(`${method} ${url} -> HTTP ${String(status)}: ${bodyExcerpt}`);
    this.name = "HttpError";
    this.method = method;
    this.url = url;
    this.status = status;
    this.bodyExcerpt = bodyExcerpt;
  }
}

/** fetch() threw (DNS, TLS, reset, timeout) and the retry policy did not recover. */
export class NetworkError extends Error {
  readonly method: HttpMethod;
  readonly url: string;

  constructor(method: HttpMethod, url: string, reason: string) {
    super(`${method} ${url} failed: ${reason}`);
    this.name = "NetworkError";
    this.method = method;
    this.url = url;
  }
}

/** Thrown before a fetch() that would exceed maxFetches. */
export class FetchBudgetExceededError extends Error {
  readonly maxFetches: number;

  constructor(maxFetches: number) {
    super(`Fetch budget of ${String(maxFetches)} requests exhausted`);
    this.name = "FetchBudgetExceededError";
    this.maxFetches = maxFetches;
  }
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  void options;
  throw new Error("not implemented");
}
