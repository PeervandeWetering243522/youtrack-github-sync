/**
 * GitHub assignees (U5, docs/13 2.2 and 2.7): the assignee shape of an issue, the repo's
 * assignable users and the add and remove writes. Logins carry student IDs, so no error
 * message here quotes a login (U8): shapes are named by kind only (jsonKind). Writes are never
 * called in DRY_RUN; sync.ts enforces that. Imports client.ts and pages.ts only.
 */

import type { operations } from "@octokit/openapi-types";
import type { HttpClient } from "../http.ts";
import { isJsonArray, isJsonObject, isString } from "../json.ts";
import type { JsonValue } from "../json.ts";
import { GITHUB_PAGE_SIZE, GitHubSchemaError, githubRequest, issueUrl, jsonKind, repoUrl } from "./client.ts";
import type { GitHubTarget } from "./client.ts";
import { listAllPages } from "./pages.ts";

type AddAssigneesBody = NonNullable<operations["issues/add-assignees"]["requestBody"]>["content"]["application/json"];
type RemoveAssigneesBody = operations["issues/remove-assignees"]["requestBody"]["content"]["application/json"];

/** An assignee as GitHub reports it: the login verbatim and the account type ("User", "Bot", ...; "" if absent). */
export type GitHubAssignee = { readonly login: string; readonly type: string };

/** GitHub's limit of assignees per issue; addAssignees and removeAssignees send at most this many. */
export const MAX_ASSIGNEES_PER_ISSUE = 10;

/**
 * `assignees` of an issue object. Missing or null: []. Not an array: GitHubSchemaError
 * prefixed with `context` (e.g. "GitHub issue #5"), naming the JSON kind only. Items without
 * a string login are skipped, like unreadable labels; a missing or non-string `type` reads as
 * "" (never a User, so never removed). Returns new objects with the login and type only.
 */
export function parseAssignees(value: JsonValue | undefined, context: string): readonly GitHubAssignee[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!isJsonArray(value)) {
    throw new GitHubSchemaError(`${context}: "assignees" must be an array or null, got ${jsonKind(value)}`);
  }
  return value.flatMap(toAssignee);
}

/**
 * GET /repos/{owner}/{repo}/assignees?per_page=100, following Link rel="next" verbatim while
 * `mayFetchNext` allows a further page. retry: "retry-once". Items are read like an issue's
 * assignees. Throws GitHubSchemaError for a page that is not an array, a Link header
 * nextPageUrl rejects, or a page fetched twice; PageLimitError when `mayFetchNext` refuses.
 */
export async function listAssignableUsers(
  http: HttpClient,
  target: GitHubTarget,
  mayFetchNext: () => boolean = () => true,
): Promise<readonly GitHubAssignee[]> {
  const query = new URLSearchParams({ per_page: String(GITHUB_PAGE_SIZE) });
  const firstUrl = `${repoUrl(target)}/assignees?${query.toString()}`;
  return await listAllPages(http, target, firstUrl, parseAssignablePage, mayFetchNext);
}

/**
 * POST /repos/{owner}/{repo}/issues/{n}/assignees with {assignees: logins}, a plain string
 * array (gotcha 15 of docs/12). GitHub adds them and keeps the others; it silently ignores a
 * login it cannot assign (201, live). retry-once: adding twice changes nothing. Returns the
 * answered issue's assignees, to check against what was sent (docs/13 2.8). Throws RangeError
 * before any request for a bad issue number, 0 or more than 10 logins, or an empty login;
 * GitHubSchemaError for an answer that is not an object; HttpError as the client throws it.
 */
export async function addAssignees(
  http: HttpClient,
  target: GitHubTarget,
  issueNumber: number,
  logins: readonly string[],
): Promise<readonly GitHubAssignee[]> {
  return await writeAssignees(http, target, issueNumber, logins, "add");
}

/**
 * DELETE /repos/{owner}/{repo}/issues/{n}/assignees with {assignees: logins} (a JSON body on
 * DELETE, as GitHub documents it). GitHub ignores a login that is not assigned (200, live).
 * retry-once: a second DELETE is a no-op. Returns and throws like addAssignees.
 */
export async function removeAssignees(
  http: HttpClient,
  target: GitHubTarget,
  issueNumber: number,
  logins: readonly string[],
): Promise<readonly GitHubAssignee[]> {
  return await writeAssignees(http, target, issueNumber, logins, "remove");
}

// ---------------------------------------------------------------------------
// Internals

type WriteVerb = "add" | "remove";

const METHOD_OF = { add: "POST", remove: "DELETE" } as const satisfies Record<WriteVerb, "POST" | "DELETE">;

async function writeAssignees(
  http: HttpClient,
  target: GitHubTarget,
  issueNumber: number,
  logins: readonly string[],
  verb: WriteVerb,
): Promise<readonly GitHubAssignee[]> {
  const url = `${issueUrl(target, issueNumber)}/assignees`;
  const body = { assignees: checkedLogins(logins, verb) } satisfies AddAssigneesBody & RemoveAssigneesBody;
  const response = await http.request(githubRequest(target, METHOD_OF[verb], url, "retry-once", body));
  const answer = response.body;
  if (!isJsonObject(answer)) {
    throw new GitHubSchemaError(
      `GitHub ${verb} assignees answer for issue #${String(issueNumber)} must be a JSON object, got ${jsonKind(answer)}`,
    );
  }
  return parseAssignees(answer["assignees"], `GitHub issue #${String(issueNumber)}`);
}

/** A new array of `logins`, or RangeError naming a count or a position, never a login. */
function checkedLogins(logins: readonly string[], verb: WriteVerb): string[] {
  if (logins.length === 0 || logins.length > MAX_ASSIGNEES_PER_ISSUE) {
    throw new RangeError(
      `GitHub ${verb} assignees needs 1 to ${String(MAX_ASSIGNEES_PER_ISSUE)} logins, got ${String(logins.length)}`,
    );
  }
  const empty = logins.indexOf("");
  if (empty >= 0) {
    throw new RangeError(`GitHub ${verb} assignees: login ${String(empty + 1)} is empty`);
  }
  return [...logins];
}

function parseAssignablePage(body: JsonValue): readonly GitHubAssignee[] {
  if (!isJsonArray(body)) {
    throw new GitHubSchemaError(`GitHub assignees page must be a JSON array, got ${jsonKind(body)}`);
  }
  return body.flatMap(toAssignee);
}

/** [assignee] for an object with a string login, else [] (flatMap filter). */
function toAssignee(item: JsonValue): GitHubAssignee[] {
  if (!isJsonObject(item)) {
    return [];
  }
  const login = item["login"];
  const type = item["type"];
  return isString(login) ? [{ login, type: isString(type) ? type : "" }] : [];
}
