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
 */

type FenceLeaf = { readonly kind: "fence"; readonly char: string; readonly length: number };
/** `end` null: ends at a blank line (kinds 6, 7). `closer`: a line ending it, for blockCloser. */
type HtmlLeaf = { readonly kind: "html"; readonly end: RegExp | null; readonly closer: string };
type Leaf = { readonly kind: "paragraph" | "indented" } | FenceLeaf | HtmlLeaf;
type Container =
  | { readonly kind: "quote" }
  | { readonly kind: "item"; readonly padding: number; readonly hasContent: boolean };
/** The open containers (outermost first) and the open leaf block after a line. */
export type BlockState = { readonly containers: readonly Container[]; readonly leaf: Leaf | null };
/** While a line is classified: containers[0, matched) continue on it, `pos` is past them. */
type Cursor = BlockState & { readonly matched: number; readonly pos: number };
export type ClassifiedLine = {
  readonly kind: "code" | "text" | "blank";
  /** A text line that continues the paragraph of the line before it. */
  readonly joins: boolean;
  readonly state: BlockState;
};

/** The state before the first line. */
export const EMPTY_STATE: BlockState = { containers: [], leaf: null };
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
export function classifyLine(state: BlockState, line: string): ClassifiedLine {
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
