# RolloutDesk implementation contract

This contract coordinates backend, frontend, scripts and verification. The application is a local release-control lab, not a hosted feature-flag platform or an experiment-analysis service.

## Runtime and scope

- Rust 1.99.1 / axum 0.8.9 backend, React 19.3.1 / TypeScript 5.9.3 / Vite 6.4.5 static frontend, PostgreSQL 17 and Nginx. No Next.js, ORM, external integrations, client polling service or cache.
- Local exact application origin `http://127.0.0.1:8098`; main PG loopback port 5450, isolated test PG loopback 5451. Backend internal port 8080, Nginx internal 8080.
- Two fixed environments: `staging`, `production`. Three immutable registered flag keys: `checkout-redesign`, `bulk-export`, `priority-support`. Their names/descriptions explain synthetic demo features; no create/delete flag API or false generic flag-hosting claim.
- Seed those three flags and six environment states if absent. Initial drafts are `{enabled:false,rolloutBasisPoints:0,allowlist:[]}` with state version1 and no active publication. Seed one operator `operator@rolloutdesk.test` only when users empty. Never reset its password on restart.
- One operator, two fixed environment-scoped client tokens, no registration/multitenancy/roles/streaming SDK/exposure analytics. Client evaluation is read-only and never records subjects or evaluation counts.

## Configuration and bucketing

`Config={enabled:boolean,rolloutBasisPoints:integer0..10000,allowlist:string[]}`. At most20 unique subjects, each1..64 ASCII bytes matching `[A-Za-z0-9._-]+`, case sensitive. Sort allowlist before storing/comparing. Reject duplicates, unknown JSON fields, invalid booleans/fractional integers and trailing data. Outer request limit16KiB. Notes trim to10..500 Unicode codepoints.

Hash SHA-256 over the literal UTF-8 domain `rolloutdesk:v1` followed by three length-prefixed fields in order: flag key, environment, exact subject. Each prefix is that field's UTF-8 byte length as a four-byte unsigned big-endian integer. Read the first four digest bytes as unsigned big-endian u32 and take modulo10000. Bucket is0..9999. Do not include revision, percentage, enabled or allowlist, so increasing a threshold preserves the cohort. This simple modulo algorithm has negligible modulo bias; it does not promise exact percentages over a finite audience or act as authorization.

Evaluate known config in this precedence: disabled ->false/`DISABLED`; enabled and allowlisted ->true/`ALLOWLIST`; otherwise bucket<threshold ->true/`ROLLOUT`; else false/`OUTSIDE_ROLLOUT`. Allowlist never overrides disabled. Draft and published previews share this pure function and bucket. Missing registered key returns false/`FLAG_NOT_FOUND` with null bucket/revision; known unpublished returns false/`UNPUBLISHED` with its computed bucket and null revision.

## Auth and mutations

- Private env supplies DB password, generated operator password and separate staging/production client tokens (64 hex chars each). Runtime API receives operator password plus SHA-256 client-token digests (hex) rather than raw client tokens. Never put client tokens in browser bundles/responses/URLs/logs. Root scripts compute digests from private env.
- Password bcrypt cost12, expensive verification off the async reactor with bounded concurrency. Session opaque random UUIDv4 pair or32 random bytes, HTTP-only SameSite=Lax cookie `rolloutdesk_session`, Path/,12h; store SHA-256 digest in PG. Configurable Secure=false locally.
- All `/api` routes require a session except exact GET`/api/health` and POST`/api/auth/login`. JSON login requires exact Origin8098. Authenticated mutations and preview POST require exact Origin and `X-CSRF-Token` from session. Error JSON `{code,message}` with no sensitive values.
- Persist a bounded remote-address login throttle (shared reverse-proxy address documented), safe generic auth failure. Hash comparisons constant-time. Client-token keys are environment-bound; an authorized staging token cannot evaluate production.
- No payload/subject/token/session/signature logging. Bind backend internally; host exposed only through loopback Nginx. No redirects to external domains.
- Session mutations use `expectedVersion` integer. Save, publish and rollback lock that flag/environment state, compare version, then atomically change state/version and append audit. Publish/rollback append immutable revision and update the active pointer in the SAME transaction. Concurrent/stale writes409. Environments do not share state versions.
- Publish uses the current stored draft. Reject no-op publishing if draft equals active config. Keep draft unchanged. First publication (even disabled config) is allowed. Max100 publications per flag/environment; enforce under lock, return409`REVISION_LIMIT`.
- Rollback target must belong to the same flag/environment. Append a new revision copying target config, record target/sourceRevision and note, move active pointer, retain draft unchanged. Reject target config equal to active config. No history edits/deletes.
- A failed/uncertain mutation locks that UI action until explicit refresh/reconciliation. Do not automatically retry with a new expectedVersion. Retain edited config and notes. Refresh may show a committed publication; no-op guards and version checks prevent accidental duplicate publication.
- Reads of state+revision/history use one query or a repeatable-read snapshot. Do not mix active pointers and snapshots from separate ReadCommitted views.

## Types (camelCase JSON, UTC ISO8601 timestamps)

`Environment='staging'|'production'`

