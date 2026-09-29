/**
 * Shared GitHub REST plumbing: the target repo, API constants, headers, URL builders, the
 * request builder and the helpers that keep untrusted text short in error messages.
 * No I/O here; the modules next to it send the requests.
 */

import type { HttpMethod, HttpRequest, RetryPolicy } from "../http.ts";
import { isJsonArray, isJsonObject, isString } from "../json.ts";
import type { JsonValue } from "../json.ts";

/** The repository the mirror writes to, and the token used for every call. */
export type GitHubTarget = {
  readonly owner: string;
  readonly repo: string;
  readonly token: string;
};

/** Origin of every GitHub API call, and the only origin a followed Link may point to. */
export const GITHUB_API_BASE = "https://api.github.com";
/** Pinned X-GitHub-Api-Version. */
export const GITHUB_API_VERSION = "2026-03-10";
/** per_page for list calls (GitHub's maximum). */
export const GITHUB_PAGE_SIZE = 100;
/** Label every mirror carries. */
export const MIRROR_LABEL = "youtrack";

/** A GitHub response this tool cannot rely on: wrong JSON shape, status or Link header. */
export class GitHubSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubSchemaError";
  }
}

/** Longest prefix (in code points) of an untrusted string quoted in an error message. */
const MAX_ECHOED_CHARS = 40;

/**
 * Headers for every GitHub call: Accept: application/vnd.github+json,
 * Authorization: Bearer <token>, X-GitHub-Api-Version.
 * (Content-Type for bodies and User-Agent are added by the http client.)
 */
export function githubHeaders(token: string): Readonly<Record<string, string>> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
}

// ---------------------------------------------------------------------------
// URLs and requests

/**
 * https://api.github.com/repos/{owner}/{repo}, each percent-encoded. Throws RangeError for an
 * owner (checked first) or repo of "", "." or "..", which URL parsing would drop or collapse.
 */
export function repoUrl(target: GitHubTarget): string {
  const owner = pathSegment("owner", target.owner);
  const repo = pathSegment("repo", target.repo);
  return `${GITHUB_API_BASE}/repos/${owner}/${repo}`;
}

/** https://api.github.com/repos/{owner}/{repo}/issues. Throws RangeError like repoUrl. */
export function issuesUrl(target: GitHubTarget): string {
  return `${repoUrl(target)}/issues`;
}

/**
 * One percent-encoded path segment. "", "." and ".." are refused: URL parsing drops or
 * collapses dot segments (even as %2E), so "/repos/../../issues" would become GET /issues.
 */
function pathSegment(name: "owner" | "repo", value: string): string {
  if (value === "" || value === "." || value === "..") {
    throw new RangeError(`GitHub ${name} must be a non-empty name other than "." and "..", got ${quote(value)}`);
  }
  return encodeURIComponent(value);
}

/** .../issues/{n}. Throws RangeError, before checking owner and repo, unless n is a positive safe integer. */
export function issueUrl(target: GitHubTarget, issueNumber: number): string {
  const checked = positiveInteger("GitHub issue number", issueNumber);
  return `${issuesUrl(target)}/${String(checked)}`;
}

/** https://api.github.com/repos/{owner}/{repo}/milestones. Throws RangeError like repoUrl. */
export function milestonesUrl(target: GitHubTarget): string {
  return `${repoUrl(target)}/milestones`;
}

/** .../milestones/{n}. Throws RangeError, before checking owner and repo, unless n is a positive safe integer. */
export function milestoneUrl(target: GitHubTarget, milestoneNumber: number): string {
  const checked = positiveInteger("GitHub milestone number", milestoneNumber);
  return `${milestonesUrl(target)}/${String(checked)}`;
}

/**
 * `value` unchanged if it is a positive safe integer; otherwise throws
 * RangeError("<what> must be a positive integer, got <value>"). Guards numbers that go into a
 * URL or a request body, where JSON.stringify would silently turn NaN or Infinity into null.
 */
export function positiveInteger(what: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${what} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

/** An HttpRequest with githubHeaders(target.token); the body key is left out when body is undefined. */
export function githubRequest(
  target: GitHubTarget,
  method: HttpMethod,
  url: string,
  retry: RetryPolicy,
  body?: JsonValue,
): HttpRequest {
  const base = { method, url, headers: githubHeaders(target.token), retry };
  return body === undefined ? base : { ...base, body };
}

// ---------------------------------------------------------------------------
// Error-message helpers

/** Short description of a JSON value for error messages; never echoes a whole string or object. */
export function describeJson(value: JsonValue | undefined): string {
  if (value === undefined) {
    return "nothing";
  }
  if (value === null) {
    return "null";
  }
  if (isJsonArray(value)) {
    return "an array";
  }
  if (isJsonObject(value)) {
    return "an object";
  }
  if (isString(value)) {
    return `string ${quote(value)}`;
  }
  return `${typeof value} ${String(value)}`;
}

/** JSON-quoted start of an untrusted string, cut on a code point boundary (never half an emoji). */
export function quote(text: string): string {
  // MAX_ECHOED_CHARS code points span at most twice as many UTF-16 units; slicing first keeps this cheap.
  const prefix = Array.from(text.slice(0, MAX_ECHOED_CHARS * 2))
    .slice(0, MAX_ECHOED_CHARS)
    .join("");
  return JSON.stringify(prefix);
}
