/**
 * Shared fixtures for the runSync tests (test/sync*.test.ts): config, YouTrack rows and
 * GitHub issues, a fake fetch that routes by method + URL to canned answers and records
 * every call, a recording logger and sleep, and assertion helpers.
 */

import assert from "node:assert/strict";

import type { Config } from "../src/config.ts";
import { MIRROR_LABEL } from "../src/github.ts";
import { isJsonArray, isJsonObject, isString, parseJson } from "../src/json.ts";
import type { JsonObject, JsonValue } from "../src/json.ts";
import { WRITE_PAUSE_MS } from "../src/sync.ts";
import type { Logger, RunSummary, SyncDeps } from "../src/sync.ts";

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
export const RESOLVED_AT = 1_789_644_365_309;
const UPDATED_AT = 1_790_254_466_396;
/** The fake numbers new GitHub issues from here on: the first create gets #101. */
export const LAST_EXISTING_NUMBER = 100;

const BASE_CONFIG: Config = {
  githubToken: GITHUB_TOKEN,
  githubOwner: "acme",
  githubRepo: "mirror",
  youtrackBaseUrl: YOUTRACK_BASE_URL,
  youtrackToken: YOUTRACK_TOKEN,
  youtrackProject: "CUI",
  titlePrefix: "[team]",
  maxWritesPerRun: 30,
  dryRun: false,
};

export function config(overrides: Partial<Config> = {}): Config {
  return { ...BASE_CONFIG, ...overrides };
}

type RowOptions = {
  readonly summary?: string;
  readonly resolved?: number | null;
  readonly description?: string | null;
};

/** A YouTrack /api/issues row shaped like the live ones in docs/00. */
export function ytRow(numberInProject: number, options: RowOptions = {}): JsonObject {
  const n = String(numberInProject);
  return {
    idReadable: `CUI-${n}`,
    numberInProject,
    summary: options.summary ?? `[team] Task ${n}`,
    description: options.description === undefined ? `Details of task ${n}` : options.description,
    resolved: options.resolved ?? null,
    updated: UPDATED_AT,
    $type: "Issue",
  };
}

type IssueOptions = {
  readonly state?: "open" | "closed";
  readonly labels?: readonly string[];
  readonly pullRequest?: boolean;
};

export function ghIssue(issueNumber: number, title: string, options: IssueOptions = {}): JsonObject {
  return {
    number: issueNumber,
    title,
    state: options.state ?? "open",
    labels: (options.labels ?? [MIRROR_LABEL]).map((name) => ({ name })),
    ...(options.pullRequest === true ? { pull_request: { url: `${GITHUB_ORIGIN}/pulls/${String(issueNumber)}` } } : {}),
  };
}

/** Open, labelled mirrors #101.. of resolved YouTrack issues YT-1..: each one needs a close. */
export function openMirrorsOfResolved(count: number): {
  readonly githubIssues: JsonObject[];
  readonly youtrackRows: JsonObject[];
} {
  const numbers = Array.from({ length: count }, (_, index) => index + 1);
  return {
    githubIssues: numbers.map((n) => ghIssue(LAST_EXISTING_NUMBER + n, `[YT-${String(n)}] [team] Task ${String(n)}`)),
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

export type World = {
  readonly githubIssues?: readonly JsonObject[];
  readonly youtrackRows?: readonly JsonObject[];
  /** Labels a create answers with; by default the requested ones ([] = silently dropped). */
  readonly createdLabels?: readonly string[];
  readonly override?: Override;
  /** SyncDeps.deadline on the virtual clock; by default never reached. */
  readonly deadline?: number;
};

export type LogLine = { readonly level: "info" | "warn" | "error"; readonly message: string };

export type Harness = {
  readonly deps: SyncDeps;
  readonly calls: readonly RecordedCall[];
  readonly lines: readonly LogLine[];
  readonly sleeps: readonly number[];
};

/**
 * YT-1 unresolved, no mirror       -> create
 * YT-2 resolved, no mirror         -> unchanged (never mirrored, decision R9)
 * YT-3 resolved, open mirror #12   -> close
 * YT-4 not "[team]"                -> filtered
 * YT-5 unresolved, open mirror #13 -> unchanged
 * YT-6 resolved, closed mirror #14 -> unchanged
 * PR #15 is titled "[YT-1]" but is not a mirror.
 */
export const MIXED_WORLD: World = {
  githubIssues: [
    ghIssue(12, "[YT-3] [team] Task 3"),
    ghIssue(13, "[YT-5] [team] Task 5"),
    ghIssue(14, "[YT-6] [team] Task 6", { state: "closed" }),
    ghIssue(15, "[YT-1] Some pull request", { pullRequest: true, labels: [] }),
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

function createdIssue(body: JsonValue | undefined, issueNumber: number, createdLabels?: readonly string[]): JsonObject {
  const request = isJsonObject(body) ? body : {};
  const title = request["title"];
  const requested = request["labels"];
  const labels = createdLabels ?? (isJsonArray(requested) ? requested.filter(isString) : []);
  return ghIssue(issueNumber, isString(title) ? title : "", { labels });
}

function githubAnswer(call: RecordedCall, world: World, nextNumber: () => number): Response {
  const path = call.url.pathname;
  if (path === ISSUES_PATH && call.method === "GET") return json(200, world.githubIssues ?? []);
  if (path === ISSUES_PATH && call.method === "POST") {
    return json(201, createdIssue(call.body, nextNumber(), world.createdLabels));
  }
  if (call.method === "POST" && LABELS_PATH.test(path)) return json(200, [{ name: MIRROR_LABEL }]);
  const issue = ISSUE_PATH.exec(path);
  if (call.method === "PATCH" && issue !== null) {
    return json(200, ghIssue(Number(issue[1]), "[YT-0] closed", { state: "closed" }));
  }
  return json(404, { message: "Not Found" });
}

function defaultAnswer(call: RecordedCall, world: World, nextNumber: () => number): Response {
  if (call.url.origin === GITHUB_ORIGIN) return githubAnswer(call, world, nextNumber);
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
  let lastNumber = LAST_EXISTING_NUMBER;
  const nextNumber = (): number => (lastNumber += 1);
  const fakeFetch: typeof fetch = (input, init) => {
    const call = recordCall(input, init);
    const attempt = calls.filter((c) => c.method === call.method && c.url.href === call.url.href).length;
    calls.push(call);
    const answer = world.override?.(call, attempt) ?? defaultAnswer(call, world, nextNumber);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  // Virtual clock: starts at 0 and moves only when the code under test sleeps.
  let clock = 0;
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
