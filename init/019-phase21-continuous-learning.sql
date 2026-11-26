-- Phase 21: continuous learning & self-improvement.
-- STRICTLY ADDITIVE: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS only.
-- Reuses: session_understanding, dev_experience, pattern/pattern_evidence/pattern_feedback,
-- learning_runs/learning_activity, coding_outcomes, knowledge_quality, memory_relationships,
-- memory_lifecycle_event. No existing row, table or constraint is changed.

-- Structured, evidence-backed learning records extracted from sessions.
CREATE TABLE IF NOT EXISTS learning_record (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  session_id text,
  signature text NOT NULL,
  category text NOT NULL DEFAULT 'pattern',
  problem text NOT NULL DEFAULT '',
  approach text NOT NULL DEFAULT '',
  outcome text NOT NULL DEFAULT 'uncertain',
  verification text NOT NULL DEFAULT 'observed',
  confidence real NOT NULL DEFAULT 0,
  confidence_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  reusability text NOT NULL DEFAULT 'project',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active',
  superseded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, signature)
);
CREATE INDEX IF NOT EXISTS lr_project_idx ON learning_record (project_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS lr_session_idx ON learning_record (session_id, created_at DESC);

-- Explicit and inferred feedback on learning records / patterns.
CREATE TABLE IF NOT EXISTS learning_feedback (
  id bigserial PRIMARY KEY,
  project_id text NOT NULL,
  learning_id uuid,
  pattern_id uuid,
  session_id text,
  verdict text NOT NULL,
  explicit_feedback boolean NOT NULL DEFAULT false,
  reason text NOT NULL DEFAULT '',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  applied boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lf_project_idx ON learning_feedback (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lf_learning_idx ON learning_feedback (learning_id, created_at DESC);

-- Idempotent learning pipeline ledger keyed by session + transcript sequence.
CREATE TABLE IF NOT EXISTS learning_pipeline_run (
  id bigserial PRIMARY KEY,
  project_id text NOT NULL,
  session_id text NOT NULL,
  transcript_sequence integer NOT NULL,
  status text NOT NULL DEFAULT 'processing',
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  attempts integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, transcript_sequence)
);
CREATE INDEX IF NOT EXISTS lpr_project_idx ON learning_pipeline_run (project_id, status, created_at DESC);
