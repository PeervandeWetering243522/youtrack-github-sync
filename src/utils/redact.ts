/**
 * Secret redaction shared by every path that turns outside text into log or error text:
 * the http client (credential header values) and the run's logger (config tokens).
 * One threshold, one placeholder and one replacement order, so the paths cannot drift. Pure.
 */

import { cutUtf16 } from "./text.ts";

export type Redact = (text: string) => string;

/** Shorter "secrets" are not redacted, so a junk value cannot garble every line; real tokens are far longer. */
export const MIN_SECRET_CHARS = 8;
export const REDACTED = "[redacted]";

/** Replaces every occurrence of each secret, longest first (one may contain another). */
export function secretRedactor(secrets: readonly string[]): Redact {
  const redactable = [...new Set(secrets)]
    .filter((secret) => secret.length >= MIN_SECRET_CHARS)
    .toSorted((a, b) => b.length - a.length);
  return (text) => redactable.reduce((result, secret) => result.replaceAll(secret, REDACTED), text);
}

/**
 * At most `maxChars` UTF-16 units of the redacted text, never ending in half a surrogate pair.
 * Redacts before cutting, so a secret that straddles the cut cannot leak its first half.
 */
export function redactedExcerpt(redact: Redact, text: string, maxChars: number): string {
  return cutUtf16(redact(text), maxChars);
}
