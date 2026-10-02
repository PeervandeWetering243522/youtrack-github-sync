/**
 * YouTrack read side. GET /api/issues ONLY -- this module must never issue any
 * other method or endpoint (see CLAUDE.md hard rules).
 *
 * Types come from the instance's OpenAPI spec (src/generated/youtrack.ts, via
 * `npm run gen:youtrack`). The spec marks nothing nullable and every property
 * optional; live responses return `null` for `resolved` (unresolved) and
 * `description` (empty) -- see docs/00-live-verification.md. The derived type
 * below encodes exactly that.
 *
 * Hierarchy (docs/11): every row also carries its Subtask parent link
 * (`parent(issues(idReadable))`) and the "Type" custom field
 * (`customFields(name,value(name))`, limited to Type by `customFields=Type`).
 *
 * Assignees (docs/13, U15): with `assignees` on, the scan also asks for the "Assignee" user
 * field (`customFields=Assignee`, `value(name,login,email)`). Every row is parsed into a
 * ScannedIssue, whose `assignee` keeps only each user's login and email; with `assignees`
 * off the request is today's, so the row reads as "absent".
 */

import type { components, paths } from "./generated/youtrack.ts";
import type { HttpClient } from "./http.ts";
import { isInteger, isJsonArray, isJsonObject, isString } from "./json.ts";
import type { JsonArray, JsonObject, JsonValue } from "./json.ts";

type IssueSchema = components["schemas"]["Issue"];
type IssueLinkSchema = components["schemas"]["IssueLink"];
type ParentIssueSchema = NonNullable<IssueLinkSchema["issues"]>[number];
type IssueCustomFieldSchema = components["schemas"]["IssueCustomField"];
type EnumValueSchema = components["schemas"]["EnumBundleElement"];
type UserSchema = components["schemas"]["User"];
type SchemaName = keyof components["schemas"];
type IssuesQueryParam = keyof NonNullable<paths["/issues"]["get"]["parameters"]["query"]>;

/** The flat fields requested. A typo here is a compile error (keyof IssueSchema). */
export const ISSUE_FIELDS = [
  "idReadable",
  "numberInProject",
  "summary",
  "description",
  "resolved",
  "updated",
] as const satisfies readonly (keyof IssueSchema)[];

/** The custom field whose value name becomes YouTrackIssue.type. */
export const YOUTRACK_TYPE_FIELD = "Type";

/** The user custom field whose users become GitHub assignees (U15), fixed like YOUTRACK_TYPE_FIELD. */
export const YOUTRACK_ASSIGNEE_FIELD = "Assignee";

// Nested field names, each checked against the generated schema like ISSUE_FIELDS.
const PARENT = "parent" satisfies keyof IssueSchema;
const LINK_ISSUES = "issues" satisfies keyof IssueLinkSchema;
const PARENT_ID = "idReadable" satisfies keyof ParentIssueSchema;
const CUSTOM_FIELDS = "customFields" satisfies keyof IssueSchema;
const FIELD_NAME = "name" satisfies keyof IssueCustomFieldSchema;
const FIELD_VALUE = "value" satisfies keyof IssueCustomFieldSchema;
const FIELD_TYPE = "$type" satisfies keyof IssueCustomFieldSchema;
const VALUE_NAME = "name" satisfies keyof EnumValueSchema;
const USER_LOGIN = "login" satisfies keyof UserSchema;
const USER_EMAIL = "email" satisfies keyof UserSchema;

// The `$type` of the two user custom fields (docs/12): one User, or an array of them.
const SINGLE_USER_FIELD = "SingleUserIssueCustomField" satisfies SchemaName;
const MULTI_USER_FIELD = "MultiUserIssueCustomField" satisfies SchemaName;

/** Every key a row must carry: the flat fields, then the two nested ones. */
const REQUIRED_KEYS: readonly string[] = [...ISSUE_FIELDS, PARENT, CUSTOM_FIELDS];

