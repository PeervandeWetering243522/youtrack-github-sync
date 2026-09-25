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
import { isInteger, isJsonArray, isJsonObject, isString } from "./json.ts";
import type { JsonObject, JsonValue } from "./json.ts";

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

type IssueField = (typeof ISSUE_FIELDS)[number];
type JsonGuard<T extends JsonValue> = (value: JsonValue | undefined) => value is T;

/** `fields=` parameter value built from ISSUE_FIELDS. */
export function issueFieldsParam(): string {
  return ISSUE_FIELDS.join(",");
}

/** `project: <project> sort by: {issue id} asc` (stable under concurrent edits). */
export function projectQuery(project: string): string {
  return `project: ${project} sort by: {issue id} asc`;
}

/** The JSON kind of a value, for error messages. Never the value itself. */
function jsonKind(value: JsonValue | undefined): string {
  if (value === null) return "null";
  if (isJsonArray(value)) return "array";
  if (typeof value === "number" && !Number.isSafeInteger(value)) return "non-safe-integer number";
  return typeof value;
}

/** jsonKind, but names a safe integer <= 0 "non-positive integer" (for numberInProject only). */
function positiveIntegerKind(value: JsonValue | undefined): string {
  return isInteger(value) && value <= 0 ? "non-positive integer" : jsonKind(value);
}

/** Names a row by idReadable or numberInProject only, so no issue text reaches logs. */
function rowLabel(row: JsonObject): string {
  const idReadable = row["idReadable"];
  if (isString(idReadable)) return `YouTrack issue ${JSON.stringify(idReadable)}`;
  const numberInProject = row["numberInProject"];
  if (isInteger(numberInProject)) {
    return `YouTrack issue numberInProject=${String(numberInProject)}`;
  }
  return "YouTrack issue row";
}

/** A field missing from the response was dropped or misspelled in `fields=`. */
function assertAllFieldsPresent(row: JsonObject): void {
  const missing = ISSUE_FIELDS.filter((field) => !(field in row));
  if (missing.length > 0) {
    const names = missing.map((field) => `"${field}"`).join(", ");
    throw new YouTrackSchemaError(`${rowLabel(row)} is missing field(s) ${names}`);
  }
}

function isStringOrNull(value: JsonValue | undefined): value is string | null {
  return value === null || isString(value);
}

function isIntegerOrNull(value: JsonValue | undefined): value is number | null {
  return value === null || isInteger(value);
}

/**
 * The mirror identity is `[YT-<numberInProject>]`, and parseMirrorTitle (mirror.ts)
 * reads back positive integers only. A 0 or negative number would give a mirror
 * that is never recognised, so every run would create another duplicate.
 */
function isPositiveInteger(value: JsonValue | undefined): value is number {
  return isInteger(value) && value > 0;
}

/** Reads one field, throwing YouTrackSchemaError (with `describe(value)`) when `guard` rejects it. */
function readField<T extends JsonValue>(
  row: JsonObject,
  field: IssueField,
  guard: JsonGuard<T>,
  expected: string,
  describe: (value: JsonValue | undefined) => string = jsonKind,
): T {
  const value = row[field];
  if (guard(value)) return value;
  throw new YouTrackSchemaError(
    `${rowLabel(row)}: field "${field}" must be ${expected}, got ${describe(value)}`,
  );
}

/**
 * Validates one row. Requires every ISSUE_FIELDS key to be present (a silently
 * dropped field must fail loudly), types exact, `resolved`/`description` may be null,
 * `numberInProject` positive (see isPositiveInteger).
 * Returns a new object with exactly the YouTrackIssue keys (no `$type`).
 */
export function parseYouTrackIssue(row: JsonValue): YouTrackIssue {
  if (!isJsonObject(row)) {
    throw new YouTrackSchemaError(`YouTrack issue row must be a JSON object, got ${jsonKind(row)}`);
  }
  assertAllFieldsPresent(row);
  return {
    idReadable: readField(row, "idReadable", isString, "a string"),
    numberInProject: readField(
      row,
      "numberInProject",
      isPositiveInteger,
      "a positive safe integer",
      positiveIntegerKind,
    ),
    summary: readField(row, "summary", isString, "a string"),
    description: readField(row, "description", isStringOrNull, "a string or null"),
    resolved: readField(row, "resolved", isIntegerOrNull, "a safe integer or null"),
    updated: readField(row, "updated", isInteger, "a safe integer"),
  };
}

