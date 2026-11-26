-- Additive migration: allow the deterministic error-non-recurrence usefulness signal.
-- No data changed; existing signals remain valid.
ALTER TABLE memory_usefulness_observations DROP CONSTRAINT IF EXISTS memory_usefulness_observations_signal_check;
ALTER TABLE memory_usefulness_observations ADD CONSTRAINT memory_usefulness_observations_signal_check
  CHECK (signal IN ('used','not_used','helpful','unhelpful','unknown','observed_usage','error_not_recurred'));