type RequiredField = "idReadable" | "numberInProject" | "summary" | "updated";
type NullableField = "description" | "resolved";

/**
 * One validated row. `type` is the value name of the YOUTRACK_TYPE_FIELD custom field
 * (null: no such field on the row, or an empty value). `parentId` is the idReadable of
 * the Subtask parent, `Issue.parent.issues[0]` (null: no parent); it may name an issue
 * of another project.
 */
export type YouTrackIssue = Readonly<
  { [K in RequiredField]-?: NonNullable<IssueSchema[K]> } & {
    [K in NullableField]-?: NonNullable<IssueSchema[K]> | null;
  } & {
    type: NonNullable<EnumValueSchema["name"]> | null;
    parentId: NonNullable<ParentIssueSchema["idReadable"]> | null;
  }
>;

/** One user value of the Assignee field: the login, and the email when set and visible. */
export type YouTrackUser = { readonly login: string; readonly email: string | null };

/**
 * A row's Assignee field: "absent" (no entry: not requested, not in the project, renamed, a
 * non-user field of that name, or unreadable), or its users ([] = unassigned).
 */
export type YouTrackAssignee =
  { readonly kind: "absent" } | { readonly kind: "users"; readonly users: readonly YouTrackUser[] };

/** A scanned row: the planner's YouTrackIssue plus its Assignee field. */
export type ScannedIssue = YouTrackIssue & { readonly assignee: YouTrackAssignee };

/** What the scan asks for beyond today's fields; `assignees` adds the Assignee field (U1). */
export type ScanOptions = { readonly assignees: boolean };

/** Today's scan: no Assignee field, no user subfields. */
const WITHOUT_ASSIGNEES: ScanOptions = { assignees: false };

/** What to scan: the instance base URL, a permanent token and the project shortName. */
export type YouTrackSource = {
  readonly baseUrl: string;
  readonly token: string;
  readonly project: string;
};

/** `$top` of every page request; a shorter page ends the scan. */
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

/** A nested `fields=` spec: `name(sub1,sub2)`. */
function nested(name: string, subfields: readonly string[]): string {
  return `${name}(${subfields.join(",")})`;
}

/**
 * `fields=` value: ISSUE_FIELDS, then `parent(issues(idReadable))` and `customFields(name,value(name))`.
 * With `assignees` on, the one value spec (shared by every entry, docs/12) also asks for the
 * user's `login` and `email`: `customFields(name,value(name,login,email))`.
 */
