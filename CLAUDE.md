# youtrack-gh

A read-only, one-way mirror from YouTrack project **CUI** ("ComfyUI 26-27S1") on
`https://youtrack.ai.buas.nl` (Server 2025.2) to GitHub issues in the private repo
`BredaUniversityADSAI/2026-27s1-fai3-adsai-ComfyUI`. It is an interim stopgap until BUas
enables YouTrack's Webhook Triggers app.

## Hard rules

- **YouTrack is GET-only.** Never call any YouTrack endpoint that creates, updates, resolves,
  comments, tags or deletes. That includes POST endpoints that only read, such as
  `/api/issuesGetter/count`. If you're unsure whether a call is read-only, stop and ask.
- **Ask before any assumption that changes behavior.** Decisions in progress are listed in
  `docs/07-open-questions.md`; answers live in `docs/08-decisions.md`. Don't resolve open ones yourself.
- **`DRY_RUN` defaults to ON.** Only the user turns it off. Never do real GitHub writes while
  testing unless the user explicitly asks.
- Never print or commit tokens. `.env` is gitignored. Log redacted values only.
- The official docs and the instance's `youtrack-openapi.json` beat blog posts and training
  data. The spec lies about nullability: `resolved` and `description` can be `null`.

## Layout (planned)

- `src/sync.ts`: pure logic. Uses only `fetch`, takes config as an argument, no Workers/Node APIs.
- `src/worker.ts`: Cloudflare `scheduled()` entrypoint (Workers Free, cron every 10 min, no HTTP route).
- `src/node.ts`: Node entrypoint that reads env vars. Also used for local dry runs and the Debian systemd timer.
- `docs/`: research and design. Start at `docs/README.md`.

## Config

Secrets: `GITHUB_TOKEN`, `YOUTRACK_TOKEN`. Vars: `GITHUB_REPO`, `YOUTRACK_BASE_URL`,
`YOUTRACK_PROJECT` (CUI), `YOUTRACK_TITLE_PREFIX` (`[team]`), `MAX_WRITES_PER_RUN` (30), `DRY_RUN`
(on). Full project scan every run; no lookback. Plan: `docs/09-implementation-plan.md`.

## Conventions

- TypeScript with erasable syntax only (no enums/namespaces/parameter properties). Relative
  imports use `.ts` extensions, so Node type-stripping and wrangler/esbuild both run the same
  sources. Type-check with `tsc --noEmit`.
- Minimal dependencies, no frameworks.
- Probe YouTrack by hand like this (GET only, token never echoed):
  `set -a; . ./.env; set +a; curl -sS -G "$BASE/api/issues" -H "Authorization: Bearer $YOUTRACK_TOKEN" --data-urlencode 'query=...' --data-urlencode 'fields=...' --data-urlencode '$top=...'`
- Shell is Git Bash on Windows. `jq` and `node` are available.

## Gotchas that have already bitten (or nearly)

- YouTrack: leaving out `fields` returns only `id`/`$type`, and misspelled fields are silently
  dropped. A bad query returns HTTP 400, never an empty list. `..` in a date range needs spaces
  around it, otherwise you get 0 rows and no error.
- GitHub: labels on `POST /issues` are silently dropped without push access. Verify them in the
  response, or you get a duplicate mirror every run. The issues list includes PRs. A User-Agent
  is required.
- Workers Free: 50 subrequests per invocation, counting reads as well as writes. 10 ms CPU.
