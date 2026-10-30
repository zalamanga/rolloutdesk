use crate::{
    config::Settings,
    error::{AppError, Result},
    store::Store,
    types::{LoginInput, Session, User},
};
use axum::http::{HeaderMap, HeaderValue};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use subtle::ConstantTimeEq;
use tokio::sync::Semaphore;
use uuid::Uuid;

#[derive(Clone)]
pub struct AppState {
    pub store: Store,
    pub settings: Arc<Settings>,
    pub(crate) crypto: Arc<Semaphore>,
    pub(crate) dummy_hash: Arc<String>,
}

#[derive(Clone)]
pub struct SessionActor {
    pub session: Session,
    pub digest: Vec<u8>,
}

impl AppState {
    pub async fn initialize(settings: Settings) -> Result<Self> {
        let store = Store::connect(&settings.database_url).map_err(|_| AppError::unavailable())?;
        store.migrate().await?;
        let password = settings.demo_password.clone();
        let hash = tokio::task::spawn_blocking(move || bcrypt::hash(password, 12))
            .await
            .map_err(|_| AppError::internal())?
            .map_err(|_| AppError::internal())?;
        store.seed(&hash).await?;
        Ok(Self {
            store,
            settings: Arc::new(settings),
            crypto: Arc::new(Semaphore::new(2)),
            dummy_hash: Arc::new(hash),
        })
    }

