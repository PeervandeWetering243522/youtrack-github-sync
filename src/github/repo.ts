/**
 * The repository read: GET /repos/{owner}/{repo} for its `open_issues_count`, the count of
 * open issues and open pull requests that the issue list is checked against (decision R11,
 * src/plan/list-check.ts). Types derive from @octokit/openapi-types.
 */

import type { components } from "@octokit/openapi-types";
import type { HttpClient } from "../http.ts";
import { isInteger, isJsonObject } from "../json.ts";
import type { JsonValue } from "../json.ts";
import { describeJson, GitHubSchemaError, githubRequest, repoUrl } from "./client.ts";
import type { GitHubTarget } from "./client.ts";

/** `open_issues_count` of a repository: its open issues plus its open pull requests. */
export type OpenIssuesCount = components["schemas"]["full-repository"]["open_issues_count"];

/** Validates a GET /repos/{owner}/{repo} body and returns its `open_issues_count`. */
export function parseOpenIssuesCount(value: JsonValue): OpenIssuesCount {
  if (!isJsonObject(value)) {
    throw new GitHubSchemaError(`GitHub repository must be a JSON object, got ${describeJson(value)}`);
  }
  const count = value["open_issues_count"];
  if (!isInteger(count) || count < 0) {
    throw new GitHubSchemaError(
      `GitHub repository "open_issues_count" must be a non-negative integer, got ${describeJson(count)}`,
    );
  }
  return count;
}

/**
 * GET /repos/{owner}/{repo}. retry: "retry-once". Throws GitHubSchemaError unless the body is
 * an object whose `open_issues_count` is a non-negative integer.
 */
export async function readOpenIssuesCount(http: HttpClient, target: GitHubTarget): Promise<OpenIssuesCount> {
  const response = await http.request(githubRequest(target, "GET", repoUrl(target), "retry-once"));
  return parseOpenIssuesCount(response.body);
}
