-- Phase 11 Steps 1-3: additive reliability state. No existing rows changed.
CREATE TABLE IF NOT EXISTS harness_state (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE automation_events
  ADD COLUMN IF NOT EXISTS sequence integer,
  ADD COLUMN IF NOT EXISTS superseded boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS automation_events_sequence_idx
  ON automation_events (session_id, sequence DESC NULLS LAST);
