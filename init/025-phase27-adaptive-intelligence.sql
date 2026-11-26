-- Phase 27: advanced self-improvement & adaptive intelligence.
-- STRICTLY ADDITIVE: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS only.
-- Reuses Phase 21 learning (verification/confidence/contradiction), Phase 18 retrieval
-- usefulness, Phase 22 agent performance, Phase 24 verification, Phase 26 progress.
-- No existing row, table or constraint is changed or removed. LEVEL 1; advisory only;
-- no auto-approval, no dispatch, no source rewriting.

-- Structured verified-outcome evaluations referencing existing source records.
CREATE TABLE IF NOT EXISTS ai_outcome_evaluation (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL DEFAULT '',
  subsystem text NOT NULL DEFAULT '',
  observation text NOT NULL DEFAULT '',
  expected_outcome jsonb NOT NULL DEFAULT '{}'::jsonb,
  actual_outcome jsonb NOT NULL DEFAULT '{}'::jsonb,
  verification_state text NOT NULL DEFAULT 'unresolved',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence real NOT NULL DEFAULT 0,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS aioe_project_idx ON ai_outcome_evaluation (project_id, verification_state, created_at DESC);

-- Recommendation outcome evaluations. Original recommendation is never mutated.
CREATE TABLE IF NOT EXISTS ai_recommendation_evaluation (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  recommendation_type text NOT NULL DEFAULT '',
  recommendation_id text NOT NULL DEFAULT '',
  original jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NOT NULL DEFAULT '',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence real NOT NULL DEFAULT 0,
  operator_decision text NOT NULL DEFAULT 'unknown',
  action_occurred boolean NOT NULL DEFAULT false,
  result_verified boolean NOT NULL DEFAULT false,
  observed_outcome text NOT NULL DEFAULT '',
  evaluation_status text NOT NULL DEFAULT 'not_evaluated',
  created_at timestamptz NOT NULL DEFAULT now(),
  evaluated_at timestamptz,
  UNIQUE (project_id, recommendation_type, recommendation_id)
);
CREATE INDEX IF NOT EXISTS aire_project_idx ON ai_recommendation_evaluation (project_id, evaluation_status, created_at DESC);

-- Prediction-vs-outcome evaluations. Original prediction is never mutated.
CREATE TABLE IF NOT EXISTS ai_prediction_evaluation (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  prediction_type text NOT NULL DEFAULT '',
  prediction_id text NOT NULL DEFAULT '',
  predicted jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence real NOT NULL DEFAULT 0,
  prediction_time timestamptz,
  observation_window text NOT NULL DEFAULT '',
  actual jsonb NOT NULL DEFAULT '{}'::jsonb,
  verification_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  evaluation_status text NOT NULL DEFAULT 'insufficient_evidence',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, prediction_type, prediction_id)
);
CREATE INDEX IF NOT EXISTS aipe_project_idx ON ai_prediction_evaluation (project_id, evaluation_status, created_at DESC);

-- Task-decomposition outcome evaluations (genuine Phase 27 gap).
CREATE TABLE IF NOT EXISTS ai_decomposition_evaluation (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  plan_id text NOT NULL,
  task_count integer NOT NULL DEFAULT 0,
  dependency_count integer NOT NULL DEFAULT 0,
  ownership_conflicts integer NOT NULL DEFAULT 0,
  review_failures integer NOT NULL DEFAULT 0,
  rework_count integer NOT NULL DEFAULT 0,
  completion_verified boolean NOT NULL DEFAULT false,
  evaluation text NOT NULL DEFAULT 'insufficient_evidence',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  sample_size integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, plan_id)
);
CREATE INDEX IF NOT EXISTS aide_project_idx ON ai_decomposition_evaluation (project_id, evaluation, created_at DESC);

-- Bounded, explainable, advisory calibration proposals with approval + rollback.
CREATE TABLE IF NOT EXISTS ai_calibration_proposal (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  proposal_key text NOT NULL,
  target_subsystem text NOT NULL DEFAULT '',
  current_behavior jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposed_behavior jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NOT NULL DEFAULT '',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  sample_size integer NOT NULL DEFAULT 0,
  confidence real NOT NULL DEFAULT 0,
  expected_benefit text NOT NULL DEFAULT '',
  potential_downside text NOT NULL DEFAULT '',
  reversal text NOT NULL DEFAULT '',
  approval_required boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'proposed',
  actor text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, proposal_key)
);
CREATE INDEX IF NOT EXISTS aica_project_idx ON ai_calibration_proposal (project_id, status, created_at DESC);
