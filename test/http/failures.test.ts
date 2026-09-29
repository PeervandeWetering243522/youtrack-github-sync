import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HttpError, NetworkError } from "../../src/http.ts";
import {
  brokenBodyResponse,
  GET,
  harness,
  jsonResponse,
  POST,
  rejection,
  RETRY_DELAY_MS,
  textResponse,
  TOKEN,
  URL_ITEMS,
} from "./fixtures.ts";

describe("createHttpClient: failures", () => {
  it("treats a 3xx as an HttpError without following or retrying it", async () => {
    const moved = jsonResponse(301, { message: "Moved Permanently" }, { location: "https://example.test/new" });
    const { client, calls, waits } = harness([moved, jsonResponse(200, {})]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 301);
    assert.equal(error.url, URL_ITEMS);
    assert.match(error.bodyExcerpt, /Moved Permanently/);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });

  it("limits the HttpError body excerpt to 500 chars", async () => {
    const { client } = harness([textResponse(404, "b".repeat(2_000))]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.equal(error.bodyExcerpt, "b".repeat(500));
    assert.equal(error.message, `GET ${URL_ITEMS} -> HTTP 404: ${"b".repeat(500)}`);
  });

  it("includes the cause of a network error in the reason", async () => {
    const failure = new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND example.test") });
    const { client } = harness([failure], {});

    const error = await rejection(client.request({ ...GET, retry: "no-retry" }));

    assert.ok(error instanceof NetworkError);
    assert.match(error.message, /failed: fetch failed \(getaddrinfo ENOTFOUND example\.test\)$/);
  });

  it("uses the cause's code when the cause has an empty message (dual-stack connect failure)", async () => {
    const cause = Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" });
    const { client } = harness([new TypeError("fetch failed", { cause })]);

    const error = await rejection(client.request({ ...GET, retry: "no-retry" }));

    assert.ok(error instanceof NetworkError);
    assert.equal(error.message, `GET ${URL_ITEMS} failed: fetch failed (ECONNREFUSED)`);
  });

  it("falls back to the cause's name when it has neither message nor string code", async () => {
    const cause = Object.assign(new AggregateError([], ""), { code: 111 });
    const { client } = harness([new TypeError("fetch failed", { cause })]);

    const error = await rejection(client.request({ ...GET, retry: "no-retry" }));

    assert.equal(error.message, `GET ${URL_ITEMS} failed: fetch failed (AggregateError)`);
  });

  it("uses the error's name when a thrown Error has no message", async () => {
    const { client } = harness([new TypeError("")]);

    const error = await rejection(client.request({ ...GET, retry: "no-retry" }));

    assert.equal(error.message, `GET ${URL_ITEMS} failed: TypeError`);
  });

  it("does not end the HttpError excerpt in half a surrogate pair", async () => {
    const { client } = harness([textResponse(500, `a${"😀".repeat(300)}`)]);

    const error = await rejection(client.request({ ...GET, retry: "no-retry" }));

    assert.ok(error instanceof HttpError);
    assert.equal(error.bodyExcerpt, `a${"😀".repeat(249)}`);
  });

  it("keeps a pair that ends exactly at the excerpt limit", async () => {
    const { client } = harness([textResponse(500, "😀".repeat(251))]);

    const error = await rejection(client.request({ ...GET, retry: "no-retry" }));

    assert.ok(error instanceof HttpError);
    assert.equal(error.bodyExcerpt, "😀".repeat(250));
  });

  it("does not end the invalid-JSON excerpt in half a surrogate pair", async () => {
    const { client } = harness([textResponse(200, `<${"😀".repeat(150)}`)]);

    const error = await rejection(client.request(GET));

    assert.ok(error.message.endsWith(`: <${"😀".repeat(99)}`));
  });

  it("stringifies a non-Error rejection", async () => {
    const throwingFetch: typeof fetch = () =>
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- covers non-Error rejections
      Promise.reject("socket hang up");
    const { client } = harness([], { fetch: throwingFetch });

    const error = await rejection(client.request({ ...GET, retry: "no-retry" }));

    assert.ok(error instanceof NetworkError);
    assert.equal(error.message, `GET ${URL_ITEMS} failed: socket hang up`);
  });
});

describe("createHttpClient: unreadable response bodies", () => {
  it("treats a failure while reading a 2xx body as a network error", async () => {
    const { client } = harness([brokenBodyResponse(200)]);

    const error = await rejection(client.request({ ...GET, retry: "no-retry" }));

    assert.ok(error instanceof NetworkError);
    assert.match(error.message, /stream reset/);
  });

  it("reports a non-2xx whose body cannot be read as an HttpError with that status and no excerpt", async () => {
    const { client, calls } = harness([brokenBodyResponse(422)]);

    const error = await rejection(client.request(POST));

    assert.ok(error instanceof HttpError);
    assert.equal(error.method, "POST");
    assert.equal(error.status, 422);
    assert.equal(error.bodyExcerpt, "");
    assert.equal(calls.length, 1);
  });

  it("does not retry a 4xx just because its body could not be read", async () => {
    const { client, calls, waits } = harness([brokenBodyResponse(404), jsonResponse(200, {})]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 404);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });

  it("classifies a 5xx with an unreadable body by its status, so it is retried once", async () => {
    const { client, calls, waits } = harness([brokenBodyResponse(503), jsonResponse(200, { ok: true })]);

    const response = await client.request(GET);

    assert.deepEqual(response.body, { ok: true });
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [RETRY_DELAY_MS]);
  });

  it("keeps the headers of a non-2xx with an unreadable body for the retry decision", async () => {
    const { client, waits } = harness([brokenBodyResponse(403, { "retry-after": "1" }), jsonResponse(200, {})]);

    await client.request(GET);

    assert.deepEqual(waits, [1_000]);
  });
});

