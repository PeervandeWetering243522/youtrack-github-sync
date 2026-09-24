# Cloudflare Workers (Free plan): cron, limits, secrets, local testing

> Researched 2026-09-24 for the YouTrack -> GitHub mirror. Status tags: [verified] = source re-opened and quote confirmed; [live] = confirmed by a live request; [partial] = indirect/partial support; [undocumented] = not found in official docs.

All Cloudflare pages were re-fetched on 2026-09-24 through their `index.md` markdown views. "Last updated" dates come from the pages themselves. No Cloudflare account actions were taken. The local checks were `npm view`, a `wrangler deploy --dry-run` bundle build and a Node `JSON.parse` benchmark.

## TL;DR

| Question | Answer | Status | Source |
| --- | --- | --- | --- |
| Subrequests per invocation (Free) | 50 external (plus 1,000 to Cloudflare services). No split by trigger type, so Cron Triggers get the same 50. Every redirect hop counts. | [verified] | [1] [24] |
| CPU per Cron Trigger (Free) | 10 ms. `limits.cpu_ms` cannot raise it on Free. | [verified] | [1] [2] [3] |
| Waiting on fetch counts as CPU? | No. It does count toward wall time. | [verified] | [1] |
| Wall-clock limit for a scheduled run | 15 minutes per invocation | [verified] | [1] [5] |
| Memory | 128 MB per isolate (Free and Paid) | [verified] | [1] |
| Cron Triggers per account (Free) | 5 (Paid 250) | [verified] | [1] |
| Daily requests (Free) | 100,000/day, reset at midnight UTC. Whether cron runs count is not stated explicitly; the pricing example bills an hourly cron as 720 requests/month. | [verified] / [partial] | [1] [2] |
| Worker size / startup | 64 MiB uncompressed on all plans (compressed limit removed 2026-09-04). Global scope must finish within 1 s. | [verified] | [1] [27] [28] |
| Cron config | `"triggers": { "crons": ["*/10 * * * *"] }` / `[triggers] crons = ["*/10 * * * *"]`. Runs on UTC. | [verified] | [3] [4] |
| Cron propagation after deploy | Up to 15 min. Past Cron Events can take up to 30 min to appear for a new Worker. | [verified] | [4] |
| Retry on throw | Not documented. `controller.noRetry()` exists in the runtime and types, so retries are possible. | [undocumented] / [partial] | [5] [36] [37] |
| Overlapping runs | Not documented | [undocumented] | - |
| Handler signature | `scheduled(controller, env, ctx)`; controller has `cron`, `scheduledTime`, `noRetry()` | [verified] | [5] [36] [37] |
| Types | Generate with `wrangler types` (recommended). `@cloudflare/workers-types` is still published (5.20260924.1). | [verified] [live] | [11] [32] [50] |
| Secrets | `wrangler secret put KEY` (creates and deploys a new version). Non-secret config goes in `vars`. | [verified] | [6] [7] [8] |
| Local secrets | `.dev.vars` or `.env`, not both. If `.dev.vars` exists, `.env` is ignored for `env`. | [verified] | [7] [9] |
| TypeScript build | Wrangler bundles `./src/index.ts` with esbuild; no type-checking. Explicit `.ts` import extensions bundle fine. | [verified] [live] | [3] [12] [45] |
| No public URL | Set both `workers_dev: false` and `preview_urls: false` | [verified] | [3] [14] [15] |
| Local cron test URL | `http://localhost:8787/cdn-cgi/local/scheduled?cron=*/10+*+*+*+*&format=json` (`wrangler dev --test-scheduled`) | [verified] | [4] [6] |
| Logs (Free) | Workers Logs: 200,000 events/day, 3-day retention, 256 KB per log. `wrangler tail` for live logs. | [verified] | [18] [1] [6] |
| Default User-Agent on fetch | Not documented by Cloudflare. Community reports say none is sent. GitHub rejects requests without one, so always set it. | [undocumented] / [partial] | [38] [39] [40] |
| Outbound fetch timeout | No set time limit per subrequest. Use `AbortSignal.timeout()`. | [verified] | [1] [22] |
| Wrangler version / Node | 4.138.0; `engines.node >=22.0.0` | [live] | [50] [23] |

## Details

### 1. Workers Free plan limits

The Limits page shows "Last updated Sep 5, 2026" [1].

- **Subrequests.** The limit is 50 per invocation on Free and 10,000 on Paid, which can be raised to 10M [1]. The table has no per-trigger-type split, so Cron Triggers share the same limit.
  > "Subrequests per invocation | 50 | 10,000 (up to 10M)" [1]
  > "Each subrequest in a redirect chain counts against this limit." [1]

  The `limits.subrequests` key defaults to 50 on Free and is capped at 50 there [3]:
  > "This value defaults to 50 for free accounts and 10,000 for paid accounts. The free account maximum is 50" [3]
