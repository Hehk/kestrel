CREATE TABLE github_app_installations (
    installation_id TEXT PRIMARY KEY,
    account_login TEXT,
    account_type TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE github_app_installation_users (
    installation_id TEXT NOT NULL REFERENCES github_app_installations(installation_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (installation_id, user_id)
) STRICT;

CREATE INDEX github_app_installation_users_user_id_idx ON github_app_installation_users(user_id);

CREATE TABLE github_app_setup_states (
    state_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;

CREATE INDEX github_app_setup_states_user_id_idx ON github_app_setup_states(user_id);
CREATE INDEX github_app_setup_states_expires_at_idx ON github_app_setup_states(expires_at);
