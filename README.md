# youtrack-gh

A read-only, one-way mirror from the YouTrack project **CUI** ("ComfyUI 26-27S1") on
`https://youtrack.ai.buas.nl` to GitHub issues in the private repo
`BredaUniversityADSAI/2026-27s1-fai3-adsai-ComfyUI`.

This is an **interim stopgap**. Once BUas enables YouTrack's Webhook Triggers app, that app
replaces this tool and the Worker (or timer) should be removed.

It runs as a Cloudflare Workers cron job (Free plan, every 10 minutes). The same code also runs
as a plain Node script, for local dry runs and for the Debian/systemd fallback host.

## What a run does

1. **Lists every GitHub issue** in the repo (`state=all`, no label filter), dropping pull
   requests. An issue whose title starts with `[YT-<n>]` is the mirror of YouTrack issue `n`.
   One with the `youtrack` label wins. A title match without the label still counts as the
   mirror, and a warning is logged. If several issues match, the lowest number wins (warning).
   For each mirror it keeps the REST `id`, milestone, issue type and parent.
2. **Lists every GitHub milestone** (`state=all`). A milestone whose title starts with
   `[YT-<n>]` is the milestone of YouTrack epic `n`. If several match, the lowest number wins
   (warning). Any other milestone counts as hand-made.
3. **Scans the whole YouTrack project** on every run (`GET /api/issues`,
   `project: CUI sort by: {issue id} asc`, 100 per page), including each issue's `Type` field
   and its Subtask parent. There is no lookback window. The run fails on any row whose
   `idReadable` is not `<project>-<numberInProject>`, and on any row with two parents or two
   `Type` fields.
4. **Filters out** every issue or epic whose summary starts with `YOUTRACK_EXCLUDE_PREFIX`
   (default `[individual]`, case-insensitive, leading whitespace ignored), and everything below
   it in YouTrack: an issue is also excluded when any ancestor (parent, grandparent and so on,
   epics included, resolved or not) starts with the prefix (decisions F1, F3). Excluded issues
   count as `filtered` and get no write at all, even if they already have a mirror or
   milestone: one that gets the prefix, or moves under an issue that has it, after it was
   mirrored keeps its mirror or milestone as it is, which is no longer synced or closed
   (decision F2). Every other issue goes on to planning, whatever its prefix (`[team]` is an
   ordinary summary now).
