/**
 * Neutralising, inline level: wraps GitHub references on one text line in code
 * spans (CommonMark 6.1 code spans, with backslash escapes and character
 * references). Pure, no I/O.
 *
 * Some ranges of a line are protected as code; references anywhere else are
 * wrapped in an inserted code span that cannot pair with any backtick around it:
 * - its delimiter length is one that no run it could meet has (below);
 * - a space separates it from any adjacent backtick, escaped or not, because a
 *   closer is a raw run ("\`" + "`" reads as "``");
 * - a literal backslash right before it is doubled, so it cannot escape it.
 * Normally the protected ranges are the line's own code spans. They are only
 * certain when no span is open at the start of the line, though: once an earlier
 * line of the paragraph left a run unmatched, spans may pair across the line break.
 * Then only an adjacent pair of equal runs whose length no other run in the paragraph
 * shares is code in every reading; everything else is wrapped.
 * A code span ends GitHub's text node, so matching restarts after each reference,
 * and directly adjacent references share one span. Rendering twice changes nothing.
 * Not modelled: raw HTML tags and autolinks outrank code spans, so a backtick
 * inside one ("<http://x/`>") does not open a span on GitHub.
 */

import { isEscaped, resolveEscapes, sourceOffset } from "./markdown-escapes.ts";
import { countBelow } from "./text.ts";

type Range = { readonly start: number; readonly end: number };
type Pair = Range & { readonly length: number };

/** Backtick-run lengths a text line leaves for the later lines of its paragraph. */
export type RunFacts = {
  /** Runs left unmatched on their line: they may open a span on a later line. */
  readonly literal: ReadonlySet<number>;
  /** Runs that are not half of an adjacent equal-length pair (see adjacentPairs). */
  readonly unpaired: ReadonlySet<number>;
};

export type RenderedText = { readonly output: string; readonly facts: RunFacts };

export const NO_FACTS: RunFacts = { literal: new Set(), unpaired: new Set() };

