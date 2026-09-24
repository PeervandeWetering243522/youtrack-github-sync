# Node.js on Debian + systemd timer (alternative host)

> Researched 2026-09-24 for the YouTrack -> GitHub mirror. Status tags: [verified] = source re-opened and quote confirmed; [live] = confirmed by a live request; [partial] = indirect/partial support; [undocumented] = not found in official docs.

This topic did not contact YouTrack or GitHub. All live checks were against nodejs.org, packages.debian.org, deb.nodesource.com, npm, local Node v22.22.2, and systemd 255 under WSL.

## TL;DR

| Question | Answer | Status | Source |
|---|---|---|---|
| Node release status (2026-09-24) | v24 "Krypton" is Active LTS until 2026-10-20, then Maintenance LTS; EOL 2028-04-30. v22 "Jod" is Maintenance LTS; EOL 2027-04-30. v26 is Current; LTS from 2026-10-28, EOL 2029-04-30. v20 EOL 2026-04-30. v25 EOL 2026-06-01. Latest builds: v24.21.0, v22.23.3, v26.10.0. | [verified] [live] | [1][2][3] |
| Global `fetch` | Unflagged since v18.0.0. Stable since v21.0.0. | [verified] [live] | [4] |
| Run `.ts` directly | Type stripping arrived in v22.6.0 behind a flag. On by default since v23.6.0 and v22.18.0. Stable since v25.2.0 and v24.12.0; the v22 docs still say "1.2 Release candidate". Only erasable syntax works. Import specifiers need the `.ts` extension. Files under `node_modules` are not stripped. | [verified] [live] | [5][6][7] |
| Same `.ts` sources for wrangler | Yes, in a local test: `.ts` specifiers plus `import type` passed `tsc --noEmit` (TS 7.0.2) and `wrangler deploy --dry-run` (4.133.0). No official doc states this. | [live] [undocumented] | -- |
| Env loading | `--env-file` since v20.6.0, `--env-file-if-exists` since v22.9.0 (backported to v20.19.0), `process.loadEnvFile` since v21.7.0 and v20.12.0. All three are non-experimental since v24.10.0 and v22.21.0. | [verified] [live] | [8][9][10] |
| Debian `nodejs` package | bookworm 18.20.4, trixie 20.19.2, forky 24.21.0. No backports packages exist. Neither stable release can run the `.ts` sources. | [live] | [11][12][13] |
| Getting a current Node | NodeSource `node_24.x` "nodistro" apt repo (currently 24.21.0-1nodesource1), or the official nodejs.org tarball with SHASUMS256. | [verified] [live] | [14][15][16][17] |
| Every-10-min schedule | `OnCalendar=*:0/10` normalizes to `*-*-* *:00/10:00`. | [verified] [live] | [18][19] |
| Overlapping runs | A run that is still active is not started again: "no concept of spawning new service instances". | [verified] | [20] |
| Oneshot timeout | Disabled by default for `Type=oneshot`, so set `TimeoutStartSec=` yourself. | [verified] | [21] |
| Secrets | Environment variables are "not suitable for passing secrets". Use `LoadCredential=` (or `LoadCredentialEncrypted=`) and read the files from `$CREDENTIALS_DIRECTORY`. | [verified] | [22][23] |
| Toolchain | `typescript` 7.0.2 (latest dist-tag) plus `@types/node`, with `"type": "module"`. | [live] [verified] | [5][24][25] |

## Details

### 1. Node.js release status

The nodejs/Release `schedule.json` gives these dates [2]:

- v20 ends 2026-04-30.
- v22: maintenance from 2025-10-21, ends 2027-04-30.
- v24: LTS from 2025-10-28, maintenance from 2026-10-20, ends 2028-04-30.
- v25: ends 2026-06-01.
- v26: starts 2026-05-05, LTS from 2026-10-28, maintenance from 2027-10-20, ends 2029-04-30. Its codename is still empty.

