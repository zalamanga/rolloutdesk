# HTTP API

Local base URL: `http://127.0.0.1:8098`. JSON field names use camelCase; timestamps use UTC ISO 8601. The outer request body limit is 16 KiB. Unknown request fields, trailing JSON data and fractional values for integer fields are rejected.

There are two authentication paths. `/api` is the operator interface and uses a cookie session. `/client/v1` evaluates published configuration using an environment-scoped bearer token. A client token must stay on a trusted client/server; never include it in a browser build or a URL.

The machine-readable contract is [OpenAPI 3.0.3](openapi.json). The [Postman collection](postman/RolloutDesk.postman_collection.json), [blank-secret environment](postman/RolloutDesk.local.postman_environment.example.json) and [Indonesian REST walkthrough](REST-CLIENT-GUIDE.md) cover the complete release flow. Nginx serves their JSON at `/openapi.json`, `/postman.collection.json` and `/postman.environment.example.json`; these static public files contain no real credentials.

## Operator session

`POST /api/auth/login`

```json
{"email":"operator@rolloutdesk.test","password":"<local generated password>"}
```

Send `Content-Type: application/json` and `Origin: http://127.0.0.1:8098`. A successful response sets `rolloutdesk_session` and returns:

```json
{
  "user": {"id":"<operator UUID>","email":"operator@rolloutdesk.test","name":"<operator name>"},
  "csrfToken":"<session CSRF token>"
}
```

Keep the cookie and send `X-CSRF-Token` plus the exact Origin for authenticated mutations and preview. `GET /api/auth/session` restores the session response. `POST /api/auth/logout` returns 204 and invalidates the session.

`GET /api/health` is public and returns `{"status":"ok"}` only when the database is reachable; otherwise it returns 503. Other operator routes require a valid session, including reads. Failed login responses do not distinguish an unknown email from a wrong password.

## Registry and detail

| Method | Route | Result |
| --- | --- | --- |
| GET | `/api/flags` | Array of all three flags, ordered by key; states ordered staging then production. |
| GET | `/api/flags/{key}/{environment}` | Flag metadata, environment state and newest-first publication history. |

Allowed environments are `staging` and `production`. Registered keys are `checkout-redesign`, `bulk-export` and `priority-support`. Unknown operator flag/environment routes return 404.

An environment state has this shape:

```json
{
  "environment":"staging",
  "version":1,
  "draft":{"enabled":false,"rolloutBasisPoints":0,"allowlist":[]},
  "active":null,
  "updatedAt":"<UTC timestamp>"
}
```

The initial state has no active publication. A publication contains `revision`, `config`, `kind`, `sourceRevision`, `note`, `actor` and `createdAt`. `kind` is `PUBLISH` or `ROLLBACK`. A normal publication has null `sourceRevision`; rollback records the revision it copies.

A detail response is:

```text
{flag:{key,name,description}, state:EnvironmentState, history:Publication[]}
```

## Save a draft

`PUT /api/flags/{key}/{environment}/draft`

```json
{
  "expectedVersion":1,
  "config":{
    "enabled":true,
    "rolloutBasisPoints":2500,
    "allowlist":["demo-alice"]
  }
}
```

Returns the updated environment state. Saving a draft changes no active publication. An identical valid draft can return the unchanged state without an extra version or audit entry.

`rolloutBasisPoints` must be an integer from 0 through 10000. The allowlist contains at most 20 unique strings. Each subject is 1 through 64 ASCII bytes matching `[A-Za-z0-9._-]+`. Subject IDs are case-sensitive; duplicate entries are invalid. The server sorts the allowlist before comparison and storage.

`expectedVersion` must be an integer from 1 through 1,000,000,000. Invalid JSON, unknown request fields, unsupported Content-Type and body sizes over the 16 KiB JSON limit return 400 `INVALID_REQUEST`, rather than 415 or 422.

Use the version from the most recent explicit read. HTTP 409 means the state changed or the operation is no longer valid. Do not fetch a new version and automatically retry a pending write.

## Publish

`POST /api/flags/{key}/{environment}/publish`

```json
{"expectedVersion":2,"note":"Release staging checkout to the demo cohort"}
```

Returns `FlagDetail` including the new active publication. The server publishes the current stored draft and keeps that draft unchanged. The first publication is allowed even when disabled. Later publication of a configuration equal to the active one is rejected.

Each flag/environment pair allows at most 100 publications, including rollbacks. The server returns HTTP 409 with code `REVISION_LIMIT` after reaching this limit. Restarting containers does not reset it.

