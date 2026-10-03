# Assignee sync: implementation plan

> Drafted 2026-10-02 from [12-assignees.md](12-assignees.md) (research, live write test) and
> decisions U1-U17 in [08-decisions.md](08-decisions.md), together with A3, A5, A10, D2-D4, D8,
> N2, R3, R5, R7-R10, F1-F3 and V1. **Status: units A-F implemented, not yet released or
> deployed** (the verification and rollout steps after stage 3 are still open). It is a
> breaking change, released as **v1.0.0** (U1): the same PR removes the `breaking` -> minor rule
> from `.releaserc.json`. The "As built" section lists where the code refines this plan and
> supersedes the sections it names. Where this plan and the code still differ, `README.md` and
> `src/` are authoritative. Every person in an example is a placeholder (`jdoe123456`,
> `JaneDoe123456`, `123456@buas.nl`).

## As built

- **Owned logins (§2.6, U4).** The mirror adds and removes only GitHub logins it matches to a
  YouTrack user seen as an assignee anywhere in the scanned project, not only on the eligible
  issues of 2.3. Owned = the logins matched to the persons of 2.3 (lookups included), plus the
  logins that the map or step b, which need no request, match to any user of any scanned
  `Assignee` value (resolved and excluded issues, closed mirrors and epics too; `LOOKUPS_OFF`
  in `src/plan/assignee-match.ts`). So a matched person whose only open issue YouTrack gives to
  someone else is still removed from its mirror, also when every other issue they hold is
  resolved, or when they left the team. Those other users get no lookup, so one only a lookup
  would match is not owned. Someone YouTrack names on no issue at all (every issue reassigned,
  or the user deleted) cannot be owned: their login stays until someone removes it by hand.
  Desired logins, lookups and warnings still cover the persons of 2.3 only. Staff, bots and
  unmatched people are never owned, so never touched. Adds and removes still happen only on the
  mirrors of eligible issues.
- **Long assignable lists (§2.2, section 6).** Read 4's first page is always sent (section 6
  counts it); each further page only while `fetches left - MAX_WRITES_PER_RUN - 2` is above 0
  (`spareFetches` in `src/plan/assignee-lookups.ts`, the reserve the lookups use), so the list
  never eats into the writes' share of the guard. A list cut short counts as unreadable (U16):
  `assignees: could not read the assignable GitHub users (too many pages for the fetch budget); assignees are not synced this run`.
  With the default 30 writes and one-page reads that allows 10 pages (1,000 assignable users).
- **A remove waits for its add (§2.7, choice 23).** A failed add (A10) or one whose answer
  lacks a sent login (§2.8) does not stop the run, so the add-first order alone did not keep a
  reassignment from leaving nobody. The add now marks its issue in the run-local map
  (`unsettledAdds` in `src/sync/resolved.ts`), and that issue's remove is capped with
  `remove 1 assignee from CUI-12 #21 capped: the add before it did not go through in this run`
  and sends nothing. The next run tries both again.
- **Stopped lookup steps (§2.4, §2.5).** A step turned off or paused for the run still pools
  the answers it already got for a person whose every email it answered, so a person it matched
  before it stopped keeps that match. An email it has no answer for gives no result when the
  step is off (commit 403, 404 or 409: the token or the repo, which later runs do not fix by
  themselves). When a rate limit paused it (step d, `withStepPaused`), a person with an email
  it has not searched waits for that search as after a run-wide stop, and `nextLookup` never
  sends it: they end `not looked up` (or `ambiguous` if they were so far), never matched from
  the emails searched before the pause, whose answers alone could hide an ambiguity (U17). A
  failed lookup is still an answer: the step is decided from the person's other emails.
- **None-matched warning (§2.10).** It is left out when every person who is not blocked is
  `not looked up`: the aggregated warning then names the cause (the lookup budget, a rate
  limit, the deadline, failed lookups), which is not the YouTrack token.
- **Aggregated warning (§2.10).** Each category gives the number of persons, then the distinct
  issue ids that name them, so two persons whose oldest eligible issue is the same read
  `2 unmatched (ABC-12)`.
- **Lookup notes (§2.10, section 5).** The notes after `; ` follow the order of the events
  that caused them (a step turned off, then what stopped the lookups), and
  `N lookups failed (...)` always comes last, after them.
- **Persons without a lookup email (§2.4, §2.5).** A person with neither a usable email nor an
  ID has no lookup email, so steps c and d pool nothing without a request: they end
  `unmatched`, never `not looked up`, and `lookupOrder` leaves them out of the rotation.
- **Section 5 example order.** Assignee writes run by ascending `numberInProject` (§2.7), so in
  the real-run example the lines for `ABC-16` come before those for `ABC-41` and `ABC-42`. The
  README shows them in that order.
- **Assignable index (§2.4).** `evaluateChain` runs once per person and again before every
  lookup, so it indexes the assignable list (logins by key, and the logins with a single ID)
  once per list array, cached in a module-level `WeakMap` in `src/plan/assignee-match.ts`,
  instead of on every call (Workers CPU, §7). Results are the same, and callers still see a
  pure function.
- **Cut bodies (§2.11).** The trim applies once the excerpt has at least
  `BODY_EXCERPT_CHARS - 1` characters, since the cut may stop one short to keep a surrogate
  pair whole.
- **Switch off (§2.1, §2.11).** The stage then returns no identities (`NO_ASSIGNEE_STAGE`), so
  the identity redactor is empty and lines pass through unchanged; the map's keys and values
  are not added to it. Nothing logs them then: no `Assignee` field is requested, nothing is
  matched, and map problems name entry positions only.
- **YouTrack rows (unit B).** The `customFields` entries of a row are read once
  (`customFieldEntries`) and shared by `readType` (exact name, unchanged) and `readAssignee`
  (name ignoring A-Z case and a user `$type`). An empty login fails the row as `empty string`.
- **Lookup answers (unit C).** A commit page that is not an array, a search answer without an
  `items` array, a search item that is not an object, or a `User` without a non-empty login is
  a `GitHubSchemaError`, so that (step, email) is skipped as `unexpected response` (§2.5).
- **Planner (§2.6-2.7, section 5).** An excluded issue counts as `filtered` before any
  assignee check, and an issue whose only actions are assignee writes no longer counts as
  `unchanged`. `src/plan.ts` dropped its private `loginKey` for the one in
  `src/plan/assignee-match.ts`, which the R10 comparison now uses too.
- **The limit, declared twice.** `MAX_ASSIGNEES_PER_ISSUE` (`src/github/assignees.ts`) and
  `GITHUB_MAX_ASSIGNEES` (`src/plan/assignees.ts`) are pinned equal by
  `test/plan/assignee-actions.test.ts`.
- **Kind-only messages (unit C).** The helper is `jsonKind` in `src/github/client.ts`.
- **Still open:** the verification and rollout steps after stage 3 (live dry run, the
  playground run, the v1.0.0 release and the U9 rollout). The README workflow still pins v0.1.0
  and says that the assignee inputs need v1.0.0; its pin is updated once v1.0.0 is tagged.

## 1. Scope in one paragraph

Each open mirror of an unresolved YouTrack issue gets the GitHub accounts of that issue's
YouTrack assignees. A YouTrack user is matched to a GitHub login by a fixed chain: a manual map,
then the student ID in an assignable GitHub login, then the commit author of a BUas email, then a
public-email user search (U2, U17). The mirror only adds or removes logins it matched this run
(U4); everyone else on GitHub stays. Unassigned or unmatched in YouTrack leaves GitHub alone
(U6). Writes are separate `POST` and `DELETE /issues/{n}/assignees` calls (U5). Logs never show
logins or emails (U8). A switch turns it all off (U1).

## 2. Behaviour, precisely

### 2.1 The switch (U1)

`SYNC_ASSIGNEES` (input `sync-assignees`) is on by default. Off means exactly today's run: the
YouTrack request is today's URL (no `Assignee`, no user subfields), no assignable-list read, no
lookups, no assignee actions, no assignee warnings, and both new summary counts are 0.
`ASSIGNEE_MAP` is still parsed and validated when the switch is off (a bad map is a config
error either way).

### 2.2 Reads per run, in order

| #   | Read                                                                                                                                      | Sent when                                                                                                    | On failure                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| 1   | GitHub issues `state=all`, unchanged URL; each issue now also parses `assignees` (login, type)                                            | always                                                                                                       | fatal, as today                                                                   |
| 2   | GitHub milestones, unchanged                                                                                                              | always                                                                                                       | fatal, as today                                                                   |
| 3   | YouTrack scan. Switch on: `customFields=Type&customFields=Assignee` (repeated parameter) and `customFields(name,value(name,login,email))` | always                                                                                                       | fatal, as today, including a malformed `Assignee` entry                           |
| 4   | `GET /repos/{o}/{r}/assignees?per_page=100`, paged through `Link` (`listAllPages`), retry-once                                            | switch on, at least one scanned row has the field, and at least one eligible issue (2.3) has a YouTrack user | warning, and no assignee change this run (U16). It cannot cause duplicate mirrors |
| 5   | Lookups (steps c and d of 2.4), serial, retry-once, no pause between them                                                                 | only for people steps a and b leave open, within the bound of 2.5                                            | never fatal, never `failed` under A10, never stops writes (2.5)                   |

A dry run sends reads 4 and 5 too. Reads 4 and 5 are not limited by the run deadline (R8) except
as 2.5 says for lookups. YouTrack stays GET-only: the only call is still `GET /api/issues`.

