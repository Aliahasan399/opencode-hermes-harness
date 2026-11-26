-- Step 2 additive migration: durable, idempotent learning runs. No existing rows changed.
CREATE TABLE IF NOT EXISTS learning_runs (
  session_id    text NOT NULL,
  content_hash  text NOT NULL,
  project_id    text,
  candidates    integer NOT NULL DEFAULT 0,
  saved         integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, content_hash)
);
CREATE INDEX IF NOT EXISTS learning_runs_session_idx ON learning_runs (session_id, created_at DESC);
