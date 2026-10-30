use crate::{
    api,
    auth::{AppState, token_digest},
    config::Settings,
    evaluation::{bucket, evaluate},
    store::Store,
    types::*,
};
use axum::{
    body::{Body, to_bytes},
    http::{HeaderMap, Method, Request, StatusCode, header},
};
use serde_json::{Value, json};
use std::{
    str::FromStr,
    sync::{Arc, OnceLock},
};
use tokio::sync::Semaphore;
use tokio_postgres::NoTls;
use tower::ServiceExt;
use uuid::Uuid;

const KEY: &str = "checkout-redesign";
const ACTOR: &str = "operator@rolloutdesk.test";
const PASSWORD: &str = "test-only-password-2026-not-for-runtime";
const STAGING_TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PRODUCTION_TOKEN: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn config(enabled: bool, threshold: u16) -> Config {
    Config {
        enabled,
        rollout_basis_points: threshold,
        allowlist: Vec::new(),
    }
}

#[test]
fn bucket_matches_independently_generated_protocol_vectors() {
    assert_eq!(bucket(KEY, "staging", "demo-customer-001"), 327);
    assert_eq!(bucket(KEY, "production", "demo-customer-001"), 3779);
    assert_eq!(bucket("bulk-export", "staging", "demo-customer-001"), 3817);
    assert_eq!(bucket("priority-support", "production", "DEMO_42"), 5994);
    assert_ne!(bucket("ab", "c", "d"), bucket("a", "bc", "d"));
}

#[test]
fn threshold_edges_and_increasing_cohorts_are_stable() {
    for n in 0..500 {
        let subject = format!("synthetic-{n}");
        let cohort = bucket(KEY, "staging", &subject);
        assert!(cohort < 10000);
        assert!(
            !evaluate(
                KEY,
                "staging",
                &subject,
                Some(&config(true, 0)),
                Some(1),
                true
            )
            .value
        );
        assert!(
            evaluate(
                KEY,
                "staging",
                &subject,
                Some(&config(true, 10000)),
                Some(9),
                true
            )
            .value
        );
        let edge = evaluate(
            KEY,
            "staging",
            &subject,
            Some(&config(true, cohort as u16)),
            Some(1),
            true,
        );
        assert!(!edge.value);
        assert!(
            evaluate(
                KEY,
                "staging",
                &subject,
                Some(&config(true, cohort as u16 + 1)),
                Some(2),
                true
            )
            .value
        );
        let low = evaluate(
            KEY,
            "staging",
            &subject,
            Some(&config(true, 2500)),
            Some(3),
            true,
        );
        let high = evaluate(
            KEY,
            "staging",
            &subject,
            Some(&config(true, 7500)),
            Some(4),
            true,
        );
        assert!(!low.value || high.value);
        assert_eq!(low.bucket, high.bucket);
    }
}

#[test]
fn decision_precedence_and_missing_flags_fail_closed() {
    let mut c = config(false, 10000);
    c.allowlist.push("demo".to_owned());
    assert_eq!(
        evaluate(KEY, "staging", "demo", Some(&c), None, true).reason,
        "DISABLED"
    );
    c.enabled = true;
    c.rollout_basis_points = 0;
    assert_eq!(
        evaluate(KEY, "staging", "demo", Some(&c), None, true).reason,
        "ALLOWLIST"
    );
    assert!(!evaluate(KEY, "staging", "Demo", Some(&c), None, true).value);
    let unpublished = evaluate(KEY, "staging", "demo", None, None, true);
    assert_eq!(unpublished.reason, "UNPUBLISHED");
    assert!(unpublished.bucket.is_some());
    let missing = evaluate("missing", "production", "demo", None, None, false);
    assert_eq!(missing.reason, "FLAG_NOT_FOUND");
    assert_eq!(missing.bucket, None);
    assert_eq!(missing.revision, None);
}

