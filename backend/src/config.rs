use std::{env, net::SocketAddr};

use base64::{engine::general_purpose::STANDARD, Engine};

#[derive(Clone, Debug)]
pub struct Config {
    pub api_url: String,
    pub app_url: String,
    pub bind_addr: SocketAddr,
    pub database_url: String,
    pub environment: Environment,
    pub github_api_url: String,
    pub github_app: Option<GitHubAppConfig>,
    pub github_oauth: Option<GitHubOAuthConfig>,
    pub session: SessionConfig,
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
        let app_url = match env::var("APP_URL") {
            Ok(value) => value,
            Err(_) if environment.is_development() => "http://127.0.0.1:5173".to_string(),
            Err(_) => return Err(ConfigError::MissingAppUrl),
        };
        let api_url = match env::var("API_URL") {
            Ok(value) => value,
            Err(_) if environment.is_development() => "http://127.0.0.1:3000".to_string(),
            Err(_) => return Err(ConfigError::MissingApiUrl),
        };
        let github_api_url =
            env::var("GITHUB_API_URL").unwrap_or_else(|_| "https://api.github.com".to_string());
        let session = SessionConfig::from_env(environment)?;
        let github_app = GitHubAppConfig::from_env(environment)?;
        let github_oauth = GitHubOAuthConfig::from_env(environment)?;

        Ok(Self {
            api_url,
            app_url,
            bind_addr,
            database_url,
            environment,
            github_api_url,
            github_app,
            github_oauth,
            session,
            token_encryption_key,
        })
    }
}

#[derive(Clone)]
pub struct GitHubAppConfig {
    pub app_id: Option<String>,
    pub private_key_pem: Option<String>,
    pub slug: String,
}

impl GitHubAppConfig {
    fn from_env(environment: Environment) -> Result<Option<Self>, ConfigError> {
        let app_id = env::var("GITHUB_APP_ID").ok();
        let private_key_pem = env::var("GITHUB_APP_PRIVATE_KEY").ok();
        let slug = env::var("GITHUB_APP_SLUG").ok();

        let has_any = app_id.is_some() || private_key_pem.is_some() || slug.is_some();
        if !has_any && environment.is_development() {
            return Ok(None);
        }

        let slug = required_github_app_value(slug, ConfigError::MissingGitHubAppSlug)?;
        let app_id = optional_github_app_value(app_id)?;
        let private_key_pem =
            optional_github_app_value(private_key_pem)?.map(|value| value.replace("\\n", "\n"));

        if environment == Environment::Production {
            if app_id.is_none() {
                return Err(ConfigError::MissingGitHubAppId);
            }
            if private_key_pem.is_none() {
                return Err(ConfigError::MissingGitHubAppPrivateKey);
            }
        }

        Ok(Some(Self {
            app_id,
            private_key_pem,
            slug,
        }))
    }
}

fn required_github_app_value(
    value: Option<String>,
    missing: ConfigError,
) -> Result<String, ConfigError> {
    let Some(value) = value else {
        return Err(missing);
    };

    let value = value.trim();
    if value.is_empty() {
        return Err(ConfigError::InvalidGitHubAppConfig);
    }

    Ok(value.to_string())
}

fn optional_github_app_value(value: Option<String>) -> Result<Option<String>, ConfigError> {
    let Some(value) = value else {
        return Ok(None);
    };

    let value = value.trim();
    if value.is_empty() {
        return Err(ConfigError::InvalidGitHubAppConfig);
    }

    Ok(Some(value.to_string()))
}

impl std::fmt::Debug for GitHubAppConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GitHubAppConfig")
            .field("app_id", &self.app_id)
            .field(
                "private_key_pem",
                &self.private_key_pem.as_ref().map(|_| "<redacted>"),
            )
            .field("slug", &self.slug)
            .finish()
    }
}

#[derive(Clone)]
pub struct GitHubOAuthConfig {
    pub client_id: String,
    pub client_secret: String,
}

