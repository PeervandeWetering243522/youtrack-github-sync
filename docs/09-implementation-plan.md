# Implementation plan

> Drafted 2026-09-24 from [06](06-design-and-backfill.md) and [08-decisions.md](08-decisions.md).
> **Status: implemented.** The "As built" section below lists where the code differs from the
> original plan and supersedes the sections it names. Where this plan and the code still
> differ, `README.md` and `src/` are authoritative.

## As built

- **Summary line (R5).** `yt-gh-sync <ok|failed> scanned= created= closed= skipped= capped=
failed= filtered= unchanged= labelsReAdded= fetches= dryRun=`, where `skipped` = `filtered`
  (no title prefix) + `unchanged` (mirror already in the right state, or resolved with no
  mirror, R9). A failed read logs the
  same line with outcome `failed` before the error is rethrown; a failed write logs it at the
  end, then `SyncFailedError` is thrown.
- **Already-resolved issues (R9, supersedes R6).** An issue that is resolved and has no mirror
  gets no mirror; it counts as `unchanged`. Only unresolved issues are created, so there is
  no create+close pair: every action (create or close) costs 1 write. The write cap takes
  actions in order while they fit and stops at the first that does not; nothing later jumps
  ahead. Open mirrors are still closed on resolution, closed mirrors are never reopened.
- **GitHub rate limit (R7).** A write that fails with a rate limit (403/429 with
  `x-ratelimit-remaining: 0`, with `retry-after`, or whose body names the secondary rate limit)
  is recorded as failed and stops the write phase; the remaining actions count as `capped`.
- **Run deadline (R8).** No write action starts at or after `RUN_DEADLINE_MS` (8 min) past the
  run's start: `controller.scheduledTime` on the Worker, process start on Node. The rest counts
  as `capped` with a `run deadline reached` warning. Reads and the dry-run preview are not
  gated. The systemd unit uses `TimeoutStartSec=10min` as a hard backstop.
- **Row sanity check (R4).** Every YouTrack row must have `idReadable` =
  `<project>-<numberInProject>`, otherwise the run fails.
- **Fetch guard and retries.** The guard refuses the 46th fetch. When it refuses a write
  (nothing sent), that action and the rest count as `capped`. A write that was sent and failed
  but whose retry the guard cannot pay for counts as `failed` (A10). "Retry once" applies to
  GETs, closes and label re-adds on a network error, timeout, 5xx, 429, or a 403 carrying
  `retry-after`. The retry waits `retry-after` when it is ≤ 10 s and 2 s when the header is
  missing or unreadable; there is no retry when `retry-after` is over 10 s, or on a primary
  rate limit without a usable `retry-after`. Creates are never retried.
- **Config.** `GITHUB_REPO`, `YOUTRACK_BASE_URL` and `YOUTRACK_PROJECT` are **required** with no
  defaults in code (`wrangler.jsonc` sets them for the Worker, `.env` for Node). Only
  `YOUTRACK_TITLE_PREFIX`, `MAX_WRITES_PER_RUN` (0-40) and `DRY_RUN` have defaults.
- **Types.** `unknown` is banned by lint. JSON enters only through `parseJson()` in
  `src/json.ts` as `JsonValue` and is narrowed with type guards. GitHub types derive from
  `@octokit/openapi-types`.
- **Layout.** See section 5, which is updated to the code.

## 1. Behavior (final, as decided)

Each run:

1. **GitHub read.** `GET /repos/{o}/{r}/issues?state=all&per_page=100` with **no label filter**,
   following `link: rel="next"`. Drop PRs (items with a `pull_request` key). Build
   `numberInProject -> {number, state}` from titles matching `^\[YT-(\d+)\]`:
   - an issue that has the `youtrack` label wins;
   - an issue _without_ the label but with a matching title is also treated as the mirror
     (decision A5: "re-add label, otherwise match by title"). This case is logged as a warning;
   - when there are several candidates for one number, the lowest issue number wins and a
     warning is logged (A6: duplicates are accepted).
