/**
 * GitHub's rate-limit signals on a response (docs/03, decision R7), read from its status,
 * headers and body only. Pure.
 */

export const HTTP_FORBIDDEN = 403;
export const HTTP_TOO_MANY_REQUESTS = 429;
const SECONDARY_RATE_LIMIT = /secondary rate limit/i;

/** The parts of a received response the checks look at; `text` is the whole body. */
export type ReceivedResponse = {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
};

/** GitHub's primary rate limit: a 403 or 429 with x-ratelimit-remaining: 0. Only x-ratelimit-reset ends it. */
export function isPrimaryRateLimit(response: Omit<ReceivedResponse, "text">): boolean {
  return isRateLimitStatus(response.status) && response.headers.get("x-ratelimit-remaining")?.trim() === "0";
}

/**
 * Decision R7: a 403 or 429 that is the primary rate limit, carries retry-after (usable or not),
 * or whose body names GitHub's secondary rate limit. Further writes would be refused as well.
 */
export function isRateLimited(response: ReceivedResponse): boolean {
  if (!isRateLimitStatus(response.status)) {
    return false;
  }
  return (
    isPrimaryRateLimit(response) || response.headers.has("retry-after") || SECONDARY_RATE_LIMIT.test(response.text)
  );
}

function isRateLimitStatus(status: number): boolean {
  return status === HTTP_FORBIDDEN || status === HTTP_TOO_MANY_REQUESTS;
}