The dist index shows the latest build per line [3]. [live]

| Line | Latest | Date | lts field |
|---|---|---|---|
| v26 | v26.10.0 | 2026-09-21 | false |
| v24 | v24.21.0 | 2026-09-07 | Krypton |
| v22 | v22.23.3 | 2026-09-23 | Jod |

> "Production applications should only use Active LTS or Maintenance LTS releases." [1]

> "Starting with Node.js 27, the release cycle will be annual and every major version will move to LTS status after its six-month Current phase" [1]

What this means for the project: run on Node 24. It stays supported until 2028-04-30, and type stripping is Stable from 24.12.0. Node 22 works, but it reaches EOL on 2027-04-30.

### 2. Global fetch

> "added: v17.5.0, v16.15.0 ... v21.0.0: No longer experimental. ... v18.0.0: No longer behind `--experimental-fetch` CLI flag." [4] [verified]

Local check: `node -e "console.log(typeof fetch)"` printed `function` on v22.22.2. [live]

### 3. Running TypeScript directly (type stripping)

**Versions** [5] [verified]

| Change | Versions |
|---|---|
| Introduced behind a flag | v22.6.0 |
| Enabled by default | v23.6.0, v22.18.0 |
| No experimental warning | v24.3.0, v22.18.0 |
| Stable | v25.2.0, v24.12.0 |
| `--experimental-transform-types` removed | v26.0.0 |

- The stability banner differs by line: main and v24.x say "Stability: 2 - Stable", while v22.x says "Stability: 1.2 - Release candidate" [5][6].
- The disable flag is now `--no-strip-types`. It was "renamed from `--no-experimental-strip-types`" in v25.2.0 and v24.12.0 [7].

**Restrictions** [5] [verified]

- **Only erasable syntax runs.**
  > "The most prominent features that require transformation are: `Enum` declarations, `namespace` with runtime code, parameter properties, import aliases"

  Namespaces that contain only types are allowed. Decorators "will result in a parser error".
- **Type imports need the `type` keyword.**
  > "Without the `type` keyword, Node.js will treat the import as a value import, which will result in a runtime error."
- **Import specifiers need a file extension.**
  > "file extensions are mandatory in `import` statements and `import()` expressions: `import './file.ts'`, not `import './file'`."
- **tsconfig.json is not read.**
  > "Node.js ignores `tsconfig.json` files"

  As a result, `paths` aliases produce an error. Subpath imports starting with `#` are the closest alternative.
- **Module system.** `.ts` files follow the package.json `"type"` field. `.mts` is always ESM, `.cts` is always CJS, and `.tsx` is unsupported.
- **node_modules is excluded.**
  > "Node.js refuses to handle TypeScript files inside folders under a `node_modules` path."
- **No source maps.** Types are replaced with whitespace, so line numbers stay correct without them.

**Recommended tsconfig** (Node recommends TS 5.8 or newer) [5] [verified]:

```json
{ "compilerOptions": { "noEmit": true, "target": "esnext", "module": "nodenext",
  "rewriteRelativeImportExtensions": true, "erasableSyntaxOnly": true, "verbatimModuleSyntax": true } }
```

Related tsconfig options [26] [verified]:

- **`allowImportingTsExtensions`:**
  > "This flag is only allowed when --noEmit or --emitDeclarationOnly is enabled"

  > "Default: true if rewriteRelativeImportExtensions; false otherwise."
- **`erasableSyntaxOnly`** rejects "enum declarations, namespaces and modules with runtime code, parameter properties in classes, Non-ECMAScript import = and export = assignments". It also rejects `<prefix>`-style type assertions.

**Local experiments** (node v22.22.2, `package.json` = `{"type":"module"}`) [live]:

