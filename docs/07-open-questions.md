# Open questions (answer before any code is written)

> Collected from docs 01-06 on 2026-09-24. Each question notes what it affects and where the
> evidence is. Recommendations are marked; none of them are decided.

## A. Behavior changes (need your call)

1. **Backfill strategy.** Should we always do a full scan (A), use lookback plus an hourly full
   scan (C), or use lookback plus a manual `BACKFILL` run (D)? Your "count" heuristic isn't possible
   with GET-only calls. *Rec: A.* See [06](06-design-and-backfill.md#backfill-without-state).
2. **What "oldest unsynced first" means.** Ascending `numberInProject` (creation order) or
   ascending `updated`? *Rec: `numberInProject`.*
3. **What counts toward the cap.** Is a create+close pair 1 or 2 writes against
   `MAX_WRITES_PER_RUN`? And do we also enforce a hard total-fetch budget (e.g. 45) that includes
   reads, so a Workers run can never reach 50? *Rec: count each HTTP write, and add the fetch
   guard.* See [04](04-cloudflare-workers.md), [06](06-design-and-backfill.md).
4. **Body content.** Descriptions are YouTrack Markdown (`usesMarkdown=true` for all 29).
   A copied `@name` notifies org members, and `#12` / `GH-12` autolink to *GitHub* issues. Options:
   (a) copy as-is; (b) neutralise `@` and `#<n>`, for example by inserting a zero-width space or
   wrapping them in backticks; (c) put the description in a quote or code block. And
   what should the body be for a `null` description (CUI-30): only the link? See [02](02-youtrack-rest-api.md), [03](03-github-rest-api.md).
5. **Label dropped on create.** Should the run abort (fail loudly), or close the stray issue
   and abort? Closing it is itself a write. *Rec: abort, log loudly, create nothing else.*
6. **Duplicate or mangled mirrors.** Two GitHub issues with the same `[YT-n]`: keep the lowest
   issue number and log? A mirror whose label was removed or whose title was edited will get a
   duplicate. Is that acceptable?
7. **`state_reason` for closing.** `completed` for every resolved state, including ones like
   "Won't fix" or "Duplicate"? *Rec: always `completed` (your spec).* Mapping states would need more
   YouTrack fields.
8. **Restricted issues.** Should issues with `visibility.$type = LimitedVisibility` be skipped?
   Otherwise a mirror publishes them to every reader of the repo. *Rec: skip, and count them in the
   log line.* See [02](02-youtrack-rest-api.md).
9. **Long titles and bodies.** GitHub's limits (256 characters for titles, 65,536 for bodies)
   aren't documented officially. Truncate with an ellipsis, or skip and log?
10. **Failure signalling on Workers.** When a run partly fails, should the handler throw, so it
    shows as an error in Cron Events and Logs, or log and return? Should it call
    `controller.noRetry()`? Cron retry behavior is undocumented. See [04](04-cloudflare-workers.md).

## B. Facts only you can check

11. **Your role on the GitHub repo.** Write/Maintain/Admin, or Triage? Org member or outside
    collaborator? This decides whether `labels` survive `POST /issues`. It's the biggest risk.
    See [03](03-github-rest-api.md).
12. **Whether the org allows fine-grained PATs,** and whether this token is *approved* or still
    pending. A pending token only gets public read access.
13. **Your YouTrack profile time zone.** It only matters if we filter with relative dates on the
    server side. *Rec: filter client-side on epoch-ms `updated`,* which avoids the question. See [01](01-youtrack-query-syntax.md).
14. **The Debian box.** Release (12 or 13), architecture, and who has root to add the
    NodeSource repo? Stock Debian Node can't run the `.ts` sources. See [05](05-node-debian-systemd.md).
15. **Will the Worker and the systemd timer ever run at the same time?** Everything is
    idempotent except creates that race each other: two hosts creating the same mirror at once
    produce a duplicate. *Rec: document "exactly one host active".*

## C. Implementation defaults (I'll pick these unless you object)

| Item | Default I'd use | Source |
|---|---|---|
| Project reference | `project: CUI` (shortName) | 01 |
| Secondary sort key | `sort by: updated desc, {issue id} desc` for deterministic paging | 01 |
| Lookback filter (if lookback is kept) | Client-side `updated < cutoff` stop, with no date term in the query | 01 |
| YouTrack `$top` | 100 | 01, 02 |
| GitHub API version header | `X-GitHub-Api-Version: 2026-03-10` | 03 |
| `youtrack` label | Script checks with GET and creates it on 404 (costs 1 fetch per run) | 03 |
| Pause between GitHub writes | 1 s | 03 |
| Per-fetch timeout | `AbortSignal.timeout(15_000)` | 04 |
| Wrangler config | `wrangler.jsonc`, `workers_dev: false`, `preview_urls: false`, `observability.enabled: true`, `compatibility_date: 2026-09-24` | 04 |
| Local Worker env | Reuse the project `.env` (wrangler reads it); no `.dev.vars` | 04 |
| TypeScript | `.ts` import specifiers, erasable syntax only, `tsc --noEmit` as the only dev tool besides wrangler | 04, 05 |
| Node host | Node 24 LTS via NodeSource, run with `node --env-file-if-exists` ... | 05 |
| systemd | `Type=oneshot`, `OnCalendar=*:0/10`, `TimeoutStartSec=5min`, secrets via `LoadCredential=` | 05 |
