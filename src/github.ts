/**
 * GitHub side. Types derive from @octokit/openapi-types (GitHub's official
 * OpenAPI description). Writes are never called in DRY_RUN; sync.ts enforces that.
 */

import type { components, operations } from "@octokit/openapi-types";
import type { HttpClient, HttpMethod, HttpRequest, RetryPolicy } from "./http.ts";
import { isInteger, isJsonArray, isJsonObject, isString } from "./json.ts";
import type { JsonValue } from "./json.ts";

type IssueSchema = components["schemas"]["issue"];
type AddLabelsBody = NonNullable<operations["issues/add-labels"]["requestBody"]>["content"]["application/json"];

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

/** Followed Link targets must use this exact spelling (no case/port/dot/%-encoded variants), so the token stays on GitHub. */
const TRUSTED_LINK_PREFIX = `${GITHUB_API_BASE}/`;

/** Longest prefix (in code points) of an untrusted string quoted in an error message. */
const MAX_ECHOED_CHARS = 40;

/** The only status that proves POST /issues created a new issue (docs/03, gotcha 15). */
const HTTP_CREATED = 201;

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

/** Validates one issue/PR object from the list or create response. */
export function parseGitHubIssue(value: JsonValue): GitHubIssue {
  if (!isJsonObject(value)) {
    throw new GitHubSchemaError(`GitHub issue must be a JSON object, got ${describeJson(value)}`);
  }
  const issueNumber = value["number"];
  if (!isInteger(issueNumber) || issueNumber <= 0) {
    throw new GitHubSchemaError(`GitHub issue "number" must be a positive integer, got ${describeJson(issueNumber)}`);
  }
  const title = value["title"];
  if (!isString(title)) {
    throw new GitHubSchemaError(`GitHub issue #${String(issueNumber)}: "title" must be a string`);
  }
  return {
    number: issueNumber,
    title,
    state: parseIssueState(value["state"], issueNumber),
    labelNames: parseLabelNames(value["labels"], issueNumber),
    isPullRequest: isPresent(value["pull_request"]),
  };
}

/**
 * The URL of the first rel="next" link in a Link header, verbatim; null (last page) only
 * when there is none. listAllIssues calls this for every page. Throws GitHubSchemaError,
 * because stopping would truncate the list, hide existing mirrors and create duplicates:
 * - when the rel="next" URL is not spelled "https://api.github.com/..." or does not parse
 *   to that origin without userinfo (never send our token to another host);
 * - when there is no rel="next" link but the header does not parse as RFC 8288 (e.g. an
 *   unclosed quote or <URL>, which can swallow the next entry).
 * Error messages quote at most 40 characters, with anything that could be userinfo hidden.
 */
export function nextPageUrl(linkHeader: string | null): string | null {
  if (linkHeader === null) {
    return null;
  }
  const { links, isWellFormed } = parseLinkHeader(linkHeader);
  const next = links.find((link) => link.rels.includes("next"));
  if (next === undefined) {
    if (!isWellFormed) {
      throw new GitHubSchemaError(`GitHub Link header does not parse and has no rel="next": ${quoteLink(linkHeader)}`);
    }
    return null;
  }
  if (!isTrustedUrl(next.url)) {
    throw new GitHubSchemaError(`GitHub Link rel="next" points outside ${TRUSTED_LINK_PREFIX}: ${quoteLink(next.url)}`);
  }
  return next.url;
}

/**
 * GET /repos/{owner}/{repo}/issues?state=all&per_page=100 (no label filter, per
 * decision A5), following Link rel="next" verbatim. Includes PRs (flagged).
 * retry: "retry-once". Throws GitHubSchemaError for a page that is not an array of
 * issues, a Link header nextPageUrl rejects, or a page fetched twice.
 */
export async function listAllIssues(
  http: HttpClient,
  target: GitHubTarget,
): Promise<readonly GitHubIssue[]> {
  const pages: (readonly GitHubIssue[])[] = [];
  const visited = new Set<string>();
  let url: string | null = `${issuesUrl(target)}?state=all&per_page=${String(GITHUB_PAGE_SIZE)}`;
  while (url !== null) {
    if (visited.has(url)) {
      throw new GitHubSchemaError(`GitHub Link rel="next" loops back to an already fetched page: ${url}`);
    }
    visited.add(url);
    const response = await http.request(githubRequest(target, "GET", url, "retry-once"));
    pages.push(parseIssuePage(response.body));
    url = nextPageUrl(response.headers.get("link"));
  }
  // flat(), not push(...page): spreading a huge page as arguments overflows the stack.
  return pages.flat();
}

/**
 * POST /repos/{owner}/{repo}/issues. retry: "no-retry" (not idempotent). Returns the created
 * issue; throws GitHubSchemaError unless GitHub answered 201 with a valid issue body.
 */
