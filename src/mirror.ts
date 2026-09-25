/**
 * Pure formatting and matching rules for mirror issues. No I/O.
 */

import type { YouTrackIssue } from "./youtrack.ts";

/** GitHub limits (community-documented, docs/03): enforced conservatively. */
export const MAX_TITLE_LENGTH = 256;
export const MAX_BODY_LENGTH = 65_536;
export const ELLIPSIS = "…";

export type FormattedMirror = {
  readonly title: string;
  readonly body: string;
  readonly titleTruncated: boolean;
  readonly bodyTruncated: boolean;
};

const MIRROR_TITLE = /^\[YT-(\d+)\]/;
const TITLE_NOTICE = "Title character limit hit, see the full YouTrack issue: ";
const LINK_LINE = "Mirrored from YouTrack: ";
const SEPARATOR = "\n\n---\n";
const LIMIT_NOTICE = `${SEPARATOR}Character limit hit, see the full YouTrack issue: `;
/** Renders tried when fitting the prefix of one line into the space left (cutLine). */
const MAX_CUT_ATTEMPTS = 12;

/** `${baseUrl}/issue/${idReadable}` (baseUrl has no trailing slash). */
export function youtrackIssueUrl(baseUrl: string, idReadable: string): string {
  return `${baseUrl}/issue/${idReadable}`;
}

