-- Phase 12 additive migration. No existing rows changed.
ALTER TABLE memory_retrieval_events
  ADD COLUMN IF NOT EXISTS ranking_source text NOT NULL DEFAULT 'hybrid',
  ADD COLUMN IF NOT EXISTS session_project_id text,
  ADD COLUMN IF NOT EXISTS scores jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE consolidation_suggestion
  ADD COLUMN IF NOT EXISTS triage_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS triage_reason text,
  ADD COLUMN IF NOT EXISTS triaged_at timestamptz;

ALTER TABLE strategy_experiment_results
  ADD COLUMN IF NOT EXISTS source_outcome_id bigint,
  ADD COLUMN IF NOT EXISTS project_id text;

ALTER TABLE strategy_versions
  ADD COLUMN IF NOT EXISTS lifecycle_status text NOT NULL DEFAULT 'proposed',
  ADD COLUMN IF NOT EXISTS confidence real NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS min_samples integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS promoted_at timestamptz;

CREATE TABLE IF NOT EXISTS consolidation_rollback (
  id            bigserial PRIMARY KEY,
  suggestion_id uuid NOT NULL,
  derived_id    uuid,
  source_ids    uuid[] NOT NULL DEFAULT '{}',
  operation     text NOT NULL,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  applied       boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS self_improvement_report (
  id           bigserial PRIMARY KEY,
  project_id   text,
  kind         text NOT NULL,
  summary      text NOT NULL,
  evidence     jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence   real NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS self_improvement_report_project_idx ON self_improvement_report (project_id, created_at DESC);

-- Extend pattern kinds produced by the Phase 9/12 classifier.
ALTER TABLE pattern DROP CONSTRAINT IF EXISTS pattern_kind_check;
ALTER TABLE pattern ADD CONSTRAINT pattern_kind_check CHECK (kind = ANY (ARRAY[
  'repeated_failure','successful_solution','user_preference','debugging_pattern',
  'workflow_inefficiency','project_experience','historical_decision','user_correction',
  'root_cause_candidate','failed_approach','technical_knowledge','project_decision',
  'architecture_decision','environment_config','temporary_observation','user_statement'
]::text[]));

-- Extend the usefulness signal enum without dropping the table or any rows.
ALTER TABLE memory_usefulness_observations DROP CONSTRAINT IF EXISTS memory_usefulness_observations_signal_check;
ALTER TABLE memory_usefulness_observations ADD CONSTRAINT memory_usefulness_observations_signal_check
  CHECK (signal IN ('used','not_used','helpful','unhelpful','unknown','observed_usage'));

CREATE INDEX IF NOT EXISTS retrieval_events_session_idx ON memory_retrieval_events (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS retrieval_usefulness_memory_idx ON memory_usefulness_observations (memory_id, signal);