2. **YouTrack read.** A full project scan on every run (A1 = option A):
   `GET /api/issues`, `query=project: CUI sort by: {issue id} asc`, `$top=100`, `$skip` paging
   until a short page. Sorting by issue id stays stable even while issues are being edited.
   Results are de-duplicated by `numberInProject`.
3. **Filter.** Keep only issues whose summary starts with `YOUTRACK_TITLE_PREFIX` (default `[team]`,
   case-insensitive). Everything else counts as `filtered` (part of `skipped`, R5).
4. **Plan actions** as a pure function:
   - no mirror and YouTrack unresolved -> `create` (1 write);
   - no mirror and YouTrack resolved -> nothing (R9: never mirrored);
   - mirror open and YouTrack resolved -> `close` (1 write);
   - otherwise nothing.
     Actions are sorted by ascending `numberInProject` (A2). The write cap takes the longest
     prefix that fits. Anything left over counts as `capped`.
5. **Execute** serially with a 1 s pause between writes. In `DRY_RUN` mode, log each intended
   write instead of sending it.
   - After a create, if the 201 response lacks the `youtrack` label: one
     `POST /issues/{n}/labels`. If that fails too, record a failure and continue. The next run
     still finds the mirror through the title fallback.
   - Close with `{"state":"closed","state_reason":"completed"}` (A7).
6. **Log** one summary line, and **throw** if anything failed (A10).

The `youtrack` label is **created once by hand** (see section 8). The script doesn't
check or create it, which saves a fetch per run. If it's missing, the re-add/title fallback above still
prevents duplicates.

`LOOKBACK_HOURS` and `BACKFILL` are **dropped**, since the full scan makes them unnecessary.

## 2. Mirror format

- **Title:** `[YT-<n>] <summary>`, at most 256 characters. If truncated, the title ends with `…` and the
  body starts with the notice below.
- **Body:**

  ```text
  <description, neutralised>

  ---
  Mirrored from YouTrack: <YOUTRACK_BASE_URL>/issue/<idReadable>
  ```

  A `null` description gives only the link line (A4). At most 65,536 characters. If truncated, the
  body ends with: `Character limit hit, see the full YouTrack issue: <link>` (A9).

- **Neutralising (A4):** wrap `@login` / `@org/team`, `#123`, `GH-123` and `owner/repo#123` in
  backticks. Leave fenced code blocks, inline code spans and email addresses (`a@b.c`) untouched.
  Unit-tested with edge cases.

## 3. Budget (Workers Free: 50 subrequests, 10 ms CPU)

- `MAX_WRITES_PER_RUN` (default 30) counts **every HTTP write**, including a label re-add.
- A hard **fetch guard of 45** in the shared HTTP client covers reads, writes and retries. When
  it's reached, the run stops cleanly and the rest counts as `capped`, which leaves headroom
  below 50.
- Today: 1 GitHub page (19 items, 17 of them PRs) + 1 YouTrack page + up to 30 writes, so 32
  without retries; each retry adds one fetch, up to the guard of 45.
  The initial backfill of 10 `[team]` issues (6 of them resolved) is 16 writes, done in one run.

## 4. Retry and failure (A10)

| Request                         | Retry once on network error / timeout / 5xx / 429 / 403 with `retry-after`?                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| YouTrack GET, GitHub GET        | Yes, after `retry-after` when it is ≤ 10 s, else 2 s if it is missing or unreadable; no retry when it is > 10 s or on a primary rate limit without a usable `retry-after` |
| GitHub PATCH close, POST labels | Yes (idempotent)                                                                                                                                                          |
| GitHub POST create issue        | **No.** A timed-out create may have succeeded, so the next run acts as the retry                                                                                          |

- A YouTrack non-2xx is fatal for the run (a 400 means a bad query, never "no issues").
- A 401/403/404 from GitHub on list is fatal. On a write it is recorded as a failure and the
  loop continues, unless it was a rate limit, which stops the write phase (R7).
