/**
 * Keeps request credentials out of error text. Only credential headers count: Authorization
 * and other token-bearing names. Their values, and the parts of each value ("Bearer <token>" ->
 * "<token>"), go through the shared redactor in src/utils/redact.ts. Accept, X-GitHub-Api-Version
 * and the like stay readable, since they are often what an error message is about.
 */

import { secretRedactor, type Redact } from "../utils/redact.ts";

/** Authorization, Proxy-Authorization, X-Auth-Token, Private-Token, Cookie, X-Api-Key and the like. */
const CREDENTIAL_HEADER_NAME = /auth|token|secret|password|cookie|api-?key/i;

/** A redactor for text headed for an error about this request. Node's fetch, for one, quotes an invalid header value. */
export function requestRedactor(headers: Readonly<Record<string, string>>): Redact {
  return secretRedactor(credentialValuesOf(headers));
}

/** Each credential header value, trimmed, plus its whitespace-separated parts. */
function credentialValuesOf(headers: Readonly<Record<string, string>>): readonly string[] {
  return Object.entries(headers)
    .filter(([name]) => CREDENTIAL_HEADER_NAME.test(name))
    .flatMap(([, value]) => [value, value.trim(), ...value.split(/\s+/)]);
}
