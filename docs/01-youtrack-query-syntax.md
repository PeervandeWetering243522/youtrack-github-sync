# YouTrack Search Query Syntax (Server 2025.2) for the CUI Mirror

> Researched 2026-09-24 for the YouTrack -> GitHub mirror. Status tags: [verified] = source re-opened and quote confirmed; [live] = confirmed by a live request; [partial] = indirect/partial support; [undocumented] = not found in official docs.

The instance OpenAPI spec reports `info.version` = `2025.2` [15]. The search syntax below comes from the versioned **Server 2025.2** Search Query Reference [1]. Its text was diffed against Server 2026.2 [2] and Cloud 2026.2 [3]. The only differences are the page title, the date, and a new `customer groups` attribute in 2026.2, so nothing in this doc depends on which version you read. The REST Developer Portal has no versions: `server/2025.2/api-query-syntax.html` returns a 302 redirect to `/devportal/api-query-syntax.html`. That means the REST citations [11]-[14] are the current pages, dated 2026.

## TL;DR

| Question                                 | Answer                                                                                                                                                                                  | Status                               | Source  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------- |
| Project filter                           | `project: CUI` (the shortName, which the docs call the "project ID") or `project: {ComfyUI 26-27S1}` (full name in braces). The alias `in:` and the single-value form `#CUI` also work. | [verified] [live]                    | [1][14] |
| Case sensitivity                         | "Grammar is case-insensitive." Live, `project: cui` and `{comfyui 26-27s1}` also match.                                                                                                 | [verified] [live]                    | [1]     |
| Name with spaces, no braces or in quotes | HTTP 400 `invalid_query`                                                                                                                                                                | [live]                               | -       |
| Sort keyword                             | `sort by: updated desc`. `order by` is a documented alias. Multiple keys are comma-separated.                                                                                           | [verified] [live]                    | [1]     |
| Must `sort by` come last?                | No. The grammar allows it anywhere. Live, putting it first gave the same result.                                                                                                        | [verified] [live]                    | [1]     |
| Default order (no sort)                  | REST: "the default issue sorting is sort by: updated desc". A query with a text term defaults to relevance instead.                                                                     | [verified] [live]                    | [12][6] |
| Tie-breaker for equal sort values        | Not documented. Add an explicit second key, e.g. `, {issue id} desc` (accepted).                                                                                                        | [undocumented]                       | [1]     |
| Date literal formats                     | `YYYY-MM-DD`, `YYYY-MM`, `MM-DD`, with optional time `HH:MM[:SS]`. Date and time are joined with `T`: `2010-01-01T12:00`.                                                               | [verified] [live]                    | [1]     |
| Range / open end                         | `a .. b`, inclusive at both ends. `*` is an open bound.                                                                                                                                 | [verified] [live]                    | [1]     |
| Hour-granular relative syntax            | Yes: `updated: {minus 2h} .. *`. Units shorter than one hour are "not supported".                                                                                                       | [verified] [live]                    | [1]     |
| Time zone                                | Relative values use "the time zone of the current user". The time zone for absolute literals is not documented; live, they behaved as UTC for this token.                               | [verified] / [undocumented] / [live] | [1]     |
| #Resolved / #Unresolved                  | Keywords for the Resolved property, which is derived from the state-type field(s). `resolved date:` is the date attribute.                                                              | [verified] [live]                    | [1]     |
| REST `query` = UI syntax?                | Yes: "same syntax with the adjustment for URL encoding".                                                                                                                                | [verified] [live]                    | [11]    |
| Recommended query                        | `project: CUI updated: {minus 24h} .. * sort by: updated desc, {issue id} desc`                                                                                                         | [live]                               | [1]     |

## Details

### 1. `project:` attribute

- Syntax: `project: <project name> | <project ID>`, alias `in`, and it "can also be referenced as a single value" (`#CUI`) [1]. [verified]
  > project: <project name> | <project ID> Returns issues that belong to the specified project. This attribute can also be referenced as a single value.
  > Accepts a project name or project ID.
