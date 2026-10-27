/**
 * The issue list check (decision R11): GitHub can answer the issue list with 200 and issues
 * missing (live during GitHub's incident of 2026-10-22). Every unresolved issue whose mirror
 * is missing then looks unmirrored, and the run creates a duplicate of it. So the list must
 * hold at least as many open items as the repository's `open_issues_count`; both count
 * issues and pull requests. More is fine: an item opened after the list was read.
 * Pure, no I/O.
 */

import type { GitHubIssue } from "../github/issues.ts";

/** The issue list holds fewer open items than the repository reports, so it cannot be trusted. */
export class IncompleteIssueListError extends Error {
  readonly listed: number;
  readonly reported: number;

  constructor(listed: number, reported: number) {
    super(
      `GitHub issue list is incomplete: it holds ${String(listed)} open issues and pull requests, ` +
        `the repository reports ${String(reported)}; nothing was written, the next run reads it again`,
    );
    this.name = "IncompleteIssueListError";
    this.listed = listed;
    this.reported = reported;
  }
}

/** The open issues and pull requests in `issues`, each number once (a shifted page can list one twice). */
export function openListed(issues: readonly GitHubIssue[]): number {
  return new Set(issues.filter((issue) => issue.state === "open").map((issue) => issue.number)).size;
}

/** Throws IncompleteIssueListError when `issues` holds fewer open items than `openIssuesCount`. */
export function checkIssueList(issues: readonly GitHubIssue[], openIssuesCount: number): void {
  const listed = openListed(issues);
  if (listed < openIssuesCount) throw new IncompleteIssueListError(listed, openIssuesCount);
}