export async function createIssue(
  http: HttpClient,
  target: GitHubTarget,
  body: CreateIssueBody,
): Promise<GitHubIssue> {
  // CreateIssueBody is a plain JSON-shaped type, so it is passed as the body unchanged.
  const response = await http.request(githubRequest(target, "POST", issuesUrl(target), "no-retry", body));
  if (response.status !== HTTP_CREATED) {
    throw new GitHubSchemaError(
      `GitHub create issue must answer HTTP 201, got HTTP ${String(response.status)} (the issue may still exist)`,
    );
  }
  return parseGitHubIssue(response.body);
}

/**
 * PATCH /repos/{owner}/{repo}/issues/{n} with {state:"closed", state_reason:"completed"}. retry-once.
 * Like addLabel, throws RangeError before any request if n is not a positive safe integer.
 */
export async function closeIssue(
  http: HttpClient,
  target: GitHubTarget,
  issueNumber: number,
): Promise<void> {
  const body = { state: "closed", state_reason: "completed" } as const satisfies UpdateIssueBody;
  await http.request(githubRequest(target, "PATCH", issueUrl(target, issueNumber), "retry-once", body));
}

/** POST /repos/{owner}/{repo}/issues/{n}/labels with {labels:[label]}. retry-once (idempotent). */
export async function addLabel(
  http: HttpClient,
  target: GitHubTarget,
  issueNumber: number,
  label: string,
): Promise<void> {
  const url = `${issueUrl(target, issueNumber)}/labels`;
  const body = { labels: [label] } satisfies AddLabelsBody;
  await http.request(githubRequest(target, "POST", url, "retry-once", body));
}

// ---------------------------------------------------------------------------
// URLs and requests

function issuesUrl(target: GitHubTarget): string {
  const owner = pathSegment("owner", target.owner);
  const repo = pathSegment("repo", target.repo);
  return `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues`;
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

function issueUrl(target: GitHubTarget, issueNumber: number): string {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    throw new RangeError(`GitHub issue number must be a positive integer, got ${String(issueNumber)}`);
  }
  return `${issuesUrl(target)}/${String(issueNumber)}`;
}

