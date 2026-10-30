CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY,
    email text NOT NULL UNIQUE,
    name text NOT NULL,
    password_hash text NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    digest bytea PRIMARY KEY CHECK (octet_length(digest) = 32),
    user_id uuid NOT NULL REFERENCES users(id),
    csrf_token text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS login_throttle (
    remote_digest bytea PRIMARY KEY CHECK (octet_length(remote_digest) = 32),
    attempts integer NOT NULL CHECK (attempts BETWEEN 0 AND 10),
    window_started timestamptz NOT NULL,
    last_seen timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS flags (
    key text PRIMARY KEY,
    name text NOT NULL,
    description text NOT NULL
);
CREATE TABLE IF NOT EXISTS flag_states (
    flag_key text NOT NULL REFERENCES flags(key),
    environment text NOT NULL CHECK (environment IN ('staging','production')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    draft jsonb NOT NULL,
    active_revision integer,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (flag_key, environment)
);
CREATE TABLE IF NOT EXISTS publications (
    flag_key text NOT NULL,
    environment text NOT NULL,
    revision integer NOT NULL CHECK (revision BETWEEN 1 AND 100),
    config jsonb NOT NULL,
    kind text NOT NULL CHECK (kind IN ('PUBLISH','ROLLBACK')),
    source_revision integer,
    note text NOT NULL CHECK (char_length(note) BETWEEN 10 AND 500),
    actor text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (flag_key, environment, revision),
    FOREIGN KEY (flag_key, environment) REFERENCES flag_states(flag_key, environment),
    FOREIGN KEY (flag_key, environment, source_revision) REFERENCES publications(flag_key, environment, revision),
    CHECK ((kind = 'PUBLISH' AND source_revision IS NULL) OR (kind = 'ROLLBACK' AND source_revision IS NOT NULL))
);
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flag_states_active_fk' AND conrelid = 'flag_states'::regclass) THEN
        ALTER TABLE flag_states ADD CONSTRAINT flag_states_active_fk
            FOREIGN KEY (flag_key, environment, active_revision) REFERENCES publications(flag_key, environment, revision);
    END IF;
END $$;
CREATE OR REPLACE FUNCTION reject_publication_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Publication history is immutable';
END $$;
DROP TRIGGER IF EXISTS publication_immutable ON publications;
CREATE TRIGGER publication_immutable BEFORE UPDATE OR DELETE ON publications
    FOR EACH ROW EXECUTE FUNCTION reject_publication_mutation();
CREATE TABLE IF NOT EXISTS audit (
    id uuid PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    actor text NOT NULL,
    action text NOT NULL CHECK (action IN ('DRAFT_SAVED','PUBLISHED','ROLLED_BACK')),
    flag_key text NOT NULL,
    environment text NOT NULL,
    revision integer,
    note text NOT NULL,
    FOREIGN KEY (flag_key, environment) REFERENCES flag_states(flag_key, environment),
    FOREIGN KEY (flag_key, environment, revision) REFERENCES publications(flag_key, environment, revision)
);
CREATE INDEX IF NOT EXISTS audit_latest ON audit(created_at DESC, id DESC);
