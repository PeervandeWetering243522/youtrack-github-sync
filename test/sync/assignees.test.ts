/**
 * Assignee sync end to end on the fake GitHub (docs/13 §2; U1-U8, U13-U17, D4): who gets
 * matched, what is added and removed, the warnings, the switch, the dry run and how assignee
 * writes stop like any other write. Every person is a placeholder.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BODY_EXCERPT_CHARS } from "../../src/http.ts";
import type { JsonObject } from "../../src/json.ts";
import { formatSummary, runSync, SyncFailedError, WRITE_PAUSE_MS } from "../../src/sync.ts";
import {
  ASSIGNABLE_PATH,
  assigneesPath,
  bodiesOf,
  COMMITS_PATH,
  config,
  ghAssignee,
  ghIssue,
  GITHUB_ORIGIN,
  harness,
  ISSUES_PATH,
  json,
  lastLine,
  messages,
  MILESTONES_PATH,
  openMirrorsOfResolved,
  rejection,
  RESOLVED_AT,
  SEARCH_USERS_PATH,
  summary,
  writeCalls,
  ytRow,
} from "./fixtures.ts";
import type { Override, RecordedCall, World, YtUser } from "./fixtures.ts";

/** YouTrack users whose student IDs are in the assignable logins below (step b). */
const JDOE: YtUser = { login: "jdoe123456", email: "123456@buas.nl" };
const JROE: YtUser = { login: "jroe654321", email: null };
const JANE_GH = "JaneDoe123456";
const ROE_GH = "RichardRoe654321";
const ASSIGNABLE = [ghAssignee(JANE_GH), ghAssignee(ROE_GH), ghAssignee("staffuser")];

const FIELD_MISSING =
  'assignees: no scanned issue has an "Assignee" field, so no assignee is changed; check the field name in ' +
  "YouTrack, or set SYNC_ASSIGNEES (input sync-assignees) to false";
const NONE_MATCHED =
  "assignees: none of the 1 YouTrack assignee matched a GitHub account; if their YouTrack logins look " +
  "anonymized, the YouTrack token may lack Read User Basic";

function unreadable(detail: string): string {
  return `assignees: could not read the assignable GitHub users (${detail}); assignees are not synced this run`;
}

/** CUI-5 with an open mirror #12 holding `assignees`, assigned in YouTrack to `users`. */
function mirrored(users: readonly YtUser[] | null, assignees: readonly string[] = []): World {
  return {
    githubIssues: [ghIssue(12, "[CUI-5] [team] Task 5", { assignees: assignees.map((login) => ghAssignee(login)) })],
    youtrackRows: [ytRow(5, { assignees: users })],
    assignable: ASSIGNABLE,
  };
}

/**
 * The assignable list as `count` pages linked by rel="next": one staff login on each page
 * before the last, and `last` on page `count`.
 */
function assignablePages(count: number, last: readonly JsonObject[]): Override {
  return (call) => {
    if (call.method !== "GET" || call.url.pathname !== ASSIGNABLE_PATH) return undefined;
    const page = Number(call.url.searchParams.get("page") ?? "1");
    if (page >= count) return json(200, last);
    const next = `${GITHUB_ORIGIN}${ASSIGNABLE_PATH}?per_page=100&page=${String(page + 1)}`;
    return json(200, [ghAssignee(`staffuser${String(page)}`)], { link: `<${next}>; rel="next"` });
  };
}

function isAt(call: RecordedCall, method: string, path: string): boolean {
  return call.method === method && call.url.pathname === path;
}

function reads(calls: readonly RecordedCall[]): readonly string[] {
  return calls.filter((call) => call.method === "GET").map((call) => call.url.pathname);
}

const THREE_READS = [ISSUES_PATH, MILESTONES_PATH, "/api/issues"];
const FOUR_READS = [...THREE_READS, ASSIGNABLE_PATH];

