/**
 * GitHub issues: the typed issue shape (including the hierarchy fields of docs/11: id,
 * milestone, type and parent), the paged list read and the issue writes. Types derive
 * from @octokit/openapi-types (GitHub's official OpenAPI description). Writes are never
 * called in DRY_RUN; sync.ts enforces that.
 */

import type { components, operations } from "@octokit/openapi-types";
import type { GitHubTypeName } from "../hierarchy.ts";
import type { HttpClient } from "../http.ts";
import { isInteger, isJsonArray, isJsonObject, isString } from "../json.ts";
import type { JsonValue } from "../json.ts";
import {
  describeJson,
  GITHUB_API_BASE,
  GITHUB_PAGE_SIZE,
  GitHubSchemaError,
  githubRequest,
  issuesUrl,
  issueUrl,
  positiveInteger,
  quote,
  repoUrl,
} from "./client.ts";
import type { GitHubTarget } from "./client.ts";
import { listAllPages } from "./pages.ts";

type IssueSchema = components["schemas"]["issue"];
type MilestoneSchema = components["schemas"]["milestone"];
type IssueTypeSchema = NonNullable<components["schemas"]["issue-type"]>;
type AddLabelsBody = NonNullable<operations["issues/add-labels"]["requestBody"]>["content"]["application/json"];
type OctokitCreateIssueBody = operations["issues/create"]["requestBody"]["content"]["application/json"];

/**
 * Request body of POST /repos/{owner}/{repo}/issues. GitHub also accepts `parent_issue_id`
 * (the parent's `id`, not its number), which @octokit/openapi-types 29 does not list.
 */
export type CreateIssueBody = OctokitCreateIssueBody & { readonly parent_issue_id?: number };
/** Request body of PATCH /repos/{owner}/{repo}/issues/{n}. */
export type UpdateIssueBody = NonNullable<operations["issues/update"]["requestBody"]>["content"]["application/json"];

/** What updateIssue changes: the milestone by number (null clears it) and the issue type by name. */
export type IssueUpdate = {
  readonly milestone?: number | null;
  readonly type?: GitHubTypeName;
};

/** The two issue states GitHub reports. */
export type IssueState = "open" | "closed";

/** The subset of a GitHub issue this tool reads. */
export type GitHubIssue = Readonly<Pick<IssueSchema, "number" | "title">> & {
  /** The REST `id` (not the number): what parent_issue_id and sub_issue_id take. */
  readonly id: number;
  readonly state: IssueState;
  readonly labelNames: readonly string[];
  /** Items from /issues that are really pull requests (have a `pull_request` key). */
  readonly isPullRequest: boolean;
  /** `milestone.number`, or null without a milestone. */
  readonly milestoneNumber: MilestoneSchema["number"] | null;
  /** `type.name` verbatim, or null without an issue type. */
  readonly typeName: IssueTypeSchema["name"] | null;
  /** The parent's issue number when parent_issue_url is an issue of the target repository, else null. */
  readonly parentNumber: number | null;
  /** parent_issue_url is set but outside the target repository (parentNumber is then null). */
  readonly parentIsForeign: boolean;
};

/** The only status that proves POST /issues created a new issue (docs/03, gotcha 15). */
const HTTP_CREATED = 201;

type ParentLink = Pick<GitHubIssue, "parentNumber" | "parentIsForeign">;
const NO_PARENT: ParentLink = { parentNumber: null, parentIsForeign: false };
const FOREIGN_PARENT: ParentLink = { parentNumber: null, parentIsForeign: true };
/** The start of every repoUrl(); a parent_issue_url without it is foreign (e.g. /repositories/{id}/). */
const REPOS_PREFIX = `${GITHUB_API_BASE}/repos/`;
/** What must follow this repository's URL in a parent_issue_url, as GitHub spells issue numbers. */
const ISSUE_PATH = /^issues\/([1-9][0-9]*)$/;

/**
 * Validates one issue/PR object from a list, create or update response into a new object.
 * A missing or null milestone, type or parent_issue_url reads as none; any other wrong
 * shape throws GitHubSchemaError. `target` tells this repository's parent URLs from
 * foreign ones (see parseParent); a target repoUrl refuses throws RangeError.
 */