- **CPU per Cron Trigger.** Free gets 10 ms. Paid gets 30 s for intervals under 1 hour, or 15 min for intervals of 1 hour or more [1].
  > "CPU time per Cron Trigger | 10 ms | 30 seconds (< 1 hour interval)" [1]

  Pricing states the same Free figure: "10 milliseconds of CPU time per invocation" [2]. `limits` config: "Limits are only supported for the Standard Usage Model." [3]. There is a small grace margin: "Each isolate has some built-in flexibility to allow for cases where your Worker infrequently runs over the configured limit." [1]. For Paid only, the limits page (30 s / 15 min) and the pricing page ("Max of 15 minutes of CPU time per Cron Trigger") are worded differently [2]. This does not affect Free.
- **Wall clock.** > "Scheduled Workers have a maximum wall time of 15 minutes per invocation." [1]. The Duration table lists "Cron Trigger | 15 min" with no Free/Paid split [1].
- **Memory.** > "Each isolate can consume up to 128 MB of memory, including the JavaScript heap and WebAssembly allocations." [1]. This limit applies per isolate, not per invocation [1].
- **Cron Triggers.** > "Number of Cron Triggers per account | 5 | 250" [1] (Free | Paid). The Cron Triggers page instead says "maximum number of Cron Triggers per Worker" [4]. That wording conflicts with the table. We need only one trigger.
- **Daily requests.** > "Accounts on the Workers Free plan have a daily request limit of 100,000 requests, resetting at midnight UTC. When a Worker exceeds this limit, Cloudflare returns Error 1027." [1]. No page says outright whether cron runs count. Pricing Example 3 describes "A Worker that runs on a Cron Trigger once an hour" and bills it as "720 requests/month" [2], which implies each cron run is billed as a request [partial]. A 10-minute cron is 144 runs/day, far below the limit either way. "Cloudflare does not bill for subrequests you make from your Worker." [2]
- **Size and startup.** "Worker size (uncompressed) | 64 MiB | 64 MiB" [1]. On 2026-09-04: > "Previously, Cloudflare checked that compressed size and rejected deploys over 3 MB (Free) or 10 MB (Paid). That limit has been removed." [27]. Startup: "A Worker must parse and execute its global scope ... within 1 second." [1], raised from 400 ms on 2025-10-10 [28]. Environment variables: 64 per Worker on Free, 5 KB each [1].
- **2025-2026 changelog check.**
  - 2026-02-11: > "Workers on the free plan remain limited to 50 external subrequests and 1000 subrequests to Cloudflare services per invocation." [24] The Paid default became 10,000.
  - 2025-03-25 (page dated March 26, 2025): Paid can opt in to up to 5 min of CPU; "By default, Workers are still limited to 30 seconds of CPU time." [25]
  - 2026-04-09: the six-connection limit now applies only while a connection waits for response headers. This removed the `Response closed due to connection limit` exception [26].
  - No 2025-2026 change to the Free 10 ms CPU limit or the Free 50 subrequests was found.

### 2. CPU vs. waiting; parsing cost; exceeding limits

- > "Waiting on network requests (such as fetch() calls, KV reads, or database queries) does not count toward CPU time." [1]
- A Worker cannot measure its own CPU use: `performance.now()` "returns the time of the last I/O and does not advance during code execution ... performance.now() will always equal Date.now()" [21]. Actual usage appears in logs: "Workers Logs — CPU time and wall time appear in the invocation log." [1]
- **JSON.parse cost.** Cloudflare gives no per-KB figure [undocumented]. It does say: > "Heavier workloads that handle authentication, server-side rendering, or parse large payloads typically use 10-20 ms." [1]. Local rerun [live, local Node v22.22.2, not Cloudflare hardware]: a 283,471-byte synthetic GitHub-issues-shaped array (100 objects) parsed in 0.72 ms on average (50 warm runs), and 1.57 ms for a single cold-ish parse. Our volumes are small (29 YouTrack issues, well under 100 GitHub issues), but the 10 ms budget is tight enough that `fields=` should stay minimal and each body should be parsed once.
- **CPU exceeded.** > "When a Worker exceeds its CPU time limit, Cloudflare returns Error 1102 to the client with the message `Worker exceeded resource limits`. In the dashboard, this appears as `Exceeded CPU Time Limits` under Metrics > Errors > Invocation Statuses. In analytics and Logpush, the invocation outcome is `exceededCpu`." [1]. A cron run has no client, so the outcome is visible only in Cron Events, Logs and analytics. Two things are undocumented: whether the handler sees an exception, and whether a killed cron run is retried.
- **Subrequest limit exceeded.** The official docs give no error type or message [undocumented]. Community reports show the over-limit `fetch()` throws. One report from 2026 is titled "Too many subrequests by single Worker invocation" [41]. A 2022 report quotes "Too many subrequests. Workers can make up to 50 subrequests per request." [42]. That issue now lives at workers-sdk#2084; the wrangler2 URL returns 404. Do not match on the message text. Also: > "Limits are only enforced when deployed to Cloudflare's network, not in local development." [3]

