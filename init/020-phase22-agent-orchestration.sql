-- Phase 22: autonomous agent coordination layer.
-- STRICTLY ADDITIVE: CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS. No existing row/table/constraint is changed or removed.
-- Reuses dev_task (Phase 19) for task records by adding orchestration columns.

ALTER TABLE dev_task ADD COLUMN IF NOT EXISTS plan_id text;
ALTER TABLE dev_task ADD COLUMN IF NOT EXISTS objective text NOT NULL DEFAULT '';
ALTER TABLE dev_task ADD COLUMN IF NOT EXISTS dependencies jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE dev_task ADD COLUMN IF NOT EXISTS parallel_group integer NOT NULL DEFAULT 0;
ALTER TABLE dev_task ADD COLUMN IF NOT EXISTS assigned_agent text;
ALTER TABLE dev_task ADD COLUMN IF NOT EXISTS required_capabilities jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE dev_task ADD COLUMN IF NOT EXISTS file_ownership jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE dev_task ADD COLUMN IF NOT EXISTS completion_criteria jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE dev_task ADD COLUMN IF NOT EXISTS risk_level text NOT NULL DEFAULT 'low';
ALTER TABLE dev_task ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0;
ALTER TABLE dev_task ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE dev_task ADD COLUMN IF NOT EXISTS result_ref jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS dt_plan_idx ON dev_task (plan_id, status);

CREATE TABLE IF NOT EXISTS agent_plan (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  session_id text,
  request text NOT NULL,
  status text NOT NULL DEFAULT 'planned',
  decomposition jsonb NOT NULL DEFAULT '{}'::jsonb,
  context_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ap_project_idx ON agent_plan (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_execution (
  id bigserial PRIMARY KEY,
  plan_id text NOT NULL,
  task_id text NOT NULL,
  project_id text NOT NULL,
  agent text NOT NULL,
  session_id text,
  status text NOT NULL DEFAULT 'running',
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  attempts integer NOT NULL DEFAULT 1,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (plan_id, task_id, attempts)
);
CREATE INDEX IF NOT EXISTS ae_plan_idx ON agent_execution (plan_id, status);

CREATE TABLE IF NOT EXISTS agent_context_ledger (
  id bigserial PRIMARY KEY,
  plan_id text NOT NULL,
  task_id text NOT NULL,
  project_id text NOT NULL,
  agent text NOT NULL,
  item_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  context_chars integer NOT NULL DEFAULT 0,
  degraded jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS acl_plan_idx ON agent_context_ledger (plan_id, task_id);

CREATE TABLE IF NOT EXISTS agent_review (
  id bigserial PRIMARY KEY,
  plan_id text NOT NULL,
  task_id text NOT NULL,
  project_id text NOT NULL,
  verdict text NOT NULL,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  reviewer text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ar_plan_idx ON agent_review (plan_id, task_id, created_at DESC);