#[test]
fn configuration_is_strict_canonical_and_ascii_bounded() {
    let mut c = config(true, 10000);
    c.allowlist = vec!["z".to_owned(), "A_1.-".to_owned()];
    assert_eq!(c.clone().canonical().unwrap().allowlist, vec!["A_1.-", "z"]);
    c.allowlist = vec!["same".to_owned(), "same".to_owned()];
    assert!(c.canonical().is_err());
    for subject in ["", "contains space", "é", "<script>", "a/b"] {
        assert!(crate::evaluation::validate_subject(subject).is_err());
    }
    assert!(crate::evaluation::validate_subject(&"a".repeat(64)).is_ok());
    assert!(crate::evaluation::validate_subject(&"a".repeat(65)).is_err());
    assert!(
        Config {
            enabled: true,
            rollout_basis_points: 10001,
            allowlist: Vec::new()
        }
        .canonical()
        .is_err()
    );
    assert!(
        Config {
            enabled: true,
            rollout_basis_points: 0,
            allowlist: (0..21).map(|i| format!("s{i}")).collect()
        }
        .canonical()
        .is_err()
    );
    for invalid in [
        r#"{"enabled":1,"rolloutBasisPoints":0,"allowlist":[]}"#,
        r#"{"enabled":true,"rolloutBasisPoints":1.5,"allowlist":[]}"#,
        r#"{"enabled":true,"rolloutBasisPoints":-1,"allowlist":[]}"#,
        r#"{"enabled":true,"rolloutBasisPoints":0,"allowlist":[],"other":true}"#,
        r#"{"enabled":true,"rolloutBasisPoints":0,"allowlist":[]} false"#,
    ] {
        assert!(api::decode_json::<Config>(invalid.as_bytes()).is_err());
    }
}

#[test]
fn note_pagination_and_digest_validation_have_exact_boundaries() {
    assert_eq!(validate_note("  0123456789  ").unwrap(), "0123456789");
    assert!(validate_note(&"é".repeat(500)).is_ok());
    assert!(validate_note(&"é".repeat(501)).is_err());
    assert!(validate_note("too short").is_err());
    assert_eq!(api::parse_page(None).unwrap(), 0);
    assert_eq!(api::parse_page(Some("page=10000")).unwrap(), 10000);
    for invalid in [
        "",
        "page=-1",
        "page=1.0",
        "page=1e2",
        "page=10001",
        "page=1&page=2",
        "page=+1",
        "page=%31",
        "other=1",
    ] {
        assert!(api::parse_page(Some(invalid)).is_err());
    }
    assert!(crate::config::decode_digest(&"a".repeat(64)).is_ok());
    assert!(crate::config::decode_digest(&"é".repeat(32)).is_err());
    assert!(crate::config::decode_digest(&"g".repeat(64)).is_err());
}

struct Fixture {
    store: Store,
    schema: String,
    admin: tokio_postgres::Client,
}

