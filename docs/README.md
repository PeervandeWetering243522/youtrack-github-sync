# docs/

Research for the read-only YouTrack -> GitHub issue mirror, done 2026-09-24. Docs 01-05 were
written by a research agent, then checked by an independent verifier that re-opened every cited
source. Claims carry status tags: `[verified]`, `[live]`, `[partial]`, `[undocumented]`.

| File | Contents |
|---|---|
| [00-live-verification.md](00-live-verification.md) | Step 0: raw issue JSON, `null` handling, project shape, paging probes |
| [01-youtrack-query-syntax.md](01-youtrack-query-syntax.md) | `project:`, `sort by:`, date ranges, `{minus Nh}`, silent-failure gotchas |
| [02-youtrack-rest-api.md](02-youtrack-rest-api.md) | `/api/issues` params, Issue schema vs live, auth, errors, GET-only audit |
| [03-github-rest-api.md](03-github-rest-api.md) | List/create/close issues, labels, PAT permissions, API versions, rate limits |
| [04-cloudflare-workers.md](04-cloudflare-workers.md) | Free plan limits, cron config, `scheduled()`, secrets, local testing, logs |
| [05-node-debian-systemd.md](05-node-debian-systemd.md) | Node versions, running TS directly, Debian packages, systemd timer |
| [06-design-and-backfill.md](06-design-and-backfill.md) | Constraints from research, subrequest budget, backfill options, idempotency |
| [07-open-questions.md](07-open-questions.md) | Questions to answer before implementation |
| [08-decisions.md](08-decisions.md) | Answers to the open questions (decided / pending) |
| [09-implementation-plan.md](09-implementation-plan.md) | Implementation plan awaiting sign-off |
