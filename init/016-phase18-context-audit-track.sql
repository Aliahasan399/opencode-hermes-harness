-- Phase 18: allow the automatic injection audit to use track='context'.
-- Additive only: extends the allowed values of an existing CHECK constraint.
-- No rows are deleted, updated, or reclassified. Rollback = re-add the original
-- four-value constraint below (only after all context audit rows are removed by
-- an explicit, separately-approved retention job; this migration never deletes).
ALTER TABLE intelligence_audit_events
  DROP CONSTRAINT IF EXISTS intelligence_audit_events_track_check;
ALTER TABLE intelligence_audit_events
  ADD CONSTRAINT intelligence_audit_events_track_check
  CHECK (track = ANY (ARRAY['memory','learning','optimization','system','context']));
