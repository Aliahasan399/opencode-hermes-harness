-- Phase 10 unified intelligence. ADDITIVE ONLY: no DROP, TRUNCATE, UPDATE or rewrite of existing rows.
-- New columns default safely; existing Phase 1-9 semantics unchanged.

ALTER TABLE memory
  ADD COLUMN IF NOT EXISTS lifecycle text NOT NULL DEFAULT 'HYPOTHESIS',
  ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS useful_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS retrieved_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_retrieved_at timestamptz,
  ADD COLUMN IF NOT EXISTS quality_score real NOT NULL DEFAULT 0.5;

CREATE TABLE IF NOT EXISTS memory_relationships (
  id            bigserial PRIMARY KEY,
  source_id     uuid NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  target_id     uuid NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  relation      text NOT NULL CHECK (relation IN ('duplicate','near_duplicate','semantic_equivalent','related','supersedes','contradicts')),
  score         real NOT NULL DEFAULT 0,
  method        text NOT NULL DEFAULT 'embedding',
  status        text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','approved','rejected')),
  evidence      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, target_id, relation)
);
CREATE INDEX IF NOT EXISTS memory_relationships_source_idx ON memory_relationships (source_id);

CREATE TABLE IF NOT EXISTS memory_contradictions (
  id             bigserial PRIMARY KEY,
  memory_a       uuid NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  memory_b       uuid NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  description    text NOT NULL,
  evidence       jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence     real NOT NULL DEFAULT 0.5,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','resolved','dismissed')),
  resolution_note text,
  resolved_by    text,
  detected_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  UNIQUE (memory_a, memory_b)
);

