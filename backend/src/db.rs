use std::{path::Path, str::FromStr};

use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
    SqlitePool,
};

use crate::config::Config;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

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
    MIGRATOR.run(pool).await
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

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use sqlx::{
        migrate::Migrate,
        sqlite::{SqliteConnectOptions, SqliteConnection},
        Connection,
    };

    use super::MIGRATOR;

    #[tokio::test]
    async fn all_application_tables_are_strict_after_each_migration() {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("in-memory SQLite options should parse")
            .foreign_keys(true);
        let mut connection = SqliteConnection::connect_with(&options)
            .await
            .expect("in-memory SQLite should connect");

        connection
            .ensure_migrations_table()
            .await
            .expect("SQLx migration metadata table should be created");

        for migration in MIGRATOR
            .iter()
            .filter(|migration| migration.migration_type.is_up_migration())
        {
            connection
                .apply(migration)
                .await
                .unwrap_or_else(|error| panic!("migration {} failed: {error}", migration.version));

            let non_strict_tables = sqlx::query_scalar::<_, String>(
                "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_sqlx_migrations' AND strict = 0 ORDER BY name",
            )
            .fetch_all(&mut connection)
            .await
            .unwrap_or_else(|error| {
                panic!(
                    "failed to inspect schema after migration {}: {error}",
                    migration.version
                )
            });

            assert!(
                non_strict_tables.is_empty(),
                "migration {} left non-STRICT application tables: {}",
                migration.version,
                non_strict_tables.join(", ")
            );
        }

        let integrity_check = sqlx::query_scalar::<_, String>("PRAGMA integrity_check")
            .fetch_one(&mut connection)
            .await
            .expect("SQLite integrity check should run");
        assert_eq!(integrity_check, "ok");

        let foreign_key_violations =
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM pragma_foreign_key_check")
                .fetch_one(&mut connection)
                .await
                .expect("SQLite foreign key check should run");
        assert_eq!(foreign_key_violations, 0);
    }
}
