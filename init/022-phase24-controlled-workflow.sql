-- Phase 24: controlled autonomous workflow execution & closed-loop engineering.
-- STRICTLY ADDITIVE: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS only.
-- Reuses Phase 22 orchestration (dev_task, agent_plan, agent_execution), Phase 23
-- project intelligence (engineering_recommendation) and core.audit(). No existing
-- row, table or constraint is changed or removed.
-- LEVEL 1: every run is approval-bound; default mode is 'simulation'.

-- Single-use, scope-bound execution approvals. Only token_hash is persisted;
-- the plaintext token is returned once at creation and never stored or audited.
CREATE TABLE IF NOT EXISTS workflow_approval (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  plan_id text NOT NULL DEFAULT '',
  plan_version text NOT NULL DEFAULT '',
  plan_hash text NOT NULL DEFAULT '',
  scope_key text NOT NULL DEFAULT '',
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  mode text NOT NULL DEFAULT 'simulation',
  risk text NOT NULL DEFAULT 'low',
  approved_by text NOT NULL DEFAULT '',
  token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  expires_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wa_token_idx ON workflow_approval (token_hash);
CREATE INDEX IF NOT EXISTS wa_project_idx ON workflow_approval (project_id, status, created_at DESC);

-- Durable workflow run: one approved plan execution attempt.
CREATE TABLE IF NOT EXISTS workflow_run (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  plan_id text NOT NULL DEFAULT '',
  plan_version text NOT NULL DEFAULT '',
  plan_hash text NOT NULL DEFAULT '',
  approval_id text,
  mode text NOT NULL DEFAULT 'simulation',
  status text NOT NULL DEFAULT 'created',
  template text NOT NULL DEFAULT '',
  source_ref text NOT NULL DEFAULT '',
  created_by text NOT NULL DEFAULT '',
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wr_project_idx ON workflow_run (project_id, status, created_at DESC);

-- Tasks inside a run, with dependency + file-ownership metadata for safe dispatch.
CREATE TABLE IF NOT EXISTS workflow_task (
  id uuid PRIMARY KEY,
  run_id text NOT NULL,
  project_id text NOT NULL,
  task_key text NOT NULL,
  title text NOT NULL DEFAULT '',
  dependencies jsonb NOT NULL DEFAULT '[]'::jsonb,
  file_ownership jsonb NOT NULL DEFAULT '[]'::jsonb,
  assigned_agent text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  risk text NOT NULL DEFAULT 'low',
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  result_ref jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, task_key)
);
CREATE INDEX IF NOT EXISTS wt_run_idx ON workflow_task (run_id, status);
CREATE INDEX IF NOT EXISTS wt_project_idx ON workflow_task (project_id, status);

-- Idempotent dispatch ledger: one row per (run, task, idempotency key).
CREATE TABLE IF NOT EXISTS workflow_dispatch (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL,
  task_id text NOT NULL DEFAULT '',
  task_key text NOT NULL DEFAULT '',
  project_id text NOT NULL,
  approval_id text NOT NULL DEFAULT '',
  idempotency_key text NOT NULL,
  argv jsonb NOT NULL DEFAULT '[]'::jsonb,
  mode text NOT NULL DEFAULT 'simulation',
  evidence_class text NOT NULL DEFAULT 'mock',
  process_exit_code integer,
  process_ok boolean NOT NULL DEFAULT false,
  task_verified boolean NOT NULL DEFAULT false,
  session_id text,
  output_ref text NOT NULL DEFAULT '',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, task_key, idempotency_key)
);
CREATE INDEX IF NOT EXISTS wd_run_idx ON workflow_dispatch (run_id, task_key);

-- Evidence-based verification: process_ok alone can never set verified=true.
CREATE TABLE IF NOT EXISTS workflow_verification (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL,
  task_id text NOT NULL DEFAULT '',
  task_key text NOT NULL DEFAULT '',
  project_id text NOT NULL,
  checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  verified boolean NOT NULL DEFAULT false,
  claims jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wv_run_idx ON workflow_verification (run_id, task_key);

-- Closed-loop feedback into Phase 21 learning / Phase 23 intelligence (record only).
CREATE TABLE IF NOT EXISTS workflow_feedback (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL,
  project_id text NOT NULL,
  channel text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'recorded',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wf_project_idx ON workflow_feedback (project_id, run_id, created_at DESC);
