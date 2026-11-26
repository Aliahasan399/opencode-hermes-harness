-- Phase 20: evidence-preserving memory lifecycle intelligence.
-- STRICTLY ADDITIVE: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS only.
-- Reuses memory.lifecycle, memory_history, memory_quality_assessments,
-- consolidation_suggestion/rollback, memory_contradictions and existing
-- archive/restore functions. No existing row, table or constraint is changed.

-- Auditable lifecycle transitions (state model already enforced by migration 014).
CREATE TABLE IF NOT EXISTS memory_lifecycle_event (
  id bigserial PRIMARY KEY,
  memory_id uuid NOT NULL,
  project_id text NOT NULL,
  from_state text,
  to_state text NOT NULL,
  reason text NOT NULL DEFAULT '',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  actor text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mle_memory_idx ON memory_lifecycle_event (memory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mle_project_idx ON memory_lifecycle_event (project_id, created_at DESC);

-- Explainable importance signals. The resulting importance value stays on memory.importance;
-- these records only explain WHY, and never change verification status.
CREATE TABLE IF NOT EXISTS memory_importance_signal (
  id bigserial PRIMARY KEY,
  memory_id uuid NOT NULL,
  project_id text NOT NULL,
  signal_type text NOT NULL,
  weight real NOT NULL DEFAULT 0,
  reason text NOT NULL DEFAULT '',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (memory_id, signal_type)
);
CREATE INDEX IF NOT EXISTS mis_project_idx ON memory_importance_signal (project_id, signal_type);

-- Freshness reviews: verdict is advisory (stale / current / needs_review).
-- Age alone never changes the underlying memory.
CREATE TABLE IF NOT EXISTS memory_freshness_review (
  id bigserial PRIMARY KEY,
  memory_id uuid NOT NULL,
  project_id text NOT NULL,
  verdict text NOT NULL,
  reason text NOT NULL DEFAULT '',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  suggested_action text NOT NULL DEFAULT 'none',
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mfr_project_idx ON memory_freshness_review (project_id, reviewed_at DESC);

-- Explicit, auditable recovery / restoration events (versions and archives).
CREATE TABLE IF NOT EXISTS memory_recovery_event (
  id bigserial PRIMARY KEY,
  memory_id uuid NOT NULL,
  project_id text NOT NULL,
  operation text NOT NULL,
  version integer,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mre_memory_idx ON memory_recovery_event (memory_id, created_at DESC);