### 2.3 Who is matched

- **Eligible issue** (assignee-eligible): not excluded (F1-F3), not an epic (U13: milestones
  have no assignees), unresolved, and either has an **open** mirror or has no mirror yet (it gets
  a `create` this run, R9). Closed mirrors are never touched (U7), including one that R10
  reopens this run: it gets its assignees on the next run. An issue whose create is later capped
  is still eligible; its people are matched anyway.
- **YouTrack users of an issue:** the users of its `Assignee` entry (U15). Single-user field:
  0 or 1 user; multi-user field: every user (GitHub's limit of 10 is applied in 2.6).
- **Field missing:** a row without an `Assignee` entry (field not in the project, renamed, a
  non-user field of that name, or unreadable) is never read as "unassigned". It gets no
  assignee change, like an unassigned row. If at least one issue was scanned and **no** scanned
  row has the field, one loud warning is logged and read 4 is skipped (U6, U15).
- **Persons:** the distinct YouTrack users of all eligible issues, keyed by login with A-Z
  lowercased (logins are unique in YouTrack). Order: by the lowest `numberInProject` among the
  eligible issues they are assigned to, then by their position in that issue's value. A person
  is named in warnings by the `idReadable` of that oldest eligible issue (never by login).

### 2.4 The matching chain (U17, docs/12 "Proposed matching chain")

The chain runs once per person Y. Its inputs are Y's login and email, the run's **assignable
list** (read 4, only entries with `type` `User`), the map and the lookup answers so far.

**IDs(Y)** (strings, never numbers, so a leading `0` survives):

- The ID regex is `/(?<!\d)\d{6}(?!\d)/g`. A text has an ID when it has exactly one match: none
  for 0 runs, 5- or 7-digit runs, or 2+ runs (`ab123456cd654321`).
- The login's ID, unless the login starts with `Anonymi` (A-Z compared ignoring case).
- The email's ID: only when the email has exactly one `@`, its domain is exactly `buas.nl`
  (ignoring A-Z case; `student.buas.nl` does not count), and the local part has exactly one run.
  Never from a noreply or other address.
- Both, deduplicated, login first. When they disagree both are used; the exactly-one rule
  decides.

**Emails(Y)** (lookup keys, A-Z lowercased, deduplicated, in this order): the YouTrack email when
it is a usable address, then `<id>@buas.nl` for each ID. A usable address matches
`/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/`: exactly one `@`, no space, quote or comma, so it can
neither turn `author=` into a username nor break out of the quoted search term. A `null` email
means "unknown", never a mismatch.

**Steps**, in order; the chain stops at the first that settles Y:

| Step                         | Source                                                                        | Pooled result                                                                                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a. Manual map                | `ASSIGNEE_MAP`, keyed by Y's login (A-Z lowercased)                           | No entry: go on. `-`: **blocked**, stop. A login in the assignable list (A-Z case ignored, the list's spelling kept): **matched**. Otherwise: **map target not assignable**, stop (no automatic steps) |
| b. ID in an assignable login | Assignable logins whose own single ID is one of IDs(Y)                        | Pool over all of Y's IDs                                                                                                                                                                               |
| c. Commit author             | `GET /repos/{o}/{r}/commits?author=<email>&per_page=1` per email of Emails(Y) | `[0].author.login` when `[0].author.type` is `User`; pool over all of Y's emails                                                                                                                       |
| d. Public-email search       | `GET /search/users?q="<email>" in:email type:user&per_page=100` per email     | Every item of type `User`; pool over all of Y's emails                                                                                                                                                 |

- **Pooling** (b, c, d): keep only logins in the assignable list (compared ignoring A-Z case),
  spelled as the list spells them, deduplicated. 1 login: a match. 2 or more: ambiguous. 0: go on.
- **Ambiguity carry-over:** at the first ambiguous step, its pooled logins become the candidates
  C and the chain goes on. A later step's single login is a match only if it is in C; a single
  login outside C ends the chain as **ambiguous**. A later step with 2 or more logins keeps it
  ambiguous and goes on (C stays as first set). At the end, Y is ambiguous if any step was.
- **A step needs every email answered:** c (or d) is decided only once every email of Y has an
  answer for it. An email it has not looked up yet makes Y wait for that lookup (2.5). A failed
  lookup is an answer with no login: docs/12 "Failure handling" skips that email, so the step is
  decided from Y's other emails.
