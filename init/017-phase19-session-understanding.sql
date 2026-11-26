-- Phase 19: structured development-session understanding.
-- STRICTLY ADDITIVE: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS only.
-- No deletes, no updates to existing rows, no drops, no reclassification.

-- Per-session connected understanding; one row per (project, session, transcript sequence).
CREATE TABLE IF NOT EXISTS session_understanding (
  id bigserial PRIMARY KEY,
  project_id text NOT NULL,
  session_id text NOT NULL,
  transcript_sequence integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  events jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, transcript_sequence)
);
CREATE INDEX IF NOT EXISTS su_project_idx ON session_understanding (project_id, updated_at DESC);

-- Long-term development goals and their subtasks (evidence-backed, never inferred from one message).
CREATE TABLE IF NOT EXISTS dev_goal (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
  constraints jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_session text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, title)
);
CREATE INDEX IF NOT EXISTS dg_project_idx ON dev_goal (project_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS dev_task (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  goal_id text,
  task_key text NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'not_started',
  parent_task_id text,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_session text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, task_key)
);
CREATE INDEX IF NOT EXISTS dt_project_idx ON dev_task (project_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS dt_goal_idx ON dev_task (goal_id);

-- Reusable development experiences (including debugging experiences, kind='debugging').
CREATE TABLE IF NOT EXISTS dev_experience (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  session_id text,
  goal_id text,
  task_id text,
  kind text NOT NULL DEFAULT 'pattern',
  title text NOT NULL,
  problem text NOT NULL DEFAULT '',
  environment text NOT NULL DEFAULT '',
  approach text NOT NULL DEFAULT '',
  result text NOT NULL DEFAULT '',
  verification_status text NOT NULL DEFAULT 'observed',
  root_cause text NOT NULL DEFAULT '',
  root_cause_status text NOT NULL DEFAULT 'hypothesis',
  failed_approaches jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence real,
  reusability text NOT NULL DEFAULT 'project',
  status text NOT NULL DEFAULT 'active',
  freshness_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, title)
);
CREATE INDEX IF NOT EXISTS de_project_idx ON dev_experience (project_id, kind, updated_at DESC);
CREATE INDEX IF NOT EXISTS de_goal_idx ON dev_experience (goal_id);