| Test | Result |
|---|---|
| `a.ts` importing `./sync.ts` | Ran, no warning |
| enum | `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript enum is not supported in strip-only mode` |
| parameter property | `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX ... parameter property is not supported in strip-only mode` |
| `import ... from './sync'` (no extension) | `ERR_MODULE_NOT_FOUND` |
| interface imported without `type` | `SyntaxError: The requested module './types.ts' does not provide an export named 'Row'` |

**Wrangler cross-check** [live] [undocumented]:

- Sources: `src/sync.ts` uses `import type { Row } from './types.ts'`. Both `worker.ts` and `node-main.ts` use `import { runSync } from './sync.ts'`.
- `npx tsc -p tsconfig.node.json --noEmit` with TS 7.0.2 exited 0. That config is the Node-recommended set plus `strict`, `skipLibCheck` and `types:["node"]`.
- `npx wrangler deploy --dry-run --outdir dist3` with wrangler 4.133.0 printed "Total Upload: 0.44 KiB / gzip: 0.29 KiB", and `runSync` was inlined into the bundle.
- The latest wrangler is 4.138.0 [live]. I found no Cloudflare page that explicitly documents `.ts` import specifiers.

### 4. Env loading

- **`--env-file=file`** [8] [verified]
  - Added v20.6.0. Multi-line values since v21.7.0 and v20.12.0. No longer experimental since v24.10.0 and v22.21.0.
  - "An error is thrown if the file does not exist."
  - > "If the same variable is defined in the environment and in the file, the value from the environment takes precedence."
  - The parser accepts `#` comments, including after a value, quoted values, multi-line values and an ignored `export` prefix.
  - Node-configuring variables in the file, such as `NODE_OPTIONS`, "are parsed and applied".
- **`--env-file-if-exists=file`** [8][9] [verified]
  - Added v22.9.0; no longer experimental since v24.10.0 and v22.21.0.
  - "Behavior is the same as `--env-file`, but an error is not thrown if the file does not exist."
  - The v20 docs list it as "added: v20.19.0" with "Stability: 1.1 - Active development".
- **`process.loadEnvFile(path)`** [10] [verified]
  - Added v21.7.0 and v20.12.0; no longer experimental since v24.10.0 and v22.21.0. The default path is `'./.env'`.
  - "Usage of `NODE_OPTIONS` in the `.env` file will not have any effect on Node.js."
- **Live results** (v22.22.2) [live]
  - `--env-file=t.env` loaded the value.
  - `--env-file-if-exists=missing.env` printed "missing.env not found. Continuing without it." and continued.
  - `--env-file=missing.env` failed with "missing.env: not found".

### 5. Debian packages and installing a current Node

**Debian archive** (packages.debian.org, fetched 2026-09-24) [live]

| Suite | nodejs | Source |
|---|---|---|
| bookworm (12) | 18.20.4+dfsg-1~deb12u2 | [11] |
| trixie (13) | 20.19.2+dfsg-1+deb13u2 | [12] |
| forky (testing) | 24.21.0+dfsg+~cs24.13.4-1 | [13] |
| bookworm-backports, trixie-backports | no package ("Debian -- Error" page) | -- |

- Both upstream lines are EOL: v18 in 2025, v20 on 2026-04-30 [2].
- Neither supports type stripping, which needs v22.6.0 or later [5].

**Option A: NodeSource apt repo** [14][15] [verified] [live]

- NodeSource moved to a distro-agnostic repo:
  > "DEB and RPM packages are now available under the `nodistro` codename. We no longer package the installer coupled to specific versions."
- The manual install steps are:
  1. Download the key from `https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key` and store it as `/etc/apt/keyrings/nodesource.gpg`.
  2. Add a deb822 source containing `URIs: https://deb.nodesource.com/node_${NODE_MAJOR}.x/`, `Suites: nodistro`, `Components: main` and `Signed-By: /etc/apt/keyrings/nodesource.gpg`.
  3. Run `apt-get install nodejs`.