- **A step that is off** for the run (2.5) counts as a step with no result.
- **Outcome** per person: `matched` (with the list's spelling and the step), `blocked`,
  `map target not assignable`, `ambiguous`, `not looked up` (no match, and a lookup Y needed was
  never sent, or failed and was skipped, this run), or `unmatched`. Only `matched` changes GitHub.

On CUI today every assignee matches at step b, so the chain sends no lookups there.

### 2.5 Lookups: bound, deadline, order, failures

- **Bound:** measured once, right before the first lookup:
  `bound = max(0, min(5, remainingFetches() - MAX_WRITES_PER_RUN - 2))`. It counts fetches
  (`fetchCount()` growth since the first lookup), so a retry counts. A lookup starts only while
  the growth is below `bound`; the last one may retry, so lookups use at most `bound + 1` fetches.
- **Deadline:** a lookup starts only while `now() < deadline - 40 s` (one worst-case request:
  2 x the 15 s timeout + the 10 s maximum retry wait, `src/http.ts`).
- **Order (rotation):** the persons whose chain needs a lookup before any lookup is sent, in the
  person order of 2.3, rotated left by `floor(now / 10 min) mod n` (`now` read once at the start
  of the assignee stage, `n` the number of those persons). Each lookup goes to the first person
  in that order whose chain still waits: all of their step c lookups, then their step d lookups,
  then the next person. Each (step, email) pair is looked up at most once per run, and an answer
  is shared by every person with that email.
- **Failures** (status only is kept, never the `HttpError` or `NetworkError` text):

| What happened                                                                                                                    | Effect                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Step c: 403 or 404, not a rate limit (the Action without `contents: read`: 403)                                                  | step c off for the run; note names the fix                                                                                                                                             |
| Step c: 409 (probably an empty repo)                                                                                             | step c off for the run                                                                                                                                                                 |
| Rate limit (`HttpError.rateLimited`) on step d                                                                                   | step d off for the run                                                                                                                                                                 |
| Rate limit on step c (the core limit)                                                                                            | all lookups stop                                                                                                                                                                       |
| Any other `HttpError` (422, 5xx), `NetworkError`, `GitHubSchemaError` or other `Error` (a 2xx that is not JSON), after the retry | that (step, email) is skipped for the run (docs/12): no login, no second try; the step is decided from the person's other emails, and a person left with no match ends `not looked up` |
| `FetchBudgetExceededError`, the bound, or the deadline                                                                           | lookups stop; waiting people end `not looked up` (or `ambiguous`)                                                                                                                      |

A person not looked up this run is simply not matched: nothing is added for them and, since only
logins matched this run are owned (2.6), nothing they hold is removed.

### 2.6 Desired assignees and the diff (U4, U6, U7, U15)

For each eligible issue:

- **Desired** = the matched logins of its YouTrack users, in the order of the value, deduplicated
  ignoring A-Z case, spelled as the assignable list spells them.
- **Owned** = every login matched to **any** person this run (A-Z lowercased). Map `-` users,
  unmatched, ambiguous and not-looked-up people own nothing.
- **Desired empty** (unassigned, field missing, or no user matched): no change at all (U6). So a
  matched assignee stays until a matched one replaces it.
- Otherwise, against the mirror's current `assignees` (none for a mirror created this run):
  - **add** = desired logins not on the issue (compared ignoring A-Z case, any type);
  - **remove** = current assignees of type `User` whose login is owned and not desired. A
    current assignee of any other type (`Bot`, ...) is never removed or re-sent (U4). Staff and
    anyone unmatched are never owned, so they stay. A hand-assigned student who matches some
    YouTrack user can be removed (U4).
  - **Limit:** GitHub allows 10 assignees. Adds are cut to `10 - current count` (all types,
    counted before removes, since adds run first); the cut ones are reported in a plan warning.

### 2.7 Actions, cost and order (U5, D4, A3)

| Situation                                             | Action            | Write                                                              | Cost |
| ----------------------------------------------------- | ----------------- | ------------------------------------------------------------------ | ---- |
| Eligible mirror lacks desired logins                  | `addAssignees`    | `POST /repos/{o}/{r}/issues/{n}/assignees` `{"assignees":[...]}`   | 1    |
| Eligible open mirror holds owned logins it should not | `removeAssignees` | `DELETE /repos/{o}/{r}/issues/{n}/assignees` `{"assignees":[...]}` | 1    |

- Bodies are plain string arrays (gotcha 15 of docs/12). Both calls are retried once: adding or
  removing twice changes nothing (live: a second DELETE is a 200 no-op).
- **Never** in the create body or the sync `PATCH`: one login that can't be assigned fails the
  whole create or PATCH with 422 (live), while the add call ignores it (201).
- **Phase:** a new last phase, after closes and reopens: milestones (0), issue creates (1), task
  creates (2), sync (3), closes (4), **assignees (5)**. Within it ascending `numberInProject`,
  and per issue the add before the remove (a reassignment that is cut off between the two leaves
  both people assigned, never nobody). Assignee writes are capped first and never delay a close.
- **Wait (D4):** `addAssignees` names its issue by YouTrack number and resolves the GitHub number
  from the run-local map (`src/sync/resolved.ts`), which existing mirrors seed and creates extend.
  A mirror created earlier in the run is found there. If its create failed or waited, the add is
  capped with `add 1 assignee to CUI-41 capped: the mirror of CUI-41 was not created in this run`,
  sends nothing, and the run goes on.
- **Cap:** the existing prefix cap (`withinWriteCap`) and the execution-time cap, deadline (R8),
  rate-limit stop (R7), fetch guard and failure handling (A10) apply unchanged.
- Never: assign on an epic or milestone, a closed mirror, an excluded issue, or a resolved one.

### 2.8 Response check

The add and remove calls answer with the issue. Its `assignees` are compared with what was sent,
ignoring A-Z case (write bodies ignore case; the answer spells logins as GitHub does, live).

- After an add, every sent login must be in the answer. Otherwise one warning:
  `CUI-12 #21: GitHub dropped 1 of 1 assignees on add; the next run tries again`.
- After a remove, no sent login may be in the answer. Otherwise:
  `CUI-12 #21: GitHub kept 1 of 1 assignees on remove; the next run tries again`.
- No extra write. The write still counts as done (like a dropped type on update). The warning
  names counts only, never a login.

### 2.9 Dry run

The dry run sends reads 1-5 and previews every assignee action, counted like a done one:
`[dry-run] would add 1 assignee to CUI-41 (new)` and
`[dry-run] would remove 1 assignee from CUI-12 #21`. It never builds the writer.

### 2.10 Warnings (U3, U6, U15, U16)

All assignee warnings are logged after the reads and lookups, before the plan's own warnings,
through the redacting logger of 2.11. Ids and counts only.

- **One aggregated warning per run** (U3), only when some category or note is non-empty. Fixed
  category order, each with the names of its persons (2.3): unmatched, ambiguous, not looked up,
  mapped to a login that cannot be assigned. Then the lookup notes after `; `. Blocked (`-`)
  people are never listed.
- **Loud warnings**, each a line of its own, logged on every run while the condition holds:
  - no scanned row has the `Assignee` field (U6, U15);
  - the assignable list was read, at least one person is not blocked, and none matched (catches
    anonymized logins after a lost Read User Basic).
- **Assignable list unreadable** (U16): one warning with the status, assignee sync skipped.
- **Limit cut** (2.6): a plan warning per issue.
- **Response check** (2.8): one per write.

### 2.11 Logging and redaction (U8)

- **Wording:** action lines, warnings and the summary carry YouTrack ids, GitHub numbers and
  counts only, never a login or an email (R3 still allows titles where it did).
- **Identity redactor:** a run-scoped, case-insensitive redactor built once the assignee stage
  is done, from every identity the run saw: the login and email of every YouTrack user in any
  scanned `Assignee` value (epics and ineligible issues too), every built `<id>@buas.nl`, every
  assignable login, every assignee login on every mirror (any type), every lookup answer, and
  every map key and value. Each identity also counts URL-encoded (`%40`) and quoted
  (`%22...%22`), as the lookup URLs spell it. Matches must not touch an ASCII letter or digit on
  either side; longer identities go first; identities under 3 characters are skipped; the
  placeholder is `[person]`.
- **Where it applies:** the run logger is rebuilt after the assignee stage as
  `redactingLogger(deps.log, text => identities(secrets(text)))`, and `WriteContext.redact` is
  the same composition, so every log line, every failure reason (a 422 body naming a login) and
  therefore `SyncFailedError.message` are scrubbed. Lines logged before the stage (mirror index
  warnings, read failures) cannot contain identities: the YouTrack parser and the GitHub parsers
  name paths and kinds only, never values.
- **Cut bodies:** `HttpError` keeps only the first 500 characters of a body (`BODY_EXCERPT_CHARS`,
  src/http.ts:179), so a login can straddle the cut and its first half would escape the
  redactor. An assignee write's `HttpError` is therefore passed on with its excerpt trimmed when
  the excerpt fills the cut: the trailing run of `[A-Za-z0-9._%+@-]` characters is dropped
  (status, URL and `rateLimited` unchanged, so A10 and R7 see the same error).
- **Workers traces:** lookup URLs carry an email in the query string, and the Worker's
  observability keeps query strings in logs and traces while `redact_query_string` is `false`
  (wrangler.example.jsonc today). The example turns it on (section 3).
- **Lookups and the assignable list** never log an error's message: only the step and the
  status (`HTTP 403`), or `network error`, `unexpected response`, `fetch guard reached`.
- **Errors thrown to the host:** new `RangeError`s and schema errors never echo a login or an
  email.

## 3. Config surface

| Setting          | Input            | Kind                                     | Default | Parsing                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ---------------- | ---------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SYNC_ASSIGNEES` | `sync-assignees` | var                                      | `true`  | Unset: on. Set: trimmed, A-Z case ignored, `true` or `false`; anything else, blank included, is the problem `SYNC_ASSIGNEES must be "true" or "false"`                                                                                                                                                                                                                                                                                                      |
| `ASSIGNEE_MAP`   | `assignee-map`   | secret (Action, Worker); `.env` for Node | empty   | Unset or blank: no map (an exception to the empty-input rule, like `reopen-closed-by`). Otherwise entries split on commas and line breaks (`\r` too), trimmed, blank entries skipped. Each entry is `<youtrack-login>=<github-login>` with exactly one `=`; both sides trimmed. Key: non-empty, no whitespace. Value: `-` or `/^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/` (a user login, no `[bot]`). Keys compare with A-Z lowercased; a repeated key is a problem |

- **Map problems** name the entry's position among the non-blank entries, never its text:
  `ASSIGNEE_MAP entry 3 must have the form <youtrack-login>=<github-login>`,
  `ASSIGNEE_MAP entry 3: the YouTrack login must not be empty or contain spaces`,
  `ASSIGNEE_MAP entry 3: the GitHub login must be a user login or "-"`,
  `ASSIGNEE_MAP entries 2 and 5 have the same YouTrack login`. Every problem of every entry is
  reported at once (one `ConfigError`, as today). Two keys may map to the same GitHub login.
- **`Config`** gains `syncAssignees: boolean` and `assigneeMap: AssigneeMap`, a
  `ReadonlyMap<string, string | null>` from the A-Z-lowercased YouTrack login to the GitHub login
  as written, `null` for `-`.
- **`ENV_KEYS`** gains `SYNC_ASSIGNEES` and `ASSIGNEE_MAP`, after `REOPEN_CLOSED_BY`.
- **`.env.example`:** `SYNC_ASSIGNEES=true` and `ASSIGNEE_MAP=` with comments (format, `-`,
  personal data: never in a committed file; one line only, since systemd's `EnvironmentFile=`
  has no multi-line values).
- **`wrangler.example.jsonc`:** `"SYNC_ASSIGNEES": "true"` in `vars`. `ASSIGNEE_MAP` is not a
  var: a comment says `wrangler secret put ASSIGNEE_MAP` (optional). `observability` gets
  `"redact_query_string": true` ("Whether query strings are removed from request URLs in logs
  and traces", wrangler's schema), so lookup emails stay out of Workers Logs and traces (2.11).
  Then `npm run gen:worker-types`, which reads `.env.example` too, so both keys land in the
  committed `worker-configuration.d.ts`.
- **`action.yml`:** inputs `sync-assignees` (default `"true"`) and `assignee-map` (default `""`,
  description: pass it from a secret, run logs print inputs), and the env lines
  `SYNC_ASSIGNEES: ${{ inputs.sync-assignees }}` and `ASSIGNEE_MAP: ${{ inputs.assignee-map }}`.
  The live test showed the log prints an input twice, under `with:` and `env:` (U14); a secret
  is masked there by GitHub's secret masking, which the test did not exercise. GitHub's docs say
  masking relies on exact matches and advise against structured secret values, so the README
  asks for the map on one line (commas, no line breaks).
- **README workflow:** the job's `permissions:` gains `contents: read` (step c; without it the
  Action gets 403 and step c is off, U17), and the step gains
  `assignee-map: ${{ secrets.ASSIGNEE_MAP }}` (an unset secret is an empty string: no map).
- **`test/action/action.test.ts`:** the existing `ENV_KEYS` check covers the env lines. New:
  `sync-assignees` defaults to `"true"` and parses to on; `assignee-map` defaults to `""` and
  parses to an empty map; `sync-assignees: ""` is a config error.

## 4. Work units

Stage 1 is four units in parallel, one git worktree and one agent each. Stage 2 (one unit)
starts after all four are merged; stage 3 after stage 2. Every unit branches from
`feat/assignees` and merges back into it, never into `main`: the whole feature reaches `main` as
one squash-merged PR titled `feat!: ...`, which also carries the `.releaserc.json` change (U1:
"the same PR"; V2). In stage 1 no file is owned by two units; each unit must pass
`npm run check` in its own worktree (run `npm ci` first: a fresh worktree has no
`node_modules`). Every unit follows TDD (tests
first), erasable TypeScript only (no enums, namespaces or parameter properties), `.ts` import
extensions, immutable data, no new dependencies, and no real personal data in fixtures (use
`jdoe123456`, `JaneDoe123456`, `123456@buas.nl`, `staffuser`).

Shared rule for every unit: "A-Z lowercased" means `text.replace(/[A-Z]+/g, (s) => s.toLowerCase())`
(no Unicode case mapping).

### Unit A: config (stage 1)

**Owns:** `src/config.ts`, `test/config/*` (new `test/config/assignees.test.ts`),
`.env.example`, `wrangler.example.jsonc`, `worker-configuration.d.ts` (regenerated, never edited
by hand), `action.yml`, `test/action/*`, and in `test/sync/fixtures.ts` only the `BASE_CONFIG`
object (add `syncAssignees: true, assigneeMap: new Map()`).

**Must not touch:** anything else in `src/`, any other line of `test/sync/fixtures.ts`, docs.

```ts
// src/config.ts
export const ENV_KEYS = [/* existing nine */ "SYNC_ASSIGNEES", "ASSIGNEE_MAP"] as const;
/** YouTrack login (A-Z lowercased) -> GitHub login as written; null: "-", never assign (U14). */
export type AssigneeMap = ReadonlyMap<string, string | null>;
export const ASSIGNEE_MAP_NEVER = "-";
export const DEFAULT_SYNC_ASSIGNEES = true;
export type Config = {
  /* existing fields */
  /** SYNC_ASSIGNEES (U1): sync GitHub assignees from YouTrack's Assignee field. */
  readonly syncAssignees: boolean;
  /** ASSIGNEE_MAP (U14): checked first by the matching chain; empty when unset. */
  readonly assigneeMap: AssigneeMap;
};
```

**Tests** (`test/config/assignees.test.ts`, plus updated `fixtures.ts` `EXPECTED_CONFIG` and any
test that lists `ENV_KEYS`): switch unset, `true`, `false`, and `FALSE` with spaces around it;
blank and `no` fail;
map unset and blank are empty; one entry; commas, newlines and CRLF; blank entries skipped; keys
lowercased; `-` is `null`; repeated key in other case fails naming both positions; no `=`, two
`=`, empty key, key with a space, value with a leading `-`, a 40-character value and a `[bot]`
value each fail; several problems reported at once; no problem text contains any key or value
of the fixtures. `test/action`: the cases of section 3.

### Unit B: youtrack (stage 1)

**Owns:** `src/youtrack.ts`, `test/youtrack/*` (new `test/youtrack/assignee.test.ts`).

**Must not touch:** `YouTrackIssue` itself (keep it person-free, see `ScannedIssue`), any other
`src/` file, any test outside `test/youtrack/`.

```ts
// src/youtrack.ts
/** The user custom field whose users become GitHub assignees (U15), fixed like YOUTRACK_TYPE_FIELD. */
export const YOUTRACK_ASSIGNEE_FIELD = "Assignee";
/** One user value of the Assignee field: the login, and the email when set and visible. */
export type YouTrackUser = { readonly login: string; readonly email: string | null };
/**
 * A row's Assignee field: "absent" (no entry: not requested, not in the project, renamed, a
 * non-user field of that name, or unreadable), or its users ([] = unassigned).
 */
