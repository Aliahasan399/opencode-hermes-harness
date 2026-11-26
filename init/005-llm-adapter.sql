-- Phase 11 additive migration: AI analysis cache and queue. No existing rows changed.
CREATE TABLE IF NOT EXISTS ai_analysis_cache (
  cache_key    text PRIMARY KEY,
  task         text NOT NULL,
  model        text NOT NULL,
  result       jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  hits         integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ai_analysis_cache_task_idx ON ai_analysis_cache (task, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_task_queue (
  id           bigserial PRIMARY KEY,
  cache_key    text NOT NULL,
  task         text NOT NULL,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','done','failed','paused')),
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cache_key)
);
CREATE INDEX IF NOT EXISTS ai_task_queue_status_idx ON ai_task_queue (status, created_at);
