# YouTrack REST API: /api/issues and the Issue schema

> Researched 2026-09-24 for the YouTrack -> GitHub mirror (YouTrack Server 2025.2 at https://youtrack.ai.buas.nl, project CUI). Status tags: [verified] = source re-opened and quote confirmed; [live] = confirmed by a live request; [partial] = indirect/partial support; [undocumented] = not found in official docs.

Note on sources: the devportal pages (`/help/youtrack/devportal/...`) are shared by Cloud and Server and are not versioned. Several are dated 2026, which is newer than this 2025.2 server. Where they overlap, the instance's own OpenAPI spec (`youtrack-openapi.json`, `info.version` "2025.2") was used as the tie-breaker [1].

## TL;DR

| Question | Answer | Status | Source |
|---|---|---|---|
| List endpoint | `GET /api/issues` with query params `query`, `customFields`, `fields`, `$skip`, `$top`. None of them is marked required. The only response is 200: an array of `Issue`. | [verified] | [1][2] |
| Single issue | `GET /api/issues/{id}` with `id` (path, required) and `fields`. `id` can be a database id or a readable id (`CUI-5`). | [verified] [live] | [1][3] |
| Default fields | With no `fields` parameter, you get only `$type` and `id`. The spec's long `default` for `fields` does not reflect this. | [verified] [live] | [4] |
| Nullability | The spec has 0 `nullable` markers. Live, `resolved` is null when unresolved and `description` is null when empty. The docs say "Can be null" for `summary`, `description`, `resolved` and `project`. | [verified] [live] | [1][2][5] |
| `usesMarkdown` | Not in the spec or the entity docs. Live it returns boolean `true` for all 29 CUI issues. | [live] [undocumented] | [1][5] |
| Default page size without `$top` | The docs contradict each other: 42 (Pagination page) vs "Max issues to export" (Issues page; default 500 on Server 2025.2). It can't be observed here because the token sees only 29 issues. Always send `$top`. | [verified] [partial] | [2][6][7] |
| Max `$top` | Not documented. Live, `$top=100000` is accepted, `$top=0` returns `[]`, and `$top=abc` returns HTTP 500. | [undocumented] [live] | [6] |
| Default sort | `sort by: updated desc` | [verified] | [2] |
| Page stability | Not documented. Live, 3 pages of 10 matched the single `$top=1000` result. | [undocumented] [live] | [6] |
| Auth | `Authorization: Bearer <permanent token>`. The docs' examples show `perm:`, but this instance's working token starts with `perm-`. Tokens do not expire. | [verified] [live] | [8][9][10] |
| Error body | JSON `{error, error_description, ...}`. 400 = bad query or fields, 401 = no or invalid token, 404 = unknown issue, 500 = non-numeric `$top`. | [live] | - |
| Rate limits | No REST request rate limit is documented. The only documented limit is login throttling, applied per login. There are no rate-limit headers live. | [undocumented] [verified] | [11] |
| Issue count endpoint | `/api/issuesGetter/count` is **POST only**, so it is OFF-LIMITS. GET alternatives: count the paged `GET /api/issues` rows, or `GET /api/admin/projects?fields=shortName,issues(id)`. | [verified] [live] | [1][12] |
| Moved issue | Gets a new ID with the target project's prefix and next number. The old link redirects in the UI. | [verified] | [13] |
| Deleted issue | Restorable for a short time, then removed by housekeeping. Live, CUI-24 and CUI-27 return 404. | [verified] [live] | [14] |

## Details

### 1. OpenAPI spec: GET /api/issues and GET /api/issues/{id}

Spec header [1]: OpenAPI 3.0.1, `info.version: "2025.2"`, `servers: [{"url": "https://youtrack.ai.buas.nl:443/api"}]`. Paths are relative to `/api`, so the spec's `/issues` is `/api/issues`. Security scheme [1]:

```json
{"permanentToken":{"type":"http","scheme":"bearer","bearerFormat":"YouTrack permanent token"}}
```

`paths["/issues"].get.parameters` [1] (all `in: query`, none required; the `fields` default is truncated here):

```json
[
  {"name":"query","in":"query","schema":{"type":"string"}},
  {"name":"customFields","in":"query","schema":{"type":"string"}},
  {"name":"fields","in":"query","schema":{"type":"string",
     "default":"$type,created,customFields($type,id,name,value($type,id,name)),description,id,idReadable,links(...),numberInProject,project($type,id,name,shortName),reporter(...),resolved,summary,updated,updater(...),visibility(...)"}},
  {"name":"$skip","in":"query","schema":{"type":"integer","format":"int32"}},
  {"name":"$top","in":"query","schema":{"type":"integer","format":"int32"}}
]
```

Response [1]:

```json
"200": {"description":"collection of Issue","content":{"application/json":{"schema":{"type":"array","items":{"$ref":"#/components/schemas/Issue"}}}}}
```

`paths["/issues/{id}"].get` [1] has the parameters `fields` (query, string) and `{"name":"id","in":"path","required":true,"schema":{"type":"string"}}`. Its only response is 200 "single Issue" (`$ref Issue`).

The spec documents only `200` responses and defines no error schema. Error handling therefore has to follow the observed behaviour (section 4). The docs list the endpoint shape as `GET /api/issues?{fields}&{$top}&{$skip}&{query}&{customFields}` [2].

### 2. Issue schema (components.schemas.Issue)

`Issue` has `discriminator: {propertyName: "$type"}` and no `required` list [1]. The exact entries from the spec [1]:

| Property | Spec | Docs [2][5] | Live |
|---|---|---|---|
| idReadable | `{type:string, readOnly:true}` | "The issue ID as seen in the YouTrack interface. Read-only." | string, e.g. `CUI-31` |
| numberInProject | `{type:integer, format:int64, readOnly:true}` | "The issue number in the project. Read-only." | number |
| summary | `{type:string, readOnly:false}` | "Can be null" | string |
| description | `{type:string, readOnly:false}` | "The issue description. Can be null." | null for 1 of 29, never `""` |
| resolved | `{type:integer, format:int64, readOnly:true}` | "... null if the issue is still in an unresolved state. Read-only. Can be null." | null for 11, number for 18 |
| updated | `{type:integer, format:int64, readOnly:true}` | "... last update of the issue. Stored as a unix timestamp at UTC." | epoch ms |
| created | `{type:integer, format:int64, readOnly:true}` | - | epoch ms, number for 29 of 29 |
| wikifiedDescription | `{type:string, readOnly:true}` | "as shown in the UI after processing wiki/Markdown markup (including HTML markup)" | always a string, `""` when description is null |
| usesMarkdown | **absent** (0 occurrences in the spec) | not listed | boolean `true` for 29 of 29 |
| project | `{$ref:Project, readOnly:false}`; `Project.shortName` is `{type:string}` | "The project where the issue belongs. Can be null." | `{$type, shortName:"CUI"}` |

`grep -c nullable youtrack-openapi.json` returns `0` [1]. Types generated from the spec are therefore wrong for `resolved`, `description`, `summary` and `project`. Type them as `number | null`, `string | null`, and so on.

> "`null` if the issue is still in an unresolved state. `Read-only`. `Can be null`." [2]

### 3. Fields syntax, pagination, ordering

- Default fields [verified] [4]:
  > "by default, the server sends back only the database ID and `$type` of the resource entity."

  Live, `GET /api/issues` without `fields` returns rows with keys `["$type","id"]` only [live].
- Nested fields [verified] [4]: the docs give the examples `project(name)` and `customFields(id,name,value(name))`. `project(shortName)` works live [live].
- Unknown field names are silently dropped. `fields=idReadable,bogusFieldXyz` returns 200 with keys `["$type","idReadable"]` [live]. An unbalanced parenthesis returns 400 `bad_request` "Query string has invalid syntax" [live].
- `$skip` and `$top` [verified] [6]:
  > "`$skip=N` lets you skip N found elements and returns elements starting from N+1." / "`$top=M` instructs the server to return a set of top M elements found."
- Default page size: the docs conflict.
  - Pagination page [6]: "For most resources, the server returns a maximum of 42 elements by default." and "It's a safety measure to eliminate server overload."
  - Issues page [2]: "If you don't provide the `$top` parameter, the number of returned issues is limited to the **Max issues to export** value in the Global Settings of your YouTrack." The same page's parameter table also says "The server returns a maximum of 42 entries for most resources that return collections."
  - Server 2025.2 Global Settings [7]: "By default, the limit is set to 500 issues."

  This can't be resolved live because only 29 issues are visible [partial].
- Maximum `$top`: [undocumented]. The Pagination page gives no maximum [6].
- Default sort [verified] [2]:
  > "If you don't specify any sorting in the query, the default issue sorting is `sort by: updated desc`."
- Stability across pages: [undocumented]. The Pagination page says cursors (not `$top`/`$skip`) are needed for activities because "new activities might be created between two consecutive requests" [6]. That is about activities, but the same shifting risk applies by analogy to an issue list sorted by `updated` [partial].

### 4. Auth, headers, errors

- Auth [verified] [8][9]:
  > "You must provide the Authorization HTTP request header for each request. The recommended authorization method is using a permanent token." [9]

  > "... utilizes a permanent token as the `Bearer` attribute of the `Authorization` header." Example: `-H 'Authorization: Bearer perm:cm9vdA==.dG9rZW4=.rNZ38ije7uiWwnUTRDdyFDdUkoPUPi'` [8]
- Token format:
  - This instance's working token starts with `perm-` (hyphen), not `perm:`, and has 3 dot-separated segments [live].
  - The Server 2025.2 token page does not document a prefix format [10].
  - Treat the token as opaque and do not validate its prefix.
- Expiry [verified] [10]:
  > "A permanent token does not have an expiration date."
- Headers [verified] [15]:
  - `Accept: application/json`: "Provide this header for `GET` methods ...".
  - `Content-Type` is required only for POST and PUT, so a GET-only client doesn't need it.
  - Without `Authorization`: "YouTrack makes the request on behalf of the guest user account. If the guest account is banned, the request will return an error." On this instance that returns 401 [live].
- Error bodies [live]:

| Case | HTTP | Body |
|---|---|---|
| Unknown project in query | 400 | `{"error":"invalid_query","error_description":"Can't parse search query, please check and update query syntax","error_developer_message":"Can't parse search query","error_field":"query","error_children":[{"error":"The value \"DOESNOTEXIST\" isn't used for the project field.","error_description":""}]}` |
| Malformed `fields` | 400 | `{"error":"bad_request","error_description":"Query string has invalid syntax"}` |
| No Authorization header | 401 | `{"error":"Unauthorized","error_description":"You are not logged in."}` (no `WWW-Authenticate` header) |
| Invalid token | 401 | `{"error":"Unauthorized","error_description":"Invalid token"}` |
| Unknown issue id | 404 | `{"error":"Not Found","error_description":"Entity with id CUI-24 not found"}` |
| `$top=abc` | 500 | `{"error":"server_error","error_description":"HTTP 404 Not Found"}` |

The `error` code strings are inconsistent, so branch on the HTTP status.

### 5. Rate limits

- No official page documents a REST request-rate limit, a 429 response or rate-limit headers for YouTrack Server [undocumented].
- The only documented rate limiting is login throttling [verified] [11]: "Rate limits are applied per login." It covers login attempts and credential checks.
- "Max issues to export" is described as a safety cap [verified] [7]: "The Max Issues to Export limit is set to avoid overloading the application."
- Live, responses carry `Server: YouTrack` and `Via: 1.1 Caddy` and no RateLimit, Retry-After or X-RateLimit headers [live]. A Caddy reverse proxy sits in front, and its limits are unknown.

### 6. Semantics: updated, resolved, move, delete

- `updated` [verified] [2][16]: "the last update of the issue". The search attribute is described as the time "the most recent change occurred".
  - Which change types bump it (comments, tags, links, votes) is [undocumented].
  - Live, resolving an issue bumps it: `resolved` and `updated` are within milliseconds of each other for several issues.
  - For CUI-12, `resolved` is 5 ms **after** `updated` [live]. Don't assume `resolved <= updated`.
- `resolved` [verified] [2][16]: the timestamp when the issue "was assigned a state that is considered to be resolved", and null while unresolved.
  - With several state-type fields: "the Resolved property is only true when all the state-type fields are assigned values that are considered to be resolved." [16]
  - The workflow API has `becomesUnresolved` ("previously resolved and is assigned a state that is considered unresolved") [17].
  - That `resolved` returns to null after a reopen follows from "null if the issue is still in an unresolved state", but the docs never state it outright [partial].
- Move [verified] [13]:
  > "The issue gets a new ID with the prefix of the target project and the next consecutive issue number in the target project." / "The old link to the issue will now redirect to the new link with the new ID."

  So `numberInProject` changes and the issue drops out of `project: CUI`. Whether `GET /api/issues/{oldId}` resolves after a move is [undocumented].
- Delete [verified] [14]:
  > "Deleted issues are only available for a short period of time before YouTrack's automated housekeeping permanently removes them."

  Live, the gaps CUI-24 and CUI-27 return 404. A deleted issue and one moved to a project the token can't see look the same [live].
- Single-issue access [verified] [3]:
  > "You can specify either the database ID of the issue (for example, `2-24`) or issue ID in the project (for example, `TST-5`)."

  It requires Read Issue, and visibility restrictions apply.

### 7. Description format and GitHub rendering

- `usesMarkdown`: it is not in the spec or the entity docs, but it works live and is `true` for all 29 issues. The only related text in the spec is `UsesMarkupActivityItem` [1]:
  > "If `true`, then the markdown is used. Otherwise, YouTrack Wiki markup."
- `description` holds the raw markup. `wikifiedDescription` holds the rendered HTML [5].
- YouTrack Markdown (Server 2025.2) [verified] [18]:
  > "The Markdown implementation in YouTrack follows the CommonMark specification with extensions" (checklists, strikethrough, tables, user mentions, issue links).

Differences that matter when a description is copied into a GitHub issue body:

- Checklists [18]: "While similar to the Task list items (extension) in GitHub Flavored Markdown, the implementation in YouTrack is slightly different".
- Attachments [18] are referenced by filename ("replacing the image URL with the filename of the attachment"). On GitHub these links break.
  - `IssueAttachment.url` is "Read-only. Can be null." [19]
  - Whether attachment URLs work without YouTrack auth is [undocumented].
- Size attributes [18] ("Wrap the size attributes in curly braces ({ })") are YouTrack-specific and would likely show as literal text on GitHub [partial, not tested].
- Issue IDs [18]: "A sequence of characters that matches an existing issue ID is automatically parsed and transformed into a link". This happens only inside YouTrack, so `CUI-12` is plain text on GitHub. Custom autolinks on GitHub need a repo admin [20].
- Mentions [18]: "the @mention is replaced with the user's full name and set as a link." How the mention is stored in the raw `description` is [undocumented]. On GitHub, `@login` notifies the user only "if the person has read access to the repository and, if the repository is owned by an organization, the person is a member of the organization." [21]
- `#26` and `GH-26` auto-link to issue 26 of the GitHub repo, which is the wrong target [20].
- Live CUI content (counts only):
  - 0 attachments, 0 image references, 0 `@` mentions, 0 HTML tags and 0 `#<n>` across the 29 issues.
  - 1 description contains a `CUI-<n>` reference.
  - Tags: 0. Comments: 0.
  - (From the researcher's live pass; not re-run in full by the verifier.)

### 8. Read-only audit

Checked with jq against the spec [1]:

| Endpoint | Methods in spec | Mirror uses |
|---|---|---|
| `/api/issues` | get, post | **GET only** |
| `/api/issues/{id}` | get, post, delete | GET only (optional) |
| `/api/admin/projects` | get, post | GET only (optional startup check) |
| `/api/issuesGetter/count` | **post only** | **OFF-LIMITS** |

- `/issuesGetter/count` is the only path whose name contains "count" [1]. The docs confirm POST [12]:
  > "GET requests don't take request body, so you need to send a POST request in this case."

  A count of `-1` means "YouTrack hasn't finished counting the issues yet" [12].
- GET ways to count a project's issues:
  - (a) Page through `GET /api/issues?query=project: CUI&fields=id` and count the rows.
  - (b) `GET /api/admin/projects?fields=shortName,issues(id)`. Live this returned CUI with 29, which matches (a) [live]. Whether that nested collection is capped for large projects is [undocumented].
  - `/api/admin/projects/{id}/issues` exists (get, post) but is not on the allowed probe list and was not called.
- Spec totals: 136 paths, with 122 `get`, 88 `post` and 38 `delete` operations, and no put or patch [1].

## Live observations

All requests were `curl -sS -G https://youtrack.ai.buas.nl/api/... -H "Authorization: Bearer $YOUTRACK_TOKEN" -H "Accept: application/json" --data-urlencode ...`. They were re-run by the verifier on 2026-09-24.

| Probe | Result |
|---|---|
| (a) `/api/issues` `fields=id,project(shortName)`, no query, no `$top` | 200, 29 rows, projects `[CUI]` |
| (a) same with `$top=1000` | 200, 29 rows, projects `[CUI]`. The default page size can't be observed. |
| (b) `query=project: CUI`, `fields=numberInProject,usesMarkdown,created,resolved,updated,project(shortName),description,wikifiedDescription`, `$top=1000` | 29 rows. `usesMarkdown` true x29. `created` number x29. `resolved` null x11. `project` keys `[$type,shortName]`, shortName CUI x29. `description` null x1, `""` x0. `wikifiedDescription` always a string. `resolved > updated` only for CUI-12. Earliest created 2026-09-10T07:36:55Z. Latest updated 2026-09-24T13:32:13Z. |
| (c) `query=project: DOESNOTEXIST` | 400 `invalid_query` (body in section 4) |
| (d) no Authorization header | 401 "You are not logged in.", no `WWW-Authenticate` |
| No `fields` param, `$top=2` | keys `[$type,id]` |
| `fields=idReadable,bogusFieldXyz` | 200, keys `[$type,idReadable]` |
| `fields=numberInProject,project(shortName` | 400 `bad_request` |
| `$top=0` / `$top=100000` / `$top=abc` | 200 `[]` / 200, 29 rows / 500 `server_error` |
| `query=project: CUI sort by: updated desc`: `$top=10` with `$skip` 0,10,20,30 vs `$top=1000` | identical order |
| `/api/admin/projects` `fields=shortName,issues(id)` | `[{shortName:CUI, n:29}]` |
| `/api/issues/CUI-24` | 404 "Entity with id CUI-24 not found" |
| Bearer `perm:invalid.invalid.invalid` | 401 "Invalid token" |
| Response headers | `Server: YouTrack`, `Via: 1.1 Caddy`, `X-Version`; no rate-limit headers |

## Undocumented / not found

- Maximum `$top`. Ordering stability or snapshot consistency across `$skip` pages. Tie-breaking for equal `updated` values.
- Which default applies without `$top` on Server 2025.2: 42 or Max issues to export. The docs contradict each other.
- REST request rate limits, 429 behaviour and rate-limit headers.
- `usesMarkdown` on Issue (it works live but is undocumented).
- The `perm-` token prefix (the docs show only `perm:`).
- Which changes bump `updated` besides resolution. That `resolved` explicitly resets to null on reopen.
- Whether `GET /api/issues/{oldId}` follows a moved issue.
- Whether attachment URLs work without auth. How `@mentions` are stored in raw `description`.
- The spec's `fields` default does not describe the real response when `fields` is left out. The docs and a live request both show only `$type` and `id`.
- The 400 and 404 troubleshooting pages the researcher cited were not re-opened. The error bodies in this doc come from live requests only.

## Gotchas and implications for this project

1. **Always send `fields`.** Without it, only `$type` and `id` come back, and every issue would look unresolved. Unknown field names are silently dropped, so check that `resolved` is present as a key (its value may be null) and fail the run if it is missing.
2. **Nulls despite the spec.**
   - Type `resolved: number | null`, `description: string | null` and `summary`/`project` as nullable.
   - Build the body from `description ?? ""`.
3. **Always send a numeric `$top`** (for example 100) and loop with `$skip` until a short page comes back.
   - Validate the config integers.
   - `$top=0` returns an empty array, not "unlimited".
   - A non-numeric `$top` returns 500.
4. **Offset paging over `updated desc` can shift** if an issue is updated mid-run: rows can be duplicated or skipped. Dedupe by `numberInProject`.
5. **`resolved` can be a few ms after `updated`** (CUI-12). Use `updated` for the lookback cutoff and add a margin.
6. **Moved or deleted issues** drop out of `project: CUI`.
   - Their mirrors stay open.
   - A moved-back issue gets a new number and so a duplicate mirror.
   - 404 can't tell deleted apart from moved to an invisible project.
7. **A reopen** sets `resolved` back to null (implied by the docs). A close-only mirror would stay closed.
8. **Lookback-only scanning** misses resolutions if downtime or a MAX_WRITES_PER_RUN backlog lasts longer than LOOKBACK_HOURS. The whole project (29 issues) fits in one page.
9. **Error handling by status:**
   - 401: fatal config error.
   - 400: query or fields bug.
   - 5xx and network errors: retry next run.
   - Log `error` and `error_description`, never the token.
10. **GitHub rendering:**
    - `#<n>` and `GH-<n>` mis-link to the mirror repo.
    - `@login` may notify org members.
    - Attachment filename references break.
    - `CUI-<n>` is plain text on GitHub.
11. **Visibility:** limited-visibility issues are hidden unless the token user is permitted. If the user is permitted, mirroring exposes that content to everyone who can read the GitHub repo. All 29 issues currently use UnlimitedVisibility (researcher live pass).
12. **Token prefix:** pass the token verbatim after `Bearer `. Don't regex-check for `perm:`.
13. **Relative dates in queries** use the token user's time zone [16]: "relative to the current date according to the time zone of the current user". The planned client-side epoch-ms comparison avoids this.
14. **Count endpoint:** never use `/api/issuesGetter/count` (POST).

## Open questions for the user

1. What is this instance's "Max issues to export" setting? Options: always send `$top` so it doesn't matter; ask a YouTrack admin.
2. Should a reopened YouTrack issue reopen its closed GitHub mirror? Options: keep close-only; also reopen (costs one write).
3. How should mirrors of moved or deleted issues be handled? Options: ignore; during BACKFILL, GET `/api/issues/CUI-n` for unseen open mirrors and close or flag them on 404; label them for manual review.
4. Should closing rely only on the `updated` lookback? Options: lookback only; full scan of `project: CUI` every run (1 GET at the current size); lookback plus a periodic BACKFILL.
5. What goes in the mirror body? Options: raw description verbatim; raw with `#` and `@` neutralised; raw inside a quote or collapsible block; `wikifiedDescription` HTML.
6. Should limited-visibility issues be skipped? Options: skip them; mirror everything the token can see.

## Sources

1. Instance OpenAPI spec (YouTrack REST API 2025.2, OAS 3.0.1) -- `C:/Users/peer/buas/youtrack-gh/youtrack-openapi.json`
2. Issues resource -- https://www.jetbrains.com/help/youtrack/devportal/resource-api-issues.html (04 July 2026)
3. Operations with Specific Issue -- https://www.jetbrains.com/help/youtrack/devportal/operations-api-issues.html (19 March 2025)
4. Fields Syntax -- https://www.jetbrains.com/help/youtrack/devportal/api-fields-syntax.html (10 September 2026)
5. Issue entity -- https://www.jetbrains.com/help/youtrack/devportal/api-entity-Issue.html (14 October 2024)
6. Pagination -- https://www.jetbrains.com/help/youtrack/devportal/api-concept-pagination.html (10 September 2026)
7. Server Configuration / Global Settings -- https://www.jetbrains.com/help/youtrack/server/2025.2/server-configuration-settings.html (Server 2025.2, 02 July 2025)
8. Permanent Token Authorization -- https://www.jetbrains.com/help/youtrack/devportal/authentication-with-permanent-token.html (10 September 2026)
9. YouTrack REST API overview -- https://www.jetbrains.com/help/youtrack/devportal/youtrack-rest-api.html (10 September 2026)
10. Manage Permanent Tokens -- https://www.jetbrains.com/help/youtrack/server/2025.2/manage-permanent-token.html (Server 2025.2, 03 September 2025)
11. Common Settings for Auth Modules -- https://www.jetbrains.com/help/youtrack/server/2025.2/auth-module-common-settings.html (Server 2025.2, 09 September 2025)
12. Issue Count resource -- https://www.jetbrains.com/help/youtrack/devportal/resource-api-issuesGetter-count.html (24 March 2026)
13. Update Field Values (move issue) -- https://www.jetbrains.com/help/youtrack/server/2025.2/update-field-values.html (Server 2025.2, 30 January 2025)
14. Delete Issues -- https://www.jetbrains.com/help/youtrack/server/2025.2/delete-issues.html (Server 2025.2, 05 September 2025)
15. Request Headers -- https://www.jetbrains.com/help/youtrack/devportal/yt-api-headers.html (10 September 2026)
16. Search Query Reference -- https://www.jetbrains.com/help/youtrack/server/2025.2/search-and-command-attributes.html (Server 2025.2, 20 August 2025)
17. Workflow API Issue entity -- https://www.jetbrains.com/help/youtrack/devportal/v1-Issue.html (10 September 2026)
18. Markdown Syntax -- https://www.jetbrains.com/help/youtrack/server/2025.2/youtrack-markdown-syntax-issues.html (Server 2025.2, 07 February 2025)
19. IssueAttachment entity -- https://www.jetbrains.com/help/youtrack/devportal/api-entity-IssueAttachment.html (23 May 2025)
20. GitHub Docs: Autolinked references and URLs -- https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls
21. GitHub Docs: Basic writing and formatting syntax -- https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax
