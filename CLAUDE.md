# youtrack-gh

A read-only, one-way mirror from a YouTrack project to GitHub issues in a repo, run every 10
minutes. The project (`YOUTRACK_PROJECT`, on the BUas instance `https://youtrack.ai.buas.nl`,
Server 2025.2) and the repo (`GITHUB_REPO`) are settings, so each student group runs its own copy
for its own project. It is an interim stopgap until BUas enables YouTrack's Webhook Triggers
app. Setup for users is in `README.md`.

It was written for one group's project, `CUI`. The research and live checks in `docs/` were done
against that project, so examples there such as `CUI-24` or "29 issues" describe CUI, not
necessarily the project you are working with.

## Hard rules

- **YouTrack is GET-only.** Never call any YouTrack endpoint that creates, updates, resolves,
  comments, tags or deletes. That includes POST endpoints that only read, such as
  `/api/issuesGetter/count`. If you're unsure whether a call is read-only, stop and ask.
- **Ask before any assumption that changes behavior.** Decisions in progress are listed in
  `docs/07-open-questions.md`; answers live in `docs/08-decisions.md`. Don't resolve open ones yourself.
- **`DRY_RUN` defaults to ON.** Only the user turns it off. Never do real GitHub writes while
  testing unless the user explicitly asks.
- Never print or commit tokens. `.env` is gitignored. Log redacted values only.
- The official docs and the instance's `youtrack-openapi.json` (local only, not committed) beat blog posts and training
  data. The spec lies about nullability: `resolved` and `description` can be `null`.

## Layout

- `src/sync.ts` + `src/sync/`: orchestration of one run (not pure: it does the I/O). Uses only
  `fetch`, takes config and deps as arguments, no Workers/Node APIs. Reads GitHub issues, then
  milestones, then YouTrack. `sync/execute.ts` runs the write loop and its stops (cap, fetch
  guard, rate limit, deadline). `sync/execute-write.ts` holds the only GitHub writer (built
  only when `DRY_RUN` is off) and turns write outcomes into counts. `sync/execute-issues.ts`
  (create, label re-add, close) and `sync/execute-hierarchy.ts` (milestones, update, move,
  detach) do the writes. `sync/resolved.ts` maps YouTrack numbers to GitHub numbers and ids
  within a run, `sync/preview.ts` is the dry run, `sync/describe.ts` the log wording both
  share, `sync/tally.ts` counts, and `sync/log.ts` redacts every log line.
- `src/plan.ts` + `src/plan/`, `src/hierarchy.ts`, `src/mirror.ts`, `src/utils/`: pure decision
  and formatting logic, no I/O. `hierarchy.ts` classifies `Type` values and walks parent links
  (cycle-safe). `plan/exclude.ts` decides which issues are excluded (F1, F3).
  `plan/desired.ts` works out each mirror's desired milestone, type and parent and how it
  differs. `plan/mirrors.ts` and `plan/milestones.ts` build the `[YT-n]` indexes,
  and `plan.ts` builds the actions, their order and the cap. New decision logic goes in
  `plan.ts` or `plan/`, not `sync.ts`.
- `src/http.ts` + `src/http/`: fetch wrapper (User-Agent, timeout, 45-fetch guard, retry-once,
  rate-limit detection, credential redaction).
- `src/youtrack.ts` (GET only): YouTrack client, including `Type` and the Subtask parent.
- `src/github/`: GitHub client, no barrel. `client.ts` has the target, headers, URLs and
  request builder, `link.ts` + `pages.ts` the Link paging, then `issues.ts`, `milestones.ts`
  and `sub-issues.ts`.
- `src/config.ts`: env -> validated `Config`. `src/json.ts`: the only JSON entry point
  (`parseJson` -> `JsonValue`).
- `src/generated/youtrack.ts`: openapi-typescript output, do not edit. Regenerate with
  `npm run gen:youtrack` after placing the instance's spec at `./youtrack-openapi.json` (the spec
  is intentionally not committed).
- `src/runtime.ts`: console logger and sleep shared by the two entrypoints; the sync core must not import it.
- `src/worker.ts`: Cloudflare `scheduled()` entrypoint (Workers Free, cron every 10 min, no HTTP route).
- `src/node.ts`: Node entrypoint that reads env vars. Also used for local dry runs and the Debian systemd timer.
- `.github/`: CI (`npm run check`, zizmor), the PR-title check, the semantic-release workflow
  (`.releaserc.json`) and Dependabot. `CONTRIBUTING.md` has the branch, PR-title and release
  rules (V1-V3); PR titles are conventional commits and pick the version. `main` is protected
  by a repo ruleset (PRs only, squash only, the three checks); never push to it directly.
