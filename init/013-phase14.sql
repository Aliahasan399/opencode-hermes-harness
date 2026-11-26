-- Phase 14 additive migration: governance review workflow + explainable quality.
-- No existing rows changed or deleted.
CREATE TABLE IF NOT EXISTS scope_review (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id              uuid NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  proposed_scope         text NOT NULL CHECK (proposed_scope IN ('project','global','private','unchanged')),
  status                 text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','approved','rejected','rolled_back')),
  reason                 text NOT NULL,
  evidence               jsonb NOT NULL DEFAULT '{}'::jsonb,
  original_scope         text NOT NULL,
  original_global_eligible boolean NOT NULL DEFAULT false,
  original_metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  reviewer               text,
  review_note            text,
  rollback               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  decided_at             timestamptz
);
CREATE INDEX IF NOT EXISTS scope_review_status_idx ON scope_review (status, created_at DESC);
CREATE INDEX IF NOT EXISTS scope_review_memory_idx ON scope_review (memory_id, created_at DESC);

ALTER TABLE memory ADD COLUMN IF NOT EXISTS quality_explanation jsonb NOT NULL DEFAULT '{}'::jsonb;