5. **Plans**, using the [hierarchy mapping](#hierarchy) below:
   - no mirror (for an epic: no milestone) and unresolved in YouTrack: **create** it. An issue
     is `[YT-<n>] <summary>` with the `youtrack` label, and its issue type, milestone and (tasks
     only) parent go in the same request. The body is the description with `@mentions` and
     `#123`-style references wrapped in backticks, plus a link back to YouTrack. A milestone
     gets the same title, the body as its description, and no due date.
   - no mirror and already resolved: nothing (`unchanged`). Issues and epics that are resolved
     before they are ever mirrored never get a mirror (decision R9).
   - every existing mirror, open or closed: **sync** its milestone, type and parent with
     YouTrack (an update, a move or a detach).
   - open mirror or milestone, and resolved in YouTrack: **close** it (issues with
     `state_reason: completed`).
   - anything else: nothing (`unchanged`).
6. **Writes** serially, 1 s apart, in this order: milestone creates and closes; creates of
   everything except tasks; creates of tasks, parents before children; syncs; closes. Within a
   group the oldest (lowest issue number) goes first. At most `MAX_WRITES_PER_RUN` writes run
   per run. Whatever does not fit is `capped` and picked up by the next run, and nothing later
   jumps ahead. Every action costs one write. If GitHub drops the label on create, it is
   re-added once (this counts as a write). A child whose parent mirror or milestone is created
   earlier in the same run uses it. If that create failed or waited itself, the child is
   `capped` too (with a warning) and the run goes on. The write phase also stops early,
   counting the rest as `capped`, when GitHub rate-limits a write, when the fetch guard is
   reached, or when the run deadline passes (see [Limits and budget](#limits-and-budget)).
7. **Logs one line per write and one summary line**, for example:

   ```text
   create milestone YT-40 -> #1
   create YT-41 with type Feature, milestone YT-40 #1 -> #30
   create YT-42 with type Task, milestone YT-40 #1, parent YT-41 #30 -> #31
   update YT-15 #21: set type Task
   close YT-3 #12
   yt-gh-sync ok scanned=40 created=2 closed=1 updated=1 milestonesCreated=1 milestonesClosed=0 skipped=35 capped=0 failed=0 filtered=28 unchanged=7 labelsReAdded=0 fetches=8 dryRun=false
   ```

   The headline counts come first. `updated` counts updates, moves and detaches, and `skipped`
   = `filtered` + `unchanged`. The other write lines look like `close milestone YT-33 #7`,
   `update YT-15 #21: set milestone YT-33 #7`, `update YT-15 #21: clear milestone`,
   `move YT-42 #31 under YT-36 #22`, `detach YT-42 #31 from parent YT-41 #30` and
   `label YT-41 #30` (label re-added).

### Hierarchy

| YouTrack `Type`   | GitHub                                                                | Issue type |
| ----------------- | --------------------------------------------------------------------- | ---------- |
| Epic              | milestone `[YT-<n>] <summary>`, no due date                           | -          |
| User Story        | issue                                                                 | Feature    |
| Bug               | issue                                                                 | Bug        |
| Task              | sub-issue of its parent's mirror, or a top-level issue if it has none | Task       |
| other, or no Type | issue                                                                 | none       |

- **Milestone:** every mirror gets the milestone of its nearest Epic ancestor, if that epic
  has one. Higher epics are not searched. An existing milestone still counts after its epic
  is resolved.
- **Parent:** only tasks become sub-issues. A task goes under the mirror of its nearest
  non-epic ancestor that has one, skipping ancestors without a mirror. The walk stops at the
  first epic. With no such ancestor the task is top-level, and it is moved once a parent
  mirror exists. Stories, bugs and other issues are always top-level, so one that sits under
  another mirror is detached.
- **Parent links** come from YouTrack's Subtask link. A parent in another project ends the
  walk. A parent cycle, which YouTrack should never hold, is ignored for milestones and
  parents and logged as `YT-<n>: parent chain loops back to YT-<m>`. The exclude filter still
  follows it: if any issue on a cycle has the exclude prefix, the whole cycle and everything
  below it is excluded.
- **Excluded issues** are never used as a milestone or parent: everything below one is
  excluded too. A mirror that still sits under an excluded issue's mirror, or in an excluded
  epic's milestone, is moved or detached like any other once YouTrack has it elsewhere.
- **Hand-made links stay:** a milestone or parent that is not a mirror is left alone unless
  YouTrack wants a mirrored one there. A type is never cleared, so a mirror whose YouTrack type
  has no mapping keeps whatever type it has on GitHub.

**Never done.** YouTrack is only ever read: the only call is `GET /api/issues`. On GitHub the
tool never reopens an issue or milestone, never changes a title, body or milestone description
after creation, never comments, never reorders sub-issues, never clears an issue type, never
creates labels and never touches pull requests. Relates links and sprints are not mirrored.

**Failures.** A failed read (GitHub issues or milestones, YouTrack scan) logs a
`yt-gh-sync failed ...` summary line and aborts the run. A failed write is logged, the run
carries on with the other writes (unless GitHub rate-limited it), and at the end it logs
`yt-gh-sync failed ...` and throws, so the run shows as failed in Cron Events (or as a failed
systemd unit). A write that waits for a failed create is `capped`, not failed. Tokens are
never logged.

**Dry run is on by default.** With `DRY_RUN` on, the run reads both sides and logs one
`[dry-run] would ...` line per planned write, but sends no GitHub write at all. The create
lines end with the title. A milestone or mirror that the run would create earlier shows as
`(new)`:

```text
[dry-run] would create milestone YT-40: [YT-40] Data pipeline
[dry-run] would create YT-41 with type Feature, milestone YT-40 (new): [YT-41] Ingest the data
[dry-run] would create YT-42 with type Task, milestone YT-40 (new), parent YT-41 (new): [YT-42] Clean the data
[dry-run] would update YT-15 #21: set type Task
[dry-run] would close YT-3 #12
```

## Configuration

| Name                      | Kind   | Default        | Notes                                                                                                                          |
| ------------------------- | ------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GITHUB_TOKEN`            | secret | required       | Classic PAT with the `repo` scope (decision B12).                                                                              |
| `YOUTRACK_TOKEN`          | secret | required       | YouTrack permanent token.                                                                                                      |
| `GITHUB_REPO`             | var    | required       | `owner/repo`. `wrangler.jsonc` sets `BredaUniversityADSAI/2026-27s1-fai3-adsai-ComfyUI`.                                       |
| `YOUTRACK_BASE_URL`       | var    | required       | https URL without query string, fragment or credentials. `wrangler.jsonc` sets `https://youtrack.ai.buas.nl`.                  |
| `YOUTRACK_PROJECT`        | var    | required       | Project shortName, starting with a letter or digit. `wrangler.jsonc` sets `CUI`.                                               |
| `YOUTRACK_EXCLUDE_PREFIX` | var    | `[individual]` | Case-insensitive summary prefix that keeps an issue or epic, and everything below it, out of the mirror. Not blank when set.   |
| `MAX_WRITES_PER_RUN`      | var    | `30`           | Whole number from 0 to 40. Every write counts 1: create, close, update, move, detach, milestone create or close, label re-add. |
| `DRY_RUN`                 | var    | on             | Only `false` (any case, surrounding whitespace ignored) turns it off.                                                          |

Invalid config fails the run before any request is made, listing every problem at once.
`YOUTRACK_TITLE_PREFIX` (the old `[team]` inclusion filter) is no longer read: if an older
`.env` or `config.env` still sets it, it is ignored and can be removed.

Where the values come from:

- **Worker:** vars in `wrangler.jsonc`, secrets via `wrangler secret put`.
- **Node (`npm run sync`):** the environment, plus `.env` if present. It does **not** read
  `wrangler.jsonc`, so the three required vars must be in `.env` (or the environment).
- **systemd:** `EnvironmentFile=` for vars, `LoadCredential=` for the two tokens (see below).

## Local setup

Requires Node 22.18 or later (it runs the `.ts` sources directly via type stripping).

```bash
npm ci
cp .env.example .env     # then fill in GITHUB_TOKEN and YOUTRACK_TOKEN
```

`.env` must also contain `GITHUB_REPO`, `YOUTRACK_BASE_URL` and `YOUTRACK_PROJECT`, which
`.env.example` already sets. If you have an older `.env` with only the tokens, copy those lines
(and the optional ones) over from `.env.example`; otherwise `npm run sync` stops with a
`ConfigError` naming the missing vars.

Create the `youtrack` label in the mirror repo once, by hand. The script never creates it:

```bash
gh label create youtrack --repo BredaUniversityADSAI/2026-27s1-fai3-adsai-ComfyUI \
  --color 6f42c1 --description "Mirrored from YouTrack (read-only)"
```

The issue types Feature, Bug and Task are defined per organization, so the mirror repo has to
belong to an organization that has them (BredaUniversityADSAI does). Milestones are created by
the tool.

## Commands

| Command                              | What it does                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `npm run check`                      | Type-check (Node and Workers configs), lint, check formatting, and run all tests.                |
| `npm run typecheck`                  | `tsc` against `tsconfig.node.json` and `tsconfig.worker.json`. Bare `tsc` skips `src/worker.ts`. |
| `npm run lint`                       | ESLint with typescript-eslint `strictTypeChecked`.                                               |
| `npm test` / `npm run test:coverage` | `node --test`, optionally with coverage.                                                         |
| `npm run sync`                       | One run with Node, reading `.env`. With `DRY_RUN=true` it only reads and logs the plan.          |
| `npm run dev:worker`                 | `wrangler dev --test-scheduled`, for triggering the Worker locally.                              |
| `npm run gen:youtrack`               | Regenerate `src/generated/youtrack.ts` from `./youtrack-openapi.json` (see below).               |
| `npm run gen:worker-types`           | Regenerate `worker-configuration.d.ts` (`wrangler types`) after editing `wrangler.jsonc`.        |

The tests use a fake `fetch`; they never contact YouTrack or GitHub.

`youtrack-openapi.json` (the instance's OpenAPI spec, about 500 KB) is intentionally not
committed; the generated `src/generated/youtrack.ts` is. To regenerate the types, for example
after a YouTrack upgrade, first place the instance's OpenAPI spec at `./youtrack-openapi.json`.

## Deploying to Cloudflare Workers

The Worker has only a `scheduled()` handler. `workers_dev` and `preview_urls` are off, so it
has no public URL. The cron is `*/10 * * * *` (UTC).

```bash
npx wrangler login
npx wrangler deploy                      # check "DRY_RUN" in wrangler.jsonc first
npx wrangler secret put GITHUB_TOKEN     # prompts for the value
npx wrangler secret put YOUTRACK_TOKEN
npx wrangler tail                        # live logs; add --status error to see failures only
```

- Each `wrangler secret put` creates and deploys a new version right away. Until both secrets
  exist, runs fail at config validation without sending any request.
- A new, changed or removed cron can take up to 15 minutes to propagate. Past Cron Events can
  take up to 30 minutes to show up for a new Worker (Workers & Pages > the Worker > Settings >
  Trigger Events > View events). It keeps the last 100 runs. Workers Logs keeps 3 days on Free.

### Testing the Worker locally

```bash
npm run dev:worker
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*/10+*+*+*+*&format=json"
```

A good run answers `{"outcome":"ok","noRetry":false}`, and the log lines appear in the
`wrangler dev` terminal. Local dev loads `.env` into the Worker's env, where it overrides the
`wrangler.jsonc` vars. So `DRY_RUN=false` in `.env` makes local Worker runs write too. If a
`.dev.vars` file exists, values from `.env` no longer reach the Worker's env. Subrequest limits
are not enforced locally.

### Turning writes on (and off)

1. Review the log of a dry run (`npm run sync`, or `wrangler tail` on the deployed Worker).
2. In `wrangler.jsonc`, set `"DRY_RUN": "false"`.
3. `npx wrangler deploy` (and `npm run gen:worker-types` to keep the generated types in step).

To pause writes, set it back to `"true"` and redeploy. To stop the Worker entirely, set
`"crons": []` and redeploy. Commenting out `crons` does **not** remove the trigger.

## Alternative host: Debian + systemd timer

> **Never run the Worker and the timer at the same time.** Neither holds a lock, so two hosts
> can race and create duplicate `[YT-n]` issues.
>
> - **Worker to timer:** deploy `"crons": []` (ideally with `"DRY_RUN": "true"` in the same
>   deploy, so a late firing only reads). Removing a cron can take up to 15 minutes to reach
>   Cloudflare, so wait at least 15 minutes and check that no new Past Cron Events appear
>   before you enable the timer.
> - **Timer to Worker:** run `sudo systemctl disable --now youtrack-gh.timer` first, then
>   re-add the cron and deploy.

### Node 24

Debian's own `nodejs` is too old (bookworm has 18, trixie has 20; neither can run `.ts`).
Install Node 24 from NodeSource's `nodistro` repo. Type stripping is stable from 24.12.

```bash
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
sudo tee /etc/apt/sources.list.d/nodesource.sources >/dev/null <<'EOF'
Types: deb
URIs: https://deb.nodesource.com/node_24.x/
Suites: nodistro
Components: main
Signed-By: /etc/apt/keyrings/nodesource.gpg
EOF
sudo apt-get update && sudo apt-get install nodejs
node --version   # v24.12 or later
```

NodeSource's docs list Debian up to 12; trixie support is not confirmed (docs/05). The
official nodejs.org tarball unpacked into `/opt` is the alternative (point `run.sh` at it).

### App, config and secrets

The runtime has no dependencies (every package import is type-only), so a copy of the repo in
`/opt/youtrack-gh` is enough; `npm ci` is not needed on the host. `package.json` must come
along (`"type": "module"`).

**Never copy a `.env` or `.dev.vars` there**: on this host the tokens exist only under
`/etc/youtrack-gh`. Use `git clone` (which leaves out the gitignored files), or rsync from a
dev checkout with explicit excludes into a staging directory, then install it as root:

```bash
# on the dev machine
rsync -a --exclude=.env --exclude=.dev.vars --exclude=.wrangler/ --exclude=node_modules/ \
  ./ host:youtrack-gh/
# on the host (--exclude keeps run.sh, below, from being deleted on updates)
sudo rsync -a --delete --exclude=/run.sh youtrack-gh/ /opt/youtrack-gh/
```

Secrets and vars:

```bash
sudo install -d -m 0700 /etc/youtrack-gh
sudo sh -c 'umask 077; cat > /etc/youtrack-gh/github_token'     # paste the token, then Ctrl-D
sudo sh -c 'umask 077; cat > /etc/youtrack-gh/youtrack_token'
```

`/etc/youtrack-gh/config.env` holds the vars, as plain `KEY=value` lines (systemd does not strip
inline comments):

```ini
GITHUB_REPO=BredaUniversityADSAI/2026-27s1-fai3-adsai-ComfyUI
YOUTRACK_BASE_URL=https://youtrack.ai.buas.nl
YOUTRACK_PROJECT=CUI
YOUTRACK_EXCLUDE_PREFIX=[individual]
MAX_WRITES_PER_RUN=30
DRY_RUN=true
```

Environment variables set in a unit are visible to unprivileged clients over D-Bus, so the
tokens do not go there. systemd hands them to the service as files in `$CREDENTIALS_DIRECTORY`,
and a tiny wrapper, `/opt/youtrack-gh/run.sh` (`chmod 755`), turns them into env vars for the
one process. It passes no `--env-file`; there must be no `.env` in `/opt/youtrack-gh` anyway:

```sh
#!/bin/sh
# One sync run with the tokens that systemd's LoadCredential= put in $CREDENTIALS_DIRECTORY.
set -eu
GITHUB_TOKEN="$(cat "$CREDENTIALS_DIRECTORY/github_token")"
YOUTRACK_TOKEN="$(cat "$CREDENTIALS_DIRECTORY/youtrack_token")"
export GITHUB_TOKEN YOUTRACK_TOKEN
exec /usr/bin/node /opt/youtrack-gh/src/node.ts
```

Then make the tree owned by root, readable by the service's dynamic user and writable only by
root (the code there runs with both tokens), and check that no secrets file came along:

```bash
sudo chown -R root:root /opt/youtrack-gh
sudo chmod -R u=rwX,go=rX /opt/youtrack-gh
test ! -e /opt/youtrack-gh/.env && test ! -e /opt/youtrack-gh/.dev.vars && echo "no .env: ok"
```

Repeat these three commands after every update of `/opt/youtrack-gh`.

### Units

`/etc/systemd/system/youtrack-gh.service`:

```ini
[Unit]
Description=YouTrack to GitHub issue mirror (one run)
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
DynamicUser=yes
LoadCredential=github_token:/etc/youtrack-gh/github_token
LoadCredential=youtrack_token:/etc/youtrack-gh/youtrack_token
EnvironmentFile=/etc/youtrack-gh/config.env
WorkingDirectory=/opt/youtrack-gh
ExecStart=/opt/youtrack-gh/run.sh
# Hard backstop only. The code starts no new write later than 8 min after the process
# starts (decision R8), and a write already under way finishes within about 2 min.
TimeoutStartSec=10min
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
```

`/etc/systemd/system/youtrack-gh.timer`:

```ini
[Unit]
Description=Run the YouTrack to GitHub mirror every 10 minutes

[Timer]
OnCalendar=*:0/10
Persistent=true
AccuracySec=1s
RandomizedDelaySec=30s

[Install]
WantedBy=timers.target
```

Leave `RemainAfterExit=` unset: a unit that stayed active would make later ticks do nothing.
The timer never starts a second run while one is still active.

```bash
sudo systemd-analyze verify /etc/systemd/system/youtrack-gh.service /etc/systemd/system/youtrack-gh.timer
sudo systemctl daemon-reload
sudo systemctl start youtrack-gh.service       # one run now, to check config and logs
journalctl -u youtrack-gh.service -e
sudo systemctl enable --now youtrack-gh.timer
systemctl list-timers youtrack-gh.timer
journalctl -u youtrack-gh.service -f           # follow later runs
```

A failed run exits with code 1, so the unit shows as failed in `systemctl status`. To turn
writes on, set `DRY_RUN=false` in `config.env`; the next run picks it up.

## Limits and budget

- **Workers Free:** 50 subrequests per invocation (reads, writes, retries and redirects all
  count), 10 ms CPU (waiting on the network is free), 15 minutes wall time.
- **Fetch guard:** the HTTP client refuses a 46th fetch. When it refuses a write, the run stops
  cleanly and that action and the remaining ones count as `capped`, not `failed`. A write that
  was sent and failed but whose retry the guard cannot pay for counts as `failed`.
- **Today:** 3 reads (1 GitHub issues page, 1 milestones page, 1 YouTrack page) + at most 30
  writes = 33 fetches without retries. Each retry is one more fetch, up to the 45-fetch guard.
  Every further 100 GitHub items (issues and pull requests), 100 milestones or 100 YouTrack
  issues costs one more page. A dry run sends only the reads.
- **Retries:** every GET and every write except a create is retried once on a network error,
  timeout, 5xx, 429, or a 403 that carries `retry-after` (GitHub's secondary rate limit). The
  retry waits `retry-after` when it is 10 s or less, and 2 s when the header is missing or
  unreadable. There is no retry when `retry-after` is over 10 s, or when GitHub's primary rate
  limit (`x-ratelimit-remaining: 0`) comes without a usable `retry-after`. A create (issue or
  milestone) is **never** retried, since a timed-out create may have succeeded; the next run
  acts as the retry. Every request times out after 15 s.
- **GitHub rate limit:** when a write still fails with a rate limit (a 403 or 429 with
  `x-ratelimit-remaining: 0`, with `retry-after`, or whose body names the secondary rate
  limit), it counts as `failed`, the run stops writing, and the remaining actions count as
  `capped` (decision R7). The run still ends as failed.
- **Run deadline:** no new write action starts later than 8 minutes after the run's scheduled
  time (Worker: the cron's `scheduledTime`; Node: process start). The rest counts as `capped`
  and a `run deadline reached` warning is logged. Reads and the dry-run preview are not
  affected. On systemd, `TimeoutStartSec=10min` is the hard backstop.
- **GitHub:** writes are serial and 1 s apart, well within the secondary limit of 80
  content-creating requests per minute. If the token lacks push access, GitHub silently drops
  labels, milestones and types. The label re-add and the title fallback stop that from causing
  duplicates. When GitHub's answer lacks a milestone, type or parent that was sent, a warning
  is logged and the next run's sync tries again (no extra write in the same run). GitHub allows
  100 sub-issues per parent and 8 levels; a create or move beyond that is expected to fail on
  every run (unverified).
- **Swapping two task mirrors** (A under B on GitHub, B under A in YouTrack) can fail one run.
  When B has the lower number, its move under A runs before A leaves B, and GitHub is expected
  to refuse the cycle. A still leaves B in that run (detached, or moved to its new parent), and
  the next run moves B.
- **Blocked epics:** while a milestone create keeps failing, every create and update that
  needs that milestone is `capped` on every run, type changes included.
- **Repeat-safe runs:** each run re-reads both sides before writing, so running again (or a
  Cloudflare retry of a failed run, which is undocumented) does not create duplicates. Two runs
  that overlap could still race; Cloudflare does not document whether cron runs can overlap.

## Docs

Research and design notes live in [`docs/`](docs/README.md):

- [08-decisions.md](docs/08-decisions.md): every decision this behavior follows.
- [09-implementation-plan.md](docs/09-implementation-plan.md): the original plan (implemented),
  with an "As built" section where the code differs.
- [10-hierarchy-design.md](docs/10-hierarchy-design.md) and
  [11-hierarchy-plan.md](docs/11-hierarchy-plan.md): epics, stories, bugs and tasks as
  milestones, issue types and sub-issues (implemented; docs/11 has the "As built" notes).
- [04-cloudflare-workers.md](docs/04-cloudflare-workers.md): Workers limits, cron, secrets, local testing.
- [05-node-debian-systemd.md](docs/05-node-debian-systemd.md): Node versions, Debian packages, systemd.
- [03-github-rest-api.md](docs/03-github-rest-api.md) and
  [02-youtrack-rest-api.md](docs/02-youtrack-rest-api.md): the two APIs.
