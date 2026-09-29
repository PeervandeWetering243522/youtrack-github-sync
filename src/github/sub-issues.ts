/**
 * GitHub sub-issue writes: attach an issue under a parent, or detach it. The child is
 * named by its REST `id` (GitHubIssue.id), the parent by its issue number. GitHub allows
 * 100 sub-issues per parent and 8 levels. Never called in DRY_RUN; sync.ts enforces that.
 */

import type { operations } from "@octokit/openapi-types";
import type { HttpClient } from "../http.ts";
import { githubRequest, issueUrl, positiveInteger } from "./client.ts";
import type { GitHubTarget } from "./client.ts";

type AddSubIssueBody = operations["issues/add-sub-issue"]["requestBody"]["content"]["application/json"];
type RemoveSubIssueBody = operations["issues/remove-sub-issue"]["requestBody"]["content"]["application/json"];

/**
 * POST /repos/{owner}/{repo}/issues/{parentNumber}/sub_issues with
 * {sub_issue_id: childId, replace_parent}; replace_parent true moves a child that already
 * has another parent. retry-once: a retry after a lost response cannot attach the child
 * twice, at worst it fails because the child is attached already (whether GitHub then
 * answers 201 or 422 is not documented; docs/11 V3). Throws RangeError before any request
 * unless parentNumber and childId are positive safe integers.
 */
export async function addSubIssue(
  http: HttpClient,
  target: GitHubTarget,
  parentNumber: number,
  childId: number,
  replaceParent: boolean,
): Promise<void> {
  const url = `${issueUrl(target, parentNumber)}/sub_issues`;
  const body = {
    sub_issue_id: positiveInteger("GitHub sub-issue id", childId),
    replace_parent: replaceParent,
  } satisfies AddSubIssueBody;
  await http.request(githubRequest(target, "POST", url, "retry-once", body));
}

/**
 * DELETE /repos/{owner}/{repo}/issues/{parentNumber}/sub_issue with {sub_issue_id: childId}
 * (a JSON body on DELETE, as GitHub documents it). retry-once: repeating it cannot detach
 * anything else, at worst a retry after a lost response fails because the child is gone
 * already. Throws RangeError before any request unless parentNumber and childId are
 * positive safe integers.
 */
export async function removeSubIssue(
  http: HttpClient,
  target: GitHubTarget,
  parentNumber: number,
  childId: number,
): Promise<void> {
  const url = `${issueUrl(target, parentNumber)}/sub_issue`;
  const body = { sub_issue_id: positiveInteger("GitHub sub-issue id", childId) } satisfies RemoveSubIssueBody;
  await http.request(githubRequest(target, "DELETE", url, "retry-once", body));
}
