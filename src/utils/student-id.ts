/**
 * Student IDs and lookup emails of one YouTrack user (decision U17, docs/13 §2.4): the 6-digit
 * BUas student number in a login or in a buas.nl address, and the addresses the commit and
 * email lookups may send. IDs stay strings, so a leading 0 survives. Pure, no I/O.
 */

export const BUAS_EMAIL_DOMAIN = "buas.nl";

/** A YouTrack user as the matcher sees it: the login, and the email when set and visible. */
export type PersonIdentity = { readonly login: string; readonly email: string | null };

/** A 6-digit run with no digit on either side; that student numbers have 6 digits fits all live data (docs/12). */
const STUDENT_ID = /(?<!\d)\d{6}(?!\d)/g;
/** One `@` and no space, quote or comma: it can neither turn `author=` into a username nor end the quoted search term. */
const USABLE_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/;
/** Anonymized YouTrack users have logins like this (an inferred shape, docs/12), compared A-Z lowercased. */
const ANONYMIZED_LOGIN_PREFIX = "anonymi";

/** The text's only 6-digit run (/(?<!\d)\d{6}(?!\d)/g), as a string; null for 0 or 2+ runs. */
export function singleStudentId(text: string): string | null {
  const [only, ...others] = text.match(STUDENT_ID) ?? [];
  return only !== undefined && others.length === 0 ? only : null;
}

/** True for /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/. */
export function isUsableEmail(text: string): boolean {
  return USABLE_EMAIL.test(text);
}

/**
 * IDs(Y) of 2.4: login ID (not for a login starting with "Anonymi", A-Z case ignored), then the
 * buas.nl email ID. The email ID needs exactly one `@`, the domain exactly `buas.nl` (A-Z case
 * ignored; `student.buas.nl` does not count) and one run in the local part, so a noreply or
 * other address never gives one. When the two IDs differ both are kept; the chain's
 * exactly-one rule decides.
 */
export function studentIds(person: PersonIdentity): readonly string[] {
  const ids = [loginId(person.login), person.email === null ? null : emailId(person.email)];
  return [...new Set(ids.filter((id) => id !== null))];
}

/**
 * Emails(Y) of 2.4: the usable email, then <id>@buas.nl per ID; A-Z lowercased, deduplicated.
 * A null email is "unknown": the built addresses still work when emails are hidden.
 */
export function lookupEmails(person: PersonIdentity): readonly string[] {
  const own = person.email !== null && isUsableEmail(person.email) ? [person.email] : [];
  const built = studentIds(person).map((id) => `${id}@${BUAS_EMAIL_DOMAIN}`);
  return [...new Set([...own, ...built].map(lowerAscii))];
}

function loginId(login: string): string | null {
  return lowerAscii(login).startsWith(ANONYMIZED_LOGIN_PREFIX) ? null : singleStudentId(login);
}

function emailId(email: string): string | null {
  const [local, domain, ...rest] = email.split("@");
  if (local === undefined || domain === undefined || rest.length > 0) return null;
  return lowerAscii(domain) === BUAS_EMAIL_DOMAIN ? singleStudentId(local) : null;
}

/** Lowercases A-Z only: toLowerCase() also maps e.g. the Kelvin sign U+212A to "k". */
function lowerAscii(text: string): string {
  return text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}
