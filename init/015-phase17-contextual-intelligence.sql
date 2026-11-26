-- Phase 17: Advanced Contextual Intelligence.
-- STRICTLY ADDITIVE: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS only.
-- No deletes, no updates to existing rows, no drops, no reclassification.
-- Reversible by dropping only the new tables (documented in the final report).

-- A. Project context: compact per-project summary + JSON fact map.
CREATE TABLE IF NOT EXISTS project_context (
  project_id text PRIMARY KEY,
  summary text NOT NULL DEFAULT '',
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_context_updated_idx ON project_context (updated_at DESC);

-- A. Individual project facts with provenance and explicit status.
CREATE TABLE IF NOT EXISTS project_context_fact (
  id bigserial PRIMARY KEY,
  project_id text NOT NULL,
  fact_key text NOT NULL,
  value jsonb NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'observed',
  confidence real,
  source text,
  source_session text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, fact_key)
);
CREATE INDEX IF NOT EXISTS pcf_project_idx ON project_context_fact (project_id, updated_at DESC);

-- B. Technical decisions. History preserved; replaced rows get status='superseded'.
CREATE TABLE IF NOT EXISTS technical_decision (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  reasoning text NOT NULL DEFAULT '',
  alternatives jsonb NOT NULL DEFAULT '[]'::jsonb,
  consequences jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active',
  confidence real,
  superseded_by text,
  source_session text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, title)
);
CREATE INDEX IF NOT EXISTS td_project_idx ON technical_decision (project_id, created_at DESC);

-- C. Evidence-based relationships between knowledge records.
CREATE TABLE IF NOT EXISTS knowledge_relationship (
  id bigserial PRIMARY KEY,
  project_id text NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  relation_type text NOT NULL,
  confidence real,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, source_type, source_id, target_type, target_id, relation_type)
);
CREATE INDEX IF NOT EXISTS kr_project_idx ON knowledge_relationship (project_id);
CREATE INDEX IF NOT EXISTS kr_source_idx ON knowledge_relationship (project_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS kr_target_idx ON knowledge_relationship (project_id, target_type, target_id);

-- E. Knowledge quality: verification kept separate from model confidence.
CREATE TABLE IF NOT EXISTS knowledge_quality (
  id bigserial PRIMARY KEY,
  project_id text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  verification text NOT NULL DEFAULT 'observed',
  confidence real,
  evidence_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  freshness_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, subject_type, subject_id)
);
CREATE INDEX IF NOT EXISTS kq_project_idx ON knowledge_quality (project_id, verification);

-- F.Idempotent context-update ledger for durable transcript processing.
CREATE TABLE IF NOT EXISTS context_update (
  id bigserial PRIMARY KEY,
  project_id text NOT NULL,
  session_id text NOT NULL,
  transcript_sequence integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  attempts integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, transcript_sequence)
);
CREATE INDEX IF NOT EXISTS cu_project_idx ON context_update (project_id, status);