- Live:
  - `https://deb.nodesource.com/setup_{22,24,26}.x` all return HTTP 200.
  - The `node_24.x/dists/nodistro/main/binary-amd64/Packages` index lists `Version: 24.21.0-1nodesource1` as its newest version.
- **Correction:** the DEV_README support table lists Debian only up to "Debian 12 Bookworm". I could not confirm an explicit "trixie 13" support statement, because nodesource.com/products/distributions is rendered client-side and the text is not in the page source. Status for trixie: [partial]. The nodistro design claims to work on "almost any distro that meets the minimum requirements".

**Option B: official nodejs.org binaries** [16] [live]

- `https://nodejs.org/dist/latest-v24.x/` has `node-v24.21.0-linux-x64.tar.xz`, with SHA-256 `fd8e59d5...cb2d6` listed in SHASUMS256.txt.
- Unpack it into `/opt` and use an absolute `ExecStart=` path.

**Option C: version managers and Docker** [17] [partial]

- nodejs.org/en/download lists nvm, fnm, n, asdf, Docker and others. It notes that third-party installers "are not maintained by the Node.js project."
- nvm installs under `$HOME`. That conflicts with `ProtectHome=` (see section 6).

### 6. systemd: oneshot service + 10-minute timer

Package versions [live]:

- trixie: systemd 257.13-1~deb13u1 [27]
- bookworm: systemd 252.39-1~deb12u2 [28]

Citations are from the trixie man pages on manpages.debian.org unless noted.

**OnCalendar** [18] [verified]

> "Values may be suffixed with "/" and a repetition value, which indicates that the value itself and the value plus all multiples of the repetition value are matched."

The man page's own example is `*:2/3 → *-*-* *:02/3:00`.

Live check with systemd 255.4 under WSL [live]:

```
$ systemd-analyze calendar --iterations=3 '*:0/10'
  Original form: *:0/10
Normalized form: *-*-* *:00/10:00
    Next elapse: Thu 2026-09-24 21:30:00 CEST
   Iteration #2: Thu 2026-09-24 21:40:00 CEST
```

`systemd-analyze calendar` "will parse and normalize repetitive calendar time events, and will calculate when they elapse next". `--iterations=NUMBER` shows the next N elapse times [19] [verified].

Calendar expressions without a timezone use local time [partial: inferred from systemd.time output formatting, no exact quote captured]. This does not matter for a 10-minute cadence.

**Timer options** [20] [verified]

- **Persistent=**
  > "If true, the time when the service unit was last triggered is stored on disk. When the timer is activated, the service unit is triggered immediately if it would have been triggered at least once during the time when the timer was inactive."

  It "only has an effect on timers configured with OnCalendar=" and defaults to false.
- **AccuracySec=**
  > "Specify the accuracy the timer shall elapse with. Defaults to 1min."

  "To get best accuracy, set this option to 1us."
- **RandomizedDelaySec=**
  > "Delay the timer by a randomly selected, evenly distributed amount of time between 0 and the specified time value. Defaults to 0"
- **Overlap**
  > "Note that in case the unit to activate is already active at the time the timer elapses it is not restarted, but simply left running. There is no concept of spawning new service instances in this case."

  The same sentence is in the bookworm page [29].

**Type=oneshot** [21] [verified]

- The start timeout is off by default:
  > "Defaults to DefaultTimeoutStartSec= set in the manager, except when Type=oneshot is used, in which case the timeout is disabled by default"
- RuntimeMaxSec= does not help: it "does not have any effect on Type=oneshot services ... (use TimeoutStartSec= to limit their activation)".
- "For Type=oneshot, Restart=always and Restart=on-success are not allowed."
- Without `RemainAfterExit=`, a oneshot service "will never enter "active" unit state, but will directly transition from "activating" to "deactivating"". Leave `RemainAfterExit=` unset. If the unit stayed active, later timer ticks would do nothing (per the overlap rule).

**Secrets vs configuration** [22] [verified]

