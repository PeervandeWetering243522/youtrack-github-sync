/**
 * Shared fixtures for the test/github/*.test.ts files: a fixed target, URLs spelled out
 * independently of src/github/, issue JSON builders and a recording fake HttpClient.
 */

import assert from "node:assert/strict";

import { GITHUB_API_VERSION } from "../../src/github/client.ts";
import type { GitHubTarget } from "../../src/github/client.ts";
import { HttpError } from "../../src/http.ts";
import type { HttpClient, HttpRequest, HttpResponse } from "../../src/http.ts";
import type { JsonObject, JsonValue } from "../../src/json.ts";

export const TOKEN = "ghp_test-token";
export const TARGET: GitHubTarget = { owner: "BredaUniversityADSAI", repo: "mirror-repo", token: TOKEN };
const FAKE_MAX_FETCHES = 45;

/** URLs spelled out independently of the implementation. */
export const REPO_URL = "https://api.github.com/repos/BredaUniversityADSAI/mirror-repo";
export const ISSUES_URL = `${REPO_URL}/issues`;
export const FIRST_PAGE_URL = `${ISSUES_URL}?state=all&per_page=100`;
/** GitHub's own page links use the numeric repository id. */
export const SECOND_PAGE_URL = "https://api.github.com/repositories/123456/issues?state=all&per_page=100&page=2";
export const MILESTONES_URL = `${REPO_URL}/milestones`;
export const FIRST_MILESTONES_PAGE_URL = `${MILESTONES_URL}?state=all&per_page=100`;
export const SECOND_MILESTONES_PAGE_URL =
  "https://api.github.com/repositories/123456/milestones?state=all&per_page=100&page=2";

/** The `id` issueJson gives every issue unless overridden (deliberately unlike any issue number). */
export const DEFAULT_ISSUE_ID = 3_400_000_001;

/** The hierarchy fields of a parsed issue that has no milestone, no type and no parent. */
export const NO_HIERARCHY = {
  milestoneNumber: null,
  typeName: null,
  parentNumber: null,
  parentIsForeign: false,
} as const;

/** NO_HIERARCHY plus no closer: the optional fields of a parsed issue that has none of them. */
export const NO_EXTRAS = { ...NO_HIERARCHY, closedBy: null } as const;

export const EXPECTED_HEADERS = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${TOKEN}`,
  "X-GitHub-Api-Version": GITHUB_API_VERSION,
} as const;

/** A minimal issue as GitHub lists it: no milestone, type or parent keys unless given. */
export function issueJson(fields: JsonObject = {}): JsonObject {
  return { id: DEFAULT_ISSUE_ID, number: 1, title: "[YT-1] First", state: "open", labels: [], ...fields };
}

/** This repository's API URL of issue `issueNumber`, as GitHub spells parent_issue_url. */
export function parentUrl(issueNumber: number): string {
  return `${ISSUES_URL}/${String(issueNumber)}`;
}

/** A milestone object shaped like GitHub's (extra keys included, as the API sends them). */
export function milestoneJson(fields: JsonObject = {}): JsonObject {
  return {
    url: `${MILESTONES_URL}/1`,
    id: 1_002_604,
    number: 1,
    title: "[YT-33] Epic",
    description: null,
    state: "open",
    open_issues: 0,
    closed_issues: 0,
    due_on: null,
    ...fields,
  };
}

export function withoutKey(value: JsonObject, key: string): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

export function schemaError(message: RegExp): { readonly name: string; readonly message: RegExp } {
  return { name: "GitHubSchemaError", message };
}

// ---------------------------------------------------------------------------
// Fake HttpClient: records every request, answers with canned responses
// ---------------------------------------------------------------------------

export type CannedResponse = { readonly body: JsonValue; readonly link?: string; readonly status?: number };

export type FakeHttp = {
  readonly http: HttpClient;
  readonly requests: readonly HttpRequest[];
};

/** Answers request n with `responses[n]`, or with `failure` once the canned responses run out. */
export function createFakeHttp(responses: readonly CannedResponse[], failure?: Error): FakeHttp {
  const requests: HttpRequest[] = [];
  const http: HttpClient = {
    request: (request) => {
      requests.push(request);
      const canned = responses[requests.length - 1];
      if (canned === undefined) {
        return Promise.reject(failure ?? new Error(`unexpected request #${String(requests.length)}`));
      }
      return Promise.resolve(toResponse(canned));
    },
    fetchCount: () => requests.length,
    remainingFetches: () => FAKE_MAX_FETCHES - requests.length,
  };
  return { http, requests };
}

function toResponse(canned: CannedResponse): HttpResponse {
  const headers = new Headers(canned.link === undefined ? {} : { link: canned.link });
  return { status: canned.status ?? 200, headers, body: canned.body };
}

export function requestAt(requests: readonly HttpRequest[], index: number): HttpRequest {
  const request = requests[index];
  assert.ok(request, `expected request #${String(index + 1)}`);
  return request;
}

export function httpError(status: number): HttpError {
  return new HttpError("POST", ISSUES_URL, status, '{"message":"Validation Failed"}');
}
