use std::{path::Path, str::FromStr};

use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
    SqlitePool,
};

use crate::config::Config;

pub async fn connect(config: &Config) -> Result<SqlitePool, DbError> {
    ensure_sqlite_parent_dir(&config.database_url)?;

    let options = SqliteConnectOptions::from_str(&config.database_url)?
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal);

    let pool = SqlitePoolOptions::new().connect_with(options).await?;
    Ok(pool)
}

pub async fn migrate(pool: &SqlitePool) -> Result<(), sqlx::migrate::MigrateError> {
    sqlx::migrate!("./migrations").run(pool).await
}

pub async fn health_check(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT 1").execute(pool).await?;
    Ok(())
}

fn ensure_sqlite_parent_dir(database_url: &str) -> Result<(), DbError> {
    let Some(path) = database_url.strip_prefix("sqlite://") else {
        return Ok(());
    };

    if path == ":memory:" || path.starts_with("file:") {
        return Ok(());
    }

    let Some(parent) = Path::new(path).parent() else {
        return Ok(());
    };

    if parent.as_os_str().is_empty() {
        return Ok(());
    }

    std::fs::create_dir_all(parent).map_err(|source| DbError::CreateDatabaseDirectory {
        path: parent.display().to_string(),
        source,
    })?;
    Ok(())
}

#[derive(Debug)]
pub enum DbError {
    Connect(sqlx::Error),
    CreateDatabaseDirectory {
        path: String,
        source: std::io::Error,
    },
}

impl From<sqlx::Error> for DbError {
    fn from(error: sqlx::Error) -> Self {
        Self::Connect(error)
    }
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Connect(error) => write!(f, "database connection failed: {error}"),
            Self::CreateDatabaseDirectory { path, source } => {
                write!(f, "failed to create database directory {path:?}: {source}")
            }
        }
    }
}

impl std::error::Error for DbError {}
