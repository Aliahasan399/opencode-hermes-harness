-- Phase 13.8 additive migration: explicit global eligibility + superseded event state.
ALTER TABLE memory
  ADD COLUMN IF NOT EXISTS global_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS scope_reason text;

ALTER TABLE automation_events DROP CONSTRAINT IF EXISTS automation_events_status_check;
ALTER TABLE automation_events ADD CONSTRAINT automation_events_status_check
  CHECK (status IN ('pending','processing','done','failed','superseded'));

CREATE INDEX IF NOT EXISTS memory_global_eligible_idx ON memory (global_eligible, project_id);
CREATE INDEX IF NOT EXISTS automation_events_session_status_idx ON automation_events (session_id, status, sequence DESC);