export function issueFieldsParam(options: ScanOptions = WITHOUT_ASSIGNEES): string {
  const valueFields = options.assignees ? [VALUE_NAME, USER_LOGIN, USER_EMAIL] : [VALUE_NAME];
  return [
    ...ISSUE_FIELDS,
    nested(PARENT, [nested(LINK_ISSUES, [PARENT_ID])]),
    nested(CUSTOM_FIELDS, [FIELD_NAME, nested(FIELD_VALUE, valueFields)]),
  ].join(",");
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
  const missing = REQUIRED_KEYS.filter((field) => !(field in row));
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

function isJsonObjectOrNull(value: JsonValue | undefined): value is JsonObject | null {
  return value === null || isJsonObject(value);
}

/**
 * The mirror identity is `[<project>-<numberInProject>]`, and parseMirrorTitle (mirror.ts)
 * reads back positive integers only. A 0 or negative number would give a mirror
 * that is never recognised, so every run would create another duplicate.
 */
function isPositiveInteger(value: JsonValue | undefined): value is number {
  return isInteger(value) && value > 0;
}

/** The error for a `path` of `row` that breaks "must <requirement>": names `path` and `got` (a kind or count), no value. */
function fieldError(row: JsonObject, path: string, requirement: string, got: string): YouTrackSchemaError {
  return new YouTrackSchemaError(`${rowLabel(row)}: field "${path}" must ${requirement}, got ${got}`);
}

/** `value` (at `path` in `row`) if `guard` accepts it; otherwise throws, naming `describe(value)`. */
function narrow<T extends JsonValue>(
  row: JsonObject,
  path: string,
  value: JsonValue | undefined,
  guard: JsonGuard<T>,
  expected: string,
  describe: (value: JsonValue | undefined) => string = jsonKind,
): T {
  if (guard(value)) return value;
  throw fieldError(row, path, `be ${expected}`, describe(value));
}

/** Reads one flat field, throwing YouTrackSchemaError (with `describe(value)`) when `guard` rejects it. */
function readField<T extends JsonValue>(
  row: JsonObject,
  field: IssueField,
  guard: JsonGuard<T>,
  expected: string,
  describe: (value: JsonValue | undefined) => string = jsonKind,
): T {
  return narrow(row, field, row[field], guard, expected, describe);
}

/**
 * `parent(issues(idReadable))` -> the parent's idReadable, or null when `issues` is empty.
 * A Subtask link has at most one parent, so two or more issues fail the row.
 */
function readParentId(row: JsonObject): string | null {
  const link = narrow(row, PARENT, row[PARENT], isJsonObject, "an object");
  const path = `${PARENT}.${LINK_ISSUES}`;
  const issues = narrow(row, path, link[LINK_ISSUES], isJsonArray, "an array");
  if (issues.length > 1) throw fieldError(row, path, "hold at most one issue", String(issues.length));
  const [first] = issues;
  if (first === undefined) return null;
  const parent = narrow(row, `${path}[0]`, first, isJsonObject, "an object");
  return narrow(row, `${path}[0].${PARENT_ID}`, parent[PARENT_ID], isString, "a string");
}

type CustomFieldEntry = { readonly path: string; readonly entry: JsonObject; readonly name: string };

/** Every `customFields` entry with its path and name. Every entry must be an object with a string name. */
function customFieldEntries(row: JsonObject): readonly CustomFieldEntry[] {
  const fields = narrow(row, CUSTOM_FIELDS, row[CUSTOM_FIELDS], isJsonArray, "an array");
  return fields.map((field, index): CustomFieldEntry => {
    const path = `${CUSTOM_FIELDS}[${String(index)}]`;
    const entry = narrow(row, path, field, isJsonObject, "an object");
    const name = narrow(row, `${path}.${FIELD_NAME}`, entry[FIELD_NAME], isString, "a string");
    return { path, entry, name };
  });
}

/** The only entry of `matches`, or undefined for none; two or more fail the row, naming `field` and the count. */
function singleEntry(
  row: JsonObject,
  matches: readonly CustomFieldEntry[],
  field: string,
): CustomFieldEntry | undefined {
  if (matches.length > 1) {
    throw fieldError(row, CUSTOM_FIELDS, `hold at most one "${field}" entry`, String(matches.length));
  }
  return matches[0];
}

/**
 * `customFields(name,value(name))` -> the Type value name, or null when there is no Type
 * entry (named exactly YOUTRACK_TYPE_FIELD) or its value is null. Two Type entries, or a
 * value without a string name, fail the row.
 */
function readType(row: JsonObject, entries: readonly CustomFieldEntry[]): string | null {
  const typeEntries = entries.filter((entry) => entry.name === YOUTRACK_TYPE_FIELD);
  const match = singleEntry(row, typeEntries, YOUTRACK_TYPE_FIELD);
  if (match === undefined) return null;
  const path = `${match.path}.${FIELD_VALUE}`;
  const value = narrow(row, path, match.entry[FIELD_VALUE], isJsonObjectOrNull, "null or an object");
  return value === null ? null : narrow(row, `${path}.${VALUE_NAME}`, value[VALUE_NAME], isString, "a string");
}

function isJsonArrayOrNull(value: JsonValue | undefined): value is JsonArray | null {
  return value === null || isJsonArray(value);
}

function isNonEmptyString(value: JsonValue | undefined): value is string {
  return isString(value) && value !== "";
}

/** jsonKind, but names "" "empty string" (for a login only). */
function nonEmptyStringKind(value: JsonValue | undefined): string {
  return value === "" ? "empty string" : jsonKind(value);
}

/** A user field named YOUTRACK_ASSIGNEE_FIELD ignoring A-Z case (as YouTrack's filter, docs/12). */
function isAssigneeEntry(entry: CustomFieldEntry): boolean {
  const type = entry.entry[FIELD_TYPE];
  return (
    asciiLowerCase(entry.name) === asciiLowerCase(YOUTRACK_ASSIGNEE_FIELD) &&
    (type === SINGLE_USER_FIELD || type === MULTI_USER_FIELD)
  );
}

/**
 * One User value at `path`: a non-empty string login, and an email that is a string, null or
 * missing ("" and missing read as null). Every other key, `name` and `fullName` included, is
 * dropped here, so no full name gets past this boundary.
 */
function readUser(row: JsonObject, path: string, value: JsonValue): YouTrackUser {
  const user = narrow(row, path, value, isJsonObject, "an object");
  const login = narrow(
    row,
    `${path}.${USER_LOGIN}`,
    user[USER_LOGIN],
    isNonEmptyString,
    "a non-empty string",
    nonEmptyStringKind,
  );
  const rawEmail = user[USER_EMAIL] ?? null;
  const email = narrow(row, `${path}.${USER_EMAIL}`, rawEmail, isStringOrNull, "a string or null");
  return { login, email: email === "" ? null : email };
}

/** The users of a recognised Assignee entry: single is null or one User, multi null or an array of them. */
function readAssigneeUsers(row: JsonObject, match: CustomFieldEntry): readonly YouTrackUser[] {
  const path = `${match.path}.${FIELD_VALUE}`;
  const raw = match.entry[FIELD_VALUE];
  if (match.entry[FIELD_TYPE] === SINGLE_USER_FIELD) {
    const value = narrow(row, path, raw, isJsonObjectOrNull, "null or an object");
    return value === null ? [] : [readUser(row, path, value)];
  }
  // An empty multi-user value may come back as null or [] (undocumented, docs/12): both are no users.
  const values = narrow(row, path, raw, isJsonArrayOrNull, "null or an array") ?? [];
  return values.map((value, index) => readUser(row, `${path}[${String(index)}]`, value));
}

/**
 * `customFields(name,value(name,login,email))` -> the Assignee field (U15). Its entry is the
 * one named YOUTRACK_ASSIGNEE_FIELD ignoring A-Z case with a `$type` of SingleUserIssueCustomField
 * or MultiUserIssueCustomField; an entry of another (or no) `$type` is ignored, so such a row
 * reads as "absent". Two recognised entries, or a value of the wrong shape, fail the row.
 */
function readAssignee(row: JsonObject, entries: readonly CustomFieldEntry[]): YouTrackAssignee {
  const match = singleEntry(row, entries.filter(isAssigneeEntry), YOUTRACK_ASSIGNEE_FIELD);
  return match === undefined ? { kind: "absent" } : { kind: "users", users: readAssigneeUsers(row, match) };
}

/**
 * Validates one row. Requires every ISSUE_FIELDS key plus `parent` and `customFields`
 * to be present (a silently dropped field must fail loudly), types exact,
 * `resolved`/`description` may be null, `numberInProject` positive (see
 * isPositiveInteger), then reads `type` (readType), `parentId` (readParentId) and
 * `assignee` (readAssignee), whatever the request asked for.
 * Returns a new object with exactly the ScannedIssue keys (no `$type`).
 */
export function parseYouTrackIssue(row: JsonValue): ScannedIssue {
  if (!isJsonObject(row)) {
    throw new YouTrackSchemaError(`YouTrack issue row must be a JSON object, got ${jsonKind(row)}`);
  }
  assertAllFieldsPresent(row);
  const flat = {
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
  const entries = customFieldEntries(row);
  return {
    ...flat,
    type: readType(row, entries),
    parentId: readParentId(row),
    assignee: readAssignee(row, entries),
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
export function parseProjectIssue(row: JsonValue, project: string): ScannedIssue {
  const issue = parseYouTrackIssue(row);
  const expected = `${project}-${String(issue.numberInProject)}`;
  if (asciiLowerCase(issue.idReadable) === asciiLowerCase(expected)) return issue;
  throw new YouTrackSchemaError(
    `YouTrack issue ${JSON.stringify(issue.idReadable)}: idReadable must be ` +
      `${JSON.stringify(expected)} (<project>-<numberInProject>)`,
  );
}

/** The `customFields=` values, in order: YOUTRACK_TYPE_FIELD, then YOUTRACK_ASSIGNEE_FIELD with `assignees` on. */
function customFieldsParams(options: ScanOptions): readonly string[] {
  return options.assignees ? [YOUTRACK_TYPE_FIELD, YOUTRACK_ASSIGNEE_FIELD] : [YOUTRACK_TYPE_FIELD];
}

/**
 * `{baseUrl}/api/issues` with the query, fields, customFields and paging parameters of one
 * page. Built from ordered pairs, since `customFields` repeats with `assignees` on (docs/12);
 * each name is checked against the generated spec. With `assignees` off the URL is today's.
 */
function issuesPageUrl(source: YouTrackSource, skip: number, options: ScanOptions): string {
  const pairs: readonly (readonly [IssuesQueryParam, string])[] = [
    ["query", projectQuery(source.project)],
    ["fields", issueFieldsParam(options)],
    ...customFieldsParams(options).map((field) => ["customFields", field] as const),
    ["$top", String(YOUTRACK_PAGE_SIZE)],
    ["$skip", String(skip)],
  ];
  const params = new URLSearchParams();
  for (const [name, value] of pairs) params.append(name, value);
  return `${source.baseUrl}/api/issues?${params.toString()}`;
}

/** GETs and validates one page. The body must be a JSON array of `source.project` issue rows. */
async function fetchIssuePage(
  http: HttpClient,
  source: YouTrackSource,
  skip: number,
  options: ScanOptions,
): Promise<readonly ScannedIssue[]> {
  const response = await http.request({
    method: "GET",
    url: issuesPageUrl(source, skip, options),
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
function dedupeByNumberInProject(issues: readonly ScannedIssue[]): readonly ScannedIssue[] {
  const seen = new Set<number>();
  return issues.filter((issue) => {
    if (seen.has(issue.numberInProject)) return false;
    seen.add(issue.numberInProject);
    return true;
  });
}

/**
 * Full project scan: GET {baseUrl}/api/issues?query=...&fields=...&customFields=Type&$top=100&$skip=n,
 * paging until a page shorter than $top. With `options.assignees` on, `fields` also asks for
 * the user login and email and `&customFields=Assignee` follows `customFields=Type`; the
 * default (off) sends today's URL unchanged. Headers: Authorization: Bearer <token>,
 * Accept: application/json. retry: "retry-once". Every row goes through
 * parseProjectIssue (decision R4), then the result is deduplicated by numberInProject.
 * Any non-2xx propagates (a 400 is a query bug, never "no issues").
 */
export async function fetchProjectIssues(
  http: HttpClient,
  source: YouTrackSource,
  options: ScanOptions = WITHOUT_ASSIGNEES,
): Promise<readonly ScannedIssue[]> {
  const pages: (readonly ScannedIssue[])[] = [];
  // $skip starts at 0 and advances by each raw page length (repeats included), not by
  // the de-duplicated count, which would re-request the rows a repeat displaced.
  let skip = 0;
  for (;;) {
    const page = await fetchIssuePage(http, source, skip, options);
    pages.push(page);
    skip += page.length;
    if (page.length < YOUTRACK_PAGE_SIZE) return dedupeByNumberInProject(pages.flat());
  }
}
