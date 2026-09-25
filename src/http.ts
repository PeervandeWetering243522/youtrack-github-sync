/**
 * Shared fetch wrapper used for both APIs: User-Agent, per-request timeout,
 * a hard fetch budget (Workers Free allows 50 subrequests per invocation),
 * a retry-once policy for safe requests, and typed errors.
 */

import { parseJson, type JsonValue } from "./json.ts";

export type HttpMethod = "GET" | "POST" | "PATCH";

/**
 * "retry-once": on a network error, timeout, 5xx, 429 or a 403 carrying retry-after
 * (GitHub's secondary rate limit), wait and try exactly once more.
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
   * Resolves only for 2xx; otherwise throws HttpError / FetchBudgetExceededError / NetworkError.
   * A 2xx whose body is not JSON throws a plain Error.
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

/**
 * One client per run: every request it makes draws from the same fetch budget.
 * Throws RangeError for numeric options that would disable the budget or break every request.
 */
export function createHttpClient(options: HttpClientOptions): HttpClient {
  assertValidOptions(options);
  let fetchCount = 0;

  const ensureBudget = (): void => {
    if (fetchCount >= options.maxFetches) {
      throw new FetchBudgetExceededError(options.maxFetches);
    }
  };

  const attempt = async (url: string, init: RequestInit): Promise<Attempt> => {
    ensureBudget();
    fetchCount += 1;
    return performFetch(options, url, init);
  };

  const request = async (httpRequest: HttpRequest): Promise<HttpResponse> => {
    // Built once and before any budget is spent: a body JSON.stringify rejects is a
    // programming error, so it throws as-is instead of posing as a network failure.
    const init = buildRequestInit(httpRequest, options.userAgent);
    const first = await attempt(httpRequest.url, init);
    if (isSuccess(first)) {
      return toHttpResponse(httpRequest, first);
    }
    const waitMs = retryWaitMs(httpRequest.retry, first, options);
    if (waitMs === undefined) {
      throw toFailure(httpRequest, first);
    }
    // No point waiting for a retry the budget cannot pay for.
    ensureBudget();
    await options.sleep(waitMs);
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
const MS_PER_SECOND = 1_000;
/** Largest delay setTimeout / AbortSignal.timeout honour (2^31 - 1 ms, about 24.8 days). */
const MAX_TIMER_MS = 2_147_483_647;
/** RFC 9110: an rfc850 date more than this far ahead belongs to the previous century. */
const RFC850_MAX_YEARS_AHEAD = 50;
const YEARS_PER_CENTURY = 100;
const JSON_CONTENT_TYPE = "application/json";
/** Header values (and their parts) shorter than this are not treated as secrets. */
const MIN_SECRET_CHARS = 8;
const REDACTED = "[redacted]";
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const DELTA_SECONDS = /^\d+$/;
// HTTP-date (RFC 9110 section 5.6.7): IMF-fixdate plus the two obsolete forms a recipient must
// accept. Day names are shape-checked only; the value comes from day, month, year and time.
const MONTH_GROUP = "(?<month>[A-Z][a-z]{2})";
const TIME_GROUPS = String.raw`(?<hour>\d\d):(?<minute>\d\d):(?<second>\d\d)`;
const IMF_FIXDATE = new RegExp(String.raw`^[A-Z][a-z]{2}, (?<day>\d\d) ${MONTH_GROUP} (?<year>\d{4}) ${TIME_GROUPS} GMT$`);
const RFC850_DATE = new RegExp(String.raw`^[A-Z][a-z]{5,8}, (?<day>\d\d)-${MONTH_GROUP}-(?<yy>\d\d) ${TIME_GROUPS} GMT$`);
const ASCTIME_DATE = new RegExp(String.raw`^[A-Z][a-z]{2} ${MONTH_GROUP} (?<day>[ \d]\d) ${TIME_GROUPS} (?<year>\d{4})$`);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** A response whose body has been read as text. */
type ResponseAttempt = {
  readonly kind: "response";
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
};

/** fetch() or reading the body threw (network, TLS, timeout, abort). */
type NetworkFailure = {
  readonly kind: "network-failure";
  readonly reason: string;
};

type Attempt = ResponseAttempt | NetworkFailure;

/** Calendar fields of an HTTP-date; `month` is 0-11, or -1 for an unknown month name. */
type DateTimeParts = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
};

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
    const text = await response.text();
    return { kind: "response", status: response.status, headers: response.headers, text };
  } catch (error) {
    const reason = error instanceof Error ? describeError(error) : String(error);
    return { kind: "network-failure", reason };
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

function isSuccess(attempt: Attempt): attempt is ResponseAttempt {
  return attempt.kind === "response" && attempt.status >= 200 && attempt.status < 300;
}

function isRetryable(attempt: Attempt): boolean {
  if (attempt.kind === "network-failure") {
    return true;
  }
  const { status, headers } = attempt;
  return status === 429 || status >= 500 || (status === 403 && headers.has("retry-after"));
}

/** Milliseconds to wait before the single retry, or undefined when no retry should happen. */
function retryWaitMs(policy: RetryPolicy, failed: Attempt, options: HttpClientOptions): number | undefined {
  if (policy === "no-retry" || !isRetryable(failed)) {
    return undefined;
  }
  const headerWaitMs =
    failed.kind === "response" ? parseRetryAfterMs(failed.headers.get("retry-after"), Date.now()) : undefined;
  const waitMs = headerWaitMs ?? options.retryDelayMs;
  return waitMs > options.maxRetryAfterMs ? undefined : waitMs;
}

/** Parses retry-after (delta-seconds or HTTP-date) into a wait; undefined when absent or unusable. */
function parseRetryAfterMs(value: string | null, nowMs: number): number | undefined {
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (DELTA_SECONDS.test(trimmed)) {
    return Number(trimmed) * MS_PER_SECOND;
  }
  const dateMs = parseHttpDateMs(trimmed, nowMs);
  return dateMs === undefined ? undefined : Math.max(0, dateMs - nowMs);
}

/** Epoch ms of an HTTP-date in any of its three forms (all UTC), or undefined. */
function parseHttpDateMs(value: string, nowMs: number): number | undefined {
  const groups = (IMF_FIXDATE.exec(value) ?? RFC850_DATE.exec(value) ?? ASCTIME_DATE.exec(value))?.groups;
  if (groups === undefined) {
    return undefined;
  }
  // Every group exists for the form that matched; Number(undefined) would be NaN and fail toEpochMs.
  const parts = {
    month: MONTHS.findIndex((name) => name === groups["month"]),
    day: Number(groups["day"]),
    hour: Number(groups["hour"]),
    minute: Number(groups["minute"]),
    second: Number(groups["second"]),
  };
  const twoDigitYear = groups["yy"];
  return twoDigitYear === undefined
    ? toEpochMs({ ...parts, year: Number(groups["year"]) })
    : rfc850EpochMs(Number(twoDigitYear), parts, nowMs);
}

/**
 * RFC 9110: a two-digit year is read as the latest matching year, except that a timestamp
 * more than 50 years in the future means the most recent past year with those digits.
 */
function rfc850EpochMs(twoDigits: number, parts: Omit<DateTimeParts, "year">, nowMs: number): number | undefined {
  const limitYear = new Date(nowMs).getUTCFullYear() + RFC850_MAX_YEARS_AHEAD;
  const limitMs = new Date(nowMs).setUTCFullYear(limitYear);
  const latestYear = limitYear - ((limitYear - twoDigits) % YEARS_PER_CENTURY);
  const latestMs = toEpochMs({ ...parts, year: latestYear });
  return latestMs !== undefined && latestMs > limitMs
    ? toEpochMs({ ...parts, year: latestYear - YEARS_PER_CENTURY })
    : latestMs;
}

/** UTC epoch ms, or undefined for an impossible date (31 Sep, 24:00). Second 60 (leap second) is allowed. */
function toEpochMs(parts: DateTimeParts): number | undefined {
  const { year, month, day, hour, minute, second } = parts;
  const midnight = new Date(Date.UTC(year, month, day));
  const isRealDay = midnight.getUTCMonth() === month && midnight.getUTCDate() === day;
  const isRealTime = hour <= 23 && minute <= 59 && second <= 60;
  if (!isRealDay || !isRealTime) {
    return undefined;
  }
  return midnight.getTime() + ((hour * 60 + minute) * 60 + second) * MS_PER_SECOND;
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
    const excerpt = redactedExcerpt(request, attempt.text, INVALID_JSON_EXCERPT_CHARS);
    throw new Error(
      `${request.method} ${request.url} -> HTTP ${String(attempt.status)}: response is not valid JSON: ${excerpt}`,
    );
  }
}