describe("createHttpClient: secret redaction", () => {
  it("redacts header values quoted in a fetch error", async () => {
    const failure = new TypeError(`Headers.append: "Bearer ${TOKEN}" is an invalid header value.`);
    const { client } = harness([failure]);

    const error = await rejection(client.request({ ...GET, retry: "no-retry" }));

    assert.ok(error instanceof NetworkError);
    assert.ok(!error.message.includes(TOKEN));
    assert.equal(error.message, `GET ${URL_ITEMS} failed: Headers.append: "[redacted]" is an invalid header value.`);
  });

  it("redacts a token part echoed without its scheme", async () => {
    const { client } = harness([jsonResponse(401, { message: `Bad credentials: ${TOKEN}` })]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.ok(!error.message.includes(TOKEN));
    assert.ok(!error.bodyExcerpt.includes(TOKEN));
    assert.match(error.bodyExcerpt, /Bad credentials: \[redacted\]/);
  });

  it("redacts header values in an invalid-JSON error", async () => {
    const { client } = harness([textResponse(200, `token=${TOKEN} not json`)]);

    const error = await rejection(client.request(GET));

    assert.ok(!error.message.includes(TOKEN));
    assert.match(error.message, /token=\[redacted\] not json/);
  });

  it("redacts before truncating, so a token straddling the cut leaks no prefix", async () => {
    const { client } = harness([textResponse(500, `${"x".repeat(495)}${TOKEN}`)]);

    const error = await rejection(client.request({ ...GET, retry: "no-retry" }));

    assert.ok(error instanceof HttpError);
    assert.equal(error.bodyExcerpt, `${"x".repeat(495)}[reda`);
  });

  it("redacts every occurrence of a header value", async () => {
    const { client } = harness([textResponse(401, `${TOKEN} and again ${TOKEN}`)]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.equal(error.bodyExcerpt, "[redacted] and again [redacted]");
  });

  it("redacts the raw value quoted by a real Headers validation error", async () => {
    const validatingFetch: typeof fetch = (input, init) =>
      Promise.resolve().then(() => {
        new Request(input, init);
        return jsonResponse(200, {});
      });
    const { client } = harness([], { fetch: validatingFetch });
    const headers = { Authorization: "Bearer perm-abc.def\nghi-jkl" };

    const error = await rejection(client.request({ ...GET, headers, retry: "no-retry" }));

    assert.ok(error instanceof NetworkError);
    assert.ok(!error.message.includes("perm-abc"));
    assert.ok(!error.message.includes("ghi-jkl"));
    assert.match(error.message, /\[redacted\]/);
  });

  it("redacts only credential headers, keeping Accept and the API version readable", async () => {
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${TOKEN}`,
      "X-GitHub-Api-Version": "2026-03-10",
    };
    const body = `Unsupported 'X-GitHub-Api-Version' '2026-03-10' for application/vnd.github+json (${TOKEN})`;
    const { client } = harness([textResponse(400, body)]);

    const error = await rejection(client.request({ ...GET, headers }));

    assert.ok(error instanceof HttpError);
    assert.equal(
      error.bodyExcerpt,
      "Unsupported 'X-GitHub-Api-Version' '2026-03-10' for application/vnd.github+json ([redacted])",
    );
  });

  it("keeps the YouTrack Accept value readable", async () => {
    const { client } = harness([textResponse(406, "Not Acceptable: application/json")]);

    const error = await rejection(client.request(GET));

    assert.ok(error instanceof HttpError);
    assert.equal(error.bodyExcerpt, "Not Acceptable: application/json");
  });

  it("redacts other token-bearing headers, whatever their case", async () => {
    const headers = {
      "x-api-key": "key-1234567890",
      "Private-Token": "glpat-abcdefgh",
      "X-Auth-Token": "auth-0987654321",
      Cookie: "session=abcdef123456",
    };
    const body = "key-1234567890 glpat-abcdefgh auth-0987654321 session=abcdef123456";
    const { client } = harness([textResponse(401, body)]);

    const error = await rejection(client.request({ ...GET, headers }));

    assert.ok(error instanceof HttpError);
    assert.equal(error.bodyExcerpt, "[redacted] [redacted] [redacted] [redacted]");
  });

  it("leaves short header values such as the auth scheme alone", async () => {
    const { client } = harness([textResponse(401, "Bearer realm=api")]);

    const error = await rejection(client.request({ ...GET, headers: { Authorization: "Bearer abc" } }));

    assert.ok(error instanceof HttpError);
    assert.equal(error.bodyExcerpt, "Bearer realm=api");
  });
});