function githubRequest(
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
// Response parsing

function parseIssuePage(body: JsonValue): readonly GitHubIssue[] {
  if (!isJsonArray(body)) {
    throw new GitHubSchemaError(`GitHub issues page must be a JSON array, got ${describeJson(body)}`);
  }
  return body.map((item) => parseGitHubIssue(item));
}

function parseIssueState(value: JsonValue | undefined, issueNumber: number): IssueState {
  if (value === "open" || value === "closed") {
    return value;
  }
  throw new GitHubSchemaError(
    `GitHub issue #${String(issueNumber)}: "state" must be "open" or "closed", got ${describeJson(value)}`,
  );
}

/** Label items are strings or objects with a string `name`; anything else is ignored. */
function parseLabelNames(value: JsonValue | undefined, issueNumber: number): readonly string[] {
  if (!isJsonArray(value)) {
    throw new GitHubSchemaError(`GitHub issue #${String(issueNumber)}: "labels" must be an array`);
  }
  return value.flatMap((label) => {
    if (isString(label)) {
      return [label];
    }
    const name = isJsonObject(label) ? label["name"] : undefined;
    return isString(name) ? [name] : [];
  });
}

/** The key exists with a non-null value (JSON has no `undefined`, so a missing key reads as undefined). */
function isPresent(value: JsonValue | undefined): boolean {
  return value !== undefined && value !== null;
}

/** Short description of a JSON value for error messages; never echoes a whole string or object. */
function describeJson(value: JsonValue | undefined): string {
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
function quote(text: string): string {
  // MAX_ECHOED_CHARS code points span at most twice as many UTF-16 units; slicing first keeps this cheap.
  const prefix = Array.from(text.slice(0, MAX_ECHOED_CHARS * 2)).slice(0, MAX_ECHOED_CHARS).join("");
  return JSON.stringify(prefix);
}

// ---------------------------------------------------------------------------
// RFC 8288 Link header

type LinkValue = { readonly url: string; readonly rels: readonly string[] };
type ParsedLinkHeader = { readonly links: readonly LinkValue[]; readonly isWellFormed: boolean };
type ParsedLinkEntry = { readonly link: LinkValue | null; readonly isWellFormed: boolean };

/** RFC 8288 link-param: token BWS [ "=" BWS ( token / quoted-string ) ], with optional whitespace around it. */
const LINK_PARAM_PATTERN =
  /^[ \t]*[!#$%&'*+.^_`|~0-9A-Za-z-]+[ \t]*(?:=[ \t]*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"(?:[^"\\]|\\.)*"))?[ \t]*$/s;

/** Needs the exact prefix, and fetch()'s WHATWG parse must then give exactly the API origin with no userinfo. */
function isTrustedUrl(url: string): boolean {
  const parsed = url.startsWith(TRUSTED_LINK_PREFIX) ? URL.parse(url) : null;
  return parsed?.origin === GITHUB_API_BASE && parsed.username === "" && parsed.password === "";
}

/** quote() of Link text with anything that could be userinfo replaced first, so a cut cannot leave half a secret. */
function quoteLink(text: string): string {
  return quote(hideUserinfo(text));
}

/**
 * Replaces everything before the last "@" of each run between "/", "?" and "#" with "***"
 * (userinfo ends at the last "@" of the authority). Over-hides rather than under-hides. Linear time.
 */
function hideUserinfo(text: string): string {
  return text
    .split(/([/?#])/)
    .map((part) => {
      const at = part.lastIndexOf("@");
      return at < 0 ? part : `***${part.slice(at)}`;
    })
    .join("");
}

/** All entries that start with <URL>, and whether every non-empty entry is well-formed RFC 8288. */
function parseLinkHeader(linkHeader: string): ParsedLinkHeader {
  const entries = splitLinkHeader(linkHeader, ",")
    .filter((entry) => !isBlank(entry))
    .map(parseLinkEntry);
  return {
    links: entries.flatMap((entry) => (entry.link === null ? [] : [entry.link])),
    isWellFormed: entries.every((entry) => entry.isWellFormed),
  };
}

function isBlank(text: string): boolean {
  return /^[ \t]*$/.test(text);
}

/**
 * Where the splitter is inside one part: "start" (only whitespace so far), "plain",
 * "value" (right after "=" and optional whitespace), "url" (<...>), "quoted" ("..."),
 * "escaped" (after a backslash inside quotes).
 */
type SplitState = "start" | "plain" | "value" | "url" | "quoted" | "escaped";

/**
 * Splits on `separator` outside <URL> and quoted values, so commas and semicolons in
 * them are kept. As in RFC 8288, "<" opens a URL only at the start of a part and '"'
 * opens a quoted string only right after "=". Elsewhere they are plain characters, so
 * one malformed entry cannot swallow the entries after it. Linear time.
 */
function splitLinkHeader(text: string, separator: "," | ";"): readonly string[] {
  const parts: string[] = [];
  let current = "";
  let state: SplitState = "start";
  for (const char of text) {
    if (char === separator && (state === "start" || state === "plain" || state === "value")) {
      parts.push(current);
      current = "";
      state = "start";
    } else {
      current += char;
      state = nextSplitState(state, char);
    }
  }
  parts.push(current);
  return parts;
}

function nextSplitState(state: SplitState, char: string): SplitState {
  switch (state) {
    case "url":
      return char === ">" ? "plain" : "url";
    case "quoted":
      if (char === "\\") {
        return "escaped";
      }
      return char === '"' ? "plain" : "quoted";
    case "escaped":
      return "quoted";
    case "start":
      return char === "<" ? "url" : unquotedState(state, char);
    case "value":
      return char === '"' ? "quoted" : unquotedState(state, char);
    case "plain":
      return unquotedState(state, char);
  }
}

/** Outside <...> and "...": "=" starts a value, whitespace keeps start/value, anything else is plain. */
function unquotedState(state: "start" | "value" | "plain", char: string): SplitState {
  if (char === "=") {
    return "value";
  }
  const isWhitespace = char === " " || char === "\t";
  return isWhitespace && state !== "plain" ? state : "plain";
}

/**
 * `<url>; rel="next last"; foo=bar` -> { url, rels: ["next", "last"] }; link is null when the
 * entry does not start with <URL>. Well-formed: nothing but whitespace between ">" and the
 * first ";", and every param empty or matching LINK_PARAM_PATTERN.
 */
function parseLinkEntry(text: string): ParsedLinkEntry {
  const match = /^[ \t]*<([^>]*)>(.*)$/s.exec(text);
  if (match === null) {
    return { link: null, isWellFormed: false };
  }
  const [, url = "", rest = ""] = match;
  const [head = "", ...params] = splitLinkHeader(rest, ";");
  return {
    link: { url: url.trim(), rels: parseRelTypes([head, ...params]) },
    isWellFormed: isBlank(head) && params.every((param) => isBlank(param) || LINK_PARAM_PATTERN.test(param)),
  };
}

/**
 * Relation types of the first `rel` param, lowercased. RFC 8288: later ones are
 * ignored, even when the first has no value (`rel; rel="next"` has no relation types).
 */
function parseRelTypes(params: readonly string[]): readonly string[] {
  for (const param of params) {
    const equals = param.indexOf("=");
    const name = equals >= 0 ? param.slice(0, equals) : param;
    if (name.trim().toLowerCase() === "rel") {
      const relValue = equals >= 0 ? unquote(param.slice(equals + 1).trim()) : "";
      return relValue.toLowerCase().split(/\s+/).filter((rel) => rel !== "");
    }
  }
  return [];
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/gs, "$1");
  }
  return value;
}