- Environment variables are the wrong channel for secrets:
  > "Note that environment variables are not suitable for passing secrets (such as passwords, key material, ...) to service processes. Environment variables set for a unit are exposed to unprivileged clients via D-Bus IPC"

  The same sentence is in the bookworm page [30].
- **LoadCredential=ID[:PATH]** makes the data available at "a read-only location". It "is only accessible to the user associated with the unit, via the User=/DynamicUser= settings (as well as the superuser)." Its location is exported "as the $CREDENTIALS_DIRECTORY environment variable".
- If PATH is omitted, "the directories /etc/credstore/, /run/credstore/ and /usr/lib/credstore/ are searched".
- **systemd-creds encrypt** "encrypts it and writes the (encrypted ciphertext) output ... The resulting file may be referenced in the LoadCredentialEncrypted= setting" [23].
- **EnvironmentFile=** suits non-secret config such as LOOKBACK_HOURS, MAX_WRITES_PER_RUN and BACKFILL.
  - A path "prefixed with "-" ... if the file does not exist, it will not be read and no error or warning message is logged."
  - Parsing rules: "lines starting with ";" or "#" will be ignored". Unquoted values follow "the same backslash-escape rules as POSIX shell unquoted text", but "interior whitespace is preserved".

**DynamicUser and hardening** [22] [verified]

- **DynamicUser=yes** allocates a UID/GID from the range "61184...65519".
  > "Furthermore NoNewPrivileges= and RestrictSUIDSGID= are implicitly enabled (and cannot be disabled) ... Moreover ProtectSystem=strict and ProtectHome=read-only are implied"

  On trixie, "unless PrivateTmp= is manually set to "true", "disconnected" would be implied."
- **ProtectSystem=strict:** "the entire file system hierarchy is mounted read-only, except for the API file system subtrees /dev/, /proc/ and /sys/".
- **ProtectHome=yes:** "/home/, /root, and /run/user are made inaccessible and empty".
- **PrivateTmp=:**
  - trixie: "Takes a boolean argument, or "disconnected"".
  - bookworm: "Takes a boolean argument" only. The word "disconnected" does not appear on the bookworm page [30].
- **NoNewPrivileges=:** "ensures that the service process and all its children can never gain new privileges through execve()".

**Sample units, checked with `systemd-analyze verify`** under WSL systemd 255 [live]:

```ini
# yt-gh-mirror.service
[Unit]
Description=YouTrack to GitHub issue mirror (one run)
Wants=network-online.target
After=network-online.target
[Service]
Type=oneshot
DynamicUser=yes
LoadCredential=youtrack_token:/etc/yt-gh-mirror/youtrack_token
LoadCredential=github_token:/etc/yt-gh-mirror/github_token
EnvironmentFile=-/etc/yt-gh-mirror/config.env
WorkingDirectory=/opt/yt-gh-mirror
ExecStart=/usr/bin/node /opt/yt-gh-mirror/src/node-main.ts
TimeoutStartSec=5min
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

# yt-gh-mirror.timer
[Timer]
OnCalendar=*:0/10
Persistent=true
AccuracySec=1s
RandomizedDelaySec=30s
[Install]
WantedBy=timers.target
```

- `verify` reported no directive errors. The only error was `Command /usr/bin/node is not executable`, because Node is not installed in WSL.
- The permission-bit warnings came from the /mnt/c mount and do not affect the units.
- These values are an illustration, not a decision; see the open questions.

**journalctl** [31] [verified]

- `-u, --unit=UNIT|PATTERN` shows messages for the unit. The man page example is `journalctl -f -u apache`.
- For this project: `journalctl -u yt-gh-mirror.service -f`.
- `systemctl list-timers` shows the next elapse time [partial: standard systemctl command, not re-cited here].

### 7. Minimal toolchain