impl Fixture {
    async fn new() -> Option<Self> {
        let url = match std::env::var("ROLLOUT_TEST_DB_URL") {
            Ok(url) => url,
            Err(_) if std::env::var("REQUIRE_DB_TESTS").as_deref() == Ok("1") => {
                panic!("REQUIRE_DB_TESTS=1 requires ROLLOUT_TEST_DB_URL.")
            }
            Err(_) => {
                eprintln!(
                    "SKIP real PostgreSQL test: ROLLOUT_TEST_DB_URL is unset; set REQUIRE_DB_TESTS=1 for required integration verification."
                );
                return None;
            }
        };
        let mut pg =
            tokio_postgres::Config::from_str(&url).expect("Invalid isolated test database URL.");
        assert_eq!(
            pg.get_dbname(),
            Some("rolloutdesk_test"),
            "Tests refuse any database except rolloutdesk_test."
        );
        let (admin, connection) = pg
            .connect(NoTls)
            .await
            .expect("Isolated PostgreSQL unavailable.");
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let schema = format!("test_{}", Uuid::new_v4().simple());
        admin
            .batch_execute(&format!("CREATE SCHEMA {schema}"))
            .await
            .unwrap();
        pg.options(&format!("-c search_path={schema}"));
        let store = Store::from_config(pg).unwrap();
        store.migrate().await.unwrap();
        static HASH: OnceLock<String> = OnceLock::new();
        let hash = tokio::task::spawn_blocking(|| {
            HASH.get_or_init(|| bcrypt::hash(PASSWORD, 12).unwrap())
                .clone()
        })
        .await
        .unwrap();
        store.seed(&hash).await.unwrap();
        Some(Self {
            store,
            schema,
            admin,
        })
    }
    fn state(&self) -> AppState {
        AppState {
            store: self.store.clone(),
            settings: Arc::new(Settings {
                database_url: String::new(),
                demo_password: PASSWORD.to_owned(),
                origin: "http://127.0.0.1:8098".to_owned(),
                cookie_secure: false,
                staging_digest: token_digest(STAGING_TOKEN.as_bytes()),
                production_digest: token_digest(PRODUCTION_TOKEN.as_bytes()),
            }),
            crypto: Arc::new(Semaphore::new(2)),
            dummy_hash: Arc::new(bcrypt_hash()),
        }
    }
    async fn finish(self) {
        self.store.pool.close();
        self.admin
            .batch_execute(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .await
            .unwrap();
    }
}
fn bcrypt_hash() -> String {
    // A fixed valid hash is used only as the nonexistent-user timing fallback in tests.
    "$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxRpSCIXqB3kN4B7TDr4D6wS5eK".to_owned()
}

async fn save(
    store: &Store,
    key: &str,
    env: &str,
    version: i64,
    config: Config,
) -> EnvironmentState {
    store
        .save_draft(
            key,
            env,
            DraftInput {
                expected_version: version,
                config,
            },
            ACTOR,
        )
        .await
        .unwrap()
}
async fn publish(store: &Store, key: &str, env: &str, version: i64) -> FlagDetail {
    store
        .publish(
            key,
            env,
            PublishInput {
                expected_version: version,
                note: "Publish synthetic test settings".to_owned(),
            },
            ACTOR,
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn pg_seed_is_idempotent_and_never_resets_operator() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let before: String = f
        .store
        .pool
        .get()
        .await
        .unwrap()
        .query_one("SELECT password_hash FROM users", &[])
        .await
        .unwrap()
        .get(0);
    f.store.seed("replacement-must-not-be-used").await.unwrap();
    f.store.migrate().await.unwrap();
    let row = f
        .store
        .pool
        .get()
        .await
        .unwrap()
        .query_one("SELECT COUNT(*),MIN(password_hash) FROM users", &[])
        .await
        .unwrap();
    assert_eq!(row.get::<_, i64>(0), 1);
    assert_eq!(row.get::<_, String>(1), before);
    let flags = f.store.flags().await.unwrap();
    assert_eq!(flags.len(), 3);
    assert_eq!(flags[0].key, "bulk-export");
    for flag in flags {
        assert_eq!(
            flag.states
                .iter()
                .map(|s| s.environment.as_str())
                .collect::<Vec<_>>(),
            vec!["staging", "production"]
        );
        for s in flag.states {
            assert_eq!(s.version, 1);
            assert!(s.active.is_none());
        }
    }
    f.finish().await;
}

#[tokio::test]
async fn pg_draft_publish_and_environment_isolation_are_real() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    assert_eq!(
        f.store
            .client_decision(KEY, "staging", "demo")
            .await
            .unwrap()
            .reason,
        "UNPUBLISHED"
    );
    let mut c = config(true, 10000);
    c.allowlist = vec!["z".to_owned(), "a".to_owned()];
    let s = save(&f.store, KEY, "staging", 1, c).await;
    assert_eq!(s.version, 2);
    assert_eq!(s.draft.allowlist, vec!["a", "z"]);
    assert!(s.active.is_none());
    let preview = f.store.preview(KEY, "staging", "demo").await.unwrap();
    assert!(preview.draft.value);
    assert!(!preview.published.value);
    assert_eq!(preview.draft.revision, None);
    let published = publish(&f.store, KEY, "staging", 2).await;
    assert_eq!(published.state.version, 3);
    assert_eq!(published.state.active.unwrap().revision, 1);
    let changed = save(&f.store, KEY, "staging", 3, config(false, 0)).await;
    assert_eq!(changed.version, 4);
    assert!(
        f.store
            .client_decision(KEY, "staging", "demo")
            .await
            .unwrap()
            .value
    );
    assert_eq!(
        f.store
            .detail(KEY, "production")
            .await
            .unwrap()
            .state
            .version,
        1
    );
    assert_eq!(
        f.store
            .client_decision(KEY, "production", "demo")
            .await
            .unwrap()
            .reason,
        "UNPUBLISHED"
    );
    assert_eq!(
        f.store
            .client_decision("unknown-registered-style", "staging", "demo")
            .await
            .unwrap()
            .reason,
        "FLAG_NOT_FOUND"
    );
    assert_eq!(f.store.audit(0).await.unwrap().total, 3);
    f.finish().await;
}

#[tokio::test]
async fn pg_concurrent_draft_writes_and_publications_have_one_winner() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let a = f.store.save_draft(
        KEY,
        "staging",
        DraftInput {
            expected_version: 1,
            config: config(true, 2500),
        },
        ACTOR,
    );
    let b = f.store.save_draft(
        KEY,
        "staging",
        DraftInput {
            expected_version: 1,
            config: config(true, 7500),
        },
        ACTOR,
    );
    let (a, b) = tokio::join!(a, b);
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let error = a.err().or_else(|| b.err()).unwrap();
    assert_eq!(error.code, "VERSION_CONFLICT");
    let a = f.store.publish(
        KEY,
        "staging",
        PublishInput {
            expected_version: 2,
            note: "Concurrent publication alpha".to_owned(),
        },
        ACTOR,
    );
    let b = f.store.publish(
        KEY,
        "staging",
        PublishInput {
            expected_version: 2,
            note: "Concurrent publication beta".to_owned(),
        },
        ACTOR,
    );
    let (a, b) = tokio::join!(a, b);
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert_eq!(
        a.err().or_else(|| b.err()).unwrap().status,
        StatusCode::CONFLICT
    );
    let detail = f.store.detail(KEY, "staging").await.unwrap();
    assert_eq!(detail.history.len(), 1);
    assert_eq!(detail.state.version, 3);
    assert_eq!(f.store.audit(0).await.unwrap().total, 2);
    f.finish().await;
}

