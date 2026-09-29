import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HttpError } from "../src/http.ts";
import type { HttpRequest } from "../src/http.ts";
import {
  callAt,
  GET,
  harness,
  jsonResponse,
  rejection,
  RETRY_DELAY_MS,
  sentHeaders,
  textResponse,
  URL_ITEMS,
} from "./http-harness.ts";

/** GitHub's remove-sub-issue shape: DELETE with a JSON body. */
const DELETE: HttpRequest = { ...GET, method: "DELETE", body: { sub_issue_id: 3_400_000_025 } };

describe("createHttpClient: DELETE with a JSON body", () => {
  it("sends method DELETE, the serialised body and a JSON Content-Type", async () => {
    // Arrange
    const { client, calls } = harness([jsonResponse(200, { number: 24 })]);

    // Act
    const response = await client.request(DELETE);

    // Assert
    const call = callAt(calls, 0);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { number: 24 });
    assert.equal(call.input, URL_ITEMS);
    assert.equal(call.init?.method, "DELETE");
    assert.equal(call.init.body, '{"sub_issue_id":3400000025}');
    assert.equal(sentHeaders(call).get("content-type"), "application/json");
    assert.equal(call.init.redirect, "manual");
  });

  it("builds a request init the Fetch API accepts for DELETE (a body is refused only for GET and HEAD)", async () => {
    // Arrange
    const { client, calls } = harness([jsonResponse(200, {})]);

    // Act
    await client.request(DELETE);

    // Assert
    const request = new Request(URL_ITEMS, callAt(calls, 0).init);
    assert.equal(request.method, "DELETE");
    assert.equal(await request.text(), '{"sub_issue_id":3400000025}');
  });

  it("resolves a 204 with an empty body as null", async () => {
    const { client } = harness([new Response(null, { status: 204 })]);
    assert.equal((await client.request(DELETE)).body, null);
  });

  it("retries a retry-once DELETE once on a 502 with the identical method and body", async () => {
    // Arrange
    const { client, calls, waits } = harness([textResponse(502, ""), jsonResponse(200, {})]);

    // Act
    await client.request(DELETE);

    // Assert
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [RETRY_DELAY_MS]);
    const [first, second] = [callAt(calls, 0), callAt(calls, 1)];
    assert.equal(second.init?.method, "DELETE");
    assert.equal(second.init.body, first.init?.body);
  });

  it("does not retry a no-retry DELETE", async () => {
    // Arrange
    const { client, calls } = harness([textResponse(502, ""), jsonResponse(200, {})]);

    // Act
    const error = await rejection(client.request({ ...DELETE, retry: "no-retry" }));

    // Assert
    assert.ok(error instanceof HttpError);
    assert.equal(calls.length, 1);
  });

  it("reports a failed DELETE as an HttpError naming the method", async () => {
    // Arrange
    const { client } = harness([textResponse(404, '{"message":"Not Found"}')]);

    // Act
    const error = await rejection(client.request(DELETE));

    // Assert
    assert.ok(error instanceof HttpError);
    assert.equal(error.method, "DELETE");
    assert.equal(error.status, 404);
    assert.match(error.message, /^DELETE https:\/\/example\.test\/api\/items -> HTTP 404/);
  });

  it("charges every DELETE attempt against the fetch budget", async () => {
    // Arrange
    const { client, calls } = harness([textResponse(500, ""), jsonResponse(200, {})], { maxFetches: 1 });

    // Act
    const error = await rejection(client.request(DELETE));

    // Assert: the retry is skipped because the budget cannot pay for it.
    assert.ok(error instanceof HttpError);
    assert.equal(calls.length, 1);
    assert.equal(client.fetchCount(), 1);
  });
});
