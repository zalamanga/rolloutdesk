# Verification record

Application source: [`047f38ecdd479b135d4aae6f72111c0859d1cf5d`](https://github.com/zalamanga/rolloutdesk/commit/047f38ecdd479b135d4aae6f72111c0859d1cf5d).

The initial complete [GitHub Actions run](https://github.com/zalamanga/rolloutdesk/actions/runs/41093099689) passed on 30 October 2026 UTC. Subsequent changes add screenshots, this evidence, and stricter capture instrumentation; they do not change the tested API or interface implementation. The workflow runs again for each main-branch push.

## Executed checks

| Check | CI | Windows/Docker local |
| --- | --- | --- |
| Frontend unit tests | 13 passed | 13 passed |
| TypeScript and production Vite build | Passed | Passed |
| Rust pure evaluator/validation tests | 5 passed | 5 passed |
| Actual PostgreSQL integration tests | 12 passed | 12 passed |
| Actual-service browser workflows | 5 passed, Chromium | 5 passed, Microsoft Edge |
| Independent bearer/bucket probe | Passed | Passed |
| Responsive and enlarged-text checks | 29 passed | 29 passed |
| npm audit at high severity | Passed, zero reported vulnerabilities | Not repeated |

There are **35 named automated tests**: 17 backend, 13 frontend unit and 5 browser. Layout checks and the client probe are additional checks, not extra named tests.

## What the backend tests exercise

- Independent SHA-256 protocol vectors; threshold edges, monotonic cohorts, disabled/allowlist precedence and unpublished behavior.
- Strict JSON, ASCII subjects, exact basis-point boundaries, canonical allowlists, notes, pagination and token digests.
- Real PostgreSQL row contention: competing draft writes or publications have one successful writer.
- Failure injection after revision insertion: failed publication and rollback leave no partial revision, active pointer or audit entry.
- Immutable history, rollback preserving the draft, idempotent seeding and the locked 100-publication budget.
- Repeatable-read detail/audit snapshots during concurrent changes.
- HTTP session login, CSRF, Origin, logout/expiry, persistent bounded login throttling and environment-scoped bearer tokens.

The test harness requires a database named `rolloutdesk_test`. Each database test uses its own schema. The local test service used port 5451, temporary storage and its own Compose project; it was stopped after the run. The application database on port 5450 was not used for backend tests.

## Browser evidence

The five workflows run against the actual API and PostgreSQL, with no replacement API responses:

1. Draft editing stays separate from published client decisions; staging tokens cannot evaluate production.
2. Rollback appends history, retains the saved draft, and keeps operator notes.
3. A stale second tab pauses writes until manual reconciliation without losing edited fields.
4. The real server commits a publication, then the browser discards its response. The UI pauses writes and reconciles instead of automatically publishing again.
5. Mobile input validation, keyboard operation, session expiry, retained edits and audit navigation remain usable.

The fourth workflow intentionally aborts a response after a real commit. It does not substitute a fake successful server response.

The capture helper additionally checks the skip link, both native JSON disclosures, all six flag/environment previews, navigation, environment links, refresh controls, pagination boundaries and logout. It deliberately aborts one initial session request to verify the unavailable state and Retry session check, then returns to the actual API. That expected transport error is recorded separately. It records no uncaught JavaScript errors, unexpected console errors, CSP violations or unexpected HTTP errors. The initial unauthenticated session check returning 401 is expected.

## Screens and layout checks

Four images in [screenshots](screenshots/) were captured from the running local application:

| Image | Dimensions |
| --- | --- |
| `01-login.png` | 1440 x 1000 |
| `02-flags.png` | 1440 x 1183 |
| `03-flag-detail.png` | 1440 x 2220 |
| `04-mobile.png` | 390 x 3654 |

All records are synthetic. The screenshots show actual stored revisions and test-generated audit history. A clean installation starts with unpublished flags, rather than these screenshot values.

The login and four authenticated views were checked at widths 320, 390, 768, 1024 and 1440 pixels. Each authenticated view was also checked with root text enlarged to 200 percent: **25 width checks plus 4 enlarged-text checks**. No page-level horizontal overflow occurred. Wide history/audit tables use their own labelled, keyboard-focusable scroll regions.

The local rendered-text scan found a minimum normal-text ratio of **5.48:1**, above 4.5:1. Separate formula checks give the control border **4.03:1** against white and focus indicator **5.87:1** against the page. Disabled controls were excluded from the automated text scan; their labels and disabled state were also inspected. These checks do not constitute a full assistive-technology or WCAG conformance audit.

## Local build provenance and disk use

The laptop did not finish downloading the Rust build image because that download was slow. The official source Dockerfiles were fully built and tested in CI with Rust 1.99.1 and Nginx 1.30.0.

For local execution, the API and test binaries were downloaded from that successful run and copied, without recompilation, into Debian Bookworm runtime images. The local static interface came from the successful local production build and ran with the already-cached Nginx 1.30.6 image. Both environments passed the same actual-service workflows. This distinction is intentional: no Windows Rust or Visual Studio build-tool installation was required.

Ignored `.local` data contains downloaded binaries, raw check results and local runtime build helpers. None of those files, private `.env` values or browser traces are committed. Start/Test redirect subprocess TEMP/TMP into `.local/tmp` and restore the previous values on exit. Docker's disk-image location remains a separate Docker Desktop setting.

## Limits

This is a single-operator local lab with three fixed flags. It has no streaming SDK, exposure analytics, external clients or multi-tenant administration. Bucketing is not access authorization and does not guarantee an exact percentage in a finite audience. No production load, availability or performance SLA is claimed. See the [API](API.md), [operations](OPERATIONS.md) and [UI review](UX-REVIEW.md) for the exact boundaries and evidence.
