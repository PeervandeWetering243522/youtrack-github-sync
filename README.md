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
2. **Scans the whole YouTrack project** on every run (`GET /api/issues`,
   `project: CUI sort by: {issue id} asc`, 100 per page). There is no lookback window.
3. **Filters** to issues whose summary starts with `YOUTRACK_TITLE_PREFIX` (default `[team]`,
   case-insensitive). Everything else counts as `filtered`.
4. **Plans**, oldest first (ascending issue number):
   - no mirror: **create** `[YT-<n>] <summary>` with the `youtrack` label. The body is the
     description with `@mentions` and `#123`-style references wrapped in backticks, plus a link
     back to YouTrack. If the YouTrack issue is resolved, the new mirror is **closed** right away.
   - open mirror and the YouTrack issue is resolved: **close** it (`state_reason: completed`).
   - anything else: nothing. Mirrors are **never reopened, retitled, edited or commented on**.
5. **Writes** serially, 1 s apart, at most `MAX_WRITES_PER_RUN` per run. Whatever does not
   fit is `capped` and picked up by the next run. If GitHub drops the label on create, it is
   re-added once (this counts as a write).
6. **Logs one line per write and one summary line**, for example:

   ```text
   create YT-5 -> #41
   close YT-3 #12
   yt-gh-sync ok dryRun=false scanned=29 filtered=19 unchanged=4 created=5 closed=3 labelsReAdded=0 capped=0 failed=0 fetches=10
   ```

YouTrack is only ever read: the only call is `GET /api/issues`.

**Failures.** A failed read (GitHub list, YouTrack scan) aborts the run. A failed write is
logged, the run carries on with the other writes, and at the end it throws, so the run shows as
failed in Cron Events (or as a failed systemd unit). Tokens are never logged.

**Dry run is on by default.** With `DRY_RUN` on, the run reads both sides and logs
`[dry-run] would create ...` / `[dry-run] would close ...` lines, but sends no GitHub write at all.

## Configuration

| Name | Kind | Default | Notes |
|---|---|---|---|
| `GITHUB_TOKEN` | secret | required | Classic PAT with the `repo` scope (decision B12). |
| `YOUTRACK_TOKEN` | secret | required | YouTrack permanent token. |
| `GITHUB_REPO` | var | required | `owner/repo`. `wrangler.jsonc` sets `BredaUniversityADSAI/2026-27s1-fai3-adsai-ComfyUI`. |
| `YOUTRACK_BASE_URL` | var | required | https URL, no query string. `wrangler.jsonc` sets `https://youtrack.ai.buas.nl`. |
| `YOUTRACK_PROJECT` | var | required | Project shortName. `wrangler.jsonc` sets `CUI`. |
| `YOUTRACK_TITLE_PREFIX` | var | `[team]` | Case-insensitive summary prefix that marks an issue for mirroring. |
| `MAX_WRITES_PER_RUN` | var | `30` | Whole number from 0 to 40. Create+close = 2 writes, a label re-add = 1. |
| `DRY_RUN` | var | on | Only the exact value `false` (any case) turns it off. |

Invalid config fails the run before any request is made, listing every problem at once.

Where the values come from:

- **Worker:** vars in `wrangler.jsonc`, secrets via `wrangler secret put`.
- **Node (`npm run sync`):** the environment, plus `.env` if present. Start from `.env.example`.
- **systemd:** `EnvironmentFile=` for vars, `LoadCredential=` for the two tokens (see below).

## Local setup

Requires Node 22.18 or later (it runs the `.ts` sources directly via type stripping).

```bash
npm ci
cp .env.example .env     # then fill in GITHUB_TOKEN and YOUTRACK_TOKEN
```

Create the `youtrack` label once, by hand. The script never creates it:

```bash
gh label create youtrack --color 6f42c1 --description "Mirrored from YouTrack (read-only)"
```

## Commands

| Command | What it does |
|---|---|
| `npm run check` | Type-check (Node and Workers configs), lint, and run all tests. |
| `npm run typecheck` | `tsc` against `tsconfig.node.json` and `tsconfig.worker.json`. |
| `npm run lint` | ESLint with typescript-eslint `strictTypeChecked`. |
| `npm test` / `npm run test:coverage` | `node --test`, optionally with coverage. |
| `npm run sync` | One run with Node, reading `.env`. With `DRY_RUN=true` it only reads and logs the plan. |
| `npm run dev:worker` | `wrangler dev --test-scheduled`, for triggering the Worker locally. |
| `npm run gen:youtrack` | Regenerate `src/generated/youtrack.ts` from `youtrack-openapi.json`. |
| `npm run gen:worker-types` | Regenerate `worker-configuration.d.ts` (`wrangler types`) after editing `wrangler.jsonc`. |

