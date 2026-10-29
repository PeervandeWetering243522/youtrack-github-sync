/**
 * The issue list check (decision R11): GitHub can answer the issue list with 200 and issues
 * missing (live during GitHub's incident of 2026-10-22). Every unresolved issue whose mirror
 * is missing then looks unmirrored, and the run creates a duplicate of it. So the list must
 * hold at least as many open issues as the repository's open issue count. More is fine: an
 * issue opened after the list was read.
 * Pull requests are left out on both sides: a token without pull request read access (the
 * Action's default token) gets a list without them, live since v1.0.1 (docs/03, gotcha 18).
 * Pure, no I/O.
 */

import type { GitHubIssue } from "../github/issues.ts";

/** The issue list holds fewer open issues than the repository reports, so it cannot be trusted. */
export class IncompleteIssueListError extends Error {
  readonly listed: number;
  readonly reported: number;

  constructor(listed: number, reported: number) {
    super(
      `GitHub issue list is incomplete: it holds ${String(listed)} open issues, ` +
        `the repository reports ${String(reported)}; nothing was written, the next run reads it again`,
    );
    this.name = "IncompleteIssueListError";
    this.listed = listed;
    this.reported = reported;
  }
}

/** The open issues in `issues`, pull requests left out, each number once (a shifted page can list one twice). */
export function openListed(issues: readonly GitHubIssue[]): number {
  const open = issues.filter((issue) => issue.state === "open" && !issue.isPullRequest);
  return new Set(open.map((issue) => issue.number)).size;
}

/** Throws IncompleteIssueListError when `issues` holds fewer open issues than `openIssueCount`. */
export function checkIssueList(issues: readonly GitHubIssue[], openIssueCount: number): void {
  const listed = openListed(issues);
  if (listed < openIssueCount) throw new IncompleteIssueListError(listed, openIssueCount);
}