- The "project ID" is the shortName [14]: `shortName | String | The ID of the project. This short name is also a prefix for an issue ID.` [verified]. The Create a Project page gives the example `project: <project ID> #{Unassigned}` [7]. [verified]
- Braces around values with spaces [1]: `{ } | Encloses attribute values that contain spaces.` The grammar: `<ComplexValue> ::= '{' <value (can have spaces)> '}'`. Doc example: `project: {IntelliJ IDEA}` [5]. [verified]
- Double quotes mark text search (`<QuotedText>`), not a value [1]. Live, `project: "ComfyUI 26-27S1"` returned HTTP 400. [live]
- Case: "Grammar is case-insensitive." [1] The docs do not say whether _values_ are case-insensitive [undocumented]. Live, `project: cui`, `PROJECT: CUI` and `project: {comfyui 26-27s1}` all return the same 29 issues. [live]
- The docs format it as "Separate the attribute from the value with a colon and a space." [4] [verified]

### 2. Sorting

- Syntax [1]: `sort by: <value> <sort order>`. The Sort Order row lists `asc, desc` and the Aliases row lists `order by`. [verified]
- Sortable attributes, verbatim [1]:
  > You can sort issues by values from the following attributes: star, updated, updater, created, {resolved date}, project, reporter, {issue id}, votes, summary, comments, <custom field>, and {attachment size}.
