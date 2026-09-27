/**
 * Shared fixtures for the test/youtrack-*.test.ts files: live-shaped rows, the
 * expected page requests, and a fake HttpClient that records every request.
 * Not a test file itself (the runner only picks up *.test.ts).
 */

import assert from "node:assert/strict";

import type { HttpClient, HttpRequest, HttpResponse } from "../src/http.ts";
import { isJsonArray, isJsonObject } from "../src/json.ts";
import type { JsonObject, JsonValue } from "../src/json.ts";
import type { YouTrackIssue, YouTrackSource } from "../src/youtrack.ts";

// ---------------------------------------------------------------------------
// Fixtures (shaped like the live responses in docs/00-live-verification.md)
// ---------------------------------------------------------------------------

export const BASE_URL = "https://youtrack.example.test";
export const TOKEN = "test-token";
// Frozen: the module must never write to its source argument.
export const SOURCE: YouTrackSource = Object.freeze({ baseUrl: BASE_URL, token: TOKEN, project: "CUI" });
export const FAKE_MAX_FETCHES = 45;

/** A page URL up to its `$skip` value, spelled out independently of the implementation. */
const PAGE_URL_PREFIX =
  `${BASE_URL}/api/issues` +
  "?query=project%3A+CUI+sort+by%3A+%7Bissue+id%7D+asc" +
  "&fields=idReadable%2CnumberInProject%2Csummary%2Cdescription%2Cresolved%2Cupdated" +
  "&%24top=100&%24skip=";
export const FIRST_PAGE_URL = `${PAGE_URL_PREFIX}0`;

/** The exact request expected for the page at `skip` of the SOURCE project. */
export function expectedPageRequest(skip: number): HttpRequest {
  return {
    method: "GET",
    url: `${PAGE_URL_PREFIX}${String(skip)}`,
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
    retry: "retry-once",
  };
}

export const UNRESOLVED_ROW: JsonObject = {
  idReadable: "CUI-31",
  summary: "[individual] Explore GH-YouTrack integrations",
  updated: 1790256733345,
  resolved: null,
  numberInProject: 31,
  description: "Probably gonna have Claude draft up a project to use API keys to have ideally bidirectional syncing",
  $type: "Issue",
};

export const RESOLVED_ROW: JsonObject = {
  idReadable: "CUI-11",
  summary: "[Team] Audit and revise the research proposal",
  updated: 1790254466400,
  resolved: 1789644365309,
  numberInProject: 11,
  description:
    "Review Gabriel's draft, identify factual and structural issues, apply corrections, merge into the shared document.",
  $type: "Issue",
};

export const NULL_DESCRIPTION_ROW: JsonObject = {
  idReadable: "CUI-30",
  summary: "Add finalized research proposal to github",
  updated: 1790254466396,
  resolved: null,
  numberInProject: 30,
  description: null,
  $type: "Issue",
};

/** A valid row for issue `numberInProject`; `overrides` replaces or adds keys. */
export function issueRow(numberInProject: number, overrides: JsonObject = {}): JsonObject {
  return {
    idReadable: `CUI-${String(numberInProject)}`,
    summary: `[team] Issue ${String(numberInProject)}`,
    updated: 1789307190036 + numberInProject,
    resolved: null,
    numberInProject,
    description: null,
    $type: "Issue",
    ...overrides,
  };
}

/** `count` consecutive valid rows starting at issue `first`. */
export function issueRows(first: number, count: number): readonly JsonObject[] {
  return Array.from({ length: count }, (_, offset) => issueRow(first + offset));
}

export function withoutFields(row: JsonObject, fields: readonly string[]): JsonObject {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !fields.includes(key)));
}

export function numbersOf(issues: readonly YouTrackIssue[]): readonly number[] {
  return issues.map((issue) => issue.numberInProject);
}

export function range(first: number, count: number): readonly number[] {
  return Array.from({ length: count }, (_, offset) => first + offset);
}

export function schemaError(message: RegExp): { readonly name: string; readonly message: RegExp } {
  return { name: "YouTrackSchemaError", message };
}

/** Freezes a JSON value and everything inside it, so any write to it throws (ES modules are strict). */
export function deepFreeze<T extends JsonValue>(value: T): T {
  if (isJsonArray(value)) {
    for (const item of value) deepFreeze(item);
  } else if (isJsonObject(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
  }
  Object.freeze(value);
  return value;
}

// ---------------------------------------------------------------------------
// Fake HttpClient: records every request, answers with canned responses
// ---------------------------------------------------------------------------

type Responder = (request: HttpRequest, callIndex: number) => Promise<HttpResponse>;

export type FakeHttp = {
  readonly http: HttpClient;
  readonly requests: readonly HttpRequest[];
};

export function createFakeHttp(respond: Responder): FakeHttp {
  const requests: HttpRequest[] = [];
  const http: HttpClient = {
    request: (request) => {
      requests.push(request);
      return respond(request, requests.length - 1);
    },
    fetchCount: () => requests.length,
    remainingFetches: () => FAKE_MAX_FETCHES - requests.length,
  };
  return { http, requests };
}

export function okResponse(body: JsonValue): HttpResponse {
  return { status: 200, headers: new Headers(), body };
}

/** Serves `firstBodies` in order, then rejects every later request with `failure`. */
export function failAfter(firstBodies: readonly JsonValue[], failure: Error): FakeHttp {
  return createFakeHttp((_request, callIndex) => {
    const body = firstBodies[callIndex];
    return body === undefined ? Promise.reject(failure) : Promise.resolve(okResponse(body));
  });
}

/** Answers request n with `bodies[n]`; a request beyond the canned bodies fails the test. */
export function serveBodies(bodies: readonly JsonValue[]): FakeHttp {
  return failAfter(bodies, new Error("unexpected request beyond the canned responses"));
}

export function skipsOf(requests: readonly HttpRequest[]): readonly (string | null)[] {
  return requests.map((request) => new URL(request.url).searchParams.get("$skip"));
}

/** The GET-only rule: every request is a bodiless GET to {baseUrl}/api/issues. */
export function assertOnlyIssueGets(requests: readonly HttpRequest[]): void {
  assert.ok(requests.length > 0, "expected at least one request");
  for (const request of requests) {
    const url = new URL(request.url);
    assert.equal(request.method, "GET");
    assert.equal(`${url.origin}${url.pathname}`, `${BASE_URL}/api/issues`);
    assert.equal("body" in request, false);
  }
}