describe("runSync assignees: matching and writes", () => {
  it("gives a mirror created this run its assignee right after the create (4 reads)", async () => {
    // Arrange
    const { deps, calls, lines } = harness({ youtrackRows: [ytRow(1, { assignees: [JDOE] })], assignable: ASSIGNABLE });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(reads(calls), FOUR_READS);
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`, `POST ${assigneesPath(101)}`]);
    assert.deepEqual(bodiesOf(calls, "POST", assigneesPath(101)), [{ assignees: [JANE_GH] }]);
    assert.deepEqual(messages(lines), [
      "create CUI-1 -> #101",
      "add 1 assignee to CUI-1 #101",
      formatSummary(result, "ok"),
    ]);
    assert.deepEqual(result, summary({ scanned: 1, created: 1, assigneesAdded: 1, fetches: 6 }));
  });

  it("asks YouTrack for the Assignee field and the user login and email", async () => {
    // Arrange
    const { deps, calls } = harness(mirrored([JDOE]));

    // Act
    await runSync(config(), deps);

    // Assert
    const scan = calls.find((call) => call.url.pathname === "/api/issues");
    assert.ok(scan);
    assert.deepEqual(scan.url.searchParams.getAll("customFields"), ["Type", "Assignee"]);
    assert.match(scan.url.searchParams.get("fields") ?? "", /customFields\(name,value\(name,login,email\)\)$/);
  });

  it("adds the login whose student ID matches, as the assignable list spells it (step b)", async () => {
    // Arrange
    const { deps, calls, lines } = harness(mirrored([JDOE]));

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${assigneesPath(12)}`]);
    assert.deepEqual(bodiesOf(calls, "POST", assigneesPath(12)), [{ assignees: [JANE_GH] }]);
    assert.deepEqual(messages(lines, "info").slice(0, -1), ["add 1 assignee to CUI-5 #12"]);
    assert.deepEqual(messages(lines, "warn"), []);
    assert.deepEqual(result, summary({ scanned: 1, assigneesAdded: 1, fetches: 5 }));
  });

  it("matches only assignable Users: a Bot or an Organization with the ID is never a match", async () => {
    // Arrange
    const assignable = [ghAssignee("ci123456-bot", "Bot"), ghAssignee("org123456", "Organization")];
    const { deps, calls, lines } = harness({ ...mirrored([{ login: "jdoe123456" }]), assignable });

    // Act
    await runSync(config({ maxWritesPerRun: 40 }), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), []);
    assert.equal(
      messages(lines, "warn")[0],
      "assignees: 1 not looked up (CUI-5); no lookup budget left by the write cap",
    );
  });

  it("adds every matched user of a multi-user field in one write", async () => {
    // Arrange
    const world: World = {
      ...mirrored(null),
      youtrackRows: [ytRow(5, { assignees: [JDOE, JROE], multiAssignee: true })],
    };
    const { deps, calls, lines } = harness(world);

    // Act
    await runSync(config(), deps);

    // Assert
    assert.deepEqual(bodiesOf(calls, "POST", assigneesPath(12)), [{ assignees: [JANE_GH, ROE_GH] }]);
    assert.deepEqual(messages(lines, "info").slice(0, -1), ["add 2 assignees to CUI-5 #12"]);
  });

  it("matches through ASSIGNEE_MAP first, spelled as the assignable list spells the login (U14)", async () => {
    // Arrange
    const { deps, calls } = harness(mirrored([{ login: "Jane.Doe" }]));
    const map = new Map([["jane.doe", "janedoe123456"]]);

    // Act
    await runSync(config({ assigneeMap: map }), deps);

    // Assert
    assert.deepEqual(bodiesOf(calls, "POST", assigneesPath(12)), [{ assignees: [JANE_GH] }]);
  });

  it("never assigns a person mapped to '-', and lists them in no warning", async () => {
    // Arrange
    const { deps, calls, lines } = harness(mirrored([JDOE]));

    // Act
    await runSync(config({ assigneeMap: new Map([["jdoe123456", null]]) }), deps);

    // Assert
    assert.deepEqual(reads(calls), FOUR_READS);
    assert.deepEqual(writeCalls(calls), []);
    assert.deepEqual(messages(lines, "warn"), []);
  });

  it("adds after the create and removes an owned login on reassignment, add first (U4)", async () => {
    // Arrange: CUI-5 moved from jdoe to jroe in YouTrack; jdoe still holds CUI-6.
    const world: World = {
      githubIssues: [
        ghIssue(12, "[CUI-5] [team] Task 5", { assignees: [ghAssignee(JANE_GH)] }),
        ghIssue(13, "[CUI-6] [team] Task 6", { assignees: [ghAssignee(JANE_GH)] }),
      ],
      youtrackRows: [ytRow(5, { assignees: [JROE] }), ytRow(6, { assignees: [JDOE] })],
      assignable: ASSIGNABLE,
    };
    const { deps, calls, lines } = harness(world);

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${assigneesPath(12)}`, `DELETE ${assigneesPath(12)}`]);
    assert.deepEqual(bodiesOf(calls, "POST", assigneesPath(12)), [{ assignees: [ROE_GH] }]);
    assert.deepEqual(bodiesOf(calls, "DELETE", assigneesPath(12)), [{ assignees: [JANE_GH] }]);
    assert.deepEqual(messages(lines, "info").slice(0, -1), [
      "add 1 assignee to CUI-5 #12",
      "remove 1 assignee from CUI-5 #12",
    ]);
    assert.deepEqual(result, summary({ scanned: 2, unchanged: 1, assigneesAdded: 1, assigneesRemoved: 1, fetches: 6 }));
  });

  it("removes the old assignee when the only issues YouTrack still gives them are resolved (U4)", async () => {
    // Arrange: CUI-12 moved from jdoe to jroe; jdoe holds only CUI-6, resolved, mirror closed.
    const world: World = {
      githubIssues: [
        ghIssue(21, "[CUI-12] [team] Task 12", { assignees: [ghAssignee(JANE_GH)] }),
        ghIssue(22, "[CUI-6] [team] Task 6", { state: "closed", assignees: [ghAssignee(JANE_GH)] }),
      ],
      youtrackRows: [ytRow(6, { resolved: RESOLVED_AT, assignees: [JDOE] }), ytRow(12, { assignees: [JROE] })],
      assignable: ASSIGNABLE,
    };
    const { deps, calls, lines } = harness(world);

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(reads(calls), FOUR_READS);
    assert.deepEqual(writeCalls(calls), [`POST ${assigneesPath(21)}`, `DELETE ${assigneesPath(21)}`]);
    assert.deepEqual(bodiesOf(calls, "POST", assigneesPath(21)), [{ assignees: [ROE_GH] }]);
    assert.deepEqual(bodiesOf(calls, "DELETE", assigneesPath(21)), [{ assignees: [JANE_GH] }]);
    assert.deepEqual(messages(lines, "warn"), []);
    assert.deepEqual(result, summary({ scanned: 2, unchanged: 1, assigneesAdded: 1, assigneesRemoved: 1, fetches: 6 }));
  });

  it("removes a student who left from the mirrors given to others while YouTrack still names them (U4)", async () => {
    // Arrange: jdoe left and CUI-5 went to jroe; YouTrack still names jdoe on epic CUI-4 and on
    // unresolved CUI-8, whose mirror was closed by hand. jane.doe, matched by the map alone, left
    // too: CUI-7 went to jroe, and she holds only resolved CUI-9.
    const world: World = {
      githubIssues: [
        ghIssue(12, "[CUI-5] [team] Task 5", { assignees: [ghAssignee(JANE_GH), ghAssignee("staffuser")] }),
        ghIssue(14, "[CUI-7] [team] Task 7", { assignees: [ghAssignee(ROE_GH), ghAssignee("OtherDev")] }),
        ghIssue(15, "[CUI-8] [team] Task 8", { state: "closed", assignees: [ghAssignee(JANE_GH)] }),
      ],
      youtrackRows: [
        ytRow(4, { type: "Epic", assignees: [JDOE] }),
        ytRow(5, { assignees: [JROE] }),
        ytRow(7, { assignees: [JROE] }),
        ytRow(8, { assignees: [JDOE] }),
        ytRow(9, { resolved: RESOLVED_AT, assignees: [{ login: "jane.doe" }] }),
      ],
      assignable: [...ASSIGNABLE, ghAssignee("OtherDev")],
    };
    const map = new Map([["jane.doe", "otherdev"]]);
    const { deps, calls } = harness(world);

    // Act
    await runSync(config({ assigneeMap: map }), deps);

    // Assert
    assert.deepEqual(reads(calls), FOUR_READS);
    const assigneeWrites = writeCalls(calls).filter((call) => call.endsWith("/assignees"));
    assert.deepEqual(assigneeWrites, [
      `POST ${assigneesPath(12)}`,
      `DELETE ${assigneesPath(12)}`,
      `DELETE ${assigneesPath(14)}`,
    ]);
    assert.deepEqual(bodiesOf(calls, "DELETE", assigneesPath(12)), [{ assignees: [JANE_GH] }]);
    assert.deepEqual(bodiesOf(calls, "DELETE", assigneesPath(14)), [{ assignees: ["OtherDev"] }]);
  });

  it("sends no lookup for someone who holds no eligible issue, so one only a lookup matches is not owned", async () => {
    // Arrange: CUI-5 moved to jroe; the old assignee holds only resolved CUI-6 and has no ID.
    const world: World = {
      githubIssues: [ghIssue(12, "[CUI-5] [team] Task 5", { assignees: [ghAssignee(JANE_GH)] })],
      youtrackRows: [
        ytRow(5, { assignees: [JROE] }),
        ytRow(6, { resolved: RESOLVED_AT, assignees: [{ login: "jane.doe", email: "jane.doe@example.com" }] }),
      ],
      assignable: ASSIGNABLE,
      commitAuthors: new Map([["jane.doe@example.com", JANE_GH]]),
    };
    const { deps, calls, lines } = harness(world);

    // Act
    await runSync(config(), deps);

    // Assert
    assert.deepEqual(reads(calls), FOUR_READS);
    assert.deepEqual(writeCalls(calls), [`POST ${assigneesPath(12)}`]);
    assert.deepEqual(messages(lines, "warn"), []);
  });

  it("keeps staff, Bots and a matching student who holds no YouTrack issue at all, so cannot be owned (U4)", async () => {
    // Arrange
    const world: World = {
      ...mirrored([JDOE]),
      githubIssues: [
        ghIssue(12, "[CUI-5] [team] Task 5", {
          assignees: [ghAssignee("staffuser"), ghAssignee("helper[bot]", "Bot"), ghAssignee(ROE_GH)],
        }),
      ],
    };
    const { deps, calls } = harness(world);

    // Act
    await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${assigneesPath(12)}`]);
  });

  it("leaves the mirror of an unassigned issue alone, even with an owned login on it (U6)", async () => {
    // Arrange
    const world: World = {
      githubIssues: [
        ghIssue(12, "[CUI-5] [team] Task 5", { assignees: [ghAssignee(JANE_GH)] }),
        ghIssue(13, "[CUI-6] [team] Task 6"),
      ],
      youtrackRows: [ytRow(5), ytRow(6, { assignees: [JDOE] })],
      assignable: ASSIGNABLE,
    };
    const { deps, calls } = harness(world);

    // Act
    await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${assigneesPath(13)}`]);
  });

  it("never touches a closed mirror and reads no assignable list for it (U7)", async () => {
    // Arrange
    const world: World = {
      ...mirrored([JDOE]),
      githubIssues: [ghIssue(12, "[CUI-5] [team] Task 5", { state: "closed" })],
    };
    const { deps, calls, lines } = harness(world);

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(reads(calls), THREE_READS);
    assert.deepEqual(writeCalls(calls), []);
    assert.deepEqual(messages(lines, "warn"), []);
    assert.deepEqual(result, summary({ scanned: 1, unchanged: 1, fetches: 3 }));
  });

  it("assigns nobody on an epic, a resolved issue or an excluded one (U13, F1)", async () => {
    // Arrange
    const world: World = {
      githubIssues: [ghIssue(12, "[CUI-5] [team] Task 5")],
      youtrackRows: [
        ytRow(4, { type: "Epic", resolved: RESOLVED_AT, assignees: [JDOE] }),
        ytRow(5, { resolved: RESOLVED_AT, assignees: [JDOE] }),
        ytRow(6, { summary: "[individual] Mine", assignees: [JDOE] }),
      ],
      assignable: ASSIGNABLE,
    };
    const { deps, calls } = harness(world);

    // Act
    await runSync(config(), deps);

    // Assert
    assert.deepEqual(reads(calls), THREE_READS);
    assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/12`]);
  });
});