### 3. Cron Triggers

- **Syntax** [4] [3]:
  ```jsonc
  { "triggers": { "crons": ["*/10 * * * *"] } }
  ```
  ```toml
  [triggers]
  crons = [ "*/10 * * * *" ]
  ```
  Per-environment triggers go under `env.<name>.triggers` (`[env.dev.triggers]`) [4]. > "When deploying a Worker with Wrangler any previous Cron Triggers are replaced with those specified in the `triggers` array." [4]. An empty array removes all triggers. If `triggers` or `crons` is undefined, the deployed triggers stay in place [4]. > "To disable a Cron Trigger, set `crons = []`. Commenting out the `crons` key will not disable a Cron Trigger." [3]. > "Cloudflare recommends using `wrangler.jsonc` for new projects" [3].
- **Expressions.** > "Cloudflare supports cron expressions with five fields, along with most Quartz scheduler-like cron syntax extensions" [4]. Supported extras: `L`, `W` and `#`, plus 3-letter month and weekday names. > "Days of the week go from 1 = Sunday to 7 = Saturday" [4]. This differs from Unix cron. `*/30 * * * *` is a documented example, and `*/3` appears in a config example [4].
- **Timezone.** > "Cron Triggers execute on UTC time." [4]
- **Propagation.** Adding, changing or deleting a trigger "may take several minutes (up to 15 minutes) to propagate to the Cloudflare global network." [4]. > "It can take up to 30 minutes before events are displayed in Past Cron Events when creating a new Worker or changing a Worker's name." [4]
- **Throwing and retries.** > "The first `ctx.waitUntil` to fail will be observed and recorded as the status in the Cron Trigger Past Events table. Otherwise, it will be reported as a success." [5]. Cloudflare docs say nothing about whether production retries a failed run [undocumented]. The runtime does expose `noRetry()`: workerd `ScheduledController` declares `JSG_METHOD(noRetry)` [36], workers-types declares `noRetry(): void` [37], and the local test route reports `"noRetry": false` [4]. That points to a retry mechanism existing [partial]. One third-party PR (not authoritative) claims "Workers replays the whole handler, not the tasks that failed" [44].
- **Overlap.** No page says whether a new firing waits for a still-running one [undocumented]. The 15-minute wall limit is longer than the 10-minute interval. Also: "Workers scheduled by Cron Triggers will run on underutilized machines" [4].
- **Past events.** Dashboard path: Workers & Pages > Worker > Settings > Trigger Events > View events. > "Cron Events stores the 100 most recent invocations of the Cron scheduled event." [4]. At a 10-minute interval that is about 16.7 hours. Workers Logs records cron invocations with longer retention; the logs page shows the message for Cron as `<UNIX-cron schedule>` [18]. The GraphQL Analytics API is the programmatic option [4].

### 4. scheduled handler and types

- **Signature** (ES modules) [5]:
  ```ts
  export default {
    async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) { /* ... */ },
  } satisfies ExportedHandler<Env>;
  ```
- **Controller properties.** The docs list three: `controller.cron`, `controller.type` ("This will always return \"scheduled\"") and `controller.scheduledTime` ("milliseconds since January 1, 1970, UTC") [5]. > "The value of `controller.cron` is the exact cron expression string from your configuration. It must match character-for-character, including spacing." [5]
  - **Discrepancy [verified].** The current types (`@cloudflare/workers-types@5.20260924.1`) and workerd `scheduled.h` define only `scheduledTime`, `cron` and `noRetry()` [36] [37]. There is no `type`, so do not use `controller.type`.
- **ctx.waitUntil.** > "The runtime waits for the promise returned by the `scheduled()` handler to resolve (up to the 15-minute duration limit). You do not need to use `waitUntil()` for the runtime to wait for a single asynchronous task." [5]. Do not destructure `ctx`: "destructuring ctx makes waitUntil lose its 'this' reference", which causes `TypeError: Illegal invocation` [16].
- **Types.** > "We recommend you use `wrangler types` to generate runtime types, rather than using the `@cloudflare/workers-types` package" [11]. `wrangler types` writes `worker-configuration.d.ts` with Env and runtime types, and the file goes in `compilerOptions.types` [11]. Wrangler 3.66-3.x needed `--experimental-include-runtime` [6]. `--check` "Exits with code 0 if types are up-to-date, or code 1 if types are out-of-date." [6]. The package is still maintained: "There are no plans to stop publishing the `@cloudflare/workers-types` package" [11]. v5 (2026-07-03) exposes only the latest runtime types [32]. `npm view @cloudflare/workers-types version` returned `5.20260924.1` [live]. With `nodejs_compat`, install `@types/node` and use `"types": ["./worker-configuration.d.ts", "node"]` [11]. When `secrets` is declared, `wrangler types` "generates typed bindings from the names listed in `secrets.required` and no longer infers secret names from `.dev.vars` or `.env` files." [3]

