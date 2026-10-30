# Local operations

The supported workflow uses PowerShell, Node.js 22 with npm, and Docker Desktop with Linux containers. Node runs the private-configuration helper and local frontend checks. Rust compiles inside the container, and Nginx serves the static React build. Native Windows MSVC tooling is not required.

## Start and stop

From the repository root:

```powershell
.\scripts\Init.ps1
.\scripts\Start.ps1
```

`Start.ps1` also initializes missing local configuration. Open **http://127.0.0.1:8098** and read the local operator credentials in `.local/LOCAL-CREDENTIALS.txt`. Keep the exact host and port because origin checks distinguish `localhost` from `127.0.0.1`.

After the images exist and the source has not changed:

```powershell
.\scripts\Start.ps1 -NoBuild
```

Stop the stack:

```powershell
.\scripts\Stop.ps1
```

Normal stop removes containers and the Compose network but keeps the application database volume. It does not erase publication history, drafts or the seeded operator. Build source changes before using `-NoBuild` again.

## Ports and data boundaries

| Service | Host address | Purpose |
| --- | --- | --- |
| Web | `127.0.0.1:8098` | UI plus proxied operator and client API. |
| Application PostgreSQL | `127.0.0.1:5450` | Persistent application database. |
| Test PostgreSQL | `127.0.0.1:5451` | Separate test-only database while tests run. |
| Rust API | Container port 8080 | Internal Compose service, not directly published. |

Tests must never point at the application database. Their setup creates and manipulates test data, including concurrency and rollback failure scenarios. The test script uses its separate database and cleans up its own temporary stack.

## Private configuration

`Init.ps1` creates private random credentials when `.env` is absent. It preserves existing configuration. `.env.example` lists the required settings without real credentials. Git ignores `.env`, `.local`, dependencies, build output and browser traces.

The private local file contains the operator password, database passwords and separate client tokens. The scripts derive SHA-256 token digests for runtime API configuration. The browser receives neither token, and the API does not need raw client tokens in its environment.

The operator is seeded only when the users table is empty. Editing the seed password in `.env` does not change an existing database password hash. It can instead make the displayed local credential differ from the stored one. Retain the original private configuration for a retained volume. This app does not provide password-reset or token-rotation workflows.

Do not paste `.env`, cookie values, CSRF tokens or client tokens into an issue, README or screenshot. Use synthetic subject IDs; preview and client evaluation intentionally keep no subject/exposure history.

## Call the client API

With the application running:

```powershell
.\scripts\Client-Check.ps1 -Environment staging -FlagKey checkout-redesign -SubjectId demo-alice
.\scripts\Client-Check.ps1 -Environment production -FlagKey checkout-redesign -SubjectId demo-alice
```

The script chooses the matching private token in memory and prints the decision. If a flag is unpublished, `false` with `UNPUBLISHED` is expected. Saving a draft alone does not change these responses.

A staging token is not accepted for production. Use this separation to demonstrate the authentication boundary rather than exposing tokens in frontend code.

## Verification

```powershell
.\scripts\Test.ps1
```

The workflow builds/tests the Rust backend in Docker against the isolated PostgreSQL instance and runs the frontend checks. The repository's [verification record](VERIFICATION.md) gives the commands and outcomes actually observed.

For real browser workflows, start the application first, then run:

```powershell
.\scripts\Test.ps1 -WithBrowser
```

Browser tests create synthetic drafts, publications and audit entries in the local application database. They are an integration demonstration, not a substitute for keeping real business data separate. Keep one compiler or browser-heavy job running at a time on a low-memory laptop.

On Windows, the browser checks use the installed Microsoft Edge by default. To use a Playwright-managed Chromium instead, install it deliberately and select that channel from the `frontend` directory:

```powershell
$env:ROLLOUT_BROWSER_CHANNEL = 'chromium'
npx playwright install chromium
```

Then return to the repository root and run `Test.ps1 -WithBrowser`. A browser download consumes disk space; use the installed Edge workflow if it is already available. CI installs Chromium explicitly. Browser checks are sequential and share the local sign-in budget, so avoid running another login-heavy demo at the same time.

The application permits at most 100 publications for each flag/environment. Repeated demos and browser runs consume that history. There is no delete-history endpoint. If the lab reaches its limit, retain/export anything needed and use a separate fresh lab database through a deliberate reset; normal restart preserves the history and limit.

## Build output and disk space

The application volume is `rolloutdesk_pgdata`. Keep it to retain operator credentials, drafts, publications and audit history. Docker stores images and BuildKit caches in Docker Desktop's configured disk image location, which can differ from the source repository's drive. Choose that location independently in Docker Desktop settings; placing this checkout on D: does not move Docker's data automatically.

After configuration initialization, `Start.ps1` and `Test.ps1` set process-level `TEMP` and `TMP` to this checkout's ignored `.local/tmp` while their build/test commands run. They restore the previous values on exit. With the checkout on D:, those subprocess temporary files stay on D:. The scripts do not change the global Windows TEMP setting.

`Test.ps1` also directs npm's cache to `.local/npm-cache`; frontend dependencies and `dist` stay in this checkout. Existing VS Code extensions, Codex history and other tools keep their own storage locations.

Do not run a global Docker prune to free space for this project. It can affect unrelated applications. Inspect images, caches and volumes first, and remove only data you have identified as disposable.

## Inspect PostgreSQL

A PostgreSQL UI can connect to the loopback application port using the local database name, user and password from private configuration. Choose **PostgreSQL**, host **127.0.0.1**, port **5450**. From a different Compose service, the hostname is the database service name and its internal port is 5432, not the host's 5450.

Read the schema and use a read-only query to inspect drafts, publications and audit. Editing tables directly can bypass the application's invariants. Use the UI/API to save, publish and roll back during a demo.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Docker command cannot connect | Start Docker Desktop and select Linux containers. |
| Port 8098 is occupied | Identify the owner before starting this stack. Do not stop an unrelated application. |
| UI loads but login/mutation returns 403 | Open the exact `http://127.0.0.1:8098` origin and sign in again. |
| Login fails after changing `.env` | A retained database keeps the original seeded password hash; initialization is not a password-reset command. |
| Login returns 429 | The local proxy shares a sign-in budget of 10 attempts per five-minute window, including successful logins. Wait for that window instead of repeatedly retrying. |
| Client returns `UNPUBLISHED` | Publish the saved draft for that specific environment. |
| Draft preview differs from client result | This is expected until the draft is published; check the selected environment and active revision. |
| Write returns 409 or a network error | Refresh explicitly, inspect the current version/revision and preserve your notes before retrying. |
| Client returns 401 | Confirm the token matches staging or production. Never fix this by inserting the token into browser code. |
| Tests cannot bind 5451 | Check whether an earlier owned test stack is still running; do not reuse the application database. |
| Revision limit reached | The lab retains at most 100 publications per pair; restarting containers cannot reclaim revision slots. |

Docker logs are useful for service startup and fixed error categories. Application logs must not contain raw subject input, passwords, bearer values, session cookies or CSRF tokens.

## Deployment limits

This local setup binds exposed ports to loopback and uses HTTP. It has one operator and two fixed bearer tokens. It supplies no registration, role policy, secret rotation UI, high-availability plan, external backup service, streaming SDK or exposure collection. Treat public hosting as a separate engineering task requiring TLS, identity, secrets and operational review.
