/**
 * Backslash escapes and character references (CommonMark 2.4, 2.5), as far as
 * reference neutralising needs them: whether a character is escaped, and how a
 * piece of source reads once rendered, with a map back to source offsets. Only
 * characters that can take part in a GitHub reference are decoded exactly.
 * Pure, no I/O.
 */

import { countBelow } from "./text.ts";

/**
 * A backslash escape of ASCII punctuation, or a character reference that can render as
 * a reference character: numeric ("&#64;", "&#x40;") or named for "@#/._" (CommonMark 2.4, 2.5).
 */
const ESCAPE_OR_ENTITY =
  /\\[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]|&(?:#\d{1,7}|#[Xx][\dA-Fa-f]{1,6}|commat|num|sol|period|lowbar|UnderBar);/g;
const NAMED_REFERENCES: ReadonlyMap<string, string> = new Map([
  ["commat", "@"], ["num", "#"], ["sol", "/"], ["period", "."], ["lowbar", "_"], ["UnderBar", "_"],
]);
/** Stands in for any decoded non-ASCII (or invalid, CommonMark: U+FFFD) character, keeping tokens one unit long. */
const INERT = String.fromCharCode(0xfffd);

/** Resolved tokens: their ascending plain offsets, and the characters dropped up to each one. */
export type Shifts = { readonly at: readonly number[]; readonly total: readonly number[] };

export type Resolved = { readonly plain: string; readonly shifts: Shifts };

/** `text` as rendered: each escape or reference of ESCAPE_OR_ENTITY resolved to one character. */
export function resolveEscapes(text: string): Resolved {
  const at: number[] = [];
  const total: number[] = [];
  let plain = "";
  let cursor = 0;
  for (const match of text.matchAll(ESCAPE_OR_ENTITY)) {
    plain += text.slice(cursor, match.index);
    at.push(plain.length);
    total.push((total.at(-1) ?? 0) + match[0].length - 1);
    plain += decodeToken(match[0]);
    cursor = match.index + match[0].length;
  }
  return { plain: plain + text.slice(cursor), shifts: { at, total } };
}

/** Where plain offset `offset` sits in the source (a token at `offset` itself is not skipped). */
export function sourceOffset(shifts: Shifts, offset: number): number {
  return offset + (shifts.total[countBelow(shifts.at, offset) - 1] ?? 0);
}

/** An odd run of backslashes right before `index` escapes the character there. */
export function isEscaped(text: string, index: number): boolean {
  let count = 0;
  while (text.charAt(index - 1 - count) === "\\") count += 1;
  return count % 2 === 1;
}

/** The rendered character; only ASCII can take part in a reference, so others become INERT. */
function decodeToken(token: string): string {
  if (token.startsWith("\\")) return token.slice(1);
  const name = token.slice(1, -1);
  const named = NAMED_REFERENCES.get(name);
  if (named !== undefined) return named;
  const hex = name.startsWith("#x") || name.startsWith("#X");
  const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
  return code > 0 && code < 0x80 ? String.fromCharCode(code) : INERT;
}
