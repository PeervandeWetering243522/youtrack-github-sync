# Implementation plan

> Drafted 2026-09-24 from [06](06-design-and-backfill.md) and [08-decisions.md](08-decisions.md).
> Awaiting sign-off before any code is written.

## 1. Behavior (final, as decided)

Each run:

1. **GitHub read.** `GET /repos/{o}/{r}/issues?state=all&per_page=100` with **no label filter**,
   following `link: rel="next"`. Drop PRs (items with a `pull_request` key). Build
   `numberInProject -> {number, state}` from titles matching `^\[YT-(\d+)\]`:
   - an issue that has the `youtrack` label wins;
   - an issue *without* the label but with a matching title is also treated as the mirror
     (decision A5: "re-add label, otherwise match by title"). This case is logged as a warning;
   - when there are several candidates for one number, the lowest issue number wins and a
     warning is logged (A6: duplicates are accepted).
2. **YouTrack read.** A full project scan on every run (A1 = option A):
   `GET /api/issues`, `query=project: CUI sort by: {issue id} asc`, `$top=100`, `$skip` paging
   until a short page. Sorting by issue id stays stable even while issues are being edited.
   Results are de-duplicated by `numberInProject`.
3. **Filter.** Keep only issues whose summary starts with `YOUTRACK_TITLE_PREFIX` (default `[team]`,
   case-insensitive). Everything else counts as `skipped`.
4. **Plan actions** as a pure function:
   - no mirror -> `create` (plus `close` if resolved: 2 writes, planned together as a pair);
   - mirror open and YouTrack resolved -> `close`;
   - otherwise nothing.
   Actions are sorted by ascending `numberInProject` (A2). The write cap is applied without
   splitting a create+close pair. Anything left over counts as `capped`.
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
- Today: 1 GitHub page (19 items, 17 of them PRs) + 1 YouTrack page + up to 30 writes, so 32 at most.
  The initial backfill of 10 `[team]` issues (6 of them resolved) is 16 writes, done in one run.

## 4. Retry and failure (A10)

| Request | Retry once on network error / timeout / 5xx / 429? |
|---|---|
| YouTrack GET, GitHub GET | Yes, after 2 s (honouring `retry-after` when it is ≤ 10 s) |
| GitHub PATCH close, POST labels | Yes (idempotent) |
| GitHub POST create issue | **No.** A timed-out create may have succeeded, so the next run acts as the retry |

- A YouTrack non-2xx is fatal for the run (a 400 means a bad query, never "no issues").
- A 401/403/404 from GitHub on list is fatal. On a write it is recorded as a failure and the
  loop continues.
- At the end: `sync failed ... failed=N` and throw. The Worker lets it propagate, so it shows
  as an error in Cron Events and Logs. Every fetch gets `AbortSignal.timeout(15 s)`.

## 5. Code layout (modular, pure core)

```text
src/
  generated/youtrack.ts   # openapi-typescript output from youtrack-openapi.json (committed)
  config.ts               # parse + validate env strings -> readonly Config (fails fast)
  http.ts                 # fetch wrapper: User-Agent, timeout, fetch guard, retry policy, HttpError
  youtrack.ts             # derived FetchedIssue type, field list, guard, paged full scan
  github.ts               # list (Link paging), create, close, add labels; minimal typed responses
  mirror.ts               # pure: parse/format title, neutralise + format body, truncation, prefix filter
  plan.ts                 # pure: mirror map + YouTrack issues -> ordered, capped actions
  sync.ts                 # orchestration only (uses fetch via http.ts); returns RunSummary
  worker.ts               # scheduled() entrypoint
  node.ts                 # Node entrypoint (env -> config -> sync)
test/                     # node:test, one file per module; sync tested with a fake fetch
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
- **`unknown` policy:** allowed only at the JSON boundary, as `const raw: unknown = await res.json()`,
  and immediately narrowed by a type guard. Nowhere else.
- **YouTrack types from the source:** `npm run gen:youtrack` runs openapi-typescript. Code then derives:

  ```ts
  type IssueSchema = components["schemas"]["Issue"];
  const ISSUE_FIELDS = ["idReadable", "numberInProject", "summary", "description", "resolved", "updated"]
    as const satisfies readonly (keyof IssueSchema)[];   // a typo'd field fails to compile
  type FetchedIssue = Readonly<
    { [K in "idReadable" | "numberInProject" | "summary" | "updated"]-?: NonNullable<IssueSchema[K]> } &
    { [K in "description" | "resolved"]-?: NonNullable<IssueSchema[K]> | null }  // live-verified nulls (docs/00)
  >;
  ```

  The `fields=` string is built from `ISSUE_FIELDS`, so the request and the type can't drift apart. A
  runtime guard validates every row. If a row fails, the run fails rather than guessing (this
  covers the silent-drop gotcha).
- **GitHub types:** hand-written minimal response types, covering only the fields we read, each with a guard.
  *Alternative:* `@octokit/openapi-types`, generated from GitHub's official spec (types only,
  one more dev dependency). Tell me if you want this for consistency with the YouTrack approach.
- **Tests:** `node --test` with type stripping (Node ≥ 22.18; local is 22.22.2), so there's no test framework
  dependency. Coverage comes from `--experimental-test-coverage`, with a target of ≥ 80%.
- **Dev dependencies:** `typescript@~5.9.3`, `openapi-typescript@7.13`, `eslint`, `typescript-eslint`,
  `@types/node@24`, `wrangler@4`. Runtime dependencies: **none**.

## 7. Config

| Name | Kind | Default |
|---|---|---|
| `GITHUB_TOKEN` | secret | (classic PAT with `repo` scope for now, B12) |
| `YOUTRACK_TOKEN` | secret | |
| `GITHUB_REPO` | var | `BredaUniversityADSAI/2026-27s1-fai3-adsai-ComfyUI` |
| `YOUTRACK_BASE_URL` | var | `https://youtrack.ai.buas.nl` |
| `YOUTRACK_PROJECT` | var | `CUI` |
| `YOUTRACK_TITLE_PREFIX` | var | `[team]` |
| `MAX_WRITES_PER_RUN` | var | `30` |
| `DRY_RUN` | var | `true` (only `false` disables it; anything else keeps dry-run on) |

The Worker gets `vars` in `wrangler.jsonc` and `wrangler secret put` for secrets. Local runs use the
project `.env` (Node `--env-file`, and wrangler reads it too).

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
`gh label create youtrack --color 6f42c1 --description "Mirrored from YouTrack (read-only)"`) and
add `GITHUB_TOKEN` to `.env`.