#[tokio::test]
async fn pg_failed_publish_and_rollback_leave_no_partial_state_or_audit() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let result = f
        .store
        .revise(
            KEY,
            "staging",
            1,
            None,
            "Injected publication failure",
            ACTOR,
            true,
        )
        .await;
    assert!(result.is_err());
    let detail = f.store.detail(KEY, "staging").await.unwrap();
    assert_eq!(detail.state.version, 1);
    assert!(detail.history.is_empty());
    assert_eq!(f.store.audit(0).await.unwrap().total, 0);
    publish(&f.store, KEY, "staging", 1).await;
    save(&f.store, KEY, "staging", 2, config(true, 10000)).await;
    publish(&f.store, KEY, "staging", 3).await;
    let result = f
        .store
        .revise(
            KEY,
            "staging",
            4,
            Some(1),
            "Injected rollback failure",
            ACTOR,
            true,
        )
        .await;
    assert!(result.is_err());
    let detail = f.store.detail(KEY, "staging").await.unwrap();
    assert_eq!(detail.state.version, 4);
    assert_eq!(detail.history.len(), 2);
    assert_eq!(detail.state.active.unwrap().revision, 2);
    assert_eq!(f.store.audit(0).await.unwrap().total, 3);
    f.finish().await;
}

#[tokio::test]
async fn pg_rollback_appends_copy_preserves_draft_and_history_is_immutable() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    publish(&f.store, KEY, "staging", 1).await;
    save(&f.store, KEY, "staging", 2, config(true, 10000)).await;
    publish(&f.store, KEY, "staging", 3).await;
    save(&f.store, KEY, "staging", 4, config(true, 3000)).await;
    let detail = f
        .store
        .rollback(
            KEY,
            "staging",
            RollbackInput {
                expected_version: 5,
                target_revision: 1,
                note: "Restore disabled synthetic configuration".to_owned(),
            },
            ACTOR,
        )
        .await
        .unwrap();
    assert_eq!(detail.state.version, 6);
    assert_eq!(detail.state.draft.rollout_basis_points, 3000);
    let active = detail.state.active.unwrap();
    assert_eq!(active.revision, 3);
    assert_eq!(active.kind, "ROLLBACK");
    assert_eq!(active.source_revision, Some(1));
    assert_eq!(active.config, Config::default());
    assert_eq!(
        detail
            .history
            .iter()
            .map(|p| p.revision)
            .collect::<Vec<_>>(),
        vec![3, 2, 1]
    );
    let c = f.store.pool.get().await.unwrap();
    assert!(
        c.execute("UPDATE publications SET note='illegal history edit'", &[])
            .await
            .is_err()
    );
    assert!(c.execute("DELETE FROM publications", &[]).await.is_err());
    assert!(c.execute("UPDATE flag_states SET active_revision=3 WHERE flag_key=$1 AND environment='production'", &[&KEY]).await.is_err());
    drop(c);
    let result = f
        .store
        .rollback(
            KEY,
            "production",
            RollbackInput {
                expected_version: 1,
                target_revision: 3,
                note: "Cross environment target rejected".to_owned(),
            },
            ACTOR,
        )
        .await;
    assert_eq!(result.unwrap_err().status, StatusCode::NOT_FOUND);
    f.finish().await;
}

