-- Phases 6-8: cross-session learning, consolidation, analytics.
-- Safe to re-run: every statement is idempotent.

CREATE TABLE IF NOT EXISTS pattern (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                  text NOT NULL CHECK (kind IN ('repeated_failure','successful_solution','user_preference',
                          'debugging_pattern','workflow_inefficiency','project_experience','historical_decision')),
  pattern_key           text NOT NULL,
  description           text NOT NULL,
  occurrences           integer NOT NULL DEFAULT 1,
  sessions              text[] NOT NULL DEFAULT '{}',
  projects              text[] NOT NULL DEFAULT '{}',
  evidence              jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence            real NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  verified              boolean NOT NULL DEFAULT false,
  suggested_improvement text,
  first_observed        timestamptz NOT NULL DEFAULT now(),
  last_observed         timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pattern_kind_key_idx ON pattern (kind, pattern_key);
CREATE INDEX IF NOT EXISTS pattern_kind_idx ON pattern (kind, last_observed DESC);

CREATE TABLE IF NOT EXISTS pattern_evidence (
  id          bigserial PRIMARY KEY,
  pattern_id  uuid NOT NULL REFERENCES pattern(id) ON DELETE CASCADE,
  session_id  text NOT NULL,
  project_id  text,
  excerpt     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pattern_evidence_pattern_idx ON pattern_evidence (pattern_id);

CREATE TABLE IF NOT EXISTS strategy_experiment (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         text NOT NULL,
  previous_approach  text,
  alternative_approach text,
  result             text,
  effort             text,
  errors             jsonb NOT NULL DEFAULT '[]'::jsonb,
  successful         boolean NOT NULL DEFAULT false,
  confidence         real NOT NULL DEFAULT 0.5,
  evidence_sessions  text[] NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS strategy_project_idx ON strategy_experiment (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS learning_activity (
  id          bigserial PRIMARY KEY,
  session_id  text,
  project_id  text,
  action      text NOT NULL,
  memory_id   uuid,
  reason      text,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS learning_activity_time_idx ON learning_activity (created_at DESC);

CREATE TABLE IF NOT EXISTS analysis_state (
  session_id     text PRIMARY KEY,
  source_updated timestamptz,
  content_hash   text,
  analyzed_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS consolidation_suggestion (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('duplicate','contradiction','outdated','merge','review')),
  memory_ids      uuid[] NOT NULL DEFAULT '{}',
  title           text NOT NULL,
  description     text NOT NULL,
  confidence      real NOT NULL DEFAULT 0.5,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','resolved')),
  resolution_note text,
  resolved_at     timestamptz,
  resolved_by     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consolidation_status_idx ON consolidation_suggestion (status, created_at DESC);

CREATE TABLE IF NOT EXISTS consolidation_run (
  id          bigserial PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  stats       jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Learning activity bootstrap from audit log (idempotent by uniqueness of id is not needed;
-- only insert when the activity table is empty).
INSERT INTO learning_activity (session_id, project_id, action, reason, detail, created_at)
SELECT a.resource, NULL, a.action, a.detail::text, a.detail, a.created_at
FROM audit_log a
WHERE a.action LIKE 'learning.%' OR a.action LIKE 'memory.%'
  AND NOT EXISTS (SELECT 1 FROM learning_activity);