- `docs/`: research and design. Start at `docs/README.md`.

## Config

Secrets: `GITHUB_TOKEN`, `YOUTRACK_TOKEN`. Vars: `GITHUB_REPO`, `YOUTRACK_BASE_URL`,
`YOUTRACK_PROJECT`, `YOUTRACK_EXCLUDE_PREFIX` (`[individual]`), `MAX_WRITES_PER_RUN` (30),
`DRY_RUN` (on). The first three vars are required (no defaults; `wrangler.jsonc` sets them for the
Worker, `.env` for `npm run sync`).

`.env` and `wrangler.jsonc` hold each user's own values and are gitignored. They are copied from
the committed `.env.example` and `wrangler.example.jsonc`, where the repo and project are blank.
Never put a real repo, project or token in the example files. `npm run gen:worker-types` reads
the two example files, not the local ones, so the committed `worker-configuration.d.ts` does not
depend on anyone's own values. Rerun it after adding a var or binding to `wrangler.example.jsonc`
(and the var to `.env.example`, `ENV_KEYS` in `src/config.ts` and the README).

Full project scan every run; no lookback. Every issue and
epic is mirrored except summaries starting with the exclude prefix (case-insensitive, F1) and
everything below such an issue: any YouTrack ancestor with the prefix, epics included, excludes
it too (F3; the walk follows parent cycles too). An excluded issue counts as `filtered` and is
ignored entirely, existing mirror or milestone left as it is (F2); `isExcluded` in
`src/plan/exclude.ts` is the rule. Only unresolved issues get a mirror; an already-resolved
issue without one is never mirrored (R9). Plan (implemented, see its "As built" section):
`docs/09-implementation-plan.md`.

## Hierarchy (H1-H10, D1-D8; docs/10 and docs/11)

Epic -> milestone `[YT-n] <summary>`. User Story -> issue with type Feature, Bug -> issue with
type Bug, any other type -> issue with no type; these are always top-level (H9). Task -> issue
with type Task, as a sub-issue of the mirror of its nearest non-epic ancestor that has one, or
top-level if there is none. Every mirror gets the milestone of its nearest epic, if that epic
has one (D1). Epics use the same exclude filter (F1, F3) and the same R9 rule as issues, and an
excluded issue's mirror or milestone is never used as a parent or milestone. Every run
syncs milestone, type and parent on all mirrors, open or closed (D8). Titles, bodies and
milestone descriptions never change after creation, and nothing is reopened (D7). Only
mirror-owned links are changed (D2) and a type is never cleared (D3). A child whose parent
mirror or milestone is created in the same run waits for it and is capped if that create fails
or waits itself (D4). Order: milestones, non-task creates, task creates by depth, syncs, closes.

## Conventions

- TypeScript with erasable syntax only (no enums/namespaces/parameter properties). Relative
  imports use `.ts` extensions, so Node type-stripping and wrangler/esbuild both run the same
  sources. Type-check with `npm run typecheck` (runs tsconfig.node.json and tsconfig.worker.json;
  bare `tsc` skips src/worker.ts). Run `npm run check` before committing.
- Minimal dependencies, no frameworks.
- Probe YouTrack by hand like this (GET only, token never echoed):
  `set -a; . ./.env; set +a; curl -sS -G "https://youtrack.ai.buas.nl/api/issues" -H "Authorization: Bearer $YOUTRACK_TOKEN" --data-urlencode 'query=...' --data-urlencode 'fields=...' --data-urlencode '$top=...'`
- Commands here use bash syntax (on Windows, Git Bash works).

## Gotchas that have already bitten (or nearly)

- YouTrack: leaving out `fields` returns only `id`/`$type`, and misspelled fields are silently
  dropped. A bad query returns HTTP 400, never an empty list. `..` in a date range needs spaces
  around it, otherwise you get 0 rows and no error.
- GitHub: labels on `POST /issues` are silently dropped without push access. Verify them in the
  response, or you get a duplicate mirror every run. The issues list includes PRs. A User-Agent
  is required. Milestone and type are dropped silently the same way.
- GitHub: `parent_issue_id` and `sub_issue_id` take the issue's REST `id`, not its number. The
  sub-issue endpoints are `POST .../issues/{n}/sub_issues` but `DELETE .../issues/{n}/sub_issue`
  (singular, with a JSON body). Issue types exist only on organization repos.
- Workers Free: 50 subrequests per invocation, counting reads as well as writes. 10 ms CPU.
