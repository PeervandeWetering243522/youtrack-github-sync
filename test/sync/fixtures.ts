/**
 * Shared fixtures for the runSync tests (test/sync/*.test.ts): config, YouTrack rows,
 * GitHub issues and milestones, a fake fetch that routes by method + URL to canned answers
 * and records every call, a recording logger and sleep, and assertion helpers.
 */

import assert from "node:assert/strict";

import type { Config } from "../../src/config.ts";
import { MIRROR_LABEL } from "../../src/github/client.ts";
import { isInteger, isJsonArray, isJsonObject, isString, parseJson } from "../../src/json.ts";
import type { JsonObject, JsonValue } from "../../src/json.ts";
import { WRITE_PAUSE_MS } from "../../src/sync.ts";
import type { Logger, RunSummary, SyncDeps } from "../../src/sync.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const GITHUB_TOKEN = "ghp_fakeGithubToken0123456789abcdefABCDEF";
export const YOUTRACK_TOKEN = "perm:fake.youtrack.token.0123456789";
export const YOUTRACK_BASE_URL = "https://youtrack.example.test";
export const GITHUB_ORIGIN = "https://api.github.com";
export const ISSUES_PATH = "/repos/acme/mirror/issues";
const ISSUE_PATH = /^\/repos\/acme\/mirror\/issues\/(\d+)$/;
export const LABELS_PATH = /^\/repos\/acme\/mirror\/issues\/\d+\/labels$/;
export const MILESTONES_PATH = "/repos/acme/mirror/milestones";
const MILESTONE_PATH = /^\/repos\/acme\/mirror\/milestones\/(\d+)$/;
/** POST .../issues/{parent}/sub_issues (add) and DELETE .../issues/{parent}/sub_issue (remove). */
const SUB_ISSUE_PATH = /^\/repos\/acme\/mirror\/issues\/(\d+)\/sub_issues?$/;
/** GET: the assignable users (read 4 of docs/13 §2.2). */
export const ASSIGNABLE_PATH = "/repos/acme/mirror/assignees";
/** GET ?author=<email>: the commit-author lookup (step c). */
export const COMMITS_PATH = "/repos/acme/mirror/commits";
/** GET ?q="<email>" in:email type:user: the public-email lookup (step d). */
export const SEARCH_USERS_PATH = "/search/users";
/** POST (add) and DELETE (remove) .../issues/{n}/assignees. */
const ISSUE_ASSIGNEES_PATH = /^\/repos\/acme\/mirror\/issues\/(\d+)\/assignees$/;

/** The add and remove endpoint of issue #issueNumber. */
export function assigneesPath(issueNumber: number): string {
  return `${ISSUES_PATH}/${String(issueNumber)}/assignees`;
}
export const RESOLVED_AT = 1_789_644_365_309;
const UPDATED_AT = 1_790_254_466_396;
/** The fake numbers new GitHub issues from here on: the first create gets #101. */
export const LAST_EXISTING_NUMBER = 100;
/** The fake numbers new GitHub milestones from here on: the first create gets milestone #201. */
export const LAST_EXISTING_MILESTONE = 200;
/** Every fake GitHub issue's REST id is this plus its number, so ids and numbers never coincide. */
const ID_OFFSET = 1_000_000;

/** The REST `id` the fake gives GitHub issue #issueNumber. */
export function issueId(issueNumber: number): number {
  return ID_OFFSET + issueNumber;
}

const BASE_CONFIG: Config = {
  githubToken: GITHUB_TOKEN,
  githubOwner: "acme",
  githubRepo: "mirror",
  youtrackBaseUrl: YOUTRACK_BASE_URL,
  youtrackToken: YOUTRACK_TOKEN,
  youtrackProject: "CUI",
  excludePrefix: "[individual]",
  maxWritesPerRun: 30,
  dryRun: false,
  reopenClosedBy: null,
  syncAssignees: true,
  assigneeMap: new Map(),
};

export function config(overrides: Partial<Config> = {}): Config {
  return { ...BASE_CONFIG, ...overrides };
}

