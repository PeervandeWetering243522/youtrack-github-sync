import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Config } from "../src/config.ts";
import { MIRROR_LABEL } from "../src/github.ts";
import { DEFAULT_MAX_FETCHES, DEFAULT_RETRY_DELAY_MS, HttpError, USER_AGENT } from "../src/http.ts";
import { isJsonArray, isJsonObject, isString, parseJson } from "../src/json.ts";
import type { JsonObject, JsonValue } from "../src/json.ts";
import { formatSummary, runSync, SyncFailedError, WRITE_PAUSE_MS } from "../src/sync.ts";
import type { Logger, RunSummary, SyncDeps } from "../src/sync.ts";

// node:test's describe/it return promises that the runner itself tracks; `void`
// marks them as handled for no-floating-promises without disabling the rule.

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GITHUB_TOKEN = "ghp_fakeGithubToken0123456789abcdefABCDEF";
const YOUTRACK_TOKEN = "perm:fake.youtrack.token.0123456789";
const YOUTRACK_BASE_URL = "https://youtrack.example.test";
const GITHUB_ORIGIN = "https://api.github.com";
const ISSUES_PATH = "/repos/acme/mirror/issues";
const ISSUE_PATH = /^\/repos\/acme\/mirror\/issues\/(\d+)$/;
const LABELS_PATH = /^\/repos\/acme\/mirror\/issues\/\d+\/labels$/;
const RESOLVED_AT = 1_789_644_365_309;
const UPDATED_AT = 1_790_254_466_396;
/** The fake numbers new GitHub issues from here on: the first create gets #101. */
const LAST_EXISTING_NUMBER = 100;

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

function config(overrides: Partial<Config> = {}): Config {
  return { ...BASE_CONFIG, ...overrides };
}

type RowOptions = {
  readonly summary?: string;
  readonly resolved?: number | null;
  readonly description?: string | null;
};