export type YouTrackAssignee =
  { readonly kind: "absent" } | { readonly kind: "users"; readonly users: readonly YouTrackUser[] };
/** A scanned row: the planner's YouTrackIssue plus its Assignee field. */
export type ScannedIssue = YouTrackIssue & { readonly assignee: YouTrackAssignee };
export type ScanOptions = { readonly assignees: boolean };
export function issueFieldsParam(options?: ScanOptions): string;
export function parseYouTrackIssue(row: JsonValue): ScannedIssue;
export function parseProjectIssue(row: JsonValue, project: string): ScannedIssue;
export async function fetchProjectIssues(
  http: HttpClient,
  source: YouTrackSource,
  options?: ScanOptions, // default { assignees: false }: today's request, unchanged
): Promise<readonly ScannedIssue[]>;
```

- **Request with `assignees: true`:** the page URL is built from ordered pairs (a `Record` can't
  repeat a key): `query`, `fields`, `customFields=Type`, `customFields=Assignee`, `$top`, `$skip`.
  `fields` ends with `customFields(name,value(name,login,email))`; `login` and `email` are
  checked against the generated `User` schema with `satisfies`, like the other field names.
  With `assignees: false` (the default) the URL is byte for byte today's.
- **Parsing** (always, whatever was requested): the Assignee entry is the `customFields` entry
  whose `name` equals `Assignee` ignoring A-Z case **and** whose `$type` is
  `SingleUserIssueCustomField` or `MultiUserIssueCustomField`; an entry of another `$type` (or
  none) is ignored, so the row reads as absent. Two such recognised entries fail the row. Single:
  `value` must be `null` (no users) or a user object. Multi: `value` must be `null` or an array
  of user objects (`null` and `[]`: no users; which one YouTrack sends for an empty multi-user
  value is undocumented, docs/12). A user object must have a non-empty string `login`; `email` is a
  string, or `null`, or missing (both `null`; `""` is `null` too). Every other key, `name` and
  `fullName` included, is dropped at this boundary. Shape errors throw `YouTrackSchemaError`
  through `fieldError` (path and kind, never a value). The Type parsing is unchanged (exact
  name).
- **Tests:** both URLs exactly (the pinned off URL in `fixtures.ts` stays); single user, `null`,
  multi with two users, multi `[]`, multi `null`, missing entry, lowercase `assignee` name, an Assignee of
  `$type` `SingleEnumIssueCustomField` (absent), two entries, value of the wrong kind, user
  without login, numeric login, missing and empty email, `fullName` not kept; no error message
  contains a fixture login or email; `ISSUE_KEYS` and the expected parsed rows gain `assignee`.

### Unit C: github (stage 1)

**Owns:** `src/github/*` (new `src/github/assignees.ts` and `src/github/users.ts`),
`test/github/*` (new `test/github/assignees.test.ts`, `test/github/users.test.ts`), and in
`test/plan/fixtures.ts` only the `ghIssue` defaults object (add `assignees: Object.freeze([])`).

**Must not touch:** `MirrorRef` and `src/plan/*`, `src/sync/*`, any other line of
`test/plan/fixtures.ts`. No sync logic.

```ts
// src/github/assignees.ts (imports client.ts and pages.ts only, never issues.ts)
/** An assignee as GitHub reports it: the login verbatim and the account type ("User", "Bot", ...; "" if absent). */
export type GitHubAssignee = { readonly login: string; readonly type: string };
export const MAX_ASSIGNEES_PER_ISSUE = 10;
/** `assignees` of an issue object: missing or null -> []; not an array -> GitHubSchemaError(context); items without a string login are skipped. */
export function parseAssignees(value: JsonValue | undefined, context: string): readonly GitHubAssignee[];
/** GET /repos/{o}/{r}/assignees?per_page=100, every Link page, retry-once. A page must be an array. */
export async function listAssignableUsers(http: HttpClient, target: GitHubTarget): Promise<readonly GitHubAssignee[]>;
/** POST /repos/{o}/{r}/issues/{n}/assignees {assignees: logins}, retry-once; the answer's assignees. */
export async function addAssignees(
  http: HttpClient,
  target: GitHubTarget,
  issueNumber: number,
  logins: readonly string[],
): Promise<readonly GitHubAssignee[]>;
/** DELETE /repos/{o}/{r}/issues/{n}/assignees {assignees: logins}, retry-once; the answer's assignees. */
export async function removeAssignees(
  http: HttpClient,
  target: GitHubTarget,
  issueNumber: number,
  logins: readonly string[],
): Promise<readonly GitHubAssignee[]>;

// src/github/users.ts
/** GET /repos/{o}/{r}/commits?author=<email>&per_page=1, retry-once: [0].author.login if a User, else null. */
export async function findCommitAuthor(http: HttpClient, target: GitHubTarget, email: string): Promise<string | null>;
/** GET /search/users?q="<email>" in:email type:user&per_page=100, retry-once: logins of type User. */
export async function searchUsersByEmail(
  http: HttpClient,
  target: GitHubTarget,
  email: string,
): Promise<readonly string[]>;

// src/github/issues.ts: GitHubIssue gains one field, filled by
// parseAssignees(value["assignees"], `GitHub issue #${n}`) in parseGitHubIssue:
//   readonly assignees: readonly GitHubAssignee[];
```

- Query strings are built with `URLSearchParams`, so the expected URLs are
  `.../repos/acme/mirror/assignees?per_page=100`,
  `.../repos/acme/mirror/commits?author=123456%40buas.nl&per_page=1` and
  `https://api.github.com/search/users?q=%22123456%40buas.nl%22+in%3Aemail+type%3Auser&per_page=100`.
- `addAssignees` and `removeAssignees` throw `RangeError` before any request for 0 or more than
  10 logins, an empty login, or a bad issue number; the lookups for an email without exactly one
  `@`. No `RangeError`, `GitHubSchemaError` or other message quotes a login or email:
  `describeJson`/`quote` are never used on assignee, login or email values (add a kind-only
  helper to `client.ts`). A non-object add or remove answer is a `GitHubSchemaError`. HTTP
  errors propagate unchanged (stage 2 classifies them).
- **Tests:** issue parse with `assignees` missing, `null`, `[]`, a User, a Bot, a non-array
  (error), items without login (skipped); updated `expected` issues in the existing tests; list
  paging and a non-array page; add and remove: method, URL, plain-string body, retry-once,
  answer parsed, every `RangeError`; commit author: `[]`, `author: null`, a Bot, a User; search:
  no items, a User and an Organization; no error message contains a fixture login or email.

### Unit D: matcher (stage 1)