export function parseGitHubIssue(value: JsonValue, target: GitHubTarget): GitHubIssue {
  if (!isJsonObject(value)) {
    throw new GitHubSchemaError(`GitHub issue must be a JSON object, got ${describeJson(value)}`);
  }
  const issueNumber = value["number"];
  if (!isInteger(issueNumber) || issueNumber <= 0) {
    throw new GitHubSchemaError(`GitHub issue "number" must be a positive integer, got ${describeJson(issueNumber)}`);
  }
  const title = value["title"];
  if (!isString(title)) {
    throw issueError(issueNumber, `"title" must be a string`);
  }
  return {
    number: issueNumber,
    id: parseIssueId(value["id"], issueNumber),
    title,
    state: parseIssueState(value["state"], issueNumber),
    labelNames: parseLabelNames(value["labels"], issueNumber),
    isPullRequest: isPresent(value["pull_request"]),
    milestoneNumber: parseMilestoneNumber(value["milestone"], issueNumber),
    typeName: parseTypeName(value["type"], issueNumber),
    ...parseParent(value["parent_issue_url"], target, issueNumber),
  };
}

/**
 * GET /repos/{owner}/{repo}/issues?state=all&per_page=100 (no label filter, per
 * decision A5), following Link rel="next" verbatim. Includes PRs (flagged).
 * retry: "retry-once". Throws GitHubSchemaError for a page that is not an array of
 * issues, a Link header nextPageUrl rejects, or a page fetched twice.
 */
export async function listAllIssues(http: HttpClient, target: GitHubTarget): Promise<readonly GitHubIssue[]> {
  const firstUrl = `${issuesUrl(target)}?state=all&per_page=${String(GITHUB_PAGE_SIZE)}`;
  return await listAllPages(http, target, firstUrl, (body) => parseIssuePage(body, target));
}

/**
 * POST /repos/{owner}/{repo}/issues. retry: "no-retry" (not idempotent). Returns the created
 * issue; throws GitHubSchemaError unless GitHub answered 201 with a valid issue body. Throws
 * RangeError before any request for a numeric milestone or a parent_issue_id that is not a
 * positive safe integer (JSON would send NaN as null, silently creating the issue without it).
 */
export async function createIssue(http: HttpClient, target: GitHubTarget, body: CreateIssueBody): Promise<GitHubIssue> {
  if (typeof body.milestone === "number") {
    positiveInteger("GitHub milestone number", body.milestone);
  }
  if (body.parent_issue_id !== undefined) {
    positiveInteger("GitHub parent issue id", body.parent_issue_id);
  }
  // CreateIssueBody is a plain JSON-shaped type, so it is passed as the body unchanged.
  const response = await http.request(githubRequest(target, "POST", issuesUrl(target), "no-retry", body));
  if (response.status !== HTTP_CREATED) {
    throw new GitHubSchemaError(
      `GitHub create issue must answer HTTP 201, got HTTP ${String(response.status)} (the issue may still exist)`,
    );
  }
  return parseGitHubIssue(response.body, target);
}

/**
 * PATCH /repos/{owner}/{repo}/issues/{n} with the milestone and/or type of `patch`; a key
 * left out is not sent. retry-once (idempotent). Returns the issue from the response, whose
 * milestoneNumber and typeName show whether GitHub applied the change (it drops both
 * silently without push access). Throws RangeError before any request for a bad issue or
 * milestone number, or for a patch with neither key.
 */
export async function updateIssue(
  http: HttpClient,
  target: GitHubTarget,
  issueNumber: number,
  patch: IssueUpdate,
): Promise<GitHubIssue> {
  const url = issueUrl(target, issueNumber);
  const response = await http.request(githubRequest(target, "PATCH", url, "retry-once", updateBody(patch)));
  return parseGitHubIssue(response.body, target);
}

/**
 * PATCH /repos/{owner}/{repo}/issues/{n} with {state:"closed", state_reason:"completed"}. retry-once.
 * Like addLabel, throws RangeError before any request if n is not a positive safe integer.
 */