#[tokio::test]
async fn pg_noops_invalid_inputs_and_stale_versions_create_no_history() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let unchanged = save(&f.store, KEY, "staging", 1, Config::default()).await;
    assert_eq!(unchanged.version, 1);
    assert_eq!(f.store.audit(0).await.unwrap().total, 0);
    publish(&f.store, KEY, "staging", 1).await;
    let error = f
        .store
        .publish(
            KEY,
            "staging",
            PublishInput {
                expected_version: 2,
                note: "No change should be rejected".to_owned(),
            },
            ACTOR,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "NO_CHANGE");
    let error = f
        .store
        .save_draft(
            KEY,
            "staging",
            DraftInput {
                expected_version: 1,
                config: config(true, 50),
            },
            ACTOR,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "VERSION_CONFLICT");
    assert!(
        f.store
            .publish(
                KEY,
                "staging",
                PublishInput {
                    expected_version: 2,
                    note: "short".to_owned()
                },
                ACTOR
            )
            .await
            .is_err()
    );
    assert_eq!(
        f.store.detail(KEY, "staging").await.unwrap().history.len(),
        1
    );
    assert_eq!(f.store.audit(0).await.unwrap().total, 1);
    f.finish().await;
}

#[tokio::test]
async fn pg_publication_budget_is_locked_and_enforced_at_100() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let mut version = 1;
    for revision in 1..=100 {
        let state = save(
            &f.store,
            KEY,
            "staging",
            version,
            config(true, if revision % 2 == 0 { 10000 } else { 0 }),
        )
        .await;
        let detail = publish(&f.store, KEY, "staging", state.version).await;
        version = detail.state.version;
        assert_eq!(detail.state.active.unwrap().revision, revision);
    }
    let state = save(&f.store, KEY, "staging", version, config(false, 0)).await;
    let error = f
        .store
        .publish(
            KEY,
            "staging",
            PublishInput {
                expected_version: state.version,
                note: "Publication budget must be enforced".to_owned(),
            },
            ACTOR,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "REVISION_LIMIT");
    let detail = f.store.detail(KEY, "staging").await.unwrap();
    assert_eq!(detail.history.len(), 100);
    assert_eq!(detail.state.version, state.version);
    f.finish().await;
}