- At the end: `yt-gh-sync failed ... failed=N ... dryRun=false` and throw. The Worker lets it propagate, so it shows
  as an error in Cron Events and Logs. Every fetch gets `AbortSignal.timeout(15 s)`.

## 5. Code layout (modular, pure core; as built)

```text
src/
  generated/youtrack.ts   # openapi-typescript output from youtrack-openapi.json (output committed, spec not)
  config.ts               # parse + validate env strings -> readonly Config (fails fast)
  json.ts                 # the only JSON entry point: parseJson() -> JsonValue, plus guards
  http.ts                 # fetch wrapper: User-Agent, timeout, fetch guard, retry policy, HttpError
  http/
    rate-limit.ts         # GitHub primary/secondary rate-limit detection (R7)
    redact.ts             # credential headers out of error text
    retry-after.ts        # strict retry-after parsing (delta-seconds, HTTP-date)
  youtrack.ts             # derived YouTrackIssue type, field list, guard, R4 check, paged full scan
  github.ts               # list (Link paging), create, close, add labels; types from @octokit/openapi-types
  mirror.ts               # pure: parse/format title, body layout, truncation, prefix filter
  plan.ts                 # pure: mirror map + YouTrack issues -> ordered, capped actions (R9)
  utils/                  # pure (R1): markdown-{blocks,inline,render,cut,escapes}.ts, text.ts, redact.ts
  sync.ts                 # orchestration only (uses fetch via http.ts); dry-run preview; returns RunSummary
  sync/
    execute.ts            # the only GitHub write path: cap, fetch guard, rate-limit stop (R7), deadline (R8)
    tally.ts              # run counters and how log lines name an issue
    log.ts                # logger that redacts every line
  runtime.ts              # console logger + sleep for the entrypoints (not imported by the sync core)
  worker.ts               # scheduled() entrypoint; deadline from controller.scheduledTime
  node.ts                 # Node entrypoint (env -> config -> sync); deadline from process start
test/                     # node:test; sync tested with a fake fetch
```

`sync.ts` and everything it imports use only `fetch` and standard ECMAScript. It type-checks under
**both** the Workers and the Node tsconfig (section 6), which proves it's portable.

## 6. Types and tooling

- **TypeScript 5.9.3.** openapi-typescript 7.13 requires `^5.x`, and typescript-eslint
  8.70 requires `<6.1`, so TS 7 is out for now (the install was verified to fail).
