# GitHub REST API: issues, labels, rate limits

> Researched 2026-09-24 for the YouTrack -> GitHub mirror. Status tags: [verified] = source re-opened and quote confirmed; [live] = confirmed by a live request; [partial] = indirect/partial support; [undocumented] = not found in official docs.

All doc pages were re-fetched on 2026-09-24. The issues and labels reference pages now default to API version `2026-03-10`. The list-repository-issues parameters are identical on the `2022-11-28` page (diffed). Live checks were unauthenticated GETs against public repos only (octocat/Hello-World, cli/cli). No authenticated call and no call to BredaUniversityADSAI/* was made.

## TL;DR

| Question                          | Answer                                                                                                                                                                | Status                   | Source    |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------- |
| List issues                       | `GET /repos/{o}/{r}/issues?labels=youtrack&state=all&per_page=100`. `per_page` max 100 (a larger value returned exactly 100). Defaults: sort=created, direction=desc. | [verified] [live]        | [1]       |
| PRs in list                       | PRs are mixed into the list. Identify them by the `pull_request` key. No query parameter excludes them, so filter client-side.                                        | [verified] [live]        | [1]       |
| Label filter                      | Comma-separated names. AND semantics and case-insensitive matching were observed live but are not documented. An unknown label returns 200 `[]`.                      | [live] [undocumented]    | [1]       |
| Pagination                        | Follow the `link` header's `rel="next"` URL verbatim until it is absent. The list-issues endpoint uses an opaque `after=` cursor and gives no `rel="last"`.           | [verified] [live]        | [3][4]    |
| Create issue                      | `POST /repos/{o}/{r}/issues` with `title` (required), `body`, `labels`. Returns 201. There is no `state` field, so a resolved item needs a second PATCH.              | [verified]               | [1]       |
| Labels silently dropped           | "Only users with push access can set labels for new issues. Labels are silently dropped otherwise."                                                                   | [verified]               | [1]       |
| Title/body length                 | Not in the REST docs. Community sources give a 256-character title limit and a 65,536-character body limit, with 422 when exceeded.                                   | [undocumented] [partial] | [20][21]  |
| Close issue                       | `PATCH .../issues/{n}` with `{"state":"closed","state_reason":"completed"}`. The request enum is `completed, not_planned, duplicate, reopened, null`.                 | [verified]               | [1]       |
| Close an already-closed issue     | Behaviour undocumented. `state_reason` is "Ignored unless state is changed."                                                                                          | [partial]                | [1]       |
| Get label                         | `GET /repos/{o}/{r}/labels/{name}` returns 200 or 404. The lookup is case-insensitive (live). URL-encode the name.                                                    | [verified] [live]        | [2][12]   |
| Create label                      | `POST /repos/{o}/{r}/labels` with `name`, `color` (hex, no `#`), and `description` (100 characters or fewer). A duplicate name gets 422 with code `already_exists`.   | [verified]               | [2][12]   |
| Auto-create label on issue create | Not documented either way.                                                                                                                                            | [undocumented]           | [1][2]    |
| FG PAT permissions                | List and get-label need Issues: read. Create/close issue and create label need Issues: write.                                                                         | [verified]               | [7][1][2] |
| API versions                      | Supported: `2026-03-10` (end of support not scheduled) and `2022-11-28` (supported until March 10, 2028). Requests with no version header use `2022-11-28`.           | [verified] [live]        | [5][6]    |
| User-Agent                        | Required. A request without one got 403 (live).                                                                                                                       | [verified] [live]        | [10]      |
| Primary rate limit                | 5,000 requests/h per user, shared across all of that user's PATs and apps.                                                                                            | [verified]               | [8]       |
| Secondary rate limits             | 100 concurrent requests; 900 points/min per endpoint (a write costs 5); 80 content-creating requests/min and 500/h, with some endpoints lower.                        | [verified]               | [8]       |
| When limited                      | Status 403 or 429. Respect `retry-after`, then `x-ratelimit-reset`, otherwise wait at least 60 s and back off exponentially.                                          | [verified]               | [8]       |
| Mentions and autolinks            | `@user` notifies (org members with read access only). `#n`, `GH-n` and `owner/repo#n` autolink and create backlinks.                                                  | [verified]               | [15][16]  |
| Read-after-write on list          | Not documented. The Search API is a separate index.                                                                                                                   | [undocumented]           | [17]      |

## Details

### 1. List repository issues

`GET /repos/{owner}/{repo}/issues` [1] [verified]. Parameters on the 2026-03-10 page, identical on the 2022-11-28 page:

- `state`: Default `open`, "Can be one of: `open`, `closed`, `all`".
- `labels`: "A list of comma separated label names. Example: bug,ui,@high".
- `sort`: `created` | `updated` | `comments`. Default `created`.
- `direction`: `asc` | `desc`. Default `desc`.
- `since`: "Only show results that were last updated after the given time. This is a timestamp in ISO 8601 format: YYYY-MM-DDTHH:MM:SSZ."
- `per_page`: "The number of results per page (max 100)." Default 30.
- `page`: Default 1.
- Other filters: `milestone`, `assignee`, `type`, `creator`, `mentioned`, `issue_field_values`.
- Status codes: 200, 301, 404, 422.
- Fine-grained PAT: "Issues" repository permissions (read).

Doc inconsistency: the endpoint description says "List issues in a repository. Only open issues will be listed." That contradicts the `state` parameter. The researcher observed live that `state=all` returns closed issues too. I saw a closed issue (cli/cli #316) returned with `state=all` [live].

Pull requests [1] [verified]:

> "Issues" endpoints may return both issues and pull requests in the response. You can identify pull requests by the pull_request key.

No query parameter excludes PRs [undocumented]. Live, Hello-World returned a mix: items #11285, #11284 and #11283 had `pull_request`, and #11282 did not [live]. Skip any item whose `pull_request` is present and non-null.

Label filter semantics [undocumented]. The docs don't say whether commas mean AND or OR, or whether matching is case-sensitive. Live on cli/cli:

- `labels=bug,enhancement` returned only #8659 and #316, and both carry both labels. That is AND semantics.
- `labels=BUG` and `labels=bug` returned the same five numbers. Matching is case-insensitive.
- A nonexistent label returned 200 `[]` (seen by the researcher; the same pattern appears in the get-label 404 check below).

Best practice for paging [9] [verified]:

> Some parameters, such as `sort=updated`, reorder the list whenever an item changes. ... A stable order, such as the default, stops updates to existing items from reordering the list

For the mirror listing, keep the default `sort=created`.

### 2. Pagination via the Link header

From the pagination page [3] [verified]:

> If the endpoint does not support pagination, or if all results fit on a single page, the `link` header will be omitted.

- The rel values are `prev`, `next`, `last` and `first`. "The URL for the next page is followed by `rel=\"next\"`."
- "the link to the last page won't be included if it can't be calculated."
- "each paginated endpoint will use the `page`, `before`/`after`, or `since` query parameters."

From best practices [9] [verified]:

> you should not try to manually construct pagination queries. Instead, you should use the link headers

Observed on 2026-09-24T18:01Z [live]. Request: `GET https://api.github.com/repos/octocat/Hello-World/issues?state=all&per_page=2` with `X-GitHub-Api-Version: 2026-03-10`.

```
Link: <https://api.github.com/repositories/1296269/issues?state=all&per_page=2&after=Y3Vyc29yOnYyOpLPAAABoNQuneDPAAAAAUwRaIQ%3D&page=2>; rel="next"
```

Following that URL verbatim returned:

```
Link: <https://api.github.com/repositories/1296269/issues?state=all&per_page=2&after=Y3Vyc29yOnYyOpLPAAABoNO8tbjPAAAAAUv4y2A%3D&page=3>; rel="next", <https://api.github.com/repositories/1296269/issues?state=all&per_page=2&page=1&before=Y3Vyc29yOnYyOpLPAAABoNQhS7jPAAAAAUwOoDs%3D>; rel="prev"
```

What this shows:

- Pagination is cursor-based (`after=` / `before=`).
- There is no `first` or `last` link.
- The URLs use the `/repositories/{id}/` form.
- The query parameters (`state`, `per_page`) are carried along.

So loop on `rel="next"` and use the URL unchanged. Parse the header per RFC 8288. The docs' own example uses the regex `/(?<=<)([\S]*)(?=>; rel="next")/i` [3].

### 3. Create an issue

`POST /repos/{owner}/{repo}/issues` [1] [verified].

> Any user with pull access to a repository can create an issue. If issues are disabled in the repository, the API returns a 410 Gone status.

Body parameters:

- `title`: string or integer, required.
- `body`: string.
- `milestone`, `labels` (array), `assignees`, `issue_field_values`, `type`, `parent_issue_id`.
- There is no `state` parameter.
- The singular `assignee` exists only in 2022-11-28 ("This field is closing down."). It was removed in 2026-03-10 [6].

Status codes: 201, 400, 403, 404, 410, 422 ("Validation failed, or the endpoint has been spammed."), 503.

The 201 response schema includes `number`, `html_url`, `state`, `state_reason`, `labels` and `title`.

Fine-grained PAT: "Issues" repository permissions (write).

> This endpoint triggers notifications. Creating content too quickly using this endpoint may result in secondary rate limiting.

Labels [1] [verified]:

> NOTE: Only users with push access can set labels for new issues. Labels are silently dropped otherwise.

Milestone, assignees and type carry the same note.

How this interacts with the fine-grained PAT [11] [verified]:

> A token has the same capabilities to access resources and perform actions on those resources that the owner of the token has, and is further limited by any scopes or permissions granted to the token.

- "Push access" corresponds to the org repository role Write or higher [14] [partial]. The roles page describes Write as "Recommended for contributors who actively push to your project".
- Triage can "Apply/dismiss labels" in the roles table [14]. The create-issue doc still names push access.
- Whether a fine-grained PAT with only Issues: write, and no Contents: write, counts as "push access" for this rule is [undocumented].
- The 201 response includes `labels`, so the code can check that `youtrack` stuck.

Length limits:

- The REST docs state none [undocumented].
- Body: a GitHub staff answer (2020-12-10) gives "65,536 4-byte unicode characters". A quoted error in the same thread reads "maximum is 65536 characters" [20] [partial].
- Title: a community-maintained list says "Max length: 256 characters" under the "Issue title" heading [21] [partial].

### 4. Update (close) an issue

`PATCH /repos/{owner}/{repo}/issues/{issue_number}` [1] [verified].

> Issue owners and users with push access or Triage role can edit an issue.

Body parameters:

- `state`: "Can be one of: `open`, `closed`".
- `state_reason`: "The reason for the state change. Ignored unless state is changed." "Can be one of: `completed`, `not_planned`, `duplicate`, `reopened`, `null`". The response-schema enum lists the same values in a different order.
- `duplicate_issue_id`: used only when `state_reason` is `duplicate`.

Status codes: 200, 301, 403, 404, 410, 422, 503.

Fine-grained PAT: "at least one of ... "Issues" repository permissions (write) "Pull requests" repository permissions (write)".

The roles table also lets the Read role "Close issues they opened themselves" [14] [verified]. The token owner is the author of every mirror issue.

Closing an already-closed issue: the status code, and whether it produces an event or notification, are [undocumented]. The only related statement is that `state_reason` is ignored unless the state changes.

### 5. Labels

Get a label: `GET /repos/{owner}/{repo}/labels/{name}`, "Gets a label using the given name." Status codes 200 and 404 [2] [verified]. Fine-grained PAT: Issues (read) OR Pull requests (read).

Live checks [live]:

- `/repos/cli/cli/labels/BUG` returned 200 with `name:"bug"`, `color:"d73a4a"`, `default:true`. The lookup is case-insensitive.
- A nonexistent name returned 404 with body `{"message":"Not Found", ..., "status":"404"}`.
- The researcher observed that `good%20first%20issue` returns 200.

Encoding [12] [verified]:

> any path parameters must be URL encoded. For example, any slashes in the parameter value must be replaced with `%2F`.

Create a label: `POST /repos/{owner}/{repo}/labels` [2] [verified].

- `name` is marked required.
- `color`: "The hexadecimal color code for the label, without the leading #."
- `description`: "Must be 100 characters or fewer."
- Status codes: 201, 404, 422.
- Fine-grained PAT: Issues (write) OR Pull requests (write).
- Doc conflict: the prose says "The name and color parameters are required. The color must be a valid hexadecimal color code." The parameter list, however, marks only `name` as required. Always send `color`.

Duplicate label: 422. The troubleshooting page's error-code table defines `already_exists` [12] [verified]:

> Another resource has the same value as one of your parameters. This can happen in resources that must have some unique key (such as label names).

Repository role: "Create, edit, delete labels" requires Write, Maintain or Admin. Triage and Read are not enough [14] [verified].

Whether passing a nonexistent label in `labels` on POST /issues auto-creates it: [undocumented]. Neither page says either way. Do not rely on it.

### 6. Fine-grained PAT permissions and org policy

From the "Repository permissions for "Issues"" table [7] [verified]:

| Endpoint                                            | Access | Additional permissions        |
| --------------------------------------------------- | ------ | ----------------------------- |
| `GET /repos/{owner}/{repo}/issues`                  | read   | no                            |
| `POST /repos/{owner}/{repo}/issues`                 | write  | no                            |
| `PATCH /repos/{owner}/{repo}/issues/{issue_number}` | write  | yes (Issues or Pull requests) |
| `GET /repos/{owner}/{repo}/labels/{name}`           | read   | yes                           |
| `POST /repos/{owner}/{repo}/labels`                 | write  | yes                           |

"`write` always includes `read`" [11] [verified]. A token with Issues read/write therefore covers every endpoint the mirror uses.

Org policy:

- **Resource owner:** the token can "only be able to access resources owned by the selected resource owner". "Organizations that you are a member of will not appear if the organization has blocked the use of fine-grained personal access tokens." [11] [verified]
- **Defaults:** "By default, both Personal access tokens (classic) and fine-grained personal access tokens are enabled." [13] [verified]
- **Approval:** "Require administrator approval" is the default. "Fine-grained personal access tokens created by organization owners will not need approval. This is the default value." [13] [verified]
- **Pending tokens:** "Your token will only be able to read public resources until it is approved." [11] [verified] Against this private repo that shows up as 404s (see [12] on 404 for auth problems).
- **Lifetime:** "the default the maximum lifetime policy for organizations is set to expire within 366 days." [13] [verified]
- **Unused tokens:** "GitHub automatically removes personal access tokens that haven't been used in a year." [11] [verified]
- **Known gap:** "Using fine-grained personal access token to contribute to repositories where the user is an outside or repository collaborator." [11] [verified]
- **Recommendation:** "To access resources on behalf of an organization, or for long-lived integrations, you should use a GitHub App." [11] [verified] This is a recommendation, not a requirement.

### 7. Headers and API versions

- **Accept:** every endpoint says "Setting to `application/vnd.github+json` is recommended." [1]
- **Authorization:** "In most cases, you can use `Authorization: Bearer` or `Authorization: token` to pass a token. However, if you are passing a JSON web token (JWT), you must use `Authorization: Bearer`." [19] [verified]
- **User-Agent:** "Requests with no `User-Agent` header will be rejected. If you provide an invalid `User-Agent` header, you will receive a `403 Forbidden` response." [10] [verified]. Live, a request with an empty User-Agent got 403: "Request forbidden by administrative rules. Please make sure your request has a User-Agent header" [live].

Versions [5] [verified]:

| API version  | End of support date |
| ------------ | ------------------- |
| `2026-03-10` | Not yet scheduled   |
| `2022-11-28` | March 10, 2028      |

`GET https://api.github.com/versions` returned `["2026-03-10","2022-11-28"]` [live].

- "Requests without the `X-GitHub-Api-Version` header will default to use the `2022-11-28` version."
- "If you specify an API version that is no longer supported, you will receive a `410 Gone` response."
- After the support window: "Requests that do not specify an API version default to the next oldest supported version, not the closing down version."
- `Deprecation` and `Sunset` headers are added as a version approaches its end of support.
- "Any additive (non-breaking) changes will be available in all supported API versions."
- A version that does not exist gives "a `400 Bad Request` error" [12] [verified].
- The response header `x-github-api-version-selected` echoed the version sent [live].

2026-03-10 breaking changes relevant to these endpoints [6] [verified]:

- "Remove deprecated singular "assignee" field from Issue and Pull Request endpoints". This affects GET/POST/PATCH issues. Live, list items under 2026-03-10 had no `assignee` key.
- "Deprecate support for the `beta` media type", including "`pull_request` response property with `null` default values". This is irrelevant with `application/vnd.github+json`.
- Also removed: the `rate` property from `/rate_limit`, `has_downloads` from Repository, and `merge_commit_sha` from PR responses.

None of these touch `title`, `body`, `state`, `state_reason`, `labels`, `number` or the `pull_request` key.

### 8. Rate limits

Primary [8] [verified]:

- "All of these requests count towards your personal rate limit of 5,000 requests per hour." This covers PATs plus apps acting on the user's behalf, so the budget is shared per user.
- Unauthenticated requests: 60/h per IP.

Secondary [8] [verified]. "These secondary rate limits are subject to change without notice." The documented limits:

- "No more than 100 concurrent requests are allowed. This limit is shared across the REST API and GraphQL API."
- "No more than 900 points per minute are allowed for REST API endpoints". Most GET/HEAD/OPTIONS requests cost 1 point, and "Most REST API `POST`, `PATCH`, `PUT`, or `DELETE` requests" cost 5. "Some REST API endpoints have a different point cost that is not shared publicly."
- "No more than 90 seconds of CPU time per 60 seconds of real time is allowed."
- "In general, no more than 80 content-generating requests per minute and no more than 500 content-generating requests per hour are allowed. Some endpoints have lower content creation limits." The limit for issue creation specifically is not published.
- Anecdotal (community, 2023-03-17): a bulk issue import hit "exceeded a secondary rate limit and have been temporarily blocked from content creation" [22] [partial].

Best practices [9] [verified]:

- "you should make requests serially instead of concurrently."
- "If you are making a large number of `POST`, `PATCH`, `PUT`, or `DELETE` requests, wait at least one second between each request."
- Follow redirects (301/302/307).
- Conditional requests (`etag` / `If-None-Match`) that return 304 "does not count against your primary rate limit" when authorized.

Headers [8] [verified]:

- `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-used`, `x-ratelimit-reset` ("in UTC epoch seconds") and `x-ratelimit-resource`.
- "There is not a way to check the status of your secondary rate limit."
- Live, `X-RateLimit-Limit: 60`, `X-RateLimit-Resource: core` and `X-RateLimit-Reset: 1790276472` were present, and `Access-Control-Expose-Headers` listed `Retry-After` [live].

When a limit is hit [8] [verified]:

- Primary: "you will receive a `403` or `429` response, and the `x-ratelimit-remaining` header will be `0`." Don't retry before `x-ratelimit-reset`.
- Secondary: "you will receive a `403` or `429` response and an error message that indicates that you exceeded a secondary rate limit." If `retry-after` is present, wait that many seconds. Else, if remaining is 0, wait until reset. "Otherwise, wait for at least one minute before retrying." Then back off exponentially and "throw an error after a specific number of retries."
- "Continuing to make requests while you are rate limited may result in the banning of your integration."
- Timeout: "If GitHub takes more than 10 seconds to process an API request, GitHub will terminate the request" [12] [verified].

### 9. Side effects of issue body content

Mentions [15] [verified]:

- Typing `@` plus a username or team name "will trigger a notification and bring their attention to the conversation."
- "A person will only be notified about a mention if the person has read access to the repository and, if the repository is owned by an organization, the person is a member of the organization."

Autolinks [16] [verified]:

- "references to issues and pull requests are automatically converted to shortened links." Forms: `#26`, `GH-26`, `jlord/sheetsee.js#26`, and full URLs. A bare `#n` refers to the current repo.
- Commit SHAs are autolinked.
- "By default, references generate a backlink."
- Custom autolinks to external trackers can be configured by a repo admin.

Notifications:

- Create-issue "triggers notifications" [1].
- Users "can also choose to automatically watch all repositories that you have push access to, except forks" [17a].
- Users are auto-subscribed when they have "Opened a pull request or issue", so the token owner is subscribed to every mirror issue [17a] [verified].
- Email content "includes any Markdown, @mentions, emojis, hash-links, and more" [18] [verified].

Documented options for limiting side effects (listed only, no decision):

- (a) Use `redirect.github.com` instead of `github.com` in URLs to avoid backlinks. This is documented for URLs only [16].
- (b) Backslash escaping: "You can tell GitHub to ignore (or escape) Markdown formatting by using \\ before the Markdown character." [15] Whether this suppresses mentions or `#n` autolinks is [undocumented].
- (c) Code spans or code blocks. Their effect on mentions and autolinks is [undocumented].
- (d) Omit the description and post only the YouTrack link.
- (e) Rely on the members-only mention-notification rule.
- (f) Ask a repo admin to configure a custom autolink.

### 10. Consistency after create

Whether `GET /repos/{o}/{r}/issues` reflects a just-created issue immediately is [undocumented]. The Search API is a separate index [17] [verified]:

> GitHub search uses an ElasticSearch cluster to index projects every time a change is pushed to GitHub. Issues and pull requests are indexed when they are created or modified.

Do not use search for deduplication. Within a run, add each created mirror to the in-memory map from the 201 response's `number`. Lag across runs 10 minutes apart was not tested, since no authenticated writes were allowed.

## Live observations

All unauthenticated GETs, 2026-09-24 ~18:01Z. Headers sent: `Accept: application/vnd.github+json`, `User-Agent: yt-gh-mirror-verify`, and `X-GitHub-Api-Version` as noted. I made 11 requests.

| Request                                                                                | Result                                                                                                                                                      |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /repos/octocat/Hello-World/issues?state=all&per_page=2` (2026-03-10)              | 200. Link contains only `rel="next"` with an `after=` cursor and `page=2`. Items #11285 and #11284 both have `pull_request`; neither has an `assignee` key. |
| Follow `rel="next"` verbatim                                                           | 200. Link has `next` (cursor, page=3) and `prev` (`before=` cursor). #11283 is a PR; #11282 is an issue.                                                    |
| `GET /repos/octocat/Hello-World/issues?state=all&per_page=150`                         | 200 with 100 items. A value above the maximum is silently capped.                                                                                           |
| `GET /repos/cli/cli/issues?labels=bug,enhancement&state=all&per_page=100` (2022-11-28) | 200 with 2 items (#8659 open, #316 closed), each labelled bug+enhancement.                                                                                  |
| `...labels=bug...per_page=5` vs `...labels=BUG...per_page=5`                           | Identical: [14404, 14394, 14389, 14386, 14374].                                                                                                             |
| `GET /repos/cli/cli/labels/BUG`                                                        | 200 `{name:"bug", color:"d73a4a", default:true}`.                                                                                                           |
| `GET /repos/cli/cli/labels/yt-nonexistent-label-xyz`                                   | 404 `{"message":"Not Found",...,"status":"404"}`.                                                                                                           |
| `GET /versions`                                                                        | 200 `["2026-03-10","2022-11-28"]`.                                                                                                                          |
| `GET /zen` with an empty User-Agent                                                    | 403 "Request forbidden by administrative rules. Please make sure your request has a User-Agent header".                                                     |
| Rate headers                                                                           | `X-RateLimit-Limit: 60`, `X-RateLimit-Resource: core`, remaining decreasing (59 -> 51), `x-github-api-version-selected` echoes the version sent.            |

## Undocumented / not found

- A query parameter to exclude PRs from list-issues.
- Label filter semantics: AND and case-insensitive observed live only.
- Title and body length limits (community sources only: 256 / 65,536).
- Auto-creation of a nonexistent label passed in `labels` on create.
- Whether Issues: write without Contents: write counts as "push access" for keeping labels on create.
- Status code and events when PATCHing an already-closed issue to closed.
- The per-endpoint content-creation limit for issue creation (only "Some endpoints have lower content creation limits").
- Read-after-write consistency of list-issues.
- Whether backslash escaping or code spans suppress mentions and autolinks.
- Default User-Agent behaviour of Cloudflare Workers `fetch` and Node `fetch`. This was not verified here and belongs to the Cloudflare/Node research topics. Always set the header explicitly.
- Dropped from the researcher's findings as not officially verifiable: a third-party GitHub PR claiming Workers fetch sends no User-Agent, and a Terraform-provider source citation. The 422 `already_exists` behaviour is instead backed by the official troubleshooting page.

## Gotchas and implications for this project

1. **A silently dropped label leads to a duplicate storm.** If the token owner lacks push access, POST still returns 201 but without `youtrack`. The next run cannot find the mirror by label and creates it again, every 10 minutes. Check that the 201 `labels` array contains `youtrack`, and abort the run if it doesn't [1].
2. **Human edits break the identity.** Mirror identity is label plus the `^\[YT-(\d+)\]` title regex. Anyone with Triage or higher can rename a title or remove the label, which makes the script create a new mirror. Two issues may also parse to the same number. The docs offer no server-side uniqueness mechanism [14].
3. **Pagination is cursor-based.** It gives only `next` and `prev`, uses `/repositories/{id}` URLs, and has no `last`. Never build `?page=N`; follow `rel="next"` verbatim. Keep the default `sort=created` so the order is stable while paging [3][9].
4. **PRs appear in the list.** Skip items with a non-null `pull_request`. Otherwise a PR titled `[YT-n]` with the label could be treated as a mirror, or be closed by the script [1].
5. **Resolved items cost 2 writes.** There is no `state` on create, so a resolved item needs a POST plus a PATCH (5 points each, notifications). With MAX_WRITES_PER_RUN=30 that is 15 resolved items per run. The initial backfill (18 resolved + 11 unresolved = 47 writes) spans at least 2 runs [1][8].
6. **POST is not idempotent.** A 10 s server timeout, a 5xx or a network error can happen after the issue was created. Do not blindly retry a create; defer to the next run, which re-lists [12].
7. **403 and 404 are ambiguous.** 403/429 can mean a rate limit or a permission error. A private repo answers 404 for bad, expired, pending or wrong-owner tokens. Classify errors by `x-ratelimit-remaining`, `retry-after` and a message containing "secondary rate limit", and alert on any other 401/403/404 [8][12].
8. **Fine-grained PAT org constraints.** Admin approval is the default, and a pending token reads public resources only. Outside collaborators can't use fine-grained PATs. Lifetime is capped at 366 days by default, and tokens unused for a year are removed. Every mirror issue is authored by, and subscribes, the owner's personal account [11][13].
9. **The primary limit is shared per user.** Other PATs, `gh` CLI use and OAuth apps of the same user draw on the same 5,000/h. The mirror's own usage is small [8].
10. **Pin `X-GitHub-Api-Version`.** Unversioned requests use 2022-11-28 until March 10, 2028, then silently move to the next-oldest supported version. A pinned retired version gets 410 [5].
11. **User-Agent is mandatory.** Without it the request gets 403 (live). Set it explicitly in both runtimes [10].
12. **Length limits.** Undocumented, but the community limits are 256 for the title and 65,536 for the body. A long summary plus the `[YT-n] ` prefix, or a long description plus the link, could return 422 on every run. Also, the YouTrack `description` can be JSON null [20][21].
13. **Copied text pings and cross-links.** `@name` notifies org members with repo access. `#12` or `GH-12` links to mirror-repo issue #12 and leaves a backlink there [15][16].
14. **Doc oddities.** List-issues says "Only open issues will be listed." yet honours `state=all`. The create-label prose requires `color`, but its table marks only `name` as required. `per_page` above 100 is silently capped (live). Label matching is case-insensitive (live), so an existing `YouTrack` label would match `youtrack` [1][2].
15. **Redirects.** GitHub says to follow 301/302/307 [9]. Per the Fetch spec, a 301 or 302 on POST is re-issued as GET; not verified here. Treat a create as successful only on status 201 with a `number` in the body.
16. **Write pacing.** A 1 s pause between writes (documented best practice) adds about 30 s per run at the 30-write cap. Check this against the Workers cron wall-time limits in the Cloudflare doc [9].

## Open questions for the user

1. **Token owner's role and membership.** What is the token owner's role on the repo, and are they an org member? A Read or Triage role means labels are dropped on create, and label creation needs Write. An outside collaborator can't use a fine-grained PAT. Options:
   - Write/Maintain/Admin org member
   - Triage
   - Read
   - Outside collaborator
2. **Issues: write and "push access".** Does a PAT with Issues: write but no Contents: write keep `labels` on create? This is undocumented. Options:
   - Verify with one test issue before go-live
   - Add Contents permission
   - Create without labels, then add labels in a separate call
3. **Org approval.** Does the org allow fine-grained PATs, and is this token approved rather than pending?
4. **Who creates the `youtrack` label?** Options:
   - Create it manually once
   - Script ensures it each run (GET, then POST on 404)
   - Script ensures it only when BACKFILL=1
5. **API version to pin.** Options:
   - `2026-03-10`
   - `2022-11-28`
6. **@mentions and `#n` in copied descriptions.** Options:
   - Copy verbatim
   - Escape `@` and `#` (effect undocumented)
   - Wrap in a code block (effect undocumented)
   - Link only, no description
   - Admin-configured custom autolink
7. **`state_reason` when closing.** Options:
   - Always `completed`
   - Map from the YouTrack state or resolution
   - Omit it
8. **Length limits.** Should titles and bodies be truncated to the community-reported limits (256 / 65,536)?
9. **Write pause.** Should the script pause 1 s between writes, given the Workers runtime budget?
10. **Missing mirror.** What should happen when a mirror disappears (deleted, transferred, label removed, title edited)? Options:
    - Recreate it
    - Log and skip (needs persistent state, which is unavailable on Workers Free without KV)
11. **PAT or GitHub App?** Options:
    - Fine-grained PAT (interim)
    - GitHub App installation token

## Sources

1. REST API endpoints for issues -- https://docs.github.com/en/rest/issues/issues?apiVersion=2026-03-10 (also `?apiVersion=2022-11-28`; fetched 2026-09-24)
2. REST API endpoints for labels -- https://docs.github.com/en/rest/issues/labels?apiVersion=2026-03-10
3. Using pagination in the REST API -- https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api
4. Live request, Hello-World issues -- https://api.github.com/repos/octocat/Hello-World/issues?state=all&per_page=2
5. API Versions -- https://docs.github.com/en/rest/about-the-rest-api/api-versions
6. Breaking changes -- https://docs.github.com/en/rest/about-the-rest-api/breaking-changes (Version 2026-03-10 section)
7. Permissions required for fine-grained personal access tokens -- https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
8. Rate limits for the REST API -- https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
9. Best practices for using the REST API -- https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
10. Getting started with the REST API -- https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api
11. Managing your personal access tokens -- https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
12. Troubleshooting the REST API -- https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api
13. Setting a personal access token policy for your organization -- https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization
14. Repository roles for an organization -- https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization
15. Basic writing and formatting syntax -- https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax
16. Autolinked references and URLs -- https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls
17. About searching on GitHub -- https://docs.github.com/en/search-github/getting-started-with-searching-on-github/about-searching-on-github
    17a. About notifications -- https://docs.github.com/en/subscriptions-and-notifications/concepts/about-notifications
18. Configuring notifications -- https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications
19. Authenticating to the REST API -- https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api
20. Community discussion #27190, body length (staff answer, 2020-12-10) -- https://github.com/orgs/community/discussions/27190 (unofficial)
21. dead-claudia/github-limits, "Issue title" section -- https://github.com/dead-claudia/github-limits (unofficial, community-maintained)
22. Community discussion #50326, secondary limit on issue creation (2023-03-17) -- https://github.com/orgs/community/discussions/50326 (unofficial)