- Grammar [1]: `<Sort> ::= 'sort by:' <SortField> (',' <SortField>)*` and `<SortField> ::= <SortAttribute> ('asc' | 'desc')?`. This means you can give multiple keys and the direction is optional. The docs do not say which direction applies when it is omitted [undocumented]. Live, omitting it gave desc for `updated`, `created` and `{issue id}` but asc for `votes` (researcher's result; the `updated` case was re-checked). Always write the direction.
- Position: `<Sort>` is one of the `<TermItem>`s in `<Term> ::= <TermItem>*` [1], so it does not have to come last. Live, `sort by: updated desc project: CUI` gave the same result. [verified] [live]
- Default order: [12] says "If you don't specify any sorting in the query, the default issue sorting is sort by: updated desc." [verified] The UI docs give the same rule for attribute queries and relevance for text search [5]: "For attribute-based search queries, the results are sorted by last update. For text search, the results are sorted by relevance." [verified] Relevance applies only when the query has no explicit sort attribute [6]: "The explicit sort attribute overrides the default sort by relevance." [verified]
- Tie-breaker: [undocumented]. The docs never say how rows with equal sort values are ordered. The researcher saw ties (all votes=0) come back in issue-number order, and `$skip` paging over them was stable. That is behaviour, not a guarantee. A documented secondary key (`{issue id}`) is accepted. [live]

### 3. Date and date-range search (`updated`, `created`, `resolved date`)

- Attributes [1]: `updated: <date> | <period>` ("Returns issues where the most recent change occurred on a specific date or within a specified time frame."), `created: <date> | <period>`, and `resolved date: <date> | <period>` ("Returns issues that were resolved on a specific date or within a specified time frame."). [verified]
- Literal formats [1]:

  > Specify dates in the format: YYYY-MM-DD or YYYY-MM or MM-DD. You also can specify a time in 24h format: HH:MM:SS or HH:MM.

  The page writes the combined format with a markup glitch, as `YYYY-MM-DD}}T{{HH:MM:SS`. Its example shows the real form, `created: 2010-01-01T12:00 .. 2010-01-01T15:00`, and the Advanced Search page uses the same form: `Actual start: 2025-03-25T09:00 .. 2025-03-25T18:00` [4]. [verified] Suffixes (`Z`, offsets), milliseconds and epoch numbers are not documented. Live, each returned HTTP 400. [live]

- Range [1]: `..`: "The search results include the upper and lower bounds." `*`: "When used with the .. symbol, substitutes a value that determines the upper or lower bound in a range search." [verified] The grammar `<ValueRange> ::= <Value> '..' <Value>` does not show spaces, but every doc example puts spaces around `..`, and live parsing requires them (see Gotchas). [verified] [live]
- Predefined relative values, verbatim from the table [1]: `Now`, `Today`, `Tomorrow`, `Yesterday`, `Sunday`, `Monday`, `Tuesday`, `Wednesday`, `Thursday`, `Friday`, `Saturday`, `{Last working day}`, `{This week}`, `{Last week}`, `{Next week}`, `{Two weeks ago}`, `{Three weeks ago}`, `{This month}`, `{Last month}`, `{Next month}`, `Older`. [verified]
- Custom relative values (hour-granular syntax exists) [1]:

  > Find issues that were updated in the last two hours: updated: {minus 2h} .. *

  Use `minus` for the past and `plus` for the future. The time frame is written as "a series of whole numbers followed by a letter that represents the unit of time", with the example `2y 3M 1w 2d 12h` [1]. [verified] The page gives no separate unit table; the letters y/M/w/d/h are known only from that example [partial].

  > Queries that specify hours will filter for events that took place during the specified hour.
  > This level of precision only applies to hours.
  > Search queries that specify units of time shorter than one hour (minutes, seconds) are not supported.

  A named "last N hours" keyword (such as `{Last 24 hours}`) is [undocumented]. Live, it returned HTTP 400.

- Time zone: relative values "are calculated relative to the current date according to the time zone of the current user" [1] [verified]. That is the token owner's profile "Local time zone" [8]: "This set of controls determines which time zone is used to present date values in YouTrack." [verified] The time zone for **absolute** literals is [undocumented]. Live, a sweep of one-hour windows matched an issue updated at 17:29Z only in the window `2026-09-23T17:00 .. 2026-09-23T17:59`, not the 19:00 window. So literals behaved as UTC for this token, which may be because the profile is set to UTC. [live]

### 4. `#Resolved` / `#Unresolved` and `resolved date`

- [1]: "This keyword references the Resolved issue property. This property is set based on the current value or combination of values for any custom field that stores a state type." [verified]
- With several state-type fields [1]: "the Resolved property is only true when all the state-type fields are assigned values that are considered to be resolved", and "the Unresolved property is true when any state-type field is assigned a value that is not considered to be resolved." [verified]
- `State: <value> | Resolved | Unresolved` is also documented [1]. A keyword "is preceded by the number sign (#) or the minus operator" [1], so `-Resolved` is grammatical. [verified]
- `resolved date:` takes the same date forms (doc example `#MPS resolved date: {this month}`) and is a sort attribute (`{resolved date}`) [1]. [verified]
- REST `Issue.resolved` [12]: "null if the issue is still in an unresolved state." [verified] Live: `#Resolved` returned exactly the 18 issues whose `resolved` is not null, and `#Unresolved` the 11 whose `resolved` is null. [live]

### 5. REST `query` parameter vs UI search box

- [11]: "When working with collections of issues, the query parameter represents a search query and has the same syntax with the adjustment for URL encoding." Example: `query=project:%20%7BSample%20Project%7D`. [verified]
- [12]: `query | String | Issue search query. Read more about the search syntax here: Search Query Reference`. The example percent-encodes `#` as `%23` (`query=for:%20me%20%23Unresolved`). [verified] The instance spec's `query` description links to the **Cloud** search reference [15], whose text is the same as Server's for these topics [3]. [verified]
- Keywords follow the server's global language [9]: "the language that is set at the global level is used for search queries, commands, and custom fields." [10]: "The language used for search queries is determined by the system language, regardless of each user's personal language preference." [verified]
- Encoding: Node `URLSearchParams` output, which uses `+` for spaces and encodes `%3A`, `%7B`, `%23` and `%24top`, is accepted. [live]

### 6. Combining project + date range + sort

- Conjunction [1]: "Searches that specify values for multiple attributes are treated as conjunctive." Several values for the _same_ attribute are ORed [1]: "Searches that include multiple values for a single attribute are treated as disjunctive." [verified]
- Order is free [4]: "You can enter these search parameters in any order." [verified]
- If you use explicit `and`/`or`, "you should wrap all of your search arguments in parenthesis" [1]. [verified]
- Working form [live]:
  ```
  project: CUI updated: {minus 24h} .. * sort by: updated desc, {issue id} desc
  ```
- Paging [13]: "$skip=N lets you skip N found elements and returns elements starting from N+1." [verified] Default page size when `$top`is omitted: the Pagination page says "For most resources, the server returns a maximum of 42 elements by default." [13]. The Issues page says the count "is limited to the Max issues to export value" [12]. The two pages conflict [verified], so always send`$top`.

### 7. Live verification

See the next section.

## Live observations

Request shape (GET only; token never shown):
`curl -sS -G https://youtrack.ai.buas.nl/api/issues -H "Authorization: Bearer $YOUTRACK_TOKEN" -H "Accept: application/json" --data-urlencode 'query=<Q>' --data-urlencode 'fields=numberInProject,updated' --data-urlencode '$top=1000'`

Re-run by the verifier at 2026-09-24T17:39Z. Results are listed as numberInProject. "desc" means `updated` values were strictly descending.

| Query `<Q>`                                                                                                                                             | HTTP | Count  | Result                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project: CUI sort by: updated desc`                                                                                                                    | 200  | 29     | 31,11,30,14,20,19,18,29,28,9,26,15,23,25,13,17,21,22,10,16,4,3,6,5,8,7,1,12,2 (desc)                                                                 |
| `project: {ComfyUI 26-27S1} sort by: updated desc`                                                                                                      | 200  | 29     | identical                                                                                                                                            |
| `project: CUI` (no sort)                                                                                                                                | 200  | 29     | identical (default updated desc)                                                                                                                     |
| `project: CUI order by: updated desc`                                                                                                                   | 200  | 29     | identical                                                                                                                                            |
| `sort by: updated desc project: CUI`                                                                                                                    | 200  | 29     | identical                                                                                                                                            |
| `project: cui sort by: updated desc`                                                                                                                    | 200  | 29     | identical                                                                                                                                            |
| `project: CUI sort by: updated desc, {issue id} desc`                                                                                                   | 200  | 29     | identical                                                                                                                                            |
| `project: CUI sort by: updated asc`                                                                                                                     | 200  | 29     | exact reverse                                                                                                                                        |
| `project: CUI sort by: updated desc`, `$top=3&$skip=3`                                                                                                  | 200  | 3      | 14,20,19 (rows 4-6)                                                                                                                                  |
| `project: CUI #Resolved`                                                                                                                                | 200  | 18     | all have `resolved` != null                                                                                                                          |
| `project: CUI #Unresolved`                                                                                                                              | 200  | 11     | 31,30,19,29,28,9,15,25,21,7,1                                                                                                                        |
| `project: CUI updated: 2026-09-21 .. 2026-09-23 sort by: updated desc`                                                                                  | 200  | 10     | 29,28,9,26,15,23,25,13,17,21                                                                                                                         |
| `project: CUI updated: 2026-09-24 .. * sort by: updated desc`                                                                                           | 200  | 7      | 31,11,30,14,20,19,18                                                                                                                                 |
| `project: CUI updated: 2026-09-23T17:00 .. 2026-09-23T17:59`                                                                                            | 200  | 1      | 29 (updated 17:29:40Z, so literals read as UTC)                                                                                                      |
| `project: CUI updated: 2026-09-23T19:00 .. 2026-09-23T19:59`                                                                                            | 200  | 0      | -                                                                                                                                                    |
| `project: CUI updated: {minus 24h} .. * sort by: updated desc`                                                                                          | 200  | 8      | 31,11,30,14,20,19,18,29. Includes CUI-29 (17:29Z the previous day) although the exact bound would be 17:39Z, so the bound was rounded down to 17:00. |
| `project: CUI updated: Today` / `{This week}`                                                                                                           | 200  | 7 / 17 | -                                                                                                                                                    |
| `project: CUI resolved date: {minus 24h} .. *`                                                                                                          | 200  | 3      | 14,20,18                                                                                                                                             |
| URLSearchParams-encoded `project: {ComfyUI 26-27S1} #Unresolved updated: {minus 24h} .. * sort by: updated desc`, `$top=5` (sent with `curl -G --data`) | 200  | 4      | 31,30,19,29                                                                                                                                          |

Undocumented forms, tested to confirm they fail:

| Query                                              | HTTP    | Result                                |
| -------------------------------------------------- | ------- | ------------------------------------- |
| `project: ComfyUI 26-27S1` (no braces)             | 400     | `invalid_query`                       |
| `project: CUI updated: 2026-09-24..*` (no spaces)  | 400     | `invalid_query`                       |
| `project: CUI updated: {minus 24h}..*` (no spaces) | **200** | **0 rows, no error**                  |
| `project: CUI updated: {minus 30m} .. *` (minutes) | **200** | **all 29 rows** (behaves like months) |
| `project: CUI updated: 2026-09-23T17:29:40Z .. *`  | 400     | `invalid_query`                       |

The researcher reported additional checks that the verifier did not re-run; they are consistent with the results above. HTTP 400 for: quoted project name, unknown project `CUIX`, `sort by: bogusattr`, `{Last 24 hours}`, millisecond literals, and epoch-ms literals. `'{minus 24h} ..*'` returned 200 with 0 rows, while `'{minus 24h}.. *'` worked. Bounds with seconds or minutes cover the whole second or minute. `{minus Nd} .. *` is rounded down to 00:00 of that day. A single `{minus 24h}` value with no range matches only the one-hour bucket 24 hours ago.

## Undocumented / not found

- Tie-break order for equal sort values, and the default direction when `asc`/`desc` is omitted.
- The time zone used for absolute date/time literals. They behaved as UTC live.
- Any "last N hours" keyword. Only `{minus Nh}` exists.
- Minute or second relative units: documented as "not supported". Live, `m` is silently accepted as months.
- Whether whitespace around `..` is required. The grammar does not show it; live, it is required.
- `Z`/offset suffixes, milliseconds, and epoch values in date literals. All return 400 live.
- Whether values (as opposed to grammar keywords) are case-insensitive. They are, live.
- A server-side maximum for `$top`. `$top=1000` worked on 29 issues.
- Refuted or corrected researcher points: none of substance. Every quote was found on the cited page. One wording fix: the Search Query Reference says "Sort Order | asc, desc" and "Aliases | order by" as separate table rows, not as the single string that was quoted.

## Gotchas and implications for this project

1. **Spacing around `..` fails silently for relative values.** `{minus 24h}..*` returns HTTP 200 with 0 rows. The mirror would then think nothing changed and never close mirrors. Always emit `..` and cover the query builder with a unit test.
2. **Never use minutes.** `{minus 30m}` matches everything (a full scan every run). Build the lookback as integer hours: `{minus ${LOOKBACK_HOURS}h}`.
3. **Relative bounds are rounded down.** `{minus Nh} .. *` starts at the top of the hour, and `{minus Nd} .. *` at 00:00 in the user's time zone. The window is only ever wider, never narrower, so it is safe for a lookback. Prefer `h` over `d`. Keep the ` .. *`: without it, `{minus 24h}` is a one-hour bucket.
4. **Time zone of literals.** If you format an ISO cutoff into the query, an unknown profile time zone could shift it. Two TZ-independent options: `{minus Nh} .. *`, or a client-side stop on the epoch-ms `updated` field while paging `sort by: updated desc`.
5. **HTTP 400 `invalid_query` means a configuration error, not "no issues".** A renamed project, a changed shortName, a missing brace, or a server system-language change [9] all cause it. Fail the run loudly.
6. **Deterministic paging.** Bulk edits in CUI produce `updated` values only milliseconds apart. Add `, {issue id} desc` as a documented secondary key. Also de-duplicate by `numberInProject` within a run: an edit during paging moves the issue to the top, and the next page then repeats one row. This point is the verifier's own analysis, not from the docs.
7. **Encode properly.** A raw `#` in a hand-built URL starts a fragment. Use `URLSearchParams` (confirmed working live).
8. **Always send `$top`** and loop until a page returns fewer rows than `$top`, because the documented default page size is contradictory [12][13].
9. **Always include an explicit `sort by:`.** Any text term would otherwise switch the order to relevance [6], and a profile setting also affects text-search ordering.

## Open questions for the user

1. **Lookback filtering: server-side, client-side, or both?**
   - Server-side `updated: {minus <H>h} .. *` (rounded down to the hour; silent 0 rows if the spacing is wrong)
   - Client-side stop at `updated < now - LOOKBACK` on `project: CUI sort by: updated desc, {issue id} desc` (exact and TZ-independent; may fetch one extra page)
   - Both
2. **Project reference:** `project: CUI`, `project: {ComfyUI 26-27S1}` (the semester-style name may change), or configurable through an env var.
3. **Secondary sort key:** add `, {issue id} desc`, or rely on de-duplication plus the lookback overlap.
4. **Profile time zone of the token owner:** set it explicitly (e.g. UTC) in the UI, or avoid absolute literals entirely. The allowed endpoints cannot read the current setting.
5. **Page size for BACKFILL:** a moderate `$top` (e.g. 100) in a loop, or large pages. The upper cap is undocumented.

## Sources

1. Search Query Reference | YouTrack Server 2025.2 Help -- https://www.jetbrains.com/help/youtrack/server/2025.2/search-and-command-attributes.html (last modified 20 August 2025)
2. Search Query Reference | YouTrack Server 2026.2 Help -- https://www.jetbrains.com/help/youtrack/server/search-and-command-attributes.html (17 September 2026; diffed, only adds `customer groups`)
3. Search Query Reference | YouTrack Cloud 2026.2 Help -- https://www.jetbrains.com/help/youtrack/cloud/search-and-command-attributes.html (17 September 2026; same text as [2] apart from the title)
4. Advanced Search | YouTrack Server 2025.2 Help -- https://www.jetbrains.com/help/youtrack/server/2025.2/attribute-based-search.html (05 September 2025)
5. Sample Search Queries | YouTrack Server 2025.2 Help -- https://www.jetbrains.com/help/youtrack/server/2025.2/sample-search-queries.html (27 August 2025)
6. Text Search | YouTrack Server 2025.2 Help -- https://www.jetbrains.com/help/youtrack/server/2025.2/full-text-search.html (05 June 2025)
7. Create a Project | YouTrack Server 2025.2 Help -- https://www.jetbrains.com/help/youtrack/server/2025.2/create-new-project.html (08 September 2025)
8. General Profile Settings | YouTrack Server 2025.2 Help -- https://www.jetbrains.com/help/youtrack/server/2025.2/general-profile-settings.html (21 January 2025)
9. Internationalization | YouTrack Server 2025.2 Help -- https://www.jetbrains.com/help/youtrack/server/2025.2/internationalization-settings.html (18 January 2024)
10. Search Terms for Additional System Languages | YouTrack Server 2026.2 Help -- https://www.jetbrains.com/help/youtrack/server/localized-search-terms.html (17 September 2026)
11. Query Syntax | Developer Portal for YouTrack and Hub -- https://www.jetbrains.com/help/youtrack/devportal/api-query-syntax.html (10 September 2026; unversioned, `server/2025.2/api-query-syntax.html` redirects here)
12. Issues | Developer Portal for YouTrack and Hub -- https://www.jetbrains.com/help/youtrack/devportal/resource-api-issues.html (04 July 2026)
13. Pagination | Developer Portal for YouTrack and Hub -- https://www.jetbrains.com/help/youtrack/devportal/api-concept-pagination.html (10 September 2026)
14. Project | Developer Portal for YouTrack and Hub -- https://www.jetbrains.com/help/youtrack/devportal/api-entity-Project.html (01 July 2026)
15. Instance OpenAPI spec -- `youtrack-openapi.json` in repo root (`info.version` 2025.2; the `/issues` `query` description links to the Cloud Search Query Reference)
