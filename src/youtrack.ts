/**
 * YouTrack read side. GET /api/issues ONLY -- this module must never issue any
 * other method or endpoint (see CLAUDE.md hard rules).
 *
 * Types come from the instance's OpenAPI spec (src/generated/youtrack.ts, via
 * `npm run gen:youtrack`). The spec marks nothing nullable and every property
 * optional; live responses return `null` for `resolved` (unresolved) and
 * `description` (empty) -- see docs/00-live-verification.md. The derived type
 * below encodes exactly that.
 */

import type { components } from "./generated/youtrack.ts";
import type { HttpClient } from "./http.ts";
import type { JsonValue } from "./json.ts";

type IssueSchema = components["schemas"]["Issue"];

/** The only fields requested. A typo here is a compile error (keyof IssueSchema). */
export const ISSUE_FIELDS = [
  "idReadable",
  "numberInProject",
  "summary",
  "description",
  "resolved",
  "updated",
] as const satisfies readonly (keyof IssueSchema)[];

type RequiredField = "idReadable" | "numberInProject" | "summary" | "updated";
type NullableField = "description" | "resolved";

export type YouTrackIssue = Readonly<
  { [K in RequiredField]-?: NonNullable<IssueSchema[K]> } & {
    [K in NullableField]-?: NonNullable<IssueSchema[K]> | null;
  }
>;

export type YouTrackSource = {
  readonly baseUrl: string;
  readonly token: string;
  readonly project: string;
};

export const YOUTRACK_PAGE_SIZE = 100;

/** A row that does not match YouTrackIssue. The run must fail rather than guess. */
export class YouTrackSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YouTrackSchemaError";
  }
}

/** `fields=` parameter value built from ISSUE_FIELDS. */
export function issueFieldsParam(): string {
  throw new Error("not implemented");
}

/** `project: <project> sort by: {issue id} asc` (stable under concurrent edits). */
export function projectQuery(project: string): string {
  void project;
  throw new Error("not implemented");
}

/**
 * Validates one row. Requires every ISSUE_FIELDS key to be present (a silently
 * dropped field must fail loudly), types exact, `resolved`/`description` may be null.
 * Returns a new object with exactly the YouTrackIssue keys (no `$type`).
 */
export function parseYouTrackIssue(row: JsonValue): YouTrackIssue {
  void row;
  throw new Error("not implemented");
}

/**
 * Full project scan: GET {baseUrl}/api/issues?query=...&fields=...&$top=100&$skip=n,
 * paging until a page shorter than $top. Headers: Authorization: Bearer <token>,
 * Accept: application/json. retry: "retry-once". Deduplicates by numberInProject.
 * Any non-2xx propagates (a 400 is a query bug, never "no issues").
 */
export async function fetchProjectIssues(
  http: HttpClient,
  source: YouTrackSource,
): Promise<readonly YouTrackIssue[]> {
  void http;
  void source;
  throw new Error("not implemented");
}
