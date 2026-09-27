import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HttpError } from "../src/http.ts";
import { GET, harness, rejection, textResponse, TOKEN, untypedResponse, URL_ITEMS } from "./http-harness.ts";

/** A YouTrack scan page cut off mid-row: quoting it would put a description in the logs (decision R3). */
const TRUNCATED_PAGE = '[{"idReadable":"CUI-1","summary":"[team] Plan","description":"SECRET design notes';
const PREFIX = `GET ${URL_ITEMS} -> HTTP 200: response is not valid JSON`;

/** The plain Error a GET answered by `response` (a 2xx that is not JSON) throws. */
async function invalidJsonError(response: Response): Promise<Error> {
  const { client } = harness([response]);
  const error = await rejection(client.request(GET));
  assert.ok(!(error instanceof HttpError));
  return error;
}

describe("createHttpClient: a 2xx that is not valid JSON", () => {
  it("reports only the length and content type for a JSON content type, never the body", async () => {
    const response = textResponse(200, TRUNCATED_PAGE, { "content-type": "application/json;charset=UTF-8" });

    const error = await invalidJsonError(response);

    const length = String(TRUNCATED_PAGE.length);
    assert.equal(error.message, `${PREFIX} (${length} chars, content-type application/json;charset=UTF-8)`);
    assert.ok(!error.message.includes("SECRET"));
    assert.ok(!error.message.includes("[team] Plan"));
  });

  for (const contentType of ["application/json", "Application/JSON ; charset=utf-8", "application/vnd.github+json"]) {
    it(`treats "${contentType}" as JSON and quotes nothing`, async () => {
      const error = await invalidJsonError(textResponse(200, TRUNCATED_PAGE, { "content-type": contentType }));

      assert.ok(!error.message.includes("SECRET"));
      assert.ok(error.message.endsWith(`content-type ${contentType})`));
    });
  }

  it("quotes nothing when the content type is missing", async () => {
    const error = await invalidJsonError(untypedResponse(200, TRUNCATED_PAGE));

    assert.equal(error.message, `${PREFIX} (${String(TRUNCATED_PAGE.length)} chars, content-type none)`);
  });

  it("adds a redacted excerpt for a non-JSON content type such as an SSO login page", async () => {
    const page = `<html><title>Sign in</title> ${TOKEN}</html>`;

    const error = await invalidJsonError(textResponse(200, page, { "content-type": "text/html; charset=utf-8" }));

    const meta = `(${String(page.length)} chars, content-type text/html; charset=utf-8)`;
    assert.equal(error.message, `${PREFIX} ${meta}: <html><title>Sign in</title> [redacted]</html>`);
  });

  it("does not retry or count a JSON parse failure as a network error", async () => {
    const { client, calls, waits } = harness([textResponse(200, "{", { "content-type": "application/json" })]);

    const error = await rejection(client.request(GET));

    assert.equal(error.constructor, Error);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });
});
