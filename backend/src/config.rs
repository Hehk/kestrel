use std::{env, net::SocketAddr};

use base64::{engine::general_purpose::STANDARD, Engine};

#[derive(Clone, Debug)]
pub struct Config {
    pub bind_addr: SocketAddr,
    pub database_url: String,
    pub environment: Environment,
    pub token_encryption_key: TokenEncryptionKey,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Environment {
    Development,
    Production,
}

impl Environment {
    pub fn is_development(self) -> bool {
        self == Self::Development
    }
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let bind_addr = env::var("BIND_ADDR")
            .unwrap_or_else(|_| "127.0.0.1:3000".to_string())
            .parse()
            .map_err(|source| ConfigError::InvalidBindAddr { source })?;
        let environment = match env::var("APP_ENV") {
            Ok(value) if value == "production" => Environment::Production,
            Ok(value) if value == "development" => Environment::Development,
            Ok(value) => return Err(ConfigError::InvalidEnvironment { value }),
            Err(_) => Environment::Development,
        };
        let database_url = match env::var("DATABASE_URL") {
            Ok(value) => value,
            Err(_) if environment.is_development() => {
                "sqlite://data/kestrel.dev.sqlite3".to_string()
            }
            Err(_) => return Err(ConfigError::MissingDatabaseUrl),
        };
        let token_encryption_key = match env::var("TOKEN_ENCRYPTION_KEY") {
            Ok(value) => TokenEncryptionKey::from_base64(&value)?,
            Err(_) if environment.is_development() => TokenEncryptionKey::development(),
            Err(_) => return Err(ConfigError::MissingTokenEncryptionKey),
        };

        Ok(Self {
            bind_addr,
            database_url,
            environment,
            token_encryption_key,
        })
    }
}

#[derive(Clone)]
pub struct TokenEncryptionKey([u8; 32]);

impl TokenEncryptionKey {
    fn development() -> Self {
        Self(*b"kestrel-development-token-key!!!")
    }

    pub(crate) fn from_base64(value: &str) -> Result<Self, ConfigError> {
        let bytes = STANDARD
            .decode(value)
            .map_err(|source| ConfigError::InvalidTokenEncryptionKey { source })?;
        let bytes: [u8; 32] = bytes
            .try_into()
            .map_err(|_| ConfigError::InvalidTokenEncryptionKeyLength)?;

        Ok(Self(bytes))
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl std::fmt::Debug for TokenEncryptionKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TokenEncryptionKey(<redacted>)")
    }
}

#[derive(Debug)]
pub enum ConfigError {
    InvalidBindAddr { source: std::net::AddrParseError },
    InvalidEnvironment { value: String },
    InvalidTokenEncryptionKey { source: base64::DecodeError },
    InvalidTokenEncryptionKeyLength,
    MissingDatabaseUrl,
    MissingTokenEncryptionKey,
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidBindAddr { source } => write!(f, "invalid BIND_ADDR: {source}"),
            Self::InvalidEnvironment { value } => {
                write!(
                    f,
                    "invalid APP_ENV {value:?}; expected development or production"
                )
            }
            Self::InvalidTokenEncryptionKey { source } => {
                write!(f, "invalid TOKEN_ENCRYPTION_KEY base64: {source}")
            }
            Self::InvalidTokenEncryptionKeyLength => {
                write!(f, "TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes")
            }
            Self::MissingDatabaseUrl => write!(f, "DATABASE_URL is required in production"),
            Self::MissingTokenEncryptionKey => {
                write!(f, "TOKEN_ENCRYPTION_KEY is required in production")
            }
        }
    }
}

impl std::error::Error for ConfigError {}

#[cfg(test)]
mod tests {
    use std::{env, sync::Mutex};

    use base64::{engine::general_purpose::STANDARD, Engine};

    use super::Config;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn defaults_to_development_database_url() {
        let _lock = ENV_LOCK.lock().expect("env lock should not be poisoned");
        env::remove_var("APP_ENV");
        env::remove_var("DATABASE_URL");
        env::remove_var("BIND_ADDR");
        env::remove_var("TOKEN_ENCRYPTION_KEY");

        let config = Config::from_env().expect("development config should load");

        assert_eq!(config.database_url, "sqlite://data/kestrel.dev.sqlite3");
        assert_eq!(
            format!("{:?}", config.token_encryption_key),
            "TokenEncryptionKey(<redacted>)"
        );
    }

    #[test]
    fn requires_database_url_in_production() {
        let _lock = ENV_LOCK.lock().expect("env lock should not be poisoned");
        env::set_var("APP_ENV", "production");
        env::remove_var("DATABASE_URL");
        env::remove_var("BIND_ADDR");
        env::remove_var("TOKEN_ENCRYPTION_KEY");

        let error = Config::from_env().expect_err("production config should fail");

        assert_eq!(error.to_string(), "DATABASE_URL is required in production");

        env::remove_var("APP_ENV");
    }

    #[test]
    fn requires_token_encryption_key_in_production() {
        let _lock = ENV_LOCK.lock().expect("env lock should not be poisoned");
        env::set_var("APP_ENV", "production");
        env::set_var("DATABASE_URL", "sqlite::memory:");
        env::remove_var("BIND_ADDR");
        env::remove_var("TOKEN_ENCRYPTION_KEY");

        let error = Config::from_env().expect_err("production config should fail");

        assert_eq!(
            error.to_string(),
            "TOKEN_ENCRYPTION_KEY is required in production"
        );

        env::remove_var("APP_ENV");
        env::remove_var("DATABASE_URL");
    }

    #[test]
    fn parses_token_encryption_key_from_base64() {
        let _lock = ENV_LOCK.lock().expect("env lock should not be poisoned");
        env::set_var("APP_ENV", "production");
        env::set_var("DATABASE_URL", "sqlite::memory:");
        env::set_var("TOKEN_ENCRYPTION_KEY", STANDARD.encode([9_u8; 32]));
        env::remove_var("BIND_ADDR");

        let config = Config::from_env().expect("production config should load");

        assert_eq!(config.token_encryption_key.as_bytes(), &[9_u8; 32]);

        env::remove_var("APP_ENV");
        env::remove_var("DATABASE_URL");
        env::remove_var("TOKEN_ENCRYPTION_KEY");
    }

    #[test]
    fn rejects_token_encryption_key_with_wrong_length() {
        let _lock = ENV_LOCK.lock().expect("env lock should not be poisoned");
        env::set_var("APP_ENV", "production");
        env::set_var("DATABASE_URL", "sqlite::memory:");
        env::set_var("TOKEN_ENCRYPTION_KEY", STANDARD.encode([1_u8; 31]));
        env::remove_var("BIND_ADDR");

        let error = Config::from_env().expect_err("production config should fail");

        assert_eq!(
            error.to_string(),
            "TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes"
        );

        env::remove_var("APP_ENV");
        env::remove_var("DATABASE_URL");
        env::remove_var("TOKEN_ENCRYPTION_KEY");
    }
}
