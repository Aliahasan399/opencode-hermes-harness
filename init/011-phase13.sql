-- Phase 13 additive migration. No existing rows changed or deleted.
CREATE TABLE IF NOT EXISTS semantic_observation (
  id            bigserial PRIMARY KEY,
  session_id    text NOT NULL,
  project_id    text NOT NULL,
  kind          text NOT NULL,
  text          text NOT NULL,
  attribution   text NOT NULL DEFAULT 'observed'
                CHECK (attribution IN ('observed','interpreted','estimated','user_confirmed')),
  source        text NOT NULL DEFAULT 'deterministic' CHECK (source IN ('llm','deterministic')),
  confidence    real NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  evidence      jsonb NOT NULL DEFAULT '{}'::jsonb,
  cache_key     text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS semantic_observation_session_idx ON semantic_observation (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS semantic_observation_project_idx ON semantic_observation (project_id, kind, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS semantic_observation_cache_idx ON semantic_observation (cache_key) WHERE cache_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS fix_evidence (
  id                  bigserial PRIMARY KEY,
  project_id          text NOT NULL,
  error_hash          text NOT NULL,
  error_signature     text NOT NULL,
  session_id          text NOT NULL,
  attempted_fix       text,
  verification_command text,
  verification_result text,
  status              text NOT NULL DEFAULT 'observed_failure'
                      CHECK (status IN ('observed_failure','attempted_fix','verified_fix','non_recurrence','strongly_supported','confirmed','regressed')),
  confidence          real NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  window_days         integer NOT NULL DEFAULT 7,
  evidence            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fix_evidence_project_idx ON fix_evidence (project_id, error_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS fix_evidence_session_idx ON fix_evidence (session_id);
CREATE UNIQUE INDEX IF NOT EXISTS fix_evidence_unique_idx ON fix_evidence (project_id, error_hash, session_id);

ALTER TABLE memory
  ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'unknown';

ALTER TABLE strategy_versions
  ADD COLUMN IF NOT EXISTS regressed_at timestamptz,
  ADD COLUMN IF NOT EXISTS regression_reason text;

ALTER TABLE memory_retrieval_events
  ADD COLUMN IF NOT EXISTS ranking_components jsonb NOT NULL DEFAULT '{}'::jsonb;