- **tsconfig:** `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
  `noPropertyAccessFromIndexSignature`, `noImplicitOverride`, `noImplicitReturns`,
  `noFallthroughCasesInSwitch`, `erasableSyntaxOnly`, `verbatimModuleSyntax`,
  `allowImportingTsExtensions`, `noEmit`. There are two leaf configs: `tsconfig.worker.json`
  (`wrangler types` output) and `tsconfig.node.json` (`@types/node`).
- **ESLint + typescript-eslint `strictTypeChecked` + `stylisticTypeChecked`.** These give
  `no-explicit-any` (error), all `no-unsafe-*` rules (these catch implicit `any` from `res.json()`),
  `switch-exhaustiveness-check`, `consistent-type-imports` and `explicit-module-boundary-types`.
- **`unknown` policy (as built):** banned everywhere by lint. Response bodies are read as text
  and parsed only by `parseJson()` (`src/json.ts`) into `JsonValue`, then narrowed with type guards.
- **YouTrack types from the source:** `npm run gen:youtrack` runs openapi-typescript. Code then derives:

  ```ts
  type IssueSchema = components["schemas"]["Issue"];
  const ISSUE_FIELDS = ["idReadable", "numberInProject", "summary", "description", "resolved", "updated"]
    as const satisfies readonly (keyof IssueSchema)[];   // a typo'd field fails to compile
  type YouTrackIssue = Readonly<
    { [K in "idReadable" | "numberInProject" | "summary" | "updated"]-?: NonNullable<IssueSchema[K]> } &
    { [K in "description" | "resolved"]-?: NonNullable<IssueSchema[K]> | null }  // live-verified nulls (docs/00)
  >;
  ```

  The `fields=` string is built from `ISSUE_FIELDS`, so the request and the type can't drift apart. A
  runtime guard validates every row. If a row fails, the run fails rather than guessing (this
  covers the silent-drop gotcha).

- **GitHub types (as built):** derived from `@octokit/openapi-types` (GitHub's official spec,
  types only), narrowed to the fields we read, each with a runtime guard.
- **Tests:** `node --test` with type stripping (Node ≥ 22.18; local is 22.22.2), so there's no test framework
  dependency. Coverage comes from `--experimental-test-coverage`, with a target of ≥ 80%.
- **Dev dependencies:** `typescript@~5.9.3`, `openapi-typescript@7.13`, `eslint`, `@eslint/js`,
  `typescript-eslint`, `@octokit/openapi-types`, `@types/node@24`, `wrangler@4`. Runtime
  dependencies: **none**.
- **Regenerating YouTrack types:** `youtrack-openapi.json` is intentionally not committed (the
  generated `src/generated/youtrack.ts` is). Place the instance's OpenAPI spec at
  `./youtrack-openapi.json` before running `npm run gen:youtrack`.

## 7. Config

| Name                    | Kind   | Default                                                                                                |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| `GITHUB_TOKEN`          | secret | (classic PAT with `repo` scope for now, B12)                                                           |
| `YOUTRACK_TOKEN`        | secret |                                                                                                        |
| `GITHUB_REPO`           | var    | required (`wrangler.jsonc` and `.env.example` set `BredaUniversityADSAI/2026-27s1-fai3-adsai-ComfyUI`) |
| `YOUTRACK_BASE_URL`     | var    | required (`wrangler.jsonc` and `.env.example` set `https://youtrack.ai.buas.nl`)                       |
| `YOUTRACK_PROJECT`      | var    | required (`wrangler.jsonc` and `.env.example` set `CUI`)                                               |
| `YOUTRACK_TITLE_PREFIX` | var    | `[team]`                                                                                               |
| `MAX_WRITES_PER_RUN`    | var    | `30` (0-40)                                                                                            |
| `DRY_RUN`               | var    | `true` (only `false`, any case and trimmed, disables it; anything else keeps dry-run on)               |

The Worker gets `vars` in `wrangler.jsonc` and `wrangler secret put` for secrets. Local runs use the
project `.env` (Node `--env-file-if-exists`, and wrangler reads it too); `npm run sync` does not
read `wrangler.jsonc`, so `.env` needs the three required vars.

## 8. Order of work

1. Scaffold: `package.json`, tsconfigs, eslint config, `.gitignore` (+ `node_modules`, `.wrangler`,
   `.dev.vars`), and generate the YouTrack types.
2. Pure modules plus tests first: `mirror.ts`, `plan.ts`, `config.ts`.
3. `http.ts`, `youtrack.ts`, `github.ts` plus tests using a fake `fetch`.
4. `sync.ts` plus an end-to-end test with a fake `fetch` (fixtures shaped like docs/00).
5. `node.ts`, then a **live dry run** (YouTrack GET plus GitHub GET only) and review of the logged plan.
6. `worker.ts` and `wrangler.jsonc`, then a `wrangler dev --test-scheduled` dry run.
7. README: setup, secrets, running with Node and systemd as the fallback host, and the note about the Webhook Triggers app.
8. Review pass (code-reviewer and security-reviewer agents), then hand over. **You** create the label,
   deploy, and flip `DRY_RUN=false`.

**Before step 5**, create the label once (e.g.
`gh label create youtrack --repo BredaUniversityADSAI/2026-27s1-fai3-adsai-ComfyUI --color 6f42c1 --description "Mirrored from YouTrack (read-only)"`),
copy `.env.example` to `.env` and fill in `GITHUB_TOKEN` and `YOUTRACK_TOKEN`.