- **TypeScript version** [live]: `npm view typescript version` returns `7.0.2`. The dist-tags are `latest: 7.0.2`, `rc: 7.0.1-rc` and `next: 7.1.0-dev.20260924.1`.
- **@types/node** [live]: latest is 26.6.2; `@types/node@24` is 24.13.6.
- **TypeScript 7 release post** [24] [verified]:
  - Install with "npm install -D typescript", which provides `tsc`.
  - "target: es5 is no longer supported. downlevelIteration is no longer supported. moduleResolution: node/node10 are no longer supported". `baseUrl` is also removed.
  - `@typescript/typescript6` "provides an executable named tsc6".
- **TypeScript 6 changed defaults** [25] [verified]:
  - "In TypeScript 6.0, the default types value will be [] (an empty array)."
  - "strict is now true by default".
  - For this project, the Node tsconfig must set `"types": ["node"]` and install `@types/node`.
- **Module type** [5] [verified]:
  > "To use `import` and `export` syntax, add `"type": "module"` to the nearest parent `package.json`."
- **Minimal dev dependencies:** `typescript` and `@types/node`. Worker types are covered in the Cloudflare doc.
- **Commands:**
  - Type check: `tsc --noEmit -p tsconfig.node.json`.
  - Run: `node src/node-main.ts` on Node 24.12 or later.

## Live observations

No YouTrack or GitHub calls were made for this topic.

- `curl https://raw.githubusercontent.com/nodejs/Release/main/schedule.json | jq '{v20,v22,v24,v25,v26}'` returned the dates in section 1.
- `curl https://nodejs.org/dist/index.json` returned v26.10.0 (2026-09-21), v24.21.0 (2026-09-07, Krypton) and v22.23.3 (2026-09-23, Jod).
- `curl https://packages.debian.org/{bookworm,trixie,forky}/nodejs` returned the versions in section 5. The `-backports` pages returned the Debian Error page.
- `curl https://packages.debian.org/{bookworm,trixie}/systemd` returned 252.39-1~deb12u2 and 257.13-1~deb13u1.
- NodeSource:
  - `setup_22.x`, `setup_24.x` and `setup_26.x` returned HTTP 200.
  - `node_24.x` nodistro amd64 Packages lists 24.21.0-1nodesource1 as newest.
- `nodejs.org/dist/latest-v24.x/SHASUMS256.txt` contains the node-v24.21.0-linux-x64.tar.xz hash.
- Local runs:
  - `node --version` = v22.22.2.
  - The type-stripping and env experiments in sections 3 and 4.
  - `tsc` 7.0.2 exited 0.
  - `wrangler` 4.133.0 dry-run bundle was 0.44 KiB.
- WSL systemd 255.4:
  - `systemd-analyze calendar '*:0/10'` gave the output in section 6.
  - `systemd-analyze verify` on the sample units reported only the missing `/usr/bin/node`.
- npm: typescript 7.0.2, @types/node 26.6.2 (v24 line 24.13.6), wrangler 4.138.0.

## Undocumented / not found

- **wrangler and `.ts` specifiers:** no Cloudflare or esbuild doc explicitly states that `.ts` import specifiers are accepted. This was verified empirically only (wrangler 4.133.0).
- **NodeSource and trixie:** I could not find an official NodeSource statement naming Debian 13 as supported. The DEV_README table stops at Debian 12, and the products page is client-rendered. The researcher's quote "bookworm 12 ... trixie 13" could not be re-confirmed from page source.
- **Local-time default:** I did not capture an exact systemd.time quote for "calendar events use local time unless a timezone is given" [partial].
- **Parser differences:** neither doc compares Node's `.env` parser with systemd's `EnvironmentFile=` parser. The differences listed below are inferred from each doc separately.

## Gotchas and implications for this project

