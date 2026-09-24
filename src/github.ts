/**
 * GitHub side. Types derive from @octokit/openapi-types (GitHub's official
 * OpenAPI description). Writes are never called in DRY_RUN; sync.ts enforces that.
 */

import type { components, operations } from "@octokit/openapi-types";
import type { HttpClient } from "./http.ts";
import type { JsonValue } from "./json.ts";

type IssueSchema = components["schemas"]["issue"];

export type CreateIssueBody = operations["issues/create"]["requestBody"]["content"]["application/json"];
export type UpdateIssueBody = NonNullable<
  operations["issues/update"]["requestBody"]
>["content"]["application/json"];

export type IssueState = "open" | "closed";

/** The subset of a GitHub issue this tool reads. */
export type GitHubIssue = Readonly<Pick<IssueSchema, "number" | "title">> & {
  readonly state: IssueState;
  readonly labelNames: readonly string[];
  /** Items from /issues that are really pull requests (have a `pull_request` key). */
  readonly isPullRequest: boolean;
};

export type GitHubTarget = {
  readonly owner: string;
  readonly repo: string;
  readonly token: string;
};

export const GITHUB_API_BASE = "https://api.github.com";
export const GITHUB_API_VERSION = "2026-03-10";
export const GITHUB_PAGE_SIZE = 100;
export const MIRROR_LABEL = "youtrack";

export class GitHubSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubSchemaError";
  }
}

/**
 * Headers for every GitHub call: Accept: application/vnd.github+json,
 * Authorization: Bearer <token>, X-GitHub-Api-Version, Content-Type for bodies.
 * (User-Agent is added by the http client.)
 */
export function githubHeaders(token: string): Readonly<Record<string, string>> {
  void token;
  throw new Error("not implemented");
}

/** Validates one issue/PR object from the list or create response. */
export function parseGitHubIssue(value: JsonValue): GitHubIssue {
  void value;
  throw new Error("not implemented");
}

/**
 * Extracts the rel="next" URL from a Link header, or null. Must accept only
 * https://api.github.com URLs (never follow a Link to another host with our token).
 */
export function nextPageUrl(linkHeader: string | null): string | null {
  void linkHeader;
  throw new Error("not implemented");
}

/**
 * GET /repos/{owner}/{repo}/issues?state=all&per_page=100 (no label filter, per
 * decision A5), following Link rel="next" verbatim. Includes PRs (flagged).
 * retry: "retry-once".
 */
export async function listAllIssues(
  http: HttpClient,
  target: GitHubTarget,
): Promise<readonly GitHubIssue[]> {
  void http;
  void target;
  throw new Error("not implemented");
}

/** POST /repos/{owner}/{repo}/issues. retry: "no-retry" (not idempotent). Returns the created issue. */
export async function createIssue(
  http: HttpClient,
  target: GitHubTarget,
  body: CreateIssueBody,
): Promise<GitHubIssue> {
  void http;
  void target;
  void body;
  throw new Error("not implemented");
}

/** PATCH /repos/{owner}/{repo}/issues/{n} with {state:"closed", state_reason:"completed"}. retry-once. */
export async function closeIssue(
  http: HttpClient,
  target: GitHubTarget,
  issueNumber: number,
): Promise<void> {
  void http;
  void target;
  void issueNumber;
  throw new Error("not implemented");
}

/** POST /repos/{owner}/{repo}/issues/{n}/labels with {labels:[label]}. retry-once (idempotent). */
export async function addLabel(
  http: HttpClient,
  target: GitHubTarget,
  issueNumber: number,
  label: string,
): Promise<void> {
  void http;
  void target;
  void issueNumber;
  void label;
  throw new Error("not implemented");
}