CREATE TABLE IF NOT EXISTS memory_quality_assessments (
  id            bigserial PRIMARY KEY,
  memory_id     uuid NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  dimension     text NOT NULL CHECK (dimension IN ('clarity','specificity','evidence','reliability','relevance')),
  score         real NOT NULL CHECK (score >= 0 AND score <= 1),
  method        text NOT NULL DEFAULT 'heuristic',
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_quality_memory_idx ON memory_quality_assessments (memory_id);

CREATE TABLE IF NOT EXISTS memory_retrieval_events (
  id            bigserial PRIMARY KEY,
  session_id    text,
  project_id    text,
  query         text NOT NULL,
  memory_ids    uuid[] NOT NULL DEFAULT '{}',
  context       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_retrieval_session_idx ON memory_retrieval_events (session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_usefulness_observations (
  id            bigserial PRIMARY KEY,
  event_id      bigserial NOT NULL REFERENCES memory_retrieval_events(id) ON DELETE CASCADE,
  memory_id     uuid NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  signal        text NOT NULL CHECK (signal IN ('used','not_used','helpful','unhelpful','unknown')),
  evidence      jsonb NOT NULL DEFAULT '{}'::jsonb,
  source        text NOT NULL DEFAULT 'observed',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coding_tasks (
  id            text PRIMARY KEY,
  session_id    text,
  project_id    text,
  description   text NOT NULL,
  task_type     text,
  language      text,
  framework     text,
  started_at    timestamptz,
  finished_at   timestamptz,
  status        text NOT NULL DEFAULT 'observed' CHECK (status IN ('observed','in_progress','completed','failed','abandoned')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coding_tasks_project_idx ON coding_tasks (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS coding_attempts (
  id            bigserial PRIMARY KEY,
  task_id       text NOT NULL REFERENCES coding_tasks(id) ON DELETE CASCADE,
  strategy_id   text,
  approach      text NOT NULL,
  started_at    timestamptz,
  finished_at   timestamptz,
  duration_ms   bigint,
  retry_number  integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coding_attempts_task_idx ON coding_attempts (task_id);

CREATE TABLE IF NOT EXISTS coding_outcomes (
  id            bigserial PRIMARY KEY,
  task_id       text NOT NULL REFERENCES coding_tasks(id) ON DELETE CASCADE,
  attempt_id    bigint REFERENCES coding_attempts(id) ON DELETE CASCADE,
  metric        text NOT NULL CHECK (metric IN ('task_completed','test_pass','build_success','regression','debug_iterations','retry_count','resolution_ms','files_changed')),
  value         text NOT NULL,
  measurement   text NOT NULL DEFAULT 'observed' CHECK (measurement IN ('observed','estimated','missing')),
  evidence      jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coding_outcomes_task_idx ON coding_outcomes (task_id, metric);

CREATE TABLE IF NOT EXISTS strategy_versions (
  id            bigserial PRIMARY KEY,
  strategy_key  text NOT NULL,
  version       integer NOT NULL,
  definition    jsonb NOT NULL DEFAULT '{}'::jsonb,
  change_note   text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (strategy_key, version)
);

CREATE TABLE IF NOT EXISTS strategy_experiment_results (
  id            bigserial PRIMARY KEY,
  experiment_id uuid NOT NULL REFERENCES strategy_experiment(id) ON DELETE CASCADE,
  task_id       text REFERENCES coding_tasks(id) ON DELETE SET NULL,
  strategy_key  text,
  strategy_version integer,
  outcome       text NOT NULL CHECK (outcome IN ('success','failure','inconclusive')),
  metrics       jsonb NOT NULL DEFAULT '{}'::jsonb,
  measurement   text NOT NULL DEFAULT 'observed' CHECK (measurement IN ('observed','estimated','missing')),
  limitations   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS strategy_experiment_results_exp_idx ON strategy_experiment_results (experiment_id);

CREATE TABLE IF NOT EXISTS optimization_recommendations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    text,
  project_id    text,
  task_id       text REFERENCES coding_tasks(id) ON DELETE SET NULL,
  task_type     text,
  category      text NOT NULL,
  recommendation text NOT NULL,
  reason        text NOT NULL,
  evidence      jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence    real NOT NULL DEFAULT 0,
  sample_size   integer NOT NULL DEFAULT 0,
  permission_level integer NOT NULL DEFAULT 1,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','executed','rolled_back')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  decided_by    text
);
CREATE INDEX IF NOT EXISTS optimization_recommendations_status_idx ON optimization_recommendations (status, created_at DESC);

CREATE TABLE IF NOT EXISTS optimization_actions (
  id            bigserial PRIMARY KEY,
  recommendation_id uuid NOT NULL REFERENCES optimization_recommendations(id) ON DELETE CASCADE,
  action        text NOT NULL,
  status        text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','executed','validated','failed','rolled_back')),
  result        jsonb NOT NULL DEFAULT '{}'::jsonb,
  rollback_info jsonb NOT NULL DEFAULT '{}'::jsonb,
  executed_by   text NOT NULL DEFAULT 'user',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS intelligence_audit_events (
  id           bigserial PRIMARY KEY,
  track        text NOT NULL CHECK (track IN ('memory','learning','optimization','system')),
  action       text NOT NULL,
  resource     text,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intelligence_audit_track_idx ON intelligence_audit_events (track, created_at DESC);

-- Strict lifecycle transition guard: verified requires independent, non-AI evidence.
CREATE OR REPLACE FUNCTION guard_memory_lifecycle() RETURNS trigger AS $$
DECLARE allowed boolean := false;
BEGIN
  IF NEW.lifecycle IS DISTINCT FROM OLD.lifecycle THEN
    allowed := (OLD.lifecycle, NEW.lifecycle) IN (
      ('HYPOTHESIS','SUPPORTED'), ('HYPOTHESIS','REJECTED'), ('HYPOTHESIS','DISPUTED'),
      ('SUPPORTED','VERIFIED'), ('SUPPORTED','OUTDATED'), ('SUPPORTED','DISPUTED'), ('SUPPORTED','REJECTED'),
      ('VERIFIED','OUTDATED'), ('VERIFIED','DISPUTED'), ('VERIFIED','ARCHIVED'),
      ('DISPUTED','VERIFIED'), ('DISPUTED','SUPPORTED'), ('DISPUTED','REJECTED'), ('DISPUTED','ARCHIVED'),
      ('OUTDATED','SUPPORTED'), ('OUTDATED','ARCHIVED'), ('REJECTED','ARCHIVED')
    );
    IF NOT allowed THEN RAISE EXCEPTION 'invalid lifecycle transition % -> %', OLD.lifecycle, NEW.lifecycle; END IF;
    IF NEW.lifecycle='VERIFIED' AND NEW.verified IS NOT true THEN
      RAISE EXCEPTION 'VERIFIED lifecycle requires independent verified evidence';
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS guard_memory_lifecycle_trigger ON memory;
CREATE TRIGGER guard_memory_lifecycle_trigger BEFORE UPDATE ON memory
  FOR EACH ROW EXECUTE FUNCTION guard_memory_lifecycle();
