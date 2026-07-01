use std::{env, net::SocketAddr};

#[derive(Clone, Debug)]
pub struct Config {
    pub bind_addr: SocketAddr,
    pub database_url: String,
    pub environment: Environment,
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

        Ok(Self {
            bind_addr,
            database_url,
            environment,
        })
    }
}

#[derive(Debug)]
pub enum ConfigError {
    InvalidBindAddr { source: std::net::AddrParseError },
    InvalidEnvironment { value: String },
    MissingDatabaseUrl,
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
            Self::MissingDatabaseUrl => write!(f, "DATABASE_URL is required in production"),
        }
    }
}

impl std::error::Error for ConfigError {}

#[cfg(test)]
mod tests {
    use std::{env, sync::Mutex};

    use super::Config;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn defaults_to_development_database_url() {
        let _lock = ENV_LOCK.lock().expect("env lock should not be poisoned");
        env::remove_var("APP_ENV");
        env::remove_var("DATABASE_URL");
        env::remove_var("BIND_ADDR");

        let config = Config::from_env().expect("development config should load");

        assert_eq!(config.database_url, "sqlite://data/kestrel.dev.sqlite3");
    }

    #[test]
    fn requires_database_url_in_production() {
        let _lock = ENV_LOCK.lock().expect("env lock should not be poisoned");
        env::set_var("APP_ENV", "production");
        env::remove_var("DATABASE_URL");
        env::remove_var("BIND_ADDR");

        let error = Config::from_env().expect_err("production config should fail");

        assert_eq!(error.to_string(), "DATABASE_URL is required in production");

        env::remove_var("APP_ENV");
    }
}