### 5. Config: vars, secrets, local dev files, compatibility_date, TypeScript

- **vars.** > "Text strings and JSON values are not encrypted and are useful for storing application configuration." [8]. `vars` is non-inheritable, so every named environment must repeat it [8]. In a dry-run, `"LOOKBACK_HOURS": 24` showed up as binding `env.LOOKBACK_HOURS (24)` [live, dry-run only]. Its runtime `typeof` was not observed. Keeping values as strings and parsing them explicitly avoids the question.
- **Secrets.** Set one with `npx wrangler secret put <KEY>`, which prompts for the value. "The `put` command can also receive piped input." [6]. > "`wrangler secret put` creates a new version of the Worker and deploys it immediately." [7]. `wrangler versions secret put` only creates a version [7]. For many secrets at once: `wrangler secret bulk` ("up to 100 secrets per command") [6], or `wrangler deploy --secrets-file` [7]. > "Wrangler will not delete your secrets (encrypted environment variables) unless you run `wrangler secret delete <key>`." [3]. In code, "Secrets can be accessed from Workers as you would any other environment variables" [7]. The researcher's quote "To your Worker, there is no difference..." is not on the page and has been replaced here. With `secrets.required` declared, deploy fails if any listed secret is missing [3].
- **Local files.** > "Put secrets for use in local development in either a `.dev.vars` file or a `.env` file, in the same directory as the Wrangler configuration file." [7]. > "If you define a `.dev.vars` file, then values in `.env` files will not be included in the `env` object during local development." [9]. `.env` support arrived on 2025-08-08: "use `.env` files to provide secrets and override environment variables on the `env` object during local development" [31]. `.env` precedence: `.env.<env>.local` > `.env.local` > `.env.<env>` > `.env` [7]. Setting `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV="false"` disables `.env` loading [7]. > "When defined, only the keys listed in `secrets.required` are loaded from `.dev.vars` or `.env`." [7]. Wrangler also reads `.env` for its own system variables, such as `CLOUDFLARE_API_TOKEN` and `WRANGLER_SEND_METRICS` [10]. Do not commit `.dev.vars*` or `.env*` [7].
- **compatibility_date.** It is required [3]. > "When you start your project, you should always set `compatibility_date` to the current date." [13]. > "Workers now enable the `nodejs_compat` and `nodejs_compat_v2` compatibility flags by default for compatibility dates of `2026-08-04` or later." [29]. With `nodejs_compat_populate_process_env` (default from 2025-04-01), vars and secrets are also on `process.env` [8]. `process.env` "will be populated lazily the first time that `process` is accessed". > "JSON variable values that do not evaluate to string values are exposed as the raw JSON string." [8]
- **TypeScript without a build step.** > "By default, Wrangler bundles your Worker code using `esbuild`." [12]. `main` can point at a TS file: "For example: `./src/index.ts`." [3]. esbuild "does not do any type checking so you will still need to run tsc -noEmit in parallel" [45].
  - **Explicit `.ts` imports [live].** Cloudflare docs don't cover them. A local `wrangler deploy --dry-run --outdir dist` (wrangler 4.133.0, esbuild 0.28.1) with `import { label } from "./util.ts"` bundled without error ("Total Upload: 0.60 KiB"), and the output inlined `util.ts`.
  - **Node side.** Node's type stripping requires explicit extensions ("file extensions are mandatory in `import` statements") and "Node.js ignores `tsconfig.json` files" [46]. It has been on by default since v23.6.0 / v22.18.0 [46].

### 6. No public HTTP route

- > "If you have a Worker that is only for `scheduled` events, you can set this to `false`. Defaults to `true`." (`workers_dev`) [3]
- > "Disabling your `workers.dev` route does not disable Version URLs, Preview URLs, or Deployment URLs." [14]. `preview_urls`: "If omitted, Wrangler does not change an existing setting. If no setting exists, its initial value depends on `workers_dev`." [3] [15]
- Disabling workers.dev only in the dashboard doesn't last: "the `workers.dev` route will be re-enabled the next time you deploy your Worker with Wrangler." [14]
- A Worker with only `scheduled` is valid. Error `10068` fires only when "The uploaded Worker has no registered event handlers." [16], and "Scheduled Handler" is a listed handler [17]. How production answers HTTP requests to such a Worker is [undocumented]. In local dev, a 2023 report shows a 500 with "Handler does not export a fetch() function" [43] [partial, old]. A later wrangler change injects a 404 for `favicon.ico` on scheduled-only Workers [34].

