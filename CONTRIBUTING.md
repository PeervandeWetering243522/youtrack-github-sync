# Contributing

Development commands and conventions are in the [README](README.md#development) and
[CLAUDE.md](CLAUDE.md). This file covers how changes reach `main` and become releases
(decisions V1-V6 in [docs/08-decisions.md](docs/08-decisions.md)).

## Branches and pull requests

- Work on a feature branch, never on `main`: `git switch -c feat/reopen-own-closes`.
- Open a pull request into `main`. Three checks must pass: **Check** (passes when the
  parallel Typecheck, Lint, Format and Test jobs all do, the tests on Node 22 and 24; together
  they are `npm run check`), **Workflow audit** (zizmor over the workflows and `action.yml`)
  and **Conventional PR title** (the title, the Upgrading section and a release preview, see
  below). The branch must be up to date with `main`.
- PRs are **squash-merged**, and the squashed commit is the PR's title alone (the repo's
  squash setting is "Pull request title"), so the title is what decides the next version. The
  description is for reviewers and never reaches `main`. The branch's own commits can be
  anything. A ruleset on `main` enforces this: no direct pushes, force pushes or deletion.
- Changes that build on each other go in a stack of PRs (`gh stack`, see GitHub's
  [stacked pull requests](https://docs.github.com/en/pull-requests/get-started/stacked-prs-quickstart)).

### PR titles

`<type>(<optional scope>)!: <summary>`, for example `feat: reopen the sync's own closes` or
`fix(action): pass the reopen input`.

| Type                                                        | Release               |
| ----------------------------------------------------------- | --------------------- |
| `feat`                                                      | minor: 1.0.0 -> 1.1.0 |
| `fix`, `perf`, `revert`                                     | patch: 1.0.0 -> 1.0.1 |
| a `!` after the type                                        | major: 1.0.0 -> 2.0.0 |
| `docs`, `refactor`, `test`, `build`, `ci`, `chore`, `style` | none                  |

The summary after the colon is the PR's line in the release notes, so write it for the groups
running the mirror. A breaking change is one a group has to act on when updating: a renamed or
removed input or setting, a changed title format, a new kind of write that needs a new
permission or setting. It bumps the major version. A change they will notice but need not act
on, such as the mirror now keeping in sync something it used to leave alone, is not breaking:
it gets an Upgrading section instead (below). Up to v0.1.1 a breaking change bumped only the
minor version (a `releaseRules` entry in `.releaserc.json`); the assignee sync removed that rule
and is released as v1.0.0 (decision U1).

### The Upgrading section

The `## Upgrading` section of a PR description says what a group running the mirror must do or
know before updating, written for them. The PR template has the heading. The release copies it
as written, so Markdown, code blocks and `#12` all come through unchanged. Which PRs have one:

- **A breaking PR** (a `!` in the title) must have one. The release puts it under
  "⚠ BREAKING CHANGES" (decision V5).
- **Any other PR that makes a release** (`feat`, `fix`, `perf`, `revert`) has one when groups
  will notice the change after updating: something the mirror now writes, rewrites or stops
  writing, or a visible change in its runs. The release lists it under "Before updating", after
  the breaking changes and before the list of changes, as `* <summary> (#16)` followed by the
  section (decision V6). A change nobody will notice leaves the section empty.
- **A PR that makes no release** (`docs`, `ci`, `chore`, ...) leaves it empty: no release
  notes would show it.

The **Conventional PR title** check fails when a `!` PR has no section or a PR that makes no
release has one. It runs again when you edit the title or description.

The check's summary page (the job's **Summary**) previews the release: the bump the PR makes
and its exact entry in the release notes. Locally:
`PR_TITLE='feat!: x' PR_BODY="$(cat body.md)" PR_NUMBER=1 node scripts/release/check-pr.ts`.

## Releases

Every push to `main` runs `.github/workflows/release.yml`. It checks the code again and then
runs [semantic-release](https://semantic-release.gitbook.io/), which reads the commits since the
last `v*` tag. When one of them warrants a release, it pushes the next tag (`v1.1.0`) and
creates a GitHub Release. Its notes have one line per PR title, grouped by type, the Upgrading
section of each breaking PR first, then "Before updating" with the section of every other PR
that has one (`scripts/release/notes.ts` reads each released commit's merged PR), and at the
end the release's commit SHA and a ready `uses:` line to pin it (`releaseBodyTemplate`).
A breaking PR without a section gets its title as its note and a warning in the release log;
release notes can still be edited afterwards. Nothing is committed back to `main`: the
tag is the version (`package.json` stays at `0.0.0-development`), and the release notes are
the changelog. Releases are immutable: a published tag is never moved or deleted, so the commit
SHA that groups pin for a version never changes.

## Dependencies

Dependabot (`.github/dependabot.yml`) proposes updates weekly, after a 7-day cooldown:

- **GitHub Actions** (the workflows and `action.yml`): titled `fix(deps): ...`, so merging
  one makes a patch release and groups get the new `actions/setup-node` pin.
- **npm** (development tools only; the sync has no runtime dependencies): titled
  `chore(deps-dev): ...`, no release.
