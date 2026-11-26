-- Phase 23: proactive project intelligence & predictive engineering.
-- STRICTLY ADDITIVE: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS only.
-- Reuses existing pattern/learning/decision/relationship/orchestration systems;
-- no existing row, table or constraint is changed.

-- Bounded, explainable project/component health assessments over time.
CREATE TABLE IF NOT EXISTS project_assessment (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  component text NOT NULL DEFAULT '_project',
  dimensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  unknown_areas jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pa_project_idx ON project_assessment (project_id, component, created_at DESC);

-- Evidence-backed technical debt / quality findings with a full lifecycle.
CREATE TABLE IF NOT EXISTS project_finding (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  component text NOT NULL DEFAULT '',
  category text NOT NULL,
  description text NOT NULL DEFAULT '',
  detection_method text NOT NULL DEFAULT 'deterministic',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence real NOT NULL DEFAULT 0,
  severity text NOT NULL DEFAULT 'low',
  impact text NOT NULL DEFAULT '',
  remediation text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'new',
  first_detected timestamptz NOT NULL DEFAULT now(),
  last_observed timestamptz NOT NULL DEFAULT now(),
  resolution jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (project_id, component, category, description)
);
CREATE INDEX IF NOT EXISTS pf_project_idx ON project_finding (project_id, status, severity, last_observed DESC);

-- Conservative, evidence-backed fragility / risk predictions (never certainty claims).
CREATE TABLE IF NOT EXISTS project_prediction (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  component text NOT NULL DEFAULT '',
  risk_category text NOT NULL,
  signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence real NOT NULL DEFAULT 0,
  severity text NOT NULL DEFAULT 'low',
  impact text NOT NULL DEFAULT '',
  preventive_action text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'observed',
  review_status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pp_project_idx ON project_prediction (project_id, status, created_at DESC);

-- Engineering recommendations with lifecycle and traceable supporting findings.
CREATE TABLE IF NOT EXISTS engineering_recommendation (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  category text NOT NULL,
  description text NOT NULL DEFAULT '',
  finding_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  learning_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  priority text NOT NULL DEFAULT 'medium',
  expected_benefit text NOT NULL DEFAULT '',
  effort text NOT NULL DEFAULT 'unknown',
  confidence real NOT NULL DEFAULT 0,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  dependencies jsonb NOT NULL DEFAULT '[]'::jsonb,
  change_risk text NOT NULL DEFAULT 'unknown',
  status text NOT NULL DEFAULT 'proposed',
  decided_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS er_project_idx ON engineering_recommendation (project_id, status, priority, created_at DESC);

-- Incremental analysis state per project/component (content-hash based, idempotent).
CREATE TABLE IF NOT EXISTS project_analysis_state (
  id bigserial PRIMARY KEY,
  project_id text NOT NULL,
  component text NOT NULL DEFAULT '_project',
  content_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  attempts integer NOT NULL DEFAULT 1,
  analyzed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, component, content_hash)
);
CREATE INDEX IF NOT EXISTS pas_project_idx ON project_analysis_state (project_id, status, analyzed_at DESC);
