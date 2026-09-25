/**
 * Neutralising, line by line: splits Markdown into lines, classifies each one
 * (markdown-blocks.ts) and wraps the references on text lines
 * (markdown-inline.ts). Pure, no I/O.
 *
 * Code spans may continue on the next line of a paragraph, so each text line is
 * rendered with the facts that the earlier lines of its paragraph left behind
 * (see RunFacts). A line depends only on the lines before it, which keeps a
 * rendered prefix identical to the prefix of the full rendering (markdown-cut.ts
 * relies on that).
 */

import { EMPTY_STATE, blockCloser, classifyLine } from "./markdown-blocks.ts";
import type { BlockState } from "./markdown-blocks.ts";
import { NO_FACTS, mergeFacts, renderTextLine } from "./markdown-inline.ts";
import type { RunFacts } from "./markdown-inline.ts";

export type RenderedLine = {
  readonly source: string;
  /** The line ending after the line, kept as written ("" for the last line). */
  readonly ending: string;
  /** Block state and paragraph facts before the line, to render a prefix of it (markdown-cut.ts). */
  readonly before: BlockState;
  readonly carried: RunFacts;
  readonly after: BlockState;
  readonly output: string;
};
/** A rendered line and the paragraph facts it hands to the next line. */
export type LineStep = { readonly line: RenderedLine; readonly carried: RunFacts };

/** CommonMark line endings; a lone "\r" ends a line too. */
const LINE_ENDING = /(\r\n|\r|\n)/;
export const BLANK_LINE = /^[ \t]*$/;

/** Splits into lines and renders every line. */
export function renderLines(markdown: string): readonly RenderedLine[] {
  const parts = markdown.split(LINE_ENDING);
  const lines: RenderedLine[] = [];
  let state = EMPTY_STATE;
  let carried = NO_FACTS;
  for (let index = 0; index < parts.length; index += 2) {
    const step = renderLine(parts[index] ?? "", parts[index + 1] ?? "", state, carried);
    lines.push(step.line);
    state = step.line.after;
    carried = step.carried;
  }
  return lines;
}

/** Outputs joined by their original line endings. */
export function joinLines(lines: readonly Pick<RenderedLine, "output" | "ending">[]): string {
  return lines.map((line, index) => (index === lines.length - 1 ? line.output : line.output + line.ending)).join("");
}

/** blockCloser() for the block state after the last of `lines` ("" when there are none). */
export function closerAfter(lines: readonly Pick<RenderedLine, "after">[]): string {
  return blockCloser(lines.at(-1)?.after ?? EMPTY_STATE);
}

/** Code and blank lines are copied; text lines get their references wrapped. */
export function renderLine(source: string, ending: string, before: BlockState, carried: RunFacts): LineStep {
  const { kind, joins, state: after } = classifyLine(before, source);
  const base = { source, ending, before, carried, after };
  if (kind !== "text") return { line: { ...base, output: source }, carried: NO_FACTS };
  const earlier = joins ? carried : NO_FACTS;
  const { output, facts } = renderTextLine(source, earlier);
  const next = after.leaf?.kind === "paragraph" ? mergeFacts(earlier, facts) : NO_FACTS;
  return { line: { ...base, output }, carried: next };
}