`User={id:string,email:string,name:string}`

`Session={user:User,csrfToken:string}`

`Publication={revision:integer,config:Config,kind:'PUBLISH'|'ROLLBACK',sourceRevision:integer|null,note:string,actor:string,createdAt:string}`

`EnvironmentState={environment:Environment,version:integer,draft:Config,active:Publication|null,updatedAt:string}`

`Flag={key:string,name:string,description:string,states:EnvironmentState[]}` (states order staging then production)

`FlagDetail={flag:{key,name,description},state:EnvironmentState,history:Publication[]}` (history newest first, at most100)

`Decision={flagKey:string,environment:Environment,revision:integer|null,value:boolean,reason:'DISABLED'|'ALLOWLIST'|'ROLLOUT'|'OUTSIDE_ROLLOUT'|'UNPUBLISHED'|'FLAG_NOT_FOUND',bucket:integer|null,algorithm:'sha256-u32be-mod10000-v1'}`

`Preview={published:Decision,draft:Decision}` (draft.revision is null, UI label clearly draft)

`AuditItem={id:string,createdAt:string,actor:string,action:'DRAFT_SAVED'|'PUBLISHED'|'ROLLED_BACK',flagKey:string,environment:Environment,revision:integer|null,note:string}`

`Page<T>={items:T[],page:integer,pageSize:25,total:integer}`

## Routes and responses

- GET`/api/health` ->200 `{status:'ok'}` if DB reachable, otherwise503.
- POST`/api/auth/login` `{email,password}` ->200 Session+cookie.
- GET`/api/auth/session` ->200 Session; unauthorized401.
- POST`/api/auth/logout` ->204.
- GET`/api/flags` ->200 `Flag[]` ordered by key; exactly3 registered flags.
- GET`/api/flags/{key}/{environment}` ->200 FlagDetail; unknown404.
- PUT`/api/flags/{key}/{environment}/draft` `{expectedVersion,config}` ->200 EnvironmentState. Saving identical config may return unchanged state without new audit/version. Initial validation failure400. Unknown404, stale409.
- POST`/api/flags/{key}/{environment}/publish` `{expectedVersion,note}` ->200 FlagDetail, including new publication.
- POST`/api/flags/{key}/{environment}/rollback` `{expectedVersion,targetRevision,note}` ->200 FlagDetail.
- POST`/api/flags/{key}/{environment}/preview` `{subjectId}` ->200 Preview, read-only; require session/CSRF/Origin.
- GET`/api/audit?page=0` ->200 Page<AuditItem>, stable newest-first order with ID tiebreaker. Page0-based, exact nonnegative integers only, max page10000; malformed400.
- POST`/client/v1/evaluate/{environment}` `{flagKey,subjectId}` ->200 Decision, scoped Bearer token for that env. Invalid/missing token401; malformed400. Unknown valid key/unpublished safe false200 as defined above. No auth cookies/CSRF needed for bearer API and no CORS wildcard.

## Frontend behavior

- Static hash routes `#/flags`, `#/flags/{key}/{environment}`, `#/playground`, `#/audit`.
- No background polling; visible Refresh reads server state. Dirty edited config and notes survive reads. Stale409/uncertain mutation disables further writes until explicit refresh, with clear feedback. The user reviews the current version before reattempting; no automatic version adoption and resubmit.
- Flag detail labels draft, active revision and environment distinctly. Editing does not affect clients until publication. Rollback explicitly says it preserves draft and appends a new revision. Render sourceRevision in history.
- Percentage input supports at most2 decimal places and converts exactly to integer basis points, avoiding floating rounding. Reject malformed values instead of clamping. Allowlist textarea one subject per line, counts and validation visible. Treat empty as no subjects.
- Playground selects fixed flag and environment plus a synthetic subject ID. Compare published vs draft using actual backend response, explain reason/bucket/threshold. No mock decision or fake checkout response. Explicitly state that preview stores no subject or exposure record and is not a real customer transaction.
- Session expiry returns login while avoiding secret logging; credentials never prefilled. Form state may remain in tab memory; no tokens/passwords in localStorage.
- Error/empty/loading/success states, keyboard focus, labelled forms, min44px actionable controls and locally scrollable tables; no page overflow at320px.

## Verification and ownership

Backend owns backend source, Cargo manifest/lock and backend Dockerfile; frontend owns frontend source/package lock/tests; root owns compose/scripts/CI, final UI gate and images/publication. Docs agent owns README and tutorial/API/operations docs, not this contract/design/final verification/gate.

Use real PostgreSQL tests for concurrent version conflicts, atomic publish rollback (fault injection after revision insertion), environment isolation, immutable revision history, read snapshot consistency, session/token scope and validation. Pure tests need golden vectors for stable bucketing, threshold edges and monotonic cohorts. Run actual-service browser workflows for edits versus active behavior, publish, rollback retaining draft, stale tabs, validation, session and mobile. Root alone runs final antislop gate.

Only one compiler/build/browser-heavy operation at a time on this8GB host. Rust compiler jobs1, release opt-level1/debug0/noLTO, separate app/test DB. Root coordinates heavy slot; do not stop existing PakeAja services.
