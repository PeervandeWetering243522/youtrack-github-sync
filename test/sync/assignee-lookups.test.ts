/**
 * The lookup steps of the matching chain end to end (docs/13 §2.4-2.5; U17): the commit author
 * (c) and public-email search (d) lookups, how their failures turn a step off, skip an email
 * or stop all lookups, the bound, the deadline margin and the rotation. Lookups are reads: never
 * fatal, never counted as failed. Every person is a placeholder.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runSync } from "../../src/sync.ts";
import {
  assigneesPath,
  bodiesOf,
  COMMITS_PATH,
  config,
  ghAssignee,
  ghIssue,
  harness,
  json,
  lastLine,
  messages,
  SEARCH_USERS_PATH,
  writeCalls,
  ytRow,
} from "./fixtures.ts";
import type { Override, RecordedCall, World, YtUser } from "./fixtures.ts";

/** Users without a student ID anywhere: only lookups can match them. */
const JANE: YtUser = { login: "jane.doe", email: "jane.doe@example.com" };
const JOHN: YtUser = { login: "john.roe", email: "john.roe@example.com" };
const JANE_GH = "JaneDoe123456";
const JOHN_GH = "RichardRoe654321";

const RATE_LIMITED = { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790276472" };

/** CUI-5 (mirror #12) assigned to JANE and CUI-6 (mirror #13) to JOHN, both GitHub logins assignable. */
function world(extra: Partial<World> = {}): World {
  return {
    githubIssues: [ghIssue(12, "[CUI-5] [team] Task 5"), ghIssue(13, "[CUI-6] [team] Task 6")],
    youtrackRows: [ytRow(5, { assignees: [JANE] }), ytRow(6, { assignees: [JOHN] })],
    assignable: [ghAssignee(JANE_GH), ghAssignee(JOHN_GH), ghAssignee("staffuser")],
    ...extra,
  };
}

/** Answers every call to `path` with `answer`, the default otherwise. */
function at(path: string, answer: (attempt: number) => Response | Error | undefined): Override {
  return (call, attempt) => (call.url.pathname === path ? answer(attempt) : undefined);
}

/** The email of every lookup sent, as "commit <email>" or "search <email>", in order. */
function lookups(calls: readonly RecordedCall[]): readonly string[] {
  return calls.flatMap((call) => {
    if (call.url.pathname === COMMITS_PATH) return [`commit ${call.url.searchParams.get("author") ?? ""}`];
    if (call.url.pathname !== SEARCH_USERS_PATH) return [];
    return [`search ${/^"(.*)" in:email type:user$/.exec(call.url.searchParams.get("q") ?? "")?.[1] ?? ""}`];
  });
}

function noneMatched(count: number): string {
  return (
    `assignees: none of the ${String(count)} YouTrack assignees matched a GitHub account; if their YouTrack ` +
    "logins look anonymized, the YouTrack token may lack Read User Basic"
  );
}

describe("runSync lookups: matching", () => {
  it("matches through the commit author (step c) and sends no search for that person", async () => {
    // Arrange
    const authors = new Map([
      ["jane.doe@example.com", JANE_GH],
      ["john.roe@example.com", JOHN_GH],
    ]);
    const { deps, calls, lines } = harness(world({ commitAuthors: authors }));

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(lookups(calls), ["commit jane.doe@example.com", "commit john.roe@example.com"]);
    const commit = calls.find((call) => call.url.pathname === COMMITS_PATH);
    assert.equal(commit?.url.searchParams.get("per_page"), "1");
    assert.deepEqual(writeCalls(calls), [`POST ${assigneesPath(12)}`, `POST ${assigneesPath(13)}`]);
    assert.deepEqual(bodiesOf(calls, "POST", assigneesPath(12)), [{ assignees: [JANE_GH] }]);
    assert.deepEqual(messages(lines, "warn"), []);
    assert.equal(result.fetches, 8);
  });

  it("matches through the public-email search (step d) when no commit names the person", async () => {
    // Arrange
    const found = new Map([["jane.doe@example.com", [JANE_GH, "outsider"]]]);
    const { deps, calls } = harness(world({ searchUsers: found }));

    // Act
    await runSync(config(), deps);

    // Assert
    assert.deepEqual(lookups(calls), [
      "commit jane.doe@example.com",
      "search jane.doe@example.com",
      "commit john.roe@example.com",
      "search john.roe@example.com",
    ]);
    assert.deepEqual(writeCalls(calls), [`POST ${assigneesPath(12)}`]);
  });

  it("looks up an email two people share once per step", async () => {
    // Arrange
    const shared = { email: "shared@example.com" };
    const rows = [
      ytRow(5, { assignees: [{ login: "jane.doe", ...shared }] }),
      ytRow(6, { assignees: [{ login: "j.doe", ...shared }] }),
    ];
    const { deps, calls, lines } = harness(world({ youtrackRows: rows }));

    // Act
    await runSync(config(), deps);

    // Assert
    assert.deepEqual(lookups(calls), ["commit shared@example.com", "search shared@example.com"]);
    assert.equal(messages(lines, "warn")[0], "assignees: 2 unmatched (CUI-5, CUI-6)");
  });
});

describe("runSync lookups: failures (docs/13 §2.5)", () => {
  for (const status of [403, 404] as const) {
    it(`turns commit lookups off on ${String(status)} with a note naming the fix; the search still runs`, async () => {
      // Arrange
      const found = new Map([["jane.doe@example.com", [JANE_GH]]]);
      const override = at(COMMITS_PATH, () => json(status, { message: "Resource not accessible by integration" }));
      const { deps, calls, lines } = harness(world({ override, searchUsers: found }));

      // Act
      await runSync(config(), deps);

      // Assert
      assert.deepEqual(lookups(calls), [
        "commit jane.doe@example.com",
        "search jane.doe@example.com",
        "search john.roe@example.com",
      ]);
      assert.deepEqual(writeCalls(calls), [`POST ${assigneesPath(12)}`]);
      assert.deepEqual(messages(lines, "warn"), [
        `assignees: 1 unmatched (CUI-6); commit lookups off: the token lacks Contents read (HTTP ${String(status)})`,
      ]);
    });
  }

  it("turns commit lookups off on 409 (an empty repository)", async () => {
    // Arrange
    const override = at(COMMITS_PATH, () => json(409, { message: "Git Repository is empty." }));
    const { deps, calls, lines } = harness(world({ override }));

    // Act
    await runSync(config(), deps);

    // Assert
    assert.equal(lookups(calls).filter((lookup) => lookup.startsWith("commit")).length, 1);
    assert.deepEqual(messages(lines, "warn"), [
      "assignees: 2 unmatched (CUI-5, CUI-6); commit lookups off (HTTP 409)",
      noneMatched(2),
    ]);
  });

  it("turns the email search off on a rate limit; commit lookups go on, the unsearched are not looked up", async () => {
    // Arrange
    const override = at(SEARCH_USERS_PATH, () => json(403, { message: "API rate limit exceeded" }, RATE_LIMITED));
    const { deps, calls, lines } = harness(world({ override }));

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(lookups(calls), [
      "commit jane.doe@example.com",
      "search jane.doe@example.com",
      "commit john.roe@example.com",
    ]);
    assert.deepEqual(messages(lines, "warn"), [
      "assignees: 2 not looked up (CUI-5, CUI-6); email search off: GitHub rate limit",
    ]);
    assert.equal(result.failed, 0);
  });

  it("keeps a match the email search found before a rate limit turned it off", async () => {
    // Arrange: jane's search finds her; john's search is the one GitHub rate-limits.
    const limitJohn: Override = (call) =>
      call.url.pathname === SEARCH_USERS_PATH && (call.url.searchParams.get("q") ?? "").includes("john.roe")
        ? json(403, { message: "API rate limit exceeded" }, RATE_LIMITED)
        : undefined;
    const found = new Map([["jane.doe@example.com", [JANE_GH]]]);
    const { deps, calls, lines } = harness(world({ override: limitJohn, searchUsers: found }));

    // Act
    await runSync(config(), deps);

    // Assert
    assert.deepEqual(bodiesOf(calls, "POST", assigneesPath(12)), [{ assignees: [JANE_GH] }]);
    assert.deepEqual(messages(lines, "warn"), [
      "assignees: 1 not looked up (CUI-6); email search off: GitHub rate limit",
    ]);
  });

  it("matches nobody from part of a person's emails when a rate limit paused the search of the rest", async () => {
    // Arrange: the person's second email, 123456@buas.nl, is never searched; its answer could
    // have been SchoolB, which would make them ambiguous.
    const person = { login: "jdoe123456", email: "jane@example.org" };
    const limitSecond: Override = (call) =>
      call.url.pathname === SEARCH_USERS_PATH && (call.url.searchParams.get("q") ?? "").includes("123456@buas.nl")
        ? json(403, { message: "API rate limit exceeded" }, RATE_LIMITED)
        : undefined;
    const extra: Partial<World> = {
      githubIssues: [ghIssue(12, "[CUI-5] [team] Task 5")],
      youtrackRows: [ytRow(5, { assignees: [person] })],
      assignable: [ghAssignee("PersonalA"), ghAssignee("SchoolB")],
      searchUsers: new Map([["jane@example.org", ["PersonalA"]]]),
      override: limitSecond,
    };
    const { deps, calls, lines } = harness(world(extra));

    // Act
    await runSync(config(), deps);

    // Assert
    assert.deepEqual(lookups(calls), [
      "commit jane@example.org",
      "commit 123456@buas.nl",
      "search jane@example.org",
      "search 123456@buas.nl",
    ]);
    assert.deepEqual(writeCalls(calls), []);
    assert.deepEqual(messages(lines, "warn"), [
      "assignees: 1 not looked up (CUI-5); email search off: GitHub rate limit",
    ]);
  });

  it("decides a person whose search was answered before a rate limit paused it for someone else", async () => {
    // Arrange: jane's search finds nobody; john's search is the one GitHub rate-limits.
    const limitJohn: Override = (call) =>
      call.url.pathname === SEARCH_USERS_PATH && (call.url.searchParams.get("q") ?? "").includes("john.roe")
        ? json(403, { message: "API rate limit exceeded" }, RATE_LIMITED)
        : undefined;
    const { deps, calls, lines } = harness(world({ override: limitJohn }));

    // Act
    await runSync(config(), deps);

    // Assert
    assert.deepEqual(lookups(calls), [
      "commit jane.doe@example.com",
      "search jane.doe@example.com",
      "commit john.roe@example.com",
      "search john.roe@example.com",
    ]);
    assert.deepEqual(writeCalls(calls), []);
    assert.deepEqual(messages(lines, "warn"), [
      "assignees: 1 unmatched (CUI-5), 1 not looked up (CUI-6); email search off: GitHub rate limit",
      noneMatched(2),
    ]);
  });

  it("stops all lookups on a commit-lookup rate limit; waiting people are not looked up", async () => {
    // Arrange
    const override = at(COMMITS_PATH, () => json(429, { message: "API rate limit exceeded" }, RATE_LIMITED));
    const { deps, calls, lines } = harness(world({ override }));

    // Act
    await runSync(config(), deps);

    // Assert
    assert.deepEqual(lookups(calls), ["commit jane.doe@example.com"]);
    assert.deepEqual(messages(lines, "warn"), [
      "assignees: 2 not looked up (CUI-5, CUI-6); lookups stopped: GitHub rate limit",
    ]);
  });

  it("skips an email whose lookup failed after its retry; the person is not looked up, the run ends ok", async () => {
    // Arrange
    const override = at(COMMITS_PATH, () => json(502, { message: "Bad Gateway" }));
    const rows = [ytRow(5, { assignees: [JANE] })];
    const { deps, calls, lines } = harness(world({ override, youtrackRows: rows }));

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(lookups(calls), [
      "commit jane.doe@example.com",
      "commit jane.doe@example.com",
      "search jane.doe@example.com",
    ]);
    assert.deepEqual(messages(lines, "warn"), ["assignees: 1 not looked up (CUI-5); 1 lookup failed (HTTP 502)"]);
    assert.equal(lastLine(lines).level, "info");
    assert.equal(result.failed, 0);
  });

  it("decides a step from a person's other emails when one of them failed", async () => {
    // Arrange: the login carries an ID no assignable login has, so the person has two emails;
    // the commit lookup of the first fails twice with a network error.
    const person = { login: "jdoe123456", email: "jane.doe@example.com" };
    const override: Override = (call) =>
      call.url.searchParams.get("author") === "jane.doe@example.com" ? new TypeError("fetch failed") : undefined;
    const extra: Partial<World> = {
      youtrackRows: [ytRow(5, { assignees: [person] })],
      assignable: [ghAssignee("JaneDoe-GH")],
      commitAuthors: new Map([["123456@buas.nl", "janedoe-gh"]]),
      override,
    };
    const { deps, calls, lines } = harness(world(extra));

    // Act
    await runSync(config(), deps);

    // Assert
    assert.deepEqual(lookups(calls), [
      "commit jane.doe@example.com",
      "commit jane.doe@example.com",
      "commit 123456@buas.nl",
    ]);
    assert.deepEqual(bodiesOf(calls, "POST", assigneesPath(12)), [{ assignees: ["JaneDoe-GH"] }]);
    assert.deepEqual(messages(lines, "warn"), ["assignees: 1 lookup failed (network error)"]);
  });

  it("names each distinct failure once in the note", async () => {
    // Arrange
    const override: Override = (call) => {
      if (call.url.pathname === COMMITS_PATH) return json(502, { message: "Bad Gateway" });
      return call.url.pathname === SEARCH_USERS_PATH
        ? new Response("<html>busy</html>", { status: 200, headers: { "content-type": "text/html" } })
        : undefined;
    };
    const { deps, lines } = harness(world({ override, youtrackRows: [ytRow(5, { assignees: [JANE] })] }));

    // Act
    await runSync(config(), deps);

    // Assert
    assert.equal(
      messages(lines, "warn")[0],
      "assignees: 1 not looked up (CUI-5); 2 lookups failed (HTTP 502, unexpected response)",
    );
  });
});

describe("runSync lookups: bound, deadline and rotation", () => {
  it("stops at the bound of 5 lookups per run", async () => {
    // Arrange: three people need two lookups each.
    const rows = [
      ytRow(5, { assignees: [JANE] }),
      ytRow(6, { assignees: [JOHN] }),
      ytRow(7, { assignees: [{ login: "sam.poe", email: "sam.poe@example.com" }] }),
    ];
    const { deps, calls, lines } = harness(world({ youtrackRows: rows }));

    // Act
    await runSync(config(), deps);

    // Assert
    assert.equal(lookups(calls).length, 5);
    assert.deepEqual(
      messages(lines, "warn")[0],
      "assignees: 2 unmatched (CUI-5, CUI-6), 1 not looked up (CUI-7); lookup budget of 5 used up",
    );
  });

  it("sends one lookup at 38 writes per run (41 fetches left - 38 - 2)", async () => {
    // Arrange
    const { deps, calls, lines } = harness(world());

    // Act
    await runSync(config({ maxWritesPerRun: 38 }), deps);

    // Assert
    assert.deepEqual(lookups(calls), ["commit jane.doe@example.com"]);
    assert.equal(messages(lines, "warn")[0], "assignees: 2 not looked up (CUI-5, CUI-6); lookup budget of 1 used up");
  });

  it("sends no lookup at 40 writes per run, and says the write cap left no budget", async () => {
    // Arrange
    const { deps, calls, lines } = harness(world());

    // Act
    await runSync(config({ maxWritesPerRun: 40 }), deps);

    // Assert
    assert.deepEqual(lookups(calls), []);
    assert.equal(
      messages(lines, "warn")[0],
      "assignees: 2 not looked up (CUI-5, CUI-6); no lookup budget left by the write cap",
    );
  });

  it("counts a lookup's retry against the bound", async () => {
    // Arrange: at 37 writes the bound is 2 fetches; the first lookup's retry spends the second.
    const override = at(COMMITS_PATH, (attempt) => (attempt === 0 ? json(502, { message: "Bad Gateway" }) : undefined));
    const { deps, calls, lines } = harness(world({ override }));

    // Act
    await runSync(config({ maxWritesPerRun: 37 }), deps);

    // Assert
    assert.deepEqual(lookups(calls), ["commit jane.doe@example.com", "commit jane.doe@example.com"]);
    assert.equal(messages(lines, "warn")[0], "assignees: 2 not looked up (CUI-5, CUI-6); lookup budget of 2 used up");
  });

  it("starts no lookup within 40 s of the run deadline (2 x 15 s timeout + 10 s retry wait)", async () => {
    // Arrange
    const { deps, calls, lines } = harness(world({ deadline: 40_000 }));

    // Act
    await runSync(config(), deps);

    // Assert
    assert.deepEqual(lookups(calls), []);
    assert.equal(
      messages(lines, "warn")[0],
      "assignees: 2 not looked up (CUI-5, CUI-6); lookups stopped at the run deadline",
    );
  });

  it("still looks up just outside that margin", async () => {
    // Arrange
    const { deps, calls } = harness(world({ deadline: 40_001 }));

    // Act
    await runSync(config(), deps);

    // Assert
    assert.equal(lookups(calls).length, 4);
  });

  it("rotates which person is looked up first, one step per 10 minutes", async () => {
    // Arrange: one lookup per run (38 writes); the second run starts 10 minutes later.
    const first = harness(world({ startTime: 0 }));
    const second = harness(world({ startTime: 600_000 }));

    // Act
    await runSync(config({ maxWritesPerRun: 38 }), first.deps);
    await runSync(config({ maxWritesPerRun: 38 }), second.deps);

    // Assert
    assert.deepEqual(lookups(first.calls), ["commit jane.doe@example.com"]);
    assert.deepEqual(lookups(second.calls), ["commit john.roe@example.com"]);
  });
});