type RowOptions = {
  readonly summary?: string;
  readonly resolved?: number | null;
  readonly description?: string | null;
  /** The YouTrack Type value ("Epic", "User Story", "Bug", "Task"); left out: no Type entry. */
  readonly type?: string;
  /** numberInProject of the Subtask parent (CUI-<n>); left out: no parent. */
  readonly parent?: number;
  /** The project ID of the row and its parent; left out: "CUI", as in config(). */
  readonly project?: string;
  /**
   * The Assignee field (U15). Left out: a single-user entry with no user (unassigned), so a
   * run reads no assignable list; null: no entry at all (the field is missing); users: a
   * single-user entry with the only one, or a multi-user entry with `multiAssignee`.
   */
  readonly assignees?: readonly YtUser[] | null;
  readonly multiAssignee?: boolean;
};

/** A YouTrack user of an Assignee value; email left out: null (hidden or unset). */
export type YtUser = { readonly login: string; readonly email?: string | null };

/**
 * A YouTrack /api/issues row shaped like the live ones in docs/00. Without `type` and
 * `parent` it has no Type entry and no parent (it parses to type: null, parentId: null).
 */
export function ytRow(numberInProject: number, options: RowOptions = {}): JsonObject {
  const n = String(numberInProject);
  const { type, parent, project = "CUI" } = options;
  const parentIssues = parent === undefined ? [] : [{ idReadable: `${project}-${String(parent)}`, $type: "Issue" }];
  const typeValue = type === undefined ? null : { name: type, $type: "EnumBundleElement" };
  const typeEntry = typeValue === null ? [] : [{ name: "Type", value: typeValue, $type: "SingleEnumIssueCustomField" }];
  return {
    idReadable: `${project}-${n}`,
    numberInProject,
    summary: options.summary ?? `[team] Task ${n}`,
    description: options.description === undefined ? `Details of task ${n}` : options.description,
    resolved: options.resolved ?? null,
    updated: UPDATED_AT,
    parent: { issues: parentIssues, $type: "IssueLink" },
    customFields: [...typeEntry, ...assigneeEntry(options)],
    $type: "Issue",
  };
}

/** The row's Assignee custom field entry as YouTrack sends it (user subfields name, login, email). */
function assigneeEntry(options: RowOptions): readonly JsonObject[] {
  const { assignees } = options;
  if (assignees === null) return [];
  const users = (assignees ?? []).map((user) => ({
    name: "Placeholder Person",
    login: user.login,
    email: user.email ?? null,
    $type: "User",
  }));
  if (options.multiAssignee === true) return [{ name: "Assignee", value: users, $type: "MultiUserIssueCustomField" }];
  assert.ok(users.length <= 1, "a single-user Assignee holds at most one user; set multiAssignee");
  return [{ name: "Assignee", value: users[0] ?? null, $type: "SingleUserIssueCustomField" }];
}

type IssueOptions = {
  readonly state?: "open" | "closed";
  readonly labels?: readonly string[];
  readonly pullRequest?: boolean;
  /** The milestone number the issue sits in. */
  readonly milestone?: number;
  /** The GitHub issue type name. */
  readonly type?: string;
  /** The number of its parent issue in this repository. */
  readonly parent?: number;
  /** The login of `closed_by` (R10); null sends `closed_by: null`, left out sends no key. */
  readonly closedBy?: string | null;
  /** The issue's assignees (see ghAssignee); left out sends no key (parsed as none). */
  readonly assignees?: readonly JsonObject[];
};

/** An assignee or assignable user as GitHub reports it: login and account type. */
export function ghAssignee(login: string, type = "User"): JsonObject {
  return { login, id: 1, type };
}

/** An issue as GitHub lists it; milestone, type, parent_issue_url, closed_by and assignees only when given. */
export function ghIssue(issueNumber: number, title: string, options: IssueOptions = {}): JsonObject {
  const { milestone, type, parent, closedBy, assignees } = options;
  return {
    id: issueId(issueNumber),
    number: issueNumber,
    title,
    state: options.state ?? "open",
    labels: (options.labels ?? [MIRROR_LABEL]).map((name) => ({ name })),
    ...(options.pullRequest === true ? { pull_request: { url: `${GITHUB_ORIGIN}/pulls/${String(issueNumber)}` } } : {}),
    ...(milestone === undefined ? {} : { milestone: { number: milestone, title: "any" } }),
    ...(type === undefined ? {} : { type: { name: type } }),
    ...(parent === undefined ? {} : { parent_issue_url: `${GITHUB_ORIGIN}${ISSUES_PATH}/${String(parent)}` }),
    ...(closedBy === undefined ? {} : { closed_by: closedBy === null ? null : { login: closedBy, type: "Bot" } }),
    ...(assignees === undefined ? {} : { assignees }),
  };
}

