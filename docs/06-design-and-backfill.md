# Design notes, request budget, and backfill proposal

> Written 2026-09-24 from docs 00-05. Nothing here is decided until the open questions in
> [07-open-questions.md](07-open-questions.md) are answered. Where this doc says "proposal",
> it needs sign-off.

## The run as specified

1. **GitHub read:** `GET /repos/{o}/{r}/issues?labels=youtrack&state=all&per_page=100`. Follow
   `link: rel="next"` verbatim ([03](03-github-rest-api.md)). Drop items that have a
   `pull_request` key. Parse `^\[YT-(\d+)\]` into `numberInProject -> {number, state}`.
2. **YouTrack read:** `GET /api/issues`, `query=project: CUI sort by: updated desc`, an explicit
   `fields=` list, an explicit `$top`, paging with `$skip` until `updated < now - LOOKBACK_HOURS`
   or a short page comes back ([01](01-youtrack-query-syntax.md), [02](02-youtrack-rest-api.md)).
3. **Decide:** no mirror means create it, and close it right after if YouTrack has it resolved.
   A mirror that is open while YouTrack has the issue resolved gets closed. Everything else
   is left alone. _(Superseded by decision R9: an issue that is already resolved and has no
   mirror is never mirrored; only unresolved issues get a mirror.)_
4. **Cap:** at most `MAX_WRITES_PER_RUN` writes, oldest unsynced first. Log one summary line.

## Facts from research that constrain the implementation

These don't change behavior. They are how the specified behavior has to be built.

| Constraint                                                                               | Consequence                                                                                                                                     | Source |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Leaving out `fields` returns only `id`, `$type`. A misspelled field is silently dropped. | Always send `fields`. Check that `resolved` is a key (the value may be `null`) and fail the run if it's missing.                                | 02     |
| `resolved` and `description` can be `null`, even though the spec says otherwise          | Types are `number \| null` and `string \| null`.                                                                                                | 00, 02 |
| A bad query returns HTTP 400; it doesn't return an empty list                            | Treat any non-2xx from YouTrack as fatal for the run. Never read it as "no issues".                                                             | 01, 02 |
| `#` in a query must be percent-encoded                                                   | Build URLs with `URLSearchParams`.                                                                                                              | 01     |
| The default page size is disputed in the docs (42 vs "Max issues to export")             | Always send `$top`. Stop on a short page.                                                                                                       | 01, 02 |
| The tie-break order for equal `updated` values is undocumented                           | Dedupe by `numberInProject` within a run. Possibly add `, {issue id} desc` (open question).                                                     | 01     |
| The GitHub issues list includes PRs                                                      | Filter on the `pull_request` key.                                                                                                               | 03     |
| GitHub silently drops labels on create if the token owner lacks push access              | Check that `labels` in the 201 response contains `youtrack`. If it doesn't, stop the run loudly; otherwise every later run creates a duplicate. | 03     |
| `POST /issues` has no `state` field                                                      | A resolved backfill item costs 2 writes (create, then PATCH to close).                                                                          | 03     |
| GitHub requires a User-Agent, and Workers `fetch` probably sends none                    | Set `User-Agent: youtrack-gh-mirror` in the shared fetch helper.                                                                                | 03, 04 |
| GitHub asks for serial writes, and content creation is limited to 80/min and 500/h       | Make writes one at a time. A ~1 s pause between writes fits easily in the 15-min wall limit.                                                    | 03, 04 |
| Workers Free allows 50 subrequests per invocation, counting every fetch, reads included  | Budget every fetch, not only writes (see below).                                                                                                | 04     |
| Workers Free allows 10 ms CPU, and waiting on the network doesn't count                  | Keep `fields` small and parse each response once. At the current size this is fine.                                                             | 04     |
| No per-fetch timeout, and cron runs may overlap                                          | Use `AbortSignal.timeout()` on every fetch. Keep every action idempotent.                                                                       | 04     |
| The Debian `nodejs` package is 18 (bookworm) or 20 (trixie), and neither can run `.ts`   | The Debian host needs Node 22.18+ or 24 from NodeSource or nodejs.org, or else a prebuilt JS bundle.                                            | 05     |

## Subrequest budget per run (Workers Free = 50)

Let `N` = YouTrack issues scanned and `M` = GitHub items carrying the `youtrack` label.

| Call                                        | Count                                     |
| ------------------------------------------- | ----------------------------------------- |
| GitHub list                                 | `ceil(M / 100)`                           |
| Ensure label exists (if the script does it) | 1, plus 1 on the very first run           |
| YouTrack pages                              | `ceil(N / 100)` with `$top=100`           |
| Writes                                      | at most `MAX_WRITES_PER_RUN` (default 30) |

