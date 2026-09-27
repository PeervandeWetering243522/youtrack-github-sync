/**
 * Neutralising, block level: which lines are code, which are inline text, and
 * which text line continues a paragraph. Pure, no I/O.
 *
 * A line-by-line port of the CommonMark 0.31 block algorithm (as in its reference
 * parser, commonmark.js) for block quotes, list items, fenced and indented code,
 * HTML blocks, headings, thematic breaks and paragraphs with lazy continuation
 * lines. Containers matter for fences: "- ```" opens one inside a list item, an
 * unindented line closes a fence inside a list item, and "    ```" after a
 * paragraph is plain text.
 * HTML block lines are copied like code: Markdown is not parsed there, so
 * backticks would not protect anything, and wrapping could break the block's end
 * marker ("@b-->" -> "`@b--`>"). GFM tables are not parsed.
 *
 * Cost is linear in the input, whatever the nesting depth: a line does work for
 * its own characters, and the containers it does not touch are shared with the
 * state before it. A blank line jumps past the list items it continues (see
 * `stops`), and the thematic break test is answered from one scan of the line.
 */

type FenceLeaf = { readonly kind: "fence"; readonly char: string; readonly length: number };
/** `end` null: ends at a blank line (kinds 6, 7). `closer`: a line ending it, for blockCloser. */
type HtmlLeaf = { readonly kind: "html"; readonly end: RegExp | null; readonly closer: string };
type Leaf = { readonly kind: "paragraph" | "indented" } | FenceLeaf | HtmlLeaf;
type Item = { readonly kind: "item"; readonly padding: number; readonly hasContent: boolean };
type Container = { readonly kind: "quote" } | Item;
/**
 * The open containers (outermost first) and the open leaf block after a line.
 * `stops`: ascending indices of the containers a blank line cannot continue, the
 * block quotes and a list item still without content (only ever the last one).
 */
export type BlockState = {
  readonly containers: readonly Container[];
  readonly stops: readonly number[];
  readonly leaf: Leaf | null;
};
/** A line after tab expansion, with the facts that would otherwise be rescanned per container. */
type Line = {
  readonly text: string;
  /** Past the last non-space character: from here on the line is blank. */
  readonly end: number;
  /** A thematic break starts at `at` if text[at] is `breakChar` and breakFrom <= at <= breakTo. */
  readonly breakChar: string;
  readonly breakFrom: number;
  readonly breakTo: number;
};
/** While a line is classified: state.containers[0, matched) continue on it, `pos` is past them. */
type Cursor = { readonly state: BlockState; readonly matched: number; readonly pos: number };
export type ClassifiedLine = {
  readonly kind: "code" | "text" | "blank";
  /** A text line that continues the paragraph of the line before it. */
  readonly joins: boolean;
  readonly state: BlockState;
};