/** `^\[YT-(\d+)\]` -> numberInProject, else null. Positive safe integers only. */
export function parseMirrorTitle(title: string): number | null {
  const digits = MIRROR_TITLE.exec(title)?.[1];
  if (digits === undefined) return null;
  // Leading zeros are tolerated ("[YT-007]" -> 7); 0 and unsafe integers are not.
  const value = Number(digits);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Summary starts with `prefix`, case-insensitive, ignoring leading whitespace. */
export function hasTitlePrefix(summary: string, prefix: string): boolean {
  return summary.trimStart().toLowerCase().startsWith(prefix.trim().toLowerCase());
}

/**
 * Wraps GitHub reference syntax in backticks so copied text does not notify
 * people or cross-link issues (decision A4):
 *   @login, @org/team, #123, GH-123, owner/repo#123
 * Leaves untouched: fenced code blocks (``` / ~~~), inline code spans,
 * email addresses (a@b.com), and matches glued to a preceding word char or
 * `/` (e.g. inside URLs like https://x.org/page#12).
 */
export function neutraliseReferences(markdown: string): string {
  return joinLines(renderLines(markdown));
}

/**
 * Title: `[YT-<n>] <summary>`, at most MAX_TITLE_LENGTH UTF-16 units, never
 * splitting a surrogate pair; when cut, ends with ELLIPSIS.
 *
 * Body (decisions A4, A9):
 *   [if title cut]  "Title character limit hit, see the full YouTrack issue: <url>\n\n"
 *   [if description non-null and non-blank]  neutraliseReferences(description) + "\n\n---\n"
 *   "Mirrored from YouTrack: <url>"
 * A null/blank description yields only the link line (plus the title notice if any).
 * If the body would exceed MAX_BODY_LENGTH, the description part is cut (no surrogate
 * split) and the body ends with
 *   "\n\n---\nCharacter limit hit, see the full YouTrack issue: <url>"
 * so the final body is always <= MAX_BODY_LENGTH.
 */
export function formatMirror(issue: YouTrackIssue, youtrackBaseUrl: string): FormattedMirror {
  const url = youtrackIssueUrl(youtrackBaseUrl, issue.idReadable);
  const title = formatTitle(issue.numberInProject, issue.summary);
  const head = title.truncated ? `${TITLE_NOTICE}${url}\n\n` : "";
  const body = formatBody(head, issue.description, url);
  return {
    title: title.text,
    body: body.text,
    titleTruncated: title.truncated,
    bodyTruncated: body.truncated,
  };
}

// ---------------------------------------------------------------------------
// Title and body

type Fitted = { readonly text: string; readonly truncated: boolean };

function formatTitle(numberInProject: number, summary: string): Fitted {
  const prefix = `[YT-${String(numberInProject)}]`;
  const trimmed = summary.trim();
  const full = trimmed === "" ? prefix : `${prefix} ${trimmed}`;
  if (full.length <= MAX_TITLE_LENGTH) return { text: full, truncated: false };
  return { text: cutUtf16(full, MAX_TITLE_LENGTH - ELLIPSIS.length) + ELLIPSIS, truncated: true };
}

function formatBody(head: string, description: string | null, url: string): Fitted {
  const footer = `${LINK_LINE}${url}`;
  if (description === null || description.trim() === "") {
    const text = head + footer;
    // Can only overflow with an absurdly long URL; the hard limit still holds.
    return { text: cutUtf16(text, MAX_BODY_LENGTH), truncated: text.length > MAX_BODY_LENGTH };
  }
  const room = MAX_BODY_LENGTH - head.length - SEPARATOR.length - footer.length;
  // Rendering only shrinks where a wrapped reference resolves an escape or character reference,
  // so a description too long even with all of them resolved is not rendered in full (CPU time).
  const { plain, shifts } = resolveEscapes(description);
  if (plain.length <= room) {
    const rendered = neutraliseReferences(description);
    if (rendered.length <= room) return { text: `${head}${rendered}${SEPARATOR}${footer}`, truncated: false };
  }
  return { text: truncatedBody(head, description, shifts, url), truncated: true };
}

/**
 * For the same reason, no source past the offset where the resolved description reaches
 * `budget` characters can fit, so that is all that is rendered (CPU time).
 */
function truncatedBody(head: string, description: string, shifts: Shifts, url: string): string {
  const tail = `${SEPARATOR}${LINK_LINE}${url}${LIMIT_NOTICE}${url}`;
  const budget = MAX_BODY_LENGTH - head.length - tail.length;
  const source = cutUtf16(description, sourceOffset(shifts, budget));
  const kept = budget > 0 ? fitDescription(renderLines(source), budget) : "";
  // The outer cut only bites for absurdly long URLs (budget <= 0).
  return cutUtf16(`${head}${kept}${tail}`, MAX_BODY_LENGTH);
}

/**
 * The kept description is neutraliseReferences() of a prefix of the description
 * (cut first, then rendered, so a cut can never split a code span and expose a
 * reference inside it), without trailing blank lines, plus blockCloser().
 * If the closer does not fit, the cut is redone with room for it.
 */
function fitDescription(lines: readonly RenderedLine[], budget: number): string {
  const first = cutLines(lines, budget);
  const closer = blockCloser(first.at(-1)?.after ?? EMPTY_STATE);
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

/**
 * A line closing the code fence or HTML block (kinds 1-5) that a cut leaves open
 * at the top level; otherwise the notice after it would render as code or vanish
 * into an HTML comment. Inside a list item or block quote, the separator's
 * unindented "---" line closes them.
 */
function blockCloser(state: BlockState): string {
  const { leaf } = state;
  if (leaf === null || state.containers.length > 0) return "";
  if (leaf.kind === "fence") return `\n${leaf.char.repeat(leaf.length)}`;
  return leaf.kind === "html" && leaf.closer !== "" ? `\n${leaf.closer}` : "";
}

type KeptLine = Pick<RenderedLine, "output" | "ending" | "after">;

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

type Probe = { readonly length: number; readonly size: number };

/**
 * The longest rendering of a prefix of `line` that fits in `room`, rendered in
 * the line's own context, exactly as neutraliseReferences() renders that prefix
 * at the end of a description (a cut can even turn "```a``` @b" into a fence).
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

/** First `maxLength` UTF-16 units of `text`, without leaving a lone high surrogate. */
function cutUtf16(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const end = Math.max(0, maxLength);
  const last = text.charCodeAt(end - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, end - 1) : text.slice(0, end);
}

// ---------------------------------------------------------------------------
// Neutralising, line by line. Code spans may continue on the next line of a
// paragraph, so each text line is rendered with the facts that the earlier lines
// of its paragraph left behind (see RunFacts). A line depends only on the lines
// before it, which keeps a rendered prefix identical to the prefix of the full
// rendering (see cutLine).

type RenderedLine = {
  readonly source: string;
  /** The line ending after the line, kept as written ("" for the last line). */
  readonly ending: string;
  /** Block state and paragraph facts before the line, to render a prefix of it (cutLine). */
  readonly before: BlockState;
  readonly carried: RunFacts;
  readonly after: BlockState;
  readonly output: string;
};
type LineStep = { readonly line: RenderedLine; readonly carried: RunFacts };

/** CommonMark line endings; a lone "\r" ends a line too. */
const LINE_ENDING = /(\r\n|\r|\n)/;
const BLANK_LINE = /^[ \t]*$/;

/** Splits into lines and renders every line. */
function renderLines(markdown: string): readonly RenderedLine[] {
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
function joinLines(lines: readonly Pick<RenderedLine, "output" | "ending">[]): string {
  return lines.map((line, index) => (index === lines.length - 1 ? line.output : line.output + line.ending)).join("");
}

/** Code and blank lines are copied; text lines get their references wrapped. */
function renderLine(source: string, ending: string, before: BlockState, carried: RunFacts): LineStep {
  const { kind, joins, state: after } = classifyLine(before, source);
  const base = { source, ending, before, carried, after };
  if (kind !== "text") return { line: { ...base, output: source }, carried: NO_FACTS };
  const earlier = joins ? carried : NO_FACTS;
  const { output, facts } = renderTextLine(source, earlier);
  const next = after.leaf?.kind === "paragraph" ? mergeFacts(earlier, facts) : NO_FACTS;
  return { line: { ...base, output }, carried: next };
}

// ---------------------------------------------------------------------------
// Neutralising, block level: which lines are code, which are inline text, and
// which text line continues a paragraph. A line-by-line port of the CommonMark
// 0.31 block algorithm (as in its reference parser, commonmark.js) for block
// quotes, list items, fenced and indented code, HTML blocks, headings, thematic
// breaks and paragraphs with lazy continuation lines. Containers matter for
// fences: "- ```" opens one inside a list item, an unindented line closes a
// fence inside a list item, and "    ```" after a paragraph is plain text.
// HTML block lines are copied like code: Markdown is not parsed there, so
// backticks would not protect anything, and wrapping could break the block's end
// marker ("@b-->" -> "`@b--`>"). GFM tables are not parsed.

type FenceLeaf = { readonly kind: "fence"; readonly char: string; readonly length: number };
/** `end` null: ends at a blank line (kinds 6, 7). `closer`: a line ending it, for blockCloser. */
type HtmlLeaf = { readonly kind: "html"; readonly end: RegExp | null; readonly closer: string };
type Leaf = { readonly kind: "paragraph" | "indented" } | FenceLeaf | HtmlLeaf;
type Container =
  | { readonly kind: "quote" }
  | { readonly kind: "item"; readonly padding: number; readonly hasContent: boolean };
type BlockState = { readonly containers: readonly Container[]; readonly leaf: Leaf | null };
/** While a line is classified: containers[0, matched) continue on it, `pos` is past them. */
type Cursor = BlockState & { readonly matched: number; readonly pos: number };
type ClassifiedLine = {
  readonly kind: "code" | "text" | "blank";
  /** A text line that continues the paragraph of the line before it. */
  readonly joins: boolean;
  readonly state: BlockState;
};

const EMPTY_STATE: BlockState = { containers: [], leaf: null };
const PARAGRAPH: Leaf = { kind: "paragraph" };
const INDENTED: Leaf = { kind: "indented" };
const QUOTE: Container = { kind: "quote" };
const CODE_INDENT = 4;
const TAB_STOP = 4;
/** More spaces than this after a list marker make the item's content indented code. */
const MAX_MARKER_SPACES = 4;
const ATX_HEADING = /^#{1,6}(?:[ \t]|$)/;
/** A backtick fence's info string cannot contain a backtick ("```a``` @b" is inline code). */
const FENCE_OPEN = /^(?:`{3,}(?!.*`)|~{3,})/;
const FENCE_CLOSE = /^(?:`{3,}|~{3,})(?=[ \t]*$)/;
const SETEXT_UNDERLINE = /^(?:=+|-+)[ \t]*$/;
const THEMATIC_BREAK = /^(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/;
const LIST_MARKER = /^(?:[*+-]|(\d{1,9})[.)])/;
const BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|" +
  "fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|" +
  "menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const TAG_NAME = "[A-Za-z][A-Za-z0-9-]*";
const ATTRIBUTE = `\\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\\s*=\\s*(?:[^"'=<>\`\\s]+|'[^']*'|"[^"]*"))?`;
/** HTML block start conditions 1-6 (CommonMark 4.6); any of the kind-1 end tags ends kind 1. */
const HTML_BLOCKS: readonly (readonly [start: RegExp, leaf: HtmlLeaf])[] = [
  [/^<(?:script|pre|textarea|style)(?:\s|>|$)/i, htmlLeaf(/<\/(?:script|pre|textarea|style)>/i, "</pre>")],
  [/^<!--/, htmlLeaf(/-->/, "-->")],
  [/^<\?/, htmlLeaf(/\?>/, "?>")],
  [/^<![A-Za-z]/, htmlLeaf(/>/, ">")],
  [/^<!\[CDATA\[/, htmlLeaf(/\]\]>/, "]]>")],
  [new RegExp(`^</?(?:${BLOCK_TAGS})(?:\\s|/?>|$)`, "i"), htmlLeaf(null, "")],
];
/** Condition 7, a line holding one complete tag. It cannot interrupt a paragraph. */
const HTML_BLOCK_7 = new RegExp(`^(?:<${TAG_NAME}(?:${ATTRIBUTE})*\\s*/?>|</${TAG_NAME}\\s*>)\\s*$`);

function htmlLeaf(end: RegExp | null, closer: string): HtmlLeaf {
  return { kind: "html", end, closer };
}

/** Classifies one line, given the block state after the lines before it. */
function classifyLine(state: BlockState, line: string): ClassifiedLine {
  const text = expandTabs(line);
  let pos = 0;
  let matched = 0;
  for (const container of state.containers) {
    const next = continueContainer(container, text, pos);
    if (next === null) break;
    pos = next;
    matched += 1;
  }
  const cursor: Cursor = { ...state, matched, pos };
  if (matched === state.containers.length && state.leaf !== null) {
    const continued = continueLeaf(cursor, state.leaf, text);
    if (continued !== null) return continued;
  }
  return openBlocks(cursor, text);
}

/** Where the line continues inside `container`, or null if it does not. */
function continueContainer(container: Container, text: string, pos: number): number | null {
  const indent = indentAt(text, pos);
  const first = pos + indent;
  if (container.kind === "quote") {
    if (indent >= CODE_INDENT || text.charAt(first) !== ">") return null;
    return text.charAt(first + 1) === " " ? first + 2 : first + 1;
  }
  // A list item that is still empty cannot continue past a blank line.
  if (first === text.length) return container.hasContent ? first : null;
  return indent >= container.padding ? pos + container.padding : null;
}

/** A line that stays in an open fence, indented code or HTML block; null otherwise. */
function continueLeaf(cursor: Cursor, leaf: Leaf, text: string): ClassifiedLine | null {
  const indent = indentAt(text, cursor.pos);
  const blank = cursor.pos + indent === text.length;
  const open: BlockState = { containers: cursor.containers, leaf };
  const closed: BlockState = { containers: cursor.containers, leaf: null };
  switch (leaf.kind) {
    case "fence": {
      const closes = indent < CODE_INDENT && closesFence(text.slice(cursor.pos + indent), leaf);
      return { kind: "code", joins: false, state: closes ? closed : open };
    }
    case "indented":
      return blank || indent >= CODE_INDENT ? { kind: "code", joins: false, state: open } : null;
    case "html":
      if (blank) return { kind: "blank", joins: false, state: leaf.end === null ? closed : open };
      return { kind: "code", joins: false, state: leaf.end?.test(text.slice(cursor.pos)) === true ? closed : open };
    case "paragraph":
      return null;
  }
}

/** Same character, at least as long, nothing but whitespace after it (CommonMark 4.5). */
function closesFence(rest: string, fence: FenceLeaf): boolean {
  const run = FENCE_CLOSE.exec(rest)?.[0];
  return run?.startsWith(fence.char) === true && run.length >= fence.length;
}

/** Opens new containers, then at most one leaf block (CommonMark block starts, in order). */
function openBlocks(start: Cursor, text: string): ClassifiedLine {
  let cursor = start;
  for (;;) {
    const indent = indentAt(text, cursor.pos);
    const at = cursor.pos + indent;
    if (indent >= CODE_INDENT) return finishLine(cursor, text, indent);
    if (text.charAt(at) === ">") {
      cursor = pushContainer(cursor, QUOTE, text.charAt(at + 1) === " " ? at + 2 : at + 1);
      continue;
    }
    const rest = text.slice(at);
    const leafLine = openLeaf(cursor, rest);
    if (leafLine !== null) return leafLine;
    const item = openListItem(cursor, rest, indent);
    if (item === null) return finishLine(cursor, text, indent);
    cursor = item;
  }
}

/** An ATX heading, fence, HTML block, setext underline or thematic break at `rest`. */
function openLeaf(cursor: Cursor, rest: string): ClassifiedLine | null {
  const tipIsParagraph = cursor.leaf?.kind === "paragraph";
  if (ATX_HEADING.test(rest)) return contentLine("text", cursor, null);
  const fence = FENCE_OPEN.exec(rest)?.[0];
  if (fence !== undefined) return contentLine("code", cursor, { kind: "fence", char: fence.charAt(0), length: fence.length });
  const html = rest.startsWith("<") ? openHtmlBlock(rest, tipIsParagraph) : null;
  if (html !== null) return contentLine("code", cursor, html.end?.test(rest) === true ? null : html);
  const setext = tipIsParagraph && cursor.matched === cursor.containers.length && SETEXT_UNDERLINE.test(rest);
  return setext || THEMATIC_BREAK.test(rest) ? contentLine("text", cursor, null) : null;
}

function openHtmlBlock(rest: string, tipIsParagraph: boolean): HtmlLeaf | null {
  for (const [start, leaf] of HTML_BLOCKS) if (start.test(rest)) return leaf;
  return !tipIsParagraph && HTML_BLOCK_7.test(rest) ? htmlLeaf(null, "") : null;
}

/** A list item marker at `rest`, `indent` columns past the cursor (CommonMark 5.2). */
function openListItem(cursor: Cursor, rest: string, indent: number): Cursor | null {
  const match = LIST_MARKER.exec(rest);
  if (match === null) return null;
  const [marker, ordinal] = match;
  const width = marker.length;
  if (width < rest.length && rest.charAt(width) !== " ") return null;
  const spaces = indentAt(rest, width);
  const isEmpty = width + spaces === rest.length;
  // Only a non-empty item, ordered ones starting at 1, can interrupt a paragraph.
  const interrupts = cursor.leaf?.kind === "paragraph" && cursor.matched === cursor.containers.length;
  if (interrupts && (isEmpty || (ordinal !== undefined && Number(ordinal) !== 1))) return null;
  const narrow = isEmpty || spaces > MAX_MARKER_SPACES;
  const padding = indent + width + (narrow ? 1 : spaces);
  const markerEnd = cursor.pos + indent + width;
  return pushContainer(cursor, { kind: "item", padding, hasContent: false }, markerEnd + (narrow ? Math.min(spaces, 1) : spaces));
}

/** No block starts here: indented code, a paragraph line (maybe lazy), or a blank line. */
function finishLine(cursor: Cursor, text: string, indent: number): ClassifiedLine {
  if (cursor.pos + indent === text.length) {
    return { kind: "blank", joins: false, state: { containers: cursor.containers.slice(0, cursor.matched), leaf: null } };
  }
  if (cursor.leaf?.kind === "paragraph") {
    // Continuation, or a lazy line that keeps unmatched containers open.
    return { kind: "text", joins: true, state: { containers: cursor.containers, leaf: PARAGRAPH } };
  }
  return indent >= CODE_INDENT ? contentLine("code", cursor, INDENTED) : contentLine("text", cursor, PARAGRAPH);
}

/** A line that adds a block to the innermost matched container, closing the unmatched ones. */
function contentLine(kind: ClassifiedLine["kind"], cursor: Cursor, leaf: Leaf | null): ClassifiedLine {
  return { kind, joins: false, state: { containers: withContent(cursor.containers.slice(0, cursor.matched)), leaf } };
}

function pushContainer(cursor: Cursor, container: Container, pos: number): Cursor {
  const containers = [...withContent(cursor.containers.slice(0, cursor.matched)), container];
  return { containers, leaf: null, matched: containers.length, pos };
}

/** Marks list items as holding a block, which lets them continue past blank lines. */
function withContent(containers: readonly Container[]): readonly Container[] {
  if (containers.every((container) => container.kind === "quote" || container.hasContent)) return containers;
  return containers.map((container) => (container.kind === "item" ? { ...container, hasContent: true } : container));
}

function indentAt(text: string, pos: number): number {
  let end = pos;
  while (text.charAt(end) === " ") end += 1;
  return end - pos;
}

/** Tabs become spaces up to the next tab stop (CommonMark 2.2), so columns are string offsets. */
function expandTabs(line: string): string {
  if (!line.includes("\t")) return line;
  let expanded = "";
  for (const char of line) expanded += char === "\t" ? " ".repeat(TAB_STOP - (expanded.length % TAB_STOP)) : char;
  return expanded;
}

function mergeFacts(a: RunFacts, b: RunFacts): RunFacts {
  return { literal: union(a.literal, b.literal), unpaired: union(a.unpaired, b.unpaired) };
}

function union(a: ReadonlySet<number>, b: ReadonlySet<number>): ReadonlySet<number> {
  for (const value of b) if (!a.has(value)) return new Set([...a, ...b]);
  return a;
}

// ---------------------------------------------------------------------------
// Neutralising, inline level (CommonMark 6.1 code spans, with backslash escapes
// and character references).
// Some ranges of a line are protected as code; references anywhere else are
// wrapped in an inserted code span that cannot pair with any backtick around it:
// - its delimiter length is one that no run it could meet has (below);
// - a space separates it from any adjacent backtick, escaped or not, because a
//   closer is a raw run ("\`" + "`" reads as "``");
// - a literal backslash right before it is doubled, so it cannot escape it.
// Normally the protected ranges are the line's own code spans. They are only
// certain when no span is open at the start of the line, though: once an earlier
// line of the paragraph left a run unmatched, spans may pair across the line break.
// Then only an adjacent pair of equal runs whose length no other run in the paragraph
// shares is code in every reading; everything else is wrapped.
// A code span ends GitHub's text node, so matching restarts after each reference,
// and directly adjacent references share one span. Rendering twice changes nothing.
// Not modelled: raw HTML tags and autolinks outrank code spans, so a backtick
// inside one ("<http://x/`>") does not open a span on GitHub.

type Range = { readonly start: number; readonly end: number };
type Pair = Range & { readonly length: number };

/** Backtick-run lengths a text line leaves for the later lines of its paragraph. */
type RunFacts = {
  /** Runs left unmatched on their line: they may open a span on a later line. */
  readonly literal: ReadonlySet<number>;
  /** Runs that are not half of an adjacent equal-length pair (see adjacentPairs). */
  readonly unpaired: ReadonlySet<number>;
};

const NO_FACTS: RunFacts = { literal: new Set(), unpaired: new Set() };
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

function renderTextLine(line: string, earlier: RunFacts): { readonly output: string; readonly facts: RunFacts } {
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

/** Every maximal backtick run, in order. */
function backtickRuns(line: string): readonly Range[] {
  const runs: Range[] = [];
  for (let start = line.indexOf("`"); start !== -1; ) {
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
function lineCodeSpans(line: string, runs: readonly Range[]): { readonly spans: readonly Range[]; readonly literal: ReadonlySet<number> } {
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
function adjacentPairs(line: string, runs: readonly Range[]): { readonly pairs: readonly Pair[]; readonly unpaired: ReadonlySet<number> } {
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

/** Resolved tokens: their ascending plain offsets, and the characters dropped up to each one. */
type Shifts = { readonly at: readonly number[]; readonly total: readonly number[] };

/** `text` as rendered: each escape or reference of ESCAPE_OR_ENTITY resolved to one character. */
function resolveEscapes(text: string): { readonly plain: string; readonly shifts: Shifts } {
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
function sourceOffset(shifts: Shifts, offset: number): number {
  return offset + (shifts.total[countBelow(shifts.at, offset) - 1] ?? 0);
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

/** How many of the ascending `values` are below `limit`. */
function countBelow(values: readonly number[], limit: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((values[middle] ?? limit) < limit) low = middle + 1;
    else high = middle;
  }
  return low;
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

/** An odd run of backslashes right before `index` escapes the character there. */
function isEscaped(text: string, index: number): boolean {
  let count = 0;
  while (text.charAt(index - 1 - count) === "\\") count += 1;
  return count % 2 === 1;
}