### 7. Local testing

- `wrangler dev --test-scheduled`: > "Exposes a `/cdn-cgi/local/scheduled` fetch route which will trigger a scheduled event (Cron Trigger) for testing during development." [6]. The Cron Triggers page says plain `wrangler dev` exposes the route [4]. Passing the flag works in both readings.
- Documented URLs [4]:
  - `curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*&time=1745856238000"`, where `time` overrides `controller.scheduledTime`
  - `?format=json` returns `{"outcome":"ok","noRetry":false}`
  - Spaces in `cron` are written as `+`, so ours is `?cron=*/10+*+*+*+*`
- **Route history.**
  - Wrangler 2.x used `/__scheduled`: "This exposes a route `/__scheduled`" [34].
  - Wrangler 4.117.0 (npm publish 2026-07-31) moved to `/cdn-cgi/local/scheduled`, and "`wrangler dev` and the Vite plugin now transparently rewrite the old paths to the new ones" for `/cdn-cgi/handler/scheduled` and `/cdn-cgi/mf/scheduled` [34].
  - Miniflare v5 itself lists "`/cdn-cgi/mf/scheduled` → removed" [35]. The changelog post says "Moved local-only /cdn-cgi routes under /cdn-cgi/local." [30]
- Local runtime runs with `TZ=UTC` [6]. Limits are not enforced locally [3]. Crons do not fire on schedule locally [partial: the docs only describe manual triggering].
- A live `wrangler dev` attempt in this environment failed ("The Workers runtime failed to start"), so the routes were not exercised live. The claims above rest on the docs.

### 8. Logging

- **`wrangler tail [WORKER]`** [6]. Options:
  - `--format "json" | "pretty"` (the page gives no default)
  - `--status "ok" | "error" | "canceled"`
  - `--search` (text in console.log)
  - `--sampling-rate`
  - `--version-id`
  - `--header`, `--method` and `--ip`, which are HTTP-oriented
  > "The output of each `wrangler tail` log is a structured JSON object" [19]. The example object has `outcome`, `scriptName`, `exceptions`, `logs`, `eventTimestamp` and `event` [19], but it shows a fetch event. For a cron event, workers-types defines `TraceItemScheduledEventInfo { scheduledTime; cron }` [37] [partial]. > "A maximum of 10 clients can view a Worker's logs at one time." [19]. Sampling mode can kick in under high volume [19].
- **Workers Logs config:** `"observability": { "enabled": true, "head_sampling_rate": 1 }`. `enabled` "Defaults to `true` for all new Workers", and `head_sampling_rate` defaults to 1 [3]. Minimum Wrangler 3.78.6 [18].
- **Free quota:** "Workers Free | 200,000 per day | 3 Days" [18]. The maximum retention is 7 days, on Paid [18]. Each invocation emits one invocation log plus one event per `console.log` [18].
- **Size:** "Log data per request | 256 KB" [1]. > "Logs exceeding that size will be truncated and the log's `$cloudflare.truncated` field will be set to true." [18]
- **Other changes.** Since 2026-08-24, logged exceptions include name, message and stack [33]. Tracing: > "Starting on October 1, 2026, tracing will be billed as part of your usage on the Workers Free Paid and Enterprise plans." [20]. Traces share the Workers Logs quota [20].

### 9. fetch specifics

- **User-Agent.** Cloudflare docs do not say whether Workers `fetch` sends a default User-Agent [undocumented]. `navigator.userAgent` is `'Cloudflare-Workers'` [21], but that is a JS property, not a request header. Community evidence says the production runtime sends no UA. Miniflare #139: "The Workers runtime and miniflare send different default headers, meaning that when calling some external APIs (e.g. Github's which requires a `User-Agent` header for all requests" [39]. next-auth #6741: "no user-agent http header was provided in the request" [40]. GitHub: > "Requests with no `User-Agent` header will be rejected." [38]. Set `User-Agent` explicitly on every GitHub request.
- **Timeouts.** > "There is no set time limit on individual subrequests." [1]. For cron runs the ceiling is the 15-minute wall limit [1]. Network-level connect and idle timeouts are [undocumented]. `AbortSignal.timeout(delay)` has been available since 2021-12-10 [22]. > "Each Worker invocation can have up to six connections simultaneously waiting for response headers." [1]

### 10. Wrangler version and Node