/** A milestone as GitHub lists it. */
export function ghMilestone(milestoneNumber: number, title: string, state: "open" | "closed" = "open"): JsonObject {
  return { number: milestoneNumber, title, state, description: null, open_issues: 0, closed_issues: 0 };
}

/** Open milestones #1.. of resolved epics CUI-1.., titled as the epics: each needs a closeMilestone only. */
export function openMilestonesOfResolvedEpics(count: number): {
  readonly milestones: JsonObject[];
  readonly youtrackRows: JsonObject[];
} {
  const numbers = Array.from({ length: count }, (_, index) => index + 1);
  return {
    milestones: numbers.map((n) => ghMilestone(n, `[CUI-${String(n)}] [team] Epic ${String(n)}`)),
    youtrackRows: numbers.map((n) =>
      ytRow(n, { type: "Epic", summary: `[team] Epic ${String(n)}`, resolved: RESOLVED_AT }),
    ),
  };
}

/** Open, labelled mirrors #101.. of resolved issues CUI-1.., titled as the issues: each needs a close only. */
export function openMirrorsOfResolved(count: number): {
  readonly githubIssues: JsonObject[];
  readonly youtrackRows: JsonObject[];
} {
  const numbers = Array.from({ length: count }, (_, index) => index + 1);
  return {
    githubIssues: numbers.map((n) => ghIssue(LAST_EXISTING_NUMBER + n, `[CUI-${String(n)}] [team] Task ${String(n)}`)),
    youtrackRows: numbers.map((n) => ytRow(n, { resolved: RESOLVED_AT })),
  };
}

// ---------------------------------------------------------------------------
// Fake fetch
// ---------------------------------------------------------------------------

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

export type RecordedCall = {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: JsonValue | undefined;
};

/** Replaces the default answer; `attempt` counts earlier calls with the same method and URL. */
export type Override = (call: RecordedCall, attempt: number) => Response | Error | undefined;

/** A POST /issues request field the fake create silently drops, as GitHub does without push access. */
export type CreateDrop = "milestone" | "type" | "parent_issue_id";

export type World = {
  readonly githubIssues?: readonly JsonObject[];
  readonly milestones?: readonly JsonObject[];
  readonly youtrackRows?: readonly JsonObject[];
  /** Labels a create answers with; by default the requested ones ([] = silently dropped). */
  readonly createdLabels?: readonly string[];
  /** Request fields a create answers without; by default none (all echoed back). */
  readonly createDrops?: readonly CreateDrop[];
  readonly override?: Override;
  /** SyncDeps.deadline on the virtual clock; by default never reached. */
  readonly deadline?: number;
  /** The virtual clock at the start of the run, epoch ms; by default 0. */
  readonly startTime?: number;
  /** GET .../assignees: the repository's assignable users (ghAssignee); by default none. */
  readonly assignable?: readonly JsonObject[];
  /** GET .../commits?author=<email>: the top-level author login per email (null: author null); others: no commit. */
  readonly commitAuthors?: ReadonlyMap<string, string | null>;
  /** GET /search/users for "<email>": the User logins per email; others: no items. */
  readonly searchUsers?: ReadonlyMap<string, readonly string[]>;
};

export type LogLine = { readonly level: "info" | "warn" | "error"; readonly message: string };

export type Harness = {
  readonly deps: SyncDeps;
  readonly calls: readonly RecordedCall[];
  readonly lines: readonly LogLine[];
  readonly sleeps: readonly number[];
};

/**
 * No milestones, and no YouTrack types or parents; every mirror has its issue's title:
 * CUI-1 unresolved, no mirror       -> create
 * CUI-2 resolved, no mirror         -> unchanged (never mirrored, decision R9)
 * CUI-3 resolved, open mirror #12   -> close
 * CUI-4 "[individual]"              -> filtered (decision F1)
 * CUI-5 unresolved, open mirror #13 -> unchanged
 * CUI-6 resolved, closed mirror #14 -> unchanged
 * PR #15 is titled "[CUI-1]" but is not a mirror.
 */
