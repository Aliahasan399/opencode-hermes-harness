-- Phase 25: advanced software engineering intelligence & deep code understanding.
-- STRICTLY ADDITIVE: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS only.
-- Reuses Phase 17 relationship/decision intelligence and Phase 23 debt/risk/test-quality/
-- dependency/recommendation engines as evidence consumers. No existing row, table or
-- constraint is changed or removed. Every table is project-scoped and content-versioned.
-- LEVEL 1: analysis only; no source rewriting, no dispatch, no auto-approval.

-- Bounded incremental source index ledger (one row per index attempt).
CREATE TABLE IF NOT EXISTS code_index_state (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  root_path text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'running',
  files_seen integer NOT NULL DEFAULT 0,
  files_indexed integer NOT NULL DEFAULT 0,
  files_skipped integer NOT NULL DEFAULT 0,
  files_failed integer NOT NULL DEFAULT 0,
  symbols_extracted integer NOT NULL DEFAULT 0,
  version_hash text NOT NULL DEFAULT '',
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS cis_project_idx ON code_index_state (project_id, started_at DESC);

-- One row per discovered source file (history preserved: no destructive deletes).
CREATE TABLE IF NOT EXISTS code_source_file (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  path text NOT NULL,
  language text NOT NULL DEFAULT 'unknown',
  content_hash text NOT NULL DEFAULT '',
  size_bytes integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'indexed',
  extractor text NOT NULL DEFAULT 'heuristic',
  last_indexed_run uuid,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, path)
);
CREATE INDEX IF NOT EXISTS csf_project_idx ON code_source_file (project_id, status, language);

-- Discovered symbols with stable identity and explicit confidence/provenance.
CREATE TABLE IF NOT EXISTS code_symbol (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  file_path text NOT NULL,
  symbol_key text NOT NULL,
  name text NOT NULL DEFAULT '',
  symbol_type text NOT NULL DEFAULT 'unknown',
  scope text NOT NULL DEFAULT 'module',
  visibility text NOT NULL DEFAULT 'internal',
  start_line integer NOT NULL DEFAULT 0,
  end_line integer NOT NULL DEFAULT 0,
  parent_key text NOT NULL DEFAULT '',
  is_export boolean NOT NULL DEFAULT false,
  language text NOT NULL DEFAULT 'unknown',
  content_hash text NOT NULL DEFAULT '',
  version_hash text NOT NULL DEFAULT '',
  extraction_method text NOT NULL DEFAULT 'heuristic',
  confidence real NOT NULL DEFAULT 0,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active',
  indexed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, file_path, symbol_key, content_hash)
);
CREATE INDEX IF NOT EXISTS cs_project_idx ON code_symbol (project_id, symbol_type, name);
CREATE INDEX IF NOT EXISTS cs_key_idx ON code_symbol (project_id, symbol_key);

-- Symbol relationships: confirmed / inferred / unresolved, always evidence-backed.
CREATE TABLE IF NOT EXISTS code_relationship (
  id bigserial PRIMARY KEY,
  project_id text NOT NULL,
  source_key text NOT NULL,
  target_key text NOT NULL,
  relationship_type text NOT NULL,
  source_file text NOT NULL DEFAULT '',
  source_line integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'inferred',
  confidence real NOT NULL DEFAULT 0,
  extraction_method text NOT NULL DEFAULT 'heuristic',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  version_hash text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, source_key, target_key, relationship_type, version_hash)
);
CREATE INDEX IF NOT EXISTS cr_project_idx ON code_relationship (project_id, relationship_type, status);
CREATE INDEX IF NOT EXISTS cr_source_idx ON code_relationship (project_id, source_key);

-- Evidence-backed test-to-code links (no invented coverage percentages).
CREATE TABLE IF NOT EXISTS code_test_map (
  id bigserial PRIMARY KEY,
  project_id text NOT NULL,
  test_path text NOT NULL,
  test_name text NOT NULL DEFAULT '',
  source_path text NOT NULL DEFAULT '',
  source_key text NOT NULL DEFAULT '',
  link_type text NOT NULL DEFAULT 'unmapped',
  confidence real NOT NULL DEFAULT 0,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  version_hash text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, test_path, test_name, source_key, version_hash)
);
CREATE INDEX IF NOT EXISTS ctm_project_idx ON code_test_map (project_id, link_type);
CREATE INDEX IF NOT EXISTS ctm_source_idx ON code_test_map (project_id, source_key);

-- Versioned analysis results: impact, review, contracts, unified report.
CREATE TABLE IF NOT EXISTS code_analysis (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  analysis_type text NOT NULL,
  change_ref text NOT NULL DEFAULT '',
  version_hash text NOT NULL DEFAULT '',
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence real NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'complete',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, analysis_type, change_ref, version_hash)
);
CREATE INDEX IF NOT EXISTS ca_project_idx ON code_analysis (project_id, analysis_type, created_at DESC);
