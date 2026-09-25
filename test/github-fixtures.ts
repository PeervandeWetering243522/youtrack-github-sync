/**
 * Shared fixtures for the test/github-*.test.ts files: a fixed target, URLs spelled out
 * independently of src/github.ts, issue JSON builders and a recording fake HttpClient.
 */

import assert from "node:assert/strict";

import { GITHUB_API_VERSION } from "../src/github.ts";
import type { GitHubTarget } from "../src/github.ts";
import { HttpError } from "../src/http.ts";
import type { HttpClient, HttpRequest, HttpResponse } from "../src/http.ts";
import type { JsonObject, JsonValue } from "../src/json.ts";

export const TOKEN = "ghp_test-token";
export const TARGET: GitHubTarget = { owner: "BredaUniversityADSAI", repo: "mirror-repo", token: TOKEN };
const FAKE_MAX_FETCHES = 45;

/** URLs spelled out independently of the implementation. */
export const ISSUES_URL = "https://api.github.com/repos/BredaUniversityADSAI/mirror-repo/issues";
export const FIRST_PAGE_URL = `${ISSUES_URL}?state=all&per_page=100`;
/** GitHub's own page links use the numeric repository id. */
export const SECOND_PAGE_URL = "https://api.github.com/repositories/123456/issues?state=all&per_page=100&page=2";

export const EXPECTED_HEADERS = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${TOKEN}`,
  "X-GitHub-Api-Version": GITHUB_API_VERSION,
} as const;

export function issueJson(fields: JsonObject = {}): JsonObject {
  return { number: 1, title: "[YT-1] First", state: "open", labels: [], ...fields };
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