1. **Debian's own nodejs cannot run the sources.** Bookworm has 18.20.4 and trixie has 20.19.2 [11][12]. Neither has type stripping, and both lines are EOL upstream. Install Node 24 from NodeSource or a nodejs.org tarball, and require 24.12 or later, where type stripping is Stable [5].
2. **Code can pass the Worker build and still fail on Debian.** wrangler/esbuild accepts enums, parameter properties and value-imports of types; Node's type stripping crashes on them [live]. Enable `erasableSyntaxOnly` and `verbatimModuleSyntax`, and run `tsc --noEmit` before deploying either target.
3. **Import specifiers must end in `.ts`.** A missing extension gives `ERR_MODULE_NOT_FOUND` on Node [live]. With `rewriteRelativeImportExtensions`, tsc accepts `.ts` specifiers without setting `allowImportingTsExtensions` explicitly [26].
4. **A hung run blocks all later runs silently.** A oneshot has no start timeout by default [21], and the timer never starts a second instance while one is active [20]. Set `TimeoutStartSec=`, and put a timeout on every fetch, e.g. `AbortSignal.timeout`.
5. **Secrets belong in credential files, not the environment.** Environment variables are visible via D-Bus [22]. With `LoadCredential=`, the Node entrypoint must read `$CREDENTIALS_DIRECTORY/<id>` and fall back to `process.env` for local and dev runs. The Worker keeps using env bindings.
6. **Node and systemd parse env files differently.** Node treats text after `#` as a comment, even after a value [8]. systemd only ignores lines that start with `#` or `;`, and preserves interior whitespace [22], so an inline comment may end up inside the value. Keep config lines as plain `KEY=value`.
7. **`--env-file` does not override the process environment.** Values already set, for example by systemd `EnvironmentFile=`, win over the file [8].
8. **Persistent=true gives one catch-up run, not a wider window** [20]. If the host is down longer than LOOKBACK_HOURS (24h), issues outside the window stay unsynced until a BACKFILL run.
9. **ProtectHome and DynamicUser hide `$HOME`** [22]. With `ProtectHome=yes` the directories are inaccessible, so an nvm install under `~/.nvm` is invisible to the service. Put Node in `/usr/bin` (NodeSource) or `/opt`, and the app in `/opt`.
10. **`PrivateTmp=disconnected` is trixie-only** [22][30]. Use `PrivateTmp=yes` so the same unit file works on bookworm and trixie.
11. **The no-overlap guarantee covers one host only.** If the Cloudflare cron and the Debian timer are both enabled, they can race and create duplicate `[YT-n]` issues, because neither holds a lock. The default AccuracySec of 1min also means firing times differ between hosts [20].
12. **TypeScript 7 removed options and TypeScript 6 changed defaults** [24][25]. `types` now defaults to `[]`, so list `"node"` explicitly. `moduleResolution node10`, `baseUrl` and `target es5` are now errors.
13. **Node does not strip `.ts` under `node_modules`** [5]. Never share TypeScript code between targets as a `.ts` package; keep it in-repo.

## Open questions for the user

1. **Which Debian release and CPU architecture is the box, and who has root to add an apt repo?**
   Why it matters: it decides how Node is installed and whether trixie-only directives are usable.
   Options: NodeSource `node_24.x` nodistro repo; nodejs.org tarball in `/opt/node`; Docker `node:24`.
2. **Can the Worker and the Debian timer ever be enabled at the same time?**
   Why it matters: concurrent runs can create duplicate mirror issues.
   Options: strict failover, only one host enabled at a time; accept rare duplicates and handle them manually.
3. **How are secrets stored on the Debian host?**
   Why it matters: it changes the entrypoint code and the ops runbook.
   Options: `LoadCredential=` from a root-only file or `/etc/credstore`; `LoadCredentialEncrypted=` via `systemd-creds encrypt`; a `0600` `EnvironmentFile=`, which systemd discourages for secrets.
4. **What is the minimum Node version to enforce?**
   Why it matters: it sets the `engines` field and the install instructions.
   Options: `>=24.12` (Stable type stripping, EOL 2028-04-30); `>=22.18` (Release candidate on v22, EOL 2027-04-30).