/** Cheap pre-check: every reference contains "@", "#", "GH-" (maybe "GH\-") or a character reference. */
const MAY_HOLD_REFERENCE = /[@#&]|[Gg][Hh]\\?-/;
const LOGIN = "[A-Za-z0-9][A-Za-z0-9-]{0,38}";
const ENDS_NUMBER = "(?![A-Za-z0-9])";
/** owner/repo#123 | #123 | GH-123 | @org/team | @login */
const REFERENCE_BODY = [
  `${LOGIN}/[A-Za-z0-9._-]+#\\d+${ENDS_NUMBER}`,
  `#\\d+${ENDS_NUMBER}`,
  `[Gg][Hh]-\\d+${ENDS_NUMBER}`,
  `@${LOGIN}/[A-Za-z0-9._-]*[A-Za-z0-9_-]`,
  `@${LOGIN}`,
].join("|");
/**
 * A reference may not follow [A-Za-z0-9/@.-] (words, emails, URLs, paths), and a
 * numeric one may not run on into [A-Za-z0-9]. `_` does not glue: it can close
 * emphasis ("_foo_#1" renders as <em>foo</em>#1, where #1 starts a new text node).
 * Both regexes are only used through findReferences, which sets lastIndex first.
 */
const REFERENCE = new RegExp(`(?<![A-Za-z0-9/@.-])(?:${REFERENCE_BODY})`, "g");
/** Right after a wrapped reference a new text node starts, so nothing before it counts. */
const REFERENCE_RIGHT_HERE = new RegExp(`(?:${REFERENCE_BODY})`, "y");

/** The facts of a paragraph so far, after one more of its lines. */
export function mergeFacts(a: RunFacts, b: RunFacts): RunFacts {
  return { literal: union(a.literal, b.literal), unpaired: union(a.unpaired, b.unpaired) };
}

/** One text line with its references wrapped, given the facts of the earlier lines of its paragraph. */
export function renderTextLine(line: string, earlier: RunFacts): RenderedText {
  const paranoid = earlier.literal.size > 0;
  if (!line.includes("`")) {
    // No runs of its own: nothing to protect, and only earlier runs constrain the delimiter.
    const taken = paranoid ? earlier.unpaired : NO_FACTS.unpaired;
    return { output: wrapOutside(line, [], shortestFreeLength(taken)), facts: NO_FACTS };
  }
  const runs = backtickRuns(line);
  const { spans, literal } = lineCodeSpans(line, runs);
  const { pairs, unpaired } = adjacentPairs(line, runs);
  const facts = { literal, unpaired };
  if (!paranoid) return { output: wrapOutside(line, spans, shortestFreeLength(literal)), facts };
  const paragraphUnpaired = union(earlier.unpaired, unpaired);
  const certain = pairs.filter((pair) => !paragraphUnpaired.has(pair.length));
  return { output: wrapOutside(line, certain, shortestFreeLength(paragraphUnpaired)), facts };
}

function union(a: ReadonlySet<number>, b: ReadonlySet<number>): ReadonlySet<number> {
  for (const value of b) if (!a.has(value)) return new Set([...a, ...b]);
  return a;
}

/** Every maximal backtick run, in order. */
function backtickRuns(line: string): readonly Range[] {
  const runs: Range[] = [];
  for (let start = line.indexOf("`"); start !== -1;) {
    let end = start;
    while (line.charAt(end) === "`") end += 1;
    runs.push({ start, end });
    start = line.indexOf("`", end);
  }
  return runs;
}

/**
 * The line's own code spans (as if nothing were open before it) and its
 * unmatched run lengths. Scanning left to right, a run inside a span is content;
 * otherwise it opens, minus a first backtick escaped by an odd backslash run
 * (backslashes before a run are never inside a span, which ends with a backtick).
 */
function lineCodeSpans(
  line: string,
  runs: readonly Range[],
): { readonly spans: readonly Range[]; readonly literal: ReadonlySet<number> } {
  const starts = startsByLength(runs);
  const spans: Range[] = [];
  const literal = new Set<number>();
  let resumeAt = 0;
  for (const run of runs) {
    const start = isEscaped(line, run.start) ? run.start + 1 : run.start;
    if (run.start < resumeAt || start === run.end) continue;
    const closeEnd = closingRunEnd(starts, run.end - start, run.end);
    if (closeEnd === -1) {
      literal.add(run.end - start);
    } else {
      spans.push({ start, end: closeEnd });
      resumeAt = closeEnd;
    }
  }
  return { spans, literal };
}

/**
 * Pairs each run with the next one when both have the same length and the first
 * is not escaped (left to right), and collects the lengths of all other runs.
 * A run after an odd backslash can open a span one shorter; that length always
 * counts, paired or not, so wrapping inside a pair cannot add a new length.
 */
function adjacentPairs(
  line: string,
  runs: readonly Range[],
): { readonly pairs: readonly Pair[]; readonly unpaired: ReadonlySet<number> } {
  const pairs: Pair[] = [];
  const unpaired = new Set(
    runs.filter((run) => runLength(run) > 1 && isEscaped(line, run.start)).map((run) => runLength(run) - 1),
  );
  let pending: Range | null = null;
  for (const run of runs) {
    if (pending !== null && runLength(pending) === runLength(run) && !isEscaped(line, pending.start)) {
      pairs.push({ start: pending.start, end: run.end, length: runLength(run) });
      pending = null;
    } else {
      if (pending !== null) unpaired.add(runLength(pending));
      pending = run;
    }
  }
  if (pending !== null) unpaired.add(runLength(pending));
  return { pairs, unpaired };
}

function runLength(run: Range): number {
  return run.end - run.start;
}

/** Run start offsets grouped by run length (ascending). */
function startsByLength(runs: readonly Range[]): ReadonlyMap<number, readonly number[]> {
  const starts = new Map<number, number[]>();
  for (const run of runs) {
    const group = starts.get(runLength(run));
    if (group === undefined) starts.set(runLength(run), [run.start]);
    else group.push(run.start);
  }
  return starts;
}

/** End of the first run of exactly `length` backticks at or after `from`, or -1 (closers are raw runs). */
function closingRunEnd(starts: ReadonlyMap<number, readonly number[]>, length: number, from: number): number {
  const group = starts.get(length) ?? [];
  const start = group[countBelow(group, from)];
  return start === undefined ? -1 : start + length;
}

function shortestFreeLength(taken: ReadonlySet<number>): number {
  let length = 1;
  while (taken.has(length)) length += 1;
  return length;
}

/** Copies protected ranges verbatim and wraps references in the gaps between them. */
function wrapOutside(line: string, protectedRanges: readonly Range[], delimiterLength: number): string {
  const delimiter = "`".repeat(delimiterLength);
  let output = "";
  let cursor = 0;
  for (const range of protectedRanges) {
    output += wrapGap(line, cursor, range.start, delimiter) + line.slice(range.start, range.end);
    cursor = range.end;
  }
  return output + wrapGap(line, cursor, line.length, delimiter);
}

/**
 * Matching runs on the gap as rendered (escapes and character references resolved),
 * and each reference is written into its span in that rendered form, so `\#12`
 * and `&#35;12` become `#12` in code.
 */
function wrapGap(line: string, from: number, to: number, delimiter: string): string {
  const gap = line.slice(from, to);
  if (!MAY_HOLD_REFERENCE.test(gap)) return gap;
  const { plain, shifts } = resolveEscapes(gap);
  let output = "";
  let cursor = from;
  for (const span of findReferences(plain)) {
    const start = from + sourceOffset(shifts, span.start);
    const end = from + sourceOffset(shifts, span.end);
    const closing = line.charAt(end) === "`" ? " " : "";
    output += `${line.slice(cursor, start)}${openingGlue(line, start)}${delimiter}${plain.slice(span.start, span.end)}${delimiter}${closing}`;
    cursor = end;
  }
  return output + line.slice(cursor, to);
}

/** A space after a backtick; a second backslash after a literal one (which would escape the delimiter). */
function openingGlue(line: string, start: number): string {
  if (line.charAt(start - 1) === "`") return " ";
  return isEscaped(line, start) ? "\\" : "";
}

/** References in `text`; each one ends a text node, so directly adjacent ones merge into one span. */
function findReferences(text: string): readonly Range[] {
  const spans: Range[] = [];
  REFERENCE.lastIndex = 0;
  for (let match = REFERENCE.exec(text); match !== null; match = REFERENCE.exec(text)) {
    let end = match.index + match[0].length;
    REFERENCE_RIGHT_HERE.lastIndex = end;
    while (REFERENCE_RIGHT_HERE.test(text)) end = REFERENCE_RIGHT_HERE.lastIndex;
    spans.push({ start: match.index, end });
    REFERENCE.lastIndex = end;
  }
  return spans;
}