- [live] `npm view wrangler version` returned `4.138.0` (modified 2026-09-24T10:39:29Z), and `engines` is `{ node: '>=22.0.0' }` [50].
- > "We support running the Wrangler CLI with the Current, Active, and Maintenance versions of Node.js." [23]
- > "Wrangler is only supported on macOS 13.5+, Windows 11, and Linux distros that support glib 2.35." [23] ("glib" sic, meaning glibc)
- Debian 12's libc6 is `2.36-9+deb12u14` [49].
- Debian stock Node: bookworm `18.20.4+dfsg-1~deb12u2` [48], trixie `20.19.2+dfsg-1+deb13u2` [47]. Both are below wrangler's `>=22` and below the Node versions that strip TS types by default (22.18.0 / 23.6.0) [46]. Wrangler is only needed on the machine that deploys.

## Live observations

No YouTrack or GitHub API calls were made for this topic. All checks ran locally or against public registries and docs:

- `npm view wrangler version` returned `4.138.0`; `npm view wrangler engines` returned `{ node: '>=22.0.0' }`; `npm view wrangler time` gives `4.117.0` published 2026-07-31T10:31Z.
- `npm view @cloudflare/workers-types version` returned `5.20260924.1`. Its `index.d.ts` defines `ScheduledController { readonly scheduledTime: number; readonly cron: string; noRetry(): void; }`.
- `wrangler deploy --dry-run --outdir dist` (local wrangler 4.133.0, bundled esbuild 0.28.1) on a Worker with `main: src/index.ts`, an explicit `./util.ts` import, `workers_dev: false`, `preview_urls: false`, `triggers.crons: ["*/10 * * * *"]` and `compatibility_date: 2026-09-24`: it succeeded with "Total Upload: 0.60 KiB / gzip: 0.38 KiB", and `util.ts` was inlined in `dist/index.js`.
- `wrangler dev --test-scheduled` failed to start the local workerd runtime in this sandbox, so no scheduled route was exercised.
- Node v22.22.2: `JSON.parse` of 283,471 bytes (100 issue-shaped objects) took 0.72 ms on average warm and 1.57 ms cold-ish.

## Undocumented / not found

- Whether cron invocations count toward the Free 100,000/day limit, and what happens to crons once the limit is exhausted. The pricing example only implies they count.
- Whether Cloudflare retries a failed or throwing scheduled invocation, and the retry count or backoff. Only the existence of `noRetry()` is known.
- Whether cron invocations can overlap, and how precisely they fire.
- The exception type and message when the 50-subrequest limit is hit. Community text: "Too many subrequests by single Worker invocation".
- What the handler observes when CPU is exceeded in a scheduled run.
- Default outgoing `User-Agent` on Workers `fetch`.
- Network-level connect or idle timeouts for outbound fetch.
- How production answers an HTTP request to a Worker without a `fetch` handler.
- `controller.type`: documented on [5] but absent from the runtime (workerd) and the types.
- Explicit `.ts` import extensions in Wrangler bundling: not in the docs, but confirmed working by dry-run.
- Default `--format` for `wrangler tail`.
- Refuted or corrected researcher details:
  - The secrets-page quote "To your Worker, there is no difference between an environment variable and a secret." is not on the page; the docs say secrets are accessed "as you would any other environment variables".
  - The wrangler2 issue URL now 404s; the issue is `cloudflare/workers-sdk#2084`.
  - The CPU changelog post slug says 2025-03-25, but the page is dated March 26, 2025.

## Gotchas and implications for this project

