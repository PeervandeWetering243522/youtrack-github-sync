# Open questions (answer before any code is written)

> Collected from docs 01-06 on 2026-09-24. Each question notes what it affects and where the
> evidence is. Recommendations are marked; none of them are decided.

## A. Behavior changes (need your call)

1. **Backfill strategy.** Should we always do a full scan (A), use lookback plus an hourly full
   scan (C), or use lookback plus a manual `BACKFILL` run (D)? Your "count" heuristic isn't possible
   with GET-only calls. _Rec: A._ See [06](06-design-and-backfill.md#backfill-without-state).
2. **What "oldest unsynced first" means.** Ascending `numberInProject` (creation order) or
   ascending `updated`? _Rec: `numberInProject`._
3. **What counts toward the cap.** Is a create+close pair 1 or 2 writes against
   `MAX_WRITES_PER_RUN`? And do we also enforce a hard total-fetch budget (e.g. 45) that includes
   reads, so a Workers run can never reach 50? _Rec: count each HTTP write, and add the fetch
   guard._ See [04](04-cloudflare-workers.md), [06](06-design-and-backfill.md).
4. **Body content.** Descriptions are YouTrack Markdown (`usesMarkdown=true` for all 29).
   A copied `@name` notifies org members, and `#12` / `GH-12` autolink to _GitHub_ issues. Options:
   (a) copy as-is; (b) neutralise `@` and `#<n>`, for example by inserting a zero-width space or
   wrapping them in backticks; (c) put the description in a quote or code block. And
   what should the body be for a `null` description (CUI-30): only the link? See [02](02-youtrack-rest-api.md), [03](03-github-rest-api.md).
5. **Label dropped on create.** Should the run abort (fail loudly), or close the stray issue
   and abort? Closing it is itself a write. _Rec: abort, log loudly, create nothing else._
6. **Duplicate or mangled mirrors.** Two GitHub issues with the same `[YT-n]`: keep the lowest
   issue number and log? A mirror whose label was removed or whose title was edited will get a
   duplicate. Is that acceptable?
7. **`state_reason` for closing.** `completed` for every resolved state, including ones like
   "Won't fix" or "Duplicate"? _Rec: always `completed` (your spec)._ Mapping states would need more
   YouTrack fields.
8. **Restricted issues.** Should issues with `visibility.$type = LimitedVisibility` be skipped?
   Otherwise a mirror publishes them to every reader of the repo. _Rec: skip, and count them in the
   log line._ See [02](02-youtrack-rest-api.md).
9. **Long titles and bodies.** GitHub's limits (256 characters for titles, 65,536 for bodies)
   aren't documented officially. Truncate with an ellipsis, or skip and log?
10. **Failure signalling on Workers.** When a run partly fails, should the handler throw, so it
    shows as an error in Cron Events and Logs, or log and return? Should it call
    `controller.noRetry()`? Cron retry behavior is undocumented. See [04](04-cloudflare-workers.md).

## B. Facts only you can check

11. **Your role on the GitHub repo.** Write/Maintain/Admin, or Triage? Org member or outside
    collaborator? This decides whether `labels` survive `POST /issues`. It's the biggest risk.
    See [03](03-github-rest-api.md).
12. **Whether the org allows fine-grained PATs,** and whether this token is _approved_ or still
    pending. A pending token only gets public read access.
13. **Your YouTrack profile time zone.** It only matters if we filter with relative dates on the
    server side. _Rec: filter client-side on epoch-ms `updated`,_ which avoids the question. See [01](01-youtrack-query-syntax.md).
14. **The Debian box.** Release (12 or 13), architecture, and who has root to add the
    NodeSource repo? Stock Debian Node can't run the `.ts` sources. See [05](05-node-debian-systemd.md).
15. **Will the Worker and the systemd timer ever run at the same time?** Everything is
    idempotent except creates that race each other: two hosts creating the same mirror at once
    produce a duplicate. _Rec: document "exactly one host active"._

## C. Implementation defaults (I'll pick these unless you object)

| Item                                  | Default I'd use                                                                                                                | Source |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------ |
| Project reference                     | `project: CUI` (shortName)                                                                                                     | 01     |
| Secondary sort key                    | `sort by: updated desc, {issue id} desc` for deterministic paging                                                              | 01     |
| Lookback filter (if lookback is kept) | Client-side `updated < cutoff` stop, with no date term in the query                                                            | 01     |
| YouTrack `$top`                       | 100                                                                                                                            | 01, 02 |
| GitHub API version header             | `X-GitHub-Api-Version: 2026-03-10`                                                                                             | 03     |
| `youtrack` label                      | Script checks with GET and creates it on 404 (costs 1 fetch per run)                                                           | 03     |
| Pause between GitHub writes           | 1 s                                                                                                                            | 03     |
| Per-fetch timeout                     | `AbortSignal.timeout(15_000)`                                                                                                  | 04     |
| Wrangler config                       | `wrangler.jsonc`, `workers_dev: false`, `preview_urls: false`, `observability.enabled: true`, `compatibility_date: 2026-09-24` | 04     |
| Local Worker env                      | Reuse the project `.env` (wrangler reads it); no `.dev.vars`                                                                   | 04     |
| TypeScript                            | `.ts` import specifiers, erasable syntax only, `tsc --noEmit` as the only dev tool besides wrangler                            | 04, 05 |
| Node host                             | Node 24 LTS via NodeSource, run with `node --env-file-if-exists` ...                                                           | 05     |
| systemd                               | `Type=oneshot`, `OnCalendar=*:0/10`, `TimeoutStartSec=5min`, secrets via `LoadCredential=`                                     | 05     |

## D. Assignees (from [12](12-assignees.md), 2026-10-02)

Research only: assign each mirror to the GitHub account of its YouTrack assignee, matched by the
BUas student ID in logins and emails. Details and evidence in
[12](12-assignees.md#open-questions-for-the-user).

**All answered 2026-10-02** in [08](08-decisions.md) as U1-U17. 18 (emails) is settled by U17:
hidden emails are only an inference (see 12), so the login comes first and the email is a
fallback. 25 is U14, 26 is U15, 27 is U16.

16. **Opt-in.** Off on every host, on in the Action only (like R10), or always on? Always on
    changes the README's "assign as you like" contract and is a `feat!`. _Rec: off everywhere._
17. **Matching source.** The ID in the GitHub login (from the repo's assignable list), plus an
    explicit map, plus a commit-email cross-check (needs `contents: read`), or a map only?
    _Rec: login ID on the assignable list._ See
    [12](12-assignees.md#from-a-student-id-to-a-github-account).
18. **YouTrack identifier.** Login only (don't request the email), login cross-checked with the
    email when visible, both required, or either one when only one carries an ID? Emails may be
    hidden from some tokens. _Rec: login, with the cross-check._
19. **Ambiguous or unmatched users** (staff, shared IDs, login and email disagreeing). Skip, prefer
    the email ID, or prefer the login ID? Warn per issue, once per run, or as a summary count?
    _Rec: skip, one aggregated warning per run, ids only._
20. **Who owns GitHub assignees.** YouTrack wins (replace), add only, mirror-owned (only logins that
    map to a YouTrack user), or set on create only? _Rec: mirror-owned, never bots._
21. **Which write.** In the create body and sync PATCH, in the sync PATCH only, or separate
    `POST`/`DELETE /issues/{n}/assignees` (for a new mirror, possibly right after the create, like
    A5)? A bad login can 422 a whole create or PATCH (community reports). _Rec: separate calls,
    checked against the assignable list._
22. **Unassigned in YouTrack, or reassigned to someone unmatched.** Leave GitHub alone (like D3),
    clear owned assignees, or clear all? A renamed field reads as "nobody assigned". _Rec: leave
    alone, and warn loudly when the field is missing._
23. **Closed mirrors.** Open only, or all (like D8)? _Rec: open only._
24. **Logs.** Counts and markers only, YouTrack ids with matched or unmatched, or full logins?
    Logins carry student IDs. _Rec: markers and ids, with logins scrubbed from 422 bodies._
25. **Explicit map** for staff and logins without an ID, as a repo variable or in the workflow
    file? _Rec: defer._
26. **Field name and multi-user fields.** Fixed `Assignee`, a config var checked to be a user
    field, or detect by type? For multi-user fields: all, the first, or fail? A missing field
    should fail loudly either way.
27. **Assignable-list read fails.** Fatal like the other reads, or warn and skip assignee sync?
28. **Rollout.** Dry run, then `max-writes-per-run: "1"`, and tell the team first? _Rec: yes._
29. **A live authenticated test on a throwaway repo** (silent drop vs 422, the per-issue check,
    the actor on `GITHUB_TOKEN` events)? It needs real GitHub writes, so only you can allow it.
30. **For a BUas YouTrack admin:** auth module, whether students can edit username and email,
    email verification, whether the identity provider overwrites edits, Contributor or Developer
    for student projects, and any 2026.x upgrade plans. Ask, or assume self-asserted IDs?
31. **Sources that need an owner or new endpoints** (Enterprise Cloud, SAML, a verified domain, Hub
    VCS usernames, issue events). Ask an org owner, or out of scope? _Rec: out of scope._
32. **Epic assignees.** Ignore, or push down to children? _Rec: ignore._

**Open (from the review of the implementation, 2026-10-03):**

33. **Worker upgrades and lookup URLs (U1, U8).** A `wrangler.jsonc` copied before v1.0.0 has
    `"redact_query_string": false` and no `SYNC_ASSIGNEES`, so after a plain `wrangler deploy`
    the default-on sync sends commit and email lookups whose URLs (with student emails) end up
    in persisted Workers Logs and traces. The README tells upgraders to set the flag first.
    Should the Worker (or every host) instead treat a missing `SYNC_ASSIGNEES` as off, or skip
    the lookups unless it is set? Either changes the U1 default. Also unverified: whether
    `redact_query_string` strips subrequest URLs in traces at all (rollout step 2); if not,
    should the example turn trace persistence off? See [13](13-assignees-plan.md#7-risks).