The tests use a fake `fetch`; they never contact YouTrack or GitHub.

## Deploying to Cloudflare Workers

The Worker has only a `scheduled()` handler. `workers_dev` and `preview_urls` are off, so it
has no public URL. The cron is `*/10 * * * *` (UTC).

```bash
npx wrangler login
npx wrangler deploy                      # DRY_RUN is "true" in wrangler.jsonc
npx wrangler secret put GITHUB_TOKEN     # prompts for the value
npx wrangler secret put YOUTRACK_TOKEN
npx wrangler tail                        # live logs; add --status error to see failures only
```

- Each `wrangler secret put` creates and deploys a new version right away. Until both secrets
  exist, runs fail at config validation without sending any request.
- A new or changed cron can take up to 15 minutes to propagate. Past Cron Events can take up to
  30 minutes to show up for a new Worker (Workers & Pages > the Worker > Settings >
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
> can race and create duplicate `[YT-n]` issues. Disable the Worker's cron (`"crons": []`,
> redeploy) before enabling the timer, and the other way round.

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

The runtime has no dependencies (every package import is type-only), so copying the repo to
`/opt/youtrack-gh` (with `git clone`, `rsync`, ...) is enough; `npm ci` is not needed on the
host. `package.json` must come along (`"type": "module"`). Files there must be world-readable,
because the service runs as a dynamic user.

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
YOUTRACK_TITLE_PREFIX=[team]
MAX_WRITES_PER_RUN=30
DRY_RUN=true
```

Environment variables set in a unit are visible to unprivileged clients over D-Bus, so the
tokens do not go there. systemd hands them to the service as files in `$CREDENTIALS_DIRECTORY`,
and a tiny wrapper, `/opt/youtrack-gh/run.sh` (`chmod 755`), turns them into env vars for the
one process. It passes no `--env-file`, so a `.env` on the host is never read:

```sh
#!/bin/sh
# One sync run with the tokens that systemd's LoadCredential= put in $CREDENTIALS_DIRECTORY.
set -eu
GITHUB_TOKEN="$(cat "$CREDENTIALS_DIRECTORY/github_token")"
YOUTRACK_TOKEN="$(cat "$CREDENTIALS_DIRECTORY/youtrack_token")"
export GITHUB_TOKEN YOUTRACK_TOKEN
exec /usr/bin/node /opt/youtrack-gh/src/node.ts
```

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
# A oneshot has no start timeout by default, and a hung run would block every later tick.
TimeoutStartSec=5min
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
- **Fetch guard:** the HTTP client refuses a 46th fetch. When the guard is reached, the run
  stops cleanly and the remaining actions count as `capped`, not `failed`.
- **Today:** 1 GitHub page + 1 YouTrack page + at most 30 writes = 32 fetches at most. Every
  further 100 GitHub items (issues and pull requests) or 100 YouTrack issues costs one more page.
- **Retries:** every GET, close and label re-add is retried once on a network error, timeout,
  5xx or 429 (after 2 s, or `retry-after` if that is 10 s or less). A create is **never**
  retried, since a timed-out create may have succeeded; the next run acts as the retry. Every
  request times out after 15 s.
- **GitHub:** writes are serial and 1 s apart, well within the secondary limit of 80
  content-creating requests per minute. If the token lacks push access, GitHub silently drops
  labels on create. The label re-add and the title fallback stop that from causing duplicates.
- **Repeat-safe runs:** each run re-reads both sides before writing, so running again (or a
  Cloudflare retry of a failed run, which is undocumented) does not create duplicates. Two runs
  that overlap could still race; Cloudflare does not document whether cron runs can overlap.

## Docs

Research and design notes live in [`docs/`](docs/README.md):

- [08-decisions.md](docs/08-decisions.md): every decision this behavior follows.
- [09-implementation-plan.md](docs/09-implementation-plan.md): the plan.
- [04-cloudflare-workers.md](docs/04-cloudflare-workers.md): Workers limits, cron, secrets, local testing.
- [05-node-debian-systemd.md](docs/05-node-debian-systemd.md): Node versions, Debian packages, systemd.
- [03-github-rest-api.md](docs/03-github-rest-api.md) and
  [02-youtrack-rest-api.md](docs/02-youtrack-rest-api.md): the two APIs.
