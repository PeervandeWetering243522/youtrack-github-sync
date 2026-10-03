# Assignees: matching YouTrack users to GitHub accounts (research)

> Researched 2026-10-02. **Status: research doc. Every question in section D of
> [07](07-open-questions.md) is answered, in [08](08-decisions.md) as U1-U17; the matching chain
> below is accepted (U17). Implemented: see [13-assignees-plan.md](13-assignees-plan.md), whose
> "As built" section lists where the code differs from the plan; `README.md` describes the
> behaviour as built. Line references below (`src/...:n`, `README.md:n`) are to the code before
> the implementation.** The idea under study: assign each GitHub mirror to the GitHub account of its
> YouTrack assignee, matched by the BUas student ID that people carry in their login or email.
> GitHub facts come from the docs (docs.github.com, REST API version 2026-03-10) plus
> unauthenticated GETs against public repos (octocat/Hello-World, cli/cli, torvalds/linux).
> YouTrack facts come from the Server 2025.2 docs, the unversioned devportal and, where marked,
> the current 2026.x docs, plus live GET probes of project CUI and one screenshot of a student's
> own profile. The snapshot of the group's own repo comes from authenticated read-only GETs and
> one read-only GraphQL query. Only counts and shapes were recorded: `<ID>` is a 6-digit student
> ID and `<letters>` a run of letters. Every person in an example is a placeholder
> (`jdoe123456`, `JaneDoe123456`, `123456@buas.nl`). Status tags as in docs 01-05, plus
> [corrected]: [verified] = source re-opened and quote confirmed; [live] = confirmed by a live
> request (or, where marked, seen on the user's screenshot); [partial] = indirect, inferred or
> community-only support; [undocumented] = not found in official docs; [corrected] = a verifier
> changed the first claim, and the corrected one is shown.

## What exists today

Live snapshot, 2026-10-02. Counts and shapes only.

| What        | YouTrack (project CUI)                                                                                   | GitHub (the group's org-owned private repo)                                                                         |
| ----------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| User field  | One: `Assignee`, `SingleUserIssueCustomField` (`user[1]`), 1 of 9 fields per issue                       | An `assignees` array on every issue, up to 10                                                                       |
| Issues      | 52 issues: 46 assigned (12 unresolved, 34 resolved), 6 unassigned (all 6 unresolved)                     | 17 mirrors (label `youtrack`), 0 with an assignee                                                                   |
| People      | 4 distinct assignees; 6 users can be set as assignee (the field's user bundle)                           | 34 assignable users, one page, all type `User`                                                                      |
| Login shape | All 4 assignees `<letters><ID>`. 2 of the 6 possible assignees have no 6-digit ID                        | 4 of 34 `<letters><ID>`. 30 have no 6-digit run (19 letters only, 8 with dashes, 3 with short digit runs)           |
| Email       | All 4 assignees `<ID>@buas.nl`, same ID as the login on 46 of 46 issues. Of the 6 possible: 1 `null`     | Public profile email `null` for 30 of 34. Of the 4 public ones, 2 are `@buas.nl` and 1 has the `<ID>@buas.nl` shape |
| Commits     | -                                                                                                        | 42, all linked to an account. 38 use an `<ID>@buas.nl` author email, ID equal to the linked login's (38 of 38)      |
| Org         | -                                                                                                        | Not verified (`is_verified: false`). GraphQL verified-domain emails and SAML: refused, needs `read:org`             |
| Token       | One member's permanent token. `/api/users/me` has the same shapes. `/api/admin/projects` customFields [] | One member's classic PAT (`repo`), org member and repo admin. `GET /repos/{o}/{r}/assignees/{login}`: 204           |

- **Match by ID:** 4 of 4 YouTrack assignees match exactly one assignable GitHub login by ID. No
  two GitHub logins share an ID. In both systems the ID sits at the end of the login.
- **Match by login:** 0 of 4. The logins differ between the systems, exactly and ignoring case.
- **Commits:** 3 distinct accounts; the other 4 commits use `users.noreply.github.com` emails.
- **Drift:** an earlier pass the same day counted 14 unresolved and 32 resolved assigned issues.
  The unresolved assigned issues are the ones whose open mirrors would get an assignee.
- `/api/admin/projects?fields=shortName,customFields(field(name),$type)` returned 200 with an empty
  `customFields` for CUI. That it needs project admin rights is a guess, not checked.

So the convention held for every current assignee, and matching on login equality would have
failed for all of them. Most assignable GitHub accounts (staff and other org members) carry no ID.

## TL;DR

- **Feasible on all three hosts,** for one extra GitHub read per run (the repo's assignable
  users), plus at most 5 lookups under the proposed fallback chain, and no extra YouTrack request.
  Assignee writes count against `MAX_WRITES_PER_RUN` like any other write.
- **The student-ID assumption held for every current assignee** (4 of 4), but only through the
  logins. On GitHub, profile emails are mostly hidden (1 of 34 public with the ID), so there the
  "or email" half works only through commit emails, which need `contents: read` on a private repo
  and cover only people who committed. Matching on login equality would have failed for all 4.
- **When the assumption fails** (a GitHub login without the ID, staff, two accounts with one ID,
  login and email disagreeing), the mirror can't find the account. The safe outcome is to leave
  GitHub alone and warn (U3, U6), or to use an explicit map, never to guess.
- **The ID is a convention, not a verified identity,** on either side. The "exactly one match"
  rules and the repo's assignable list are the only safeguards.
- **It changes the README contract** ("Assign ... on GitHub as you like"). The research leaned to
  an opt-in switch; U1 makes it on by default instead, as a breaking v1.0.0 (08).

| Question                                         | Answer                                                                                                                                                                                                                                           | Status                      | Source       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | ------------ |
| Can the scan read the assignee?                  | Yes. Repeat the parameter (`customFields=Type&customFields=Assignee`) and add user subfields. Still one GET per 100 issues; rows grow by about 27%.                                                                                              | [verified] [live]           | [1][2]       |
| What does "unassigned" look like?                | The entry is there with `value: null`. A wrong or alias field name returns HTTP 200 and **no entry**, so a missing entry must never mean "unassigned".                                                                                           | [live]                      | -            |
| Is the field always called `Assignee`?           | No. Admins can rename it, make it multi-value and change its aliases. User fields can be found by type, but nothing marks "the" assignee field.                                                                                                  | [verified] [live]           | [2][8]       |
| Can every token see emails?                      | Not proven either way. 2025.2 names email under no permission; 2026.x ties it to Read User Details. Live, this token sees every email that is set (5 of 6 possible assignees; the one `null` is most likely unset). Logins need Read User Basic. | [partial] [live]            | [10][14]     |
| Is the ID trustworthy?                           | It is a convention. At BUas students can edit their own username and email (screenshot), and emails are most likely unverified (inference). REST exposes no email-verified flag.                                                                 | [verified] [live] [partial] | [20][22][23] |
| Does YouTrack know the GitHub login?             | No, not through the allowed GETs. Hub keeps GitHub details and VCS usernames, readable only through the Hub API.                                                                                                                                 | [verified]                  | [34][35]     |
| Best way to find the GitHub account              | Take the ID from the logins in `GET /repos/{o}/{r}/assignees`: 1 fetch per 100 users, works on all three hosts, 4 of 4 live.                                                                                                                     | [verified] [live]           | [40]         |
| Other ways                                       | Commit emails (needs `contents: read`, at most 3 of 4, can be gamed), public profile emails (1 of 34), user search (public emails only), verified domain or SAML (owner token, Enterprise Cloud), Classroom (closed).                            | [verified]                  | [56]-[77]    |
| Who can be assigned?                             | Yourself, commenters on that issue, anyone with write access, org members with read access. The repo-wide list leaves commenters out (live).                                                                                                     | [verified] [live]           | [41]         |
| Is the assignability check case-sensitive?       | Yes, live: the exact login gives 204, other casing 404. Always write the exact `login` from the list.                                                                                                                                            | [live]                      | [40]         |
| Write calls                                      | `PATCH` replaces the whole set (`[]` clears it). `POST .../assignees` adds up to 10 and keeps the rest. `DELETE` removes the named ones. All are dropped silently without push access.                                                           | [verified]                  | [39][40]     |
| A login that can't be assigned (caller can push) | Officially undocumented. Community reports: 422 for the whole create or PATCH; `POST .../assignees` ignores the login.                                                                                                                           | [undocumented] [partial]    | [82][83][89] |
| Can the Action's `GITHUB_TOKEN` assign?          | Yes per the docs: Add assignees works with installation tokens and needs Issues write, which the workflow already grants.                                                                                                                        | [verified] [corrected]      | [40][46]     |
| Who assigned someone?                            | Not on the issue object. Only issue events carry `assigner`, at one GET per issue.                                                                                                                                                               | [verified] [live]           | [49][50]     |
| Side effects                                     | The assignee is notified and subscribed to the issue. Assignments made through the API are emailed (community report).                                                                                                                           | [verified] [partial]        | [51][52][90] |
| Singular `assignee`                              | Removed in API 2026-03-10 (live-confirmed). `@octokit/openapi-types` 29.0.1 still types it.                                                                                                                                                      | [verified] [live]           | [43]         |

## YouTrack: the Assignee field and users

### Reading the field

- **Shapes** [verified] [2][3][4]: the docs map `user[1]` to `SingleUserIssueCustomField` and
  `user[*]` to `MultiUserIssueCustomField`. A single field's `value` is one `User`, or `null` when
  unassigned (null seen live only; no doc sample shows it). "Multi-value fields return an array of
  values." [2] The generated types agree: `value` is `User` (src/generated/youtrack.ts:9886-9889)
  and `User[]` (9543-9546). `$type` always comes back: "The $type attribute will appear in the
  response regardless of whether you specify it explicitly or not." [2]
- **Request** [verified] [live]: `customFields` can be repeated. "To show more than one custom
  field, use this parameter several times." [1] The docs' example is
  `&customFields=type&customFields=assignee&customFields=priority` [1]. The instance spec says the
  same (src/generated/youtrack.ts:5783); only its TypeScript type is single-valued
  (`customFields?: string`, :5784).
- **One `value(...)` spec for both entries** [live] [6]: with
  `customFields(name,$type,value(name,login,email,...))`, the Type entry silently drops the user
  subfields and returns only `name` and `$type`. The fields-syntax sample shows the same: enum
  values carry `name`, User values carry `login`, `fullName` and `name` [6]. For a User, `name` is
  the full name, so the shared spec pulls full names into memory.
- **Name filter** [live]: matched case-insensitively (`assignee` and `ASSIGNEE` both return the
  entry, named `Assignee`). Aliases do not match. An unknown name is not an error.
- **Cost** [live]: no extra request. The scan stays one GET per 100 issues (`YOUTRACK_PAGE_SIZE`,
  src/youtrack.ts:79) and stops on a short page (:351). The list of possible assignees (the field's
  `UserBundle`) is readable through the same endpoint for one more request, via
  `projectCustomField(bundle(aggregatedUsers(...)))` with `$top=1`; "The set of users that can be
  set as values for this custom field. Can be null." [7] Workers CPU cost was not measured.

Live checks (GET `/api/issues`, `query=project: CUI`, `$top=100`):

| Probe                                                               | Result                                                                                                                                                                  |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customFields=Type&customFields=Assignee`, user subfields           | 200, 52 rows, exactly 2 entries each. Type: `SingleEnumIssueCustomField` 52/52. Assignee: `SingleUserIssueCustomField` 52/52, value object 46, `null` 6, never an array |
| Keys on the 46 user values                                          | `$type` (always `User`), `banned`, `email`, `fullName`, `guest`, `login`, `name`, `ringId`                                                                              |
| `customFields=assignee` (lowercase)                                 | 52/52 rows return an entry named `Assignee`                                                                                                                             |
| `customFields=NoSuchFieldZz`                                        | 200, 52 rows, `customFields: []` on every row, no error                                                                                                                 |
| `customFields=for` (an alias of Assignee)                           | 200, `[]` on every row                                                                                                                                                  |
| `projectCustomField(...,field(name,isAutoAttached,fieldType(...)))` | `UserProjectCustomField`, public, `canBeEmpty` true, auto-attached, `fieldType.id` `user[1]`, `isMultiValue` false, `valueType` `user`                                  |
| No filter, `$top=1`                                                 | 9 fields: `enum[1]` x2, `state[1]`, `user[1]` x1, `version[*]`, `period` x2, `integer` x2                                                                               |
| Today's scan fields vs the same plus Assignee                       | 40,597 vs 51,503 bytes (+27%, about 210 bytes per issue), 0.07 s vs 0.08 s, one request each                                                                            |
| Bundle read, `$top=1`                                               | `UserBundle`: 6 aggregated users, 1 individual, 1 group                                                                                                                 |

### Which field is "the" assignee

- **Not guaranteed** [verified] [8][9]. The default Assignee field is "Used to assign an issue to a
  user." [9] But its base properties can change: "This includes changes to the field name, the
  property for the field type that determines whether the field stores single or multiple
  values, and the field aliases." [8] An auto-attached or shared field may not be editable, and a
  project admin can move its data to a new field instead. "the combination of field name and
  field type must be unique" [8], so names alone are not unique. The default aliases are "for and
  assigned to" [8].
- **Detectable by type** [verified] [2]: "The field.fieldType.id value also includes the
  cardinality suffix, for example user[*] for a multi-value user field." Any user field shows up as
  `user[1]` or `user[*]`. With two user fields, type alone cannot pick one, and no `isAssignee`
  flag is documented [undocumented].
- In CUI, `Assignee` (`user[1]`) is the only user field [live].

### The User entity

| Field                       | Docs [5]                                                                                                             | Live (CUI)                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `login`, `fullName`         | Read-only                                                                                                            | Login `<letters><ID>` on all 4 assignees; no digits in names |
| `email`                     | "The email address of the user. Read-only. Can be null."                                                             | `<ID>@buas.nl` on all 4; `null` for 1 of 6 possible          |
| `ringId`                    | "ID of the user in Hub. You can use this ID for operations in Hub, and for matching users between YouTrack and Hub." | Non-null on all 46 values                                    |
| `guest`, `banned`           | Booleans                                                                                                             | `false` on all 46                                            |
| deleted                     | No such attribute (also not in src/generated/youtrack.ts:10271-10285)                                                | -                                                            |
| email verified              | No such attribute                                                                                                    | `emailVerified`, `verifiedEmail` silently dropped            |
| `userType`                  | "The type of the user. Available since YouTrack 2026.2."                                                             | Returned anyway on `/api/users/me` (`STANDARD_USER`)         |
| `banBadge`                  | "Returns null when no badge is set or the ban details are not available to the requester."                           | Returned (`null`)                                            |
| `banReason`, `isAnonymized` | Listed, no version note                                                                                              | Silently dropped                                             |

[corrected] Only `userType` carries a version note. This 2025.2 instance returns `userType` and
`banBadge`, which its generated type lacks, and drops `isAnonymized` and `banReason`. Response
headers carry `X-Version`, which is a hash, not a version number. A missing key proves nothing.

### Who can see logins and emails

Short answer to 07 Q18: no official text proves that some tokens get emails hidden. It is an
inference on 2025.2, documented only indirectly on 2026.x. Logins are what the matcher needs, and
on 2025.2 every default team role gets them (Read User Basic).

- **Documented, 2025.2** [verified] [10][22]: Read User Basic: "View the list of registered users
  and read the ID, username, name, and avatar for each user." Read User Full: "View all
  properties for all registered users, including authorization details." Neither YouTrack's nor
  Hub's 2025.2 permissions page names email (0 matches on both). Hub adds that Basic "Does not
  grant permission to view values for custom attributes." [22]
- **Default roles, 2025.2** [verified] [12][13]: Read User Full is ticked for System Admin and
  Contributor only; Read User Basic also for Project Admin and Observer, not Issue Creator or
  Issue Reader [13]. "the Developer role doesn't include the Read User Full permission" [12], so
  a Developer is the concrete case of Basic without Full.
- **Documented, 2026.x** [verified] [corrected] [11][14][16][98][99]: the permission is now Read
  User Details ("View additional profile details for all registered users." [11]). Only the
  Secure page ties it to email, for the Observer role that installs created with 2026.1 or later
  give to Registered Users: "These details include email addresses and authorization data"
  [14]. It shows admins how to withhold them: "Create a custom role that contains the Read User
  Basic and Update Self permissions." [14] User-read permissions now sit only in global roles
  (System Admin, Observer) [99], and "At the project level, permissions with global and
  organizational scopes are disregarded." [16] But "During the upgrade to 2026.1, YouTrack
  creates replacement single-permission roles when needed to preserve access" [98]. Whether that
  covers the user-read permissions is not stated. Its wording ("no longer propagate" [98])
  implies that on 2025.2 a project-level grant of a global permission does take effect.
- **Inferred, not stated** [partial]: a 2025.2 token with Basic but not Full sees logins but not
  emails. No official sentence says how the REST API shows a hidden email (`null` or left out).
  The User entity says only "Can be null" for `email`; it gives a permission reason for
  `banBadge` ("not available to the requester") but not for `email` [5]. No per-user setting that
  hides an email from others is documented; Hub's email entity holds only `email`, `verified` and
  `user` [34].
- **Without Read User Basic** [verified] [corrected] [10][19]: users "only see anonymized
  versions of other user accounts in the system." [10] Only the full name has a documented
  shape: "the full name is shown as Anonymized1234 where 1234 is replaced with a random number.
  The usernames are anonymized in a similar way." [19] So an `Anonymi...` login prefix and its
  digit count are inference, and an anonymized login could carry a 6-digit run.
- **Per token** [verified] [25][26]: "A permanent token allows access to a service with the
  permissions that are granted to the user account for the selected token scope." [26] So two
  groups on the same instance can see different user data. The token cannot show its own roles
  through the allowed GETs.
- **Seen live** [live] (re-checked 2026-10-02, 2 GETs): 151 user objects on 52 CUI issues
  (reporter, updater, comment authors, Assignee), 4 distinct users. Every login is a non-empty
  `<letters><ID>`, every email `<ID>@buas.nl` with the same ID, the `email` key is always there,
  and no login starts with `Anonymi`. In the Assignee bundle (6 users, group `ProjectTeam`) 5
  emails are visible; the one `null` belongs to a `<letters>`-login account in the same team.
- **The one `null` is most likely "not set"** [partial]: a permission applies "for all registered
  users" [10], so a mask that hides 1 of 6 in one team is unlikely, but nothing in the response
  tells "not set" from "masked". The docs' own users-list sample mixes a `null` (the guest) with
  real emails for one caller [37], and the profile docs allow an account without one: "This
  attribute is only displayed when you have entered an email address in your YouTrack
  profile." [20]
- **Unproven:** that any BUas token is denied emails, and what a `null` means.

Takeaway: the login is the YouTrack identifier. It is always present while Read User Basic holds
and carries the ID for every student seen, so the API does give real users. Email is an optional
fallback that adds 0 matches on CUI today; a `null` email means "unknown", never a mismatch.

### Who sets logins and emails

- **BUas's auth module is unknown.** The shapes suggest an institutional identity provider, but
  that can't be read with the allowed GETs.
- **Auth modules** [verified] [30][31][32][33]: Entra ID and OAuth 2.0 tie a first login to an
  existing account on a matching email or username. Entra: "When synchronization is enabled,
  changes applied to Microsoft Entra ID profiles are synchronized with YouTrack." [31] OAuth 2.0
  can map an email verification state: "Maps to the field that stores the value to copy to the
  verified email property in the YouTrack account." [32] Whether a sync overwrites a hand-edited
  username or email is [undocumented].
- **Self-editing** [verified]: Hub 2025.2, Update Self: "Edit all profile attributes for their own
  accounts." [22] YouTrack 2025.2: "Grants users permission to update all profile attributes for
  their own accounts." [24] Hub: "Users with Update Self permissions can edit this information
  themselves." [23] Only the YouTrack permissions reference describes it narrowly: "Edit own
  Account Security information in the user profile." [10] By default every role except Issue
  Reader has Update Self [13].
- **Every token owner has Update Self** [verified] [25]: creating a permanent token "Requires
  permissions: Update Self". So the person whose token runs the mirror can edit the ID in their
  own profile too.
- **At BUas, students can edit them** [live, screenshot] (the user's screenshot of their own
  YouTrack 2025.2 profile, 2026-10-02; no values copied). On the General tab, Full name, Username
  (`<letters><ID>`), Email (`<ID>@buas.nl`) and a multi-line VCS usernames box (holding the email
  and the username) are all editable fields. Next to Email the page says "Email notifications are
  currently disabled system-wide." and offers a "Send verification email" link. The docs describe
  that message: "If email notifications are disabled for your YouTrack server, a message is
  displayed on the page." [20] Hub: "basic information like full name, username, avatar, and
  email address. Users with Update Self permissions can edit this information themselves." [23]
  Whether the identity provider later overwrites an edit is still [undocumented].
- **Uniqueness** [verified] [20][27]: "Usernames must be unique in the system. If you attempt to
  assign yourself a username that is currently assigned to another user, you encounter an
  error." [20] That covers whole strings only: `jdoe123456` and `xy123456` can coexist. Emails can
  repeat: "In this case, there will be two separate accounts with the same email address" [27].
- **Verification** [verified] [15][21][30][34]: Hub stores a flag per email
  (`"email": string, "verified": boolean` [34]), and unverified emails exist: "If your email
  address is not verified, click the Verify button to register the email address in the Hub
  service." [21] An installation can require it: "Determines whether users must verify their email
  addresses to log in to YouTrack." [30], an option that "is located on the Auth Modules > Common
  Settings page" [15]. The YouTrack REST `User` has no such flag. At BUas the "Send verification
  email" link suggests the address is not verified, and with notifications off system-wide the
  mail most likely can't arrive [partial, inference from the screenshot]. So BUas emails are best
  treated as unverified.
- **Self-anonymizing** [verified] [20]: "Anonymize user Replaces the personal data in your user
  account with random or encrypted values", which removes any match.

Conclusion: at BUas the username and the email are self-asserted, not "probably" but in fact.
The ID in either is a convention that any student can change in their own profile, even to a
teammate's ID (usernames only need to differ as whole strings).

### No GitHub identity in YouTrack

[verified] [33][34][35][36]. Hub can hold a `githubdetails` record with a GitHub `login`, only for
users who log in through a GitHub auth module, and a `VCSUserNames` list [34]. VCS usernames are
meant for the commit author name ("GitHub and GitLab provide the value that is stored as the
Name." [35]), but "GitHub and GitLab users often enter their username instead" [35]. They are
typed in by hand on the profile ("Stores the usernames that are associated with your account in a
connected version control system." [20]) and unverified. Both live on the Hub user entity, which
the allowed paths can't reach. From 2026.1 the YouTrack REST API "supports user, group, and access
management operations directly" [36]. The `User` returned inside `/api/issues` has no such field
(src/generated/youtrack.ts:10271-10285; profile types at 9133-9139 and 10322-10328 hold only
format, timezone and locale), and live, `vcsUserNames`, `vcsUsernames` and `details` were dropped.
Whether BUas has a GitHub auth module is unknown.

### Edge cases

| Case                       | What YouTrack does                                                                                                                                        | Status / source           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Unassigned                 | Entry present, `value: null` (6 of 52)                                                                                                                    | [live]                    |
| Field missing              | No entry: field not in the project, wrong name, or private and unreadable. Whether a private field is left out or `null` is undocumented                  | [live] [undocumented] [8] |
| Banned assignee            | Stays: "The system continues to display issues, tickets, and articles assigned to the banned user."                                                       | [verified] [29]           |
| Deleted assignee           | "Deleted users are removed from the set of values for the Assignee field"; a field that can't be empty gets the chosen replacement user                   | [verified] [28]           |
| Merged accounts            | Assignee "replaced with the merged user account"                                                                                                          | [verified] [27]           |
| Guest                      | Docs sample: login `guest`, email `null`, banned `true`. None in CUI                                                                                      | [verified] [37]           |
| Anonymized                 | "the full name is shown as Anonymous and the username is replaced with a random value"                                                                    | [verified] [19]           |
| No ID                      | 2 of 6 possible assignees in CUI                                                                                                                          | [live]                    |
| Resolved                   | 34 of 46 assigned issues. Under R9 most of them never got a mirror, so only existing mirrors (17) matter                                                  | [live]                    |
| History                    | Not in `/api/issues`. Needs `GET /api/activities` (`categories` is mandatory, `CustomFieldCategory`) or `/api/issues/{id}/activities`; neither was called | [verified] [38]           |
| Assignee changed by admins | Deletes and merges change it without an edit. Whether `updated` moves then is undocumented. A desired-state sync each run doesn't care                    | [undocumented]            |

## GitHub: assignees in the REST API

### Reading current assignees

- **Already in the list** [verified] [live] [39]: list repository issues has the "Same response
  schema as List issues assigned to the authenticated user", which includes "`assignees`: array of
  `Simple User`". Live on cli/cli (2026-03-10): 30 of 30 items carry `assignees` (`[]` when
  unassigned) and none carries `assignee`. With `assignee=*`: 38 assignee objects, at most 2 per
  issue, types `User` and `Bot`, no `email` key. The existing paged read
  (src/github/issues.ts:121-124) already returns them; `parseGitHubIssue` (89-113) drops them
  today.
- **Singular `assignee` is gone** [verified] [live] [43]: "Use the `assignees` array parameter
  instead of the singular `assignee` parameter when creating or updating Issues." and "Read
  assignee information from the `assignees` array instead of the singular `assignee` property".
  Live: with 2026-03-10, 0 of 8 items had `assignee`; with 2022-11-28 on a fresh URL, 7 of 7. The
  code pins 2026-03-10 (src/github/client.ts:21). `@octokit/openapi-types` 29.0.1, the latest on
  npm, still declares `assignee` on the issue and as a body param, plus an object form for PATCH
  `assignees`. `CreateIssueBody` and `UpdateIssueBody` come from those types
  (src/github/issues.ts:32-40), so the type checker would accept the removed param.
- **No assigner on the issue** [verified] [39]: the issue has `assignees` and `closed_by`, but the
  word "assigner" appears 0 times on the issues reference page.

### Who can be assigned

- **The rule** [verified] [41][42]: "yourself, anyone who has commented on the issue or pull
  request, anyone with write permissions to the repository, and organization members with read
  permissions to the repository." [41] The roles table gives Read "Have an issue assigned to them"
  and applies to "organization members, outside collaborators, and teams" [42]. That implies
  outside collaborators with Read are assignable too, which the help page leaves out: the docs
  conflict.
- **The list** [verified] [live] [40]: `GET /repos/{o}/{r}/assignees` "Lists the available assignees
  for issues in a repository." `per_page` defaults to 30, "max 100", paging through `Link`. Simple
  Users, no name or email. Live on cli/cli: 200, 22 users, all `User`, one page.
- **No commenters in the list** [live] [corrected]: on octocat/Hello-World the list has 1 user,
  although 45 issues by other authors all have comments. A commenter got 204 from the per-issue
  check and 404 from the repo-level check. Commenter rights are per issue only. So the group's 34
  are write collaborators plus org members with read access, staff included.
- **The repo check is case-sensitive** [verified] [live] [40]: "If the assignee can be assigned to
  issues in the repository, a 204 header with no content is returned. Otherwise a 404 status code
  is returned." Live: the exact login gives 204, upper case and capitalised give 404 (cli/cli, and
  `octocat` 204 vs `Octocat` 404 on octocat/Hello-World). `GET /users/Octocat` gives 200 with login
  `octocat`, so user lookups ignore case while this check does not. The docs mark `owner` and
  `repo` as not case-sensitive and say nothing about `assignee`. A community comment blames a
  capitalisation mismatch for a 422 on create, though it also mentions a user added later [85].
- **The per-issue check** [live] [corrected] [40]: "Checks if a user has permission to be assigned
  to a specific issue." Unauthenticated, it gave 204 for an issue's current assignee (cli/cli) and
  for a commenter (octocat/Hello-World), and 404 for a login the repo-level check accepted.
  Authenticated behaviour is untested, and it costs one GET per mirror. Don't build on it.
- **Limit** [verified] [41]: "Both issues and pull requests support up to 10 assignees." What
  happens above 10 is [undocumented]; the single-user `Assignee` never gets there.
- **Copilot** [verified] [41]: "You may also be able to assign Copilot to an issue". Whether
  Copilot shows up in `/assignees` is [undocumented].

### Writing assignees

| Call                                      | What it does                                                                                                                                  | Without push access                                                             | Response           |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------ |
| `POST /repos/{o}/{r}/issues`, `assignees` | Sets them on create                                                                                                                           | "Assignees are silently dropped otherwise."                                     | 201 with the issue |
| `PATCH /issues/{n}`, `assignees`          | "Pass one or more user logins to replace the set of assignees on this issue. Send an empty array ([]) to clear all assignees from the issue." | "Without push access to the repository, assignee changes are silently dropped." | 200 with the issue |
| `POST /issues/{n}/assignees`              | "Adds up to 10 assignees to an issue. Users already assigned to an issue are not replaced."                                                   | "Assignees are silently ignored otherwise."                                     | 201 with the issue |
| `DELETE /issues/{n}/assignees`            | "Removes one or more assignees from an issue."                                                                                                | "Assignees are silently ignored otherwise."                                     | 200 with the issue |

Sources [39][40], all [verified]. Only 201 and 200 are listed for the add and remove calls. Either
way, an assignment is confirmed only by reading `assignees` in the response, as the code already
does for labels, milestone and type (src/sync/execute-issues.ts:79-91,
src/sync/execute-hierarchy.ts:114-123).

### When a login can't be assigned

[undocumented] officially. The "silently dropped" wording covers only a **caller** without push
access. For a caller with push access and a login that can't be assigned (outside the repo,
suspended, renamed, a bot), the docs list only a generic 422: "Validation failed, or the endpoint
has been spammed." [39] Community reports [partial]:

- **Create:** 422 Validation Failed, `field: assignees`, `code: invalid`, message "assignees
  <login> cannot be assigned to this issue" [82][84]. The issue is not created: "failing to create
  the issue if non-assignable people are assigned" [86].
- **PATCH:** 422 for the whole request. In one report an already-assigned Copilot bot was sent back
  with an unrelated change [83]; another says GitHub "rejects the _entire_ request with HTTP 422 on
  one unknown value" [87].
- **Add assignees:** accepted, the login ignored: "GitHub accepts the request and ignores that
  name." [89] A workflow that uses `GITHUB_TOKEN`: "GitHub drops non-assignable users without
  erroring, so surface them." [88]
- **Bots:** `GITHUB_TOKEN` could not assign Copilot or `github-actions[bot]` (422); a PAT fixed it
  [82].

In this code a 422 is thrown as `HttpError` by `http.request`, which resolves only for 2xx
(src/http.ts:54-62; the create call is src/github/issues.ts:140). A create with a bad login makes
no mirror and fails again every run, and its tasks wait, capped (D4). A PATCH with a bad login
also loses its title, milestone and type change. The error message carries up to 500 characters
of the body (src/http.ts:92, 179, 394), which names the login. Whether a login's case matters in
write bodies is [undocumented] and untested.

### Token permissions

| Endpoint                                                   | Fine-grained PAT / GitHub App            | Action `GITHUB_TOKEN` (`issues: write`)                               | Classic PAT `repo`      |
| ---------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------- | ----------------------- |
| `GET /repos/{o}/{r}/assignees`, `/assignees/{a}`           | Issues read or Pull requests read        | Yes ("`write` includes `read`" [47])                                  | Yes                     |
| `POST`/`DELETE /issues/{n}/assignees`, `PATCH /issues/{n}` | Issues write or Pull requests write      | Yes                                                                   | Yes                     |
| `POST /repos/{o}/{r}/issues`                               | Issues write                             | Yes                                                                   | Yes                     |
| `GET /repos/{o}/{r}/commits`                               | Contents read (private repos only [61])  | No on a private repo: the README workflow grants only `issues: write` | Yes                     |
| `GET /users/{login}`, `/search/*`                          | No permissions                           | Yes                                                                   | Yes                     |
| GraphQL verified-domain emails, SAML identities            | Org owner, or an App with members access | No (no org or members key)                                            | Only an org owner's PAT |

Sources [40][44][45][47][48][61][73], [verified].

- **`GITHUB_TOKEN` can assign** [verified] [corrected]: the Add assignees endpoint "works with the
  following fine-grained token types : GitHub App user access tokens GitHub App installation
  access tokens Fine-grained personal access tokens" and needs Issues write [40]. "The
  `GITHUB_TOKEN` secret is a GitHub App installation access token." [46] Community actions assign
  with exactly `permissions: issues: write` [91]. Whether that counts as "push access" for the
  drop rule is [undocumented]: the same open point as labels and types (docs/03-github-rest-api.md,
  README.md:198-200), which the existing drop checks catch.
- **Unlisted permissions become `none`** [verified] [47]: "If you specify the access for any of
  these permissions, all of those that are not specified are set to `none`." The README workflow
  sets `permissions: {}` and `issues: write` (README.md:148-161).
- **Classic PAT** [verified] [42][48]: `repo` "Grants full access to public and private
  repositories". The owner's role must also allow assigning. The REST pages say push access; the
  roles table gives Triage "Close, reopen, and assign all issues and pull requests" [42]. The docs
  conflict, so Write or higher is the safe requirement.

### Who made an assignment

[verified] [live] [49][50]. `assigned` and `unassigned` issue events carry `actor`, `assignee`,
`assigner` and `performed_via_github_app` [50]. "`assigner` ... The person who performed the
assignment for this issue. This field is available in the REST API for issue events but not the
REST API for timeline events." [49] Per-issue and repo-wide event lists page at 100 and need
Issues read. Live on one cli/cli issue: 23 events; in the one `assigned` event, actor and assigner
were the same account and `performed_via_github_app` was `null`.

That costs one GET per mirror, which doesn't fit the 45-fetch guard. On PAT hosts the actor is the
PAT owner, the same as for their own manual assignments. Whether a `GITHUB_TOKEN` assignment shows
`github-actions[bot]` and a non-null app is [undocumented] and was not observed. So a rule like R10
("undo only what the mirror did") can't be built without stored state.

### Notifications and rate limits

- **Notifications** [verified] [51][52][53]: the `assign` reason is "You were assigned to the
  issue." [51] People are subscribed automatically when they have "Been assigned to an issue or
  pull request." [52], so later closes and R10 reopens of that mirror notify them too.
  "Assignments to issues or pull requests" is its own notification category [53]. Nothing treats
  bot-made assignments differently [undocumented]. A community report shows API-made assignments
  are emailed, and a create followed by a separate add-assignees call sent two emails [90]
  [partial]. The default for "Your own updates" is not stated [53].
- **Workflows** [verified] [46][80]: `assigned` and `unassigned` are activity types of the `issues`
  event [80]. "events triggered by the `GITHUB_TOKEN` will not create a new workflow run" [46], but
  assignments made with a PAT (Worker, systemd) do start workflows.
- **Rate limits** [verified] [39][54][55]: create carries "This endpoint triggers notifications.
  Creating content too quickly using this endpoint may result in secondary rate limiting." [39];
  the assignee sections carry no such note. "no more than 80 content-generating requests per minute
  and no more than 500 content-generating requests per hour" [54]; "The rate limit for
  `GITHUB_TOKEN` is 1,000 requests per hour per repository." [54]; wait "at least one second between
  each request" for writes [55]. Whether an assignment is content-generating is [undocumented]. At
  30 writes per 10 minutes this is far away, and the existing rate-limit stop (R7,
  src/http.ts:85-89) covers assignment writes too.

## From a student ID to a GitHub account

| Method                                         | Needs                                              | Fetches per run                        | Action token                     | PAT (Worker, Node)  | Coverage seen live                    | Can it be gamed?                                                               |
| ---------------------------------------------- | -------------------------------------------------- | -------------------------------------- | -------------------------------- | ------------------- | ------------------------------------- | ------------------------------------------------------------------------------ |
| 1. ID in the GitHub login (`/assignees` list)  | Issues read                                        | 1 per 100 assignable users (1 for CUI) | Yes                              | Yes                 | 4 of 4 assignees                      | An insider can rename to carry a teammate's ID; outsiders can't enter the list |
| 2. Commit author email `<ID>@buas.nl`          | Contents read                                      | 1 per assignee, or 1 per 100 commits   | No, needs `contents: read` added | Yes                 | At most 3 of 4 (3 accounts committed) | Yes: an unclaimed email can be added unverified and still links commits        |
| 3. Public profile email (`GET /users/{login}`) | Nothing                                            | 1 per candidate (34 for CUI)           | Yes, but breaks the fetch budget | Yes, same           | 1 of 34 has `<ID>@buas.nl`            | The user picks which email is public                                           |
| 4. User search `in:email`                      | Nothing (docs contradict on auth)                  | 1 per assignee, 10-30 per minute       | Unclear                          | Unclear             | Public emails only                    | As 3; also sends students' emails to a global search                           |
| 5. Verified-domain emails (GraphQL)            | Enterprise Cloud, verified domain, org owner token | 1                                      | No                               | Only an owner's PAT | Not available (org not verified)      | Hard: GitHub verifies them                                                     |
| 6. SAML / SCIM external identity               | Enterprise Cloud with SAML, owner token or App     | 1 or more                              | No                               | Only an owner's PAT | Unknown                               | Hard                                                                           |
| 7. GitHub Classroom roster                     | -                                                  | -                                      | -                                | -                   | API closed since 2026-08-28           | -                                                                              |
| 8. Explicit map in config                      | Someone to keep it up to date                      | 0                                      | Yes                              | Yes                 | Whoever is listed                     | Only by editing the config                                                     |

Not compared: matching full names. The assignable list carries no names (live), so it would cost
one `GET /users/{login}` per candidate, like method 3. It is also fuzzy, and none of the 34
profile names in the snapshot carries an ID.

### 1. ID in the GitHub login

[verified] [live] [40][41]. The candidates are the logins from `GET /repos/{o}/{r}/assignees`, type
`User`, used exactly as returned. Extract the ID with `/(?<!\d)\d{6}(?!\d)/`: one run for
`jdoe123456`, `JaneDoe123456`, `jdoe-123456` and `jdoe123456_buas`; none for 5- or 7-digit runs;
two for `ab123456cd654321`, which counts as ambiguous (tested on placeholders).

- **Username rules** [verified] [69]: "Usernames for user accounts on GitHub can only contain
  alphanumeric characters and dashes (`-`)." and "Usernames, including underscore and short code,
  must not exceed 39 characters." Both are on the external-authentication page only. Whether
  uniqueness ignores case is [undocumented]; live, lookups ignore it.
- **Renames** [verified] [56][68]: "After changing your username, your old username becomes
  available for anyone else to claim." [68] The durable lookup takes "their durable user ID
  instead of their login, which can change over time." [56] The match is rebuilt from the live
  list every run, so a rename that keeps the ID changes nothing, and one that drops it silently
  stops matching.
- **Gaming:** an outsider can't get into the candidate set; commenting makes someone assignable on
  that issue only, not listed. An insider (write access, or org member with read access) could
  rename to include a teammate's ID. Requiring exactly one candidate per ID limits that.

### 2. Commit author email

[verified] [61][62][63][64][65][66]. `GET /repos/{o}/{r}/commits?author=` takes a "GitHub username
or email address to use to filter by commit author.", starting at the default branch [61]. The
top-level `author` is the linked account: "GitHub links a commit to a user by matching the email
address in the commit header to an email address on a GitHub account." [62] (A later pass did
not find this quote again on the page; the linking itself is [live], see step c below.) Live, the
`author` filter ignores case (octocat/Hello-World).

- **Permission:** "Contents" read [61], for private repos: "This endpoint can be used without
  authentication or the aforementioned permissions if only public resources are requested." [61]
  On a private group repo the Action would need `contents: read` added: "`contents: read` permits
  an action to list the commits" [47].
- **Coverage:** only people who committed to the default branch with their BUas email on their
  account. "If you enabled email address privacy, then the commit author email address cannot be
  changed and will be a no-reply by default." [66] Live: 3 accounts for 4 assignees.
- **Gaming** [verified]: "An email address can only be associated with one GitHub account at a
  time." [63] But unverified emails keep commits linked: "re-add it without verifying to keep any
  commits linked to your account" [64], and "Having an unverified email address does not affect
  most actions you can take on GitHub." [65] A verified owner blocks others ("Email is already
  verified by another user" [64]). So a teammate could claim a student's `<ID>@buas.nl` if that
  student never added it, as a research paper also describes [92]. Useful as a cross-check or a
  fallback (step c of the proposed chain), not as proof.
- **Variant:** `GET /search/commits?q=author-email:<email>` needs no permissions and searches
  default branches only [60], with search rate limits and a wider privacy footprint.

### 3. Public profile email

[verified] [56][57]. "The email key in the following response is the publicly visible email address
from your GitHub profile page." and "If you do not set a public email address for email, then it
will have a value of null. You only see publicly visible email addresses when authenticated with
GitHub." [56] One GET per candidate (34 for CUI) plus the existing reads and up to 30 writes breaks
the 45-fetch guard (src/http.ts:72). Coverage: 1 of 34. Users choose which email, if any, is
public; whether it must be verified is [undocumented].

### 4. User search by email

[partial] [58][59]. The Search users section says it "does not accept authentication and will only
include publicly visible users", while its own token section says "The fine-grained token does
not require any permissions." [58] So whether the 30 per minute (authenticated) or 10 per minute
(unauthenticated) limit applies is unclear. `in:email` matches the public email only [59], "For
privacy reasons, you cannot search by email domain name." [59], and results span all of GitHub.
Not viable as the main method; the proposed chain uses it only as its last fallback (step d),
bounded by the assignable list.

### 5. Verified-domain emails

[verified] [57][70][71][72]. `organizationVerifiedDomainEmails`: "Verified email addresses that
match verified domains for a specified organization the user is a member of." [57] It needs an
Enterprise Cloud org that agreed to the Corporate Terms [72][70], an org owner as caller, and a
verified domain: "To verify a domain, you must have access to modify domain records with your
domain hosting service." [71] Live: the org is not verified and the query asked for `read:org`.
`GITHUB_TOKEN` has no org or members permission key [47], so it can't use this (inference).

### 6. SAML / SCIM identities

[verified] [73][74][75][76][69]. The SAML identity provider is "Visible to (1) organization owners,
(2) organization owners' personal access tokens (classic) with read:org or admin:org scope, (3)
GitHub App with an installation token with read or write access to members." [73] External
identities follow the same rule [74]. "To use SAML single sign-on, your organization must use
GitHub Enterprise Cloud." [75] Whether the org uses it can't be known without an owner. The member's
classic PAT works on the private repo, and under SAML "You must authorize your personal access token
(classic) after creation" [76], so either SAML is off or the token was authorized. Enterprise
Managed Users are unlikely: their logins end in an underscore and short code [69], and none of the
34 logins has an underscore (inference from shapes).

### 7. GitHub Classroom

[verified] [77][78]. Every Classroom REST operation now shows "Closed notice: This operation is no
longer available as of August 28, 2026." and lists only 410 Gone [77]. "On August 28, 2026, GitHub
Classroom will fully transition to partner solutions." [78] No GitHub Education or student
verification API is documented.

### 8. Explicit map

[verified] [35][93][94]. Other tools match on email first, then a hand-kept mapping. YouTrack's own
VCS integration: "First, YouTrack searches for a user account whose email address matches the
email address of the commit author." [35] Unito links users "as long as they have the same email
address in each tool." [93] Another YouTrack-GitHub integration says "A small config file maps
GitHub users to YouTrack users" [94].

- **Pros:** 0 fetches, deterministic, covers staff and logins without an ID, and only people who
  can edit the config can game it.
- **Cons:** needs upkeep; breaks on a rename, after which a stranger can claim the old login, so
  every target must still be checked against the list; entries need the exact login case; the
  map itself is personal data. Where Action inputs show up in logs was not checked.

### The ID itself

[partial] [95]. The official BUas intro FAQ documents the email form: "jouw studentenmail
(studentnummer@buas.nl)". That student numbers have 6 digits is [undocumented]; it fits all live
data. Whether one can start with `0` is [undocumented], so keep IDs as strings
(`Number("012345")` is `12345`). The staff ID or email format is [undocumented].

## Proposed matching chain

**Accepted 2026-10-02 (U2, U17), with the research's lean on every choice listed at the end of
this section. Nothing is implemented yet.** It matches
automatically as far as it can (steps b-d), with a manual map for whoever is left (step a). The
map is checked first, so an entry can also correct or block an automatic match; anyone without
an entry goes through the automatic steps.

### YouTrack side

No extra YouTrack request. The chain runs once per distinct assignee Y of an eligible issue:
unresolved, not excluded, with an open mirror or a mirror created this run (U7, R9, F1-F3).

- **Login:** real only while the token has Read User Basic [10]. Never take an ID from a login
  that starts with `Anonymi` (an inferred shape, see "Who can see logins and emails").
- **Email:** may be `null`, which means "unknown".
- **IDs(Y):** the single 6-digit run in the login (`/(?<!\d)\d{6}(?!\d)/`; none for 0 or 2+ runs),
  plus the single run in the email's local part when the domain is exactly `buas.nl`. Kept as
  strings. Never from a noreply or other non-`buas.nl` address.
- **Emails(Y):** the YouTrack email, lowercased, if it has exactly one `@` (`author=` also takes
  a username [61], so a malformed value could match someone else's commits), plus
  `<id>@buas.nl` for every ID, deduplicated. On CUI that is one address per user (login and email
  agree on 46 of 46 issues). The built address works even when emails are hidden.
- **Login ID and email ID disagree:** both are used, and the exactly-one rule below decides.

### GitHub side

The steps run in order and stop at the first that gives exactly one login. Every result must be
a type `User` login in this run's assignable list, compared ignoring case and written exactly as
the list spells it. Within a step, results for all of Y's IDs or emails are pooled: 1 login is a
match, 2 or more is ambiguous, 0 is none. Once a step is ambiguous with candidates C, a later
step's single login counts only if it is in C; otherwise Y stays ambiguous (0 fetches; two
logins with one ID is what an impersonating rename looks like). At the end Y is ambiguous if any
step saw 2 or more, else unmatched. Under U6 both leave GitHub alone.

| Step                         | Request                                                                                                                                 | Cost per run                                         | Fails or misses when                                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Assignable list           | `GET /repos/{o}/{r}/assignees?per_page=100`, after the YouTrack scan, only when the feature is on and an eligible issue has an assignee | 1 per 100 users (1 for CUI)                          | The read fails: assignee sync is skipped this run, with a warning (U16)                                                                  |
| a. Manual map                | None; keyed by YouTrack login                                                                                                           | 0                                                    | Target not assignable: unmatched with a warning, chain stops. Value `-`: never auto-assign Y. A YouTrack rename silently drops the entry |
| b. ID in an assignable login | None (method 1)                                                                                                                         | 0                                                    | The GitHub login has no ID (30 of 34 live); two logins with one ID: ambiguous                                                            |
| c. Commit author             | `GET /repos/{o}/{r}/commits?author=<email>&per_page=1` per email; match is `[0].author.login` when `author` is a `User`                 | 1 per email, every run while a and b miss (no cache) | No default-branch commit with that email, or the email is linked to no account; private repo without `contents: read`; empty repo        |
| d. Public-email search       | `GET /search/users?q="<email>"+in:email+type:user` per email                                                                            | 1 per email, under the search limit                  | The email isn't public on the profile (30 of 34 `null` live); a word match that isn't the exact address                                  |

Rejected: `GET /users/{login}` per candidate (30 of 34 have no ID, over budget), the per-issue
check, issue events, GraphQL, `search/commits`, name matching, and scanning the newest 100
commits.

**Step c, live** [live] (unauthenticated, 2026-10-02, torvalds/linux and octocat/Hello-World;
emails not recorded): `author=<email>` matches `commit.author.email`, not the committer email,
also when the email is linked to no account (top-level `author` is then `null` on every item).
It ignores case. For a linked email `per_page=1` returns the linked login, type `User`. An email
with no commits gives 200 and `[]`. Docs [verified] [61]: "SHA or branch to start listing commits
from. Default: the repository's default branch (usually main)."; "Contents" read for private
repos, and "This endpoint can be used without authentication or the aforementioned permissions if
only public resources are requested." 409 is listed only as "Conflict" (probably an empty repo,
[undocumented]). What `GITHUB_TOKEN` without `contents: read` gets on a private repo is
[undocumented]: the troubleshooting page names "Resource not accessible by integration" without a
status, and "GitHub uses a 404 Not Found response instead of a 403 Forbidden response to avoid
confirming the existence of private repositories." [100]

**Step d** [verified] [58][59] [live]: "With the in qualifier you can restrict your search to the
username (login), full name, public email, or any combination of these." Matching is by word:
"data in:email type:org matches organizations with the word "data" in their email." And "By
default, searching users will return both personal and organizations." [59] That quoting the
address makes `in:email` match it exactly is [undocumented]. Items carry no email, so a hit is
not proof of the exact address; the assignable list and the exactly-one rule are the
safeguards. Live, a commit email that isn't public on its user's profile gave `total_count` 1: an
Organization whose public email is exactly that address, not the user. A User found by public
email was not tested. Unauthenticated, the response carried `X-RateLimit-Limit: 10` and
`X-RateLimit-Resource: search`; authenticated is 30 per minute [58], and the docs contradict each
other on whether the endpoint accepts authentication (method 4). The email goes to GitHub's global
search.

### Manual map (proposal for 07 Q25)

- **Setting:** `ASSIGNEE_MAP`; action input `assignee-map`, `.env` for Node, wrangler.jsonc for
  the Worker. Never in the committed workflow file. Empty means no map, an exception to the
  empty-input rule like `reopen-closed-by` (README.md:228-230). An unset repo variable evaluates
  to an empty string [102].
- **Syntax:** comma- or newline-separated `<youtrack-login>=<github-login>`, trimmed, for example
  `jdoe123456=JaneDoe123456, staffuser=-`. Keys compare ignoring case; a duplicate key is a config
  error. Values match `GITHUB_LOGIN_PATTERN` (src/config.ts:139) without `[bot]`, or are `-`
  ("never auto-assign"). Config errors never echo values.
- **Key:** the YouTrack login. It is present while Read User Basic holds, unique ("Usernames must
  be unique in the system." [20]), and staff have one. Downside: students can rename it (U11),
  and the entry then silently stops applying; the automatic steps take over.
- **Where it lives on the Action:** "By default, variables render unmasked in your build
  outputs. If you need greater security for sensitive information, such as passwords, use secrets
  instead." [101] Whether composite-action inputs are echoed into the step log is [undocumented].
  If they are, a `${{ vars.X }}` map shows in every run log for every repo reader, against U8.
  The options are a secret (masked, write-only in the UI) or a repo variable (editable, visible).
  The throwaway test can settle it.

### Budget

- **When:** lookups (c, d) are reads, sent after the YouTrack scan and the assignable list, before
  planning. A dry run sends them too.
- **Bound:** lookups ≤ max(0, min(5, `remainingFetches()` − `MAX_WRITES_PER_RUN` − 2)), counted as
  growth of `fetchCount`, so retries count. Both exist on the client (src/http.ts:67-69, 175-176).
- **Deadline:** each lookup can take up to 2 × 15 s plus a retry wait of up to 10 s
  (src/http.ts:73-75), and R8 is checked today only before each write (src/sync/execute.ts:51-53).
  So lookups stop once the run deadline minus one worst-case request is reached.
- **Order:** oldest eligible issue first starves anyone past the first 5 while those stay
  unmatched. The alternative is to rotate the start each run (`floor(now / 10 min) mod n`). Both
  are safe under U6 and mirror-owned (U4): a user not looked up this run is unmatched,
  and nothing is removed. Each email is looked up at most once per run. Users skipped for budget
  appear in the warning.
- **Numbers** (1 page per read): today 3 reads + 30 writes = 33 of 45. New: 4 reads + at most 5
  lookups + 30 writes = 39 of 45, which is 38 GitHub requests on the Action, about 228 an hour,
  under `GITHUB_TOKEN`'s 1,000 per hour per repository [54]. At 34 writes: 43. At 38 writes: 1
  lookup, so 43. At 39-40: 0 lookups, with a warning. CUI today pays 0 lookups (4 of 4 match at
  step b).
- **Promises:** "at most 30 writes per run" (README.md:58) and `MAX_WRITES_LIMIT` 40 stay, since
  4 reads and 40 writes are 44. These would change in v1.0.0 (U1): README.md:815-816, the fetch
  counts at README.md:183 and 514, the 13 test pins (12 `fetches: 3` in 7 files plus 1
  `fetches=3`) and test/sync/guard.test.ts:45. If step c is kept, the README workflow also gains
  `contents: read` (README.md:160-161).

### Failure handling

Lookups are never fatal, never count as failed under A10 and never stop writes.

- **Step c, 403 or 404** (status [undocumented]; the earlier reads of the same repo worked, so it
  means permission): step c is off for the run, and the warning names the fix (`contents: read`).
  **409:** step c is off for the run.
- **Rate limit** (403 or 429 with `x-ratelimit-remaining: 0` or `retry-after`): on step d, step d
  is off for the run; on step c (the core limit), all lookups stop.
- **422, 5xx or a network error** after the single retry: that email is skipped.
- **`FetchBudgetExceededError` or the deadline:** lookups stop.
- **Logs:** never log a lookup's `HttpError` or `NetworkError` message. The URL holds the email
  (src/http.ts:92, 108) and the body may name logins. Log the step and the status only, with a
  test that no log line, failure line or `SyncFailedError.message` contains a fixture email or
  login (U8).
- **One aggregated warning per run** (U3), ids and counts only, for example
  `assignees: 2 unmatched (CUI-12, CUI-15), 1 ambiguous (CUI-20), 1 not looked up (budget); commit lookups off: token lacks Contents read`.
- **A loud warning when every scanned assignee is unmatched.** It catches anonymized logins after
  a lost Read User Basic, next to U6's loud warning when no row has the field.

### Gaming and ownership

- **Gaming:** YouTrack email, username and VCS usernames are self-editable and emails unverified
  (U11). A student can point steps c and d at any GitHub account whose commit or public email they
  copy, for example a teammate's, so their issues get assigned to that teammate. The assignable
  list keeps outsiders out. The effect is a visible misassignment, the same as a login rename.
- **Mirror-owned (U4), in plain words:** on each mirror, the mirror only adds or removes GitHub
  assignees it can trace to a YouTrack user through this run's matching. A teacher, a bot, or
  anyone assigned by hand who doesn't match a YouTrack user is never touched. A student assigned by
  hand who matches a YouTrack user other than the issue's assignee can be removed when the issue is
  reassigned in YouTrack. A login counts as owned only if it matched this run, so a skipped lookup
  never removes anyone.

### Edge cases

| Case                                                         | Proposed handling                                                                                                    |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `jdoe123456` in YouTrack, `JaneDoe123456` on GitHub          | Match at step b (same ID; the logins differ, as all 4 did live)                                                      |
| Entry present, `value: null`                                 | No YouTrack assignee; GitHub is left alone (U6)                                                                      |
| No `Assignee` entry on any row                               | Never "unassigned": nothing changes, and a loud warning (U6). The field name is fixed as `Assignee` (U15)            |
| Login without an ID (staff or anyone)                        | The map, then steps c and d with the real email; otherwise unmatched, in the warning. No special staff handling (U3) |
| Two 6-digit runs (`ab123456cd654321`)                        | No ID from the login; the email ID, if any, still counts                                                             |
| 5- or 7-digit run (`jdoe1234567`)                            | No ID                                                                                                                |
| Login ID and email ID differ                                 | Both used; a match only if exactly one assignable login results                                                      |
| Email `null` or hidden                                       | The login ID and the built `<ID>@buas.nl`; `null` means unknown, never a mismatch                                    |
| YouTrack login without an ID, email `<ID>@buas.nl`           | The email ID at step b, then steps c and d                                                                           |
| Two GitHub logins with one ID                                | Ambiguous at step b; a later step may only pick one of the two; otherwise in the warning                             |
| Two YouTrack users with one ID                               | Each goes through the chain on its own and may get the same login. No special handling (U3)                          |
| Match not in this run's assignable list                      | Unmatched; never sent (a 422 risk)                                                                                   |
| Map target not assignable                                    | Unmatched with a warning; the automatic steps are skipped                                                            |
| Map value `-`                                                | Never auto-assigned                                                                                                  |
| Matched student leaves the org or loses repo access          | Drops out of the list, so under mirror-owned (U4) their GitHub assignment is no longer recognized as owned and stays |
| Anonymized YouTrack user                                     | No ID from an `Anonymi...` login; unmatched. Loud warning when every assignee is unmatched                           |
| Budget or deadline hit before Y's lookup                     | Not looked up this run: unmatched, nothing removed, named in the warning                                             |
| Bot assignee already on the issue                            | Never treated as owned, never sent back                                                                              |
| Closed mirror, or an epic's assignee                         | Not synced (U7, U13)                                                                                                 |
| Multi-user field                                             | Every matched user is assigned, up to GitHub's 10 (U15)                                                              |
| ID with a leading zero                                       | Strings throughout                                                                                                   |
| Noreply email `12345678+jdoe123456@users.noreply.github.com` | Ignored: the account ID can be 6 digits on old accounts (octocat's is) [67]                                          |

Safety comes from the "exactly one" rules and the assignable list, not from the ID being
verified. Neither side's ID is verified.

Choices inside the chain, each settled by U17 with the lean given here:

- **The chain as a whole** (U2), including whether the map is checked first (it can then
  override or block an automatic match) or only for whoever the automatic steps leave.
- **Ownership** (U4): confirm mirror-owned after the plain-words explanation above.
- **Emails** (07 Q18): read them at all (login only loses 0 matches on CUI today), and whether
  the raw YouTrack email goes to steps c and d or only built `<ID>@buas.nl` addresses.
- **Login ID and email ID disagree:** use both with the exactly-one rule (lean), prefer the
  login ID, or skip.
- **After an ambiguous step:** accept a later single login only if it is one of the ambiguous
  candidates (lean), accept any, or stop.
- **The map** (07 Q25): the key (YouTrack login), where it lives on the Action (secret or repo
  variable, after the throwaway test), a non-assignable target (unmatched with a warning), and
  the `-` value.
- **Steps c and d:** whether each is in; for d, `type:user` alone (lean) or an extra
  `GET /users/{hit}` email check; for c without `contents: read`, skip with a warning (lean), a
  setting, or fail.
- **Budget:** the lookup bound and the order (rotation, lean), or lowering `MAX_WRITES_LIMIT`.
- **Failed lookups:** never a failed run under A10 (lean), or failed.
- **Anonymized-looking assignees:** unmatched by the login-prefix check plus the loud warning
  (lean), also request `fullName`, or skip all assignee writes that run.
- **Field name and multi-user fields** (07 Q26) and **a failed assignable-list read** (07 Q27).

## How it would fit the code

### Reads

- **YouTrack** (src/youtrack.ts): send `customFields` twice. `issuesPageUrl` builds a
  `Readonly<Record<IssuesQueryParam,string>>` for `URLSearchParams` (295-303), and a Record can't
  repeat a key, so it needs pairs or `append`. `issueFieldsParam` (98-104) builds
  `customFields(name,value(name))` and needs `login` (and `email`, if wanted), checked against the
  generated `User` (src/generated/youtrack.ts:10271-10275). Add `readAssignee` next to `readType`
  (226-236) by generalizing `typeEntries` (212-220), which compares names exactly (218): compare
  against the canonical name or ignore case. At most one entry; `null` means no assignee; a
  `login` string; `email` string or `null`; an array value fails loudly unless multi-user is
  supported on purpose. `YouTrackIssue` (62-69) gains a small assignee field; cut it to the ID
  (plus the login, if a map keys on it) at the parse boundary. `fieldError` (165-168) already names
  paths and kinds, never values. The pinned URL in test/youtrack/fixtures.ts:25-31 changes.
- **GitHub issues** (src/github/issues.ts): `GitHubIssue` (53-70) and `parseGitHubIssue` (89-113)
  gain `assigneeLogins` plus each assignee's `type`, parsed like `parseLabelNames` (245-256). Add it
  to the `MirrorRef` pick (src/plan/mirrors.ts:17-23) and `toMirrorRef` (90-103). Parse a missing
  key as `[]`. No new read.
- **Assignable users:** a new src/github/assignees.ts on `listAllPages` (src/github/pages.ts:19-39).
  Read order today is GitHub issues, milestones, then YouTrack (src/sync.ts:270-280), and any read
  error is fatal (281-285). It could go after milestones (always paid), or after the scan, only
  when the feature is on and some eligible issue has an assignee. It could be fatal like the other
  reads, or degrade to "skip assignee sync this run". A dry run still sends it (295-298).
  Rejected: per-login checks (they put the login in a URL that `HttpError` prints), per-mirror
  events, GraphQL.

### Planning

- A pure matcher in a new src/plan/assignees.ts ("New decision logic goes in `plan.ts` or `plan/`",
  CLAUDE.md), with the ID extractor possibly in src/utils/. Inputs: each eligible issue's
  assignee, the assignable logins, map entries. Output per YouTrack user: matched login, unmatched
  or ambiguous, and warnings with ids and numbers only, like `Plan.warnings` (src/plan.ts:103).
- Joining the desired state: `PlanInput` (src/plan.ts:66-78) and `planContext` (188-204) carry the
  match into `PlanContext` (src/plan/desired.ts:21-36); `DesiredFields` (50-57) gains assignees;
  `updateFields` (104-111) gets an assignee half modelled on `milestoneChange` (126-135); the
  `create` action (src/plan.ts:38-47, built at 215) may gain a field.
- **Existing rules:** D2 clears a milestone only if it is a mirror milestone
  (src/plan/desired.ts:134); the analog is "change only owned assignees". D3 never clears a type
  (107); the analog is "no YouTrack assignee leaves GitHub alone". D8 syncs open and closed
  mirrors (src/plan.ts:242); skipping closed ones means checking `mirror.state`. R9 means no
  create for resolved issues (191, 212). R10's reopen runs in the closes phase after sync (293),
  so a mirror reopened this run gets its assignee one run later. F1-F3: excluded issues never
  reach `actionsFor` (151).
- **Cap and order:** an assignee diff riding `update` lands in `PHASE.sync` (3), before closes (4)
  (src/plan.ts:293). A diff that never converges (silent drop) costs one write per mirror per run
  and can delay closes. Epics have no GitHub assignee (milestones take only title, state,
  description and `due_on` [81]); they route to `epicActions` (src/plan.ts:209) and need nothing.

### Writes

Three shapes (see choice 6; U5 picked the second, separate add and remove calls):

- **Ride the existing writes:** `createBody` (src/sync/execute-issues.ts:64-76), `IssueUpdate`
  (src/github/issues.ts:43-47) and `updateBody` (200-214) take `assignees`; the empty-patch guard
  (203-205), the
  `UpdateFields` union (src/plan/desired.ts:44-47) and `issuePatch`
  (src/sync/execute-hierarchy.ts:104-111) learn about it. Write cost stays 1
  (src/plan.ts:107-121). PATCH replaces the set, so every PATCH must send a full set built from
  this run's snapshot: a human edit between read and write is undone, bot assignees get re-sent,
  and one bad login blocks title, milestone and type.
- **Separate add and remove actions:** `POST`/`DELETE /issues/{n}/assignees` name only the logins
  the mirror owns and keep everything else. They need new action kinds in `writeCost`, `phaseOf`
  (src/plan.ts:295-311), `executeAction` (src/sync/execute.ts:77-98), the preview
  (src/sync/preview.ts:48-77) and `describe` (src/sync/describe.ts:15-32). They also need new
  client calls (next to `addLabel`, src/github/issues.ts:186, or in a new file) and methods on
  `GitHubWriter` (src/sync/execute-write.ts:31-46), the only GitHub writer. A separate add for a
  mirror created earlier in the same run needs its number from the run-local map
  (src/sync/resolved.ts) and waits like D4; otherwise it lands one run later.
- **A follow-up right after a create,** modelled on the A5 label re-add `ensureLabel`
  (src/sync/execute-issues.ts:94-118): one `POST /issues/{n}/assignees` once the 201 is in,
  checked against `writer.count()` itself. That needs no new action kind and no D4 wait, but it
  is not planned, so `withinWriteCap` (src/plan.ts:343-354) and the dry-run preview don't see it.

In every shape, compare sent with returned logins ignoring ASCII case, like `loginKey`
(src/plan.ts:276-278), and warn without naming the login. Riding `update` needs no new tally
counter (src/sync/tally.ts:12-33); `updated` then also counts assignee-only writes.

### Fetch and write budget

| Item                               | Today                                 | With assignees                                          |
| ---------------------------------- | ------------------------------------- | ------------------------------------------------------- |
| Reads                              | 3 (issues, milestones, YouTrack page) | 4, plus 1 per further 100 assignable users              |
| YouTrack request size              | 40.6 KB for 52 issues                 | 51.5 KB, same single request                            |
| Default cap                        | 3 + 30 writes = 33 of 45              | 4 + 30 = 34 of 45                                       |
| With the proposed chain's lookups  | -                                     | 4 + at most 5 + 30 = 39 of 45 (see Budget above)        |
| At `MAX_WRITES_LIMIT` 40           | 43 of 45 (2 spare for retries)        | 44 of 45 (1 spare)                                      |
| First-run assignee writes (CUI)    | -                                     | Up to 12-14 (open mirrors); at most 17 with closed ones |
| New mirror with a matched assignee | 1 write (create)                      | 1 in the create body; 2 with a separate add call        |
| Reassignment between matched users | -                                     | 1 PATCH, or 2 separate calls (remove, then add)         |

Sources: src/http.ts:72 (`DEFAULT_MAX_FETCHES = 45`), src/config.ts:48-49 (`MAX_WRITES_LIMIT`),
README.md:815-818. The guard is set once in the shared sync core (src/sync.ts:170), so these
numbers hold on all three hosts. Only the Worker adds the platform's 50-subrequest limit, and its
10 ms CPU limit was not measured against the larger YouTrack response. On the Action, with the
assignable list but no lookups, at most 33 GitHub requests per run without retries (3 GitHub
reads, 30 writes; today it is 32) is about 200 an hour at one run every 10 minutes, well under
`GITHUB_TOKEN`'s 1,000 per hour per repository [54]; with 5 lookups it is 38. If reads alone pass
45, `FetchBudgetExceededError` fails the read phase (src/http.ts:148-150). The list grows with org
membership, not with the team, because org members with read access are assignable [41]. 13 test
pins (12 `fetches: 3` in 7 files plus 1 `fetches=3`), the guard test arithmetic
(test/sync/guard.test.ts:45) and README.md:183, 514 and 815 pin today's three reads.

### Config surface

If a switch or map is added (`REOPEN_CLOSED_BY` is the model, empty means off,
src/config.ts:255-265): `ENV_KEYS`, `Config` and `parseConfig` in src/config.ts; `.env.example`;
`wrangler.example.jsonc` and a rerun of `npm run gen:worker-types`; an input and env line in
action.yml, which test/action/action.test.ts:129 checks against `ENV_KEYS`; and the README (Inputs,
the Permissions bullet at README.md:220-221, Configuration, "Using it day to day" at README.md:69,
"Hand-made links stay", "What it never does", Limits) and CLAUDE.md. The empty-input rule
(README.md:228-230) means an empty map must mean "no map". Map logins can be checked with
`GITHUB_LOGIN_PATTERN` (src/config.ts:139). A map in the workflow file is committed to the repo; a
repo variable renders unmasked in build outputs [101], a secret is masked (see "Manual map"); the
Worker's copy lives in the gitignored wrangler.jsonc.

### README contract

README.md:69 says "Assign, label, comment and link PRs on GitHub as you like". With the feature
on, that holds only for assignees the mirror does not own: under choice 5(c), a team member
assigned by hand whose login maps to a YouTrack user can be removed again. "Hand-made links stay"
(README.md:550-552) and "What it never does" (554-562) would need an assignee line, and the
Permissions bullet (220-221) would add assignees to what `issues: write` covers. YouTrack stays
GET-only: the only call is still `GET /api/issues`.

### Logging and privacy

- **Personal data** [verified] [96][97]: GDPR counts "an identification number" and "an online
  identifier" [96] and requires data "limited to what is necessary" [97]. Student IDs, BUas emails
  and logins that contain an ID all qualify. BUas policy and who the controller is were not
  researched.
- **Who reads logs** [verified] [79]: "Read access to the repository is required to perform these
  steps." and "You must be logged in to a GitHub account to view workflow run information,
  including for public repositories."
- **Today's redaction** removes only the two tokens: `secretRedactor` (src/sync.ts:164;
  src/utils/redact.ts:16-21) through `redactingLogger` (src/sync/log.ts:15-27). The action wording
  promises "YouTrack ids and GitHub numbers only" (src/sync/describe.ts:3), and R3 allows titles
  but nothing about people.
- **Leaks to watch:** a 422 body naming a login lands in `HttpError` (src/http.ts:394), the failure
  line (src/sync/execute-write.ts:126), `SyncFailedError.message` (src/sync.ts:116) and node.ts's
  output. `GitHubSchemaError`'s `quote()` echoes up to 40 characters of untrusted strings
  (src/github/client.ts:144-151). Emails can only reach a log if the YouTrack parser lets them out.
- Assigning itself publishes "this person works on this" to every reader of the repo.

### Tests

Models exist for every part: test/youtrack/hierarchy.test.ts (`Type` parsing, invalid
`customFields`), test/github/parse-fields.test.ts (`milestone`, `closed_by`), the list, update and
write tests in test/github/, test/plan/sync.test.ts (type sync D3, closed mirrors D8, titles N2),
exclude, reopen, cap and order tests, test/config/flags.test.ts (`REOPEN_CLOSED_BY`) and
test/action/action.test.ts. New: a matcher test (the edge-case table above), and a test that no
log line, failure line or `SyncFailedError.message` contains a fixture login or email. The fake
GitHub in test/sync/fixtures.ts 404s unknown routes (326-329), so it needs a `GET /assignees`
route; its created and patched answers (261-283) must echo `assignees`, or every e2e write warns
"dropped"; and a variant should answer 422.

## Behavior choices

All of these are now answered in [08](08-decisions.md): 1 (U1), 2 (U2, U17), 3 (U17), 4 (U3),
5 (U4), 6 (U5), 7 (U6), 8 (U7), 9 (U16), 10 (U8), 11 (U9), 12 (U13). The list is kept as first
researched: "_Rec:_" marks what the research leaned towards.

1. **Switch.** (a) Opt-in, off on every host. (b) On in the Action only, like R10. (c) Always on.
   Always on changes the README contract ("Assign, label, comment and link PRs on GitHub as you
   like", README.md:69), adds a read and notifications for every group, and counts as breaking
   under CONTRIBUTING.md ("anything a group running the mirror would notice after updating"): a
   `feat!`, still a minor bump on 0.x (.releaserc.json). _Rec:_ (a).
2. **Matching source.** (a) Login ID only. (b) Login ID plus an explicit map. (c) Login ID plus a
   commit-email cross-check (needs `contents: read` in every workflow). (d) Map only. _Rec:_ (a),
   with (b) later if staff assignment is wanted.
3. **YouTrack identifier.** (a) Login only, and don't request the email at all (data
   minimization). (b) Login, cross-checked with the email when visible; skip on disagreement.
   (c) Both required, which fails for tokens that can't see emails. (d) Either one when only one
   carries an ID, which also covers a login without the ID next to an `<ID>@buas.nl` email.
   _Rec:_ (b), or (a) if the cross-check isn't worth reading emails.
4. **Ambiguous or unmatched.** (a) Skip and warn. (b) Prefer the email ID. (c) Prefer the login ID.
   Warnings could be per issue every run (noisy), one aggregated per run, or a summary count
   (changes `SUMMARY_FIELDS`, src/sync.ts:199-215, and every summary test). _Rec:_ skip, one
   aggregated warning per run, ids only.
5. **Who owns GitHub assignees.** (a) YouTrack wins: replace the set every run; removes human, staff
   and bot assignees. (b) Add only, never remove; a YouTrack reassignment from A to B leaves A.
   (c) Mirror-owned, the D2 analog: remove only logins that map by ID to a YouTrack user seen in
   this scan, keep staff, people without an ID and bots. (d) Mirror-owned by shape: any login with
   a 6-digit ID. (e) Set once on create. Exact "assigned by the mirror" tracking would need event
   reads per mirror, and bodies never change (N2), so there is nowhere to keep a marker. Under (c)
   a human assigning another team member by hand is undone. _Rec:_ (c), never touching `Bot`
   assignees.
6. **Which write.** (a) In the create body and the sync PATCH: no extra writes, but a 422 blocks
   the create or the whole sync, and PATCH replaces the set. (b) In the sync PATCH only, with
   logins checked against this run's list, so a create never depends on an assignee. (c) Separate
   `POST`/`DELETE /issues/{n}/assignees`: keeps other assignees, reportedly ignores bad logins
   instead of failing, but costs one write per change and new action kinds. For a new mirror, the
   add can also run right after the create, like the A5 label re-add. _Rec:_ (c), checked against
   the list and verified in the response. (b) is the smaller code change.
7. **YouTrack unassigned, or reassigned to someone unmatched.** (a) Leave GitHub alone, the D3
   analog. (b) Clear owned assignees. (c) Clear all. Clearing turns a renamed field, a typo or an
   anonymized view into a mass unassignment with notifications. _Rec:_ (a), plus a loud warning
   when no scanned row has the field; keep a matched student until a matched assignee replaces
   them.
8. **Closed mirrors.** (a) Open mirrors only. (b) All, like D8. _Rec:_ (a): assignees signal
   current work, and (b) notifies people about finished issues.
9. **Assignable-list read fails.** (a) Fatal, like the other reads. (b) Warn and skip assignee sync
   this run. The other reads are fatal because a partial list causes duplicate mirrors, which does
   not apply here.
10. **Logging.** (a) Markers and counts only ("set assignee"), plus scrubbing logins from failure
    reasons. (b) Logins in action lines. _Rec:_ (a), with a test.
11. **Rollout.** A dry run first, `max-writes-per-run: "1"` for the first live run (README.md:198),
    and tell the team. _Rec:_ yes.
12. **Epics.** Milestones can't have assignees [81]. (a) Ignore epic assignees. (b) Push them down
    to children. _Rec:_ (a).

## Gotchas

1. **A wrong field name looks like "nobody is assigned".** An unknown or alias name returns 200 and
   `customFields: []` on every row (live). The current reader treats a missing entry as none
   (src/youtrack.ts:232). Treat a missing entry as an error, never as `null`.
2. **The filter ignores case, the code doesn't.** `typeEntries` compares `name === "Type"`
   (src/youtrack.ts:218).
3. **Today's URL builder can't repeat `customFields`** (src/youtrack.ts:295-303), and the pinned
   test URL changes with it.
4. **Email visibility may depend on whose token it is** (inferred, not stated), and may change on
   a 2026.x upgrade. Match on the login; treat a `null` email as unknown, not a mismatch.
5. **Both sides' identifiers are self-asserted.** BUas students can edit their own username and
   email, and emails are unverified in practice (U11); GitHub users rename freely; unverified
   GitHub emails still link commits. Rely on the exactly-one rules and the assignable list.
6. **Staff have no ID.** 2 of 6 possible YouTrack assignees and 30 of 34 assignable GitHub logins.
7. **The instance returns fields its spec lacks** (`userType`, `banBadge`) and drops some its docs
   list. Don't rely on `isAnonymized` or `banReason`.
8. **VCS usernames are not GitHub logins,** and they're behind the Hub API anyway.
9. **One unassignable login can fail a whole create or PATCH** (422, community reports). Never
   send a login that isn't in this run's assignable list.
10. **PATCH replaces the whole set.** It undoes human edits made since the read, wipes extra
    assignees (README.md:69) and re-sends bots the token may not be allowed to assign.
11. **`POST .../assignees` drops silently.** Without checking the response, the same write repeats
    every run and eats `MAX_WRITES_PER_RUN`.
12. **The assignability check is case-sensitive.** Write the exact `login` from the list.
13. **The assignable list excludes commenters but includes all org members with read access,** so
    it grows with the org, not the team.
14. **Bot assignees exist** on issues (type `Bot`), while the list returned only `User`s.
15. **`@octokit/openapi-types` still has the singular `assignee`** and an object form for PATCH
    `assignees`. Send plain string arrays.
16. **422 bodies echo logins,** and logins carry student IDs. They end up in failure lines and
    `SyncFailedError` unless scrubbed.
17. **No assigner on the issue object;** issue events cost one GET per mirror.
18. **Assigning notifies and subscribes people.** Rollout sends a burst; create-then-assign may
    send two emails; PAT-made assignments start `issues: assigned` workflows.
19. **Admin actions change YouTrack assignees** (deletes, merges). A desired-state comparison each
    run handles it; logic that reacts only to changes wouldn't.
20. **Noreply emails contain ID-like numbers** (`<ID+USERNAME@users.noreply.github.com>` [67]).
    Take IDs only from YouTrack logins and emails, GitHub logins and `buas.nl` emails.
21. **The commit-email method needs `contents: read` on a private repo,** which the README
    workflow doesn't grant.
22. **Unauthenticated public GitHub responses are cached for 60 s without varying on the API
    version header** (live: `s-maxage=60`, `Vary` without `X-GitHub-Api-Version`). This only
    matters for manual curl comparisons between versions: change the URL. The tool pins one version.

## Live write test (2026-10-02)

U10, run on a personal private playground repo with real writes: once with the member's classic
PAT (`repo`), once inside a `workflow_dispatch` run with `GITHUB_TOKEN` (`issues: write`, and a
second job with `contents: read` added). Logins were replaced by labels: SELF (the repo owner, the
only assignable account), NON (`octocat`, a real account that can't be assigned there), and the
bot. Every result was the same for both tokens unless the table says otherwise. These results
replace the [partial] and [undocumented] marks on the same points elsewhere in this doc.

| Request                                                                | Result [live]                                                                                                                                         |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /issues/{n}/assignees` `[SELF, NON]`                             | 201; SELF assigned, NON silently ignored                                                                                                              |
| `POST /issues/{n}/assignees` `[NON]`                                   | 201; nothing changes                                                                                                                                  |
| `DELETE /issues/{n}/assignees` `[NON]` (not assigned)                  | 200; nothing changes                                                                                                                                  |
| `DELETE /issues/{n}/assignees` `[SELF]`                                | 200; removed                                                                                                                                          |
| Add, then remove, SELF in other letter case                            | 201 and 200; assigned and removed, the response spells the login as GitHub does                                                                       |
| `PATCH /issues/{n}` `assignees: [SELF, NON]`                           | 422 for the whole request (`field: assignees`, `code: invalid`); nothing changes                                                                      |
| `PATCH /issues/{n}` `assignees: []`                                    | 200; all removed                                                                                                                                      |
| `POST /issues` with `assignees: [NON]` or `[SELF, NON]`                | 422 "assignees ... cannot be assigned to this issue"; no issue is created                                                                             |
| `GET /repos/{o}/{r}/assignees/{login}`                                 | SELF 204; SELF in other case 404; NON 404                                                                                                             |
| `GET /repos/{o}/{r}/issues/{n}/assignees/{login}`                      | SELF 204; NON 404 "User cannot be assigned to this issue."                                                                                            |
| `assigned` / `unassigned` events                                       | `assigner` is the token's account (PAT: SELF; Actions: `github-actions[bot]`); `actor` is the assignee; `performed_via_github_app` is `null` for both |
| `GET /commits?author=<email>`, `GITHUB_TOKEN` without `contents: read` | 403 "Resource not accessible by integration"                                                                                                          |
| `GET /commits?author=<email>`, PAT or with `contents: read`            | 200; the linked account (SELF), also for the email in upper case                                                                                      |
| `GET /search/users?q="<email>" in:email type:user`                     | 200 with both tokens, `X-RateLimit-Limit: 30`, resource `search`; 0 hits (the email isn't public)                                                     |

Input echo: a composite action that receives `with: map: <dummy>` and passes it on as `env`, as
action.yml does, printed the value twice in the run log, under the step's `with:` and its `env:`.
A map in a repo variable would therefore be readable by anyone who can see the run logs, so the
map belongs in a secret, which the log masks (U14).

What this means for the design:

- U5 holds: the separate add and remove calls never fail on a login that can't be assigned, while
  a create or `PATCH` would fail as a whole. The response's `assignees` must still be checked,
  because an ignored login looks like success.
- Write bodies ignore case; the repo-level check does not. Compare logins ignoring case and send
  them as the assignable list spells them.
- Step c needs `contents: read` on the Action (a 403 without it), so the README workflow gains it;
  without it, step c is skipped for the run with a warning (U17).
- `assigner` would tell the mirror's own assignments apart, but reading events costs one GET per
  mirror (U12 keeps it out of scope).

## Not documented / not found

GitHub:

- What happens to a login that can't be assigned when the caller has push access, on create,
  PATCH and add-assignees. Community reports only.
- Whether `GITHUB_TOKEN` with `issues: write` counts as "push access" for the drop rules.
- The per-issue assignability check with authentication; case handling of logins in write bodies.
- More than 10 assignees; whether Copilot appears in `/assignees`; whether username uniqueness
  ignores case; whether a public profile email must be verified.
- Whether bot-made or self-made assignments notify; the default for "Your own updates"; whether an
  assignment counts as content-generating.
- Whether a `GITHUB_TOKEN` assignment shows `github-actions[bot]` as actor and a non-null
  `performed_via_github_app`.
- The effective rate limit of authenticated user search; whether GraphQL user search matches
  private emails; whether composite-action inputs are echoed in step logs.
- What List commits returns to `GITHUB_TOKEN` without `contents: read` on a private repo (403 or
  404), and what its 409 means.
- Docs conflicts: outside collaborators with Read (help page vs roles table); push vs Triage for
  assigning.

YouTrack and BUas:

- An `isAssignee` marker; that any permission hides `email`, and whether it is then `null` or left
  out; whether a private field is left out or `null`; whether an empty multi-user value is `[]` or
  `null`.
- Whether `updated` changes when a delete or merge changes the assignee.
- The 2025.2 rule for global permissions granted at project level (only implied to work, by the
  2026 upgrade notes [98]).
- BUas's auth module and whether email verification is required (students can edit username and
  email, U11); whether the identity provider overwrites profile edits; the student number length
  (6 digits) and leading zeros; the staff format.
- The shape of an anonymized username, and how many digits an anonymized name has.

Notable corrections and refutations (first claims that did not survive verification):

- The repo-wide `/assignees` list does **not** include people who only commented (live).
- The per-issue check gave 204 for a current assignee, not 404 (live, unauthenticated).
- "Your own actions are not emailed by default" is not supported by the docs.
- The docs **do** say `GITHUB_TOKEN` can assign (installation tokens are listed for Add assignees).
- Only `userType` is marked "since 2026.2", not `banBadge`, `banReason` or `isAnonymized`.
- VCS usernames are also a 2025.2 YouTrack profile attribute, not only a Hub one.
- A third-party page claiming "6 positions" for BUas student numbers now returns 404 and was
  dropped; so was a data-broker guess at the staff email format.

## Open questions for the user

Numbered 1-17 here and 16-32 in [07](07-open-questions.md) section D (1 here is Q16 there).
All are answered in [08](08-decisions.md) (U1-U17).

1. **Opt-in?** Off on every host / on in the Action only (R10 style) / always on (`feat!`).
   _Rec:_ off on every host. **Answered: U1** (on by default, breaking, v1.0.0).
2. **Matching source?** Login ID only / login ID plus a map / login ID plus a commit-email
   cross-check (needs `contents: read`) / map only. _Rec:_ login ID on the assignable list.
   **Answered: U2, U17** (automatic with fallbacks, plus a map; the chain above).
3. **Which YouTrack identifier?** Login only, email not requested / login with an email
   cross-check when visible / both required / either one when only one carries an ID. _Rec:_
   login, with the cross-check. **Answered: U17** (as the _Rec now_ below). The proof the user asked for is in "Who can see
   logins and emails": hidden emails are an inference, not a stated rule, and this token sees
   every email that is set. Logins, which the chain needs, are real for every default team role
   on 2025.2.
   _Rec now:_ as in the chain: the login first, plus the built `<ID>@buas.nl` and the real email
   when visible, with `null` as unknown. Not reading emails at all would lose 0 matches on CUI
   today.
4. **Ambiguous or unmatched users?** Skip and warn / prefer the email ID / prefer the login ID; and
   per-issue warnings / one per run / a summary count. _Rec:_ skip, one aggregated warning.
   **Answered: U3.**
5. **Who owns GitHub assignees?** YouTrack wins / add only / mirror-owned (logins mapping to a
   YouTrack user) / mirror-owned (any login with an ID) / set on create only. _Rec:_ mirror-owned
   by mapping, never bots. **Answered: U4** (mirror-owned, as explained under "Gaming and
   ownership").
6. **Which write call?** Create body and sync PATCH / sync PATCH only / separate add and remove
   calls (for a new mirror, possibly right after the create, like A5). _Rec:_ separate calls,
   checked against the list. **Answered: U5.**
7. **YouTrack unassigned, or reassigned to someone unmatched?** Leave GitHub alone / clear owned
   assignees / clear all. _Rec:_ leave alone, with a loud warning when the field is missing.
   **Answered: U6.**
8. **Closed mirrors too (D8)?** Open only / all. _Rec:_ open only. **Answered: U7.**
9. **What may logs show?** Counts and markers only / YouTrack ids with matched or unmatched / full
   logins. _Rec:_ markers and ids, with 422 bodies scrubbed of logins. **Answered: U8.**
10. **An explicit map** for staff and logins without an ID? If so, as a repo variable or in the
    workflow file? _Rec:_ defer. **Answered: U14** (the _Rec now_). _Rec now:_ the format under "Manual map",
    keyed by YouTrack login; a secret or a repo variable on the Action, decided after the
    throwaway test shows whether inputs are echoed.
11. **Field name and multi-user fields?** Fixed `Assignee` / a config var (default `Assignee`)
    checked to be a user field / detect by type and fail on more than one; for multi-user fields:
    all (up to 10) / the first / fail. Whichever is picked, a missing field should fail loudly.
    In plain words: admins can rename the Assignee field or make it hold several people. A wrong
    name gives no error; it looks like nobody is assigned anywhere. **Answered: U15** (fixed
    `Assignee` like `Type`; every matched user of a multi-user field; a loud warning and no
    assignee changes when no row has it).
12. **Assignable-list read fails:** fatal like the other reads, or warn and skip assignee sync?
    In plain words: if the one extra GitHub read of who can be assigned fails, should the whole
    run stop, or should everything else carry on with assignees skipped this run? **Answered:
    U16** (carry on with a warning; it can't cause duplicate mirrors).
13. **Rollout:** dry run, then `max-writes-per-run: "1"`, and tell the team first? _Rec:_ yes.
    **Answered: U9.**
14. **A live authenticated test on a throwaway repo** (silent drop vs 422, the per-issue check,
    the actor on `GITHUB_TOKEN` events)? It needs real GitHub writes, so only you can turn
    `DRY_RUN` off for it. Yes, on a personal test repo / no, design for both outcomes.
    **Answered: U10** (see "Live write test").
15. **For a BUas YouTrack admin:** which auth module; can students edit username and email; is
    email verification required; does the identity provider overwrite edits; Contributor or
    Developer for student projects; is a 2026.x upgrade planned? Ask / assume self-asserted and
    rely on the duplicate-skip rule. **Answered: U11** (no admin contact; students can edit them).
16. **Sources that need an owner or new endpoints** (Enterprise Cloud, SAML or a verified domain;
    Hub VCS usernames; issue events): ask an org owner / out of scope. _Rec:_ out of scope.
    **Answered: U12.**
17. **Epic assignees:** ignore / push down to children. _Rec:_ ignore. **Answered: U13.**

## Sources

1. Issues resource -- https://www.jetbrains.com/help/youtrack/devportal/resource-api-issues.html
2. Custom Fields in REST API -- https://www.jetbrains.com/help/youtrack/devportal/api-concept-custom-fields.html
3. SingleUserIssueCustomField -- https://www.jetbrains.com/help/youtrack/devportal/api-entity-SingleUserIssueCustomField.html
4. MultiUserIssueCustomField -- https://www.jetbrains.com/help/youtrack/devportal/api-entity-MultiUserIssueCustomField.html
5. User entity -- https://www.jetbrains.com/help/youtrack/devportal/api-entity-User.html
6. Fields Syntax -- https://www.jetbrains.com/help/youtrack/devportal/api-fields-syntax.html
7. UserProjectCustomField -- https://www.jetbrains.com/help/youtrack/devportal/api-entity-UserProjectCustomField.html
8. Manage Custom Fields per Project (Server 2025.2) -- https://www.jetbrains.com/help/youtrack/server/2025.2/manage-custom-fields-per-project.html
9. Default Custom Fields (Server 2025.2) -- https://www.jetbrains.com/help/youtrack/server/2025.2/default-custom-fields.html
10. Permissions Reference (Server 2025.2) -- https://www.jetbrains.com/help/youtrack/server/2025.2/youtrack-permissions-reference.html
11. Permissions Reference (current, 2026.x) -- https://www.jetbrains.com/help/youtrack/server/youtrack-permissions-reference.html
12. Default Roles (Server 2025.2) -- https://www.jetbrains.com/help/youtrack/server/2025.2/default-roles.html
13. Permissions Comparison for Default Roles (Server 2025.2) -- https://www.jetbrains.com/help/youtrack/server/2025.2/permissions-comparison-for-default-roles.html
14. Secure Your Installation (current, 2026.x) -- https://www.jetbrains.com/help/youtrack/server/secure-your-installation.html
15. Secure Your Installation (Server 2025.2) -- https://www.jetbrains.com/help/youtrack/server/2025.2/Secure-Your-Installation.html
16. Configure Access for a User Account (current, 2026.x) -- https://www.jetbrains.com/help/youtrack/server/configure-access-for-user-account.html
17. Manage Organization Permissions (Server 2025.2) -- https://www.jetbrains.com/help/youtrack/server/2025.2/manage-organization-permissions.html
18. Manage Organization Permissions (current, 2026.x) -- https://www.jetbrains.com/help/youtrack/server/manage-organization-permissions.html
19. Anonymize User Data (Server 2025.2) -- https://www.jetbrains.com/help/youtrack/server/2025.2/anonymize-user-data.html
20. General Profile Settings (Server 2025.2) -- https://www.jetbrains.com/help/youtrack/server/2025.2/general-profile-settings.html
21. Hub: User Profile (2025.2) -- https://www.jetbrains.com/help/hub/2025.2/user-profile.html
22. Hub: Permissions (2025.2) -- https://www.jetbrains.com/help/hub/2025.2/hub-permissions.html
23. Hub: Configuring User Account Settings (2025.2) -- https://www.jetbrains.com/help/hub/2025.2/configuring-user-account-settings.html
24. Manage Custom Attributes (Server 2025.2) -- https://www.jetbrains.com/help/youtrack/server/2025.2/manage-custom-attributes.html
25. Manage Permanent Tokens (Server 2025.2) -- https://www.jetbrains.com/help/youtrack/server/2025.2/manage-permanent-token.html
26. Manage Permanent Token (devportal) -- https://www.jetbrains.com/help/youtrack/devportal/Manage-Permanent-Token.html
27. Merge User Accounts (Server 2025.2) -- https://www.jetbrains.com/help/youtrack/server/2025.2/merge-user-accounts.html
28. Delete User Accounts (Server 2025.2) -- https://www.jetbrains.com/help/youtrack/server/2025.2/delete-user-accounts.html
29. Ban User Accounts (Server 2025.2) -- https://www.jetbrains.com/help/youtrack/server/2025.2/ban-user-accounts.html
30. Common Settings for Auth Modules (Server 2025.2) -- https://www.jetbrains.com/help/youtrack/server/2025.2/auth-module-common-settings.html
31. Microsoft Entra ID Auth Module (Server 2025.2) -- https://www.jetbrains.com/help/youtrack/server/2025.2/azure-ad-auth-module.html
32. OAuth 2.0 Auth Module (Server 2025.2) -- https://www.jetbrains.com/help/youtrack/server/2025.2/oauth2-authentication-module.html
33. GitHub Auth Module (Server 2025.2) -- https://www.jetbrains.com/help/youtrack/server/2025.2/github-authentication-module.html
34. Hub REST API JSON Scheme -- https://www.jetbrains.com/help/youtrack/devportal/HUB-REST-API_JSON-Scheme.html
35. Match Commit Authors and YouTrack Users (Server 2025.2) -- https://www.jetbrains.com/help/youtrack/server/2025.2/match-commit-authors-and-youtrack-users.html
36. Users in YouTrack and Hub -- https://www.jetbrains.com/help/youtrack/devportal/api-users-yt-vs-hub.html
37. Users resource -- https://www.jetbrains.com/help/youtrack/devportal/resource-api-users.html
38. Activities resource -- https://www.jetbrains.com/help/youtrack/devportal/resource-api-activities.html
39. GitHub REST: Issues (2026-03-10) -- https://docs.github.com/en/rest/issues/issues?apiVersion=2026-03-10
40. GitHub REST: Assignees (2026-03-10) -- https://docs.github.com/en/rest/issues/assignees?apiVersion=2026-03-10
41. Assigning issues and pull requests to other GitHub users -- https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/assigning-issues-and-pull-requests-to-other-github-users
42. Repository roles for an organization -- https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization
43. REST breaking changes, version 2026-03-10 -- https://docs.github.com/en/rest/about-the-rest-api/breaking-changes#version-2026-03-10
44. Permissions required for GitHub Apps -- https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
45. Permissions required for fine-grained personal access tokens -- https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
46. GITHUB_TOKEN -- https://docs.github.com/en/actions/concepts/security/github_token
47. Workflow syntax: permissions -- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions
48. Scopes for OAuth apps -- https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
49. Issue event types: assigned -- https://docs.github.com/en/rest/using-the-rest-api/issue-event-types#assigned
50. GitHub REST: Issue events (2026-03-10) -- https://docs.github.com/en/rest/issues/events?apiVersion=2026-03-10
51. GitHub REST: Notifications -- https://docs.github.com/en/rest/activity/notifications
52. About notifications -- https://docs.github.com/en/subscriptions-and-notifications/concepts/about-notifications
53. Configuring notifications -- https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications
54. Rate limits for the REST API -- https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
55. Best practices for using the REST API -- https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
56. GitHub REST: Users -- https://docs.github.com/en/rest/users/users
57. GitHub GraphQL: Users -- https://docs.github.com/en/graphql/reference/users
58. GitHub REST: Search -- https://docs.github.com/en/rest/search/search
59. Searching users -- https://docs.github.com/en/search-github/searching-on-github/searching-users
60. Searching commits -- https://docs.github.com/en/search-github/searching-on-github/searching-commits
61. GitHub REST: Commits -- https://docs.github.com/en/rest/commits/commits#list-commits
62. Why are my commits linked to the wrong user? -- https://docs.github.com/en/pull-requests/committing-changes-to-your-project/troubleshooting-commits/why-are-my-commits-linked-to-the-wrong-user
63. Troubleshooting adding an email -- https://docs.github.com/en/account-and-profile/how-tos/email-preferences/troubleshooting-adding-an-email
64. Troubleshooting email verification -- https://docs.github.com/en/account-and-profile/how-tos/email-preferences/troubleshooting-email-verification
65. About email addresses -- https://docs.github.com/en/account-and-profile/concepts/email-addresses
66. Setting your commit email address -- https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address
67. Email addresses reference -- https://docs.github.com/en/account-and-profile/reference/email-addresses-reference
68. Username changes -- https://docs.github.com/en/account-and-profile/concepts/username-changes
69. Username considerations for external authentication -- https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/iam-configuration-reference/username-considerations-for-external-authentication
70. Verifying or approving a domain (Enterprise Cloud) -- https://docs.github.com/en/enterprise-cloud@latest/organizations/managing-organization-settings/verifying-or-approving-a-domain-for-your-organization
71. Verifying or approving a domain -- https://docs.github.com/en/organizations/managing-organization-settings/verifying-or-approving-a-domain-for-your-organization
72. Changelog: API support for viewing organization members' verified email addresses (2020-05-19) -- https://github.blog/changelog/2020-05-19-api-support-for-viewing-organization-members-verified-email-addresses/
73. GitHub GraphQL: Organizations -- https://docs.github.com/en/graphql/reference/orgs
74. GitHub GraphQL: Enterprise administration -- https://docs.github.com/en/graphql/reference/enterprise-admin
75. About identity and access management with SAML single sign-on -- https://docs.github.com/en/enterprise-cloud@latest/organizations/managing-saml-single-sign-on-for-your-organization/about-identity-and-access-management-with-saml-single-sign-on
76. Authorizing a personal access token for use with single sign-on -- https://docs.github.com/en/enterprise-cloud@latest/authentication/authenticating-with-single-sign-on/authorizing-a-personal-access-token-for-use-with-single-sign-on
77. GitHub REST: Classroom -- https://docs.github.com/en/rest/classroom/classroom
78. Changelog: GitHub Classroom sign-ups are no longer available (2026-05-26) -- https://github.blog/changelog/2026-05-26-github-classroom-sign-ups-are-no-longer-available/
79. Using workflow run logs -- https://docs.github.com/en/actions/how-tos/monitor-workflows/use-workflow-run-logs
80. Events that trigger workflows -- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
81. GitHub REST: Milestones (2026-03-10) -- https://docs.github.com/en/rest/issues/milestones?apiVersion=2026-03-10
82. Community discussion 186820 (422 on assignees, bots and `GITHUB_TOKEN`) -- https://github.com/orgs/community/discussions/186820
83. octokit.net issue 3067 (PATCH 422 with a Copilot assignee) -- https://github.com/octokit/octokit.net/issues/3067
84. trstringer/manual-approval issue 93 (422 on create) -- https://github.com/trstringer/manual-approval/issues/93
85. trstringer/manual-approval issue 109 (422, rights and capitalisation) -- https://github.com/trstringer/manual-approval/issues/109
86. rust-lang/rust pull request 64119 -- https://github.com/rust-lang/rust/pull/64119
87. mydcc/cachy-app issue 3363 (PATCH 422 on one unknown assignee) -- https://github.com/mydcc/cachy-app/issues/3363
88. NVIDIA/nodewright assign workflow -- https://github.com/NVIDIA/nodewright/blob/main/.github/workflows/assign.yaml
89. UCLA-Creative-Labs/sunshine issue 351 -- https://github.com/UCLA-Creative-Labs/sunshine/issues/351
90. Community discussion 27585 (emails for API assignments) -- https://github.com/orgs/community/discussions/27585
91. pozil/auto-assign-issue -- https://github.com/pozil/auto-assign-issue
92. arXiv 2504.19215 (commit attribution with unverified emails) -- https://arxiv.org/html/2504.19215v1
93. Unito: how to map users and assignees -- https://guide.unito.io/how-to-map-users-and-assignees
94. Reside-IC: integrating YouTrack and GitHub workflows -- https://reside-ic.github.io/blog/integrating-youtrack-and-github-workflows/
95. BUas introlink FAQ -- https://introlink.buas.nl/veelgestelde-vragen/
96. GDPR Art. 4 -- https://gdpr-info.eu/art-4-gdpr/
97. GDPR Art. 5 -- https://gdpr-info.eu/art-5-gdpr/
98. Permission Updates in 2026 (current, 2026.x) -- https://www.jetbrains.com/help/youtrack/server/permission-updates-2026.html
99. Permissions Comparison for Default Roles (current, 2026.x) -- https://www.jetbrains.com/help/youtrack/server/permissions-comparison-for-default-roles.html
100. Troubleshooting the REST API -- https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api
101. Variables (concepts) -- https://docs.github.com/en/actions/concepts/workflows-and-actions/variables
102. Use variables -- https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-variables
