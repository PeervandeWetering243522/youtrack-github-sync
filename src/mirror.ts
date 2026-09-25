/**
 * Pure formatting and matching rules for mirror issues: the mirror title, the
 * body layout (notices, description, separator, footer) and the length limits.
 * No I/O. The CommonMark-aware work lives in src/utils/:
 *   markdown-render.ts   line-by-line neutralising (uses markdown-blocks.ts, markdown-inline.ts)
 *   markdown-cut.ts      cutting a rendering to a budget
 *   markdown-escapes.ts  escapes and character references
 *   text.ts              UTF-16-safe cutting
 */

import { fitRendered } from "./utils/markdown-cut.ts";
import { resolveEscapes, sourceOffset } from "./utils/markdown-escapes.ts";
import type { Shifts } from "./utils/markdown-escapes.ts";
import { closerAfter, joinLines, renderLines } from "./utils/markdown-render.ts";
import { cutUtf16 } from "./utils/text.ts";
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
 *   [if description non-null and non-blank]  neutraliseReferences(description) + closer + "\n\n---\n"
 *   "Mirrored from YouTrack: <url>"
 * The closer is a line closing a code fence or HTML block (kinds 1-5) that the
 * description leaves open at the top level, so the separator and the link line
 * never render as code or vanish into an HTML comment; usually it is empty.
 * A null/blank description yields only the link line (plus the title notice if any).
 * If the body would exceed MAX_BODY_LENGTH, the description part is cut (no surrogate
 * split, open blocks closed) and the body ends with
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
  const whole = plain.length <= room ? wholeDescription(description, room) : null;
  if (whole !== null) return { text: `${head}${whole}${SEPARATOR}${footer}`, truncated: false };
  return { text: truncatedBody(head, description, shifts, url), truncated: true };
}

/**
 * The whole description, neutralised, plus the closer for a block it leaves open;
 * null if both together do not fit in `room` (the body is then truncated instead).
 */
function wholeDescription(description: string, room: number): string | null {
  const lines = renderLines(description);
  const rendered = joinLines(lines) + closerAfter(lines);
  return rendered.length <= room ? rendered : null;
}

/**
 * For the same reason, no source past the offset where the resolved description reaches
 * `budget` characters can fit, so that is all that is rendered (CPU time).
 */
function truncatedBody(head: string, description: string, shifts: Shifts, url: string): string {
  const tail = `${SEPARATOR}${LINK_LINE}${url}${LIMIT_NOTICE}${url}`;
  const budget = MAX_BODY_LENGTH - head.length - tail.length;
  const source = cutUtf16(description, sourceOffset(shifts, budget));
  const kept = budget > 0 ? fitRendered(renderLines(source), budget) : "";
  // The outer cut only bites for absurdly long URLs (budget <= 0).
  return cutUtf16(`${head}${kept}${tail}`, MAX_BODY_LENGTH);
}
