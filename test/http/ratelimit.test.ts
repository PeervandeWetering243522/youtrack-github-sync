import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HttpError } from "../../src/http.ts";
import { GET, harness, jsonResponse, POST, rejection, textResponse, URL_ITEMS } from "./fixtures.ts";

type RateLimitCase = {
  readonly name: string;
  readonly status: number;
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly rateLimited: boolean;
};

const SECONDARY_LIMIT_BODY = '{"message":"You have exceeded a secondary rate limit. Please wait a few minutes."}';
const EXHAUSTED = { "x-ratelimit-remaining": "0" };

const CASES: readonly RateLimitCase[] = [
  { name: "403 with x-ratelimit-remaining: 0", status: 403, headers: EXHAUSTED, rateLimited: true },
  {
    name: "429 whose x-ratelimit-remaining trims to 0",
    status: 429,
    headers: { "x-ratelimit-remaining": " 0 " },
    rateLimited: true,
  },
  { name: "403 with retry-after", status: 403, headers: { "retry-after": "60" }, rateLimited: true },
  { name: "429 with an unusable retry-after", status: 429, headers: { "retry-after": "soon" }, rateLimited: true },
  { name: "403 whose body names a secondary rate limit", status: 403, body: SECONDARY_LIMIT_BODY, rateLimited: true },
  { name: "429 whose body says Secondary Rate Limit", status: 429, body: "Secondary Rate Limit", rateLimited: true },
  { name: "403 without rate-limit signals", status: 403, body: "Resource not accessible by token", rateLimited: false },
  {
    name: "403 with requests remaining",
    status: 403,
    headers: { "x-ratelimit-remaining": "4999" },
    rateLimited: false,
  },
  { name: "429 without any rate-limit signal", status: 429, body: "Too Many Requests", rateLimited: false },
  { name: "500 with retry-after", status: 500, headers: { "retry-after": "1" }, rateLimited: false },
  { name: "503 with x-ratelimit-remaining: 0", status: 503, headers: EXHAUSTED, rateLimited: false },
  { name: "404 whose body names a secondary rate limit", status: 404, body: SECONDARY_LIMIT_BODY, rateLimited: false },
  { name: "422 validation failure", status: 422, body: '{"message":"Validation Failed"}', rateLimited: false },
];

/** The HttpError that a no-retry POST answered by `response` throws. */
async function failedWrite(response: Response): Promise<HttpError> {
  const { client, calls } = harness([response]);
  const error = await rejection(client.request(POST));
  assert.ok(error instanceof HttpError);
  assert.equal(calls.length, 1);
  return error;
}

describe("HttpError.rateLimited (decision R7)", () => {
  for (const testCase of CASES) {
    it(`is ${String(testCase.rateLimited)} for a ${testCase.name}`, async () => {
      const error = await failedWrite(textResponse(testCase.status, testCase.body ?? "", testCase.headers));

      assert.equal(error.status, testCase.status);
      assert.equal(error.rateLimited, testCase.rateLimited);
    });
  }

  it("finds the secondary-rate-limit phrase beyond the body excerpt", async () => {
    const error = await failedWrite(textResponse(403, `${"x".repeat(600)} secondary rate limit`));

    assert.ok(!error.bodyExcerpt.includes("secondary"));
    assert.equal(error.rateLimited, true);
  });

  it("leaves the error message format unchanged", async () => {
    const error = await failedWrite(textResponse(403, "slow down", { "retry-after": "60" }));

    assert.equal(error.message, `POST ${URL_ITEMS} -> HTTP 403: slow down`);
  });

  it("judges the response that was thrown, not an earlier attempt", async () => {
    const { client } = harness([textResponse(500, ""), textResponse(429, "", { "x-ratelimit-remaining": "0" })]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 429);
    assert.equal(error.rateLimited, true);
  });

  it("is false when a rate-limited first attempt is retried and the retry fails otherwise", async () => {
    const { client } = harness([
      textResponse(403, "", { "retry-after": "1" }),
      jsonResponse(404, { message: "Not Found" }),
    ]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 404);
    assert.equal(error.rateLimited, false);
  });

  it("defaults to false when an HttpError is constructed without the flag", () => {
    assert.equal(new HttpError("GET", URL_ITEMS, 403, "").rateLimited, false);
    assert.equal(new HttpError("PATCH", URL_ITEMS, 403, "", true).rateLimited, true);
  });
});
