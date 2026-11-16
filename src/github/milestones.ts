/**
 * GitHub milestones (the mirrors of YouTrack epics, H1/H7): the typed milestone shape, the
 * paged list read, create, update and close. A milestone's title (N2) and description (N4)
 * follow its epic; it is never reopened (D7). Types derive from @octokit/openapi-types.
 * Writes are never called in DRY_RUN; sync.ts enforces that.
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

/** The subset of a GitHub milestone this tool reads; `description` verbatim, or null when GitHub reports none. */
export type GitHubMilestone = Readonly<Pick<MilestoneSchema, "number" | "title" | "state">> & {
  readonly description: string | null;
};

/** What createMilestone sends: exactly these two fields (no due date, H1). */
export type NewMilestone = Readonly<Pick<CreateMilestoneBody, "title">> & { readonly description: string };

/** What updateMilestone changes: the title (N2) and/or the description (N4); a key left out is not sent. */
export type MilestoneUpdate = { readonly title?: string; readonly description?: string };

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
  const description = value["description"] ?? null;
  if (description !== null && !isString(description)) {
    throw new GitHubSchemaError(`${prefix} "description" must be a string or null, got ${describeJson(description)}`);
  }
  return { number: milestoneNumber, title, state, description };
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
 * PATCH /repos/{owner}/{repo}/milestones/{n} with the title and/or description of `patch` and
 * nothing else (never a state, so a closed milestone stays closed). retry-once (idempotent).
 * Returns the milestone from the response, whose title and description show whether GitHub
 * applied the change; throws GitHubSchemaError for a response that is not a milestone. Throws
 * RangeError before any request unless n is a positive safe integer, or for a patch with
 * neither key.
 */
export async function updateMilestone(
  http: HttpClient,
  target: GitHubTarget,
  milestoneNumber: number,
  patch: MilestoneUpdate,
): Promise<GitHubMilestone> {
  const { title, description } = patch;
  if (title === undefined && description === undefined) {
    throw new RangeError("GitHub milestone update needs a title or description to change");
  }
  const body = {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  } satisfies UpdateMilestoneBody;
  const url = milestoneUrl(target, milestoneNumber);
  const response = await http.request(githubRequest(target, "PATCH", url, "retry-once", body));
  return parseGitHubMilestone(response.body);
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