For CUI today (N = 29, M <= 29) that is 1 + 1 + 1 + 30 = **33 fetches**, well under 50.
Keeping `MAX_WRITES_PER_RUN = 30` leaves 20 fetches for reads. That covers a _full_
project scan up to roughly 1,800 issues, which is far more than a course project will reach.

**Initial backfill of CUI** means 29 creates plus 18 closes, 47 writes in total. With a cap of 30
that takes two runs, about 10 minutes apart. The GitHub content-creation limit (80/min) isn't
at risk.

## Backfill without state

### Your suggestion

> Full project scan when the GitHub map is empty or smaller than the YouTrack project count.

Problems found:

1. **No allowed call returns a project issue count.** The only count endpoint in the spec,
   `/api/issuesGetter/count`, is a **POST**, which the GET-only rule rules out ([02](02-youtrack-rest-api.md)).
   `numberInProject` can't stand in for it either, because it has gaps (24 and 27 are missing) ([00](00-live-verification.md)).
   The only way to learn the count with GETs is to page through the whole project, and that _is_ the full scan.
2. **"Map is empty" alone stalls a capped backfill.** After the first capped run the map isn't
   empty any more. From then on only the 24 h window is scanned, so issues last updated more than
   24 h ago and not reached in run 1 would never be mirrored.

### Options

|     | Option                                                                                                                                                      | Cost per run (CUI)                                       | Self-healing?                                                                     | Notes                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| A   | **Always do a full scan.** Keep `LOOKBACK_HOURS` out of the logic, or drop it.                                                                              | 1 YouTrack request (same as lookback today)              | Yes. It also catches missed closes after downtime, cap backlogs, and human edits. | Simplest to reason about. Cost grows with project size, but stays under budget up to ~1,800 issues. |
| B   | Lookback normally, plus a full scan when `map.size < issues seen in a full scan`                                                                            | Needs the full scan to know, so in practice it becomes A | --                                                                                | Circular. Listed only to show why the heuristic reduces to A.                                       |
| C   | Lookback normally, plus a full scan on a stateless schedule (e.g. when `controller.scheduledTime` falls in minute 0-9 of the hour, or when `BACKFILL=true`) | 1 extra YouTrack request per hour                        | Within an hour                                                                    | Keeps your lookback design and bounds the drift. Needs the time source to be passed into `sync()`.  |
| D   | Lookback only, plus a manual `BACKFILL=true` run from Node until it reports `capped=0`                                                                      | Lowest                                                   | No. It drifts after >24 h of downtime or a capped burst.                          | Closest to the original spec. Needs an operator.                                                    |

**Recommendation: A.** For this project it costs the same as the lookback window, it removes a
whole class of drift bugs, and it makes `BACKFILL` unnecessary. If you'd rather keep lookback as
the normal path, C is the next best. **This changes behavior, so it needs your decision.**

### "Oldest unsynced first"

This needs a definition (open question). The candidates are ascending `numberInProject`, which is
creation order and stable, or ascending `updated`. In either case the pending actions for the run
get sorted before the cap is applied, so skipped items are exactly the newest ones and the next
run picks them up.

## Idempotency walk-through

| Failure                                                       | Next run sees                       | Outcome                                                                          |
| ------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| Create succeeded, close didn't happen (cap, crash, or 5xx)    | Mirror open, YouTrack resolved      | Closes it. OK.                                                                   |
| Create timed out, but GitHub did create the issue             | Mirror present (if the label stuck) | No duplicate. OK.                                                                |
| Label silently dropped on create                              | No mirror found                     | **A duplicate every run.** Prevented by the label check in the response (above). |
| A person removes the label or edits `[YT-n]` out of the title | No mirror found                     | A duplicate is created. Open question.                                           |
| Two GitHub issues with the same `[YT-n]`                      | Ambiguous map                       | Open question: keep the lowest issue number and log a warning?                   |
| The YouTrack issue is reopened                                | Mirror closed, `resolved = null`    | Nothing happens (no reopening, per spec). Drift is accepted.                     |
| The YouTrack issue is deleted or moved out of CUI             | It's no longer in the scan          | The mirror stays as it is. Out of scope; noted.                                  |

## Out of scope (possible future extensions, not built)

- Title and body updates when YouTrack changes.
- Reopening mirrors when YouTrack issues are reopened.
- Handling issues moved out of or deleted from CUI.
- Replacing the whole mirror with YouTrack's Webhook Triggers app once BUas enables it.
