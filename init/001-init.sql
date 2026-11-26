-- OpenCode persistent memory schema. Runs once on a fresh PostgreSQL data volume.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS memory (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  layer           text NOT NULL CHECK (layer IN ('user','project','session','knowledge')),
  project_id      text NOT NULL DEFAULT '_global',
  title           text NOT NULL,
  content         text NOT NULL,
  category        text,
  tags            text[] NOT NULL DEFAULT '{}',
  source_session  text,
  source_kind     text NOT NULL DEFAULT 'observed'
                  CHECK (source_kind IN ('observed','user','hypothesis','attempt','verified')),
  confidence      real NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  importance      real NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
  verified        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  valid_until     timestamptz,
  version         integer NOT NULL DEFAULT 1,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding       vector(768)
);

CREATE INDEX IF NOT EXISTS memory_layer_project_idx ON memory (layer, project_id);
CREATE INDEX IF NOT EXISTS memory_tags_idx ON memory USING gin (tags);
CREATE INDEX IF NOT EXISTS memory_fts_idx ON memory USING gin (
  to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,''))
);
CREATE INDEX IF NOT EXISTS memory_embedding_idx ON memory USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS memory_history (
  id          bigserial PRIMARY KEY,
  memory_id   uuid NOT NULL,
  version     integer NOT NULL,
  content     text NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  reason      text
);
CREATE INDEX IF NOT EXISTS memory_history_memory_idx ON memory_history (memory_id, version);

CREATE TABLE IF NOT EXISTS session_index (
  id             text PRIMARY KEY,
  project_id     text NOT NULL,
  directory      text,
  title          text,
  summary        text,
  message_count  integer NOT NULL DEFAULT 0,
  time_created   timestamptz,
  time_updated   timestamptz,
  imported_at    timestamptz NOT NULL DEFAULT now(),
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS session_index_project_idx ON session_index (project_id);

CREATE TABLE IF NOT EXISTS import_state (
  source      text PRIMARY KEY,
  last_cursor text,
  last_run    timestamptz NOT NULL DEFAULT now(),
  count       integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         bigserial PRIMARY KEY,
  action     text NOT NULL,
  actor      text NOT NULL DEFAULT 'opencode-memory',
  resource   text,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION memory_touch() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS memory_touch_trigger ON memory;
CREATE TRIGGER memory_touch_trigger BEFORE UPDATE ON memory
  FOR EACH ROW EXECUTE FUNCTION memory_touch();
