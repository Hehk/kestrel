use std::{env, net::SocketAddr};

#[derive(Clone, Debug)]
pub struct Config {
    pub bind_addr: SocketAddr,
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

        Ok(Self {
            bind_addr,
            environment,
        })
    }
}

#[derive(Debug)]
pub enum ConfigError {
    InvalidBindAddr { source: std::net::AddrParseError },
    InvalidEnvironment { value: String },
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
        }
    }
}

impl std::error::Error for ConfigError {}
