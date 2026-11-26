-- Phase 28 hardening: additive project_id indexes on high-traffic project-scoped tables.
-- STRICTLY ADDITIVE: CREATE INDEX IF NOT EXISTS only. Reversible by DROP INDEX IF EXISTS.
-- No existing row, table, constraint or index is changed or removed.
CREATE INDEX IF NOT EXISTS p28_agent_execution_project_idx ON agent_execution (project_id);
CREATE INDEX IF NOT EXISTS p28_agent_review_project_idx ON agent_review (project_id);
CREATE INDEX IF NOT EXISTS p28_workflow_verification_project_idx ON workflow_verification (project_id);
CREATE INDEX IF NOT EXISTS p28_workflow_dispatch_project_idx ON workflow_dispatch (project_id);
CREATE INDEX IF NOT EXISTS p28_learning_runs_project_idx ON learning_runs (project_id);
CREATE INDEX IF NOT EXISTS p28_memory_retrieval_events_project_idx ON memory_retrieval_events (project_id);
CREATE INDEX IF NOT EXISTS p28_optimization_recommendations_project_idx ON optimization_recommendations (project_id);
CREATE INDEX IF NOT EXISTS p28_learning_activity_project_idx ON learning_activity (project_id);