/** Lower-cases A-Z only, so no Unicode case mapping (e.g. U+0131 -> "I") can forge a match. */
function asciiLowerCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * parseYouTrackIssue plus the row sanity check of decision R4: `idReadable` must be
 * `<project>-<numberInProject>`. The project prefix is compared case-insensitively
 * (ASCII only), as YouTrack matches shortNames in queries; the number must match exactly.
 * A mismatch throws YouTrackSchemaError naming both ids, never any issue text.
 */
export function parseProjectIssue(row: JsonValue, project: string): YouTrackIssue {
  const issue = parseYouTrackIssue(row);
  const expected = `${project}-${String(issue.numberInProject)}`;
  if (asciiLowerCase(issue.idReadable) === asciiLowerCase(expected)) return issue;
  throw new YouTrackSchemaError(
    `YouTrack issue ${JSON.stringify(issue.idReadable)}: idReadable must be ` +
      `${JSON.stringify(expected)} (<project>-<numberInProject>)`,
  );
}

/** `{baseUrl}/api/issues` with the query, fields and paging parameters of one page. */
function issuesPageUrl(source: YouTrackSource, skip: number): string {
  const params = new URLSearchParams({
    query: projectQuery(source.project),
    fields: issueFieldsParam(),
    $top: String(YOUTRACK_PAGE_SIZE),
    $skip: String(skip),
  });
  return `${source.baseUrl}/api/issues?${params.toString()}`;
}

/** GETs and validates one page. The body must be a JSON array of `source.project` issue rows. */
async function fetchIssuePage(
  http: HttpClient,
  source: YouTrackSource,
  skip: number,
): Promise<readonly YouTrackIssue[]> {
  const response = await http.request({
    method: "GET",
    url: issuesPageUrl(source, skip),
    headers: { Authorization: `Bearer ${source.token}`, Accept: "application/json" },
    retry: "retry-once",
  });
  const rows = response.body;
  if (!isJsonArray(rows)) {
    const page = `YouTrack /api/issues page at $skip=${String(skip)}`;
    throw new YouTrackSchemaError(`${page} must be a JSON array, got ${jsonKind(rows)}`);
  }
  return rows.map((row) => parseProjectIssue(row, source.project));
}

/** Keeps the first row per numberInProject (a result set that shifts mid-scan can repeat a row). */
function dedupeByNumberInProject(issues: readonly YouTrackIssue[]): readonly YouTrackIssue[] {
  const seen = new Set<number>();
  return issues.filter((issue) => {
    if (seen.has(issue.numberInProject)) return false;
    seen.add(issue.numberInProject);
    return true;
  });
}

/**
 * Full project scan: GET {baseUrl}/api/issues?query=...&fields=...&$top=100&$skip=n,
 * paging until a page shorter than $top. Headers: Authorization: Bearer <token>,
 * Accept: application/json. retry: "retry-once". Every row goes through
 * parseProjectIssue (decision R4), then the result is deduplicated by numberInProject.
 * Any non-2xx propagates (a 400 is a query bug, never "no issues").
 */
export async function fetchProjectIssues(
  http: HttpClient,
  source: YouTrackSource,
): Promise<readonly YouTrackIssue[]> {
  const pages: (readonly YouTrackIssue[])[] = [];
  // $skip starts at 0 and advances by each raw page length (repeats included), not by
  // the de-duplicated count, which would re-request the rows a repeat displaced.
  let skip = 0;
  for (;;) {
    const page = await fetchIssuePage(http, source, skip);
    pages.push(page);
    skip += page.length;
    if (page.length < YOUTRACK_PAGE_SIZE) return dedupeByNumberInProject(pages.flat());
  }
}