/** A YouTrack /api/issues row shaped like the live ones in docs/00. */
function ytRow(numberInProject: number, options: RowOptions = {}): JsonObject {
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

function ghIssue(issueNumber: number, title: string, options: IssueOptions = {}): JsonObject {
  return {
    number: issueNumber,
    title,
    state: options.state ?? "open",
    labels: (options.labels ?? [MIRROR_LABEL]).map((name) => ({ name })),
    ...(options.pullRequest === true ? { pull_request: { url: `${GITHUB_ORIGIN}/pulls/${String(issueNumber)}` } } : {}),
  };
}

/** Open, labelled mirrors #101.. of resolved YouTrack issues YT-1..: each one needs a close. */
function openMirrorsOfResolved(count: number): { readonly githubIssues: JsonObject[]; readonly youtrackRows: JsonObject[] } {
  const numbers = Array.from({ length: count }, (_, index) => index + 1);
  return {
    githubIssues: numbers.map((n) => ghIssue(LAST_EXISTING_NUMBER + n, `[YT-${String(n)}] [team] Task ${String(n)}`)),
    youtrackRows: numbers.map((n) => ytRow(n, { resolved: RESOLVED_AT })),
  };
}

/**
 * YT-1 unresolved, no mirror       -> create
 * YT-2 resolved, no mirror         -> create + close
 * YT-3 resolved, open mirror #12   -> close
 * YT-4 not "[team]"                -> filtered
 * YT-5 unresolved, open mirror #13 -> unchanged
 * YT-6 resolved, closed mirror #14 -> unchanged
 * PR #15 is titled "[YT-1]" but is not a mirror.
 */
const MIXED_WORLD: World = {
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

// ---------------------------------------------------------------------------
// Fake fetch: routes by method + URL to canned GitHub / YouTrack answers and records every call
// ---------------------------------------------------------------------------

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

type RecordedCall = {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: JsonValue | undefined;
};

/** Replaces the default answer; `attempt` counts earlier calls with the same method and URL. */
type Override = (call: RecordedCall, attempt: number) => Response | Error | undefined;

type World = {
  readonly githubIssues?: readonly JsonObject[];
  readonly youtrackRows?: readonly JsonObject[];
  /** Labels a create answers with; by default the requested ones ([] = silently dropped). */
  readonly createdLabels?: readonly string[];
  readonly override?: Override;
};

type LogLine = { readonly level: "info" | "warn" | "error"; readonly message: string };

type Harness = {
  readonly deps: SyncDeps;
  readonly calls: readonly RecordedCall[];
  readonly lines: readonly LogLine[];
  readonly sleeps: readonly number[];
};

function json(status: number, body: JsonValue): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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

function harness(world: World = {}): Harness {
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
  const log: Logger = {
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
  const sleep = (ms: number): Promise<void> => {
    sleeps.push(ms);
    return Promise.resolve();
  };
  return { deps: { fetch: fakeFetch, sleep, log }, calls, lines, sleeps };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/** "POST /repos/acme/mirror/issues" etc. for every non-GET call, in order. */
function writeCalls(calls: readonly RecordedCall[]): readonly string[] {
  return calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.url.pathname}`);
}

function messages(lines: readonly LogLine[], level?: LogLine["level"]): readonly string[] {
  return lines.filter((line) => level === undefined || line.level === level).map((line) => line.message);
}

function lastLine(lines: readonly LogLine[]): LogLine {
  const line = lines.at(-1);
  assert.ok(line, "expected at least one log line");
  return line;
}

function bodyOf(call: RecordedCall | undefined): JsonObject {
  assert.ok(call, "expected the call to exist");
  assert.ok(isJsonObject(call.body), "expected a JSON object body");
  return call.body;
}

function titleOf(call: RecordedCall): string {
  const title = isJsonObject(call.body) ? call.body["title"] : undefined;
  return isString(title) ? title : "";
}

function isCreate(call: RecordedCall): boolean {
  return call.method === "POST" && call.url.pathname === ISSUES_PATH;
}

function pauses(sleeps: readonly number[]): number {
  return sleeps.filter((ms) => ms === WRITE_PAUSE_MS).length;
}

/** The error runSync rejected with; fails the test if it resolved. */
async function rejection(promise: Promise<RunSummary>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error, "expected an Error");
    return error;
  }
  return assert.fail("expected runSync to reject");
}

function summary(fields: Partial<RunSummary>): RunSummary {
  return {
    dryRun: false,
    scanned: 0,
    filtered: 0,
    unchanged: 0,
    created: 0,
    closed: 0,
    labelsReAdded: 0,
    capped: 0,
    failed: 0,
    fetches: 0,
    ...fields,
  };
}

// ---------------------------------------------------------------------------
// formatSummary
// ---------------------------------------------------------------------------

void describe("formatSummary", () => {
  const sample = summary({ dryRun: true, scanned: 29, filtered: 19, unchanged: 4, created: 5, closed: 3, fetches: 2 });

  void it("prints every field in the documented order after the tag and outcome", () => {
    // Act
    const line = formatSummary(sample, "ok");

    // Assert
    assert.equal(
      line,
      "yt-gh-sync ok dryRun=true scanned=29 filtered=19 unchanged=4 created=5 closed=3 labelsReAdded=0 capped=0 failed=0 fetches=2",
    );
  });

  void it("prints the failed outcome and non-zero failure counts", () => {
    // Act
    const line = formatSummary({ ...sample, dryRun: false, failed: 2, capped: 1 }, "failed");

    // Assert
    assert.match(line, /^yt-gh-sync failed dryRun=false /);
    assert.match(line, / capped=1 failed=2 fetches=2$/);
  });
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

void describe("runSync in dry run", () => {
  void it("sends only GETs and still reports what would be created and closed", async () => {
    // Arrange
    const { deps, calls } = harness(MIXED_WORLD);

    // Act
    const result = await runSync(config({ dryRun: true }), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), []);
    assert.ok(calls.every((call) => call.method === "GET"));
    assert.deepEqual(
      result,
      summary({ dryRun: true, scanned: 6, filtered: 1, unchanged: 2, created: 2, closed: 2, fetches: 2 }),
    );
  });

  void it("logs each intended write with its title, then the ok summary", async () => {
    // Arrange
    const { deps, lines } = harness(MIXED_WORLD);

    // Act
    const result = await runSync(config({ dryRun: true }), deps);

    // Assert
    assert.deepEqual(messages(lines), [
      "[dry-run] would create YT-1: [YT-1] [team] Task 1",
      "[dry-run] would create YT-2: [YT-2] [team] Task 2",
      "[dry-run] would close YT-2 right after creating it",
      "[dry-run] would close YT-3 #12",
      formatSummary(result, "ok"),
    ]);
    assert.equal(lastLine(lines).level, "info");
  });

  void it("never sleeps, since nothing is written", async () => {
    // Arrange
    const { deps, sleeps } = harness(MIXED_WORLD);

    // Act
    await runSync(config({ dryRun: true }), deps);

    // Assert
    assert.deepEqual(sleeps, []);
  });

  void it("applies the write cap to the preview as well", async () => {
    // Arrange: YT-1 (1 write) fits, the YT-2 create+close pair (2 writes) does not.
    const { deps, calls } = harness(MIXED_WORLD);

    // Act
    const result = await runSync(config({ dryRun: true, maxWritesPerRun: 2 }), deps);

    // Assert
    assert.equal(result.created, 1);
    assert.equal(result.closed, 0);
    assert.equal(result.capped, 2);
    assert.deepEqual(writeCalls(calls), []);
  });
});

// ---------------------------------------------------------------------------
// Real mode
// ---------------------------------------------------------------------------

void describe("runSync with writes enabled", () => {
  void it("creates unresolved, creates+closes resolved and closes open mirrors, oldest first", async () => {
    // Arrange
    const { deps, calls } = harness(MIXED_WORLD);

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [
      `POST ${ISSUES_PATH}`,
      `POST ${ISSUES_PATH}`,
      `PATCH ${ISSUES_PATH}/102`,
      `PATCH ${ISSUES_PATH}/12`,
    ]);
    assert.deepEqual(calls.filter(isCreate).map(titleOf), ["[YT-1] [team] Task 1", "[YT-2] [team] Task 2"]);
    assert.deepEqual(
      result,
      summary({ scanned: 6, filtered: 1, unchanged: 2, created: 2, closed: 2, fetches: 6 }),
    );
  });

  void it("sends the mirror title, body and label on create and completed on close", async () => {
    // Arrange
    const { deps, calls } = harness(MIXED_WORLD);

    // Act
    await runSync(config(), deps);

    // Assert
    const create = bodyOf(calls.find(isCreate));
    assert.equal(create["title"], "[YT-1] [team] Task 1");
    assert.deepEqual(create["labels"], [MIRROR_LABEL]);
    assert.equal(
      create["body"],
      `Details of task 1\n\n---\nMirrored from YouTrack: ${YOUTRACK_BASE_URL}/issue/CUI-1`,
    );
    const close = bodyOf(calls.find((call) => call.method === "PATCH"));
    assert.deepEqual(close, { state: "closed", state_reason: "completed" });
  });

  void it("logs one line per write and ends with the ok summary", async () => {
    // Arrange
    const { deps, lines } = harness(MIXED_WORLD);

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(messages(lines), [
      "create YT-1 -> #101",
      "create YT-2 -> #102",
      "close YT-2 #102",
      "close YT-3 #12",
      formatSummary(result, "ok"),
    ]);
  });

  void it("pauses WRITE_PAUSE_MS between writes, not before the first one", async () => {
    // Arrange
    const { deps, sleeps } = harness(MIXED_WORLD);

    // Act
    await runSync(config(), deps);

    // Assert: 4 writes, 3 gaps.
    assert.deepEqual(sleeps, [WRITE_PAUSE_MS, WRITE_PAUSE_MS, WRITE_PAUSE_MS]);
  });

  void it("does not sleep at all for a single write", async () => {
    // Arrange
    const { deps, sleeps, calls } = harness({ youtrackRows: [ytRow(1)] });

    // Act
    await runSync(config(), deps);

    // Assert
    assert.equal(writeCalls(calls).length, 1);
    assert.deepEqual(sleeps, []);
  });

  void it("sends YouTrack only GET /api/issues with the project query and its own token", async () => {
    // Arrange
    const { deps, calls } = harness(MIXED_WORLD);

    // Act
    await runSync(config(), deps);

    // Assert
    const youtrackCalls = calls.filter((call) => call.url.origin === YOUTRACK_BASE_URL);
    assert.equal(youtrackCalls.length, 1);
    for (const call of youtrackCalls) {
      assert.equal(call.method, "GET");
      assert.equal(call.url.pathname, "/api/issues");
      assert.equal(call.url.searchParams.get("query"), "project: CUI sort by: {issue id} asc");
      assert.equal(call.headers.get("authorization"), `Bearer ${YOUTRACK_TOKEN}`);
    }
  });

  void it("sends the GitHub token only to GitHub and a User-Agent on every call", async () => {
    // Arrange
    const { deps, calls } = harness(MIXED_WORLD);

    // Act
    await runSync(config(), deps);

    // Assert
    for (const call of calls) {
      const expectedToken = call.url.origin === GITHUB_ORIGIN ? GITHUB_TOKEN : YOUTRACK_TOKEN;
      assert.equal(call.headers.get("authorization"), `Bearer ${expectedToken}`);
      assert.equal(call.headers.get("user-agent"), USER_AGENT);
    }
    assert.ok(calls.every((call) => call.url.origin === GITHUB_ORIGIN || call.url.origin === YOUTRACK_BASE_URL));
  });

  void it("scans every YouTrack page until a short one", async () => {
    // Arrange: 101 rows = a full page of 100 plus a page of 1.
    const rows = Array.from({ length: 101 }, (_, index) => ytRow(index + 1, { summary: "no prefix" }));
    const { deps, calls } = harness({ youtrackRows: rows });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    const skips = calls
      .filter((call) => call.url.origin === YOUTRACK_BASE_URL)
      .map((call) => call.url.searchParams.get("$skip"));
    assert.deepEqual(skips, ["0", "100"]);
    assert.equal(result.scanned, 101);
    assert.equal(result.filtered, 101);
  });

  void it("logs mirror index warnings and treats an unlabelled title match as the mirror", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      githubIssues: [ghIssue(20, "[YT-1] [team] Task 1", { labels: [] })],
      youtrackRows: [ytRow(1)],
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), []);
    assert.equal(result.unchanged, 1);
    const warnings = messages(lines, "warn");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /YT-1: #20 matched by title only/);
  });

  void it("mirrors only summaries starting with the configured prefix, ignoring case", async () => {
    // Arrange
    const { deps, calls } = harness({
      youtrackRows: [
        ytRow(1, { summary: "[OPS] Deploy" }),
        ytRow(2, { summary: "[team] Not ours" }),
        ytRow(3, { summary: "ops: missing brackets" }),
        ytRow(4, { summary: "  [ops] leading spaces" }),
      ],
    });

    // Act
    const result = await runSync(config({ titlePrefix: "[ops]" }), deps);

    // Assert
    assert.deepEqual(calls.filter(isCreate).map(titleOf), ["[YT-1] [OPS] Deploy", "[YT-4] [ops] leading spaces"]);
    assert.equal(result.filtered, 2);
    assert.equal(result.created, 2);
  });
});

// ---------------------------------------------------------------------------
// Label re-add (decision A5)
// ---------------------------------------------------------------------------

void describe("runSync label re-add", () => {
  void it("re-adds the label when the 201 lacks it, before closing a resolved issue", async () => {
    // Arrange
    const { deps, calls, lines } = harness({ youtrackRows: [ytRow(1, { resolved: RESOLVED_AT })], createdLabels: [] });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [
      `POST ${ISSUES_PATH}`,
      `POST ${ISSUES_PATH}/101/labels`,
      `PATCH ${ISSUES_PATH}/101`,
    ]);
    assert.deepEqual(bodyOf(calls.find((call) => LABELS_PATH.test(call.url.pathname))), { labels: [MIRROR_LABEL] });
    assert.equal(result.labelsReAdded, 1);
    assert.equal(result.closed, 1);
    assert.ok(messages(lines).includes("label YT-1 #101"));
  });

  void it("accepts the label in another case without re-adding it", async () => {
    // Arrange
    const { deps, calls } = harness({ youtrackRows: [ytRow(1)], createdLabels: ["YouTrack"] });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`]);
    assert.equal(result.labelsReAdded, 0);
  });

  void it("keeps the pair's close ahead of the re-add when only two writes are allowed", async () => {
    // Arrange
    const { deps, calls, lines } = harness({ youtrackRows: [ytRow(1, { resolved: RESOLVED_AT })], createdLabels: [] });

    // Act
    const result = await runSync(config({ maxWritesPerRun: 2 }), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`, `PATCH ${ISSUES_PATH}/101`]);
    assert.equal(result.labelsReAdded, 0);
    assert.equal(result.closed, 1);
    assert.match(messages(lines, "warn")[0] ?? "", /YT-1 #101 was created without the "youtrack" label .*write cap/);
  });

  void it("counts the re-add as a write, which can cap a later action", async () => {
    // Arrange
    const { deps, calls } = harness({ youtrackRows: [ytRow(1), ytRow(2)], createdLabels: [] });

    // Act
    const result = await runSync(config({ maxWritesPerRun: 2 }), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`, `POST ${ISSUES_PATH}/101/labels`]);
    assert.equal(result.created, 1);
    assert.equal(result.labelsReAdded, 1);
    assert.equal(result.capped, 1);
  });

  void it("records a failed re-add, still closes, and fails the run", async () => {
    // Arrange
    const { deps, calls } = harness({
      youtrackRows: [ytRow(1, { resolved: RESOLVED_AT })],
      createdLabels: [],
      override: (call) => (LABELS_PATH.test(call.url.pathname) ? json(422, { message: "Label does not exist" }) : undefined),
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.equal(error.failures.length, 1);
    assert.match(error.failures[0] ?? "", /^label YT-1 #101 failed: POST .* -> HTTP 422/);
    assert.equal(error.summary.closed, 1);
    assert.deepEqual(writeCalls(calls).at(-1), `PATCH ${ISSUES_PATH}/101`);
  });
});

// ---------------------------------------------------------------------------
// Write cap
// ---------------------------------------------------------------------------

void describe("runSync write cap", () => {
  void it("stops at the first action that does not fit and never splits a create+close pair", async () => {
    // Arrange: YT-1 create (1) fits; YT-2 create+close (2) would make 3; YT-3 comes after it.
    const { deps, calls } = harness({ youtrackRows: [ytRow(1), ytRow(2, { resolved: RESOLVED_AT }), ytRow(3)] });

    // Act
    const result = await runSync(config({ maxWritesPerRun: 2 }), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`]);
    assert.equal(result.created, 1);
    assert.equal(result.capped, 2);
    assert.equal(result.failed, 0);
  });

  void it("writes nothing with a cap of zero", async () => {
    // Arrange
    const { deps, calls } = harness(MIXED_WORLD);

    // Act
    const result = await runSync(config({ maxWritesPerRun: 0 }), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), []);
    assert.equal(result.capped, 3);
  });
});

// ---------------------------------------------------------------------------
// Write failures (decision A10)
// ---------------------------------------------------------------------------

void describe("runSync write failures", () => {
  const failFirstCreate: Override = (call) =>
    isCreate(call) && titleOf(call).startsWith("[YT-1]") ? json(422, { message: "Validation Failed" }) : undefined;

  void it("records a failed create, skips its close, runs the rest, then throws", async () => {
    // Arrange: YT-1 is resolved, so its failed create must not be followed by a close.
    const world: World = {
      githubIssues: [ghIssue(12, "[YT-3] [team] Task 3")],
      youtrackRows: [ytRow(1, { resolved: RESOLVED_AT }), ytRow(2), ytRow(3, { resolved: RESOLVED_AT })],
      override: failFirstCreate,
    };
    const { deps, calls } = harness(world);

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`, `POST ${ISSUES_PATH}`, `PATCH ${ISSUES_PATH}/12`]);
    assert.equal(error.failures.length, 1);
    assert.match(error.failures[0] ?? "", /^create YT-1 failed: POST https:\/\/api\.github\.com\/.* -> HTTP 422/);
    assert.deepEqual(error.summary, summary({ scanned: 3, created: 1, closed: 1, failed: 1, fetches: 5 }));
  });

  void it("logs the failure and then the failed summary as the last line", async () => {
    // Arrange
    const { deps, lines } = harness({ youtrackRows: [ytRow(1), ytRow(2)], override: failFirstCreate });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(lastLine(lines), { level: "error", message: formatSummary(error.summary, "failed") });
    assert.match(messages(lines, "error")[0] ?? "", /^create YT-1 failed: /);
    assert.ok(messages(lines, "info").includes("create YT-2 -> #101"));
  });

  void it("records a failed close and continues", async () => {
    // Arrange
    const { deps, calls } = harness({
      githubIssues: [ghIssue(12, "[YT-1] [team] Task 1"), ghIssue(13, "[YT-2] [team] Task 2")],
      youtrackRows: [ytRow(1, { resolved: RESOLVED_AT }), ytRow(2, { resolved: RESOLVED_AT })],
      override: (call) => (call.url.pathname.endsWith("/12") ? json(404, { message: "Not Found" }) : undefined),
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.match(error.failures[0] ?? "", /^close YT-1 #12 failed: PATCH .* -> HTTP 404/);
    assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/12`, `PATCH ${ISSUES_PATH}/13`]);
    assert.equal(error.summary.closed, 1);
  });

  void it("never retries a create that failed on the network", async () => {
    // Arrange
    const { deps, calls } = harness({
      youtrackRows: [ytRow(1)],
      override: (call) => (isCreate(call) ? new TypeError("fetch failed") : undefined),
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.equal(calls.filter(isCreate).length, 1);
    assert.match(error.failures[0] ?? "", /^create YT-1 failed: POST .* failed: fetch failed/);
  });

  void it("retries a close once after a 5xx and counts it as done", async () => {
    // Arrange
    const { deps, calls, sleeps } = harness({
      githubIssues: [ghIssue(12, "[YT-1] [team] Task 1")],
      youtrackRows: [ytRow(1, { resolved: RESOLVED_AT })],
      override: (call, attempt) => (call.method === "PATCH" && attempt === 0 ? json(503, { message: "busy" }) : undefined),
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.equal(writeCalls(calls).length, 2);
    assert.equal(result.closed, 1);
    assert.equal(result.failed, 0);
    assert.deepEqual(sleeps, [DEFAULT_RETRY_DELAY_MS]);
  });
});

// ---------------------------------------------------------------------------
// Read failures
// ---------------------------------------------------------------------------

void describe("runSync read failures", () => {
  void it("rethrows a GitHub list error after a failed summary, before touching YouTrack", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      ...MIXED_WORLD,
      override: (call) => (call.url.origin === GITHUB_ORIGIN ? json(401, { message: "Bad credentials" }) : undefined),
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 401);
    assert.equal(calls.length, 1);
    assert.deepEqual(lastLine(lines), { level: "error", message: formatSummary(summary({ fetches: 1 }), "failed") });
  });

  void it("rethrows a YouTrack 400 and writes nothing", async () => {
    // Arrange
    const { deps, calls, lines } = harness({
      ...MIXED_WORLD,
      override: (call) =>
        call.url.origin === YOUTRACK_BASE_URL ? json(400, { error: "invalid_query", error_description: "bad" }) : undefined,
    });

    // Act
    const error = await rejection(runSync(config({ dryRun: true }), deps));

    // Assert
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 400);
    assert.deepEqual(writeCalls(calls), []);
    const failed = formatSummary(summary({ dryRun: true, fetches: 2 }), "failed");
    assert.deepEqual(lastLine(lines), { level: "error", message: failed });
  });

  void it("rethrows a YouTrack row that lacks a requested field", async () => {
    // Arrange
    const row = Object.fromEntries(Object.entries(ytRow(1)).filter(([key]) => key !== "resolved"));
    const { deps, calls } = harness({ youtrackRows: [row] });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.equal(error.name, "YouTrackSchemaError");
    assert.deepEqual(writeCalls(calls), []);
  });
});

// ---------------------------------------------------------------------------
// Fetch guard (Workers Free: 50 subrequests; the client allows DEFAULT_MAX_FETCHES)
// ---------------------------------------------------------------------------

void describe("runSync fetch guard", () => {
  /** Every PATCH fails once with a 502 and succeeds on the retry: 2 fetches per close. */
  const flakyPatch: Override = (call, attempt) =>
    call.method === "PATCH" && attempt === 0 ? json(502, { message: "Bad Gateway" }) : undefined;

  void it("caps the remaining actions instead of failing when the budget runs out", async () => {
    // Arrange: 2 reads + 21 closes x 2 fetches = 44; close 22 spends the 45th and cannot retry.
    const { deps, calls, lines } = harness({ ...openMirrorsOfResolved(25), override: flakyPatch });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.equal(calls.length, DEFAULT_MAX_FETCHES);
    assert.deepEqual(result, summary({ scanned: 25, closed: 21, capped: 4, fetches: DEFAULT_MAX_FETCHES }));
    assert.ok(messages(lines, "warn").some((line) => line.includes(`fetch guard of ${String(DEFAULT_MAX_FETCHES)}`)));
    assert.equal(lastLine(lines).level, "info");
  });

  void it("caps a create+close pair whose close no longer fits, and does not pause for it", async () => {
    // Arrange: 44 fetches for 21 closes, the YT-22 create takes the 45th.
    const world = openMirrorsOfResolved(21);
    const { deps, sleeps } = harness({
      githubIssues: world.githubIssues,
      youtrackRows: [...world.youtrackRows, ytRow(22, { resolved: RESOLVED_AT })],
      override: flakyPatch,
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(result, summary({ scanned: 22, created: 1, closed: 21, capped: 1, fetches: DEFAULT_MAX_FETCHES }));
    // 22 writes were sent (21 gaps); the refused close gets no pause.
    assert.equal(pauses(sleeps), 21);
  });

  void it("warns when the budget runs out on a label re-add with no close pending", async () => {
    // Arrange
    const world = openMirrorsOfResolved(21);
    const { deps, lines } = harness({
      githubIssues: world.githubIssues,
      youtrackRows: [...world.youtrackRows, ytRow(22)],
      createdLabels: [],
      override: flakyPatch,
    });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.equal(result.created, 1);
    assert.equal(result.labelsReAdded, 0);
    assert.equal(result.capped, 0);
    assert.equal(result.failed, 0);
    assert.ok(messages(lines, "warn").some((line) => /YT-22 #101 .*not re-added \(fetch guard reached\)/.test(line)));
  });
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

void describe("runSync secrets", () => {
  /** Issue text and an error body that both contain the tokens. */
  const leakyWorld: World = {
    youtrackRows: [ytRow(1, { summary: `[team] leaked ${GITHUB_TOKEN}` }), ytRow(2)],
    override: (call) =>
      isCreate(call) && titleOf(call).startsWith("[YT-2]")
        ? json(422, { message: `bad ${YOUTRACK_TOKEN} and ${GITHUB_TOKEN}` })
        : undefined,
  };

  function assertNoTokens(texts: readonly string[]): void {
    for (const text of texts) {
      assert.ok(!text.includes(GITHUB_TOKEN), `GitHub token leaked: ${text.slice(0, 40)}`);
      assert.ok(!text.includes(YOUTRACK_TOKEN), `YouTrack token leaked: ${text.slice(0, 40)}`);
    }
  }

  void it("never logs a token, even when issue text or error bodies contain one", async () => {
    // Arrange
    const { deps, lines } = harness(leakyWorld);

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assertNoTokens([...messages(lines), error.message, ...error.failures]);
    assert.ok(messages(lines, "error").some((line) => line.includes("[redacted]")));
  });

  void it("never logs a token in dry run", async () => {
    // Arrange
    const { deps, lines } = harness(leakyWorld);

    // Act
    await runSync(config({ dryRun: true }), deps);

    // Assert
    assertNoTokens(messages(lines));
    assert.ok(messages(lines).includes("[dry-run] would create YT-1: [YT-1] [team] leaked [redacted]"));
  });

  void it("never logs a token when a read fails", async () => {
    // Arrange
    const { deps, lines } = harness({
      override: (call) => (call.url.origin === GITHUB_ORIGIN ? new TypeError(`bad header ${GITHUB_TOKEN}`) : undefined),
    });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assertNoTokens([...messages(lines), error.message]);
  });
});