1. **The 50-subrequest cap covers all fetches.** GitHub list pages, YouTrack pages, creates, closes and redirect hops all count. A "create then close" costs 2. `MAX_WRITES_PER_RUN=30` plus pagination leaves little headroom. The limit is not enforced in `wrangler dev`, so count every fetch in code against a budget below 50.
2. **Always send `User-Agent`.** GitHub rejects requests without it, and the Workers runtime does not document a default.
3. **10 ms CPU.** Network waits are free, but parsing and string work are not. Keep `fields=` narrow and parse each body once. Current volumes are fine.
4. **Retries are possible and undocumented, and overlap is undocumented.** A run must be idempotent: re-list GitHub state before any write, and dedupe by the `[YT-n]` title. Put `AbortSignal.timeout` on every fetch so a hung YouTrack call cannot stretch a run toward 15 min.
5. **Close every public URL.** Set both `workers_dev: false` and `preview_urls: false` in config, not only in the dashboard.
6. **The local scheduled route was renamed.** Use `/cdn-cgi/local/scheduled`. Older posts use `/__scheduled`, `/cdn-cgi/mf/scheduled` or `/cdn-cgi/handler/scheduled`. `wrangler dev` still rewrites the last two, but Miniflare directly does not.
7. **Don't use `controller.type`.** Use `cron` and `scheduledTime`.
8. **The existing project `.env` is auto-loaded by wrangler.** Wrangler reads it for its own settings, and in local dev also loads it into `env`, where it overrides `vars`. Adding a `.dev.vars` later silently stops `.env` values from reaching `env`. With `secrets.required`, only the listed keys are loaded.
9. **Compatibility date 2026-08-04 or later turns on `nodejs_compat`.** `process.env` is then populated too. Non-string JSON vars become raw JSON strings there, so keep every var a string.
10. **Cron changes and history lag.** Allow up to 15 min for propagation and up to 30 min before the first Past Cron Events appear. The events view keeps only 100 entries (about 16.7 h); Workers Logs keeps 3 days on Free.
11. **The Debian runner cannot run wrangler, or TypeScript directly, on stock Node.** Stock Debian Node (18/20) is too old for wrangler and for default type stripping. That leaves two paths: a bundled JS build for Node, or Node 22.18+ from outside Debian main. Explicit `.ts` imports work on both sides; Node requires them, and wrangler/esbuild accepts them.
12. **`limits` on Free is ambiguous.** The docs say "Limits are only supported for the Standard Usage Model", yet also give a Free maximum for `limits.subrequests`. Don't rely on `limits.subrequests` as a safety cap on Free; enforce the budget in code.

## Open questions for the user

1. **Should the handler call `controller.noRetry()`?**
   - Options: never, relying on idempotency / only after the first GitHub write / always, relying on the next 10-minute tick.
   - Why it matters: retry behavior is undocumented, and a retry spends another 50-subrequest budget.
2. **How should the per-run budget be defined?**
   - Options: `MAX_WRITES_PER_RUN` only, with bounded read pages / an additional `MAX_SUBREQUESTS` (e.g. 45) checked before every fetch / a lower write cap on Workers than on Node.
3. **What should the handler do when a run partly fails?**
   - Options: throw on any failure / throw only when no progress was made / never throw and log structured errors.
   - Why it matters: throwing shows up in Past Events but may trigger undocumented retries.
4. **Which file should hold local dev secrets?**
   - Options: reuse the existing `.env` (shared with the Node script) with `secrets.required` / a separate `.dev.vars` for wrangler.
5. **How will the Debian runner execute TypeScript?**
   - Options: Node 22.18+ type stripping with explicit `.ts` imports (tsc `allowImportingTsExtensions` + `noEmit`) / an esbuild bundle run on stock Node / tsc emit with `rewriteRelativeImportExtensions`.
6. **Which compatibility_date?**
   - Options: 2026-09-24, which makes `nodejs_compat` implicit and `process.env` available / a date before 2026-08-04, passing config only through `env`.
7. **What observability settings?**
   - Options: `observability.enabled=true`, `head_sampling_rate=1`, tracing off / also enable tracing, billed from 2026-10-01 against the same quota.

## Sources

