# Live verification against the YouTrack instance

> Done 2026-09-24 against `https://youtrack.ai.buas.nl` (YouTrack Server 2025.2) using the
> permanent token in `.env` (`YOUTRACK_TOKEN`). Every request was a `GET` to `/api/issues`.
> No other endpoint or method was called.

All requests used this shape (token never printed):

```bash
set -a; . ./.env; set +a
curl -sS -G "https://youtrack.ai.buas.nl/api/issues" \
  -H "Authorization: Bearer $YOUTRACK_TOKEN" -H "Accept: application/json" \
  --data-urlencode 'query=...' --data-urlencode 'fields=...' --data-urlencode '$top=...'
```

## Step 0: how `resolved` looks when unset

Fields: `idReadable,numberInProject,summary,description,resolved,updated`

Unresolved (`query=project: CUI #Unresolved`, `$top=1`):

```json
[
  {
    "idReadable": "CUI-31",
    "summary": "[individual] Explore GH-YouTrack integrations",
    "updated": 1790256733345,
    "resolved": null,
    "numberInProject": 31,
    "description": "Probably gonna have Claude draft up a project to use API keys to have ideally bidirectional syncing",
    "$type": "Issue"
  }
]
```

Resolved (`query=project: CUI #Resolved`, `$top=1`):

```json
[
  {
    "idReadable": "CUI-11",
    "summary": "[Team] Audit and revise the research proposal",
    "updated": 1790254466400,
    "resolved": 1789644365309,
    "numberInProject": 11,
    "description": "Review Gabriel's draft, identify factual and structural issues, apply corrections, merge into the shared document.",
    "$type": "Issue"
  }
]
```

Empty description (CUI-30, found by filtering a full-project fetch):

```json
{
  "idReadable": "CUI-30",
  "summary": "Add finalized research proposal to github",
  "updated": 1790254466396,
  "resolved": null,
  "numberInProject": 30,
  "description": null,
  "$type": "Issue"
}
```

What the spec says (`./youtrack-openapi.json`, `info.version = 2025.2`,
`components.schemas.Issue.properties`):

| Field             | Spec                                      | Observed                                             |
| ----------------- | ----------------------------------------- | ---------------------------------------------------- |
| `idReadable`      | `string`, readOnly                        | string                                               |
| `numberInProject` | `integer/int64`, readOnly                 | number                                               |
| `summary`         | `string`                                  | string                                               |
| `description`     | `string` (no `nullable`)                  | string, or **`null` when empty** (never `""` in CUI) |
| `resolved`        | `integer/int64`, readOnly (no `nullable`) | epoch ms, or **`null` when unresolved**              |
| `updated`         | `integer/int64`, readOnly                 | epoch ms                                             |

Every returned object also includes `"$type": "Issue"`, which we didn't request.

**Implication:** type `resolved` as `number | null` and `description` as `string | null`. The spec
is not reliable about nullability.

## Project shape (probe P1, `query=project: CUI`, `$top=1000`)

| Metric                    | Value                                                      |
| ------------------------- | ---------------------------------------------------------- |
| Issues visible            | 29                                                         |
| Resolved / unresolved     | 18 / 11                                                    |
| `numberInProject` range   | 1..31                                                      |
| Missing numbers           | 24, 27 (deleted or moved)                                  |
| `description == null`     | 1 (CUI-30)                                                 |
| Distinct `updated` values | 29 (all distinct; several only ms apart, from a bulk edit) |
| Oldest `updated`          | 1789307190036                                              |
| Newest `updated`          | 1790256733345 (2026-09-24 13:32 UTC)                       |

**Implication for backfill:** `numberInProject` has gaps, so "max issue number" can't stand in
for "issue count".

## Paging and sorting (probes P3-P5)

- **P3:** without `$top`, `project: CUI` returned all 29. The project is too small to show the
  default page size, so the code should always send `$top`.
- **P4:** `project: CUI sort by: updated desc`, `$top=5` came back strictly descending by `updated`:
  31, 11, 30, 14, 20.
- **P5:** the same query with `$top=2&$skip=2` returned 30 and 14 (rows 3-4 of P4), so
  `$top`/`$skip` paging is consistent.