**Owns (all new):** `src/utils/student-id.ts`, `src/utils/identity-redact.ts`,
`src/plan/assignee-match.ts`, `src/plan/assignee-lookups.ts`, `src/plan/assignees.ts`, and their
tests `test/utils/student-id.test.ts`, `test/utils/identity-redact.test.ts`,
`test/plan/assignee-match.test.ts`, `test/plan/assignee-lookups.test.ts`,
`test/plan/assignees.test.ts`.

**Must not touch or import:** `src/youtrack.ts`, `src/github/*`, `src/config.ts`, any existing
file (it may import the `Redact` type from `src/utils/redact.ts`). All inputs are its own plain
readonly types, structurally equal to the other units' (`YouTrackUser`, `GitHubAssignee`,
`AssigneeMap`), so stage 2 passes them straight in. Pure: no I/O, no clock, no mutation.

```ts
// src/utils/student-id.ts
export const BUAS_EMAIL_DOMAIN = "buas.nl";
export type PersonIdentity = { readonly login: string; readonly email: string | null };
/** The text's only 6-digit run (/(?<!\d)\d{6}(?!\d)/g), as a string; null for 0 or 2+ runs. */
export function singleStudentId(text: string): string | null;
/** True for /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/. */
export function isUsableEmail(text: string): boolean;
/** IDs(Y) of 2.4: login ID (not for a login starting with "Anonymi", A-Z case ignored), then the buas.nl email ID. */
export function studentIds(person: PersonIdentity): readonly string[];
/** Emails(Y) of 2.4: the usable email, then <id>@buas.nl per ID; A-Z lowercased, deduplicated. */
export function lookupEmails(person: PersonIdentity): readonly string[];

// src/plan/assignee-match.ts
export type ManualMap = ReadonlyMap<string, string | null>; // = AssigneeMap
export type LookupStep = "commit" | "search";
export type LookupAnswer =
  | { readonly kind: "found"; readonly logins: readonly string[] } // commit: 0 or 1 login
  | { readonly kind: "failed" };
/** Answers so far, keyed by lowercased email, and the steps turned off for the run. */
export type LookupState = {
  readonly commit: ReadonlyMap<string, LookupAnswer>;
  readonly search: ReadonlyMap<string, LookupAnswer>;
  readonly off: ReadonlySet<LookupStep>;
};
export const NO_LOOKUPS: LookupState;
export function withAnswer(state: LookupState, step: LookupStep, email: string, answer: LookupAnswer): LookupState;
export function withStepOff(state: LookupState, step: LookupStep): LookupState;
/** assignable: the logins of type User from the assignable list, as GitHub spells them. */
export type MatchBasis = { readonly assignable: readonly string[]; readonly map: ManualMap };
export type MatchContext = MatchBasis & { readonly lookups: LookupState };
export type MatchStep = "map" | "login-id" | "commit" | "search";
export type MatchOutcome =
  | { readonly kind: "matched"; readonly login: string; readonly step: MatchStep }
  | { readonly kind: "blocked" }
  | { readonly kind: "map-target-not-assignable" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "not-looked-up" }
  | { readonly kind: "unmatched" };
export type ChainState =
  | MatchOutcome
  | { readonly kind: "needs-lookup"; readonly step: LookupStep; readonly email: string; readonly ambiguous: boolean };
/** A-Z lowercased; the key of persons, the map and owned logins. */
export function loginKey(login: string): string;
/** 2.4 for one person with the answers so far. */
export function evaluateChain(person: PersonIdentity, context: MatchContext): ChainState;
/** needs-lookup -> "ambiguous" if ambiguous so far, else "not-looked-up"; any other state as is. */
export function finalOutcome(state: ChainState): MatchOutcome;
/** finalOutcome(evaluateChain(...)) per person, keyed by loginKey(login). */
export function matchAll(persons: readonly PersonIdentity[], context: MatchContext): ReadonlyMap<string, MatchOutcome>;

// src/plan/assignee-lookups.ts
export const MAX_LOOKUPS_PER_RUN = 5;
export const LOOKUP_FETCH_RESERVE = 2;
export const LOOKUP_ROTATION_MS = 600_000;
export type PlannedLookup = { readonly step: LookupStep; readonly email: string };
/** max(0, min(MAX_LOOKUPS_PER_RUN, remainingFetches - maxWrites - LOOKUP_FETCH_RESERVE)). */
export function lookupBudget(remainingFetches: number, maxWrites: number): number;
/** floor(now / LOOKUP_ROTATION_MS). */
export function rotationIndex(now: number): number;
/** The persons that need a lookup with no answers yet, in input order, rotated left by rotation mod n. */
export function lookupOrder<P extends PersonIdentity>(
  persons: readonly P[],
  basis: MatchBasis,
  rotation: number,
): readonly P[];
/** The first person in `order` whose chain waits for a lookup, and that lookup; null: none needed. */
export function nextLookup(order: readonly PersonIdentity[], context: MatchContext): PlannedLookup | null;

// src/plan/assignees.ts
export const GITHUB_MAX_ASSIGNEES = 10;
export type CurrentAssignee = { readonly login: string; readonly type: string }; // = GitHubAssignee
export type NamedPerson = PersonIdentity & { readonly name: string }; // name: e.g. "CUI-12"
export type AssigneeDiff = {
  readonly add: readonly string[];
  readonly remove: readonly string[];
  readonly notAdded: number;
};
/** 2.6 desired: matched logins of `users` in order, deduplicated by loginKey. */
export function desiredAssignees(
  users: readonly PersonIdentity[],
  outcomes: ReadonlyMap<string, MatchOutcome>,
): readonly string[];
/** 2.6 owned: loginKey of every matched login. */
export function ownedLogins(outcomes: ReadonlyMap<string, MatchOutcome>): ReadonlySet<string>;
/** 2.6 diff; desired [] -> nothing. */
export function assigneeDiff(
  current: readonly CurrentAssignee[],
  desired: readonly string[],
  owned: ReadonlySet<string>,
): AssigneeDiff;
/** The aggregated warning of 2.10 and section 5, or null when there is nothing to say. */
export function assigneeWarning(
  persons: readonly NamedPerson[],
  outcomes: ReadonlyMap<string, MatchOutcome>,
  notes: readonly string[],
): string | null;
/** The "none matched" loud warning of 2.10, or null. */
export function noneMatchedWarning(
  persons: readonly NamedPerson[],
  outcomes: ReadonlyMap<string, MatchOutcome>,
): string | null;

// src/utils/identity-redact.ts
export const PERSON_REDACTED = "[person]";
export const MIN_IDENTITY_CHARS = 3;
/** 2.11: case-insensitive, raw + encodeURIComponent + encodeURIComponent(`"${id}"`) variants, longest first, no letter or digit on either side. */
export function identityRedactor(identities: readonly string[]): Redact;
```

**Tests** (every row of the docs/12 edge-case table that is pure has a case):

- `student-id`: `jdoe123456`, `JaneDoe123456`, `jdoe-123456`, `jdoe123456_buas` give `123456`;
  5 and 7 digits, two runs, no digits give none; `012345` stays a string; `Anonymized123456`
  gives no login ID; email ID only for exactly `buas.nl` (also `BUAS.NL`), not
  `student.buas.nl`, not a noreply address with an ID-like number; login and email IDs that
  differ give both; emails deduplicated, lowercased, unusable ones (two `@`, a quote, a space)
  dropped, built address added when the email is `null`.
- `assignee-match`: each step settles; map `-`, map target not assignable (automatic steps not
  tried); map target in other case returns the list spelling; two logins with one ID ambiguous;
  ambiguity settled by a later single login in C, kept by one outside C; results outside the
  assignable list ignored; a step that is off; a failed answer is skipped (the other email of
  the step still matches; with no match anywhere the person is `not-looked-up`, not
  `unmatched`); waiting for the second email of a step; `finalOutcome` both ways; two YouTrack
  users with one ID both matched.
- `assignee-lookups`: the bound at 30, 34, 38, 39 and 40 writes with 41 fetches left (5, 5, 1,
  0, 0); rotation picks a different first person for consecutive indexes; persons settled by a
  or b are not in the order; depth-first c then d; an email shared by two persons is looked up
  once; `null` when nobody waits.
- `assignees`: add, remove, reassignment (add and remove), desired empty, Bot never removed,
  unowned User never removed, owned but desired kept, case-insensitive compare, limit cut with
  `notAdded`, warning wording with each category, notes, blocked people left out, `null` when
  clean; none-matched warning only with at least one non-blocked person and no match.
- `identity-redact`: case-insensitive; URL-encoded and quoted variants; inside a 422 body;
  `jdoe` does not redact inside `jdoe1234567` but `jdoe-123456` (longer, given) wins; identities
  under 3 characters ignored; regex metacharacters in an email; no identities: text unchanged.

### Unit E: integration (stage 2, after A-D are merged)

**Owns:** `src/sync.ts`, `src/sync/*` (new `src/sync/assignees.ts`,
`src/sync/execute-assignees.ts`), `src/plan.ts`, `src/plan/*` except D's three new files (new
`src/plan/assignee-scope.ts`), `src/http*` only if needed, `test/sync/*`, `test/plan/*` except
D's three new test files.

**Must not touch:** units A-D's public signatures (a bug there is fixed in a follow-up commit
in that file, noted in the PR), README and docs (unit F).

Work, in TDD order:

1. **Scope** (`src/plan/assignee-scope.ts`): one predicate for 2.3, used by both the assignee
   stage and the planner:
   `assigneeEligible(input: Pick<PlanInput, "youtrackIssues" | "mirrors" | "excludePrefix">): ReadonlySet<number>`.