impl GitHubOAuthConfig {
    fn from_env(environment: Environment) -> Result<Option<Self>, ConfigError> {
        let client_id = env::var("GITHUB_CLIENT_ID").ok();
        let client_secret = env::var("GITHUB_CLIENT_SECRET").ok();

        match (client_id, client_secret) {
            (Some(client_id), Some(client_secret)) => Ok(Some(Self {
                client_id,
                client_secret,
            })),
            (None, None) if environment.is_development() => Ok(None),
            (None, _) => Err(ConfigError::MissingGitHubClientId),
            (_, None) => Err(ConfigError::MissingGitHubClientSecret),
        }
    }
}

impl std::fmt::Debug for GitHubOAuthConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GitHubOAuthConfig")
            .field("client_id", &self.client_id)
            .field("client_secret", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, Debug)]
pub struct SessionConfig {
    pub cookie_name: String,
    pub cookie_secure: bool,
    pub ttl_days: i64,
}

impl SessionConfig {
    fn from_env(environment: Environment) -> Result<Self, ConfigError> {
        let cookie_name =
            env::var("SESSION_COOKIE_NAME").unwrap_or_else(|_| "kestrel_session".to_string());
        if cookie_name.trim().is_empty() {
            return Err(ConfigError::InvalidSessionCookieName);
        }

        let ttl_days = match env::var("SESSION_TTL_DAYS") {
            Ok(value) => value
                .parse()
                .map_err(|source| ConfigError::InvalidSessionTtl { value, source })?,
            Err(_) => 30,
        };
        if ttl_days <= 0 {
            return Err(ConfigError::NonPositiveSessionTtl { value: ttl_days });
        }

        Ok(Self {
            cookie_name,
            cookie_secure: !environment.is_development(),
            ttl_days,
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
    InvalidBindAddr {
        source: std::net::AddrParseError,
    },
    InvalidEnvironment {
        value: String,
    },
    InvalidSessionCookieName,
    InvalidSessionTtl {
        value: String,
        source: std::num::ParseIntError,
    },
    InvalidTokenEncryptionKey {
        source: base64::DecodeError,
    },
    InvalidTokenEncryptionKeyLength,
    MissingApiUrl,
    MissingAppUrl,
    MissingDatabaseUrl,
    InvalidGitHubAppConfig,
    MissingGitHubAppId,
    MissingGitHubAppPrivateKey,
    MissingGitHubAppSlug,
    MissingGitHubClientId,
    MissingGitHubClientSecret,
    MissingTokenEncryptionKey,
    NonPositiveSessionTtl {
        value: i64,
    },
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
            Self::InvalidSessionCookieName => write!(f, "SESSION_COOKIE_NAME cannot be empty"),
            Self::InvalidSessionTtl { value, source } => {
                write!(f, "invalid SESSION_TTL_DAYS {value:?}: {source}")
            }
            Self::InvalidTokenEncryptionKey { source } => {
                write!(f, "invalid TOKEN_ENCRYPTION_KEY base64: {source}")
            }
            Self::InvalidTokenEncryptionKeyLength => {
                write!(f, "TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes")
            }
            Self::MissingApiUrl => write!(f, "API_URL is required in production"),
            Self::MissingAppUrl => write!(f, "APP_URL is required in production"),
            Self::MissingDatabaseUrl => write!(f, "DATABASE_URL is required in production"),
            Self::InvalidGitHubAppConfig => write!(f, "GitHub App config values cannot be empty"),
            Self::MissingGitHubAppId => write!(f, "GITHUB_APP_ID is required in production"),
            Self::MissingGitHubAppPrivateKey => {
                write!(f, "GITHUB_APP_PRIVATE_KEY is required in production")
            }
            Self::MissingGitHubAppSlug => write!(f, "GITHUB_APP_SLUG is required in production"),
            Self::MissingGitHubClientId => write!(f, "GITHUB_CLIENT_ID is required in production"),
            Self::MissingGitHubClientSecret => {
                write!(f, "GITHUB_CLIENT_SECRET is required in production")
            }
            Self::MissingTokenEncryptionKey => {
                write!(f, "TOKEN_ENCRYPTION_KEY is required in production")
            }
            Self::NonPositiveSessionTtl { value } => {
                write!(f, "SESSION_TTL_DAYS must be positive, got {value}")
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

    fn clear_oauth_env() {
        env::remove_var("API_URL");
        env::remove_var("APP_URL");
        env::remove_var("GITHUB_CLIENT_ID");
        env::remove_var("GITHUB_CLIENT_SECRET");
    }

    fn clear_github_app_env() {
        env::remove_var("GITHUB_API_URL");
        env::remove_var("GITHUB_APP_ID");
        env::remove_var("GITHUB_APP_PRIVATE_KEY");
        env::remove_var("GITHUB_APP_SLUG");
    }

    #[test]
    fn defaults_to_development_database_url() {
        let _lock = ENV_LOCK.lock().expect("env lock should not be poisoned");
        env::remove_var("APP_ENV");
        env::remove_var("DATABASE_URL");
        env::remove_var("BIND_ADDR");
        env::remove_var("SESSION_COOKIE_NAME");
        env::remove_var("SESSION_TTL_DAYS");
        env::remove_var("TOKEN_ENCRYPTION_KEY");
        clear_github_app_env();
        clear_oauth_env();

        let config = Config::from_env().expect("development config should load");

        assert_eq!(config.api_url, "http://127.0.0.1:3000");
        assert_eq!(config.app_url, "http://127.0.0.1:5173");
        assert_eq!(config.database_url, "sqlite://data/kestrel.dev.sqlite3");
        assert_eq!(config.github_api_url, "https://api.github.com");
        assert!(config.github_app.is_none());
        assert!(config.github_oauth.is_none());
        assert_eq!(config.session.cookie_name, "kestrel_session");
        assert!(!config.session.cookie_secure);
        assert_eq!(config.session.ttl_days, 30);
        assert_eq!(
            format!("{:?}", config.token_encryption_key),
            "TokenEncryptionKey(<redacted>)"
        );
    }

    #[test]
    fn reads_github_api_url_override() {
        let _lock = ENV_LOCK.lock().expect("env lock should not be poisoned");
        env::remove_var("APP_ENV");
        env::remove_var("DATABASE_URL");
        env::remove_var("BIND_ADDR");
        env::remove_var("SESSION_COOKIE_NAME");
        env::remove_var("SESSION_TTL_DAYS");
        env::remove_var("TOKEN_ENCRYPTION_KEY");
        clear_oauth_env();
        clear_github_app_env();
        env::set_var("GITHUB_API_URL", "http://127.0.0.1:9000");

        let config = Config::from_env().expect("development config should load");

        assert_eq!(config.github_api_url, "http://127.0.0.1:9000");
        env::remove_var("GITHUB_API_URL");
    }

    #[test]
    fn requires_database_url_in_production() {
        let _lock = ENV_LOCK.lock().expect("env lock should not be poisoned");
        env::set_var("APP_ENV", "production");
        env::remove_var("DATABASE_URL");
        env::remove_var("BIND_ADDR");
        env::remove_var("SESSION_COOKIE_NAME");
        env::remove_var("SESSION_TTL_DAYS");
        env::remove_var("TOKEN_ENCRYPTION_KEY");
        clear_github_app_env();
        clear_oauth_env();

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
        env::remove_var("SESSION_COOKIE_NAME");
        env::remove_var("SESSION_TTL_DAYS");
        env::remove_var("TOKEN_ENCRYPTION_KEY");
        clear_github_app_env();
        clear_oauth_env();

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
        env::set_var("API_URL", "https://api.example.test");
        env::set_var("APP_URL", "https://app.example.test");
        env::set_var("GITHUB_CLIENT_ID", "client_id");
        env::set_var("GITHUB_CLIENT_SECRET", "client_secret");
        env::set_var("GITHUB_APP_ID", "12345");
        env::set_var("GITHUB_APP_PRIVATE_KEY", "private\\nkey");
        env::set_var("GITHUB_APP_SLUG", "kestrel-app");
        env::set_var("SESSION_COOKIE_NAME", "custom_session");
        env::set_var("SESSION_TTL_DAYS", "14");
        env::set_var("TOKEN_ENCRYPTION_KEY", STANDARD.encode([9_u8; 32]));
        env::remove_var("BIND_ADDR");

        let config = Config::from_env().expect("production config should load");

        assert_eq!(config.api_url, "https://api.example.test");
        assert_eq!(config.app_url, "https://app.example.test");
        assert_eq!(
            config
                .github_app
                .as_ref()
                .expect("github app should be configured")
                .slug,
            "kestrel-app"
        );
        assert_eq!(
            config
                .github_app
                .as_ref()
                .expect("github app should be configured")
                .app_id
                .as_deref(),
            Some("12345")
        );
        assert_eq!(
            config
                .github_app
                .as_ref()
                .expect("github app should be configured")
                .private_key_pem
                .as_deref(),
            Some("private\nkey")
        );
        assert_eq!(
            config
                .github_oauth
                .as_ref()
                .expect("github oauth should be configured")
                .client_id,
            "client_id"
        );
        assert_eq!(config.session.cookie_name, "custom_session");
        assert!(config.session.cookie_secure);
        assert_eq!(config.session.ttl_days, 14);
        assert_eq!(config.token_encryption_key.as_bytes(), &[9_u8; 32]);

        env::remove_var("APP_ENV");
        env::remove_var("DATABASE_URL");
        env::remove_var("SESSION_COOKIE_NAME");
        env::remove_var("SESSION_TTL_DAYS");
        env::remove_var("TOKEN_ENCRYPTION_KEY");
        clear_github_app_env();
        clear_oauth_env();
    }

    #[test]
    fn rejects_token_encryption_key_with_wrong_length() {
        let _lock = ENV_LOCK.lock().expect("env lock should not be poisoned");
        env::set_var("APP_ENV", "production");
        env::set_var("DATABASE_URL", "sqlite::memory:");
        env::set_var("TOKEN_ENCRYPTION_KEY", STANDARD.encode([1_u8; 31]));
        env::remove_var("BIND_ADDR");
        env::remove_var("SESSION_COOKIE_NAME");
        env::remove_var("SESSION_TTL_DAYS");
        clear_github_app_env();
        clear_oauth_env();

        let error = Config::from_env().expect_err("production config should fail");

        assert_eq!(
            error.to_string(),
            "TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes"
        );

        env::remove_var("APP_ENV");
        env::remove_var("DATABASE_URL");
        env::remove_var("TOKEN_ENCRYPTION_KEY");
    }

    #[test]
    fn requires_github_app_slug_in_production() {
        let _lock = ENV_LOCK.lock().expect("env lock should not be poisoned");
        env::set_var("APP_ENV", "production");
        env::set_var("DATABASE_URL", "sqlite::memory:");
        clear_oauth_env();
        env::set_var("API_URL", "https://api.example.test");
        env::set_var("APP_URL", "https://app.example.test");
        env::set_var("TOKEN_ENCRYPTION_KEY", STANDARD.encode([9_u8; 32]));
        env::remove_var("BIND_ADDR");
        env::remove_var("SESSION_COOKIE_NAME");
        env::remove_var("SESSION_TTL_DAYS");
        clear_github_app_env();

        let error = Config::from_env().expect_err("production config should fail");

        assert_eq!(
            error.to_string(),
            "GITHUB_APP_SLUG is required in production"
        );

        env::remove_var("APP_ENV");
        env::remove_var("DATABASE_URL");
        env::remove_var("TOKEN_ENCRYPTION_KEY");
        clear_oauth_env();
    }

    #[test]
    fn rejects_empty_github_app_slug() {
        let _lock = ENV_LOCK.lock().expect("env lock should not be poisoned");
        env::remove_var("APP_ENV");
        env::remove_var("DATABASE_URL");
        env::remove_var("BIND_ADDR");
        env::remove_var("SESSION_COOKIE_NAME");
        env::remove_var("SESSION_TTL_DAYS");
        env::remove_var("TOKEN_ENCRYPTION_KEY");
        env::set_var("GITHUB_APP_SLUG", "  ");
        clear_oauth_env();

        let error = Config::from_env().expect_err("config should fail");

        assert_eq!(
            error.to_string(),
            "GitHub App config values cannot be empty"
        );

        clear_github_app_env();
    }

    #[test]
    fn requires_github_app_id_in_production() {
        let _lock = ENV_LOCK.lock().expect("env lock should not be poisoned");
        env::set_var("APP_ENV", "production");
        env::set_var("DATABASE_URL", "sqlite::memory:");
        clear_oauth_env();
        env::set_var("API_URL", "https://api.example.test");
        env::set_var("APP_URL", "https://app.example.test");
        env::set_var("TOKEN_ENCRYPTION_KEY", STANDARD.encode([9_u8; 32]));
        env::set_var("GITHUB_APP_SLUG", "kestrel-app");
        env::remove_var("BIND_ADDR");
        env::remove_var("SESSION_COOKIE_NAME");
        env::remove_var("SESSION_TTL_DAYS");
        env::remove_var("GITHUB_APP_ID");
        env::remove_var("GITHUB_APP_PRIVATE_KEY");

        let error = Config::from_env().expect_err("production config should fail");

        assert_eq!(error.to_string(), "GITHUB_APP_ID is required in production");

        env::remove_var("APP_ENV");
        env::remove_var("DATABASE_URL");
        env::remove_var("TOKEN_ENCRYPTION_KEY");
        clear_github_app_env();
        clear_oauth_env();
    }

    #[test]
    fn requires_github_app_private_key_in_production() {
        let _lock = ENV_LOCK.lock().expect("env lock should not be poisoned");
        env::set_var("APP_ENV", "production");
        env::set_var("DATABASE_URL", "sqlite::memory:");
        clear_oauth_env();
        env::set_var("API_URL", "https://api.example.test");
        env::set_var("APP_URL", "https://app.example.test");
        env::set_var("TOKEN_ENCRYPTION_KEY", STANDARD.encode([9_u8; 32]));
        env::set_var("GITHUB_APP_SLUG", "kestrel-app");
        env::set_var("GITHUB_APP_ID", "12345");
        env::remove_var("BIND_ADDR");
        env::remove_var("SESSION_COOKIE_NAME");
        env::remove_var("SESSION_TTL_DAYS");
        env::remove_var("GITHUB_APP_PRIVATE_KEY");

        let error = Config::from_env().expect_err("production config should fail");

        assert_eq!(
            error.to_string(),
            "GITHUB_APP_PRIVATE_KEY is required in production"
        );

        env::remove_var("APP_ENV");
        env::remove_var("DATABASE_URL");
        env::remove_var("TOKEN_ENCRYPTION_KEY");
        clear_github_app_env();
        clear_oauth_env();
    }

    #[test]
    fn requires_github_oauth_in_production() {
        let _lock = ENV_LOCK.lock().expect("env lock should not be poisoned");
        env::set_var("APP_ENV", "production");
        env::set_var("DATABASE_URL", "sqlite::memory:");
        env::set_var("API_URL", "https://api.example.test");
        env::set_var("APP_URL", "https://app.example.test");
        env::set_var("TOKEN_ENCRYPTION_KEY", STANDARD.encode([9_u8; 32]));
        env::set_var("GITHUB_APP_ID", "12345");
        env::set_var("GITHUB_APP_PRIVATE_KEY", "private-key");
        env::set_var("GITHUB_APP_SLUG", "kestrel-app");
        env::remove_var("BIND_ADDR");
        env::remove_var("SESSION_COOKIE_NAME");
        env::remove_var("SESSION_TTL_DAYS");
        env::remove_var("GITHUB_CLIENT_ID");
        env::remove_var("GITHUB_CLIENT_SECRET");

        let error = Config::from_env().expect_err("production config should fail");

        assert_eq!(
            error.to_string(),
            "GITHUB_CLIENT_ID is required in production"
        );

        env::remove_var("APP_ENV");
        env::remove_var("DATABASE_URL");
        env::remove_var("TOKEN_ENCRYPTION_KEY");
        clear_github_app_env();
        clear_oauth_env();
    }

    #[test]
    fn rejects_non_positive_session_ttl() {
        let _lock = ENV_LOCK.lock().expect("env lock should not be poisoned");
        env::remove_var("APP_ENV");
        env::remove_var("DATABASE_URL");
        env::remove_var("BIND_ADDR");
        env::remove_var("SESSION_COOKIE_NAME");
        env::set_var("SESSION_TTL_DAYS", "0");
        env::remove_var("TOKEN_ENCRYPTION_KEY");

        let error = Config::from_env().expect_err("config should fail");

        assert_eq!(
            error.to_string(),
            "SESSION_TTL_DAYS must be positive, got 0"
        );

        env::remove_var("SESSION_TTL_DAYS");
    }
}
