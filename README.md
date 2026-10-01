# youtrack-gh

A read-only, one-way mirror from a YouTrack project to GitHub issues. Every 10 minutes it reads
the whole project and keeps a matching issue in a GitHub repo for each YouTrack issue, titled
with its YouTrack ID (`[ABC-12] Fix login`), and a milestone for each epic. It creates a mirror
for every open issue, closes the mirror once the issue is resolved, and keeps each mirror's
title, milestone, issue type and parent in step with YouTrack. It never writes to YouTrack.

You can run it for your own group's YouTrack project and GitHub repo: both are settings of the
host you pick, such as the action's inputs, `wrangler.jsonc` for the Worker or `.env` for local
runs (see [Configuration](#configuration)). Your own files are gitignored copies of committed
examples, so updating to a newer version never touches them.

It is an **interim stopgap** until BUas enables YouTrack's Webhook Triggers app. Once that app
is available, it replaces this tool, and the Worker (or timer) should be removed.

It runs as a Cloudflare Workers cron job (Free plan, every 10 minutes), as a GitHub Action in
your repo, or as a plain Node script on a Debian/systemd host; see
[Choosing a deployment](#choosing-a-deployment). The Node script also does local dry runs.

> [!WARNING]
> **Run only one copy per GitHub repo.** Agree within your group who runs the mirror. A second
> copy (another Worker, a systemd timer, a GitHub Action workflow, or a Node run with
> `DRY_RUN=false`) against the same repo can race the first and create duplicate mirror issues.
> Dry runs are always safe: they only read.

## Contents

- [Features](#features)
- [Using it day to day](#using-it-day-to-day): for everyone in the group
- [Choosing a deployment](#choosing-a-deployment): Worker, systemd timer or GitHub Action
- [Installation](#installation): which steps each deployment needs
- [Troubleshooting](#troubleshooting)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [Development](#development)
- [Alternative host: GitHub Action](#alternative-host-github-action)
- [Alternative host: Debian + systemd timer](#alternative-host-debian--systemd-timer)
- [Limits and budget](#limits-and-budget)
- [Docs](#docs)

## Features

- **One way, read-only on YouTrack:** the only YouTrack call is `GET /api/issues`. GitHub is a
  mirror; the work stays in YouTrack.
- **An issue per YouTrack issue,** titled with its ID (`[ABC-12] Fix login`), with the
  description, a link back to YouTrack and the `youtrack` label. `@mentions` and `#123`
  references in the description are wrapped in backticks, so nobody gets pinged.
- **The hierarchy:** epics become milestones; User Story, Bug and Task become the issue types
  Feature, Bug and Task; tasks become sub-issues of their parent's mirror; every mirror goes in
  its nearest epic's milestone ([Hierarchy](#hierarchy)).
- **Kept in step:** every run syncs each mirror's title, milestone, type and parent, open or
  closed, and each milestone's title. A mirror is closed when its issue is resolved, and with
  `REOPEN_CLOSED_BY` (on in the GitHub Action) reopened when the issue goes back to unresolved,
  if the mirror closed it itself.
- **Leave things out:** an issue whose summary starts with `[individual]` (configurable), and
  everything below it, is never mirrored.
- **Safe by default:** dry run until you turn writes on, at most 30 writes per run, retries for
  network errors, and no duplicates: every run re-reads both sides before it writes.
- **Three ways to run it:** a free Cloudflare Worker, a GitHub Action (writes as
  `github-actions[bot]`), or a systemd timer on your own Debian host.

## Using it day to day

For everyone in the group, once someone has set it up:

- **Work in YouTrack.** Create, edit, nest and resolve issues there. Within about 10 minutes
  GitHub follows: a new mirror, a new title, a new milestone or parent, or a close.
- **Treat mirrors as read-only.** Assign, label, comment and link PRs on GitHub as you like, but
  title edits are undone by the next run. Keep the `[ABC-12]` prefix and the `youtrack` label: a
  mirror without them is no longer recognised and gets a duplicate. The description is copied
  once, at creation; the YouTrack link always has the current one.
- **Resolve in YouTrack, not on GitHub.** Closing a mirror, by hand or with `Closes #12` in a
  PR, does not touch YouTrack. A mirror closed by hand stays closed until someone reopens it.
- **Keep personal work out** by starting its summary with `[individual]`; its tasks stay out
  too. An issue that already has a mirror keeps it as it is, no longer synced.
- **For whoever runs it:** turn writes off and on with `DRY_RUN` (or `dry-run`), start a run
  from the Actions tab or with `systemctl start`, and read the summary line each run logs
  ([What a run does](#what-a-run-does), step 7). [Troubleshooting](#troubleshooting) covers the
  usual errors.

## Choosing a deployment

Three ways to run it exist side by side (decision W4). Pick whichever fits what you can set up
and who you want GitHub to show as the author of the mirror's writes.

|                          | Cloudflare Worker                                                       | systemd timer                                          | GitHub Action                                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Setup**                | Easiest: a free Cloudflare account, no server of your own               | A Debian host you have root on                         | A workflow file on your repo's default branch, and ideally a self-hosted runner (your own, or one your organization shares)                                                           |
| **Writes attributed to** | Your token's account                                                    | Your token's account                                   | `github-actions[bot]` (with the default token)                                                                                                                                        |
| **On-demand run**        | None on the deployed Worker; the cron is its only trigger               | `sudo systemctl start youtrack-gh.service` on the host | `workflow_dispatch`: a **Run workflow** button in the repo's Actions tab, for anyone with write access                                                                                |
| **Ongoing cost**         | Free (Workers Free covers it)                                           | Free (your own hardware)                               | Free on a self-hosted runner, or on any runner in a public repo. In a private repo a GitHub-hosted runner bills your organization's shared Actions minutes, so the action warns there |
| **Best fit**             | The least to maintain, and you don't mind writes coming from your token | You already run a server and want it alongside         | You want writes from a bot identity or a run button, and have a self-hosted runner                                                                                                    |

Pick one per repo; see the warning above.

## Installation

The numbered steps below are shared; which ones you need depends on the deployment:

| Deployment                 | Steps                                                                                                                                                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub Action**          | No clone needed: the YouTrack token from [step 2](#2-create-the-two-tokens), [step 4](#4-prepare-the-github-repo), then [GitHub Action](#alternative-host-github-action). A local dry run first (steps 1, 3, 5) is optional. |
| **Cloudflare Worker**      | Steps 1 to 7.                                                                                                                                                                                                                |
| **Debian + systemd timer** | Steps 1 to 5, then [Debian + systemd timer](#alternative-host-debian--systemd-timer).                                                                                                                                        |

Steps 1 to 5 end in a local dry run, which only reads and is safe to try at any time. Steps 6
and 7 deploy the Worker and turn writes on.

### What you need

- **Node.js 22.18 or later**, with npm. The `.ts` sources run directly (type stripping), so
  there is no build step.
- **A GitHub account with the Write role or higher on the target repo.** Its token does every
  write, so every mirror issue and milestone is created by this account, and GitHub subscribes
  it to each mirror issue. A dedicated account keeps those notifications out of someone's inbox.
  Without push access, GitHub silently drops labels, milestones and issue types. (The
  [GitHub Action](#alternative-host-github-action) writes as `github-actions[bot]` instead; you
  still need a token for local dry runs.)
- **A target repo owned by an organization that has the issue types Feature, Bug and Task.**
  Issue types exist only on organizations (the BredaUniversityADSAI organization has all three).
- **A YouTrack account that can read every issue in the project.** The mirror only sees what
  this account can see.
- **A YouTrack project with a `Type` field.** The values `Epic`, `User Story`, `Bug` and `Task`
  are mapped (see [Hierarchy](#hierarchy)); any other value, or no `Type`, becomes a plain issue.
  Parents come from YouTrack's Subtask links.
- **A Cloudflare account** (the Free plan is enough), only for deploying the Worker. A
  [Debian + systemd host](#alternative-host-debian--systemd-timer) is the alternative.

### 1. Get the code

Clone this repo (or your fork of it) and install the tools:

```bash
git clone <this repo's URL> youtrack-gh
cd youtrack-gh
npm ci
```

`npm ci` installs the development tools only (TypeScript, ESLint, Prettier, Wrangler). The code
itself has no runtime dependencies.

### 2. Create the two tokens

**GitHub:** a classic personal access token with the `repo` scope (decision B12), for the
account above. The GitHub Action uses the job's own token instead, so it needs this one only for
a local dry run.

1. On GitHub, open **Settings > Developer settings > Personal access tokens > Tokens (classic)**
   and choose **Generate new token > Generate new token (classic)**.
2. Give it a note, pick an expiration, tick the `repo` scope and click **Generate token**. Copy
   the token right away.
3. If the organization uses SAML single sign-on, authorize the token for it (**Configure SSO**
   next to the token in the list).

When the token expires, every run fails until you put in a new one (`.env` for local runs,
`wrangler secret put GITHUB_TOKEN` for the Worker).

**YouTrack:** a permanent token for the account above. It does not expire.

1. In YouTrack, click your avatar, then **Profile**, and open the **Account Security** tab.
2. Under **Tokens**, click **New token**. Give it a name and the **YouTrack** scope, then click
   **Create token** and copy it.

The tool only ever calls `GET /api/issues` with it.

### 3. Fill in `.env`

```bash
cp .env.example .env
```

In `.env`:

1. Put the two tokens in `GITHUB_TOKEN` and `YOUTRACK_TOKEN`.
2. Fill in `GITHUB_REPO` with your repo (`owner/repo`) and `YOUTRACK_PROJECT` with your
   project's shortName: the part of its issue IDs before the dash, such as `ABC` for `ABC-12`.
   Both are empty in `.env.example`, so a run stops with a `ConfigError` until you set them.
3. Leave `YOUTRACK_BASE_URL` at `https://youtrack.ai.buas.nl`, the BUas instance, unless your
   project lives elsewhere.
4. Leave `DRY_RUN=true`.

Issues whose summary starts with `[individual]` stay out of the mirror, along with everything
below them. Set `YOUTRACK_EXCLUDE_PREFIX` if your group uses another prefix.
[Configuration](#configuration) lists every setting. `.env` is gitignored: never commit it or
paste it anywhere.

### 4. Prepare the GitHub repo

Create the `youtrack` label once, by hand. The tool never creates labels:

```bash
gh label create youtrack --repo <owner>/<repo> \
  --color 6f42c1 --description "Mirrored from YouTrack (read-only)"
```

Without the GitHub CLI, add it in the repo under **Issues > Labels > New label**. Also check
that the organization has the issue types Feature, Bug and Task (the organization's settings,
under **Issue types**). Milestones are created by the tool.

### 5. Do a dry run

```bash
npm run sync
```

With `DRY_RUN=true` this reads GitHub and YouTrack and logs one `[dry-run] would ...` line per
write it would make, then a summary line. It sends no GitHub write:

```text
[dry-run] would create milestone ABC-40: [ABC-40] Data pipeline
[dry-run] would create ABC-41 with type Feature, milestone ABC-40 (new): [ABC-41] Ingest the data
[dry-run] would create ABC-42 with type Task, milestone ABC-40 (new), parent ABC-41 (new): [ABC-42] Clean the data
[dry-run] would update ABC-15 #21: set title, set type Task: [ABC-15] Write the parser
[dry-run] would close ABC-3 #12
yt-gh-sync ok scanned=40 created=2 closed=1 reopened=0 updated=1 milestonesCreated=1 milestonesClosed=0 skipped=35 capped=0 failed=0 filtered=28 unchanged=7 labelsReAdded=0 fetches=3 dryRun=true
```

Check that `scanned` matches the number of issues in the project, and that the planned writes
are what you expect. The dry run shows exactly what the next real run would do, write cap
included. On a new repo that means one create per open issue and epic that is not excluded, up to
`MAX_WRITES_PER_RUN` (30); the rest show up as `capped` and are created by later runs, 10
minutes apart. If the run fails, see [Troubleshooting](#troubleshooting).

Upgrading from a version that titled mirrors `[YT-<n>]`: the first run renames every mirror and
milestone to `[<PROJECT>-<n>]`, one write each (decisions N1, N2), so it may take a few runs.
Nothing is duplicated.

### 6. Deploy the Worker

The Worker takes its settings from `wrangler.jsonc`, not from `.env`, and its tokens from
Cloudflare secrets.

1. Copy the example config:

   ```bash
   cp wrangler.example.jsonc wrangler.jsonc
   ```

2. In `wrangler.jsonc`, fill in `GITHUB_REPO` and `YOUTRACK_PROJECT` under `vars`, with the same
   values as in your `.env`. Leave `"DRY_RUN": "true"` for now; step 7 turns writes on.
3. Log in, deploy, add the two secrets and watch the logs:

   ```bash
   npx wrangler login                       # opens a browser to log in to Cloudflare
   npx wrangler deploy
   npx wrangler secret put GITHUB_TOKEN     # prompts for the value
   npx wrangler secret put YOUTRACK_TOKEN
   npx wrangler tail                        # live logs; add --status error to see failures only
   ```

The Worker has only a `scheduled()` handler. `workers_dev` and `preview_urls` are off, so it
has no public URL. The cron is `*/10 * * * *` (UTC).

- The Worker is called `youtrack-gh-mirror` (`name` in `wrangler.jsonc`). To run two mirrors
  on one Cloudflare account, give each its own name.
- Each `wrangler secret put` creates and deploys a new version right away. Until both secrets
  exist, runs fail at config validation without sending any request.
- A new, changed or removed cron can take up to 15 minutes to propagate. Past Cron Events can
  take up to 30 minutes to show up for a new Worker (Workers & Pages > the Worker > Settings >
  Trigger Events > View events). It keeps the last 100 runs. Workers Logs keeps 3 days on Free.

### 7. Turn writes on (and off)

1. Review the log of a dry run (`npm run sync`, or `wrangler tail` on the deployed Worker).
2. In `wrangler.jsonc`, set `"DRY_RUN": "false"`.
3. Run `npx wrangler deploy`.

To pause writes, set it back to `"true"` and redeploy. To stop the Worker entirely, set
`"crons": []` and redeploy. Commenting out `crons` does **not** remove the trigger.

## Troubleshooting

| Symptom                                                     | Likely cause                                                                                                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ConfigError: Invalid configuration: ...`                   | A setting is missing or invalid. The message lists every problem. For `npm run sync`, the three required vars must be in `.env`; it does not read `wrangler.jsonc`. |
| GitHub answers 401                                          | The GitHub token is wrong or has expired.                                                                                                                           |
| GitHub answers 403 and mentions SAML                        | The token is not authorized for the organization's single sign-on (step 2).                                                                                         |
| GitHub answers 404 for the repo                             | A private repo answers 404, not 403, when the token is wrong or expired, or its account has no access. Check `GITHUB_REPO` too.                                     |
| YouTrack answers 401 `Invalid token`                        | The YouTrack token is wrong or was revoked.                                                                                                                         |
| YouTrack answers 400 `invalid_query`                        | `YOUTRACK_PROJECT` is not a project the token's account can see.                                                                                                    |
| `scanned` is lower than the number of issues in the project | The token's account cannot see some issues (visibility restrictions).                                                                                               |
| `GitHub dropped ...` warnings, or `label ABC-n #m` lines    | The token's account lacks the Write role, or the organization lacks an issue type. The next run tries again.                                                        |
| `GitHub dropped the title on update` on every run           | GitHub stored another title than the one sent. Each run spends a write on it; please report the YouTrack summary.                                                   |
| Duplicate mirror issues                                     | Two copies are running against one repo, or someone edited a mirror's `[ABC-n]` prefix so it no longer matches.                                                     |
| Nothing in Cron Events or `wrangler tail` after a deploy    | A new cron can take up to 15 minutes to start firing.                                                                                                               |
| Action: 403 `Resource not accessible by integration`        | The workflow lacks `permissions: issues: write`.                                                                                                                    |
| Action: `youtrack-gh on a GitHub-hosted runner` warning     | The job runs on a GitHub-hosted runner, which bills Actions minutes. Use `runs-on: self-hosted` if you can.                                                         |

## How it works

Decision codes such as F1 or R9 refer to [docs/08-decisions.md](docs/08-decisions.md).

### What a run does

1. **Lists every GitHub issue** in the repo (`state=all`, no label filter), dropping pull
   requests. An issue whose title starts with `[<PROJECT>-<n>]` (the project in any case) is the
   mirror of YouTrack issue `n`; so is one with the `[YT-<n>]` of older versions, which the run
   then renames (decision N1). One with the `youtrack` label wins. A title match without the
   label still counts as the mirror, and a warning is logged. If several issues match, the
   lowest number wins (warning). For each mirror it keeps the REST `id`, title, milestone,
   issue type and parent.
2. **Lists every GitHub milestone** (`state=all`). A milestone whose title starts with
   `[<PROJECT>-<n>]` (or `[YT-<n>]`) is the milestone of YouTrack epic `n`. If several match,
   the lowest number wins (warning). Any other milestone counts as hand-made.
3. **Scans the whole YouTrack project** on every run (`GET /api/issues`,
   `project: <YOUTRACK_PROJECT> sort by: {issue id} asc`, 100 per page), including each issue's `Type` field
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
   (decision F2). Every other issue goes on to planning.
5. **Plans**, using the [hierarchy mapping](#hierarchy) below:
   - no mirror (for an epic: no milestone) and unresolved in YouTrack: **create** it. An issue
     is `[<PROJECT>-<n>] <summary>` with the `youtrack` label, and its issue type, milestone and
     (tasks only) parent go in the same request. The body is the description with `@mentions` and
     `#123`-style references wrapped in backticks, plus a link back to YouTrack. A milestone
     gets the same title, the body as its description, and no due date.
   - no mirror and already resolved: nothing (`unchanged`). Issues and epics that are resolved
     before they are ever mirrored never get a mirror (decision R9).
   - every existing mirror, open or closed: **sync** its title, milestone, type and parent with
     YouTrack (an update, a move or a detach). Title, milestone and type go in one update.
   - every existing milestone, open or closed: **rename** it when its epic's title changed
     (decision N2).
   - open mirror or milestone, and resolved in YouTrack: **close** it (issues with
     `state_reason: completed`).
   - closed mirror, unresolved in YouTrack again, and closed by the `REOPEN_CLOSED_BY` login:
     **reopen** it (decision R10). Only the GitHub Action sets that login by default (to
     `github-actions[bot]`), which undoes closes made with the default `GITHUB_TOKEN`: the
     Action's own, and any other workflow's in the repo. A close by any other login stays, and
     milestones are never reopened.
   - anything else: nothing (`unchanged`).
6. **Writes** serially, 1 s apart, in this order: milestone creates, renames and closes; creates of
   everything except tasks; creates of tasks, parents before children; syncs; closes and
   reopens. Within a
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
   create milestone ABC-40 -> #1
   create ABC-41 with type Feature, milestone ABC-40 #1 -> #30
   create ABC-42 with type Task, milestone ABC-40 #1, parent ABC-41 #30 -> #31
   update ABC-15 #21: set title, set type Task
   close ABC-3 #12
   yt-gh-sync ok scanned=40 created=2 closed=1 reopened=0 updated=1 milestonesCreated=1 milestonesClosed=0 skipped=35 capped=0 failed=0 filtered=28 unchanged=7 labelsReAdded=0 fetches=8 dryRun=false
   ```

   The headline counts come first. `updated` counts updates, moves, detaches and milestone
   renames, and `skipped` = `filtered` + `unchanged`. The other write lines look like
   `rename milestone ABC-33 #7`, `close milestone ABC-33 #7`,
   `update ABC-15 #21: set milestone ABC-33 #7`, `update ABC-15 #21: clear milestone`,
   `move ABC-42 #31 under ABC-36 #22`, `detach ABC-42 #31 from parent ABC-41 #30` and
   `label ABC-41 #30` (label re-added).

### Hierarchy

| YouTrack `Type`   | GitHub                                                                | Issue type |
| ----------------- | --------------------------------------------------------------------- | ---------- |
| Epic              | milestone `[<PROJECT>-<n>] <summary>`, no due date                    | -          |
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
  parents and logged as `ABC-<n>: parent chain loops back to ABC-<m>`. The exclude filter still
  follows it: if any issue on a cycle has the exclude prefix, the whole cycle and everything
  below it is excluded.
- **Excluded issues** are never used as a milestone or parent: everything below one is
  excluded too. A mirror that still sits under an excluded issue's mirror, or in an excluded
  epic's milestone, is moved or detached like any other once YouTrack has it elsewhere.
- **Hand-made links stay:** a milestone or parent that is not a mirror is left alone unless
  YouTrack wants a mirrored one there. A type is never cleared, so a mirror whose YouTrack type
  has no mapping keeps whatever type it has on GitHub.

### What it never does

YouTrack is only ever read: the only call is `GET /api/issues`. On GitHub the tool never
reopens a milestone, never reopens an issue that the `REOPEN_CLOSED_BY` login did not close
(and reopens nothing when it is unset, decision R10), never changes a body or milestone
description after creation (titles do follow YouTrack, decision N2), never comments, never
reorders sub-issues, never clears an issue type, never creates labels and never touches pull
requests. Relates links and sprints are not mirrored. A mirror whose YouTrack issue is deleted
is left as it is.

Mirrors are recognised by the project ID in their titles. If a YouTrack admin changes the
project's ID (say `ABC` to `XYZ`), update `YOUTRACK_PROJECT`, and first rename the old
`[ABC-n]` prefixes to `[XYZ-n]` by hand, or every mirror and milestone is created again.

### Failures

A failed read (GitHub issues or milestones, YouTrack scan) logs a `yt-gh-sync failed ...`
summary line and aborts the run. A failed write is logged, the run carries on with the other
writes (unless GitHub rate-limited it), and at the end it logs `yt-gh-sync failed ...` and
throws, so the run shows as failed in Cron Events (or as a failed systemd unit). A write that
waits for a failed create is `capped`, not failed. Tokens are never logged.

### Dry run

Dry run is on by default: only `DRY_RUN=false` turns it off. With it on, the run reads both
sides and logs one `[dry-run] would ...` line per planned write, but sends no GitHub write at
all. The create lines, and the lines that change a title, end with the new title. A milestone or mirror that the run would create
earlier shows as `(new)`. See [step 5](#5-do-a-dry-run) for an example.

## Configuration

| Name                      | Kind   | Default        | Notes                                                                                                                                                                   |
| ------------------------- | ------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`            | secret | required       | Classic PAT with the `repo` scope (decision B12).                                                                                                                       |
| `YOUTRACK_TOKEN`          | secret | required       | YouTrack permanent token.                                                                                                                                               |
| `GITHUB_REPO`             | var    | required       | The mirror repo, as `owner/repo`.                                                                                                                                       |
| `YOUTRACK_BASE_URL`       | var    | required       | https URL without query string, fragment or credentials. For BUas: `https://youtrack.ai.buas.nl`.                                                                       |
| `YOUTRACK_PROJECT`        | var    | required       | Project shortName (the prefix of its issue IDs), starting with a letter or digit.                                                                                       |
| `YOUTRACK_EXCLUDE_PREFIX` | var    | `[individual]` | Case-insensitive summary prefix that keeps an issue or epic, and everything below it, out of the mirror. Not blank when set.                                            |
| `MAX_WRITES_PER_RUN`      | var    | `30`           | Whole number from 0 to 40. Every write counts 1: create, close, reopen, update, move, detach, milestone create, rename or close, label re-add.                          |
| `DRY_RUN`                 | var    | on             | Only `false` (any case, surrounding whitespace ignored) turns it off.                                                                                                   |
| `REOPEN_CLOSED_BY`        | var    | empty (off)    | A GitHub login, such as `github-actions[bot]`: a closed mirror it closed is reopened once its YouTrack issue is unresolved (R10). Leave it empty with a personal token. |

Invalid config fails the run before any request is made, listing every problem at once.
Variables the tool does not know, such as the retired `YOUTRACK_TITLE_PREFIX`, are ignored.

Where the values come from:

- **Worker:** vars in `wrangler.jsonc` (your gitignored copy of `wrangler.example.jsonc`),
  secrets via `wrangler secret put`.
- **Node (`npm run sync`):** the environment, plus `.env` if present. It does **not** read
  `wrangler.jsonc`, so the three required vars must be in `.env` (or the environment).
- **systemd:** `EnvironmentFile=` for vars, `LoadCredential=` for the two tokens (see
  [below](#app-config-and-secrets)).
- **GitHub Action:** the action's inputs, one per setting (see
  [GitHub Action](#alternative-host-github-action)).

## Development

| Command                              | What it does                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `npm run check`                      | Type-check (Node and Workers configs), lint, check formatting, and run all tests.                |
| `npm run typecheck`                  | `tsc` against `tsconfig.node.json` and `tsconfig.worker.json`. Bare `tsc` skips `src/worker.ts`. |
| `npm run lint`                       | ESLint with typescript-eslint `strictTypeChecked`.                                               |
| `npm run format`                     | Prettier over the whole repo.                                                                    |
| `npm test` / `npm run test:coverage` | `node --test`, optionally with coverage.                                                         |
| `npm run sync`                       | One run with Node, reading `.env`. With `DRY_RUN=true` it only reads and logs the plan.          |
| `npm run dev:worker`                 | `wrangler dev --test-scheduled`, for triggering the Worker locally.                              |
| `npm run gen:youtrack`               | Regenerate `src/generated/youtrack.ts` from `./youtrack-openapi.json` (see below).               |
| `npm run gen:worker-types`           | Regenerate `worker-configuration.d.ts` from `wrangler.example.jsonc` and `.env.example`.         |

Changes reach `main` through pull requests, and every merge can make a release; see
[CONTRIBUTING.md](CONTRIBUTING.md). Run `npm run check` before committing. The tests use a fake `fetch`; they never contact YouTrack
or GitHub. [CLAUDE.md](CLAUDE.md) describes the source layout and the conventions.

The generated `worker-configuration.d.ts` is committed. `npm run gen:worker-types` builds it from
the two example files, not from your own `wrangler.jsonc` and `.env`, so it is the same for
everyone. Run it after adding a setting or a binding to `wrangler.example.jsonc` or after
upgrading Wrangler. Changing a value in your own `wrangler.jsonc` needs no regeneration.

`youtrack-openapi.json` (the instance's OpenAPI spec, about 500 KB) is intentionally not
committed; the generated `src/generated/youtrack.ts` is. To regenerate the types, for example
after a YouTrack upgrade, first place the instance's OpenAPI spec at `./youtrack-openapi.json`.

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

## Alternative host: GitHub Action

`action.yml` makes this repo a composite action (decisions W1-W4): it sets up Node 24 on the
job's runner and runs `src/node.ts`, the same entrypoint as `npm run sync`, with its inputs as
the settings. With the default token, GitHub shows every write as `github-actions[bot]`, and
anyone with write access can start a run from the repo's Actions tab.

> [!IMPORTANT]
> **On a private repo, use a self-hosted runner if you can** (`runs-on: self-hosted`). There,
> every run on a GitHub-hosted runner bills your organization's Actions minutes, rounded up to
> a whole minute: about 4,300 minutes a month at every 10 minutes, from a pool other repos
> share. The action still runs, but logs a warning (decision W3). On a public repo
> GitHub-hosted runners are free, and GitHub advises against self-hosted runners for public
> repos, so use `runs-on: ubuntu-latest` there.

Switching from the Worker or the timer: turn that one off first and wait until it has stopped
(see [below](#alternative-host-debian--systemd-timer) for how), then enable the workflow.

### Workflow

Add this as `.github/workflows/youtrack-mirror.yml` on the target repo's **default branch**
(GitHub runs scheduled workflows only from there), through whatever pull request rules the repo
has. Fill in the action's commit SHA, your YouTrack URL and your project:

```yaml
name: YouTrack mirror

on:
  schedule:
    - cron: "*/10 * * * *"
  workflow_dispatch:

permissions: {}

# One run at a time, whatever triggered it: two runs creating at once can duplicate a mirror.
concurrency:
  group: youtrack-mirror
  cancel-in-progress: false

jobs:
  sync:
    name: Sync YouTrack to GitHub issues
    runs-on: self-hosted
    timeout-minutes: 10
    permissions:
      issues: write # create, update and close mirror issues, milestones and sub-issue links
    steps:
      - uses: OWNER/youtrack-github-sync@<full-commit-sha> # v0.1.0
        with:
          youtrack-token: ${{ secrets.YOUTRACK_TOKEN }}
          youtrack-base-url: https://youtrack.ai.buas.nl
          youtrack-project: ABC
          dry-run: "true"
```

Then:

1. Add the YouTrack token (setup [step 2](#2-create-the-two-tokens)) as a secret named
   `YOUTRACK_TOKEN`: in the repo, **Settings > Secrets and variables > Actions > New repository
   secret**. To keep it out of workflows on other branches, store it as an environment secret
   instead (an environment limited to the default branch) and add `environment: <its name>`
   to the `sync` job; each run then shows as a deployment to it.
2. Do setup [step 4](#4-prepare-the-github-repo) (the label and the issue types).
3. Start a run from **Actions > YouTrack mirror > Run workflow**. With `dry-run: "true"` it only
   reads; check its log as in setup [step 5](#5-do-a-dry-run).
4. Set `dry-run: "false"`. For the first live run, consider `max-writes-per-run: "1"` and check
   that the issue type and milestone stuck: GitHub's docs don't say whether `GITHUB_TOKEN` may set
   issue types, and if it may not, the log says `GitHub dropped type ...`.

| Input                     | Setting                   | Default                                     |
| ------------------------- | ------------------------- | ------------------------------------------- |
| `youtrack-token`          | `YOUTRACK_TOKEN`          | required                                    |
| `youtrack-base-url`       | `YOUTRACK_BASE_URL`       | required                                    |
| `youtrack-project`        | `YOUTRACK_PROJECT`        | required                                    |
| `github-token`            | `GITHUB_TOKEN`            | the job's own token (`${{ github.token }}`) |
| `github-repo`             | `GITHUB_REPO`             | the repo running the workflow               |
| `youtrack-exclude-prefix` | `YOUTRACK_EXCLUDE_PREFIX` | `[individual]`                              |
| `max-writes-per-run`      | `MAX_WRITES_PER_RUN`      | `30`                                        |
| `dry-run`                 | `DRY_RUN`                 | `true`: only `false` writes                 |
| `reopen-closed-by`        | `REOPEN_CLOSED_BY`        | `github-actions[bot]`; empty: never reopen  |

- **Permissions:** the workflow's `permissions:` block decides what the default token may do;
  the action cannot raise it. `issues: write` covers issues, labels, milestones and sub-issues.
  With a personal access token in `github-token` (from a secret) instead, writes come from that
  token's account, as with the Worker; then also set `reopen-closed-by: ""`.
- **Reopening:** a mirror this action closed is reopened when its YouTrack issue goes back to
  unresolved (decision R10); one a person closed stays closed. Closes by another workflow in
  the repo that uses `GITHUB_TOKEN` also show as `github-actions[bot]`, so those mirrors are
  reopened too while their YouTrack issue is open.
- **Empty inputs:** an input set to an empty string, such as an unset `${{ vars.X }}`, is a
  config error, not "use the default" (except `reopen-closed-by`, where empty means off). Leave
  an input out to get its default.
- **No zizmor findings:** the action pins `actions/setup-node` by commit SHA and passes inputs to
  its script only through env.
- **Runner:** Linux or macOS (the steps use `shell: bash`; Windows only with Git Bash). It must
  reach your YouTrack and `api.github.com`. `actions/setup-node` downloads Node 24 unless the
  runner has it cached.
- **Runs and failures:** the `concurrency` group keeps one run at a time (pending runs wait).
  The 8-minute run deadline (decision R8) counts from the start of the sync step, and
  `timeout-minutes: 10` is the hard backstop. A failed sync fails the job; for scheduled runs
  GitHub emails whoever last changed the cron line.

### Versions and updates

Releases are SemVer tags (`v0.1.0`, `v0.2.0`, ...) with notes on the repo's Releases page
(decisions V1-V3; [CONTRIBUTING.md](CONTRIBUTING.md) has how they are made). Pin `uses:` to the
full commit SHA of a release, with its tag as a comment, so nothing changes in your repo until
you update the pin:

```yaml
- uses: OWNER/youtrack-github-sync@<commit SHA of the v0.1.0 tag> # v0.1.0
```

`git ls-remote https://github.com/OWNER/youtrack-github-sync refs/tags/v0.1.0` prints that SHA.
Dependabot then proposes new releases as PRs that update both the SHA and the comment, with the
release notes in the PR. Your repo needs a `github-actions` entry in `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

While the version is 0.x, a minor bump (0.1 to 0.2) can contain breaking changes: read the
release notes before merging one. Patch bumps (0.1.0 to 0.1.1) are fixes and updated pins of
the actions it uses.

## Alternative host: Debian + systemd timer

> **Never run the Worker and the timer at the same time.** Neither holds a lock, so two hosts
> can race and create duplicate mirror issues. The same goes for the GitHub Action.
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
GITHUB_REPO=<owner>/<repo>
YOUTRACK_BASE_URL=https://youtrack.ai.buas.nl
YOUTRACK_PROJECT=<PROJECT>
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