2. **Mirror index:** `MirrorRef` picks `assignees` from `GitHubIssue`; `toMirrorRef` copies it.
3. **Planner:** `PlanInput` gains `assignees: AssigneeSync | null` (null: switch off, field
   missing, nobody to match, or the list unreadable: no assignee action). The `Action` union
   gains the two kinds below; `writeCost` 1 each; `phaseOf` returns the new `PHASE.assignees`
   (5); the create path appends an `addAssignees` with the desired logins; the existing-mirror
   path adds both from `assigneeDiff`, only for eligible issues; a `notAdded > 0` adds the plan
   warning of section 5. Any existing private `loginKey` may switch to D's.

   ```ts
   export type AssigneeSync = {
     /** numberInProject -> desiredAssignees of the issue; issues without a matched user are absent. */
     readonly desired: ReadonlyMap<number, readonly string[]>;
     /** ownedLogins of the run (U4). */
     readonly owned: ReadonlySet<string>;
   };
   // The two new members of the Action union. The add names its mirror by YouTrack number
   // (resolved at execution, D4); the remove only exists for an existing mirror.
   type AddAssigneesAction = {
     readonly kind: "addAssignees";
     readonly issue: YouTrackIssue;
     readonly logins: readonly string[];
   };
   type RemoveAssigneesAction = {
     readonly kind: "removeAssignees";
     readonly issue: YouTrackIssue;
     readonly mirror: MirrorRef;
     readonly logins: readonly string[];
   };
   ```

4. **Assignee stage** (`src/sync/assignees.ts`), between the reads and the plan:
   `readAssignees(run, inputs): Promise<AssigneeStage>` with
   `AssigneeStage = { sync: AssigneeSync | null; identities: readonly string[]; warnings: readonly string[] }`.
   It applies 2.2 (reads 4, 5), 2.3, 2.4, 2.5 and 2.10 using units B-D, and catches every error
   of reads 4 and 5 as section 2 says. The lookup loop: `lookupOrder` once, then
   `nextLookup` / budget / deadline checks before each lookup, `withAnswer` or `withStepOff`
   after it, and `matchAll` at the end. The deadline margin constant
   `LOOKUP_DEADLINE_MARGIN_MS = 2 * DEFAULT_TIMEOUT_MS + DEFAULT_MAX_RETRY_AFTER_MS` lives here.
5. **`src/sync.ts`:** pass `{ assignees: config.syncAssignees }` to `fetchProjectIssues`; run
   the stage; build the identity redactor and the second logger (2.11); log the stage's
   warnings; pass `assignees` to `planActions`; `WriteContext.redact` is the composed redactor;
   `RunSummary`, `toSummary` and `SUMMARY_FIELDS` gain `assigneesAdded` and `assigneesRemoved`
   after `updated` (section 5); the `formatSummary` doc example.
6. **Execution:** `GitHubWriter` gains `addAssignees(issueNumber, logins)` and
   `removeAssignees(issueNumber, logins)` (through `send`, retry-once);
   `src/sync/execute-assignees.ts` has `executeAddAssignees(action, context, resolved)` (resolve
   with `mirrorFor`, `waitsFor` when missing, response check 2.8) and
   `executeRemoveAssignees(action, context)`, both passing an `HttpError` on with the trimmed
   excerpt of 2.11 "Cut bodies" (`src/http.ts` exports `BODY_EXCERPT_CHARS` for it, its only
   change); `executeAction` dispatches both; `Tally` and
   `Counter` gain `assigneesAdded`, `assigneesRemoved`; `describe.ts` gains
   `describeAddAssignees(resolved, action)` and `describeRemoveAssignees(action)`; `preview.ts`
   previews both.
7. **Fixtures** (`test/sync/fixtures.ts`): `ytRow` gets an `assignees` option (left out: an
   `Assignee` entry with `value: null`, so every existing test stays unassigned; `null`: no
   entry; an array: a single-user entry, or a multi-user one with a `multi` flag); `ghIssue`
   gets `assignees`; the fake GitHub answers `GET /assignees` (world `assignable`, default `[]`),
   `POST`/`DELETE /issues/{n}/assignees` (echoing the sent logins on add, an empty list on
   remove, or a world-set answer to simulate drops or a 422), `GET /commits` and
   `GET /search/users` (world maps by email); the created and patched answers carry
   `assignees: []`; `summary()` defaults gain the two zero counts. `test/plan/fixtures.ts`:
   `mirror()` default `assignees: []`, `plan()` passes `assignees: null` unless given.
8. **Existing tests:** the two new summary fields in every pinned summary line: the exact
   strings at `test/sync/hierarchy-e2e.test.ts:128` and `test/sync/sync.test.ts:58`, and the
   regex at `test/sync/reopen.test.ts:264`, whose `updated=1 milestonesCreated=0` the new fields
   split (`reopen.test.ts:84` still matches); a test pins `GITHUB_MAX_ASSIGNEES` (D) equal to
   `MAX_ASSIGNEES_PER_ISSUE` (C), the one limit the two stage-1 units had to declare twice;
   hand-written YouTrack rows without an `Assignee`
   entry either gain one or the test sets `syncAssignees: false`, so no stray loud warning. The
   13 fetch pins (12 `fetches: 3` in 7 files and 1 `fetches=3`) stay at 3: an unassigned
   project reads no assignable list (2.2, read 4).

**New tests:**

| File                                 | Cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/plan/assignee-scope.test.ts`   | eligible: open mirror, new issue; not: closed mirror, resolved, epic, excluded by own prefix and by an ancestor's                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `test/plan/assignee-actions.test.ts` | add, remove, both in order; phase 5 after closes; prefix cap takes assignee actions last; `assignees: null` plans none; create then add; closed mirror, resolved, epic, excluded get none; limit warning                                                                                                                                                                                                                                                                                                                                                                                                   |
| `test/sync/assignees.test.ts`        | e2e: new mirror gets its assignee after its create (4 reads); reassignment; staff and Bot stay; unassigned and unmatched leave GitHub alone with the aggregated warning; field missing on every row: loud warning, 3 reads; switch off: today's YouTrack URL, 3 reads, no assignee lines; list 502 twice and 403: warning, the run ends ok and other writes go on; dry run: preview lines, no write, list and lookups sent; dropped add warned; failed create: add capped with the wait line; deadline and rate limit stop assignee writes like any other                                                  |
| `test/sync/assignee-lookups.test.ts` | match through step c for a login without an ID; step c 403 (note, step d still runs), 409; step d rate limit (off), step c rate limit (all stop); 502 twice: not looked up; bound with 38 and 40 writes; deadline margin; rotation across two runs 10 minutes apart; retries count against the bound; one lookup per (step, email)                                                                                                                                                                                                                                                                         |
| `test/sync/assignee-privacy.test.ts` | U8: with `jdoe123456`, `JaneDoe123456`, `123456@buas.nl`, `staffuser` and a map entry in the fixtures, a 422 add answer and a 422 update answer whose bodies name them, a 422 add answer over 500 characters with a login across the cut, a commit lookup that fails with 502 twice and a search lookup that answers 200 with a non-JSON body (both URLs carry the email), and the assignable list failing: no log line, failure line or `SyncFailedError.message` (printed as `node.ts` prints it) contains any of them, or a 5-character or longer start of one, in any case, raw, URL-encoded or quoted |

### Unit F: docs (stage 3, after E is merged)

**Owns:** `README.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `.releaserc.json`, `docs/README.md`,
`docs/12-assignees.md` (header note only), `docs/13-assignees-plan.md` ("As built" section),
`docs/08-decisions.md` (V1 row only, if the release rule text needs it).

- **`.releaserc.json`:** remove `{ "breaking": true, "release": "minor" }` (U1, V1); keep the
  `revert` rule. **`CONTRIBUTING.md`:** the release table for 1.x (breaking: major).
- **README:** Features bullet; "Using it day to day" (the "Assign ... as you like" contract,
  README.md:69: assignees the mirror matched follow YouTrack, everyone else stays); the workflow
  (`contents: read`, `assignee-map`); step 4's example lines; step 5 rollout (U9: dry run,
  `max-writes-per-run: "1"`, tell the team: assigning notifies and subscribes people); Inputs
  table and the Permissions and Empty inputs bullets; "What a run does" (read 4, lookups,
  phase 5, log lines); a new "Assignees" section (chain, ownership, map format on one line,
  privacy); "Hand-made links stay" (README.md:550, an assignee line); "What it never does"
  (never removes an assignee it did not match this run, never touches a Bot); Failures; "Dry
  run" (reads 4 and 5 are sent); Configuration table and the Worker and systemd notes (the
  Worker's map is set with `wrangler secret put ASSIGNEE_MAP`; an existing `wrangler.jsonc`
  should copy `"redact_query_string": true`; a `config.env` with a map holds personal data);
  Troubleshooting (`commit lookups off`); Limits and budget (section 6); Docs list.
- **CLAUDE.md:** Layout (the new modules), Config (two settings), an "Assignees (U1-U17)"
  paragraph, Gotchas (add ignores unassignable logins while PATCH and create 422; the repo-level
  check is case-sensitive; `contents: read` for commits; inputs and env are printed in run logs).
- **docs/12** header: decided and implemented, see docs/13. **docs/README.md:** rows for 12
  (decided) and 13.

### After stage 3: verification and rollout