export const MIXED_WORLD: World = {
  githubIssues: [
    ghIssue(12, "[CUI-3] [team] Task 3"),
    ghIssue(13, "[CUI-5] [team] Task 5"),
    ghIssue(14, "[CUI-6] [team] Task 6", { state: "closed" }),
    ghIssue(15, "[CUI-1] Some pull request", { pullRequest: true, labels: [] }),
  ],
  youtrackRows: [
    ytRow(1),
    ytRow(2, { resolved: RESOLVED_AT }),
    ytRow(3, { resolved: RESOLVED_AT }),
    ytRow(4, { summary: "[individual] Task 4" }),
    ytRow(5),
    ytRow(6, { resolved: RESOLVED_AT }),
  ],
};

export function json(status: number, body: JsonValue, headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function recordCall(input: FetchInput, init: FetchInit): RecordedCall {
  const href = input instanceof Request ? input.url : String(input);
  const rawBody = init?.body;
  return {
    method: init?.method ?? "GET",
    url: new URL(href),
    headers: new Headers(init?.headers),
    body: typeof rawBody === "string" ? parseJson(rawBody) : undefined,
  };
}

function youtrackPage(url: URL, rows: readonly JsonObject[]): Response {
  const skip = Number(url.searchParams.get("$skip") ?? "0");
  const top = Number(url.searchParams.get("$top") ?? "0");
  return json(200, rows.slice(skip, skip + top));
}

/** Hands out the numbers of new issues (#101..) and milestones (#201..). */
type Counters = { readonly nextIssue: () => number; readonly nextMilestone: () => number };

function requestOf(body: JsonValue | undefined): JsonObject {
  return isJsonObject(body) ? body : {};
}

/** The request's integer field `key`, unless the world drops it; else undefined. */
function kept(request: JsonObject, key: CreateDrop, world: World): number | undefined {
  const value = request[key];
  return isInteger(value) && !(world.createDrops ?? []).includes(key) ? value : undefined;
}

function createdIssue(body: JsonValue | undefined, issueNumber: number, world: World): JsonObject {
  const request = requestOf(body);
  const { title, labels: requested, type } = request;
  const labels = world.createdLabels ?? (isJsonArray(requested) ? requested.filter(isString) : []);
  const parentId = kept(request, "parent_issue_id", world);
  const milestone = kept(request, "milestone", world);
  return ghIssue(issueNumber, isString(title) ? title : "", {
    labels,
    assignees: [],
    ...(milestone === undefined ? {} : { milestone }),
    ...(isString(type) && !(world.createDrops ?? []).includes("type") ? { type } : {}),
    ...(parentId === undefined ? {} : { parent: parentId - ID_OFFSET }),
  });
}

/** A PATCH answer: closed for a close, otherwise the requested title, milestone and type echoed back. */
function patchedIssue(body: JsonValue | undefined, issueNumber: number): JsonObject {
  const { state, title, milestone, type } = requestOf(body);
  if (state === "closed") return ghIssue(issueNumber, "[CUI-0] closed", { state: "closed", assignees: [] });
  return {
    ...ghIssue(issueNumber, isString(title) ? title : "[CUI-0] patched", {
      assignees: [],
      ...(isString(type) ? { type } : {}),
    }),
    ...(milestone === undefined ? {} : { milestone: isInteger(milestone) ? { number: milestone } : null }),
  };
}

function createdMilestone(body: JsonValue | undefined, milestoneNumber: number): JsonObject {
  const { title } = requestOf(body);
  return ghMilestone(milestoneNumber, isString(title) ? title : "");
}

/** A milestone PATCH answer: closed for a close, otherwise open with the requested title (a rename). */
function patchedMilestone(body: JsonValue | undefined, milestoneNumber: number): JsonObject {
  const { state, title } = requestOf(body);
  if (state === "closed") return ghMilestone(milestoneNumber, "[CUI-0] closed", "closed");
  return ghMilestone(milestoneNumber, isString(title) ? title : "");
}

function milestoneAnswer(call: RecordedCall, world: World, counters: Counters): Response | undefined {
  const path = call.url.pathname;
  if (path === MILESTONES_PATH && call.method === "GET") return json(200, world.milestones ?? []);
  if (path === MILESTONES_PATH && call.method === "POST") {
    return json(201, createdMilestone(call.body, counters.nextMilestone()));
  }
  const milestone = MILESTONE_PATH.exec(path);
  if (call.method === "PATCH" && milestone !== null) {
    return json(200, patchedMilestone(call.body, Number(milestone[1])));
  }
  return undefined;
}

function issueAnswer(call: RecordedCall, world: World, counters: Counters): Response | undefined {
  const path = call.url.pathname;
  if (path === ISSUES_PATH && call.method === "GET") return json(200, world.githubIssues ?? []);
  if (path === ISSUES_PATH && call.method === "POST") {
    return json(201, createdIssue(call.body, counters.nextIssue(), world));
  }
  if (call.method === "POST" && LABELS_PATH.test(path)) return json(200, [{ name: MIRROR_LABEL }]);
  const issue = ISSUE_PATH.exec(path);
  if (call.method === "PATCH" && issue !== null) return json(200, patchedIssue(call.body, Number(issue[1])));
  const parent = SUB_ISSUE_PATH.exec(path);
  if (parent !== null && (call.method === "POST" || call.method === "DELETE")) {
    return json(call.method === "POST" ? 201 : 200, ghIssue(Number(parent[1]), "[CUI-0] parent"));
  }
  return undefined;
}

/** The logins of an assignee write's {assignees: [...]} body. */
function sentLogins(body: JsonValue | undefined): readonly string[] {
  const { assignees } = requestOf(body);
  return isJsonArray(assignees) ? assignees.filter(isString) : [];
}

/** A commits page of at most one commit, whose top-level author is the world's login for `email`. */
function commitsPage(email: string, world: World): JsonValue {
  const login = world.commitAuthors?.get(email);
  if (login === undefined) return [];
  return [{ sha: "0123abc", author: login === null ? null : ghAssignee(login) }];
}

/** A user search answer for the query `"<email>" in:email type:user`. */
function searchAnswer(query: string, world: World): JsonValue {
  const email = /^"(.*)" in:email type:user$/.exec(query)?.[1];
  const logins = email === undefined ? [] : (world.searchUsers?.get(email) ?? []);
  return { total_count: logins.length, incomplete_results: false, items: logins.map((login) => ghAssignee(login)) };
}

/**
 * The assignable list, the commit and user-search lookups, and the add and remove writes:
 * an add answers with the sent logins assigned, a remove with no assignee left.
 */
function assigneeAnswer(call: RecordedCall, world: World): Response | undefined {
  const { pathname: path, searchParams } = call.url;
  if (call.method === "GET" && path === ASSIGNABLE_PATH) return json(200, world.assignable ?? []);
  if (call.method === "GET" && path === COMMITS_PATH)
    return json(200, commitsPage(searchParams.get("author") ?? "", world));
  if (call.method === "GET" && path === SEARCH_USERS_PATH)
    return json(200, searchAnswer(searchParams.get("q") ?? "", world));
  const issue = ISSUE_ASSIGNEES_PATH.exec(path);
  if (issue === null) return undefined;
  const issueNumber = Number(issue[1]);
  if (call.method === "POST") {
    const assignees = sentLogins(call.body).map((login) => ghAssignee(login));
    return json(201, ghIssue(issueNumber, "[CUI-0] assigned", { assignees }));
  }
  return call.method === "DELETE"
    ? json(200, ghIssue(issueNumber, "[CUI-0] unassigned", { assignees: [] }))
    : undefined;
}

function githubAnswer(call: RecordedCall, world: World, counters: Counters): Response {
  const answer =
    milestoneAnswer(call, world, counters) ?? issueAnswer(call, world, counters) ?? assigneeAnswer(call, world);
  return answer ?? json(404, { message: "Not Found" });
}

function defaultAnswer(call: RecordedCall, world: World, counters: Counters): Response {
  if (call.url.origin === GITHUB_ORIGIN) return githubAnswer(call, world, counters);
  const isIssueScan = call.url.origin === YOUTRACK_BASE_URL && call.url.pathname === "/api/issues";
  return isIssueScan && call.method === "GET"
    ? youtrackPage(call.url, world.youtrackRows ?? [])
    : json(404, { error: "not_found" });
}

function recordingLogger(lines: LogLine[]): Logger {
  return {
    info: (message) => {
      lines.push({ level: "info", message });
    },
    warn: (message) => {
      lines.push({ level: "warn", message });
    },
    error: (message) => {
      lines.push({ level: "error", message });
    },
  };
}

export function harness(world: World = {}): Harness {
  const calls: RecordedCall[] = [];
  const lines: LogLine[] = [];
  const sleeps: number[] = [];
  let lastIssue = LAST_EXISTING_NUMBER;
  let lastMilestone = LAST_EXISTING_MILESTONE;
  const counters: Counters = { nextIssue: () => (lastIssue += 1), nextMilestone: () => (lastMilestone += 1) };
  const fakeFetch: typeof fetch = (input, init) => {
    const call = recordCall(input, init);
    const attempt = calls.filter((c) => c.method === call.method && c.url.href === call.url.href).length;
    calls.push(call);
    const answer = world.override?.(call, attempt) ?? defaultAnswer(call, world, counters);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  // Virtual clock: starts at world.startTime (0) and moves only when the code under test sleeps.
  let clock = world.startTime ?? 0;
  const sleep = (ms: number): Promise<void> => {
    sleeps.push(ms);
    clock += ms;
    return Promise.resolve();
  };
  const deps: SyncDeps = {
    fetch: fakeFetch,
    sleep,
    log: recordingLogger(lines),
    now: () => clock,
    deadline: world.deadline ?? Number.POSITIVE_INFINITY,
  };
  return { deps, calls, lines, sleeps };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/** "POST /repos/acme/mirror/issues" etc. for every non-GET call, in order. */
export function writeCalls(calls: readonly RecordedCall[]): readonly string[] {
  return calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.url.pathname}`);
}

export function messages(lines: readonly LogLine[], level?: LogLine["level"]): readonly string[] {
  return lines.filter((line) => level === undefined || line.level === level).map((line) => line.message);
}

export function lastLine(lines: readonly LogLine[]): LogLine {
  const line = lines.at(-1);
  assert.ok(line, "expected at least one log line");
  return line;
}

export function bodyOf(call: RecordedCall | undefined): JsonObject {
  assert.ok(call, "expected the call to exist");
  assert.ok(isJsonObject(call.body), "expected a JSON object body");
  return call.body;
}

export function titleOf(call: RecordedCall): string {
  const title = isJsonObject(call.body) ? call.body["title"] : undefined;
  return isString(title) ? title : "";
}

export function isCreate(call: RecordedCall): boolean {
  return call.method === "POST" && call.url.pathname === ISSUES_PATH;
}

/** The body of the only call with `method` to `path`; fails the test unless exactly one exists. */
export function onlyBody(calls: readonly RecordedCall[], method: string, path: string): JsonObject {
  const matching = calls.filter((call) => call.method === method && call.url.pathname === path);
  assert.equal(matching.length, 1, `expected exactly one ${method} ${path}`);
  return bodyOf(matching[0]);
}

/** The bodies of every call with `method` to `path`, in order. */
export function bodiesOf(calls: readonly RecordedCall[], method: string, path: string): readonly JsonObject[] {
  return calls.filter((call) => call.method === method && call.url.pathname === path).map((call) => bodyOf(call));
}

/** The bodies of every issue create, in order. */
export function createBodies(calls: readonly RecordedCall[]): readonly JsonObject[] {
  return calls.filter(isCreate).map((call) => bodyOf(call));
}

export function pauses(sleeps: readonly number[]): number {
  return sleeps.filter((ms) => ms === WRITE_PAUSE_MS).length;
}

/** The error runSync rejected with; fails the test if it resolved. */
export async function rejection(promise: Promise<RunSummary>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error, "expected an Error");
    return error;
  }
  return assert.fail("expected runSync to reject");
}

/** A RunSummary with zeros for every field not given; `skipped` defaults to filtered + unchanged. */
export function summary(fields: Partial<RunSummary>): RunSummary {
  return {
    dryRun: false,
    scanned: 0,
    created: 0,
    closed: 0,
    reopened: 0,
    updated: 0,
    assigneesAdded: 0,
    assigneesRemoved: 0,
    milestonesCreated: 0,
    milestonesClosed: 0,
    skipped: (fields.filtered ?? 0) + (fields.unchanged ?? 0),
    capped: 0,
    failed: 0,
    filtered: 0,
    unchanged: 0,
    labelsReAdded: 0,
    fetches: 0,
    ...fields,
  };
}
