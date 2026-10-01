/**
 * GitHub milestones (the mirrors of YouTrack epics, H1/H7): the typed milestone shape, the
 * paged list read, create, rename and close. A milestone's title follows its epic (N2); it
 * is never re-described or reopened (D7). Types derive from @octokit/openapi-types. Writes
 * are never called in DRY_RUN; sync.ts enforces that.
 */

import type { components, operations } from "@octokit/openapi-types";
import type { HttpClient } from "../http.ts";
import { isInteger, isJsonArray, isJsonObject, isString } from "../json.ts";
import type { JsonValue } from "../json.ts";
import {
  describeJson,
  GITHUB_PAGE_SIZE,
  GitHubSchemaError,
  githubRequest,
  milestonesUrl,
  milestoneUrl,
} from "./client.ts";
import type { GitHubTarget } from "./client.ts";
import { listAllPages } from "./pages.ts";

type MilestoneSchema = components["schemas"]["milestone"];
type CreateMilestoneBody = operations["issues/create-milestone"]["requestBody"]["content"]["application/json"];
type UpdateMilestoneBody = NonNullable<
  operations["issues/update-milestone"]["requestBody"]
>["content"]["application/json"];

/** The subset of a GitHub milestone this tool reads. */
export type GitHubMilestone = Readonly<Pick<MilestoneSchema, "number" | "title" | "state">>;

/** What createMilestone sends: exactly these two fields (no due date, H1). */
export type NewMilestone = Readonly<Pick<CreateMilestoneBody, "title">> & { readonly description: string };

/** The only status that proves POST /milestones created a new milestone. */
const HTTP_CREATED = 201;

/** Validates one milestone object from the list or create response into a new object. */
export function parseGitHubMilestone(value: JsonValue): GitHubMilestone {
  if (!isJsonObject(value)) {
    throw new GitHubSchemaError(`GitHub milestone must be a JSON object, got ${describeJson(value)}`);
  }
  const milestoneNumber = value["number"];
  if (!isInteger(milestoneNumber) || milestoneNumber <= 0) {
    throw new GitHubSchemaError(
      `GitHub milestone "number" must be a positive integer, got ${describeJson(milestoneNumber)}`,
    );
  }
  const prefix = `GitHub milestone #${String(milestoneNumber)}:`;
  const title = value["title"];
  if (!isString(title)) {
    throw new GitHubSchemaError(`${prefix} "title" must be a string`);
  }
  const state = value["state"];
  if (state !== "open" && state !== "closed") {
    throw new GitHubSchemaError(`${prefix} "state" must be "open" or "closed", got ${describeJson(state)}`);
  }
  return { number: milestoneNumber, title, state };
}

/**
 * GET /repos/{owner}/{repo}/milestones?state=all&per_page=100, following Link rel="next"
 * verbatim. retry: "retry-once". Throws GitHubSchemaError for a page that is not an array
 * of milestones, a Link header nextPageUrl rejects, or a page fetched twice.
 */
export async function listAllMilestones(http: HttpClient, target: GitHubTarget): Promise<readonly GitHubMilestone[]> {
  const firstUrl = `${milestonesUrl(target)}?state=all&per_page=${String(GITHUB_PAGE_SIZE)}`;
  return await listAllPages(http, target, firstUrl, parseMilestonePage);
}

/**
 * POST /repos/{owner}/{repo}/milestones with {title, description} and nothing else.
 * retry: "no-retry" (not idempotent). Returns the created milestone; throws
 * GitHubSchemaError unless GitHub answered 201 with a valid milestone body.
 */
export async function createMilestone(
  http: HttpClient,
  target: GitHubTarget,
  milestone: NewMilestone,
): Promise<GitHubMilestone> {
  const body = { title: milestone.title, description: milestone.description } satisfies CreateMilestoneBody;
  const response = await http.request(githubRequest(target, "POST", milestonesUrl(target), "no-retry", body));
  if (response.status !== HTTP_CREATED) {
    throw new GitHubSchemaError(
      `GitHub create milestone must answer HTTP 201, got HTTP ${String(response.status)} (the milestone may still exist)`,
    );
  }
  return parseGitHubMilestone(response.body);
}

/**
 * PATCH /repos/{owner}/{repo}/milestones/{n} with {title} and nothing else. retry-once
 * (idempotent). Throws RangeError before any request unless n is a positive safe integer.
 */
export async function renameMilestone(
  http: HttpClient,
  target: GitHubTarget,
  milestoneNumber: number,
  title: string,
): Promise<void> {
  const body = { title } satisfies UpdateMilestoneBody;
  await http.request(githubRequest(target, "PATCH", milestoneUrl(target, milestoneNumber), "retry-once", body));
}

/**
 * PATCH /repos/{owner}/{repo}/milestones/{n} with {state:"closed"}. retry-once (idempotent).
 * Throws RangeError before any request unless n is a positive safe integer.
 */
export async function closeMilestone(http: HttpClient, target: GitHubTarget, milestoneNumber: number): Promise<void> {
  const body = { state: "closed" } as const satisfies UpdateMilestoneBody;
  await http.request(githubRequest(target, "PATCH", milestoneUrl(target, milestoneNumber), "retry-once", body));
}

function parseMilestonePage(body: JsonValue): readonly GitHubMilestone[] {
  if (!isJsonArray(body)) {
    throw new GitHubSchemaError(`GitHub milestones page must be a JSON array, got ${describeJson(body)}`);
  }
  return body.map((item) => parseGitHubMilestone(item));
}
