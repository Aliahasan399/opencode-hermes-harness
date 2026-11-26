-- Step 3-6 additive migration: durable automation events, resumable after restart.
CREATE TABLE IF NOT EXISTS automation_events (
  session_id    text NOT NULL,
  event_id      text NOT NULL,
  directory     text,
  project_id    text,
  transcript_hash text,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','failed')),
  attempts      integer NOT NULL DEFAULT 0,
  result        jsonb NOT NULL DEFAULT '{}'::jsonb,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  PRIMARY KEY (session_id, event_id)
);
CREATE INDEX IF NOT EXISTS automation_events_status_idx ON automation_events (status, created_at);