5. **What should TimeoutStartSec be, and what per-request fetch timeout?**
   Why it matters: without them, a hang blocks every later run.
   Options: a short timeout such as 5min plus about 30s per request; just under the 10-min cadence, such as 9min.
6. **Should Persistent=true be set, and how are outages longer than 24h handled?**
   Why it matters: catch-up runs one sync only; it does not widen the lookback window.
   Options: Persistent=true with a manual BACKFILL after outages; Persistent=true with an automatic backfill based on a last-success marker (needs `StateDirectory=`); Persistent=false.

## Sources

1. Node.js Releases -- https://nodejs.org/en/about/previous-releases (fetched 2026-09-24)
2. nodejs/Release schedule.json -- https://raw.githubusercontent.com/nodejs/Release/main/schedule.json (fetched 2026-09-24)
3. Node.js dist index -- https://nodejs.org/dist/index.json (fetched 2026-09-24)
4. Node.js Globals: fetch -- https://nodejs.org/api/globals.html#fetch (main-branch source doc/api/globals.md)
5. Node.js Modules: TypeScript -- https://nodejs.org/api/typescript.html (v26 docs; main-branch doc/api/typescript.md)
6. Node.js v22 Modules: TypeScript -- https://nodejs.org/docs/latest-v22.x/api/typescript.html (v22.x branch source)
7. Node.js CLI: --no-strip-types -- https://nodejs.org/api/cli.html#--no-strip-types
8. Node.js CLI: --env-file / --env-file-if-exists -- https://nodejs.org/api/cli.html#--env-filefile
9. Node.js v20 CLI -- https://nodejs.org/docs/latest-v20.x/api/cli.html
10. Node.js process.loadEnvFile -- https://nodejs.org/api/process.html#processloadenvfilepath
11. Debian bookworm nodejs -- https://packages.debian.org/bookworm/nodejs
12. Debian trixie nodejs -- https://packages.debian.org/trixie/nodejs
13. Debian forky nodejs -- https://packages.debian.org/forky/nodejs
14. NodeSource distributions DEV_README -- https://raw.githubusercontent.com/nodesource/distributions/master/DEV_README.md
15. NodeSource Repository Manual Installation -- https://github.com/nodesource/distributions/wiki/Repository-Manual-Installation
16. Node.js v24 SHASUMS256 -- https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt
17. Node.js Download -- https://nodejs.org/en/download
18. systemd.time(7), Debian trixie -- https://manpages.debian.org/trixie/systemd/systemd.time.7.en.html (systemd 257)
19. systemd-analyze(1), Debian trixie -- https://manpages.debian.org/trixie/systemd/systemd-analyze.1.en.html
20. systemd.timer(5), Debian trixie -- https://manpages.debian.org/trixie/systemd/systemd.timer.5.en.html
21. systemd.service(5), Debian trixie -- https://manpages.debian.org/trixie/systemd/systemd.service.5.en.html
22. systemd.exec(5), Debian trixie -- https://manpages.debian.org/trixie/systemd/systemd.exec.5.en.html
23. systemd-creds(1), Debian trixie -- https://manpages.debian.org/trixie/systemd/systemd-creds.1.en.html
24. Announcing TypeScript 7.0 -- https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
25. Announcing TypeScript 6.0 -- https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/
26. TSConfig Reference -- https://www.typescriptlang.org/tsconfig/
27. Debian trixie systemd -- https://packages.debian.org/trixie/systemd
28. Debian bookworm systemd -- https://packages.debian.org/bookworm/systemd
29. systemd.timer(5), Debian bookworm -- https://manpages.debian.org/bookworm/systemd/systemd.timer.5.en.html (systemd 252)
30. systemd.exec(5), Debian bookworm -- https://manpages.debian.org/bookworm/systemd/systemd.exec.5.en.html (systemd 252)
31. journalctl(1), Debian trixie -- https://manpages.debian.org/trixie/systemd/journalctl.1.en.html