1. Limits -- https://developers.cloudflare.com/workers/platform/limits/ (last updated Sep 5, 2026)
2. Pricing -- https://developers.cloudflare.com/workers/platform/pricing/ (last updated Aug 28, 2026)
3. Wrangler configuration -- https://developers.cloudflare.com/workers/wrangler/configuration/ (last updated Sep 22, 2026)
4. Cron Triggers -- https://developers.cloudflare.com/workers/configuration/cron-triggers/ (last updated Sep 4, 2026)
5. Scheduled Handler -- https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/ (last updated Sep 4, 2026)
6. Wrangler commands (Workers) -- https://developers.cloudflare.com/workers/wrangler/commands/workers/ (last updated Sep 22, 2026)
7. Secrets -- https://developers.cloudflare.com/workers/configuration/secrets/ (last updated Jul 3, 2026)
8. Environment variables -- https://developers.cloudflare.com/workers/configuration/environment-variables/ (last updated Aug 21, 2026)
9. Local development: environment variables and secrets -- https://developers.cloudflare.com/workers/local-development/environment-variables/ (last updated Jun 25, 2026)
10. Wrangler system environment variables -- https://developers.cloudflare.com/workers/wrangler/system-environment-variables/ (last updated Aug 28, 2026)
11. TypeScript -- https://developers.cloudflare.com/workers/languages/typescript/ (last updated Jul 3, 2026)
12. Bundling -- https://developers.cloudflare.com/workers/wrangler/bundling/
13. Compatibility dates -- https://developers.cloudflare.com/workers/configuration/compatibility-dates/
14. workers.dev -- https://developers.cloudflare.com/workers/configuration/routing/workers-dev/ (last updated Sep 22, 2026)
15. Version URLs -- https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/ (last updated Sep 22, 2026)
16. Errors and exceptions -- https://developers.cloudflare.com/workers/observability/errors/ (last updated Jun 16, 2026)
17. Handlers -- https://developers.cloudflare.com/workers/runtime-apis/handlers/ (last updated Apr 23, 2026)
18. Workers Logs -- https://developers.cloudflare.com/workers/observability/logs/workers-logs/ (last updated Aug 11, 2026)
19. Real-time logs -- https://developers.cloudflare.com/workers/observability/logs/real-time-logs/ (last updated Jun 25, 2026)
20. Traces -- https://developers.cloudflare.com/workers/observability/traces/ (last updated Sep 17, 2026)
21. Web standards -- https://developers.cloudflare.com/workers/runtime-apis/web-standards/
22. Workers historical changelog (2021-12-10 entry) -- https://developers.cloudflare.com/workers/platform/changelog/historical-changelog/
23. Install/Update Wrangler -- https://developers.cloudflare.com/workers/wrangler/install-and-update/ (last updated Jul 21, 2026)
24. Changelog: Workers are no longer limited to 1000 subrequests (Feb 11, 2026) -- https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/
25. Changelog: Run Workers for up to 5 minutes of CPU-time (Mar 26, 2025) -- https://developers.cloudflare.com/changelog/post/2025-03-25-higher-cpu-limits/
26. Changelog: Relaxed simultaneous connection limiting (Apr 9, 2026) -- https://developers.cloudflare.com/changelog/post/2026-04-09-relaxed-connection-limiting/
27. Changelog: Deploy larger Workers, up to 64 MiB (Sep 4, 2026) -- https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/
28. Changelog: Worker startup time limit increased to 1 second (Oct 10, 2025) -- https://developers.cloudflare.com/changelog/post/2025-10-10-increased-startup-time/
29. Changelog: Node.js compatibility is now enabled by default (Aug 4, 2026) -- https://developers.cloudflare.com/changelog/post/2026-08-04-nodejs-compat-default/
30. Changelog: Miniflare v5 (Sep 8, 2026) -- https://developers.cloudflare.com/changelog/post/2026-09-08-miniflare-v5/
31. Changelog: `.env` files in local development (Aug 8, 2025) -- https://developers.cloudflare.com/changelog/post/2025-08-08-dot-env-in-local-dev/
32. Changelog: @cloudflare/workers-types v5 (Jul 3, 2026) -- https://developers.cloudflare.com/changelog/post/2026-07-03-workers-types-v5/
33. Changelog: Preserve exception details in console logs (Aug 24, 2026) -- https://developers.cloudflare.com/changelog/post/2026-08-24-preserve-exception-info/
34. wrangler CHANGELOG.md (4.117.0 path rewrite; 2.x `/__scheduled`; favicon 404) -- https://raw.githubusercontent.com/cloudflare/workers-sdk/main/packages/wrangler/CHANGELOG.md
35. miniflare CHANGELOG.md (v5 route moves) -- https://raw.githubusercontent.com/cloudflare/workers-sdk/main/packages/miniflare/CHANGELOG.md
36. workerd `scheduled.h` -- https://raw.githubusercontent.com/cloudflare/workerd/main/src/workerd/api/scheduled.h
37. @cloudflare/workers-types 5.20260924.1 `index.d.ts` -- https://cdn.jsdelivr.net/npm/@cloudflare/workers-types@5.20260924.1/index.d.ts
38. GitHub REST: Getting started (User-Agent required) -- https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api
39. miniflare #139: Default fetch request headers differ -- https://github.com/cloudflare/miniflare/issues/139
40. next-auth #6741: missing user-agent header on Cloudflare -- https://github.com/nextauthjs/next-auth/issues/6741
41. qsl-worker #5: "Too many subrequests by single Worker invocation" -- https://github.com/query-store-links/qsl-worker/issues/5
42. workers-sdk #2084 (formerly wrangler2 #2084): old subrequest error text -- https://github.com/cloudflare/workers-sdk/issues/2084
43. workers-sdk #4653: no fetch handler error in dev (Dec 2023) -- https://github.com/cloudflare/workers-sdk/issues/4653
44. plumix PR #2420 (third-party, cron replay claim) -- https://github.com/withplumix/plumix/pull/2420
45. esbuild content types (TypeScript caveats) -- https://esbuild.github.io/content-types/
46. Node.js Modules: TypeScript (v26.10.0 docs) -- https://nodejs.org/api/typescript.html
47. Debian trixie nodejs -- https://packages.debian.org/trixie/nodejs
48. Debian bookworm nodejs -- https://packages.debian.org/bookworm/nodejs
49. Debian bookworm libc6 -- https://packages.debian.org/bookworm/libc6
50. npm registry, wrangler (via `npm view wrangler version engines time`) -- https://www.npmjs.com/package/wrangler
