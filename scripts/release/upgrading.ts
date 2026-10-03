/**
 * The "## Upgrading" section of a PR description (decision V5): what a group running the mirror
 * must do before updating to a release with a breaking change. A PR has one exactly when its
 * title has a `!` (pr-check.ts). The squash commit on main is the PR title only, so the section
 * reaches the release notes through notes.ts, which reads it from the merged PR. It never goes
 * through the commit parser, which would drop lines such as `Closes #12` and split the note at
 * any line starting with "breaking change".
 */

/** A conventional-commit header with a `!` before the colon (the preset's breakingHeaderPattern). */
const BREAKING_HEADER = /^\w*(?:\(.*\))?!: /;

const HEADING = /^ {0,3}##[ \t]+upgrading[ \t]*#*[ \t]*$/i;
/** A heading of level 1 or 2 ends the section; deeper ones belong to it. */
const SECTION_END = /^ {0,3}#{1,2}(?:[ \t]|$)/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";

const TOKEN = /UPGRADING-NOTE-(\d+)/g;

/** A description line: prose (comments removed), a fence's opening or closing line, or code inside a fence. */
type MarkdownLine = { readonly text: string; readonly kind: "text" | "fence" | "code" };
type Fence = { readonly marker: string; readonly length: number };

/** True when the commit message's first line (or a PR title) marks a breaking change with `!`. */
export function isBreakingTitle(message: string): boolean {
  return BREAKING_HEADER.test(message);
}

/**
 * The text of the description's first "## Upgrading" section, trimmed, or null when there is
 * none or it is empty. HTML comments, like the template's guidance, do not count. Headings
 * inside code fences neither start nor end the section.
 */
export function upgradingSection(body: string | null): string | null {
  if (body === null) return null;
  const lines = markdownLines(body);
  const start = lines.findIndex((line) => line.kind === "text" && HEADING.test(line.text));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.kind === "text" && SECTION_END.test(line.text));
  const text = (end === -1 ? rest : rest.slice(0, end))
    .map((line) => line.text)
    .join("\n")
    .trim();
  return text === "" ? null : text;
}

/**
 * Splits a description into lines as GitHub renders it. A fence closes only with its own
 * character, at least as long. Outside fences, HTML comments are removed, a comment across
 * lines joins what is around it into one line, and an unclosed one hides the rest.
 */
function markdownLines(body: string): readonly MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let fence: Fence | null = null;
  // The text before a comment still open, joined with the text after it ends.
  let beforeComment: string | null = null;
  for (const raw of body.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence !== null) {
      const closes = closesFence(raw, fence);
      lines.push({ text: raw, kind: closes ? "fence" : "code" });
      if (closes) fence = null;
      continue;
    }
    const stripped = withoutComments(raw, beforeComment !== null);
    const text: string = (beforeComment ?? "") + stripped.text;
    if (stripped.inComment) {
      beforeComment = text;
      continue;
    }
    beforeComment = null;
    fence = openedFence(text);
    lines.push({ text, kind: fence === null ? "text" : "fence" });
  }
  return lines;
}

function openedFence(line: string): Fence | null {
  const marker = FENCE_OPEN.exec(line)?.[1];
  return marker === undefined ? null : { marker: marker.charAt(0), length: marker.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const marker = FENCE_CLOSE.exec(line)?.[1] ?? "";
  return marker.startsWith(fence.marker) && marker.length >= fence.length;
}

/** The line without its HTML comments, and whether a comment is still open at its end. */
function withoutComments(line: string, inComment: boolean): { readonly text: string; readonly inComment: boolean } {
  let text = "";
  let rest = line;
  let open = inComment;
  for (;;) {
    if (open) {
      const end = rest.indexOf(COMMENT_CLOSE);
      if (end === -1) return { text, inComment: true };
      rest = rest.slice(end + COMMENT_CLOSE.length);
      open = false;
    }
    const start = rest.indexOf(COMMENT_OPEN);
    if (start === -1) return { text: text + rest, inComment: false };
    text += rest.slice(0, start);
    rest = rest.slice(start + COMMENT_OPEN.length);
    open = true;
  }
}

/**
 * The commit message the notes generator gets for a breaking commit with a section: its header
 * and a `BREAKING CHANGE:` footer holding only a token, which fillUpgrading replaces with the
 * section afterwards. Any other body (typed into the merge dialog) is dropped: the section wins.
 */
export function withUpgradingToken(message: string, index: number): string {
  const header = message.split("\n", 1)[0] ?? "";
  return `${header}\n\nBREAKING CHANGE: UPGRADING-NOTE-${String(index)}`;
}

/** Puts each section in place of its token, its later lines indented to stay in the token's `* ` bullet. */
export function fillUpgrading(notes: string, sections: ReadonlyMap<number, string>): string {
  return notes.replace(TOKEN, (token, index: string) => {
    const text = sections.get(Number(index));
    return text === undefined ? token : indentLater(text);
  });
}

function indentLater(text: string): string {
  return text
    .split("\n")
    .map((line, i) => (i === 0 || line === "" ? line : `  ${line}`))
    .join("\n");
}