describe("runSync assignees: warnings", () => {
  it("warns once about unmatched people by issue id and leaves their mirrors alone (U3, U6)", async () => {
    // Arrange: CUI-5's user has no student ID and no email, so nothing can match them.
    const world: World = {
      githubIssues: [ghIssue(12, "[CUI-5] [team] Task 5"), ghIssue(13, "[CUI-6] [team] Task 6")],
      youtrackRows: [ytRow(5, { assignees: [{ login: "nobody" }] }), ytRow(6, { assignees: [JDOE] })],
      assignable: ASSIGNABLE,
    };
    const { deps, calls, lines } = harness(world);

    // Act
    await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${assigneesPath(13)}`]);
    assert.deepEqual(messages(lines, "warn"), ["assignees: 1 unmatched (CUI-5)"]);
  });

  it("adds the loud none-matched warning when nobody matched", async () => {
    // Arrange
    const { deps, calls, lines } = harness(mirrored([{ login: "nobody" }]));

    // Act
    await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), []);
    assert.deepEqual(messages(lines, "warn"), ["assignees: 1 unmatched (CUI-5)", NONE_MATCHED]);
  });

  it("reports a person two assignable logins share an ID with as ambiguous and assigns nobody", async () => {
    // Arrange: both JaneDoe123456 and jdoe-123456 carry ID 123456; the lookups find nothing more.
    const world: World = {
      ...mirrored([{ login: "jdoe123456" }]),
      assignable: [...ASSIGNABLE, ghAssignee("jdoe-123456")],
    };
    const { deps, calls, lines } = harness(world);

    // Act
    await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), []);
    assert.deepEqual(messages(lines, "warn"), ["assignees: 1 ambiguous (CUI-5)", NONE_MATCHED]);
  });

  it("warns loudly when no scanned row has the Assignee field, reads no list and changes nothing (U6, U15)", async () => {
    // Arrange
    const world: World = {
      ...mirrored(null),
      youtrackRows: [ytRow(1, { assignees: null }), ytRow(5, { assignees: null })],
    };
    const { deps, calls, lines } = harness(world);

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(reads(calls), THREE_READS);
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`]);
    assert.deepEqual(messages(lines, "warn"), [FIELD_MISSING]);
    assert.deepEqual(result, summary({ scanned: 2, created: 1, unchanged: 1, fetches: 4 }));
  });

  it("gives an empty project no field warning: with no scanned issue there is no field to miss (U15)", async () => {
    // Arrange
    const { deps, calls, lines } = harness({ assignable: ASSIGNABLE });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(reads(calls), THREE_READS);
    assert.deepEqual(messages(lines, "warn"), []);
    assert.deepEqual(result, summary({ fetches: 3 }));
  });

  it("logs mirror index warnings, then assignee warnings, then the plan's warnings", async () => {
    // Arrange: #13 is unlabelled (index warning); CUI-6's user is unmatched (assignee warning);
    // #12 holds 10 staff, so CUI-5's matched login does not fit (plan warning).
    const staff = Array.from({ length: 10 }, (_, index) => ghAssignee(`staffuser${String(index)}`));
    const world: World = {
      githubIssues: [
        ghIssue(12, "[CUI-5] [team] Task 5", { assignees: staff }),
        ghIssue(13, "[CUI-6] [team] Task 6", { labels: [] }),
      ],
      youtrackRows: [ytRow(5, { assignees: [JDOE] }), ytRow(6, { assignees: [{ login: "nobody" }] })],
      assignable: ASSIGNABLE,
    };
    const { deps, lines } = harness(world);

    // Act
    await runSync(config(), deps);

    // Assert
    assert.deepEqual(messages(lines, "warn"), [
      'CUI-6: #13 matched by title only (no "youtrack" label)',
      "assignees: 1 unmatched (CUI-6)",
      "CUI-5 #12: 1 matched assignee not added: GitHub allows 10 per issue",
    ]);
  });
});

