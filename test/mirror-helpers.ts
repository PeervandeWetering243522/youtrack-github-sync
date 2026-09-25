/**
 * Shared fixtures for the test/mirror*.test.ts files: body layout constants, an
 * issue factory, an independent live-reference checker and a reproducible fuzzer.
 * Not a test file itself (the runner only picks up *.test.ts).
 */

import { MAX_BODY_LENGTH } from "../src/mirror.ts";
import type { YouTrackIssue } from "../src/youtrack.ts";

export const BASE_URL = "https://yt.example";
export const ISSUE_URL = "https://yt.example/issue/CUI-7";
export const SEPARATOR = "\n\n---\n";
export const FOOTER = `Mirrored from YouTrack: ${ISSUE_URL}`;
export const TITLE_HEAD = `Title character limit hit, see the full YouTrack issue: ${ISSUE_URL}\n\n`;
export function limitTail(url: string): string {
  return `${SEPARATOR}Mirrored from YouTrack: ${url}${SEPARATOR}Character limit hit, see the full YouTrack issue: ${url}`;
}
export const LIMIT_TAIL = limitTail(ISSUE_URL);
/** Description characters that fit in front of LIMIT_TAIL when the title is not cut. */
export const BUDGET = MAX_BODY_LENGTH - LIMIT_TAIL.length;
/** Description characters that fit in front of SEPARATOR + FOOTER when nothing is cut. */
export const ROOM = MAX_BODY_LENGTH - SEPARATOR.length - FOOTER.length;
export const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function makeIssue(overrides: Partial<YouTrackIssue> = {}): YouTrackIssue {
  return {
    idReadable: "CUI-7",
    numberInProject: 7,
    summary: "[team] Fix it",
    description: null,
    resolved: null,
    updated: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Independent checker: references GitHub would still link, per the A4 rules,
// in the text outside CommonMark code spans (spans may cross line breaks).

const PUNCTUATION = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const LIVE_REFERENCE = [
  /(?<![A-Za-z0-9_/@.-])@[A-Za-z0-9]/,
  /(?<![A-Za-z0-9_/@.-])#\d+(?![A-Za-z0-9_])/,
  /(?<![A-Za-z0-9_/@.-])[Gg][Hh]-\d+(?![A-Za-z0-9_])/,
  /(?<![A-Za-z0-9_/@.-])[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+#\d+(?![A-Za-z0-9_])/,
];

function closerEnd(text: string, from: number, length: number): number {
  let index = from;
  while (index < text.length) {
    if (text.charAt(index) !== "`") {
      index += 1;
      continue;
    }
    let end = index;
    while (text.charAt(end) === "`") end += 1;
    if (end - index === length) return end;
    index = end;
  }
  return -1;
}

/** A numeric character reference, or a named one for a character the references use. */
const CHARACTER_REFERENCE = /&(?:#(\d{1,7})|#[Xx]([\dA-Fa-f]{1,6})|(commat|num|sol|period|lowbar|UnderBar));/y;
const NAMED: Readonly<Record<string, string>> = { commat: "@", num: "#", sol: "/", period: ".", lowbar: "_", UnderBar: "_" };

function characterReferenceAt(text: string, index: number): { readonly char: string; readonly length: number } | null {
  CHARACTER_REFERENCE.lastIndex = index;
  const match = CHARACTER_REFERENCE.exec(text);
  if (match === null) return null;
  const [whole, decimal, hex, name] = match;
  const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hex ?? "", 16);
  const numeric = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "\u{FFFD}";
  return { char: name !== undefined ? (NAMED[name] ?? "") : numeric, length: whole.length };
}

function textOutsideCodeSpans(paragraph: string): readonly string[] {
  const pieces: string[] = [];
  let current = "";
  let index = 0;
  while (index < paragraph.length) {
    const char = paragraph.charAt(index);
    const next = paragraph.charAt(index + 1);
    const reference = char === "&" ? characterReferenceAt(paragraph, index) : null;
    if (char === "\\" && next !== "" && PUNCTUATION.includes(next)) {
      current += next;
      index += 2;
    } else if (reference !== null) {
      current += reference.char;
      index += reference.length;
    } else if (char !== "`") {
      current += char;
      index += 1;
    } else {
      let runEnd = index;
      while (paragraph.charAt(runEnd) === "`") runEnd += 1;
      const close = closerEnd(paragraph, runEnd, runEnd - index);
      if (close === -1) current += paragraph.slice(index, runEnd);
      else pieces.push(current);
      if (close !== -1) current = "";
      index = close === -1 ? runEnd : close;
    }
  }
  return [...pieces, current];
}

function indentOf(line: string): number {
  return /^ */.exec(line)?.[0].length ?? 0;
}

function paragraphs(markdown: string): readonly string[] {
  const result: string[] = [];
  let current: string[] = [];
  let fence: { readonly char: string; readonly length: number; readonly indent: number } | null = null;
  for (const line of markdown.split("\n")) {
    const trimmed = line.replace(/^[ \t]+/, "");
    const run = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];
    const rest = run === undefined ? "" : trimmed.slice(run.length);
    if (fence !== null) {
      const closes =
        run?.startsWith(fence.char) === true &&
        run.length >= fence.length &&
        rest.trim() === "" &&
        indentOf(line) <= fence.indent + 3;
      if (closes) fence = null;
    } else if (run !== undefined && !(run.startsWith("`") && rest.includes("`"))) {
      fence = { char: run.charAt(0), length: run.length, indent: indentOf(line) };
      result.push(current.join("\n"));
      current = [];
    } else if (line.trim() === "") {
      result.push(current.join("\n"));
      current = [];
    } else {
      current.push(line);
    }
  }
  return [...result, current.join("\n")].filter((paragraph) => paragraph !== "");
}

export function liveReferences(markdown: string): readonly string[] {
  return paragraphs(markdown)
    .flatMap(textOutsideCodeSpans)
    .filter((piece) => LIVE_REFERENCE.some((pattern) => pattern.test(piece)));
}

// ---------------------------------------------------------------------------
// Fuzzing

/** Deterministic PRNG (mulberry32), so fuzz failures are reproducible. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FUZZ_ALPHABET = [
  "`", "``", "\\", "#", "1", "12", "@", "a", "b", " ", "/", ".", "-", "GH-", "gh-", "x/y#3",
  "@o/t", "\\#", "\\`", "é", "😀", "\n", "\n", "\n\n", "```", "~~~", "(", ")", "&#64;", "&", ";",
];

/**
 * The checker above knows top-level fences and blank lines only, so line starts
 * that could open a list item, block quote, indented code or an ATX heading are
 * dropped (block structure has its own tests in mirror-blocks.test.ts).
 */
export function fuzzInputs(seed: number, count: number): readonly string[] {
  const random = prng(seed);
  const pick = (): string => FUZZ_ALPHABET[Math.floor(random() * FUZZ_ALPHABET.length)] ?? "";
  return Array.from({ length: count }, () =>
    Array.from({ length: 1 + Math.floor(random() * 30) }, pick)
      .join("")
      .replace(/^(?:[ \d.-]|#+(?=[ \t]|$))+/gm, ""),
  );
}
