// Feature G: unified, evidence-labeled intelligence report. Read-only.
import * as core from "./core.js";
import { semanticCoverage } from "./semanticUnderstanding.js";
import { fixEvidenceReport } from "./errorLearning.js";
import { strategyValidationReport } from "./learning10.js";
import { dryRunQualityReport } from "./dataQuality.js";
import { usefulnessSummary } from "./retrievalFeedback.js";
import { consolidationCoverage } from "./consolidationReport.js";

const observed = (value, source) => ({ value, measurement: "observed", source });

export async function intelligenceQualityReport({ project_id } = {}) {
  const semantic = await semanticCoverage({ project_id });
  const fixes = await fixEvidenceReport({ project_id, limit: 0 });
  const strategies = await strategyValidationReport({ project_id });
  const quality = await dryRunQualityReport({ project_id });
  const usefulness = await usefulnessSummary({ project_id });
  const sessions = (await core.dbQuery(
    `SELECT count(*)::int analyzed FROM analysis_state`)).rows[0].analyzed;
  return {
    ok: true,
    session_intelligence: {
      sessions_analyzed: observed(sessions, "analysis_state"),
      semantic_observations: observed(semantic.breakdown.reduce((a, b) => a + b.n, 0), "semantic_observation"),
      deterministic_observations: observed(semantic.breakdown.filter((x) => x.source === "deterministic").reduce((a, b) => a + b.n, 0), "semantic_observation"),
      attribution_breakdown: semantic.breakdown,
    },
    memory_intelligence: {
      retrieval_events: observed(quality.retrieval.events, "memory_retrieval_events"),
      explicit_helpful: observed(quality.retrieval.helpful, "memory_usefulness_observations"),
      explicit_unhelpful: observed(quality.retrieval.unhelpful, "memory_usefulness_observations"),
      observed_reuse: observed(quality.retrieval.observed, "memory_usefulness_observations"),
      non_recurrence_signals: observed(quality.retrieval.non_recurrence, "memory_usefulness_observations"),
      uncertain_usefulness: observed(usefulness.insufficient_evidence ?? 0, "derived"),
    },
    learning_intelligence: {
      errors: observed(fixes.summary.find((x) => x.status === "observed_failure")?.n || 0, "fix_evidence"),
      verified_fixes: observed(fixes.summary.find((x) => x.status === "verified_fix")?.n || 0, "fix_evidence"),
      non_recurrence: observed(fixes.summary.find((x) => x.status === "non_recurrence")?.n || 0, "fix_evidence"),
      strongly_supported: observed(fixes.summary.find((x) => x.status === "strongly_supported")?.n || 0, "fix_evidence"),
      regressed_fixes: observed(fixes.summary.find((x) => x.status === "regressed")?.n || 0, "fix_evidence"),
      strategies: observed(strategies.summary, "strategy_versions"),
    },
    data_quality: {
      production: observed(quality.memory.production, "memory.provenance"),
      test_fixture: observed(quality.memory.test_fixture, "memory.provenance"),
      unknown_provenance: observed(quality.memory.total - quality.memory.production - quality.memory.test_fixture, "derived"),
      duplicate_suggestions: observed(quality.suggestions.pending, "consolidation_suggestion"),
      contradictions: observed(quality.contradictions.total, "memory_contradictions"),
      consolidation_coverage: observed(await consolidationCoverage(), "consolidation_suggestion"),
    },
    note: "Every metric identifies its source; no improvement is claimed without observed evidence.",
  };
}