function toFailure(request: HttpRequest, attempt: Attempt): HttpError | NetworkError {
  if (attempt.kind === "network-failure") {
    return new NetworkError(request.method, request.url, redactSecrets(request, attempt.reason));
  }
  const excerpt = redactedExcerpt(request, attempt.text, BODY_EXCERPT_CHARS);
  return new HttpError(request.method, request.url, attempt.status, excerpt);
}

/** Redacts before truncating, so a secret that straddles the cut cannot leak its first half. */
function redactedExcerpt(request: HttpRequest, text: string, maxChars: number): string {
  return truncate(redactSecrets(request, text), maxChars);
}

/** At most `maxChars` UTF-16 units, never ending in the first half of a cut surrogate pair. */
function truncate(text: string, maxChars: number): string {
  const cut = text.slice(0, maxChars);
  const lastUnit = cut.charCodeAt(cut.length - 1);
  const splitsPair = cut.length < text.length && lastUnit >= HIGH_SURROGATE_MIN && lastUnit <= HIGH_SURROGATE_MAX;
  return splitsPair ? cut.slice(0, -1) : cut;
}

// ---------------------------------------------------------------------------
// Redaction

/**
 * Removes the request's header values from text headed for an error. Node's
 * fetch, for one, quotes an invalid header value (a token) in its TypeError.
 */
function redactSecrets(request: HttpRequest, text: string): string {
  return secretsOf(request.headers).reduce((redacted, secret) => redacted.replaceAll(secret, REDACTED), text);
}

/** Each header value, trimmed, plus its parts ("Bearer <token>" -> "<token>"); longest first. */
function secretsOf(headers: Readonly<Record<string, string>>): readonly string[] {
  const candidates = Object.values(headers).flatMap((value) => [value, value.trim(), ...value.split(/\s+/)]);
  return [...new Set(candidates)]
    .filter((candidate) => candidate.length >= MIN_SECRET_CHARS)
    .toSorted((a, b) => b.length - a.length);
}
