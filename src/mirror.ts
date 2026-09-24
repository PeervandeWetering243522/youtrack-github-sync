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

/** `${baseUrl}/issue/${idReadable}` (baseUrl has no trailing slash). */
export function youtrackIssueUrl(baseUrl: string, idReadable: string): string {
  void baseUrl;
  void idReadable;
  throw new Error("not implemented");
}

/** `^\[YT-(\d+)\]` -> numberInProject, else null. Positive safe integers only. */
export function parseMirrorTitle(title: string): number | null {
  void title;
  throw new Error("not implemented");
}

/** Summary starts with `prefix`, case-insensitive, ignoring leading whitespace. */
export function hasTitlePrefix(summary: string, prefix: string): boolean {
  void summary;
  void prefix;
  throw new Error("not implemented");
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
  void markdown;
  throw new Error("not implemented");
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
  void issue;
  void youtrackBaseUrl;
  throw new Error("not implemented");
}
