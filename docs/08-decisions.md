# Decisions log

> Answers to [07-open-questions.md](07-open-questions.md), given 2026-09-24. "Pending" means we're
> still waiting on confirmation.

| # | Topic | Decision | Status |
|---|---|---|---|
| A1 | Backfill | **Always full project scan** (option A). `LOOKBACK_HOURS`/`BACKFILL` dropped. | Decided |
| A2 | Oldest-first order | Ascending `numberInProject`. Gaps (deleted issues 24, 27) are fine for ordering and identity. | Decided |
| A3 | Write cap / budget | Whatever keeps us on Workers Free. Count every HTTP write (create and close are 2) and add a hard total-fetch guard below 50. | Decided (delegated) |
| A4 | Body content | Wrap `@mentions` and `#<n>` / `GH-<n>` references in backticks. A `null` description gives a body with only the YouTrack link. | Decided |
| A5 | Label dropped on create | Keep the issue. Re-add the label once via `POST /issues/{n}/labels`; mirrors are also matched by `[YT-n]` title without the label (warning logged). The GitHub list is therefore unfiltered (includes PRs, dropped client-side). | Decided |
| A6 | Duplicate / edited mirrors | Accept duplicates. The team agrees not to edit mirror titles or labels. | Decided |
| A7 | `state_reason` | Always `completed` (CUI resolved state is only `Done`). | Decided |
| A8 | Which issues to mirror | Only summaries starting with `YOUTRACK_TITLE_PREFIX` (default `[team]`, case-insensitive; configurable). No restricted-visibility issues exist today. | Decided |
| A9 | Long title/body | Truncate. When anything is cut, add a note like "Character limit hit, see the full YouTrack issue: <link>". | Decided |
| A10 | Failure signalling | Throw at end of run on any failure. Retry once in code for GETs, PATCH, POST labels; never for POST create. | Decided |
| B11 | GitHub role | Org member with Admin, so labels stick on create. | Fact |
| B12 | Token | **Classic (legacy) PAT with `repo` scope** for now instead of a fine-grained PAT. | Decided |
| B13 | YouTrack profile TZ | UTC. | Fact |
| B14 | Host | Cloudflare Workers is primary. The Debian box isn't set up yet. | Decided |
| B15 | systemd | Documented only as a fallback that *replaces* the Worker. Never run both. | Decided |
| C | Project reference | `project: CUI` (shortName; full name "ComfyUI 26-27S1"). | Decided |
| T1 | Types | YouTrack types generated with openapi-typescript; derive-and-narrow `FetchedIssue` (nullable `resolved`/`description`) + runtime guard. | Decided |
| T2 | Toolchain | TypeScript 5.9 + ESLint/typescript-eslint `strictTypeChecked`; `any` banned; `unknown` only at the JSON boundary. | Decided |
| G1 | GitHub label | `youtrack` label created once by hand (done); the script never creates it. Label checks are case-insensitive. | Decided |
| R1 | `mirror.ts` size | Keep the full CommonMark-aware neutralisation, but split it into util modules under `src/utils/`. | Decided |
| R2 | Prefix removed after mirroring | Keep as is: an issue without the prefix is ignored entirely, even if a mirror exists. | Decided |
| R3 | Log content | Per-action log lines may include issue titles (never descriptions or tokens). | Decided |
| R4 | Row sanity check | Every YouTrack row must have `idReadable` = `<project>-<numberInProject>`; otherwise the run fails. | Decided |