## Roll back

`POST /api/flags/{key}/{environment}/rollback`

```json
{"expectedVersion":4,"targetRevision":1,"note":"Restore the earlier staging cohort after review"}
```

The target must exist in the same flag/environment history. The result is a new immutable revision copying the target configuration, with `kind: "ROLLBACK"` and `sourceRevision: 1`. The draft stays as it was. Selecting a target with the same configuration as the active one is rejected.

`targetRevision` must be an integer from 1 through 100. A number within that range that does not exist in the pair returns 404.

Publication and rollback notes are trimmed and must contain 10 through 500 Unicode codepoints after trimming. The audit and active pointer change atomically with the publication.

## Compare draft and published decisions

`POST /api/flags/{key}/{environment}/preview`

```json
{"subjectId":"demo-alice"}
```

Returns `{published: Decision, draft: Decision}`. It requires the operator session, CSRF token and exact Origin, although it does not mutate state. Draft decisions always have a null revision and are labelled as draft in the UI.

This endpoint stores no subject and adds no audit or exposure entry. It evaluates the saved server draft, not unsaved form edits.

## Client evaluation

`POST /client/v1/evaluate/staging`

Headers:

```text
Content-Type: application/json
Authorization: Bearer <private staging token>
```

Body:

```json
{"flagKey":"checkout-redesign","subjectId":"demo-alice"}
```

After publishing the example allowlisted configuration as revision 1, this subject has the following decision:

```json
{
  "flagKey":"checkout-redesign",
  "environment":"staging",
  "revision":1,
  "value":true,
  "reason":"ALLOWLIST",
  "bucket":5224,
  "algorithm":"sha256-u32be-mod10000-v1"
}
```

Bucket 5224 follows the documented hash protocol for `checkout-redesign`, `staging` and `demo-alice`; the allowlist makes the decision true even though that bucket is outside a 2500 threshold. Your revision depends on the database history. The endpoint only reads the active publication. It never returns a draft or stores a subject/evaluation count. A production request needs the production token. A missing, invalid or wrong-environment token returns 401.

For a local request without copying a token into command history:

```powershell
.\scripts\Client-Check.ps1 -Environment staging -FlagKey checkout-redesign -SubjectId demo-alice
```

| Reason | Value | Meaning |
| --- | --- | --- |
| `FLAG_NOT_FOUND` | false | A syntactically valid but unregistered key; bucket and revision are null. |
| `UNPUBLISHED` | false | Known flag with no active publication; bucket exists, revision is null. |
| `DISABLED` | false | The selected configuration is disabled, including for allowlisted subjects. |
| `ALLOWLIST` | true | Enabled configuration and exact subject on its allowlist. |
| `ROLLOUT` | true | Enabled configuration and bucket below `rolloutBasisPoints`. |
| `OUTSIDE_ROLLOUT` | false | Enabled configuration, no allowlist match and bucket at or above the threshold. |

The bucket is deterministic for a flag, environment and exact subject. It does not change with the revision or threshold. See the exact [hash protocol](ARCHITECTURE.md#deterministic-evaluation) before implementing another client-side evaluator. This project ships no browser SDK.

## Audit

`GET /api/audit?page=0`

Returns `{items, page, pageSize: 25, total}`. Pages are zero-based exact integers from 0 through 10000. Negative, fractional, duplicate/malformed values are rejected according to request validation. The newest entries appear first with an ID tie-breaker.

An item contains `id`, `createdAt`, `actor`, `action`, `flagKey`, `environment`, nullable `revision` and `note`. Actions are `DRAFT_SAVED`, `PUBLISHED` and `ROLLED_BACK`. Preview and client evaluation create no audit records.

## Errors and uncertain responses

Errors use `{code, message}` and avoid echoing credentials or subject payloads. Common statuses are 400 for invalid input, 401 for missing/expired authentication, 403 for failed origin/CSRF checks, 404 for unknown operator resources and 409 for a stale version, rejected no-op or exhausted publication history. A stale version uses `VERSION_CONFLICT`; an unchanged active configuration uses `NO_CHANGE`; exhausted history uses `REVISION_LIMIT`. Login throttling returns 429 `RATE_LIMITED`.

A network failure does not prove that a mutation failed to commit. Refresh the flag, inspect its version and active revision, and then decide what to submit. There is no client-generated idempotency key for publication; the interface prevents automatic retries and reconciles through explicit reads, version checks and no-op guards.
