// Phase 18 workstream B — lightweight, deterministic task understanding.
//
// Pure function: no LLM, no network, no database, no clock/random. Given the
// same query it always returns the same result. Every decision is explainable
// via the matched `signals` and the `reason` string. All text that could look
// like a credential is redacted before it is returned.

// Safety bounds. The query is capped before any regex work so pathological
// input cannot inflate cost, and output collections are bounded as well.
const QUERY_CAP = 2000;
const MAX_SIGNALS = 12;
const MAX_REASON = 300;
const CONF_DENOM = 8; // confidence = score / CONF_DENOM, clamped to [0.1, 0.95]

// Fixed category order. Also the deterministic tie-break order: when two
// categories share the top score, the one listed earlier wins.
export const CATEGORIES = Object.freeze([
  "implementation", "bugfix", "debugging", "architecture", "refactoring",
  "database", "api", "testing", "security", "documentation", "planning",
  "research", "general",
]);

// Redact credential-like material from any user-influenced string before it is
// placed in signals or the reason. Patterns cover common key/token shapes.
const REDACT_PATTERNS = [
  /\bsk-[A-Za-z0-9_\-]{6,}/gi,
  /\bBearer\s+[A-Za-z0-9._\-]{6,}/gi,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\b(api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|authorization)\b\s*[:=]\s*["']?[^\s"',;]{4,}/gi,
];
function redact(text) {
  let s = String(text ?? "");
  for (const p of REDACT_PATTERNS) s = s.replace(p, "[REDACTED]");
  return s;
}

// Weighted rules. Each rule: { label, re, weight }.
// `label` is not used for scoring; signals are the actual matched text.
const rule = (label, source, weight) => ({ label, re: new RegExp(source, "ig"), weight });

const RULES = {
  implementation: [
    rule("implement", "\\bimplement(ing|ation|ed|s)?\\b", 3),
    rule("build", "\\bbuild|builds|building\\b", 2),
    rule("add feature", "\\badd (a |the )?(new )?feature\\b", 2),
    rule("new feature", "\\bnew feature|functionality\\b", 2),
    rule("support for", "\\bsupport for\\b", 1),
  ],
  bugfix: [
    rule("fix", "\\bfix(es|ed|ing)?\\b", 3),
    rule("bug", "\\bbugs?\\b", 3),
    rule("assertion", "\\bassertion|asserts?\\b", 3),
    rule("error", "\\berrors?\\b", 2),
    rule("fails", "\\bfail(s|ed|ing|ure)?\\b", 2),
    rule("broken", "\\bbroken\\b", 2),
    rule("crash", "\\bcrash(es|ed|ing)?\\b", 2),
    rule("regression", "\\bregressions?\\b", 2),
    rule("patch", "\\bpatch(es|ed|ing)?\\b", 2),
    rule("hotfix", "\\bhotfix\\b", 3),
  ],
  debugging: [
    rule("debug", "\\bdebug(ging|ged)?\\b", 3),
    rule("trace", "\\btrace|stack trace|tracing\\b", 3),
    rule("root cause", "\\broot cause|root-cause\\b", 3),
    rule("memory leak", "\\bmemory leak|leak\\b", 3),
    rule("hanging", "\\bhang(s|ing)?|stuck|frozen\\b", 2),
    rule("reproduce", "\\breproduce|reproducible\\b", 2),
    rule("intermittent", "\\bintermittent|flaky|sporadic\\b", 2),
    rule("diagnose", "\\bdiagnose|diagnostic\\b", 2),
  ],
  architecture: [
    rule("architecture", "\\barchitecture|architectural\\b", 3),
    rule("system design", "\\bsystem design|system design\\b", 3),
    rule("microservice", "\\bmicroservices?\\b", 3),
    rule("distributed", "\\bdistributed|event-driven|event driven\\b", 2),
    rule("component", "\\bcomponent diagram|topology|components\\b", 2),
    rule("scale", "\\bscal(e|ing|ability)\\b", 1),
  ],
  refactoring: [
    rule("refactor", "\\brefactor(s|ed|ing)?\\b", 3),
    rule("rename", "\\brename(s|d|ing)?\\b", 3),
    rule("module boundaries", "\\bmodule boundaries?|module boundary\\b", 3),
    rule("clean up", "\\bclean ?up|cleanup\\b", 2),
    rule("restructure", "\\brestructure|reorganize\\b", 2),
    rule("extract method", "\\bextract method|extract function\\b", 2),
    rule("simplify", "\\bsimplify|simplification\\b", 1),
  ],
  database: [
    rule("timeout", "\\btimeout|time-out|timed out\\b", 3),
    rule("connection", "\\bconnection|connections\\b", 2),
    rule("postgres", "\\bpostgres|postgresql|psql\\b", 3),
    rule("database", "\\bdatabase|db|rdbms\\b", 3),
    rule("sql", "\\bsql\\b", 2),
    rule("migration", "\\bmigrations?\\b", 3),
    rule("redis", "\\bredis|mysql|sqlite|mongo(db)?\\b", 2),
    rule("index", "\\bindex|indexes|indices\\b", 2),
    rule("table", "\\btables?\\b", 1),
    rule("query", "\\bquer(y|ies)\\b", 1),
  ],
  api: [
    rule("api", "\\bapis?\\b", 3),
    rule("rest", "\\brest|restful\\b", 3),
    rule("graphql", "\\bgraphql\\b", 3),
    rule("endpoint", "\\bendpoints?\\b", 2),
    rule("pagination", "\\bpagination|paginate\\b", 2),
    rule("route", "\\broutes?\\b", 1),
    rule("http", "\\bhttp|https|request|response\\b", 1),
  ],
  testing: [
    rule("unit test", "\\bunit tests?\\b", 3),
    rule("integration test", "\\bintegration tests?\\b", 3),
    rule("jest", "\\bjest|vitest|mocha|jasmine\\b", 3),
    rule("test coverage", "\\btest coverage|coverage\\b", 2),
    rule("test", "\\btests?|testing\\b", 2),
    rule("spec", "\\bspecs?\\b", 1),
  ],
  security: [
    rule("sql injection", "\\bsql injection\\b", 3),
    rule("xss", "\\bxss|cross.site scripting\\b", 3),
    rule("csrf", "\\bcsrf\\b", 3),
    rule("vulnerability", "\\bvulnerabilit(y|ies)|cve\\b", 3),
    rule("security", "\\bsecurity|secure\\b", 3),
    rule("authorization", "\\bauthorization|authorize|permissions?\\b", 2),
    rule("sanitize", "\\bsanitize|escap(e|ing)\\b", 2),
    rule("auth", "\\bauth|authentication\\b", 1),
    rule("token", "\\btokens?\\b", 1),
  ],
  documentation: [
    rule("document", "\\bdocument(s|ed|ing|ation)?\\b", 3),
    rule("readme", "\\breadme\\b", 3),
    rule("architecture docs", "\\barchitecture docs?|architecture documentation\\b", 3),
    rule("docs", "\\bdocs?\\b", 2),
    rule("user guide", "\\buser guide|guide|changelog\\b", 2),
    rule("docstring", "\\bdocstring|jsdoc|comment(s)?\\b", 2),
  ],
  planning: [
    rule("plan", "\\bplan(s|ning|ned)?\\b", 3),
    rule("roadmap", "\\broadmap\\b", 3),
    rule("milestone", "\\bmilestones?\\b", 3),
    rule("implementation plan", "\\bimplementation plan|task breakdown\\b", 3),
    rule("next steps", "\\bnext steps\\b", 2),
    rule("schedule", "\\bschedule|timeline|estimate\\b", 2),
  ],
  research: [
    rule("research", "\\bresearch\\b", 3),
    rule("investigate", "\\binvestigate|explore|look into\\b", 3),
    rule("comparison", "\\bcompar(e|ison|ing)|versus|vs\\b", 2),
    rule("alternatives", "\\balternatives?\\b", 2),
    rule("survey", "\\bsurvey|benchmark|study\\b", 2),
  ],
  general: [], // pure fallback — never scores
};

// Query-level retrieval boosts. Matching any of these forces the corresponding
// retrieve flag on, regardless of the chosen category. Notably "why/decision/
// chose/alternative" keeps historical decisions available.
const FLAG_RULES = {
  decisions: /\b(why|decision|decided|chose|chosen|alternative|rationale|tradeoffs?|reconsider|because)\b/i,
  fixes: /\b(fix|fixes|bug|error|fails|failing|patch|workaround|hotfix|regression|broken)\b/i,
  verification: /\b(test|tests|verify|assertion|coverage|validate|confirm|check)\b/i,
  relationships: /\b(module|modules|dependency|dependencies|relation|relationships|integrate|impact|connect|coupling)\b/i,
  projectFacts: /\b(project|context|config|convention|conventions|stack|schema|settings)\b/i,
};

// Per-category retrieval defaults. Every value is a plain boolean; `general`
// deliberately enables everything as the safe fallback.
const BASE_RETRIEVE = Object.freeze({
  implementation: { projectFacts: true, decisions: true, fixes: false, relationships: true, verification: true },
  bugfix:         { projectFacts: true, decisions: false, fixes: true,  relationships: true, verification: true },
  debugging:      { projectFacts: true, decisions: false, fixes: true,  relationships: true, verification: true },
  architecture:   { projectFacts: true, decisions: true, fixes: false, relationships: true, verification: false },
  refactoring:    { projectFacts: true, decisions: true, fixes: false, relationships: true, verification: true },
  database:       { projectFacts: true, decisions: false, fixes: false, relationships: false, verification: true },
  api:            { projectFacts: true, decisions: true, fixes: false, relationships: true, verification: false },
  testing:        { projectFacts: true, decisions: false, fixes: true,  relationships: false, verification: true },
  security:       { projectFacts: true, decisions: true, fixes: false, relationships: true, verification: true },
  documentation:  { projectFacts: true, decisions: true, fixes: false, relationships: true, verification: false },
  planning:       { projectFacts: true, decisions: true, fixes: false, relationships: true, verification: false },
  research:       { projectFacts: true, decisions: false, fixes: false, relationships: true, verification: false },
  general:        { projectFacts: true, decisions: true, fixes: true,  relationships: true, verification: true },
});

const round2 = (n) => Math.round(n * 100) / 100;

function safeDefault() {
  return {
    ok: true,
    category: "general",
    confidence: 0.1,
    signals: [],
    retrieve: { projectFacts: true, decisions: true, fixes: true, relationships: true, verification: true },
    reason: "Safe fallback: classification could not be completed; using general defaults with all retrieval flags enabled at low confidence.",
  };
}

/**
 * Deterministically classify a task query.
 * @param {{query?: string, project_id?: string, session_id?: string}} [options]
 * @returns {{ok: boolean, category: string, confidence: number, signals: string[],
 *            retrieve: {projectFacts: boolean, decisions: boolean, fixes: boolean,
 *            relationships: boolean, verification: boolean}, reason: string}}
 */
export function classifyTask(options = {}) {
  try {
    // Tolerate malformed callers (null, strings, arrays, objects with hostile
    // toString). project_id/session_id are accepted for API symmetry but never
    // echoed, so no identifier can leak into the output.
    const input = options && typeof options === "object" ? options : {};
    let raw = input.query;
    if (raw === undefined || raw === null) raw = "";
    let q;
    try { q = typeof raw === "string" ? raw : String(raw); } catch { q = ""; }
    q = q.slice(0, QUERY_CAP).toLowerCase().replace(/\s+/g, " ").trim();

    if (!q) return safeDefault();

    const scores = Object.create(null);
    for (const c of CATEGORIES) scores[c] = 0;
    const signals = [];
    const seen = new Set();

    for (const cat of CATEGORIES) {
      if (cat === "general") continue;
      for (const r of RULES[cat]) {
        const matches = q.match(r.re);
        if (!matches) continue;
        scores[cat] += r.weight;
        for (const hit of matches) {
          const s = redact(String(hit).toLowerCase());
          if (s && !seen.has(s)) { seen.add(s); signals.push(s); }
        }
      }
    }

    // Pick the highest score; strict '>' over the fixed CATEGORIES order makes
    // ties resolve deterministically to the earlier category.
    let category = "general";
    let best = 0;
    for (const cat of CATEGORIES) {
      if (cat === "general") continue;
      if (scores[cat] > best) { best = scores[cat]; category = cat; }
    }

    const noMatch = best <= 0;
    if (noMatch) category = "general";

    const confidence = noMatch
      ? 0.1
      : round2(Math.min(0.95, Math.max(0.1, best / CONF_DENOM)));

    // Retrieve flags: category baseline, then query-driven boosts.
    const base = BASE_RETRIEVE[category] || BASE_RETRIEVE.general;
    const retrieve = {
      projectFacts: base.projectFacts,
      decisions: base.decisions,
      fixes: base.fixes,
      relationships: base.relationships,
      verification: base.verification,
    };
    for (const [flag, re] of Object.entries(FLAG_RULES)) {
      if (re.test(q)) retrieve[flag] = true;
    }

    const boundedSignals = signals.slice(0, MAX_SIGNALS);
    const enabled = Object.entries(retrieve).filter(([, v]) => v).map(([k]) => k).join(", ");
    let reason = noMatch
      ? "No category-specific signals matched; using safe general defaults with all retrieval flags enabled and low confidence."
      : `Matched ${signals.length} signal(s) for category '${category}' (score ${best}); retrieve: ${enabled}.`;
    reason = redact(reason).slice(0, MAX_REASON);

    return { ok: true, category, confidence, signals: boundedSignals, retrieve, reason };
  } catch {
    return safeDefault();
  }
}

/** Classify a list of queries. Always returns a bounded, ok:true envelope. */
export function classifyBatch(queries = []) {
  try {
    const arr = Array.isArray(queries) ? queries : [];
    const results = arr.map((q) => classifyTask({ query: q }));
    return { ok: true, count: results.length, results };
  } catch {
    return { ok: true, count: 0, results: [] };
  }
}

export default { CATEGORIES, classifyTask, classifyBatch };
