/**
 * U8 (docs/13 §2.11): no log line, failure line or SyncFailedError message names a person,
 * whatever GitHub answers: 422 bodies that quote logins and emails, a body cut in the middle of
 * a login, lookups whose URLs carry an email, and an unreadable assignable list. Every person is
 * a placeholder.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runSync, SyncFailedError } from "../../src/sync.ts";
import {
  ASSIGNABLE_PATH,
  assigneesPath,
  COMMITS_PATH,
  config,
  ghAssignee,
  ghIssue,
  harness,
  ISSUES_PATH,
  json,
  messages,
  SEARCH_USERS_PATH,
  ytRow,
} from "./fixtures.ts";
import type { Harness, Override, RecordedCall, World } from "./fixtures.ts";

const YT_LOGIN = "jdoe123456";
const GH_LOGIN = "JaneDoe123456";
const EMAIL = "123456@buas.nl";
const STAFF = "staffuser";
const MAPPED = "jane.doe";
const IDENTITIES = [YT_LOGIN, GH_LOGIN, EMAIL, STAFF, MAPPED];

/** How much of the start of an identity may never show (docs/13 §4, unit E). */
const SHOWN_PREFIX_CHARS = 5;
/** HttpError keeps this many characters of a body (src/http.ts). */
const BODY_EXCERPT_CHARS = 500;

/** A GitHub error body that quotes every identity. */
const NAMING_BODY = {
  message: "Validation Failed",
  errors: IDENTITIES.map((value) => ({ resource: "Issue", field: "assignees", code: "invalid", value })),
};

/** A 422 body over 500 characters whose cut falls inside GH_LOGIN ("...JaneD|oe123456"). */
function cutBody(): string {
  const start = `{"message":"Validation Failed","errors":[{"value":"${STAFF}"}],"detail":"`;
  const cutAt = BODY_EXCERPT_CHARS - 5;
  return `${start}${" ".repeat(cutAt - start.length)}${GH_LOGIN} and more"}`;
}

function textBody(status: number, text: string, contentType: string): Response {
  return new Response(text, { status, headers: { "content-type": contentType } });
}

function isAt(call: RecordedCall, method: string, path: string): boolean {
  return call.method === method && call.url.pathname === path;
}

/** Every form an identity must not show in: raw, URL-encoded and quoted, and its first 5 characters. */
function forbidden(identity: string): readonly string[] {
  const prefix = identity.slice(0, SHOWN_PREFIX_CHARS);
  return [
    identity,
    encodeURIComponent(identity),
    encodeURIComponent(`"${identity}"`),
    prefix,
    encodeURIComponent(prefix),
  ].map((form) => form.toLowerCase());
}

function assertNoIdentity(texts: readonly string[]): void {
  for (const text of texts) {
    const lower = text.toLowerCase();
    for (const identity of IDENTITIES) {
      for (const form of forbidden(identity)) {
        assert.ok(!lower.includes(form), `"${form}" shows in: ${text}`);
      }
    }
  }
}

/** Runs the sync; returns every log line plus, when it threw, each failure and the error as node.ts prints it. */
async function everyText(
  run: Harness,
  map: ReadonlyMap<string, string | null> = new Map(),
): Promise<readonly string[]> {
  const lines = (): readonly string[] => messages(run.lines);
  try {
    await runSync(config({ assigneeMap: map }), run.deps);
    return lines();
  } catch (error) {
    assert.ok(error instanceof SyncFailedError, "expected only write failures");
    return [...lines(), ...error.failures, `${error.name}: ${error.message}`];
  }
}

describe("runSync assignees: privacy (U8)", () => {
  it("names nobody when writes fail with 422 bodies that quote people, one cut inside a login", async () => {
    // Arrange: #12 needs a title update, an add and a remove; #13 an add (jane.doe maps to staff).
    const override: Override = (call) => {
      if (isAt(call, "PATCH", `${ISSUES_PATH}/12`)) return json(422, NAMING_BODY);
      if (isAt(call, "POST", assigneesPath(12))) return json(422, NAMING_BODY);
      if (isAt(call, "POST", assigneesPath(13))) return textBody(422, cutBody(), "application/json");
      return undefined;
    };
    const world: World = {
      githubIssues: [
        ghIssue(12, "[CUI-5] [team] Task 5", { assignees: [ghAssignee(STAFF)] }),
        ghIssue(13, "[CUI-6] [team] Task 6"),
      ],
      youtrackRows: [
        ytRow(5, { summary: "[team] Renamed 5", assignees: [{ login: YT_LOGIN, email: EMAIL }] }),
        ytRow(6, { assignees: [{ login: MAPPED }] }),
      ],
      assignable: [ghAssignee(GH_LOGIN), ghAssignee(STAFF)],
      override,
    };
    const run = harness(world);

    // Act
    const texts = await everyText(run, new Map([[MAPPED, STAFF]]));

    // Assert
    assert.ok(cutBody().slice(0, BODY_EXCERPT_CHARS).endsWith("JaneD"));
    assert.equal(run.calls.filter((call) => call.method !== "GET").length, 4);
    assert.ok(texts.some((text) => text.startsWith("SyncFailedError: Sync finished with 3 failure(s): ")));
    assert.ok(texts.some((text) => text.startsWith("add 1 assignee to CUI-6 #13 failed: POST ")));
    assert.ok(texts.some((text) => text.includes("[person]")));
    assertNoIdentity(texts);
  });

  it("names nobody when lookups fail: a commit lookup 502 twice and a search answering non-JSON", async () => {
    // Arrange: no assignable login carries the ID, so the email is looked up in both steps.
    const override: Override = (call) => {
      if (call.url.pathname === COMMITS_PATH) return json(502, NAMING_BODY);
      if (call.url.pathname !== SEARCH_USERS_PATH) return undefined;
      return textBody(200, `<html>${IDENTITIES.join(" ")}</html>`, "text/html");
    };
    const world: World = {
      githubIssues: [ghIssue(12, "[CUI-5] [team] Task 5")],
      youtrackRows: [ytRow(5, { assignees: [{ login: YT_LOGIN, email: EMAIL }] })],
      assignable: [ghAssignee(STAFF)],
      override,
    };
    const run = harness(world);

    // Act
    const texts = await everyText(run);

    // Assert
    const lookupUrls = run.calls.filter((call) => [COMMITS_PATH, SEARCH_USERS_PATH].includes(call.url.pathname));
    assert.equal(lookupUrls.length, 3);
    assert.ok(lookupUrls.every((call) => call.url.href.includes("123456%40buas.nl")));
    assert.ok(texts.includes("assignees: 1 not looked up (CUI-5); 2 lookups failed (HTTP 502, unexpected response)"));
    assertNoIdentity(texts);
  });

  it("names nobody when the assignable list fails with a body that quotes people", async () => {
    // Arrange
    const override: Override = (call) => (call.url.pathname === ASSIGNABLE_PATH ? json(502, NAMING_BODY) : undefined);
    const world: World = {
      githubIssues: [ghIssue(12, "[CUI-5] [team] Task 5", { assignees: [ghAssignee(STAFF)] })],
      youtrackRows: [ytRow(5, { assignees: [{ login: YT_LOGIN, email: EMAIL }] })],
      override,
    };
    const run = harness(world);

    // Act
    const texts = await everyText(run);

    // Assert
    assert.ok(
      texts.includes(
        "assignees: could not read the assignable GitHub users (HTTP 502); assignees are not synced this run",
      ),
    );
    assertNoIdentity(texts);
  });
});
