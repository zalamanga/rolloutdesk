use crate::error::{AppError, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const ENVIRONMENTS: [&str; 2] = ["staging", "production"];
pub const FLAGS: [(&str, &str, &str); 3] = [
    (
        "bulk-export",
        "Bulk export",
        "Synthetic export feature used to compare staging and production release settings.",
    ),
    (
        "checkout-redesign",
        "Checkout redesign",
        "Synthetic checkout presentation flag; it performs no customer transaction.",
    ),
    (
        "priority-support",
        "Priority support",
        "Synthetic support routing flag; it does not grant account permissions.",
    ),
];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub enabled: bool,
    pub rollout_basis_points: u16,
    pub allowlist: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            rollout_basis_points: 0,
            allowlist: Vec::new(),
        }
    }
}

impl Config {
    pub fn canonical(mut self) -> Result<Self> {
        if self.rollout_basis_points > 10000 {
            return Err(AppError::bad(
                "Rollout must be an integer from 0 to 10000 basis points.",
            ));
        }
        if self.allowlist.len() > 20 {
            return Err(AppError::bad(
                "Allowlist accepts at most 20 unique subjects.",
            ));
        }
        for subject in &self.allowlist {
            crate::evaluation::validate_subject(subject)?;
        }
        self.allowlist.sort();
        if self.allowlist.windows(2).any(|w| w[0] == w[1]) {
            return Err(AppError::bad("Allowlist subjects must be unique."));
        }
        Ok(self)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: Uuid,
    pub email: String,
    pub name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub user: User,
    pub csrf_token: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Publication {
    pub revision: i32,
    pub config: Config,
    pub kind: String,
    pub source_revision: Option<i32>,
    pub note: String,
    pub actor: String,
    pub created_at: DateTime<Utc>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentState {
    pub environment: String,
    pub version: i64,
    pub draft: Config,
    pub active: Option<Publication>,
    pub updated_at: DateTime<Utc>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Flag {
    pub key: String,
    pub name: String,
    pub description: String,
    pub states: Vec<EnvironmentState>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlagIdentity {
    pub key: String,
    pub name: String,
    pub description: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlagDetail {
    pub flag: FlagIdentity,
    pub state: EnvironmentState,
    pub history: Vec<Publication>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub flag_key: String,
    pub environment: String,
    pub revision: Option<i32>,
    pub value: bool,
    pub reason: String,
    pub bucket: Option<u32>,
    pub algorithm: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct Preview {
    pub published: Decision,
    pub draft: Decision,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditItem {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub actor: String,
    pub action: String,
    pub flag_key: String,
    pub environment: String,
    pub revision: Option<i32>,
    pub note: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub page: i32,
    pub page_size: i32,
    pub total: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoginInput {
    pub email: String,
    pub password: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftInput {
    pub expected_version: i64,
    pub config: Config,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishInput {
    pub expected_version: i64,
    pub note: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RollbackInput {
    pub expected_version: i64,
    pub target_revision: i32,
    pub note: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewInput {
    pub subject_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluateInput {
    pub flag_key: String,
    pub subject_id: String,
}

pub fn validate_environment(environment: &str) -> Result<()> {
    if !ENVIRONMENTS.contains(&environment) {
        return Err(AppError::not_found());
    }
    Ok(())
}
pub fn validate_flag_key(key: &str) -> Result<()> {
    if key.is_empty()
        || key.len() > 64
        || !key
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(AppError::bad(
            "Flag key must contain 1 to 64 lowercase letters, digits or hyphens.",
        ));
    }
    Ok(())
}
pub fn validate_note(note: &str) -> Result<String> {
    let note = note.trim();
    if !(10..=500).contains(&note.chars().count()) {
        return Err(AppError::bad(
            "Note must contain 10 to 500 characters after trimming.",
        ));
    }
    Ok(note.to_owned())
}
pub fn validate_version(version: i64) -> Result<()> {
    if version < 1 || version > 1_000_000_000 {
        return Err(AppError::bad(
            "Expected version must be a positive integer.",
        ));
    }
    Ok(())
}