1. `npm run check` and coverage at least at today's level.
2. Live dry run on the group's project (GET only, `SYNC_ASSIGNEES` on): expect read 4, no
   lookups when every assignee matches at step b, one `[dry-run] would add 1 assignee to ...`
   per open mirror with a matched assignee, and no login or email anywhere in the log. On the
   Worker, also check in Workers Logs that subrequest URLs show no query string.
3. **Needs the user's OK (real writes):** one live run on the personal private playground repo
   used for U10, with `max-writes-per-run: "1"`, then the PAT host and the Action.
4. Release `feat!` as v1.0.0, then roll out per U9 and tell the team first.

## 5. Summary line and log lines (extends R5)

Field order: `scanned created closed reopened updated assigneesAdded assigneesRemoved
milestonesCreated milestonesClosed skipped capped failed filtered unchanged labelsReAdded fetches
dryRun`. `assigneesAdded` and `assigneesRemoved` count add and remove **writes** (a write may name
several logins), done or previewed. An issue whose only actions are assignee writes no longer
counts as `unchanged`.

A real run (project `ABC`):

```text
assignees: 1 unmatched (ABC-18)
create milestone ABC-40 -> #1
create ABC-41 with type Feature, milestone ABC-40 #1 -> #30
create ABC-42 with type Task, milestone ABC-40 #1, parent ABC-41 #30 -> #31
update ABC-15 #21: set title, set type Task
close ABC-3 #12
add 1 assignee to ABC-41 #30
add 1 assignee to ABC-42 #31
add 1 assignee to ABC-16 #22
remove 1 assignee from ABC-16 #22
yt-gh-sync ok scanned=40 created=2 closed=1 reopened=0 updated=1 assigneesAdded=3 assigneesRemoved=1 milestonesCreated=1 milestonesClosed=0 skipped=34 capped=0 failed=0 filtered=28 unchanged=6 labelsReAdded=0 fetches=13 dryRun=false
```

The same as a dry run ends with `fetches=4 dryRun=true`, and its assignee lines read
`[dry-run] would add 1 assignee to ABC-41 (new)` and
`[dry-run] would remove 1 assignee from ABC-16 #22`. Other lines (ids and counts only):

| When                          | Line                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aggregated (U3)               | `assignees: 2 unmatched (ABC-12, ABC-15), 1 ambiguous (ABC-20), 1 not looked up (ABC-31), 1 mapped to a login that cannot be assigned (ABC-7); commit lookups off: the token lacks Contents read (HTTP 403)`                                                                                                                                                                                                        |
| Lookup notes (after `; `)     | `commit lookups off: the token lacks Contents read (HTTP 404)`, `commit lookups off (HTTP 409)`, `email search off: GitHub rate limit`, `lookups stopped: GitHub rate limit`, `lookups stopped: fetch guard reached`, `lookups stopped at the run deadline`, `lookup budget of 5 used up` (the bound of 2.5), `no lookup budget left by the write cap` (a bound of 0), `2 lookups failed (HTTP 502, network error)` |
| Field missing (loud, U6, U15) | `assignees: no scanned issue has an "Assignee" field, so no assignee is changed; check the field name in YouTrack, or set SYNC_ASSIGNEES (input sync-assignees) to false`                                                                                                                                                                                                                                           |
| None matched (loud)           | `assignees: none of the 4 YouTrack assignees matched a GitHub account; if their YouTrack logins look anonymized, the YouTrack token may lack Read User Basic`                                                                                                                                                                                                                                                       |
| List unreadable (U16)         | `assignees: could not read the assignable GitHub users (HTTP 502); assignees are not synced this run` (or `network error`, `unexpected response`, `fetch guard reached`)                                                                                                                                                                                                                                            |
| Limit cut (plan warning)      | `ABC-9 #40: 1 matched assignee not added: GitHub allows 10 per issue` (`ABC-9 (new): ...` for a mirror this run creates)                                                                                                                                                                                                                                                                                            |
| Response check                | `ABC-16 #22: GitHub dropped 1 of 1 assignees on add; the next run tries again`, `ABC-16 #22: GitHub kept 1 of 1 assignees on remove; the next run tries again`                                                                                                                                                                                                                                                      |
| Wait (D4)                     | `add 1 assignee to ABC-41 capped: the mirror of ABC-41 was not created in this run`                                                                                                                                                                                                                                                                                                                                 |
| Failure (A10)                 | `add 1 assignee to ABC-16 #22 failed: POST https://api.github.com/repos/acme/mirror/issues/22/assignees -> HTTP 422: {"message":"... [person] ..."}`                                                                                                                                                                                                                                                                |

Plurals follow the count (`1 assignee`, `2 assignees`). The none-matched count is of persons
who are not blocked. A lookup note appears only when it cut a needed lookup short or turned a
step off; `2 lookups failed (...)` lists each distinct status once.

## 6. Fetch and write budget

One page per read; `w` = `MAX_WRITES_PER_RUN`; the guard is 45 (`DEFAULT_MAX_FETCHES`).

| Item                                     | Today (v0.x) | v1.0.0, switch off | v1.0.0, on, no eligible assignee | v1.0.0, on, with eligible assignees                             |
| ---------------------------------------- | ------------ | ------------------ | -------------------------------- | --------------------------------------------------------------- |
| Reads                                    | 3            | 3                  | 3                                | 4, plus 1 per further 100 assignable users                      |
| Lookups                                  | -            | -                  | -                                | at most `min(5, 41 - w - 2)` (+1 retry), only when a and b miss |
| Default `w` 30, no retries               | 3 + 30 = 33  | 33                 | 33                               | 4 + 30 = 34; with 5 lookups 39                                  |
| `w` = 34                                 | 37           | 37                 | 37                               | 4 + 5 + 34 = 43                                                 |
| `w` = 38                                 | 41           | 41                 | 41                               | 4 + 1 + 38 = 43                                                 |
| `w` = 40 (`MAX_WRITES_LIMIT`, unchanged) | 43           | 43                 | 43                               | 4 + 0 + 40 = 44 (the warning notes the budget)                  |
| YouTrack response, 52 issues (CUI)       | 40.6 KB      | 40.6 KB            | 51.5 KB (+27%), one request      | 51.5 KB, one request                                            |
| GitHub requests per run on the Action    | at most 32   | 32                 | 32                               | at most 33, or 38 with lookups (about 228 an hour, under 1,000) |
| First live run on CUI                    | -            | -                  | -                                | up to 12-14 adds (one per open mirror with an assignee)         |

- A new mirror with a matched assignee costs 2 writes (create, add); a reassignment between
  matched people 2 (add, remove).
- **README lines that change** (58, "at most 30 writes per run", stays as is): 183 and 514 (example
  summary lines: the new fields, `fetches=4` and `fetches=13`, section 5); 815-818 (the
  "Today: 3 reads" bullet becomes the table above); 160-161 (permissions); 220-221
  (Permissions bullet).
- **Test pins:** the 13 `fetches: 3` / `fetches=3` pins stay, because the default fixture row
  is unassigned (read 4 not sent); `test/sync/guard.test.ts:45` stays; the pinned summary lines
  (`test/sync/hierarchy-e2e.test.ts:128`, `test/sync/sync.test.ts:58`,
  `test/sync/reopen.test.ts:264`) and the `summary()` defaults gain the two zero fields. New e2e
  tests pin 4 reads and the lookup counts.

## 7. Risks

- **Notification burst:** the first live run assigns up to 12-14 people at once, and each is
  emailed and subscribed; later closes and R10 reopens notify them too. Assignments by a PAT
  (Worker, systemd) start `issues: assigned` workflows. Mitigation: U9 rollout.
- **Self-asserted identities (U11):** a student can edit their YouTrack username or email, or
  rename on GitHub, to point the chain at a teammate. The assignable list keeps outsiders out and
  the exactly-one rules catch two logins with one ID; the effect is a visible misassignment.
- **Silent drops without push access:** GitHub ignores the add and remove calls; the same write
  repeats every run (one per mirror) and is warned each time (2.8). Assignee writes run last, so
  they never block closes.
- **Lookup-only matches flicker:** a person matched only by a lookup is matched on the runs that
  look them up. On other runs nothing is added or removed for them, so a stale assignment of
  theirs can stay a few runs longer.
- **Strict parsing:** a malformed `Assignee` value fails the whole run, like a bad `Type`; the
  switch is the escape hatch. A field of that name but another `$type` is safe (absent, loud
  warning).
- **`$type` reliance:** recognising the user field depends on `$type`, which the docs say is
  always returned; a missing `$type` reads as absent (no changes, loud warning).
- **Privacy:** the YouTrack response now holds full names (`value(name,...)` is shared with
  `Type`), dropped at the parse boundary but present in memory. Step d sends emails to GitHub's
  global search. The redactor may over-redact a word in a title that equals a short login.
  Logins under 3 characters are not redacted. Whether `redact_query_string` also strips the
  query of subrequest URLs in Workers traces is not verified (step 2 of the rollout checks the
  logs), and groups that copied `wrangler.jsonc` earlier keep `false` until they change it.
  GitHub's masking of the map secret was not live-tested.
- **Workers CPU:** a 27% larger YouTrack response, the matcher and the redactor regex were not
  measured against the 10 ms limit.
- **Budget:** at 39-40 writes per run there are no lookups at all; the assignable list grows
  with org membership (staff, other teams), not with the team.
