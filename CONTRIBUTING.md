# Contributing

Development commands and conventions are in the [README](README.md#development) and
[CLAUDE.md](CLAUDE.md). This file covers how changes reach `main` and become releases
(decisions V1-V3 in [docs/08-decisions.md](docs/08-decisions.md)).

## Branches and pull requests

- Work on a feature branch, never on `main`: `git switch -c feat/reopen-own-closes`.
- Open a pull request into `main`. Three checks must pass: **Check** (passes when the
  parallel Typecheck, Lint, Format and Test jobs all do, the tests on Node 22 and 24; together
  they are `npm run check`), **Workflow audit** (zizmor over the workflows and `action.yml`)
  and **Conventional PR title**. The branch must be up to date with `main`.
- PRs are **squash-merged**, and the squashed commit takes the PR's title (and its body), so
  the title is what decides the next version. The branch's own commits can be anything. A
  ruleset on `main` enforces this: no direct pushes, force pushes or deletion.
- Changes that build on each other go in a stack of PRs (`gh stack`, see GitHub's
  [stacked pull requests](https://docs.github.com/en/pull-requests/get-started/stacked-prs-quickstart)).

### PR titles

`<type>(<optional scope>)!: <summary>`, for example `feat: reopen the sync's own closes` or
`fix(action): pass the reopen input`.

| Type                                                                | Release (while on 0.x) |
| ------------------------------------------------------------------- | ---------------------- |
| `feat`                                                              | minor: 0.1.0 -> 0.2.0  |
| `fix`, `perf`, `revert`                                             | patch: 0.1.0 -> 0.1.1  |
| a `!` after the type, or a `BREAKING CHANGE:` footer in the PR body | minor too (see below)  |
| `docs`, `refactor`, `test`, `build`, `ci`, `chore`, `style`         | none                   |

A breaking change is anything a group running the mirror would notice after updating: a
renamed or removed input or setting, a changed title format, a new kind of write. While the
version is 0.x, breaking changes bump the minor version (`releaseRules` in `.releaserc.json`).
To move to 1.0.0, remove that rule; from then on a breaking change bumps the major version.

## Releases

Every push to `main` runs `.github/workflows/release.yml`. It checks the code again and then
runs [semantic-release](https://semantic-release.gitbook.io/), which reads the commits since the
last `v*` tag. When one of them warrants a release, it pushes the next tag (`v0.2.0`) and
creates a GitHub Release with notes grouped by type. Nothing is committed back to `main`: the
tag is the version (`package.json` stays at `0.0.0-development`), and the release notes are
the changelog. Releases are immutable: a published tag is never moved or deleted, so the commit
SHA that groups pin for a version never changes.

## Dependencies

Dependabot (`.github/dependabot.yml`) proposes updates weekly, after a 7-day cooldown:

- **GitHub Actions** (the workflows and `action.yml`): titled `fix(deps): ...`, so merging
  one makes a patch release and groups get the new `actions/setup-node` pin.
- **npm** (development tools only; the sync has no runtime dependencies): titled
  `chore(deps-dev): ...`, no release.
