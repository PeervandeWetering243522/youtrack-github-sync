# youtrack-gh

A read-only, one-way mirror from a YouTrack project to GitHub issues. Every 10 minutes it reads
the whole project and keeps a matching issue in a GitHub repo for each YouTrack issue, titled
with its YouTrack ID (`[ABC-12] Fix login`), and a milestone for each epic. It creates a mirror
for every open issue, closes the mirror once the issue is resolved, keeps each mirror's title,
milestone, issue type and parent in step with YouTrack, and assigns each open mirror to the
GitHub accounts of its YouTrack assignees. It never writes to YouTrack.

You can run it for your own group's YouTrack project and GitHub repo: both are settings of the
host you pick, such as the action's inputs, `wrangler.jsonc` for the Worker or `.env` for local
runs (see [Configuration](#configuration)). Your own files are gitignored copies of committed
examples, so updating to a newer version never touches them.

It is an **interim stopgap** until BUas enables YouTrack's Webhook Triggers app. Once that app
is available, it replaces this tool, and the Worker (or timer) should be removed.

The recommended way to run it is the **GitHub Action**: one workflow file in your repo, no other
account or server ([Installation](#installation)). It can also run as a Cloudflare Workers cron
job or as a systemd timer on a Debian host ([Other ways to run it](#other-ways-to-run-it)).

> [!WARNING]
> **Run only one copy per GitHub repo.** Agree within your group who runs the mirror. A second
> copy (another Worker, a systemd timer, a GitHub Action workflow, or a Node run with
> `DRY_RUN=false`) against the same repo can race the first and create duplicate mirror issues.
> Dry runs are always safe: they only read.

## Contents

- [Features](#features)
- [Using it day to day](#using-it-day-to-day): for everyone in the group
- [Assignees](#assignees): how YouTrack assignees become GitHub assignees
- [Installation](#installation): the GitHub Action, in five steps
- [Other ways to run it](#other-ways-to-run-it): a Cloudflare Worker or a systemd timer
  - [Alternative host: Cloudflare Worker](#alternative-host-cloudflare-worker)
  - [Alternative host: Debian + systemd timer](#alternative-host-debian--systemd-timer)
- [Troubleshooting](#troubleshooting)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [Development](#development)
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
- **Assignees:** each open mirror is assigned to the GitHub accounts of its YouTrack issue's
  assignees, found by the student ID in their usernames, their BUas email, their commits, their
  public email or a manual map ([Assignees](#assignees)). It only adds and removes accounts it
  matches to someone assigned in the YouTrack project; staff, bots and anyone it cannot match
  are never touched. `SYNC_ASSIGNEES=false` turns it off.
- **Leave things out:** an issue whose summary starts with `[individual]` (configurable), and
  everything below it, is never mirrored.
- **Safe by default:** dry run until you turn writes on, at most 30 writes per run, retries for
  network errors, and no duplicates: every run re-reads both sides before it writes.
- **Three ways to run it:** a GitHub Action in your repo (recommended; writes as
  `github-actions[bot]`), a free Cloudflare Worker, or a systemd timer on your own Debian host.

## Using it day to day

For everyone in the group, once someone has set it up:

- **Work in YouTrack.** Create, edit, nest and resolve issues there. Within about 10 minutes
  GitHub follows: a new mirror, a new title, a new milestone or parent, or a close.
- **Treat mirrors as read-only.** Label, comment and link PRs on GitHub as you like, but title
  edits are undone by the next run. Keep the `[ABC-12]` prefix and the `youtrack` label: a
  mirror without them is no longer recognised and gets a duplicate. The description is copied
  once, at creation; the YouTrack link always has the current one.
- **Assign in YouTrack, not on GitHub.** Within about 10 minutes the open mirror is assigned to
  the GitHub account of each YouTrack assignee the tool can match
  ([how people are matched](#how-people-are-matched)). Those accounts belong to the mirror:
  when YouTrack gives the issue to someone else it matches, the new person is added and the old
  one removed, even if they were assigned on GitHub by hand. Staff, bots and anyone the tool
  cannot match can be assigned on GitHub as you like; it never touches them. Unassigning in
  YouTrack changes nothing on GitHub, and closed mirrors keep their assignees. GitHub emails
  whoever it assigns and subscribes them to the issue.
- **Resolve in YouTrack, not on GitHub.** Closing a mirror, by hand or with `Closes #12` in a
  PR, does not touch YouTrack. A mirror closed by hand stays closed until someone reopens it.
- **Keep personal work out** by starting its summary with `[individual]`; its tasks stay out
  too. An issue that already has a mirror keeps it as it is, no longer synced.
- **For whoever runs it:** turn writes off and on with `DRY_RUN` (or `dry-run`), start a run
  from the Actions tab or with `systemctl start`, and read the summary line each run logs
  ([What a run does](#what-a-run-does), step 8). [Troubleshooting](#troubleshooting) covers the
  usual errors.

## Assignees

Each open mirror gets the GitHub accounts of its YouTrack issue's assignees (decisions U1-U17 in
[docs/08-decisions.md](docs/08-decisions.md)). YouTrack knows nobody's GitHub username, so the
tool has to find each person's account. It is on by default; `SYNC_ASSIGNEES=false` (input
`sync-assignees: "false"`) turns it off, and the run then sends the same requests as v0.x did.

### How people are matched

For students: any one of these is enough for the mirror to find your GitHub account. Only
accounts that can be assigned in the repo count (its collaborators, and organization members
with access to it).

1. **Your student ID in your username.** Your YouTrack username carries your 6-digit student ID
   (`jdoe123456`), and your GitHub username carries the same ID (`JaneDoe123456`). This needs no
   request and works on every run, so it is the easiest way.
2. **Your BUas email.** If your YouTrack username has no ID, but your YouTrack email is your
   BUas address (`123456@buas.nl`), the ID is read from there and matched the same way.
3. **Your commit email.** Add your YouTrack email, or `<student ID>@buas.nl`, to your GitHub
   account (**Settings > Emails**) and push a commit with it to the repo's default branch. The
   mirror asks GitHub who authored commits with that email.
4. **Your public email.** Show one of those emails publicly on your GitHub profile. The mirror
   finds it through GitHub's user search.
5. **The map.** If none of these works, ask whoever runs the mirror to add you to
   `ASSIGNEE_MAP` ([The map](#the-map)). A map entry is checked before everything else, so it
   also fixes a wrong match or keeps someone from ever being assigned.

The commit and email lookups (3 and 4) cost a GitHub request per email, so a run sends at most
5 of them, rotating every 10 minutes among the people who need them. Someone found only that way
is matched on the runs that look them up, and left as they are on the others. When one way finds
two accounts (two usernames with your ID, say), the later ways may only pick one of those two;
otherwise you count as ambiguous and are not assigned. Every run that leaves someone out logs
one warning that names an issue of theirs, never the person, such as
`assignees: 1 unmatched (ABC-18)`.

### What the mirror changes

- **Only open mirrors** of unresolved issues that are not excluded, including mirrors it creates
  in the same run. Never a closed mirror (one it reopens gets its assignees on the next run), an
  epic's milestone or a pull request.
- **Only the accounts it matches** (decision U4). The mirror adds and removes only GitHub
  accounts it matches to someone assigned to an issue anywhere in the YouTrack project. It adds
  each matched assignee a mirror lacks, and removes a matched account that YouTrack does not
  assign to that issue, whoever put it there. Staff, bots and anyone it cannot match are never
  touched. Someone assigned only to issues that are no longer synced (resolved issues, closed
  mirrors, epics) still counts when the map or their student ID matches them, so a student who
  left is removed from the issues YouTrack gave to others. Someone YouTrack names on no issue
  at all is never touched: remove them by hand.
- **Unassigned is left alone** (decision U6). An issue that is unassigned in YouTrack, or
  assigned only to people it cannot match, keeps its GitHub assignees. So a matched assignee
  stays until YouTrack names another matched one.
- **Its own writes** (decision U5): adding and removing are separate requests, run after every
  other write, at most one add and one remove per mirror (the add first). They never go in a
  create or an update. GitHub allows 10 assignees per issue; more are left out with a warning.
- **Notifications:** GitHub emails each person it assigns and subscribes them to the issue, so
  later closes notify them too. With a personal token (Worker, systemd), assigning also starts
  `issues: assigned` workflows in the repo.

### The map

`ASSIGNEE_MAP` (input `assignee-map`) holds `<youtrack-username>=<github-username>` pairs,
separated by commas, on one line:

```text
jdoe123456=JaneDoe123456,staffuser=-
```

- The YouTrack username is compared ignoring case, and may appear only once. The GitHub
  username must be one of the repo's assignable users; otherwise the person is listed as
  `mapped to a login that cannot be assigned` and nothing else is tried for them.
- `-` means never assign that person.
- Keep it on one line: systemd's `EnvironmentFile=` and GitHub's masking of secrets both need
  that. A mistake fails the run with a `ConfigError` that names the entry's position, never its
  text, even with assignee sync off.
- It holds personal data, so keep it in a secret, never in a committed file or a repo variable:
  a repository secret `ASSIGNEE_MAP` for the Action (added like `YOUTRACK_TOKEN` in
  [step 1](#1-create-a-youtrack-token)), `npx wrangler secret put ASSIGNEE_MAP` for the Worker,
  `.env` for local runs and `config.env` on systemd.

### Privacy

Log lines and warnings name issues and counts only, never a username or an email (decision
U8). With assignee sync on, every username and email the run has seen (of 3 characters or more)
is replaced with `[person]` in every later line, including error bodies that GitHub sends back.
The commit and email lookups send emails to GitHub, the email lookup to its user search. On the
Worker, keep `"redact_query_string": true` in `wrangler.jsonc` (the example has it), so those
emails stay out of Workers Logs and traces.

## Installation

The recommended way is the GitHub Action (decisions W1-W4): a scheduled workflow in your repo runs
the sync with the job's own token, so GitHub shows every write as `github-actions[bot]`, and anyone
with write access can start a run from the Actions tab. Nothing to clone, host or deploy.

> [!TIP]
> **If you have the resources, a self-hosted runner is preferred.** In a private repo every run
> on a GitHub-hosted runner uses your organization's Actions minutes; see
> [Runners and Actions minutes](#runners-and-actions-minutes).

### What you need

- **A target repo owned by an organization that has the issue types Feature, Bug and Task**
  (the BredaUniversityADSAI organization has all three), and a way to get a workflow file onto
  its default branch, through whatever pull request rules it has. GitHub runs scheduled
  workflows only from the default branch.
- **A YouTrack account that can read every issue in the project.** The mirror only sees what
  this account can see.
- **A YouTrack project with a `Type` field.** The values `Epic`, `User Story`, `Bug` and `Task`
  are mapped (see [Hierarchy](#hierarchy)); any other value, or no `Type`, becomes a plain issue.
  Parents come from YouTrack's Subtask links.
- **For assignees:** a user field named `Assignee` in the project (single or multiple users),
  and a YouTrack account that may see other users' usernames (the Read User Basic permission).
  Without it, usernames come back anonymized and nobody is matched; the run warns. Not needed
  with `sync-assignees: "false"`.
- **Optional:** a [self-hosted runner](#runners-and-actions-minutes).

If a Worker or a timer already mirrors into this repo, turn it off first and wait until it has
stopped ([how](#alternative-host-debian--systemd-timer)): only one copy may run per repo.

### 1. Create a YouTrack token

1. In YouTrack, click your avatar, then **Profile**, and open the **Account Security** tab.
2. Under **Tokens**, click **New token**. Give it a name and the **YouTrack** scope, then click
   **Create token** and copy it. It does not expire, and the tool only ever calls
   `GET /api/issues` with it.
3. In the GitHub repo, open **Settings > Secrets and variables > Actions > New repository
   secret**, name it `YOUTRACK_TOKEN` and paste the token.

To keep the secret out of workflows on other branches, store it as an environment secret
instead (an environment limited to the default branch) and add `environment: <its name>` to the
`sync` job in step 3; each run then shows as a deployment to it.

### 2. Prepare the GitHub repo

Create the `youtrack` label once, by hand. The tool never creates labels:

```bash
gh label create youtrack --repo <owner>/<repo> \
  --color 6f42c1 --description "Mirrored from YouTrack (read-only)"
```

Without the GitHub CLI, add it in the repo under **Issues > Labels > New label**. Also check
that the organization has the issue types Feature, Bug and Task (the organization's settings,
under **Issue types**). Milestones are created by the tool.

### 3. Add the workflow

Save this as `.github/workflows/youtrack-mirror.yml`. Change `youtrack-project` to your project's
ID, and `youtrack-base-url` if your project is not on the BUas YouTrack:

```yaml
name: YouTrack mirror

on:
  schedule:
    - cron: "*/10 * * * *" # every 10 minutes (UTC)
  workflow_dispatch: # the "Run workflow" button

permissions: {}

# One run at a time, whatever triggered it: two runs creating at once can duplicate a mirror.
concurrency:
  group: youtrack-mirror
  cancel-in-progress: false

jobs:
  sync:
    name: Sync YouTrack to GitHub issues
    runs-on: ubuntu-latest # or self-hosted: see "Runners and Actions minutes"
    timeout-minutes: 10
    permissions:
      issues: write # create, update and close mirror issues, milestones, sub-issue links and assignees
      contents: read # find assignees by the email of their commits (see "Assignees")
    steps:
      - uses: PeervandeWetering243522/youtrack-github-sync@8a2a592137ed4c678bc1baffe98964561b32c4a0 # v0.1.0
        with:
          youtrack-token: ${{ secrets.YOUTRACK_TOKEN }}
          youtrack-base-url: https://youtrack.ai.buas.nl # your YouTrack
          youtrack-project: ABC # your project's ID: ABC for issues like ABC-12
          assignee-map: ${{ secrets.ASSIGNEE_MAP }} # optional; an unset secret means no map
          dry-run: "true" # step 5 turns writes on
```

Assignee sync and the `assignee-map` input come with v1.0.0: pin that release or a later one,
copying the `uses:` line from the end of its release notes ([Versions and updates](#versions-and-updates)).

### 4. Do a dry run

Once the workflow is on the default branch, start a run from **Actions > YouTrack mirror > Run
workflow**. With `dry-run: "true"` it reads GitHub and YouTrack and logs one `[dry-run] would
...` line per write it would make, then a summary line. It sends no GitHub write:

```text
assignees: 1 unmatched (ABC-18)
[dry-run] would create milestone ABC-40: [ABC-40] Data pipeline
[dry-run] would create ABC-41 with type Feature, milestone ABC-40 (new): [ABC-41] Ingest the data
[dry-run] would create ABC-42 with type Task, milestone ABC-40 (new), parent ABC-41 (new): [ABC-42] Clean the data
[dry-run] would update ABC-15 #21: set title, set type Task: [ABC-15] Write the parser
[dry-run] would close ABC-3 #12
[dry-run] would add 1 assignee to ABC-16 #22
[dry-run] would remove 1 assignee from ABC-16 #22
[dry-run] would add 1 assignee to ABC-41 (new)
[dry-run] would add 1 assignee to ABC-42 (new)
yt-gh-sync ok scanned=40 created=2 closed=1 reopened=0 updated=1 assigneesAdded=3 assigneesRemoved=1 milestonesCreated=1 milestonesClosed=0 skipped=34 capped=0 failed=0 filtered=28 unchanged=6 labelsReAdded=0 fetches=4 dryRun=true
```

Check that `scanned` matches the number of issues in the project, and that the planned writes
are what you expect. The dry run shows exactly what the next real run would do, write cap
included. On a new repo that means one create per open issue and epic that is not excluded, up
to `max-writes-per-run` (30); the rest show up as `capped` and are created by later runs, 10
minutes apart. A line such as `assignees: 1 unmatched (ABC-18)` names people the mirror could
not match ([How people are matched](#how-people-are-matched)). If the run fails, see
[Troubleshooting](#troubleshooting).

Upgrading from a version that titled mirrors `[YT-<n>]`: the first run renames every mirror and
milestone to `[<PROJECT>-<n>]`, one write each (decisions N1, N2), so it may take a few runs.
Nothing is duplicated.

### 5. Turn writes on

Tell your group first: the first live run assigns everyone the mirror matches at once, and
GitHub emails each of them (decision U9). Then set `dry-run: "false"`. For the first live run,
consider adding `max-writes-per-run: "1"` and checking on GitHub that the new issue's type and
milestone stuck: GitHub's docs don't say whether the job's token may set issue types, and if it
may not, the log says `GitHub dropped type ...`. Then remove that line again. To pause writes,
set `dry-run` back to `"true"`; to stop the mirror, disable the workflow (**Actions > YouTrack
mirror > ... > Disable workflow**).

### Inputs

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
| `sync-assignees`          | `SYNC_ASSIGNEES`          | `true`; `"false"` leaves assignees alone    |
| `assignee-map`            | `ASSIGNEE_MAP`            | empty: no map; pass it from a secret        |

[Configuration](#configuration) explains each setting.

- **Permissions:** the workflow's `permissions:` block decides what the default token may do;
  the action cannot raise it. `issues: write` covers issues, labels, milestones, sub-issues and
  assignees. `contents: read` lets the commit lookup read the repo's commits; without it that
  lookup is off, and a run that needs it warns
  `commit lookups off: the token lacks Contents read (HTTP 403)`. With a
  personal access token in `github-token` (from a secret) instead, writes come from that token's
  account; then also set `reopen-closed-by: ""`.
- **The map is a secret:** run logs print a step's inputs and env, so pass `assignee-map` from a
  secret (`${{ secrets.ASSIGNEE_MAP }}`), which GitHub masks, never from a variable or as text in
  the workflow. An unset secret is an empty string: no map.
- **Reopening:** a mirror this action closed is reopened when its YouTrack issue goes back to
  unresolved (decision R10); one a person closed stays closed. Closes by another workflow in
  the repo that uses `GITHUB_TOKEN` also show as `github-actions[bot]`, so those mirrors are
  reopened too while their YouTrack issue is open.
- **Empty inputs:** an input set to an empty string, such as an unset `${{ vars.X }}`, is a
  config error, not "use the default" (except `reopen-closed-by`, where empty means off, and
  `assignee-map`, where empty means no map). Leave an input out to get its default.
- **No zizmor findings:** the action pins `actions/setup-node` by commit SHA and passes inputs to
  its script only through env.
- **Runs and failures:** the `concurrency` group keeps one run at a time (pending runs wait).
  The 8-minute run deadline (decision R8) counts from the start of the sync step, and
  `timeout-minutes: 10` is the hard backstop. A failed sync fails the job; for scheduled runs
  GitHub emails whoever last changed the cron line.

### Runners and Actions minutes

Where the job runs decides what it costs (decision W3):

- **A private repo on GitHub-hosted runners** (`runs-on: ubuntu-latest`): every run bills the
  repo owner's [Actions minutes](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
  rounded up to a whole minute. Every 10 minutes is about 4,300 minutes a month, from a pool
  the organization shares with every other repo, and when it runs out, Actions stops for all of
  them. The action logs a warning on these runs.
- **A self-hosted runner** costs no minutes. If you can run one, on a machine of your own or one
  your organization provides, use it:
  [add a self-hosted runner](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners)
  to the repo or organization, then set `runs-on: self-hosted`. It needs Linux or macOS (the
  steps use `shell: bash`; Windows only with Git Bash), and it must reach your YouTrack and
  `api.github.com`. `actions/setup-node` downloads Node 24 unless the runner has it cached.
- **A public repo:** GitHub-hosted runners are free there, and GitHub advises against
  self-hosted runners for public repos, so keep `ubuntu-latest`.
- **No runner, but fewer minutes:** run less often, for example `cron: "*/30 * * * *"`, about
  1,440 minutes a month.

### Versions and updates

Releases are SemVer tags (`v0.1.0`, `v0.2.0`, ...) on the repo's
[Releases page](https://github.com/PeervandeWetering243522/youtrack-github-sync/releases), with
notes (decisions V1-V3; [CONTRIBUTING.md](CONTRIBUTING.md) has how they are made). The workflow
above pins `uses:` to the full commit SHA of a release, with its tag as a comment, so nothing
changes in your repo until you update the pin. From v0.1.1 on, each release's notes end with its
commit SHA and the `uses:` line to copy. For v0.1.0,
`git ls-remote https://github.com/PeervandeWetering243522/youtrack-github-sync refs/tags/v0.1.0`
prints it.

Dependabot proposes new releases as PRs that update both the SHA and the comment, with the
release notes in the PR. Your repo needs a `github-actions` entry in `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

From v1.0.0 on, a major bump (1.x to 2.0) can contain breaking changes: read the release notes
before merging one. Minor bumps (1.0 to 1.1) add features, and patch bumps (1.0.0 to 1.0.1) are
fixes and updated pins of the actions it uses. Before v1.0.0, a minor bump could break things
too.

**Updating from v0.x to v1.0.0** turns on [assignee sync](#assignees): add `contents: read` and
the `assignee-map` line to the workflow as in [step 3](#3-add-the-workflow), do a dry run, and
tell your group before the first live run. The mirror then owns the assignees it matches: a
student it matches who was assigned on GitHub by hand is removed when YouTrack assigns that
issue to someone else it matches. To keep the v0.x behaviour, set `sync-assignees: "false"`.

## Other ways to run it

The Action suits most groups. The two alternatives need a clone of this repo and a personal
GitHub token, whose account then shows as the author of every write:

|                          | GitHub Action (recommended)                                                                                 | Cloudflare Worker                                                                       | systemd timer                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Setup**                | One workflow file in your repo; no other account or server                                                  | A free Cloudflare account, a clone and a deploy                                         | A Debian host you have root on, and a clone            |
| **Writes attributed to** | `github-actions[bot]` (with the default token)                                                              | Your token's account                                                                    | Your token's account                                   |
| **On-demand run**        | `workflow_dispatch`: a **Run workflow** button in the repo's Actions tab, for anyone with write access      | None on the deployed Worker; the cron is its only trigger                               | `sudo systemctl start youtrack-gh.service` on the host |
| **Ongoing cost**         | Free on a self-hosted runner or in a public repo; otherwise [Actions minutes](#runners-and-actions-minutes) | Free (Workers Free covers it)                                                           | Free (your own hardware)                               |
| **Best fit**             | Most groups: nothing extra to host, writes from a bot, a run button                                         | You can't add a workflow to the repo, or may not use Actions minutes and have no runner | You already run a server and want it alongside         |

## Alternative host: Cloudflare Worker

Steps 1 to 5 end in a local dry run, which only reads and is safe to try at any time; steps 6
and 7 deploy the Worker and turn writes on. Steps 1 to 5 are also the start of the
[Debian + systemd timer](#alternative-host-debian--systemd-timer), and a way to try a dry run
on your own machine before installing the Action.

### What the Worker needs

Everything the [Action needs](#what-you-need) except the workflow, plus:

- **Node.js 22.18 or later**, with npm. The `.ts` sources run directly (type stripping), so
  there is no build step.
- **A GitHub account with the Write role or higher on the target repo.** Its token does every
  write, so every mirror issue and milestone is created by this account, and GitHub subscribes
  it to each mirror issue. A dedicated account keeps those notifications out of someone's inbox.
  Without push access, GitHub silently drops labels, milestones and issue types.
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
account above.

1. On GitHub, open **Settings > Developer settings > Personal access tokens > Tokens (classic)**
   and choose **Generate new token > Generate new token (classic)**.
2. Give it a note, pick an expiration, tick the `repo` scope and click **Generate token**. Copy
   the token right away.
3. If the organization uses SAML single sign-on, authorize the token for it (**Configure SSO**
   next to the token in the list).

When the token expires, every run fails until you put in a new one (`.env` for local runs,
`wrangler secret put GITHUB_TOKEN` for the Worker).

**YouTrack:** a permanent token, made as in the Action's
[step 1](#1-create-a-youtrack-token) (items 1 and 2; there is no GitHub secret to add).

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
below them. Set `YOUTRACK_EXCLUDE_PREFIX` if your group uses another prefix. Assignee sync is on
(`SYNC_ASSIGNEES=true`); put a map, if you need one, in `ASSIGNEE_MAP` ([The map](#the-map)).
[Configuration](#configuration) lists every setting. `.env` is gitignored: never commit it or
paste it anywhere.

### 4. Set up the GitHub repo

Create the `youtrack` label and check the issue types, as in the Action's
[step 2](#2-prepare-the-github-repo).

### 5. Do a dry run

```bash
npm run sync
```

With `DRY_RUN=true` this reads GitHub and YouTrack and logs one `[dry-run] would ...` line per
write it would make, then a summary line, and sends no GitHub write. Read it as described in the
Action's [step 4](#4-do-a-dry-run).

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
   npx wrangler secret put ASSIGNEE_MAP     # optional, only if you use a map
   npx wrangler tail                        # live logs; add --status error to see failures only
   ```

The Worker has only a `scheduled()` handler. `workers_dev` and `preview_urls` are off, so it
has no public URL. The cron is `*/10 * * * *` (UTC).

- The Worker is called `youtrack-gh-mirror` (`name` in `wrangler.jsonc`). To run two mirrors
  on one Cloudflare account, give each its own name.
- Each `wrangler secret put` creates and deploys a new version right away. Until both token
  secrets exist, runs fail at config validation without sending any request.
- The map is a secret, not a var: vars sit as plain text in `wrangler.jsonc` and the dashboard.
- Keep `"redact_query_string": true` under `observability`: the commit and email lookups put
  an email in the request URL, and this keeps query strings out of Workers Logs and traces. A
  `wrangler.jsonc` copied before v1.0.0 lacks it; copy the line from `wrangler.example.jsonc`.
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
| `assignees: 2 unmatched (ABC-12, ABC-15)`                   | The mirror found no GitHub account for someone assigned there. They follow [How people are matched](#how-people-are-matched), or you add them to the map.           |
| `assignees: 1 ambiguous (ABC-20)`                           | Two assignable accounts fit one person, such as two usernames with the same student ID. Add the person to the map.                                                  |
| `assignees: 1 not looked up (ABC-31)`                       | A commit or email lookup the person needed was not sent this run (the limit of 5, the write cap, the deadline) or failed. Later runs try again.                     |
| `mapped to a login that cannot be assigned`                 | A map entry names a GitHub username that is misspelled, or not a collaborator or organization member with access to the repo.                                       |
| `commit lookups off: the token lacks Contents read`         | Action: the workflow lacks `contents: read` (step 3). Worker or systemd: the token cannot read the repo's contents.                                                 |
| `commit lookups off (HTTP 409)`                             | The repo has no commits yet, so there is nothing to look up.                                                                                                        |
| `assignees: no scanned issue has an "Assignee" field`       | The project has no user field named exactly `Assignee` (it was renamed, or is not a user field). Rename it back, or set `sync-assignees: "false"`.                  |
| `assignees: none of the 4 YouTrack assignees matched ...`   | Nobody matched. If YouTrack usernames look anonymized, the YouTrack token's account lacks Read User Basic.                                                          |
| `assignees: could not read the assignable GitHub users ...` | That run synced no assignees; everything else went on. It retries on the next run. A 403 or 404 there points at the token's access to the repo.                     |
| `... (too many pages for the fetch budget)`                 | The repo has more assignable accounts (organization members with access count) than a run can read beside its writes. Lower `MAX_WRITES_PER_RUN`.                   |
| `GitHub dropped 1 of 1 assignees on add` on every run       | GitHub ignored the add: the token lacks push access, or the account can no longer be assigned. Each run spends a write on it.                                       |
| Worker: emails in the URLs of Workers Logs or traces        | `wrangler.jsonc` lacks `"redact_query_string": true` under `observability` (copies made before v1.0.0). Copy it from `wrangler.example.jsonc` and redeploy.         |

## How it works

Decision codes such as F1 or R9 refer to [docs/08-decisions.md](docs/08-decisions.md).

### What a run does

1. **Lists every GitHub issue** in the repo (`state=all`, no label filter), dropping pull
   requests. An issue whose title starts with `[<PROJECT>-<n>]` (the project in any case) is the
   mirror of YouTrack issue `n`; so is one with the `[YT-<n>]` of older versions, which the run
   then renames (decision N1). One with the `youtrack` label wins. A title match without the
   label still counts as the mirror, and a warning is logged. If several issues match, the
   lowest number wins (warning). For each mirror it keeps the REST `id`, title, milestone,
   issue type, parent and assignees.
2. **Lists every GitHub milestone** (`state=all`). A milestone whose title starts with
   `[<PROJECT>-<n>]` (or `[YT-<n>]`) is the milestone of YouTrack epic `n`. If several match,
   the lowest number wins (warning). Any other milestone counts as hand-made.
3. **Scans the whole YouTrack project** on every run (`GET /api/issues`,
   `project: <YOUTRACK_PROJECT> sort by: {issue id} asc`, 100 per page), including each issue's `Type` field
   and its Subtask parent, and with assignee sync on its `Assignee` field (each user's username
   and email). There is no lookback window. The run fails on any row whose `idReadable` is not
   `<project>-<numberInProject>`, on any row with two parents, two `Type` fields or two
   `Assignee` user fields, and on an `Assignee` value of the wrong shape.
4. **Filters out** every issue or epic whose summary starts with `YOUTRACK_EXCLUDE_PREFIX`
   (default `[individual]`, case-insensitive, leading whitespace ignored), and everything below
   it in YouTrack: an issue is also excluded when any ancestor (parent, grandparent and so on,
   epics included, resolved or not) starts with the prefix (decisions F1, F3). Excluded issues
   count as `filtered` and get no write at all, even if they already have a mirror or
   milestone: one that gets the prefix, or moves under an issue that has it, after it was
   mirrored keeps its mirror or milestone as it is, which is no longer synced or closed
   (decision F2). Every other issue goes on to planning.
5. **Matches assignees** (assignee sync on; see [Assignees](#assignees)). When some open issue
   (with an open mirror, or about to get one) has a YouTrack assignee, it reads the repo's
   assignable users (`GET /repos/{owner}/{repo}/assignees`, 100 per page) and matches each
   person: the map, then the student ID in an assignable username, then the commit author of
   their emails (`GET /repos/{owner}/{repo}/commits?author=<email>`), then GitHub's public-email
   search (`GET /search/users`). The last two are lookups: at most 5 per run, fewer when the write
   cap leaves less room under the fetch guard, none within 40 s of the run deadline, each
   (lookup, email) once, and the people who need them rotate every 10 minutes. Nothing here
   fails the run: if the assignable users cannot be read, the run syncs no assignees and warns
   (decision U16); a failed lookup is skipped, or turns that kind of lookup off for the run. It
   then logs one warning for everyone it left out, and from here on every log line has the
   usernames and emails it saw replaced with `[person]` (decision U8).
6. **Plans**, using the [hierarchy mapping](#hierarchy) below:
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
   - open mirror, or a mirror created in this run, of an unresolved issue that is not an epic,
     whose YouTrack assignees include someone matched: **add** the matched accounts it lacks,
     and **remove** the matched accounts YouTrack does not assign to it (decisions U4-U7).
   - anything else: nothing (`unchanged`).
7. **Writes** serially, 1 s apart, in this order: milestone creates, renames and closes; creates of
   everything except tasks; creates of tasks, parents before children; syncs; closes and
   reopens; assignee adds and removes (per mirror the add first). Within a
   group the oldest (lowest issue number) goes first. At most `MAX_WRITES_PER_RUN` writes run
   per run. Whatever does not fit is `capped` and picked up by the next run, and nothing later
   jumps ahead. Every action costs one write. If GitHub drops the label on create, it is
   re-added once (this counts as a write). A child whose parent mirror or milestone is created
   earlier in the same run uses it. If that create failed or waited itself, the child is
   `capped` too (with a warning) and the run goes on. The write phase also stops early,
   counting the rest as `capped`, when GitHub rate-limits a write, when the fetch guard is
   reached, or when the run deadline passes (see [Limits and budget](#limits-and-budget)).
8. **Logs one line per write and one summary line**, for example:

   ```text
   assignees: 1 unmatched (ABC-18)
   create milestone ABC-40 -> #1
   create ABC-41 with type Feature, milestone ABC-40 #1 -> #30
   create ABC-42 with type Task, milestone ABC-40 #1, parent ABC-41 #30 -> #31
   update ABC-15 #21: set title, set type Task
   close ABC-3 #12
   add 1 assignee to ABC-16 #22
   remove 1 assignee from ABC-16 #22
   add 1 assignee to ABC-41 #30
   add 1 assignee to ABC-42 #31
   yt-gh-sync ok scanned=40 created=2 closed=1 reopened=0 updated=1 assigneesAdded=3 assigneesRemoved=1 milestonesCreated=1 milestonesClosed=0 skipped=34 capped=0 failed=0 filtered=28 unchanged=6 labelsReAdded=0 fetches=13 dryRun=false
   ```

   The headline counts come first. `updated` counts updates, moves, detaches and milestone
   renames, `assigneesAdded` and `assigneesRemoved` count assignee writes (one write may name
   several people), and `skipped` = `filtered` + `unchanged`. The other write lines look like
   `rename milestone ABC-33 #7`, `close milestone ABC-33 #7`,
   `update ABC-15 #21: set milestone ABC-33 #7`, `update ABC-15 #21: clear milestone`,
   `move ABC-42 #31 under ABC-36 #22`, `detach ABC-42 #31 from parent ABC-41 #30` and
   `label ABC-41 #30` (label re-added). Assignee lines name counts, never a person; when GitHub
   ignores one, a warning such as
   `ABC-16 #22: GitHub dropped 1 of 1 assignees on add; the next run tries again` follows.

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
  has no mapping keeps whatever type it has on GitHub. Assignees work the same way: one the
  mirror cannot match to someone assigned in YouTrack (staff, bots, anyone unmatched) stays.

### What it never does

YouTrack is only ever read: the only call is `GET /api/issues`. On GitHub the tool never
reopens a milestone, never reopens an issue that the `REOPEN_CLOSED_BY` login did not close
(and reopens nothing when it is unset, decision R10), never changes a body or milestone
description after creation (titles do follow YouTrack, decision N2), never comments, never
reorders sub-issues, never clears an issue type, never creates labels and never touches pull
requests. It never adds or removes an assignee it does not match to someone assigned in the
YouTrack project, never removes a bot, never changes the assignees of a closed mirror, and
never clears a mirror's assignees because its YouTrack issue is unassigned. Relates links and
sprints are not mirrored. A mirror whose YouTrack issue is deleted is left as it is.

Mirrors are recognised by the project ID in their titles. If a YouTrack admin changes the
project's ID (say `ABC` to `XYZ`), update `YOUTRACK_PROJECT`, and first rename the old
`[ABC-n]` prefixes to `[XYZ-n]` by hand, or every mirror and milestone is created again.

### Failures

A failed read (GitHub issues or milestones, YouTrack scan) logs a `yt-gh-sync failed ...`
summary line and aborts the run. A failed write is logged, the run carries on with the other
writes (unless GitHub rate-limited it), and at the end it logs `yt-gh-sync failed ...` and
throws, so the run shows as failed in Cron Events (or as a failed systemd unit). A write that
waits for a failed create is `capped`, not failed, such as
`add 1 assignee to ABC-41 capped: the mirror of ABC-41 was not created in this run`. The
assignee reads (assignable users and lookups) never fail the run; they only warn. Tokens are
never logged, and with assignee sync on neither are usernames or emails.

### Dry run

Dry run is on by default: only `DRY_RUN=false` turns it off. With it on, the run reads both
sides and logs one `[dry-run] would ...` line per planned write, but sends no GitHub write at
all. The create lines, and the lines that change a title, end with the new title. A milestone or mirror that the run would create
earlier shows as `(new)`. It sends the same reads as a real run, the assignable users and the
lookups included, so it shows who would be matched. See the Action's
[step 4](#4-do-a-dry-run) for an example.

## Configuration

| Name                      | Kind   | Default        | Notes                                                                                                                                                                   |
| ------------------------- | ------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`            | secret | required       | Classic PAT with the `repo` scope (decision B12).                                                                                                                       |
| `YOUTRACK_TOKEN`          | secret | required       | YouTrack permanent token.                                                                                                                                               |
| `GITHUB_REPO`             | var    | required       | The mirror repo, as `owner/repo`.                                                                                                                                       |
| `YOUTRACK_BASE_URL`       | var    | required       | https URL without query string, fragment or credentials. For BUas: `https://youtrack.ai.buas.nl`.                                                                       |
| `YOUTRACK_PROJECT`        | var    | required       | Project shortName (the prefix of its issue IDs), starting with a letter or digit.                                                                                       |
| `YOUTRACK_EXCLUDE_PREFIX` | var    | `[individual]` | Case-insensitive summary prefix that keeps an issue or epic, and everything below it, out of the mirror. Not blank when set.                                            |
| `MAX_WRITES_PER_RUN`      | var    | `30`           | Whole number from 0 to 40. Every write counts 1: create, close, reopen, update, move, detach, milestone create, rename or close, label re-add, assignee add or remove.  |
| `DRY_RUN`                 | var    | on             | Only `false` (any case, surrounding whitespace ignored) turns it off.                                                                                                   |
| `REOPEN_CLOSED_BY`        | var    | empty (off)    | A GitHub login, such as `github-actions[bot]`: a closed mirror it closed is reopened once its YouTrack issue is unresolved (R10). Leave it empty with a personal token. |
| `SYNC_ASSIGNEES`          | var    | `true`         | `true` or `false` (any case, surrounding whitespace ignored); anything else, empty included, is a config error. `false` leaves GitHub assignees alone (U1).             |
| `ASSIGNEE_MAP`            | secret | empty (no map) | `<youtrack-username>=<github-username>` pairs separated by commas, on one line; `-` as the GitHub username means never assign. See [The map](#the-map) (U14).           |

Invalid config fails the run before any request is made, listing every problem at once.
Variables the tool does not know, such as the retired `YOUTRACK_TITLE_PREFIX`, are ignored.

Where the values come from:

- **GitHub Action:** the action's inputs, one per setting (see [Inputs](#inputs)).
- **Worker:** vars in `wrangler.jsonc` (your gitignored copy of `wrangler.example.jsonc`),
  secrets via `wrangler secret put`, `ASSIGNEE_MAP` included.
- **Node (`npm run sync`):** the environment, plus `.env` if present. It does **not** read
  `wrangler.jsonc`, so the three required vars must be in `.env` (or the environment).
- **systemd:** `EnvironmentFile=` for vars and the map, `LoadCredential=` for the two tokens
  (see [below](#app-config-and-secrets)).

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
SYNC_ASSIGNEES=true
```

A map, if you use one, goes in the same file as one `ASSIGNEE_MAP=...` line. It holds personal
data; `/etc/youtrack-gh` is readable by root only.

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
- **Fetches per run:** 3 reads (1 GitHub issues page, 1 milestones page, 1 YouTrack page) + at
  most 30 writes = 33 fetches without retries. With assignee sync on and at least one open
  issue assigned in YouTrack, a 4th read (the assignable users, 1 page per 100) makes it 34,
  plus the commit and email lookups when someone needs them. A further page of assignable users
  is read only while `fetches left - MAX_WRITES_PER_RUN - 2` is above 0 (10 pages with the
  default 30 writes); a longer list skips assignee sync for that run with a warning, so the
  writes keep their share of the guard. Each retry is one more fetch, up
  to the 45-fetch guard. Every further 100 GitHub items (issues and pull requests), 100
  milestones or 100 YouTrack issues costs one more page. A dry run sends only the reads, the
  lookups included.
- **Lookups:** at most `min(5, fetches left - MAX_WRITES_PER_RUN - 2)` per run, where the
  fetches left are counted before the first lookup (41 after four one-page reads), so the writes
  always keep their share of the guard; the last lookup may retry once. With the default 30
  writes that is 5 (4 + 5 + 30 = 39 fetches), with 38 writes 1, and with 39 or 40 none. A lookup
  starts only while the run is more than 40 s from its deadline.
  Commit lookups use the core rate limit and email lookups the search rate limit; a rate limit
  on the email search turns it off for the run, one on the commits stops all lookups.
- **Writes per issue:** a new mirror with a matched assignee costs 2 writes (create, then add);
  a reassignment between matched people costs 2 (add, then remove). The first live run with
  assignee sync adds one assignee write per open mirror whose assignee it matches, so it may
  take a few runs.
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
  affected, except the assignee lookups, which stop 40 s before it. On systemd,
  `TimeoutStartSec=10min` is the hard backstop.
- **GitHub:** writes are serial and 1 s apart, well within the secondary limit of 80
  content-creating requests per minute. If the token lacks push access, GitHub silently drops
  labels, milestones and types, and ignores assignee adds and removes. The label re-add and the
  title fallback stop that from causing duplicates. When GitHub's answer lacks a milestone,
  type, parent or added assignee that was sent, or still holds a removed one, a warning is
  logged and the next run tries again (no extra write in the same run). GitHub allows 100
  sub-issues per parent and 8 levels; a create or move beyond that is expected to fail on every
  run (unverified). It allows 10 assignees per issue: matched people beyond that are left out
  with a warning such as `ABC-9 #40: 1 matched assignee not added: GitHub allows 10 per issue`.
- **Workers CPU:** the larger YouTrack response (the `Assignee` field adds about a quarter), the
  matching and the redaction were not measured against the 10 ms limit.
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
- [12-assignees.md](docs/12-assignees.md) and [13-assignees-plan.md](docs/13-assignees-plan.md):
  matching YouTrack assignees to GitHub accounts, the live write test and the plan
  (implemented; docs/13 has the "As built" notes).
- [04-cloudflare-workers.md](docs/04-cloudflare-workers.md): Workers limits, cron, secrets, local testing.
- [05-node-debian-systemd.md](docs/05-node-debian-systemd.md): Node versions, Debian packages, systemd.
- [03-github-rest-api.md](docs/03-github-rest-api.md) and
  [02-youtrack-rest-api.md](docs/02-youtrack-rest-api.md): the two APIs.
