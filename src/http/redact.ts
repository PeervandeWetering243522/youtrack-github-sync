/**
 * Keeps request credentials out of error text: every value of the request's headers
 * (and its parts, "Bearer <token>" -> "<token>") is replaced before the text is cut.
 */

/** Header values (and their parts) shorter than this are not treated as secrets. */
const MIN_SECRET_CHARS = 8;
const REDACTED = "[redacted]";
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;

type RequestHeaders = Readonly<Record<string, string>>;

/**
 * Removes the request's header values from text headed for an error. Node's
 * fetch, for one, quotes an invalid header value (a token) in its TypeError.
 */
export function redactHeaderValues(headers: RequestHeaders, text: string): string {
  return secretsOf(headers).reduce((redacted, secret) => redacted.replaceAll(secret, REDACTED), text);
}

/** Redacts before truncating, so a secret that straddles the cut cannot leak its first half. */
export function redactedExcerpt(headers: RequestHeaders, text: string, maxChars: number): string {
  return truncate(redactHeaderValues(headers, text), maxChars);
}

/** Each header value, trimmed, plus its parts ("Bearer <token>" -> "<token>"); longest first. */
function secretsOf(headers: RequestHeaders): readonly string[] {
  const candidates = Object.values(headers).flatMap((value) => [value, value.trim(), ...value.split(/\s+/)]);
  return [...new Set(candidates)]
    .filter((candidate) => candidate.length >= MIN_SECRET_CHARS)
    .toSorted((a, b) => b.length - a.length);
}

/** At most `maxChars` UTF-16 units, never ending in the first half of a cut surrogate pair. */
function truncate(text: string, maxChars: number): string {
  const cut = text.slice(0, maxChars);
  const lastUnit = cut.charCodeAt(cut.length - 1);
  const splitsPair = cut.length < text.length && lastUnit >= HIGH_SURROGATE_MIN && lastUnit <= HIGH_SURROGATE_MAX;
  return splitsPair ? cut.slice(0, -1) : cut;
}