describe("runSync assignees: the assignable list fails (U16)", () => {
  // [case, answer to the list read, the warning's detail, fetches: 3 reads + list attempts + 1 create]
  const cases: readonly (readonly [string, () => Response | Error, string, number])[] = [
    ["502 twice", () => json(502, { message: "x" }), "HTTP 502", 6],
    ["403", () => json(403, { message: "Must have push access" }), "HTTP 403", 5],
    ["a network error twice", () => new TypeError("fetch failed"), "network error", 6],
    ["a page that is not an array", () => json(200, { message: "x" }), "unexpected response", 5],
  ];

  for (const [name, answer, detail, fetches] of cases) {
    it(`warns on ${name}, syncs no assignee and still writes the rest`, async () => {
      // Arrange
      const override: Override = (call) => (call.url.pathname === ASSIGNABLE_PATH ? answer() : undefined);
      const world: World = { ...mirrored([JDOE]), youtrackRows: [ytRow(1), ytRow(5, { assignees: [JDOE] })], override };
      const { deps, calls, lines } = harness(world);

      // Act
      const result = await runSync(config(), deps);

      // Assert
      assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`]);
      assert.deepEqual(messages(lines, "warn"), [unreadable(detail)]);
      assert.equal(lastLine(lines).level, "info");
      assert.deepEqual(result, summary({ scanned: 2, created: 1, unchanged: 1, fetches }));
    });
  }

  it("reads every page of a list that fits the fetch budget, and matches a login on a later page", async () => {
    // Arrange
    const { deps, calls } = harness({ ...mirrored([JDOE]), override: assignablePages(2, [ghAssignee(JANE_GH)]) });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.equal(calls.filter((call) => call.url.pathname === ASSIGNABLE_PATH).length, 2);
    assert.deepEqual(bodiesOf(calls, "POST", assigneesPath(12)), [{ assignees: [JANE_GH] }]);
    assert.equal(result.fetches, 6);
  });

  it("stops a long list before its pages eat into the writes' share of the guard, and sends every write", async () => {
    // Arrange: 30 closes at the default cap of 30 leave room for 10 list pages (45 - 3 - 30 - 2).
    const closes = openMirrorsOfResolved(30);
    const world: World = {
      githubIssues: [...closes.githubIssues, ghIssue(200, "[CUI-31] [team] Task 31")],
      youtrackRows: [...closes.youtrackRows, ytRow(31, { assignees: [JDOE] })],
      override: assignablePages(Number.POSITIVE_INFINITY, []),
    };
    const { deps, calls, lines } = harness(world);

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.equal(calls.filter((call) => call.url.pathname === ASSIGNABLE_PATH).length, 10);
    assert.equal(writeCalls(calls).filter((call) => call.startsWith("PATCH ")).length, 30);
    assert.deepEqual(messages(lines, "warn"), [unreadable("too many pages for the fetch budget")]);
    assert.deepEqual(result, summary({ scanned: 31, closed: 30, unchanged: 1, fetches: 43 }));
  });

  it("warns that the fetch guard was reached when the reads before the list spent it", async () => {
    // Arrange: 43 pages of GitHub issues, the milestones and the scan use all 45 fetches.
    const issuePages: Override = (call) => {
      if (call.method !== "GET" || call.url.pathname !== ISSUES_PATH) return undefined;
      const page = Number(call.url.searchParams.get("page") ?? "1");
      const next = `${GITHUB_ORIGIN}${ISSUES_PATH}?state=all&per_page=100&page=${String(page + 1)}`;
      const issues = page === 1 ? [ghIssue(12, "[CUI-5] [team] Task 5")] : [];
      return json(200, issues, page < 43 ? { link: `<${next}>; rel="next"` } : {});
    };
    const { deps, calls, lines } = harness({ ...mirrored([JDOE]), override: issuePages });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.ok(calls.every((call) => call.url.pathname !== ASSIGNABLE_PATH));
    assert.deepEqual(messages(lines, "warn"), [unreadable("fetch guard reached")]);
    assert.deepEqual(result, summary({ scanned: 1, unchanged: 1, fetches: 45 }));
  });
});

describe("runSync assignees: response check (docs/13 §2.8)", () => {
  it("warns when GitHub drops a sent login on add, and counts the write as done", async () => {
    // Arrange
    const dropped: Override = (call) =>
      isAt(call, "POST", assigneesPath(12)) ? json(201, ghIssue(12, "[CUI-5] x", { assignees: [] })) : undefined;
    const { deps, lines } = harness({ ...mirrored([JDOE]), override: dropped });

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(messages(lines, "warn"), [
      "CUI-5 #12: GitHub dropped 1 of 1 assignees on add; the next run tries again",
    ]);
    assert.equal(result.assigneesAdded, 1);
  });

  it("compares the answer ignoring A-Z case", async () => {
    // Arrange
    const lowercased: Override = (call) =>
      isAt(call, "POST", assigneesPath(12))
        ? json(201, ghIssue(12, "[CUI-5] x", { assignees: [ghAssignee("janedoe123456")] }))
        : undefined;
    const { deps, lines } = harness({ ...mirrored([JDOE]), override: lowercased });

    // Act
    await runSync(config(), deps);

    // Assert
    assert.deepEqual(messages(lines, "warn"), []);
  });

  it("warns when GitHub keeps a sent login on remove", async () => {
    // Arrange: jroe replaces jdoe on #12, but the remove answer still lists jdoe.
    const kept: Override = (call) =>
      isAt(call, "DELETE", assigneesPath(12))
        ? json(200, ghIssue(12, "[CUI-5] x", { assignees: [ghAssignee(JANE_GH), ghAssignee(ROE_GH)] }))
        : undefined;
    const world: World = {
      githubIssues: [
        ghIssue(12, "[CUI-5] [team] Task 5", { assignees: [ghAssignee(JANE_GH)] }),
        ghIssue(13, "[CUI-6] [team] Task 6", { assignees: [ghAssignee(JANE_GH)] }),
      ],
      youtrackRows: [ytRow(5, { assignees: [JROE] }), ytRow(6, { assignees: [JDOE] })],
      assignable: ASSIGNABLE,
      override: kept,
    };
    const { deps, lines } = harness(world);

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(messages(lines, "warn"), [
      "CUI-5 #12: GitHub kept 1 of 1 assignees on remove; the next run tries again",
    ]);
    assert.equal(result.assigneesRemoved, 1);
  });
});

describe("runSync assignees: failures, the cap, the deadline and rate limits", () => {
  it("caps the add with the wait line when the mirror's create failed (D4)", async () => {
    // Arrange
    const failedCreate: Override = (call) =>
      isAt(call, "POST", ISSUES_PATH) ? json(422, { message: "Validation Failed" }) : undefined;
    const world: World = {
      youtrackRows: [ytRow(1, { assignees: [JDOE] })],
      assignable: ASSIGNABLE,
      override: failedCreate,
    };
    const { deps, calls, lines } = harness(world);

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`]);
    assert.deepEqual(messages(lines, "warn"), [
      "add 1 assignee to CUI-1 capped: the mirror of CUI-1 was not created in this run",
    ]);
    assert.deepEqual(error.summary, summary({ scanned: 1, capped: 1, failed: 1, fetches: 5 }));
  });

  it("records a failed add like any failed write, with the URL and the excerpt (A10)", async () => {
    // Arrange
    const refused: Override = (call) =>
      isAt(call, "POST", assigneesPath(12)) ? json(422, { message: "Validation Failed" }) : undefined;
    const { deps, lines } = harness({ ...mirrored([JDOE]), override: refused });

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    const line =
      "add 1 assignee to CUI-5 #12 failed: POST https://api.github.com/repos/acme/mirror/issues/12/assignees" +
      ' -> HTTP 422: {"message":"Validation Failed"}';
    assert.deepEqual(error.failures, [line]);
    assert.deepEqual(messages(lines, "error"), [line, formatSummary(error.summary, "failed")]);
  });

  it("holds back the remove of an issue whose add failed, so a reassignment never leaves nobody", async () => {
    // Arrange: CUI-5 and CUI-7 both moved from jdoe to jroe; only the add to #12 fails.
    const refused: Override = (call) =>
      isAt(call, "POST", assigneesPath(12)) ? json(422, { message: "Validation Failed" }) : undefined;
    const world: World = {
      githubIssues: [
        ghIssue(12, "[CUI-5] [team] Task 5", { assignees: [ghAssignee(JANE_GH)] }),
        ghIssue(14, "[CUI-7] [team] Task 7", { assignees: [ghAssignee(JANE_GH)] }),
      ],
      youtrackRows: [
        ytRow(5, { assignees: [JROE] }),
        ytRow(6, { resolved: RESOLVED_AT, assignees: [JDOE] }),
        ytRow(7, { assignees: [JROE] }),
      ],
      assignable: ASSIGNABLE,
      override: refused,
    };
    const { deps, calls, lines } = harness(world);

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(writeCalls(calls), [
      `POST ${assigneesPath(12)}`,
      `POST ${assigneesPath(14)}`,
      `DELETE ${assigneesPath(14)}`,
    ]);
    assert.deepEqual(messages(lines, "warn"), [
      "remove 1 assignee from CUI-5 #12 capped: the add before it did not go through in this run",
    ]);
    assert.deepEqual(
      error.summary,
      summary({ scanned: 3, unchanged: 1, assigneesAdded: 1, assigneesRemoved: 1, capped: 1, failed: 1, fetches: 7 }),
    );
  });

  it("holds back the remove of an issue whose add GitHub dropped", async () => {
    // Arrange: CUI-5 moved from jdoe to jroe; GitHub answers the add without jroe's login.
    const dropped: Override = (call) =>
      isAt(call, "POST", assigneesPath(12))
        ? json(201, ghIssue(12, "[CUI-5] x", { assignees: [ghAssignee(JANE_GH)] }))
        : undefined;
    const world: World = {
      githubIssues: [ghIssue(12, "[CUI-5] [team] Task 5", { assignees: [ghAssignee(JANE_GH)] })],
      youtrackRows: [ytRow(5, { assignees: [JROE] }), ytRow(6, { resolved: RESOLVED_AT, assignees: [JDOE] })],
      assignable: ASSIGNABLE,
      override: dropped,
    };
    const { deps, calls, lines } = harness(world);

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${assigneesPath(12)}`]);
    assert.deepEqual(messages(lines, "warn"), [
      "CUI-5 #12: GitHub dropped 1 of 1 assignees on add; the next run tries again",
      "remove 1 assignee from CUI-5 #12 capped: the add before it did not go through in this run",
    ]);
    assert.deepEqual(result, summary({ scanned: 2, unchanged: 1, assigneesAdded: 1, capped: 1, fetches: 5 }));
  });

  it("caps assignee writes that would start at the run deadline (R8)", async () => {
    // Arrange: the CUI-1 create starts at 0, the CUI-3 close at 0 (sent after the pause, at
    // 1 s), and the CUI-5 add would start at 1 s.
    const world: World = {
      githubIssues: [ghIssue(12, "[CUI-5] [team] Task 5"), ghIssue(14, "[CUI-3] [team] Task 3")],
      youtrackRows: [ytRow(1), ytRow(3, { resolved: RESOLVED_AT }), ytRow(5, { assignees: [JDOE] })],
      assignable: ASSIGNABLE,
      deadline: WRITE_PAUSE_MS,
    };
    const { deps, calls, lines } = harness(world);

    // Act
    const result = await runSync(config(), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`, `PATCH ${ISSUES_PATH}/14`]);
    assert.deepEqual(messages(lines, "warn"), ["run deadline reached; 1 more action(s) capped"]);
    assert.equal(result.capped, 1);
  });

  it("caps assignee writes after a rate-limited write (R7)", async () => {
    // Arrange
    const limited: Override = (call) =>
      isAt(call, "PATCH", `${ISSUES_PATH}/14`)
        ? json(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" })
        : undefined;
    const world: World = {
      githubIssues: [ghIssue(12, "[CUI-5] [team] Task 5"), ghIssue(14, "[CUI-3] [team] Task 3")],
      youtrackRows: [ytRow(3, { resolved: RESOLVED_AT }), ytRow(5, { assignees: [JDOE] })],
      assignable: ASSIGNABLE,
      override: limited,
    };
    const { deps, calls, lines } = harness(world);

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(writeCalls(calls), [`PATCH ${ISSUES_PATH}/14`]);
    assert.deepEqual(messages(lines, "warn"), ["GitHub rate limit hit; 1 more action(s) capped"]);
  });

  it("records a rate-limited add as failed and stops the write phase (R7)", async () => {
    // Arrange
    const limited: Override = (call) =>
      isAt(call, "POST", assigneesPath(12))
        ? json(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" })
        : undefined;
    const world: World = {
      githubIssues: [ghIssue(12, "[CUI-5] [team] Task 5"), ghIssue(13, "[CUI-6] [team] Task 6")],
      youtrackRows: [ytRow(5, { assignees: [JDOE] }), ytRow(6, { assignees: [JDOE] })],
      assignable: ASSIGNABLE,
      override: limited,
    };
    const { deps, calls, lines } = harness(world);

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(writeCalls(calls), [`POST ${assigneesPath(12)}`]);
    assert.deepEqual(error.failures, [
      "add 1 assignee to CUI-5 #12 failed: POST https://api.github.com/repos/acme/mirror/issues/12/assignees" +
        ' -> HTTP 403: {"message":"API rate limit exceeded"}',
    ]);
    assert.deepEqual(messages(lines, "warn"), ["GitHub rate limit hit; 1 more action(s) capped"]);
    assert.deepEqual(error.summary, summary({ scanned: 2, capped: 1, failed: 1, fetches: 5 }));
  });

  it("records a rate-limited remove whose long body is cut as failed and stops the write phase (R7)", async () => {
    // Arrange: CUI-5 moved from jdoe to jroe, then CUI-7 needs an add. The DELETE answers a
    // rate limit whose body is cut inside a login, so the excerpt is trimmed before logging.
    const start = '{"message":"API rate limit exceeded","detail":"';
    const longBody = `${start}${" ".repeat(BODY_EXCERPT_CHARS - 5 - start.length)}${JANE_GH} and more"}`;
    const limited: Override = (call) =>
      isAt(call, "DELETE", assigneesPath(12))
        ? new Response(longBody, {
            status: 403,
            headers: { "content-type": "application/json", "x-ratelimit-remaining": "0" },
          })
        : undefined;
    const world: World = {
      githubIssues: [
        ghIssue(12, "[CUI-5] [team] Task 5", { assignees: [ghAssignee(JANE_GH)] }),
        ghIssue(14, "[CUI-7] [team] Task 7"),
      ],
      youtrackRows: [
        ytRow(5, { assignees: [JROE] }),
        ytRow(6, { resolved: RESOLVED_AT, assignees: [JDOE] }),
        ytRow(7, { assignees: [JROE] }),
      ],
      assignable: ASSIGNABLE,
      override: limited,
    };
    const { deps, calls, lines } = harness(world);

    // Act
    const error = await rejection(runSync(config(), deps));

    // Assert
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(writeCalls(calls), [`POST ${assigneesPath(12)}`, `DELETE ${assigneesPath(12)}`]);
    assert.equal(error.failures.length, 1);
    assert.match(
      error.failures[0] ?? "",
      /^remove 1 assignee from CUI-5 #12 failed: DELETE .* -> HTTP 403: \{"message"/,
    );
    assert.doesNotMatch(error.failures[0] ?? "", /JaneD/i);
    assert.deepEqual(messages(lines, "warn"), ["GitHub rate limit hit; 1 more action(s) capped"]);
    assert.deepEqual(
      error.summary,
      summary({ scanned: 3, unchanged: 1, assigneesAdded: 1, capped: 1, failed: 1, fetches: 6 }),
    );
  });

  it("caps assignee writes first under MAX_WRITES_PER_RUN", async () => {
    // Arrange
    const world: World = { youtrackRows: [ytRow(1, { assignees: [JDOE] })], assignable: ASSIGNABLE };
    const { deps, calls } = harness(world);

    // Act
    const result = await runSync(config({ maxWritesPerRun: 1 }), deps);

    // Assert
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`]);
    assert.equal(result.capped, 1);
  });
});

describe("runSync assignees: the switch (U1) and the dry run", () => {
  it("off: sends today's YouTrack request, reads no list and logs nothing about assignees", async () => {
    // Arrange: assignees in YouTrack, a row without the field, and an owned-looking login on #12.
    const world: World = {
      ...mirrored([JDOE], [ROE_GH]),
      youtrackRows: [ytRow(1, { assignees: null }), ytRow(5, { assignees: [JDOE] })],
    };
    const { deps, calls, lines } = harness(world);

    // Act
    const result = await runSync(config({ syncAssignees: false }), deps);

    // Assert
    const scan = calls.find((call) => call.url.pathname === "/api/issues");
    assert.ok(scan);
    assert.deepEqual(scan.url.searchParams.getAll("customFields"), ["Type"]);
    assert.doesNotMatch(scan.url.searchParams.get("fields") ?? "", /login|email/);
    assert.deepEqual(reads(calls), THREE_READS);
    assert.deepEqual(writeCalls(calls), [`POST ${ISSUES_PATH}`]);
    assert.deepEqual(messages(lines), ["create CUI-1 -> #101", formatSummary(result, "ok")]);
    assert.deepEqual(result, summary({ scanned: 2, created: 1, unchanged: 1, fetches: 4 }));
  });

  it("dry run: sends the list read and the lookups, previews every assignee write and sends none", async () => {
    // Arrange: CUI-1 is new; CUI-5 moves from jdoe to jroe; CUI-6's user needs lookups that find nobody.
    const world: World = {
      githubIssues: [ghIssue(12, "[CUI-5] [team] Task 5", { assignees: [ghAssignee(JANE_GH)] })],
      youtrackRows: [
        ytRow(1, { assignees: [JDOE] }),
        ytRow(5, { assignees: [JROE] }),
        ytRow(6, { assignees: [{ login: "jane.doe", email: "jane.doe@example.com" }] }),
      ],
      assignable: ASSIGNABLE,
    };
    const { deps, calls, lines } = harness(world);

    // Act
    const result = await runSync(config({ dryRun: true }), deps);

    // Assert
    assert.ok(calls.every((call) => call.method === "GET"));
    assert.deepEqual(reads(calls), [...FOUR_READS, COMMITS_PATH, SEARCH_USERS_PATH]);
    assert.deepEqual(messages(lines), [
      "assignees: 1 unmatched (CUI-6)",
      "[dry-run] would create CUI-1: [CUI-1] [team] Task 1",
      "[dry-run] would create CUI-6: [CUI-6] [team] Task 6",
      "[dry-run] would add 1 assignee to CUI-1 (new)",
      "[dry-run] would add 1 assignee to CUI-5 #12",
      "[dry-run] would remove 1 assignee from CUI-5 #12",
      formatSummary(result, "ok"),
    ]);
    assert.deepEqual(
      result,
      summary({ dryRun: true, scanned: 3, created: 2, assigneesAdded: 2, assigneesRemoved: 1, fetches: 6 }),
    );
  });
});