/** The state before the first line. */
export const EMPTY_STATE: BlockState = { containers: [], stops: [], leaf: null };
const PARAGRAPH: Leaf = { kind: "paragraph" };
const INDENTED: Leaf = { kind: "indented" };
const QUOTE: Container = { kind: "quote" };
const CODE_INDENT = 4;
const TAB_STOP = 4;
/** More spaces than this after a list marker make the item's content indented code. */
const MAX_MARKER_SPACES = 4;
/** A thematic break needs this many marker characters. */
const BREAK_MIN = 3;
const BREAK_CHARS = "*_-";
const ATX_HEADING = /^#{1,6}(?:[ \t]|$)/;
/** A backtick fence's info string cannot contain a backtick ("```a``` @b" is inline code). */
const FENCE_OPEN = /^(?:`{3,}(?!.*`)|~{3,})/;
const FENCE_CLOSE = /^(?:`{3,}|~{3,})(?=[ \t]*$)/;
const SETEXT_UNDERLINE = /^(?:=+|-+)[ \t]*$/;
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

/**
 * A line closing the code fence or HTML block (kinds 1-5) that `state` leaves open
 * at the top level; otherwise text after it would render as code or vanish into
 * an HTML comment. Inside a list item or block quote an unindented "---" line
 * (the mirror's separator) closes them, so nothing is needed there; indented code
 * and HTML kinds 6-7 end at a blank line.
 */
export function blockCloser(state: BlockState): string {
  const { leaf } = state;
  if (leaf === null || state.containers.length > 0) return "";
  if (leaf.kind === "fence") return `\n${leaf.char.repeat(leaf.length)}`;
  return leaf.kind === "html" && leaf.closer !== "" ? `\n${leaf.closer}` : "";
}

/** Classifies one line, given the block state after the lines before it. */
export function classifyLine(state: BlockState, source: string): ClassifiedLine {
  const line = scanLine(expandTabs(source));
  const cursor = matchContainers(state, line);
  if (cursor.matched === state.containers.length && state.leaf !== null) {
    const continued = continueLeaf(cursor, state.leaf, line.text);
    if (continued !== null) return continued;
  }
  return openBlocks(cursor, line);
}

/**
 * Continues the open containers on the line. Each one consumes at least one
 * character, until the rest of the line is blank: then every list item with
 * content continues without consuming, up to the next stop.
 */
function matchContainers(state: BlockState, line: Line): Cursor {
  let pos = 0;
  let matched = 0;
  for (const container of state.containers) {
    if (pos >= line.end) {
      const stop = nextStop(state.stops, matched, state.containers.length);
      return { state, matched: stop, pos: stop > matched ? line.text.length : pos };
    }
    const next = continueContainer(container, line.text, pos);
    if (next === null) break;
    pos = next;
    matched += 1;
  }
  return { state, matched, pos };
}

/** The first stop at or after `from` (binary search), or `length` if there is none. */
function nextStop(stops: readonly number[], from: number, length: number): number {
  const index = lowerBound(stops, from);
  return index < stops.length ? (stops[index] ?? length) : length;
}

/** How many of the ascending `values` are below `limit`. */
function lowerBound(values: readonly number[], limit: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((values[middle] ?? limit) < limit) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Where a non-blank rest of the line continues inside `container`, or null if it does not. */
function continueContainer(container: Container, text: string, pos: number): number | null {
  if (container.kind === "quote") {
    const first = pos + spacesAt(text, pos, CODE_INDENT);
    if (first - pos >= CODE_INDENT || text.charAt(first) !== ">") return null;
    return text.charAt(first + 1) === " " ? first + 2 : first + 1;
  }
  return spacesAt(text, pos, container.padding) >= container.padding ? pos + container.padding : null;
}

/** A line that stays in an open fence, indented code or HTML block; null otherwise. */
function continueLeaf(cursor: Cursor, leaf: Leaf, text: string): ClassifiedLine | null {
  const indent = indentAt(text, cursor.pos);
  const blank = cursor.pos + indent === text.length;
  const { containers, stops } = cursor.state;
  const open: BlockState = { containers, stops, leaf };
  const closed: BlockState = { containers, stops, leaf: null };
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

/**
 * The containers this line opens, after the matched ones. Once one is open the
 * old leaf is closed and every earlier container is matched. `opened` is built
 * for this line only (a local builder, so deep lines stay linear) and copied into
 * the state when the line ends.
 */
type Opening = { readonly cursor: Cursor; readonly opened: Container[] };

/** Opens new containers, then at most one leaf block (CommonMark block starts, in order). */
function openBlocks(start: Cursor, line: Line): ClassifiedLine {
  const opening: Opening = { cursor: start, opened: [] };
  const { text } = line;
  let pos = start.pos;
  for (;;) {
    const indent = indentAt(text, pos);
    const at = pos + indent;
    if (indent >= CODE_INDENT) return finishLine(opening, text, pos, indent);
    if (text.charAt(at) === ">") {
      opening.opened.push(QUOTE);
      pos = text.charAt(at + 1) === " " ? at + 2 : at + 1;
      continue;
    }
    const rest = text.slice(at);
    const leafLine = openLeaf(opening, line, at, rest);
    if (leafLine !== null) return leafLine;
    const item = openListItem(opening, rest, indent);
    if (item === null) return finishLine(opening, text, pos, indent);
    opening.opened.push(item.container);
    pos += item.advance;
  }
}

/** The leaf block open before this line, unless the line opened a container (which closes it). */
function tipLeaf(opening: Opening): Leaf | null {
  return opening.opened.length > 0 ? null : opening.cursor.state.leaf;
}

/** Whether a paragraph continuation here would be a lazy line, not one in its own container. */
function tipIsOwnParagraph(opening: Opening): boolean {
  const { cursor } = opening;
  const allMatched = opening.opened.length > 0 || cursor.matched === cursor.state.containers.length;
  return allMatched && tipLeaf(opening)?.kind === "paragraph";
}

/** An ATX heading, fence, HTML block, setext underline or thematic break at `at` (`rest` starts there). */
function openLeaf(opening: Opening, line: Line, at: number, rest: string): ClassifiedLine | null {
  const tipIsParagraph = tipLeaf(opening)?.kind === "paragraph";
  if (ATX_HEADING.test(rest)) return contentLine("text", opening, null);
  const fence = FENCE_OPEN.exec(rest)?.[0];
  if (fence !== undefined)
    return contentLine("code", opening, { kind: "fence", char: fence.charAt(0), length: fence.length });
  const html = rest.startsWith("<") ? openHtmlBlock(rest, tipIsParagraph) : null;
  if (html !== null) return contentLine("code", opening, html.end?.test(rest) === true ? null : html);
  const setext = tipIsOwnParagraph(opening) && SETEXT_UNDERLINE.test(rest);
  return setext || isThematicBreak(line, at) ? contentLine("text", opening, null) : null;
}

function openHtmlBlock(rest: string, tipIsParagraph: boolean): HtmlLeaf | null {
  for (const [start, leaf] of HTML_BLOCKS) if (start.test(rest)) return leaf;
  return !tipIsParagraph && HTML_BLOCK_7.test(rest) ? htmlLeaf(null, "") : null;
}

/** A list item marker at `rest`, `indent` columns past the position (CommonMark 5.2). */
function openListItem(opening: Opening, rest: string, indent: number): { container: Item; advance: number } | null {
  const match = LIST_MARKER.exec(rest);
  if (match === null) return null;
  const [marker, ordinal] = match;
  const width = marker.length;
  if (width < rest.length && rest.charAt(width) !== " ") return null;
  const spaces = indentAt(rest, width);
  const isEmpty = width + spaces === rest.length;
  // Only a non-empty item, ordered ones starting at 1, can interrupt a paragraph.
  if (tipIsOwnParagraph(opening) && (isEmpty || (ordinal !== undefined && Number(ordinal) !== 1))) return null;
  const narrow = isEmpty || spaces > MAX_MARKER_SPACES;
  const padding = indent + width + (narrow ? 1 : spaces);
  const advance = indent + width + (narrow ? Math.min(spaces, 1) : spaces);
  return { container: { kind: "item", padding, hasContent: false }, advance };
}

/** No block starts here: indented code, a paragraph line (maybe lazy), or a blank line. */
function finishLine(opening: Opening, text: string, pos: number, indent: number): ClassifiedLine {
  if (pos + indent === text.length) return { kind: "blank", joins: false, state: buildState(opening, false, null) };
  const { state } = opening.cursor;
  if (tipLeaf(opening)?.kind === "paragraph") {
    // Continuation, or a lazy line that keeps unmatched containers open.
    return { kind: "text", joins: true, state: { ...state, leaf: PARAGRAPH } };
  }
  return indent >= CODE_INDENT ? contentLine("code", opening, INDENTED) : contentLine("text", opening, PARAGRAPH);
}

/** A line that adds a block to the innermost container, closing the unmatched ones. */
function contentLine(kind: ClassifiedLine["kind"], opening: Opening, leaf: Leaf | null): ClassifiedLine {
  return { kind, joins: false, state: buildState(opening, true, leaf) };
}

/**
 * The matched containers plus the opened ones. Opening a container, or adding a
 * block (`hasBlock`), gives every list item before it content, which lets them
 * continue past blank lines. Unchanged containers are shared, not copied.
 */
function buildState(opening: Opening, hasBlock: boolean, leaf: Leaf | null): BlockState {
  const { cursor, opened } = opening;
  const { containers, stops } = cursor.state;
  const last = containers.at(-1);
  // Only the innermost container can be a list item without content (see `stops`).
  const markLast = (hasBlock || opened.length > 0) && last?.kind === "item" && !last.hasContent;
  const keepsAll = cursor.matched === containers.length;
  if (opened.length === 0 && keepsAll && !markLast) return { containers, stops, leaf };
  const kept = containers.slice(0, cursor.matched);
  const keptStops = stops.slice(0, lowerBound(stops, cursor.matched));
  const prefix = keepsAll && markLast ? kept.map(withContent) : kept;
  const prefixStops = prefix === kept ? keptStops : keptStops.slice(0, -1);
  const added = opened.map((container, index) =>
    hasBlock || index < opened.length - 1 ? withContent(container) : container,
  );
  const addedStops = added.flatMap((container, index) => (isStop(container) ? [prefix.length + index] : []));
  return { containers: [...prefix, ...added], stops: [...prefixStops, ...addedStops], leaf };
}

function isStop(container: Container): boolean {
  return container.kind === "quote" || !container.hasContent;
}

/** Marks a list item as holding a block. */
function withContent(container: Container): Container {
  return container.kind === "item" && !container.hasContent ? { ...container, hasContent: true } : container;
}

/** The line's blank tail and thematic break tail, found in one scan from its end. */
function scanLine(text: string): Line {
  let index = text.length;
  while (index > 0 && isSpaceOrTab(text.charAt(index - 1))) index -= 1;
  const end = index;
  const breakChar = text.charAt(end - 1);
  let breakTo = -1;
  if (breakChar !== "" && BREAK_CHARS.includes(breakChar)) {
    let count = 0;
    for (; index > 0; index -= 1) {
      const char = text.charAt(index - 1);
      if (char !== breakChar && !isSpaceOrTab(char)) break;
      if (char === breakChar) count += 1;
      if (char === breakChar && count === BREAK_MIN) breakTo = index - 1;
    }
  }
  return { text, end, breakChar, breakFrom: index, breakTo };
}

/** THEMATIC_BREAK (CommonMark 4.1) on the rest of the line from `at`, which is not a space. */
function isThematicBreak(line: Line, at: number): boolean {
  return at >= line.breakFrom && at <= line.breakTo && line.text.charAt(at) === line.breakChar;
}

function isSpaceOrTab(char: string): boolean {
  return char === " " || char === "\t";
}

function indentAt(text: string, pos: number): number {
  return spacesAt(text, pos, Infinity);
}

/** The spaces at `pos`, counting at most `limit`. */
function spacesAt(text: string, pos: number, limit: number): number {
  let end = pos;
  while (end - pos < limit && text.charAt(end) === " ") end += 1;
  return end - pos;
}

/** Tabs become spaces up to the next tab stop (CommonMark 2.2), so columns are string offsets. */
function expandTabs(line: string): string {
  if (!line.includes("\t")) return line;
  let expanded = "";
  for (const char of line) expanded += char === "\t" ? " ".repeat(TAB_STOP - (expanded.length % TAB_STOP)) : char;
  return expanded;
}