    pub async fn login(&self, input: LoginInput, remote: &str) -> Result<(Session, HeaderValue)> {
        self.throttle(remote).await?;
        if input.email.len() > 254 || input.password.is_empty() || input.password.len() > 72 {
            return Err(AppError::unauthorized());
        }
        let email = input.email.trim().to_ascii_lowercase();
        let row = self
            .store
            .pool
            .get()
            .await?
            .query_opt(
                "SELECT id,email,name,password_hash FROM users WHERE email=$1",
                &[&email],
            )
            .await?;
        let hash = row
            .as_ref()
            .map(|r| r.get::<_, String>("password_hash"))
            .unwrap_or_else(|| (*self.dummy_hash).clone());
        let permit = self
            .crypto
            .clone()
            .try_acquire_owned()
            .map_err(|_| AppError::throttle())?;
        let password = input.password;
        let valid = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            bcrypt::verify(password, &hash).unwrap_or(false)
        })
        .await
        .map_err(|_| AppError::internal())?;
        if !valid || row.is_none() {
            return Err(AppError::unauthorized());
        }
        let row = row.ok_or_else(AppError::unauthorized)?;
        let user = User {
            id: row.get("id"),
            email: row.get("email"),
            name: row.get("name"),
        };
        let raw = opaque_token();
        let digest = token_digest(raw.as_bytes()).to_vec();
        let csrf_token = opaque_token();
        let mut client = self.store.pool.get().await?;
        let tx = client.transaction().await?;
        tx.execute("SELECT pg_advisory_xact_lock(824418302)", &[])
            .await?;
        tx.execute(
            "DELETE FROM sessions WHERE expires_at<=clock_timestamp()",
            &[],
        )
        .await?;
        let count: i64 = tx
            .query_one(
                "SELECT COUNT(*) FROM sessions WHERE user_id=$1",
                &[&user.id],
            )
            .await?
            .get(0);
        if count >= 20 {
            tx.execute("DELETE FROM sessions WHERE digest IN (SELECT digest FROM sessions WHERE user_id=$1 ORDER BY created_at,digest LIMIT 1)", &[&user.id]).await?;
        }
        tx.execute("INSERT INTO sessions(digest,user_id,csrf_token,expires_at) VALUES($1,$2,$3,clock_timestamp()+INTERVAL '12 hours')", &[&digest,&user.id,&csrf_token]).await?;
        tx.commit().await?;
        let secure = if self.settings.cookie_secure {
            "; Secure"
        } else {
            ""
        };
        let cookie = HeaderValue::from_str(&format!(
            "rolloutdesk_session={raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200{secure}"
        ))
        .map_err(|_| AppError::internal())?;
        Ok((Session { user, csrf_token }, cookie))
    }

    async fn throttle(&self, remote: &str) -> Result<()> {
        let digest = token_digest(remote.as_bytes()).to_vec();
        let mut client = self.store.pool.get().await?;
        let tx = client.transaction().await?;
        tx.execute("SELECT pg_advisory_xact_lock(824418303)", &[])
            .await?;
        tx.execute(
            "DELETE FROM login_throttle WHERE last_seen<clock_timestamp()-INTERVAL '5 minutes'",
            &[],
        )
        .await?;
        let exists = tx
            .query_one(
                "SELECT EXISTS(SELECT 1 FROM login_throttle WHERE remote_digest=$1)",
                &[&digest],
            )
            .await?
            .get::<_, bool>(0);
        if !exists {
            let count: i64 = tx
                .query_one("SELECT COUNT(*) FROM login_throttle", &[])
                .await?
                .get(0);
            if count >= 256 {
                return Err(AppError::throttle());
            }
        }
        let row = tx.query_opt("INSERT INTO login_throttle(remote_digest,attempts,window_started,last_seen) VALUES($1,1,clock_timestamp(),clock_timestamp()) ON CONFLICT(remote_digest) DO UPDATE SET attempts=CASE WHEN login_throttle.window_started<=clock_timestamp()-INTERVAL '5 minutes' THEN 1 ELSE login_throttle.attempts+1 END,window_started=CASE WHEN login_throttle.window_started<=clock_timestamp()-INTERVAL '5 minutes' THEN clock_timestamp() ELSE login_throttle.window_started END,last_seen=clock_timestamp() WHERE login_throttle.attempts<10 OR login_throttle.window_started<=clock_timestamp()-INTERVAL '5 minutes' RETURNING attempts", &[&digest]).await?;
        if row.is_none() {
            return Err(AppError::throttle());
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn session(&self, headers: &HeaderMap) -> Result<SessionActor> {
        let raw = session_cookie(headers).ok_or_else(AppError::unauthorized)?;
        let digest = token_digest(raw.as_bytes()).to_vec();
        let client = self.store.pool.get().await?;
        let row = client.query_opt("SELECT u.id,u.email,u.name,s.csrf_token FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.digest=$1 AND s.expires_at>clock_timestamp()", &[&digest]).await?.ok_or_else(AppError::unauthorized)?;
        Ok(SessionActor {
            session: Session {
                user: User {
                    id: row.get("id"),
                    email: row.get("email"),
                    name: row.get("name"),
                },
                csrf_token: row.get("csrf_token"),
            },
            digest,
        })
    }

    pub async fn logout(&self, actor: &SessionActor) -> Result<HeaderValue> {
        self.store
            .pool
            .get()
            .await?
            .execute("DELETE FROM sessions WHERE digest=$1", &[&actor.digest])
            .await?;
        let secure = if self.settings.cookie_secure {
            "; Secure"
        } else {
            ""
        };
        HeaderValue::from_str(&format!(
            "rolloutdesk_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{secure}"
        ))
        .map_err(|_| AppError::internal())
    }

    pub fn require_origin(&self, headers: &HeaderMap) -> Result<()> {
        if headers.get("origin").and_then(|v| v.to_str().ok())
            != Some(self.settings.origin.as_str())
        {
            return Err(AppError::forbidden());
        }
        Ok(())
    }

    pub fn require_csrf(&self, headers: &HeaderMap, actor: &SessionActor) -> Result<()> {
        self.require_origin(headers)?;
        let supplied = headers
            .get("x-csrf-token")
            .map(|v| v.as_bytes())
            .unwrap_or_default();
        if !bool::from(supplied.ct_eq(actor.session.csrf_token.as_bytes())) {
            return Err(AppError::forbidden());
        }
        Ok(())
    }

    pub fn require_client(&self, headers: &HeaderMap, environment: &str) -> Result<()> {
        let raw = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or_else(AppError::unauthorized)?;
        if raw.len() != 64 || !raw.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(AppError::unauthorized());
        }
        let digest = token_digest(raw.as_bytes());
        let expected = match environment {
            "staging" => &self.settings.staging_digest,
            "production" => &self.settings.production_digest,
            _ => return Err(AppError::unauthorized()),
        };
        if !bool::from(digest.ct_eq(expected)) {
            return Err(AppError::unauthorized());
        }
        Ok(())
    }
}

pub fn token_digest(value: &[u8]) -> [u8; 32] {
    Sha256::digest(value).into()
}
fn opaque_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}
fn session_cookie(headers: &HeaderMap) -> Option<String> {
    let mut found = None;
    for header in headers.get_all("cookie") {
        for part in header.to_str().ok()?.split(';') {
            if let Some(value) = part.trim().strip_prefix("rolloutdesk_session=") {
                if found.is_some()
                    || value.len() != 64
                    || !value.bytes().all(|b| b.is_ascii_hexdigit())
                {
                    return None;
                }
                found = Some(value.to_owned());
            }
        }
    }
    found
}
