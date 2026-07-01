CREATE TABLE oauth_states (
    state_hash TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX oauth_states_expires_at_idx ON oauth_states(expires_at);