- **Parallel merges:** stage 1 relies on the ownership split. `test/plan/fixtures.ts` (unit C,
  `ghIssue` only) and `test/sync/fixtures.ts` (unit A, `BASE_CONFIG` only) are the two shared
  test files; any other cross-unit edit waits for stage 2.
- **v1.0.0:** groups that pin by SHA keep running v0.x until they update; the README states what
  changes (contract, `contents: read`, notifications).
- **Undocumented:** more than 10 assignees; whether `GITHUB_TOKEN` counts as push access for the
  drop rule (the response check catches it).

## 8. Choices the plan makes

The decisions leave these details open; each pick below is for the lead to confirm.

| #   | Choice                                                                                                                                                                                                                                                                                                   | Why                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Switch named `SYNC_ASSIGNEES` / `sync-assignees`, default `true`                                                                                                                                                                                                                                         | Verb first like `REOPEN_CLOSED_BY`; U1 says on by default                                                                                                                           |
| 2   | The switch parses strictly: `true` or `false` (trimmed, any case); blank or anything else is a config error                                                                                                                                                                                              | A typo should not silently keep a feature on that notifies people; matches the empty-input rule                                                                                     |
| 3   | Map details: commas and line breaks, blank entries skipped, key without whitespace, problems named by position among non-blank entries, repeated targets allowed                                                                                                                                         | docs/12 format; positions instead of values keep personal data out of errors                                                                                                        |
| 4   | Map lives in a Worker secret (`wrangler secret put`), not a var; `.env` and `config.env` on Node and systemd                                                                                                                                                                                             | U14 calls it a secret; wrangler vars are plain text in the gitignored file and the dashboard                                                                                        |
| 5   | `ASSIGNEE_MAP` is parsed even with the switch off                                                                                                                                                                                                                                                        | One config error path; a bad map is caught before it is turned on                                                                                                                   |
| 6   | Switch off sends today's YouTrack URL (no Assignee, no user subfields)                                                                                                                                                                                                                                   | "Off" means no extra data at all, not only no extra request                                                                                                                         |
| 7   | User subfields are `login,email` only; `name`/`fullName` are dropped at the parse boundary                                                                                                                                                                                                               | Data minimisation; `name` comes anyway through the shared `value(name)`                                                                                                             |
| 8   | The Assignee entry is matched by name ignoring A-Z case and by `$type` Single/MultiUserIssueCustomField; another `$type` reads as absent                                                                                                                                                                 | The filter ignores case (live); a non-user field of that name should warn, not fail the run                                                                                         |
| 9   | Shape errors inside a recognised Assignee entry fail the row, like `Type`                                                                                                                                                                                                                                | Existing rule: never guess on a shape change                                                                                                                                        |
| 10  | A row without the entry gets no change (like unassigned); the loud warning needs at least one scanned issue and no row with the field                                                                                                                                                                    | U6 leave-alone; no warning for an empty project                                                                                                                                     |
| 11  | `ScannedIssue = YouTrackIssue & { assignee }` instead of a new `YouTrackIssue` field; `GitHubIssue` gains `assignees` directly                                                                                                                                                                           | Keeps personal data out of the type every action and log line receives (the objects still hold it at runtime; nothing logs a whole issue); lets stage 1 run without fixture clashes |
| 12  | GitHub assignee items without a string login are skipped and a missing `type` reads as `""` (never owned); a non-array `assignees` is an error                                                                                                                                                           | Same leniency as labels; an unreadable assignee can never be removed                                                                                                                |
| 13  | Module names: `src/github/assignees.ts`, `src/github/users.ts`, `src/utils/student-id.ts`, `src/utils/identity-redact.ts`, `src/plan/assignee-match.ts`, `src/plan/assignee-lookups.ts`, `src/plan/assignees.ts`, `src/plan/assignee-scope.ts`, `src/sync/assignees.ts`, `src/sync/execute-assignees.ts` | Fits the existing split by domain; each stays small                                                                                                                                 |
| 14  | `Anonymi` prefix compared ignoring A-Z case                                                                                                                                                                                                                                                              | The anonymized shape is inferred, so err on the safe side                                                                                                                           |
| 15  | Usable email: `/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/`                                                                                                                                                                                                                                                     | Stricter than "one `@`": no search-term injection through a self-edited email                                                                                                       |
| 16  | After an ambiguous step the chain goes on; C is the first ambiguous set; a single login outside C ends it as ambiguous                                                                                                                                                                                   | One reading of "otherwise Y stays ambiguous"                                                                                                                                        |
| 17  | A failed lookup (422, 5xx, network, schema, non-JSON) is skipped as docs/12 says ("that email is skipped"): no second try in the run, the step pools the other emails, and a person left with no match is `not looked up`, not `unmatched`                                                               | docs/12 "Failure handling"; the warning category says the answer is unknown, not negative                                                                                           |
| 18  | A step is decided only when every email of the person has an answer for it (a skipped failure counts as one)                                                                                                                                                                                             | Pooling needs all emails; a partial pool cut short by the budget could hide an ambiguity                                                                                            |
| 19  | Lookups go depth-first per person (c, then d), persons rotated by `floor(now / 10 min) mod n` over those who need lookups; no pause between lookups                                                                                                                                                      | Settles whole people; rotation over the needers is fair to them                                                                                                                     |
| 20  | A lookup starts while the fetch growth is below the bound, so the last may retry (bound + 1)                                                                                                                                                                                                             | Keeps 5 single-fetch lookups possible; the write phase's guard handling covers the extra fetch                                                                                      |
| 21  | Deadline margin 40 s = 2 x 15 s + 10 s                                                                                                                                                                                                                                                                   | docs/12: "one worst-case request"                                                                                                                                                   |
| 22  | Assignee writes form phase 5, after closes and reopens                                                                                                                                                                                                                                                   | A write that never converges can't delay a close; capped first                                                                                                                      |
| 23  | On one mirror the add runs before the remove                                                                                                                                                                                                                                                             | A cut-off reassignment leaves both people, never nobody                                                                                                                             |
| 24  | The 10-assignee limit cuts adds to the free slots counted before removes, with a plan warning                                                                                                                                                                                                            | Simple and never above the limit                                                                                                                                                    |
| 25  | Summary fields `assigneesAdded`, `assigneesRemoved` after `updated`, counting writes                                                                                                                                                                                                                     | Headline counts first (R5); every other field counts actions                                                                                                                        |
| 26  | Log wording of section 5, including `add 1 assignee to ...` / `remove 1 assignee from ...` and every warning                                                                                                                                                                                             | Markers and ids only (U8); reads like the existing lines                                                                                                                            |
| 27  | Persons are named in warnings by the id of their oldest eligible issue                                                                                                                                                                                                                                   | Ids only, and it tells the reader where to look in YouTrack                                                                                                                         |
| 28  | "Loud" means a warn line of its own, never folded into the aggregated one, on every run                                                                                                                                                                                                                  | The decisions name no level; an error level would look like a failed run                                                                                                            |
| 29  | Blocked (`-`) people are left out of the aggregated warning and of the none-matched count                                                                                                                                                                                                                | They are unassigned on purpose                                                                                                                                                      |
| 30  | Redactor: `[person]`, at least 3 characters, no letter or digit on either side, raw, URL-encoded and quoted forms, longest first; built after the assignee stage; the logger is rebuilt then                                                                                                             | Covers 422 bodies and lookup URLs without garbling ordinary words                                                                                                                   |
| 31  | Assignee warnings are logged after the stage, before the plan's warnings                                                                                                                                                                                                                                 | They need the full redactor, and they explain the plan that follows                                                                                                                 |
| 32  | Default sync fixture row carries `Assignee: null`, so the 13 fetch pins stay at 3                                                                                                                                                                                                                        | Read 4 is only sent when an eligible issue has an assignee (U17 step 0)                                                                                                             |
| 33  | Search uses `per_page=100`, commits `per_page=1`; only `User` results count                                                                                                                                                                                                                              | One request either way; docs/12 step c and d                                                                                                                                        |
| 34  | `PlanInput.assignees: AssigneeSync \| null`, the desired logins and owned set computed before planning                                                                                                                                                                                                   | The planner stays pure and never sees YouTrack emails                                                                                                                               |
| 35  | README workflow passes `assignee-map: ${{ secrets.ASSIGNEE_MAP }}` by default                                                                                                                                                                                                                            | An unset secret is empty (no map), so it is safe to keep in the example                                                                                                             |
| 36  | A response-check mismatch (2.8) gives one warning and no extra write; the write counts as done                                                                                                                                                                                                           | Same as a dropped type or milestone on update; the next run's diff tries again                                                                                                      |
| 37  | A multi-user `Assignee` value of `null` reads as no users, like `[]`                                                                                                                                                                                                                                     | The empty shape is undocumented (docs/12); failing every run on it would be worse than reading it as unassigned                                                                     |
| 38  | An assignee write's `HttpError` whose excerpt fills the 500-character cut loses its trailing login-or-email characters before redaction (2.11)                                                                                                                                                           | A login cut in half would escape the identity redactor                                                                                                                              |
| 39  | `wrangler.example.jsonc` sets `observability.redact_query_string` to `true`                                                                                                                                                                                                                              | Lookup URLs carry emails in the query string (U8)                                                                                                                                   |
| 40  | The README asks for `ASSIGNEE_MAP` on one line (commas), also in the Action secret                                                                                                                                                                                                                       | systemd's `EnvironmentFile=` and GitHub's exact-match masking both handle one line best                                                                                             |
