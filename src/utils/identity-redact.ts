/**
 * The identity redactor of decision U8 (docs/13 §2.11): replaces every login and email the run
 * saw with a placeholder, so no log line, failure reason or error message names a person. The
 * sync stage builds it once per run and composes it with the secret redactor (redact.ts). Pure.
 */

import type { Redact } from "./redact.ts";

export const PERSON_REDACTED = "[person]";
/** Shorter identities are not redacted, so a 1- or 2-letter login cannot garble every line. */
export const MIN_IDENTITY_CHARS = 3;

/** Characters with a meaning in a regular expression, escaped to match literally. */
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;
/** A match must not touch one of these on either side, so `jdoe` stays inside `jdoe1234567`. */
const WORD_BEFORE = "(?<![A-Za-z0-9])";
const WORD_AFTER = "(?![A-Za-z0-9])";

/**
 * 2.11: case-insensitive, raw + encodeURIComponent + encodeURIComponent(`"${id}"`) variants,
 * longest first, no letter or digit on either side. The encoded forms are how the lookup URLs
 * spell an email (`%40`, and `%22...%22` around the search term); longest first makes a longer
 * identity win over one it contains. No identities: the text is returned unchanged.
 */
export function identityRedactor(identities: readonly string[]): Redact {
  const forms = [
    ...new Set(identities.filter((id) => id.length >= MIN_IDENTITY_CHARS).flatMap((id) => [id, ...encodedForms(id)])),
  ].toSorted((a, b) => b.length - a.length);
  if (forms.length === 0) return (text) => text;
  const alternatives = forms.map((form) => form.replace(REGEX_SPECIAL, "\\$&")).join("|");
  const pattern = new RegExp(`${WORD_BEFORE}(?:${alternatives})${WORD_AFTER}`, "gi");
  return (text) => text.replace(pattern, PERSON_REDACTED);
}

/** The URL-encoded and the quoted URL-encoded form of an identity. */
function encodedForms(identity: string): readonly string[] {
  try {
    return [encodeURIComponent(identity), encodeURIComponent(`"${identity}"`)];
  } catch (error) {
    // encodeURIComponent throws on a lone surrogate. Lookup URLs only carry ASCII emails
    // (isUsableEmail), so such an identity can only appear raw.
    if (error instanceof URIError) return [];
    throw error;
  }
}
