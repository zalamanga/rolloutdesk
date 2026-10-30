use std::env;

#[derive(Clone)]
pub struct Settings {
    pub database_url: String,
    pub demo_password: String,
    pub origin: String,
    pub cookie_secure: bool,
    pub staging_digest: [u8; 32],
    pub production_digest: [u8; 32],
}

impl Settings {
    pub fn from_env() -> Result<Self, &'static str> {
        let get = |name| env::var(name).map_err(|_| "Required runtime configuration is missing.");
        let database_url = get("ROLLOUT_DB_URL")?;
        let demo_password = get("ROLLOUT_DEMO_PASSWORD")?;
        if !(16..=72).contains(&demo_password.len()) {
            return Err("Operator password must be 16 to 72 bytes.");
        }
        let origin = get("ROLLOUT_APP_ORIGIN")?;
        if origin != "http://127.0.0.1:8098" {
            return Err("This local lab requires its documented loopback origin.");
        }
        let cookie_secure = match get("ROLLOUT_COOKIE_SECURE")?.as_str() {
            "true" => true,
            "false" => false,
            _ => return Err("Cookie secure must be true or false."),
        };
        let staging_digest = decode_digest(&get("ROLLOUT_STAGING_TOKEN_SHA256")?)?;
        let production_digest = decode_digest(&get("ROLLOUT_PRODUCTION_TOKEN_SHA256")?)?;
        if staging_digest == production_digest {
            return Err("Environment token digests must differ.");
        }
        Ok(Self {
            database_url,
            demo_password,
            origin,
            cookie_secure,
            staging_digest,
            production_digest,
        })
    }
}

pub fn decode_digest(value: &str) -> Result<[u8; 32], &'static str> {
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Token digest must contain 64 hexadecimal characters.");
    }
    let mut out = [0u8; 32];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16)
            .map_err(|_| "Token digest is invalid.")?;
    }
    Ok(out)
}
