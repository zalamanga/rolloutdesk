use crate::{
    error::{AppError, Result},
    types::*,
};
use chrono::{DateTime, Utc};
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod, Runtime};
use std::{str::FromStr, time::Duration};
use tokio_postgres::{GenericClient, IsolationLevel, NoTls, Row};
use uuid::Uuid;

#[derive(Clone)]
pub struct Store {
    pub(crate) pool: Pool,
}

impl Store {
    pub fn connect(url: &str) -> std::result::Result<Self, &'static str> {
        let config =
            tokio_postgres::Config::from_str(url).map_err(|_| "Database URL is invalid.")?;
        Self::from_config(config)
    }

    pub(crate) fn from_config(
        config: tokio_postgres::Config,
    ) -> std::result::Result<Self, &'static str> {
        let manager = Manager::from_config(
            config,
            NoTls,
            ManagerConfig {
                recycling_method: RecyclingMethod::Fast,
            },
        );
        let pool = Pool::builder(manager)
            .max_size(8)
            .runtime(Runtime::Tokio1)
            .wait_timeout(Some(Duration::from_secs(5)))
            .create_timeout(Some(Duration::from_secs(5)))
            .build()
            .map_err(|_| "Database pool could not be created.")?;
        Ok(Self { pool })
    }

    pub async fn migrate(&self) -> Result<()> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        tx.execute("SELECT pg_advisory_xact_lock(824418301)", &[])
            .await?;
        tx.batch_execute(include_str!("../migrations/001_init.sql"))
            .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn seed(&self, password_hash: &str) -> Result<()> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        tx.execute("SELECT pg_advisory_xact_lock(824418301)", &[])
            .await?;
        if !tx
            .query_one("SELECT EXISTS(SELECT 1 FROM users)", &[])
            .await?
            .get::<_, bool>(0)
        {
            tx.execute("INSERT INTO users(id,email,name,password_hash) VALUES($1,'operator@rolloutdesk.test','Local operator',$2)", &[&Uuid::new_v4(), &password_hash]).await?;
        }
        let draft = serde_json::to_value(Config::default()).map_err(|_| AppError::internal())?;
        for (key, name, description) in FLAGS {
            tx.execute(
                "INSERT INTO flags(key,name,description) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
                &[&key, &name, &description],
            )
            .await?;
            for env in ENVIRONMENTS {
                tx.execute("INSERT INTO flag_states(flag_key,environment,draft) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", &[&key,&env,&draft]).await?;
            }
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn healthy(&self) -> bool {
        match self.pool.get().await {
            Ok(client) => client.simple_query("SELECT 1").await.is_ok(),
            Err(_) => false,
        }
    }

    pub async fn flags(&self) -> Result<Vec<Flag>> {
        let mut client = self.pool.get().await?;
        let tx = client
            .build_transaction()
            .isolation_level(IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .await?;
        let rows = tx
            .query("SELECT key,name,description FROM flags ORDER BY key", &[])
            .await?;
        let mut result = Vec::new();
        for row in rows {
            let key: String = row.get("key");
            let mut states = Vec::new();
            for environment in ENVIRONMENTS {
                states.push(load_state(&*tx, &key, environment).await?);
            }
            result.push(Flag {
                key,
                name: row.get("name"),
                description: row.get("description"),
                states,
            });
        }
        tx.commit().await?;
        Ok(result)
    }

    pub async fn detail(&self, key: &str, environment: &str) -> Result<FlagDetail> {
        validate_environment(environment)?;
        let mut client = self.pool.get().await?;
        let tx = client
            .build_transaction()
            .isolation_level(IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .await?;
        let detail = load_detail(&*tx, key, environment).await?;
        tx.commit().await?;
        Ok(detail)
    }

    pub async fn save_draft(
        &self,
        key: &str,
        environment: &str,
        input: DraftInput,
        actor: &str,
    ) -> Result<EnvironmentState> {
        validate_environment(environment)?;
        validate_version(input.expected_version)?;
        let config = input.config.canonical()?;
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        let row = lock_state(&*tx, key, environment, input.expected_version).await?;
        let previous = config_from_value(row.get("draft"))?;
        if previous != config {
            let json = serde_json::to_value(config).map_err(|_| AppError::internal())?;
            tx.execute("UPDATE flag_states SET draft=$3,version=version+1,updated_at=clock_timestamp() WHERE flag_key=$1 AND environment=$2", &[&key,&environment,&json]).await?;
            insert_audit(
                &*tx,
                actor,
                "DRAFT_SAVED",
                key,
                environment,
                None,
                "Saved draft configuration",
            )
            .await?;
        }
        let state = load_state(&*tx, key, environment).await?;
        tx.commit().await?;
        Ok(state)
    }

    pub async fn publish(
        &self,
        key: &str,
        environment: &str,
        input: PublishInput,
        actor: &str,
    ) -> Result<FlagDetail> {
        self.revise(
            key,
            environment,
            input.expected_version,
            None,
            &input.note,
            actor,
            false,
        )
        .await
    }

    pub async fn rollback(
        &self,
        key: &str,
        environment: &str,
        input: RollbackInput,
        actor: &str,
    ) -> Result<FlagDetail> {
        if input.target_revision < 1 || input.target_revision > 100 {
            return Err(AppError::bad(
                "Target revision must be an integer from 1 to 100.",
            ));
        }
        self.revise(
            key,
            environment,
            input.expected_version,
            Some(input.target_revision),
            &input.note,
            actor,
            false,
        )
        .await
    }

    pub(crate) async fn revise(
        &self,
        key: &str,
        environment: &str,
        expected_version: i64,
        source: Option<i32>,
        note: &str,
        actor: &str,
        fail_after_insert: bool,
    ) -> Result<FlagDetail> {
        validate_environment(environment)?;
        validate_version(expected_version)?;
        let note = validate_note(note)?;
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        let locked = lock_state(&*tx, key, environment, expected_version).await?;
        let config = if let Some(revision) = source {
            let row = tx.query_opt("SELECT config FROM publications WHERE flag_key=$1 AND environment=$2 AND revision=$3", &[&key,&environment,&revision]).await?.ok_or_else(AppError::not_found)?;
            config_from_value(row.get("config"))?
        } else {
            config_from_value(locked.get("draft"))?
        };
        if let Some(active_revision) = locked.get::<_, Option<i32>>("active_revision") {
            let active = tx.query_one("SELECT config FROM publications WHERE flag_key=$1 AND environment=$2 AND revision=$3", &[&key,&environment,&active_revision]).await?;
            if config_from_value(active.get("config"))? == config {
                return Err(AppError::conflict(
                    "NO_CHANGE",
                    "Configuration already equals the active publication.",
                ));
            }
        }
        let last: i32 = tx.query_one("SELECT COALESCE(MAX(revision),0) FROM publications WHERE flag_key=$1 AND environment=$2", &[&key,&environment]).await?.get(0);
        if last >= 100 {
            return Err(AppError::conflict(
                "REVISION_LIMIT",
                "This flag and environment reached its 100-publication limit.",
            ));
        }
        let revision = last + 1;
        let kind = if source.is_some() {
            "ROLLBACK"
        } else {
            "PUBLISH"
        };
        let action = if source.is_some() {
            "ROLLED_BACK"
        } else {
            "PUBLISHED"
        };
        let json = serde_json::to_value(config).map_err(|_| AppError::internal())?;
        tx.execute("INSERT INTO publications(flag_key,environment,revision,config,kind,source_revision,note,actor) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", &[&key,&environment,&revision,&json,&kind,&source,&note,&actor]).await?;
        if fail_after_insert {
            // Tests inject a database error at the point a partial history row would be dangerous.
            tx.batch_execute("SELECT 1/0").await?;
        }
        tx.execute("UPDATE flag_states SET active_revision=$3,version=version+1,updated_at=clock_timestamp() WHERE flag_key=$1 AND environment=$2", &[&key,&environment,&revision]).await?;
        insert_audit(&*tx, actor, action, key, environment, Some(revision), &note).await?;
        let detail = load_detail(&*tx, key, environment).await?;
        tx.commit().await?;
        Ok(detail)
    }

    pub async fn client_decision(
        &self,
        key: &str,
        environment: &str,
        subject: &str,
    ) -> Result<Decision> {
        validate_environment(environment)?;
        validate_flag_key(key)?;
        crate::evaluation::validate_subject(subject)?;
        let client = self.pool.get().await?;
        let row = client.query_opt("SELECT s.active_revision,p.config FROM flag_states s LEFT JOIN publications p ON p.flag_key=s.flag_key AND p.environment=s.environment AND p.revision=s.active_revision WHERE s.flag_key=$1 AND s.environment=$2", &[&key,&environment]).await?;
        if let Some(row) = row {
            let config = row
                .get::<_, Option<serde_json::Value>>("config")
                .map(config_from_value)
                .transpose()?;
            Ok(crate::evaluation::evaluate(
                key,
                environment,
                subject,
                config.as_ref(),
                row.get("active_revision"),
                true,
            ))
        } else {
            Ok(crate::evaluation::evaluate(
                key,
                environment,
                subject,
                None,
                None,
                false,
            ))
        }
    }

    pub async fn preview(&self, key: &str, environment: &str, subject: &str) -> Result<Preview> {
        crate::evaluation::validate_subject(subject)?;
        let detail = self.detail(key, environment).await?;
        let active = detail.state.active.as_ref();
        Ok(Preview {
            published: crate::evaluation::evaluate(
                key,
                environment,
                subject,
                active.map(|p| &p.config),
                active.map(|p| p.revision),
                true,
            ),
            draft: crate::evaluation::evaluate(
                key,
                environment,
                subject,
                Some(&detail.state.draft),
                None,
                true,
            ),
        })
    }

    pub async fn audit(&self, page: i32) -> Result<Page<AuditItem>> {
        if !(0..=10000).contains(&page) {
            return Err(AppError::bad("Page must be an integer from 0 to 10000."));
        }
        let mut client = self.pool.get().await?;
        let tx = client
            .build_transaction()
            .isolation_level(IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .await?;
        let total: i64 = tx
            .query_one("SELECT COUNT(*) FROM audit", &[])
            .await?
            .get(0);
        let offset = i64::from(page) * 25;
        let rows = tx.query("SELECT id,created_at,actor,action,flag_key,environment,revision,note FROM audit ORDER BY created_at DESC,id DESC LIMIT 25 OFFSET $1", &[&offset]).await?;
        let items = rows
            .into_iter()
            .map(|row| AuditItem {
                id: row.get("id"),
                created_at: row.get("created_at"),
                actor: row.get("actor"),
                action: row.get("action"),
                flag_key: row.get("flag_key"),
                environment: row.get("environment"),
                revision: row.get("revision"),
                note: row.get("note"),
            })
            .collect();
        tx.commit().await?;
        Ok(Page {
            items,
            page,
            page_size: 25,
            total,
        })
    }
}

fn config_from_value(value: serde_json::Value) -> Result<Config> {
    serde_json::from_value(value).map_err(|_| AppError::internal())
}

async fn lock_state<C: GenericClient + Sync>(
    client: &C,
    key: &str,
    environment: &str,
    expected: i64,
) -> Result<Row> {
    let row = client.query_opt("SELECT version,draft,active_revision FROM flag_states WHERE flag_key=$1 AND environment=$2 FOR UPDATE", &[&key,&environment]).await?.ok_or_else(AppError::not_found)?;
    if row.get::<_, i64>("version") != expected {
        return Err(AppError::conflict(
            "VERSION_CONFLICT",
            "State changed. Refresh and review the current version before trying again.",
        ));
    }
    Ok(row)
}

async fn load_state<C: GenericClient + Sync>(
    client: &C,
    key: &str,
    environment: &str,
) -> Result<EnvironmentState> {
    let row = client.query_opt("SELECT environment,version,draft,active_revision,updated_at FROM flag_states WHERE flag_key=$1 AND environment=$2", &[&key,&environment]).await?.ok_or_else(AppError::not_found)?;
    let active = if let Some(revision) = row.get::<_, Option<i32>>("active_revision") {
        Some(publication(client.query_one("SELECT revision,config,kind,source_revision,note,actor,created_at FROM publications WHERE flag_key=$1 AND environment=$2 AND revision=$3", &[&key,&environment,&revision]).await?)?)
    } else {
        None
    };
    Ok(EnvironmentState {
        environment: row.get("environment"),
        version: row.get("version"),
        draft: config_from_value(row.get("draft"))?,
        active,
        updated_at: row.get::<_, DateTime<Utc>>("updated_at"),
    })
}

async fn load_detail<C: GenericClient + Sync>(
    client: &C,
    key: &str,
    environment: &str,
) -> Result<FlagDetail> {
    let row = client
        .query_opt(
            "SELECT key,name,description FROM flags WHERE key=$1",
            &[&key],
        )
        .await?
        .ok_or_else(AppError::not_found)?;
    let state = load_state(client, key, environment).await?;
    let rows = client.query("SELECT revision,config,kind,source_revision,note,actor,created_at FROM publications WHERE flag_key=$1 AND environment=$2 ORDER BY revision DESC LIMIT 100", &[&key,&environment]).await?;
    let history = rows
        .into_iter()
        .map(publication)
        .collect::<Result<Vec<_>>>()?;
    Ok(FlagDetail {
        flag: FlagIdentity {
            key: row.get("key"),
            name: row.get("name"),
            description: row.get("description"),
        },
        state,
        history,
    })
}

fn publication(row: Row) -> Result<Publication> {
    Ok(Publication {
        revision: row.get("revision"),
        config: config_from_value(row.get("config"))?,
        kind: row.get("kind"),
        source_revision: row.get("source_revision"),
        note: row.get("note"),
        actor: row.get("actor"),
        created_at: row.get("created_at"),
    })
}

async fn insert_audit<C: GenericClient + Sync>(
    client: &C,
    actor: &str,
    action: &str,
    key: &str,
    environment: &str,
    revision: Option<i32>,
    note: &str,
) -> Result<()> {
    client.execute("INSERT INTO audit(id,actor,action,flag_key,environment,revision,note) VALUES($1,$2,$3,$4,$5,$6,$7)", &[&Uuid::new_v4(),&actor,&action,&key,&environment,&revision,&note]).await?;
    Ok(())
}
