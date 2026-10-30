use crate::{
    error::{AppError, Result},
    types::{Config, Decision},
};
use sha2::{Digest, Sha256};

pub const ALGORITHM: &str = "sha256-u32be-mod10000-v1";

pub fn validate_subject(subject: &str) -> Result<()> {
    if !(1..=64).contains(&subject.len())
        || !subject
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
    {
        return Err(AppError::bad(
            "Subject must contain 1 to 64 ASCII letters, digits, dots, underscores or hyphens.",
        ));
    }
    Ok(())
}

pub fn bucket(flag_key: &str, environment: &str, subject: &str) -> u32 {
    let mut hash = Sha256::new();
    hash.update(b"rolloutdesk:v1");
    for field in [flag_key, environment, subject] {
        hash.update((field.len() as u32).to_be_bytes());
        hash.update(field.as_bytes());
    }
    let digest = hash.finalize();
    u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 10000
}

pub fn evaluate(
    flag_key: &str,
    environment: &str,
    subject: &str,
    config: Option<&Config>,
    revision: Option<i32>,
    registered: bool,
) -> Decision {
    let cohort = registered.then(|| bucket(flag_key, environment, subject));
    let (value, reason) = match config {
        None if !registered => (false, "FLAG_NOT_FOUND"),
        None => (false, "UNPUBLISHED"),
        Some(c) if !c.enabled => (false, "DISABLED"),
        Some(c) if c.allowlist.iter().any(|s| s == subject) => (true, "ALLOWLIST"),
        Some(c) if cohort.unwrap_or(10000) < u32::from(c.rollout_basis_points) => (true, "ROLLOUT"),
        Some(_) => (false, "OUTSIDE_ROLLOUT"),
    };
    Decision {
        flag_key: flag_key.to_owned(),
        environment: environment.to_owned(),
        revision,
        value,
        reason: reason.to_owned(),
        bucket: cohort,
        algorithm: ALGORITHM.to_owned(),
    }
}
