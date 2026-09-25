/**
 * Cutting a neutralised rendering down to a character budget. The kept text is
 * always the rendering of a prefix of the source (cut first, then rendered), so a
 * cut can never split a code span and expose a reference inside it, and a code
 * fence or HTML block the cut leaves open is closed (blockCloser). Pure, no I/O.
 */

import { blockCloser } from "./markdown-blocks.ts";
import { BLANK_LINE, closerAfter, joinLines, renderLine } from "./markdown-render.ts";
import type { RenderedLine } from "./markdown-render.ts";
import { cutUtf16 } from "./text.ts";

/** Renders tried when fitting the prefix of one line into the space left (cutLine). */
const MAX_CUT_ATTEMPTS = 12;

type KeptLine = Pick<RenderedLine, "output" | "ending" | "after">;
type Probe = { readonly length: number; readonly size: number };

/**
 * At most `budget` characters: the rendering of a line-wise prefix of `lines`
 * (the last line maybe cut short), without trailing blank lines, plus the
 * blockCloser() for the block it leaves open. If the closer does not fit, the cut
 * is redone with room for it.
 */
export function fitRendered(lines: readonly RenderedLine[], budget: number): string {
  const first = cutLines(lines, budget);
  const closer = closerAfter(first);
  const fits = joinLines(first).length + closer.length <= budget;
  return closeWithin(fits ? first : cutLines(lines, budget - closer.length), budget);
}

/**
 * The longest line-wise prefix of `kept` that ends in a non-blank line and fits in `budget`
 * with its closer: all of it, unless the recut landed in a block with a longer closer.
 */
function closeWithin(kept: readonly KeptLine[], budget: number): string {
  let best = { count: 0, closer: "" };
  let length = 0;
  let ending = "";
  for (const [index, line] of kept.entries()) {
    length += ending.length + line.output.length;
    ending = line.ending;
    const closer = blockCloser(line.after);
    if (!BLANK_LINE.test(line.output) && length + closer.length <= budget) best = { count: index + 1, closer };
  }
  return joinLines(kept.slice(0, best.count)) + best.closer;
}

/** Longest line-wise prefix of the rendered lines that fits in `budget`, minus trailing blank lines. */
function cutLines(lines: readonly RenderedLine[], budget: number): readonly KeptLine[] {
  const kept: KeptLine[] = [];
  let used = 0;
  for (const line of lines) {
    const room = budget - used - (kept.at(-1)?.ending.length ?? 0);
    if (line.output.length > room) {
      const partial = cutLine(line, room);
      if (partial !== null) kept.push(partial);
      break;
    }
    used += (kept.at(-1)?.ending.length ?? 0) + line.output.length;
    kept.push(line);
  }
  while (kept.length > 0 && BLANK_LINE.test(kept.at(-1)?.output ?? "")) kept.pop();
  return kept;
}

/**
 * The longest rendering of a prefix of `line` that fits in `room`, rendered in
 * the line's own context, exactly as the full rendering renders that prefix at
 * the end of a description (a cut can even turn "```a``` @b" into a fence).
 * Wrapping makes the rendered size a rough, not quite monotonic function of the
 * prefix length, so a few interpolated guesses are tried; null if none fits.
 */
function cutLine(line: RenderedLine, room: number): KeptLine | null {
  let best: KeptLine | null = null;
  let low: Probe = { length: 0, size: 0 };
  let high: Probe | null = null;
  let length = Math.min(room, line.source.length);
  for (let attempt = 0; attempt < MAX_CUT_ATTEMPTS; attempt += 1) {
    if (length <= low.length || length >= (high?.length ?? Infinity)) break;
    const candidate = renderLine(cutUtf16(line.source, length), "", line.before, line.carried).line;
    const size = candidate.output.length;
    if (size > room) {
      high = { length, size };
    } else {
      if (best === null || size > best.output.length) best = candidate;
      if (size === room) break;
      low = { length, size };
    }
    length = Math.min(nextGuess(low, high, room), line.source.length);
  }
  return best;
}

/** Interpolates between the longest fitting and the shortest overflowing prefix tried so far. */
function nextGuess(low: Probe, high: Probe | null, room: number): number {
  if (high === null) return low.length + Math.max(1, room - low.size);
  const guess = low.length + Math.floor(((high.length - low.length) * (room - low.size)) / (high.size - low.size));
  return Math.min(high.length - 1, Math.max(low.length + 1, guess));
}
