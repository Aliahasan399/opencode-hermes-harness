-- Phase 9: learning quality. ADDITIVE ONLY: no DROP, no TRUNCATE, no data rewrites.
-- Existing rows keep their values; new columns are nullable/defaulted.

ALTER TABLE pattern
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'hypothesis',
  ADD COLUMN IF NOT EXISTS distinct_sessions integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS verification_reason text,
  ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'unknown';

ALTER TABLE strategy_experiment
  ADD COLUMN IF NOT EXISTS outcome_confirmed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS confirmation_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS measured_ms bigint,
  ADD COLUMN IF NOT EXISTS retries integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS error_count integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS pattern_feedback (
  id          bigserial PRIMARY KEY,
  pattern_id  uuid NOT NULL REFERENCES pattern(id) ON DELETE CASCADE,
  verdict     text NOT NULL CHECK (verdict IN ('useful','not_useful')),
  reason      text,
  created_by  text NOT NULL DEFAULT 'user',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pattern_feedback_pattern_idx ON pattern_feedback (pattern_id);

CREATE TABLE IF NOT EXISTS session_raw_lines (
  session_id  text NOT NULL,
  role        text NOT NULL,
  seq         integer NOT NULL,
  text        text NOT NULL,
  kind        text,
  language    text NOT NULL DEFAULT 'unknown',
  time_created timestamptz,
  extracted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS session_raw_lines_session_idx ON session_raw_lines (session_id, seq);

CREATE TABLE IF NOT EXISTS strategy_observation (
  id           bigserial PRIMARY KEY,
  session_id   text NOT NULL,
  project_id   text,
  tool_name    text,
  duration_ms  bigint,
  exit_code    integer,
  is_error     boolean NOT NULL DEFAULT false,
  retry_of     text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS strategy_observation_session_idx ON strategy_observation (session_id, created_at);

ALTER TABLE session_index
  ADD COLUMN IF NOT EXISTS summary_roles text,
  ADD COLUMN IF NOT EXISTS role_extracted_at timestamptz;
