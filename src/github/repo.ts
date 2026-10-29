/**
 * The repository read: its count of open issues, pull requests left out, that the issue list
 * is checked against (decision R11, src/plan/list-check.ts). REST has no such count
 * (`open_issues_count` adds the open pull requests), so this one read goes to GraphQL:
 * `repository.issues(states: OPEN).totalCount`, which needs only issue read access.
 */

import type { HttpClient } from "../http.ts";
import { isInteger, isJsonArray, isJsonObject } from "../json.ts";
import type { JsonObject, JsonValue } from "../json.ts";
import { describeJson, GITHUB_GRAPHQL_URL, GitHubSchemaError, githubRequest } from "./client.ts";
import type { GitHubTarget } from "./client.ts";

/** Read-only; owner and name go in as variables, never into the query text. */
const OPEN_ISSUE_COUNT_QUERY =
  "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { issues(states: OPEN) { totalCount } } }";

/**
 * Validates a GraphQL answer to OPEN_ISSUE_COUNT_QUERY and returns its totalCount. GraphQL
 * reports a missing repository or a rate limit as 200 with `errors`; any error refuses the
 * whole answer, and only the first error's `type` is echoed, never its message.
 */
export function parseOpenIssueCount(value: JsonValue): number {
  if (!isJsonObject(value)) {
    throw new GitHubSchemaError(`GitHub GraphQL answer must be a JSON object, got ${describeJson(value)}`);
  }
  const errors = value["errors"];
  if (errors !== undefined) {
    const first = isJsonArray(errors) ? errors[0] : undefined;
    const type = isJsonObject(first) ? first["type"] : undefined;
    throw new GitHubSchemaError(`GitHub GraphQL answered with errors (first type: ${describeJson(type)})`);
  }
  const count = field(field(field(value, "data"), "repository"), "issues")?.["totalCount"];
  if (!isInteger(count) || count < 0) {
    throw new GitHubSchemaError(
      `GitHub GraphQL "data.repository.issues.totalCount" must be a non-negative integer, got ${describeJson(count)}`,
    );
  }
  return count;
}

/** `parent[key]` when parent and that value are both JSON objects, else undefined. */
function field(parent: JsonValue | undefined, key: string): JsonObject | undefined {
  if (!isJsonObject(parent)) return undefined;
  const value = parent[key];
  return isJsonObject(value) ? value : undefined;
}

/**
 * POST /graphql with OPEN_ISSUE_COUNT_QUERY. retry: "retry-once" (a query writes nothing).
 * Throws GitHubSchemaError for an answer parseOpenIssueCount refuses.
 */
export async function readOpenIssueCount(http: HttpClient, target: GitHubTarget): Promise<number> {
  const body = { query: OPEN_ISSUE_COUNT_QUERY, variables: { owner: target.owner, name: target.repo } };
  const response = await http.request(githubRequest(target, "POST", GITHUB_GRAPHQL_URL, "retry-once", body));
  return parseOpenIssueCount(response.body);
}
