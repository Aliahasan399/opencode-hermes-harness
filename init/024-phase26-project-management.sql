-- Phase 26: long-term project management intelligence.
-- STRICTLY ADDITIVE: ALTER TABLE ... ADD COLUMN IF NOT EXISTS /
-- CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS only.
-- Extends dev_goal (Phase 19) and references dev_task (Phase 19), Phase 22
-- orchestration, Phase 24 workflow/approval and Phase 23/25 findings. No existing
-- row, table or constraint is changed or removed. LEVEL 1; no auto-approval.

-- Extended goal metadata on the existing dev_goal table (same project isolation).
ALTER TABLE dev_goal ADD COLUMN IF NOT EXISTS goal_type text NOT NULL DEFAULT 'short_term';
ALTER TABLE dev_goal ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0;
ALTER TABLE dev_goal ADD COLUMN IF NOT EXISTS target_date timestamptz;
ALTER TABLE dev_goal ADD COLUMN IF NOT EXISTS owner text NOT NULL DEFAULT '';
ALTER TABLE dev_goal ADD COLUMN IF NOT EXISTS success_criteria jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE dev_goal ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'user_approved';
ALTER TABLE dev_goal ADD COLUMN IF NOT EXISTS parent_goal_id text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS dg_ext_project_idx ON dev_goal (project_id, goal_type, priority, updated_at DESC);

-- Milestones: success criteria + evidence gates completion.
CREATE TABLE IF NOT EXISTS pm_milestone (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  milestone_key text NOT NULL,
  goal_id text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  success_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  priority integer NOT NULL DEFAULT 0,
  target_date timestamptz,
  status text NOT NULL DEFAULT 'planned',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, milestone_key)
);
CREATE INDEX IF NOT EXISTS pmm_project_idx ON pm_milestone (project_id, status, goal_id, updated_at DESC);

-- Evidence-backed progress snapshots (append-only history; no invented percentages).
CREATE TABLE IF NOT EXISTS pm_progress_snapshot (
  id bigserial PRIMARY KEY,
  project_id text NOT NULL,
  snapshot_key text NOT NULL,
  goal_id text NOT NULL DEFAULT '',
  milestone_id text NOT NULL DEFAULT '',
  task_id text NOT NULL DEFAULT '',
  session_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'partial',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, snapshot_key)
);
CREATE INDEX IF NOT EXISTS pmps_project_idx ON pm_progress_snapshot (project_id, goal_id, milestone_id, created_at DESC);

-- Typed dependencies; only 'confirmed' is an authoritative execution constraint.
CREATE TABLE IF NOT EXISTS pm_dependency (
  id bigserial PRIMARY KEY,
  project_id text NOT NULL,
  from_type text NOT NULL,
  from_id text NOT NULL,
  to_type text NOT NULL,
  to_id text NOT NULL,
  dependency_type text NOT NULL DEFAULT 'inferred',
  confidence real NOT NULL DEFAULT 0,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, from_type, from_id, to_type, to_id, dependency_type)
);
CREATE INDEX IF NOT EXISTS pmd_project_idx ON pm_dependency (project_id, from_type, from_id, dependency_type);

-- Blockers with lifecycle and verification-gated resolution.
CREATE TABLE IF NOT EXISTS pm_blocker (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  blocker_key text NOT NULL,
  title text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  severity text NOT NULL DEFAULT 'medium',
  category text NOT NULL DEFAULT 'technical',
  status text NOT NULL DEFAULT 'identified',
  affected_goals jsonb NOT NULL DEFAULT '[]'::jsonb,
  affected_milestones jsonb NOT NULL DEFAULT '[]'::jsonb,
  affected_tasks jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  owner text NOT NULL DEFAULT '',
  resolution jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, blocker_key)
);
CREATE INDEX IF NOT EXISTS pmb_project_idx ON pm_blocker (project_id, status, severity, updated_at DESC);

-- Project drift findings: recommendations for operator review, never auto-rewrites.
CREATE TABLE IF NOT EXISTS pm_drift_finding (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  finding_key text NOT NULL,
  category text NOT NULL DEFAULT 'other',
  severity text NOT NULL DEFAULT 'low',
  confidence real NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  affected_goals jsonb NOT NULL DEFAULT '[]'::jsonb,
  affected_milestones jsonb NOT NULL DEFAULT '[]'::jsonb,
  recommendation text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, finding_key)
);
CREATE INDEX IF NOT EXISTS pmdf_project_idx ON pm_drift_finding (project_id, status, severity, created_at DESC);

-- Continuity briefings assembled from existing authoritative records (references only).
CREATE TABLE IF NOT EXISTS pm_continuity_snapshot (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  briefing jsonb NOT NULL DEFAULT '{}'::jsonb,
  freshness jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pmcs_project_idx ON pm_continuity_snapshot (project_id, created_at DESC);

-- Agent ownership/accountability with honest execution states.
CREATE TABLE IF NOT EXISTS pm_ownership (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  task_id text NOT NULL,
  agent text NOT NULL,
  assignment_reason text NOT NULL DEFAULT '',
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  expected_output text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'planned',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  handoff jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, task_id, agent)
);
CREATE INDEX IF NOT EXISTS pmo_project_idx ON pm_ownership (project_id, status, task_id, updated_at DESC);
