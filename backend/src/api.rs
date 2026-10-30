use crate::{
    auth::{AppState, SessionActor},
    error::{AppError, Result},
    types::*,
};
use axum::{
    Json, Router,
    body::to_bytes,
    extract::{ConnectInfo, Extension, FromRequest, Path, RawQuery, Request, State},
    http::{Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use serde::de::DeserializeOwned;
use serde_json::json;
use std::net::SocketAddr;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/auth/login", post(login))
        .route("/api/auth/session", get(session))
        .route("/api/auth/logout", post(logout))
        .route("/api/flags", get(flags))
        .route("/api/flags/{key}/{environment}", get(detail))
        .route("/api/flags/{key}/{environment}/draft", put(save_draft))
        .route("/api/flags/{key}/{environment}/publish", post(publish))
        .route("/api/flags/{key}/{environment}/rollback", post(rollback))
        .route("/api/flags/{key}/{environment}/preview", post(preview))
        .route("/api/audit", get(audit))
        .route("/client/v1/evaluate/{environment}", post(client_evaluate))
        .fallback(|| async { AppError::not_found() })
        .method_not_allowed_fallback(|| async {
            (
                StatusCode::METHOD_NOT_ALLOWED,
                Json(json!({"code":"METHOD_NOT_ALLOWED","message":"Method is not supported."})),
            )
        })
        .layer(middleware::from_fn_with_state(state.clone(), security))
        .with_state(state)
}

async fn security(State(state): State<AppState>, mut request: Request, next: Next) -> Response {
    let remote = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(remote)| remote.ip().to_string())
        .unwrap_or_else(|| "local-test-client".to_owned());
    request.extensions_mut().insert(RemoteAddress(remote));
    let path = request.uri().path();
    let public_health = path == "/api/health" && request.method() == Method::GET;
    let public_login = path == "/api/auth/login" && request.method() == Method::POST;
    if let Some(environment) = path.strip_prefix("/client/v1/evaluate/") {
        if let Err(error) = state.require_client(request.headers(), environment) {
            return error.into_response();
        }
    } else if public_login {
        if let Err(error) = state.require_origin(request.headers()) {
            return error.into_response();
        }
    } else if path.starts_with("/api") && !public_health {
        let actor = match state.session(request.headers()).await {
            Ok(actor) => actor,
            Err(error) => return error.into_response(),
        };
        if request.method() != Method::GET && request.method() != Method::HEAD {
            if let Err(error) = state.require_csrf(request.headers(), &actor) {
                return error.into_response();
            }
        }
        request.extensions_mut().insert(actor);
    }
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    response
}

#[derive(Clone)]
struct RemoteAddress(String);

pub struct StrictJson<T>(pub T);
impl<S, T> FromRequest<S> for StrictJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = AppError;
    async fn from_request(req: Request, _: &S) -> Result<Self> {
        if req
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(';').next())
            .map(str::trim)
            != Some("application/json")
        {
            return Err(AppError::bad("Request must use application/json."));
        }
        let bytes = to_bytes(req.into_body(), 16 * 1024)
            .await
            .map_err(|_| AppError::bad("Request body must not exceed 16 KiB."))?;
        decode_json(&bytes).map(Self)
    }
}
pub fn decode_json<T: DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    serde_json::from_slice(bytes).map_err(|_| AppError::bad("JSON fields or values are invalid."))
}

async fn health(State(state): State<AppState>) -> Result<Json<serde_json::Value>> {
    if !state.store.healthy().await {
        return Err(AppError::unavailable());
    }
    Ok(Json(json!({"status":"ok"})))
}
async fn login(
    State(state): State<AppState>,
    Extension(remote): Extension<RemoteAddress>,
    StrictJson(input): StrictJson<LoginInput>,
) -> Result<Response> {
    let (session, cookie) = state.login(input, &remote.0).await?;
    Ok(([(header::SET_COOKIE, cookie)], Json(session)).into_response())
}
async fn session(Extension(actor): Extension<SessionActor>) -> Json<Session> {
    Json(actor.session)
}
async fn logout(
    State(state): State<AppState>,
    Extension(actor): Extension<SessionActor>,
) -> Result<Response> {
    let cookie = state.logout(&actor).await?;
    Ok((StatusCode::NO_CONTENT, [(header::SET_COOKIE, cookie)]).into_response())
}
async fn flags(State(state): State<AppState>) -> Result<Json<Vec<Flag>>> {
    Ok(Json(state.store.flags().await?))
}
async fn detail(
    State(state): State<AppState>,
    Path((key, env)): Path<(String, String)>,
) -> Result<Json<FlagDetail>> {
    Ok(Json(state.store.detail(&key, &env).await?))
}
async fn save_draft(
    State(state): State<AppState>,
    Extension(actor): Extension<SessionActor>,
    Path((key, env)): Path<(String, String)>,
    StrictJson(input): StrictJson<DraftInput>,
) -> Result<Json<EnvironmentState>> {
    Ok(Json(
        state
            .store
            .save_draft(&key, &env, input, &actor.session.user.email)
            .await?,
    ))
}
async fn publish(
    State(state): State<AppState>,
    Extension(actor): Extension<SessionActor>,
    Path((key, env)): Path<(String, String)>,
    StrictJson(input): StrictJson<PublishInput>,
) -> Result<Json<FlagDetail>> {
    Ok(Json(
        state
            .store
            .publish(&key, &env, input, &actor.session.user.email)
            .await?,
    ))
}
async fn rollback(
    State(state): State<AppState>,
    Extension(actor): Extension<SessionActor>,
    Path((key, env)): Path<(String, String)>,
    StrictJson(input): StrictJson<RollbackInput>,
) -> Result<Json<FlagDetail>> {
    Ok(Json(
        state
            .store
            .rollback(&key, &env, input, &actor.session.user.email)
            .await?,
    ))
}
async fn preview(
    State(state): State<AppState>,
    Path((key, env)): Path<(String, String)>,
    StrictJson(input): StrictJson<PreviewInput>,
) -> Result<Json<Preview>> {
    Ok(Json(
        state.store.preview(&key, &env, &input.subject_id).await?,
    ))
}
async fn audit(
    State(state): State<AppState>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Page<AuditItem>>> {
    Ok(Json(state.store.audit(parse_page(raw.as_deref())?).await?))
}
pub fn parse_page(raw: Option<&str>) -> Result<i32> {
    let Some(raw) = raw else {
        return Ok(0);
    };
    let value = raw
        .strip_prefix("page=")
        .ok_or_else(|| AppError::bad("Only the page query parameter is supported."))?;
    if value.is_empty() || value.len() > 5 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AppError::bad("Page must be an integer from 0 to 10000."));
    }
    let page = value
        .parse::<i32>()
        .map_err(|_| AppError::bad("Page must be an integer from 0 to 10000."))?;
    if page > 10000 {
        return Err(AppError::bad("Page must be an integer from 0 to 10000."));
    }
    Ok(page)
}
async fn client_evaluate(
    State(state): State<AppState>,
    Path(environment): Path<String>,
    StrictJson(input): StrictJson<EvaluateInput>,
) -> Result<Json<Decision>> {
    Ok(Json(
        state
            .store
            .client_decision(&input.flag_key, &environment, &input.subject_id)
            .await?,
    ))
}