#[tokio::test]
async fn pg_detail_reads_remain_coherent_during_concurrent_publication() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let store = f.store.clone();
    let writer = tokio::spawn(async move {
        let mut version = 1;
        for n in 0..20 {
            let s = save(
                &store,
                KEY,
                "staging",
                version,
                config(true, if n % 2 == 0 { 10000 } else { 0 }),
            )
            .await;
            version = publish(&store, KEY, "staging", s.version)
                .await
                .state
                .version;
            tokio::task::yield_now().await;
        }
    });
    for _ in 0..100 {
        let d = f.store.detail(KEY, "staging").await.unwrap();
        match d.state.active {
            None => assert!(d.history.is_empty()),
            Some(active) => {
                assert_eq!(active.revision, d.history[0].revision);
                assert_eq!(active.config, d.history[0].config);
                assert_eq!(d.history.len(), active.revision as usize);
            }
        }
        tokio::task::yield_now().await;
    }
    writer.await.unwrap();
    f.finish().await;
}

async fn request(
    app: axum::Router,
    method: Method,
    path: &str,
    cookie: Option<&str>,
    csrf: Option<&str>,
    origin: Option<&str>,
    bearer: Option<&str>,
    body: &str,
) -> (StatusCode, HeaderMap, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(cookie) = cookie {
        builder = builder.header(header::COOKIE, cookie);
    }
    if let Some(csrf) = csrf {
        builder = builder.header("x-csrf-token", csrf);
    }
    if let Some(origin) = origin {
        builder = builder.header(header::ORIGIN, origin);
    }
    if let Some(bearer) = bearer {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {bearer}"));
    }
    let response = app
        .oneshot(builder.body(Body::from(body.to_owned())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), 128 * 1024).await.unwrap();
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).expect("All API errors and data must be JSON.")
    };
    (status, headers, body)
}

