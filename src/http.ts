/**
 * Shared fetch wrapper used for both APIs: User-Agent, per-request timeout,
 * a hard fetch budget (Workers Free allows 50 subrequests per invocation),
 * a retry-once policy for safe requests, and typed errors.
 */

import { HTTP_FORBIDDEN, HTTP_TOO_MANY_REQUESTS, isPrimaryRateLimit, isRateLimited } from "./http/rate-limit.ts";
import { requestRedactor } from "./http/redact.ts";
import { parseRetryAfterMs } from "./http/retry-after.ts";
import { parseJson, type JsonValue } from "./json.ts";
import { redactedExcerpt } from "./utils/redact.ts";

export type HttpMethod = "GET" | "POST" | "PATCH";

/**
 * "retry-once": on a network error, timeout, 5xx, 429 or a 403 carrying retry-after
 * (GitHub's secondary rate limit), wait and try exactly once more. A 403/429 with
 * x-ratelimit-remaining: 0 (GitHub's primary rate limit) is retried only when it also
 * carries a usable retry-after within maxRetryAfterMs: GitHub says to wait for
 * x-ratelimit-reset, so a retry after the default delay would only burn a fetch.
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
  /**
   * Resolves only for 2xx. Otherwise it throws:
   * - FetchBudgetExceededError when the budget is spent before the first attempt, so nothing was sent;
   * - HttpError / NetworkError when the request was sent and failed. A retry the budget cannot pay
   *   for (checked before the wait, and again after it in case a concurrent request spent the last
   *   unit) is skipped, and the first attempt's failure is thrown: a write that really failed
   *   counts as failed, not as refused by the budget.
   * A non-2xx whose body cannot be read is still an HttpError with that status and an empty excerpt.
   * A 2xx whose body is not JSON throws a plain Error that quotes the body only when its content type
   * is present and not JSON (see invalidJsonDetail).
   */
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
  /** First ~500 chars of the response body with credential header values redacted, for logs. */
  readonly bodyExcerpt: string;
  /**
   * GitHub refused the request for a rate limit (decision R7): a 403 or 429 with
   * x-ratelimit-remaining: 0, with retry-after, or whose body names a secondary rate limit.
   */
  readonly rateLimited: boolean;

  constructor(method: HttpMethod, url: string, status: number, bodyExcerpt: string, rateLimited = false) {
    super(`${method} ${url} -> HTTP ${String(status)}: ${bodyExcerpt}`);
    this.name = "HttpError";
    this.method = method;
    this.url = url;
    this.status = status;
    this.bodyExcerpt = bodyExcerpt;
    this.rateLimited = rateLimited;
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

/**
 * Thrown instead of a request's first fetch() when that would exceed maxFetches: nothing was
 * sent. A retry the budget cannot pay for is skipped instead (see HttpClient.request).
 */
export class FetchBudgetExceededError extends Error {
  readonly maxFetches: number;

  constructor(maxFetches: number) {
    super(`Fetch budget of ${String(maxFetches)} requests exhausted`);
    this.name = "FetchBudgetExceededError";
    this.maxFetches = maxFetches;
  }
}

/**
 * One client per run: every request it makes draws from the same fetch budget.
 * Throws RangeError for numeric options that would disable the budget or break every request.
 */
export function createHttpClient(options: HttpClientOptions): HttpClient {
  assertValidOptions(options);
  let fetchCount = 0;

  const hasBudget = (): boolean => fetchCount < options.maxFetches;

  const attempt = (url: string, init: RequestInit): Promise<Attempt> => {
    fetchCount += 1;
    return performFetch(options, url, init);
  };

  const request = async (httpRequest: HttpRequest): Promise<HttpResponse> => {
    // Built once and before any budget is spent: a body JSON.stringify rejects is a
    // programming error, so it throws as-is instead of posing as a network failure.
    const init = buildRequestInit(httpRequest, options.userAgent);
    if (!hasBudget()) {
      throw new FetchBudgetExceededError(options.maxFetches);
    }
    const first = await attempt(httpRequest.url, init);
    if (isSuccess(first)) {
      return toHttpResponse(httpRequest, first);
    }
    const waitMs = retryWaitMs(httpRequest.retry, first, options);
    // No point waiting for a retry the budget cannot pay for.
    if (waitMs === undefined || !hasBudget()) {
      throw toFailure(httpRequest, first);
    }
    await options.sleep(waitMs);
    // A concurrent request may have spent the last unit during the wait.
    if (!hasBudget()) {
      throw toFailure(httpRequest, first);
    }
    const second = await attempt(httpRequest.url, init);
    if (isSuccess(second)) {
      return toHttpResponse(httpRequest, second);
    }
    throw toFailure(httpRequest, second);
  };

  return {
    request,
    fetchCount: () => fetchCount,
    remainingFetches: () => Math.max(0, options.maxFetches - fetchCount),
  };
}

const BODY_EXCERPT_CHARS = 500;
const INVALID_JSON_EXCERPT_CHARS = 200;
/** Largest delay setTimeout / AbortSignal.timeout honour (2^31 - 1 ms, about 24.8 days). */
const MAX_TIMER_MS = 2_147_483_647;
const HTTP_SERVER_ERROR_MIN = 500;
const JSON_CONTENT_TYPE = "application/json";
const JSON_SUFFIX = "+json";

/** A response whose body has been read as text ("" when a non-2xx body could not be read). */
type ResponseAttempt = {
  readonly kind: "response";
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
};

/** fetch() threw (network, TLS, timeout, abort), or reading a 2xx body did. */
type NetworkFailure = {
  readonly kind: "network-failure";
  readonly reason: string;
};

type Attempt = ResponseAttempt | NetworkFailure;

// ---------------------------------------------------------------------------
// Options and requests

/**
 * NaN never compares >= so it would switch the budget off; AbortSignal.timeout needs an integer.
 * Timers clamp delays above MAX_TIMER_MS to 1 ms, which would time out every request (or
 * skip a setTimeout-based sleep), so both waits are capped there.
 */
function assertValidOptions(options: HttpClientOptions): void {
  const problems = [
    isCount(options.maxFetches) ? [] : ["maxFetches must be a non-negative integer"],
    isCount(options.timeoutMs) && options.timeoutMs > 0 && options.timeoutMs <= MAX_TIMER_MS
      ? []
      : [`timeoutMs must be an integer from 1 to ${String(MAX_TIMER_MS)}`],
    isDuration(options.retryDelayMs) ? [] : ["retryDelayMs must be a non-negative finite number"],
    isDuration(options.maxRetryAfterMs) && options.maxRetryAfterMs <= MAX_TIMER_MS
      ? []
      : [`maxRetryAfterMs must be a non-negative number up to ${String(MAX_TIMER_MS)}`],
  ].flat();
  if (problems.length > 0) {
    throw new RangeError(`Invalid HttpClientOptions: ${problems.join("; ")}`);
  }
}

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isDuration(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/** Everything but the signal, which must be fresh for every attempt. */
function buildRequestInit(request: HttpRequest, userAgent: string): RequestInit {
  const body = request.body === undefined ? undefined : JSON.stringify(request.body);
  return {
    method: request.method,
    headers: outgoingHeaders(request.headers, userAgent, body !== undefined),
    ...(body === undefined ? {} : { body }),
    // A 3xx surfaces as an HttpError: a moved repo fails loudly, and credentials
    // are never re-sent to another location or charged against the budget.
    redirect: "manual",
  };
}

/**
 * Caller headers plus User-Agent (and Content-Type with a body). A caller header
 * with the same name in any case is dropped: fetch would join both into one value.
 */
function outgoingHeaders(
  callerHeaders: Readonly<Record<string, string>>,
  userAgent: string,
  hasBody: boolean,
): Readonly<Record<string, string>> {
  const ownHeaders: Readonly<Record<string, string>> = {
    "User-Agent": userAgent,
    ...(hasBody ? { "Content-Type": JSON_CONTENT_TYPE } : {}),
  };
  const ownNames = new Set(Object.keys(ownHeaders).map((name) => name.toLowerCase()));
  const kept = Object.entries(callerHeaders).filter(([name]) => !ownNames.has(name.toLowerCase()));
  return { ...Object.fromEntries(kept), ...ownHeaders };
}

async function performFetch(options: HttpClientOptions, url: string, init: RequestInit): Promise<Attempt> {
  // Called unbound: `options.fetch(...)` would pass `options` as `this`, and the Workers
  // global fetch rejects any foreign `this` with "TypeError: Illegal invocation".
  const { fetch: send } = options;
  try {
    const response = await send(url, { ...init, signal: AbortSignal.timeout(options.timeoutMs) });
    // A non-2xx body only feeds the error excerpt: failing to read it must not turn a status
    // that already says what went wrong into a (retryable) network failure.
    const text = isSuccessStatus(response.status) ? await response.text() : await errorBodyText(response);
    return { kind: "response", status: response.status, headers: response.headers, text };
  } catch (error) {
    const reason = error instanceof Error ? describeError(error) : String(error);
    return { kind: "network-failure", reason };
  }
}

/** The body of a non-2xx response, or "" when it cannot be read (reset, timeout mid-body). */
async function errorBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/** Node's fetch reports "fetch failed" and keeps the useful part in `cause`. */
function describeError(error: Error): string {
  const detail = errorDetail(error);
  return error.cause instanceof Error ? `${detail} (${errorDetail(error.cause)})` : detail;
}

/**
 * The message, else the error code, else the name. A dual-stack connect failure's
 * cause is an AggregateError with an empty message and a code like "ECONNREFUSED".
 */
function errorDetail(error: Error): string {
  if (error.message !== "") {
    return error.message;
  }
  return "code" in error && typeof error.code === "string" ? error.code : error.name;
}

// ---------------------------------------------------------------------------
// Retry policy

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function isSuccess(attempt: Attempt): attempt is ResponseAttempt {
  return attempt.kind === "response" && isSuccessStatus(attempt.status);
}

function isRetryable(attempt: Attempt): boolean {
  if (attempt.kind === "network-failure") {
    return true;
  }
  const { status, headers } = attempt;
  return (
    status === HTTP_TOO_MANY_REQUESTS ||
    status >= HTTP_SERVER_ERROR_MIN ||
    (status === HTTP_FORBIDDEN && headers.has("retry-after"))
  );
}

/** Milliseconds to wait before the single retry, or undefined when no retry should happen. */
function retryWaitMs(policy: RetryPolicy, failed: Attempt, options: HttpClientOptions): number | undefined {
  if (policy === "no-retry" || !isRetryable(failed)) {
    return undefined;
  }
  const headerWaitMs =
    failed.kind === "response" ? parseRetryAfterMs(failed.headers.get("retry-after"), Date.now()) : undefined;
  // Out of requests until x-ratelimit-reset: only a retry-after we can wait for is worth a fetch.
  if (headerWaitMs === undefined && failed.kind === "response" && isPrimaryRateLimit(failed)) {
    return undefined;
  }
  const waitMs = headerWaitMs ?? options.retryDelayMs;
  return waitMs > options.maxRetryAfterMs ? undefined : waitMs;
}

// ---------------------------------------------------------------------------
// Responses and errors

function toHttpResponse(request: HttpRequest, attempt: ResponseAttempt): HttpResponse {
  return { status: attempt.status, headers: attempt.headers, body: parseBody(request, attempt) };
}

function parseBody(request: HttpRequest, attempt: ResponseAttempt): JsonValue {
  if (attempt.text.trim() === "") {
    return null;
  }
  try {
    return parseJson(attempt.text);
  } catch {
    const detail = invalidJsonDetail(request, attempt);
    throw new Error(
      `${request.method} ${request.url} -> HTTP ${String(attempt.status)}: response is not valid JSON ${detail}`,
    );
  }
}

/**
 * Length and content type, plus a redacted excerpt only for a declared non-JSON type (an SSO
 * login page, say). A broken JSON body is never quoted: a YouTrack scan page would put an
 * issue description into the logs (decision R3). A missing content type is treated the same way.
 */
function invalidJsonDetail(request: HttpRequest, attempt: ResponseAttempt): string {
  const contentType = attempt.headers.get("content-type");
  const meta = `(${String(attempt.text.length)} chars, content-type ${contentType ?? "none"})`;
  if (contentType === null || isJsonContentType(contentType)) {
    return meta;
  }
  const excerpt = redactedExcerpt(requestRedactor(request.headers), attempt.text, INVALID_JSON_EXCERPT_CHARS);
  return `${meta}: ${excerpt}`;
}

/** application/json, or any structured +json type such as application/vnd.github+json. */
function isJsonContentType(contentType: string): boolean {
  const mediaType = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  return mediaType === JSON_CONTENT_TYPE || mediaType.endsWith(JSON_SUFFIX);
}

/** Every error text is redacted (see src/http/redact.ts): fetch errors can quote a header value. */
function toFailure(request: HttpRequest, attempt: Attempt): HttpError | NetworkError {
  const redact = requestRedactor(request.headers);
  if (attempt.kind === "network-failure") {
    return new NetworkError(request.method, request.url, redact(attempt.reason));
  }
  const excerpt = redactedExcerpt(redact, attempt.text, BODY_EXCERPT_CHARS);
  return new HttpError(request.method, request.url, attempt.status, excerpt, isRateLimited(attempt));
}