export async function closeIssue(http: HttpClient, target: GitHubTarget, issueNumber: number): Promise<void> {
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
// Request bodies

/** A new body with only the keys `patch` sets. */
function updateBody(patch: IssueUpdate): IssueUpdate {
  const { milestone, type } = patch;
  if (milestone === undefined && type === undefined) {
    throw new RangeError("GitHub issue update needs a milestone or type to change");
  }
  if (milestone !== undefined && milestone !== null) {
    positiveInteger("GitHub milestone number", milestone);
  }
  return {
    ...(milestone === undefined ? {} : { milestone }),
    ...(type === undefined ? {} : { type }),
  } satisfies UpdateIssueBody;
}

// ---------------------------------------------------------------------------
// Response parsing

function issueError(issueNumber: number, detail: string): GitHubSchemaError {
  return new GitHubSchemaError(`GitHub issue #${String(issueNumber)}: ${detail}`);
}

function parseIssuePage(body: JsonValue, target: GitHubTarget): readonly GitHubIssue[] {
  if (!isJsonArray(body)) {
    throw new GitHubSchemaError(`GitHub issues page must be a JSON array, got ${describeJson(body)}`);
  }
  return body.map((item) => parseGitHubIssue(item, target));
}

function parseIssueId(value: JsonValue | undefined, issueNumber: number): number {
  if (isInteger(value) && value > 0) {
    return value;
  }
  throw issueError(issueNumber, `"id" must be a positive integer, got ${describeJson(value)}`);
}

function parseIssueState(value: JsonValue | undefined, issueNumber: number): IssueState {
  if (value === "open" || value === "closed") {
    return value;
  }
  throw issueError(issueNumber, `"state" must be "open" or "closed", got ${describeJson(value)}`);
}

/** Label items are strings or objects with a string `name`; anything else is ignored. */
function parseLabelNames(value: JsonValue | undefined, issueNumber: number): readonly string[] {
  if (!isJsonArray(value)) {
    throw issueError(issueNumber, `"labels" must be an array`);
  }
  return value.flatMap((label) => {
    if (isString(label)) {
      return [label];
    }
    const name = isJsonObject(label) ? label["name"] : undefined;
    return isString(name) ? [name] : [];
  });
}

/** Missing or null: no milestone. Otherwise an object whose `number` is a positive integer. */
function parseMilestoneNumber(value: JsonValue | undefined, issueNumber: number): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isJsonObject(value)) {
    throw issueError(issueNumber, `"milestone" must be an object or null, got ${describeJson(value)}`);
  }
  const milestoneNumber = value["number"];
  if (isInteger(milestoneNumber) && milestoneNumber > 0) {
    return milestoneNumber;
  }
  throw issueError(issueNumber, `"milestone.number" must be a positive integer, got ${describeJson(milestoneNumber)}`);
}

/** Missing or null: no type. Otherwise an object with a string `name`, kept verbatim. */
function parseTypeName(value: JsonValue | undefined, issueNumber: number): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isJsonObject(value)) {
    throw issueError(issueNumber, `"type" must be an object or null, got ${describeJson(value)}`);
  }
  const name = value["name"];
  if (isString(name)) {
    return name;
  }
  throw issueError(issueNumber, `"type.name" must be a string, got ${describeJson(name)}`);
}

/**
 * parent_issue_url -> parent. Missing or null: no parent. A string is this repository's when
 * it is "https://api.github.com/repos/{owner}/{repo}/..." with owner and repo equal to the
 * target's (percent-encoded like repoUrl, ASCII letters compared case-insensitively, as
 * GitHub names are); what follows must then be "issues/{n}" with n a positive safe integer,
 * or GitHubSchemaError. Any other string, including another repository of the same owner
 * or a /repositories/{id}/ URL, is a foreign parent.
 */
function parseParent(value: JsonValue | undefined, target: GitHubTarget, issueNumber: number): ParentLink {
  const ownRepo = asciiLowerCase(repoUrl(target));
  if (value === undefined || value === null) {
    return NO_PARENT;
  }
  if (!isString(value)) {
    throw issueError(issueNumber, `"parent_issue_url" must be a string or null, got ${describeJson(value)}`);
  }
  if (!value.startsWith(REPOS_PREFIX)) {
    return FOREIGN_PARENT;
  }
  const [owner = "", repo = "", ...rest] = value.slice(REPOS_PREFIX.length).split("/");
  if (asciiLowerCase(`${REPOS_PREFIX}${owner}/${repo}`) !== ownRepo) {
    return FOREIGN_PARENT;
  }
  const path = rest.join("/");
  const parentNumber = Number(ISSUE_PATH.exec(path)?.[1]);
  if (!Number.isSafeInteger(parentNumber)) {
    throw issueError(issueNumber, `"parent_issue_url" is in this repository but is not an issue URL: ${quote(path)}`);
  }
  return { parentNumber, parentIsForeign: false };
}

/** Lowercases A-Z only: toLowerCase() also maps e.g. the Kelvin sign U+212A to "k". */
function asciiLowerCase(text: string): string {
  return text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

/** The key exists with a non-null value (JSON has no `undefined`, so a missing key reads as undefined). */
function isPresent(value: JsonValue | undefined): boolean {
  return value !== undefined && value !== null;
}