#[tokio::test]
async fn pg_http_auth_csrf_strict_json_logout_and_expiry_are_enforced() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let state = f.state();
    let app = api::router(state.clone());
    let (status, _, _) = request(
        app.clone(),
        Method::GET,
        "/api/flags",
        None,
        None,
        None,
        None,
        "",
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let body = json!({"email":ACTOR,"password":PASSWORD}).to_string();
    let (status, _, _) = request(
        app.clone(),
        Method::POST,
        "/api/auth/login",
        None,
        None,
        Some("http://localhost:8098"),
        None,
        &body,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, headers, body) = request(
        app.clone(),
        Method::POST,
        "/api/auth/login",
        None,
        None,
        Some("http://127.0.0.1:8098"),
        None,
        &body,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let set_cookie = headers.get(header::SET_COOKIE).unwrap().to_str().unwrap();
    assert!(
        set_cookie.contains("HttpOnly")
            && set_cookie.contains("SameSite=Lax")
            && set_cookie.contains("Max-Age=43200")
    );
    let cookie = set_cookie.split(';').next().unwrap().to_owned();
    let csrf = body["csrfToken"].as_str().unwrap();
    assert_eq!(body["user"]["email"], ACTOR);
    assert!(!body.to_string().contains("password"));
    let draft_path = format!("/api/flags/{KEY}/staging/draft");
    let valid = r#"{"expectedVersion":1,"config":{"enabled":true,"rolloutBasisPoints":1234,"allowlist":[]}}"#;
    for (origin, token) in [
        (None, Some(csrf)),
        (Some("http://127.0.0.1:8098"), None),
        (Some("http://127.0.0.1:8098"), Some("wrong-token")),
    ] {
        assert_eq!(
            request(
                app.clone(),
                Method::PUT,
                &draft_path,
                Some(&cookie),
                token,
                origin,
                None,
                valid
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }
    for invalid in [
        valid.replace("1234", "1.5"),
        valid.replace("true", "1"),
        valid.replace("\"expectedVersion\":1", "\"expectedVersion\":1.0"),
        format!("{valid} false"),
        valid.replace(
            "\"expectedVersion\":1",
            "\"unexpected\":1,\"expectedVersion\":1",
        ),
    ] {
        assert_eq!(
            request(
                app.clone(),
                Method::PUT,
                &draft_path,
                Some(&cookie),
                Some(csrf),
                Some("http://127.0.0.1:8098"),
                None,
                &invalid
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    let large = json!({"subjectId":"x".repeat(17000)}).to_string();
    assert_eq!(
        request(
            app.clone(),
            Method::POST,
            &format!("/api/flags/{KEY}/staging/preview"),
            Some(&cookie),
            Some(csrf),
            Some("http://127.0.0.1:8098"),
            None,
            &large
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (status, _, saved) = request(
        app.clone(),
        Method::PUT,
        &draft_path,
        Some(&cookie),
        Some(csrf),
        Some("http://127.0.0.1:8098"),
        None,
        valid,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["version"], 2);
    assert_eq!(
        request(
            app.clone(),
            Method::GET,
            "/api/audit?page=1.0",
            Some(&cookie),
            None,
            None,
            None,
            ""
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(
            app.clone(),
            Method::POST,
            "/api/auth/logout",
            Some(&cookie),
            Some(csrf),
            Some("http://127.0.0.1:8098"),
            None,
            ""
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(
            app.clone(),
            Method::GET,
            "/api/auth/session",
            Some(&cookie),
            None,
            None,
            None,
            ""
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let (session, cookie_header) = state
        .login(
            LoginInput {
                email: ACTOR.to_owned(),
                password: PASSWORD.to_owned(),
            },
            "expiry-test",
        )
        .await
        .unwrap();
    let expired_cookie = cookie_header.to_str().unwrap().split(';').next().unwrap();
    f.store
        .pool
        .get()
        .await
        .unwrap()
        .execute(
            "UPDATE sessions SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE user_id=$1",
            &[&session.user.id],
        )
        .await
        .unwrap();
    assert_eq!(
        request(
            app.clone(),
            Method::GET,
            "/api/auth/session",
            Some(expired_cookie),
            None,
            None,
            None,
            ""
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    f.finish().await;
}

#[tokio::test]
async fn pg_client_tokens_are_environment_scoped_and_preview_is_read_only() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    save(&f.store, KEY, "staging", 1, config(true, 10000)).await;
    publish(&f.store, KEY, "staging", 2).await;
    let before = f.store.audit(0).await.unwrap().total;
    let app = api::router(f.state());
    let body = json!({"flagKey":KEY,"subjectId":"synthetic-customer"}).to_string();
    for token in [None, Some(PRODUCTION_TOKEN), Some("wrong")] {
        let (status, _, error) = request(
            app.clone(),
            Method::POST,
            "/client/v1/evaluate/staging",
            None,
            None,
            None,
            token,
            &body,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(error["code"], "UNAUTHORIZED");
    }
    let (status, headers, decision) = request(
        app.clone(),
        Method::POST,
        "/client/v1/evaluate/staging",
        None,
        None,
        None,
        Some(STAGING_TOKEN),
        &body,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(decision["value"], true);
    assert_eq!(decision["revision"], 1);
    assert!(headers.get("access-control-allow-origin").is_none());
    assert!(!decision.to_string().contains("synthetic-customer"));
    assert!(!decision.to_string().contains(STAGING_TOKEN));
    let (_, _, production) = request(
        app.clone(),
        Method::POST,
        "/client/v1/evaluate/production",
        None,
        None,
        None,
        Some(PRODUCTION_TOKEN),
        &body,
    )
    .await;
    assert_eq!(production["reason"], "UNPUBLISHED");
    let missing =
        json!({"flagKey":"missing-valid-key","subjectId":"synthetic-customer"}).to_string();
    let (_, _, decision) = request(
        app,
        Method::POST,
        "/client/v1/evaluate/staging",
        None,
        None,
        None,
        Some(STAGING_TOKEN),
        &missing,
    )
    .await;
    assert_eq!(decision["reason"], "FLAG_NOT_FOUND");
    assert!(decision["bucket"].is_null());
    for _ in 0..5 {
        f.store
            .preview(KEY, "staging", "synthetic-customer")
            .await
            .unwrap();
    }
    assert_eq!(f.store.audit(0).await.unwrap().total, before);
    f.finish().await;
}

#[tokio::test]
async fn pg_login_throttle_is_persistent_and_bounded() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let state = f.state();
    for _ in 0..10 {
        let error = state
            .login(
                LoginInput {
                    email: ACTOR.to_owned(),
                    password: String::new(),
                },
                "same-proxy-address",
            )
            .await
            .unwrap_err();
        assert_eq!(error.status, StatusCode::UNAUTHORIZED);
    }
    let error = f
        .state()
        .login(
            LoginInput {
                email: ACTOR.to_owned(),
                password: String::new(),
            },
            "same-proxy-address",
        )
        .await
        .unwrap_err();
    assert_eq!(error.status, StatusCode::TOO_MANY_REQUESTS);
    let c = f.store.pool.get().await.unwrap();
    c.execute("UPDATE login_throttle SET window_started=clock_timestamp()-INTERVAL '6 minutes',last_seen=clock_timestamp()-INTERVAL '6 minutes'", &[]).await.unwrap();
    drop(c);
    assert_eq!(
        state
            .login(
                LoginInput {
                    email: ACTOR.to_owned(),
                    password: String::new()
                },
                "same-proxy-address"
            )
            .await
            .unwrap_err()
            .status,
        StatusCode::UNAUTHORIZED
    );
    let c = f.store.pool.get().await.unwrap();
    c.execute("DELETE FROM login_throttle", &[]).await.unwrap();
    c.execute("INSERT INTO login_throttle(remote_digest,attempts,window_started,last_seen) SELECT decode(repeat(lpad(to_hex(g),32,'0'),2),'hex'),1,clock_timestamp(),clock_timestamp() FROM generate_series(1,256) g", &[]).await.unwrap();
    drop(c);
    assert_eq!(
        state
            .login(
                LoginInput {
                    email: ACTOR.to_owned(),
                    password: String::new()
                },
                "new-address-capacity"
            )
            .await
            .unwrap_err()
            .status,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        f.store
            .pool
            .get()
            .await
            .unwrap()
            .query_one("SELECT COUNT(*) FROM login_throttle", &[])
            .await
            .unwrap()
            .get::<_, i64>(0),
        256
    );
    f.finish().await;
}

#[tokio::test]
async fn pg_audit_pagination_is_snapshot_consistent_and_stably_ordered() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let mut version = 1;
    for n in 0..30 {
        version = save(&f.store, KEY, "staging", version, config(true, n + 1))
            .await
            .version;
    }
    f.store
        .pool
        .get()
        .await
        .unwrap()
        .execute("UPDATE audit SET created_at='2026-01-01T00:00:00Z'", &[])
        .await
        .unwrap();
    let a = f.store.audit(0).await.unwrap();
    let b = f.store.audit(1).await.unwrap();
    assert_eq!(a.total, 30);
    assert_eq!(a.items.len(), 25);
    assert_eq!(b.items.len(), 5);
    let ids: Vec<Uuid> = a.items.iter().chain(b.items.iter()).map(|i| i.id).collect();
    assert!(ids.windows(2).all(|p| p[0] > p[1]));
    assert!(f.store.audit(10000).await.unwrap().items.is_empty());
    f.finish().await;
}
