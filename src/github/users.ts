/**
 * GitHub account lookups by email (steps c and d of the matching chain, docs/13 2.4): the
 * commit author of an email and the public-email user search. Both send an email to GitHub
 * in the query string, built with URLSearchParams; no error message here quotes an email or a
 * login (U8), shapes are named by kind only (jsonKind). Read-only; stage 2 decides what a
 * failure means (docs/13 2.5), so HttpErrors propagate unchanged.
 */

import type { HttpClient } from "../http.ts";
import { isJsonArray, isJsonObject, isString } from "../json.ts";
import type { JsonObject, JsonValue } from "../json.ts";
import { GITHUB_API_BASE, GITHUB_PAGE_SIZE, GitHubSchemaError, githubRequest, jsonKind, repoUrl } from "./client.ts";
import type { GitHubTarget } from "./client.ts";

/** The account type whose logins count; Organization, Bot and the like never do. */
const USER_TYPE = "User";
/** One commit is enough: its top-level author is the account linked to the email. */
const COMMITS_PER_LOOKUP = 1;

/**
 * GET /repos/{owner}/{repo}/commits?author=<email>&per_page=1, retry-once. GitHub filters by
 * the git author email (ignoring case, live) from the default branch. Returns the first
 * commit's top-level `author.login` when that author is a User, else null: no commit, an email
 * linked to no account (`author: null`), or a Bot. Throws RangeError before any request for an
 * email without exactly one "@", GitHubSchemaError for a wrong shape, HttpError (403 without
 * Contents read, 409 for an empty repo, ...) as the client throws it.
 */
export async function findCommitAuthor(http: HttpClient, target: GitHubTarget, email: string): Promise<string | null> {
  checkEmail(email, "commit lookup");
  const query = new URLSearchParams({ author: email, per_page: String(COMMITS_PER_LOOKUP) });
  const url = `${repoUrl(target)}/commits?${query.toString()}`;
  const response = await http.request(githubRequest(target, "GET", url, "retry-once"));
  return parseCommitAuthor(response.body);
}

/**
 * GET /search/users?q="<email>" in:email type:user&per_page=100, retry-once (the search rate
 * limit applies). Only the token of `target` is used. Returns the logins of the items of type
 * User, verbatim and in order; [] when nobody shows that email publicly. Throws RangeError
 * before any request for an email without exactly one "@", GitHubSchemaError for a wrong
 * shape, HttpError as the client throws it.
 */
export async function searchUsersByEmail(
  http: HttpClient,
  target: GitHubTarget,
  email: string,
): Promise<readonly string[]> {
  checkEmail(email, "user search");
  const query = new URLSearchParams({ q: `"${email}" in:email type:user`, per_page: String(GITHUB_PAGE_SIZE) });
  const url = `${GITHUB_API_BASE}/search/users?${query.toString()}`;
  const response = await http.request(githubRequest(target, "GET", url, "retry-once"));
  return parseSearchLogins(response.body);
}

// ---------------------------------------------------------------------------
// Internals

type LookupName = "commit lookup" | "user search";

/** RangeError unless `email` has exactly one "@"; the message never holds the email. */
function checkEmail(email: string, name: LookupName): void {
  if (email.split("@").length !== 2) {
    throw new RangeError(`GitHub ${name} needs an email with exactly one "@"`);
  }
}

function lookupError(name: LookupName, detail: string): GitHubSchemaError {
  return new GitHubSchemaError(`GitHub ${name}: ${detail}`);
}

function parseCommitAuthor(body: JsonValue): string | null {
  if (!isJsonArray(body)) {
    throw lookupError("commit lookup", `the commits page must be a JSON array, got ${jsonKind(body)}`);
  }
  const [commit] = body;
  if (commit === undefined) {
    return null;
  }
  if (!isJsonObject(commit)) {
    throw lookupError("commit lookup", `commit 1 must be a JSON object, got ${jsonKind(commit)}`);
  }
  const author = commit["author"];
  if (author === undefined || author === null) {
    return null;
  }
  if (!isJsonObject(author)) {
    throw lookupError("commit lookup", `commit 1 "author" must be an object or null, got ${jsonKind(author)}`);
  }
  return author["type"] === USER_TYPE ? userLogin(author, "commit lookup", `commit 1 "author.login"`) : null;
}

function parseSearchLogins(body: JsonValue): readonly string[] {
  if (!isJsonObject(body)) {
    throw lookupError("user search", `the answer must be a JSON object, got ${jsonKind(body)}`);
  }
  const items = body["items"];
  if (!isJsonArray(items)) {
    throw lookupError("user search", `"items" must be an array, got ${jsonKind(items)}`);
  }
  return items.flatMap((item, index) => {
    const position = `item ${String(index + 1)}`;
    if (!isJsonObject(item)) {
      throw lookupError("user search", `${position} must be a JSON object, got ${jsonKind(item)}`);
    }
    return item["type"] === USER_TYPE ? [userLogin(item, "user search", `${position} "login"`)] : [];
  });
}

/** The non-empty string `login` of a User object, or GitHubSchemaError naming `what` and the kind. */
function userLogin(user: JsonObject, name: LookupName, what: string): string {
  const login = user["login"];
  if (isString(login) && login !== "") {
    return login;
  }
  throw lookupError(name, `${what} must be a non-empty string, got ${jsonKind(login)}`);
}
