// Phase 6: cross-session pattern detection, strategy tracking, learning trends.
import crypto from "node:crypto";
import * as core from "./core.js";

const RULES = [
  { kind: "user_preference", re: /\b(always|never|prefer|do not|don't|must|should not)\b/i,
    improve: "Record as a durable user preference and apply it in future sessions." },
  { kind: "successful_solution", re: /\b(fixed|resolved|solution|solved by|works now)\b/i,
    improve: "Reuse this verified approach for similar failures." },
  { kind: "repeated_failure", re: /\b(error|failed|exception|traceback|bug|crash)\b/i,
    improve: "Check for this failure early and apply the known remedy before repeating the attempt." },
  { kind: "debugging_pattern", re: /\b(error|failed).{0,100}\b(fixed|resolved|because|caused by)\b/i,
    improve: "Use the observed cause -> fix sequence as a debugging checklist." },
  { kind: "workflow_inefficiency", re: /\b(again|repeatedly|still failing|trying|retried|over and over)\b/i,
    improve: "Stop retrying the same step; switch strategy after the first repeated failure." },
  { kind: "historical_decision", re: /\b(decided|chose|agreed to|went with)\b/i,
    improve: "Preserve this decision and its context for future architecture work." },
  { kind: "project_experience", re: /\b(architecture|schema|migration|convention|dependency|config)\b/i,
    improve: "Treat as project-specific experience; confirm before reusing in another project." },
];

const STOPWORDS = new Set(`the a an and or but if then than that this these those is are was were be been being
  to of in on at by for from with without into over under as it its it's i we you he she they them their our your
  not no yes do does did done have has had can could should would will want need may must about after before when
  while just so such very more most other some any all one two use used using get got make made run running
  there here what which who whom why how because also however only even still`.split(/\s+/));

function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{16,}/gi, "<id>")
    .replace(/[a-z]:[\\/][^\s,;)]+/gi, "<path>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function clusterKey(kind, line) {
  const tokens = normalize(line)
    .split(/\s+/)
    .filter((t) => t.length > 3 && !STOPWORDS.has(t) && !t.startsWith("<"))
    .sort()
    .slice(0, 6);
  return tokens.length ? `${kind}:${tokens.join("|")}` : `${kind}:${normalize(line).slice(0, 80)}`;
}

function sentences(summary) {
  return String(summary || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12 && s.length < 600)
    .slice(0, 40);
}

function detectKind(line) {
  for (const r of RULES) if (r.re.test(line)) return r;
  return null;
}

export async function analyzePatterns({ limit = 200, project_id, force = false } = {}) {
  const sessions = (await core.dbQuery(
    `SELECT id, project_id, title, summary, message_count, time_updated FROM session_index
     WHERE ($1::text IS NULL OR project_id=$1)
     ORDER BY time_updated DESC NULLS LAST LIMIT $2`,
    [project_id || null, Math.min(limit, 500)],
  )).rows;

  let analyzed = 0, skipped = 0, signals = 0;
  for (const s of sessions) {
    const hash = crypto.createHash("sha256")
      .update(`${s.title}|${s.summary}|${s.message_count}|${s.time_updated}`)
      .digest("hex");
    const prev = await core.dbQuery("SELECT content_hash FROM analysis_state WHERE session_id=$1", [s.id]);
    if (!force && prev.rows[0]?.content_hash === hash) { skipped++; continue; }

    const pid = s.project_id || "_global";
    for (const line of sentences(s.summary)) {
      const rule = detectKind(line);
      if (!rule) continue;
      const key = clusterKey(rule.kind, line);
      if (key.length < 15) continue;
      const evidence = JSON.stringify([{ session: s.id, project: pid, excerpt: line.slice(0, 400), observed_at: new Date().toISOString() }]);
      const verified = rule.kind === "successful_solution" || rule.kind === "historical_decision";
      const r = await core.dbQuery(
        `INSERT INTO pattern (kind, pattern_key, description, occurrences, sessions, projects, evidence,
            confidence, verified, suggested_improvement, first_observed, last_observed)
         VALUES ($1,$2,$3,1,ARRAY[$4]::text[],ARRAY[$5]::text[],$6::jsonb,$7,$8,$9,now(),now())
         ON CONFLICT (kind, pattern_key) DO UPDATE SET
           occurrences = pattern.occurrences + 1,
           sessions = CASE WHEN $4 = ANY(pattern.sessions) THEN pattern.sessions ELSE array_append(pattern.sessions,$4) END,
           projects = CASE WHEN $5 = ANY(pattern.projects) THEN pattern.projects ELSE array_append(pattern.projects,$5) END,
           evidence = pattern.evidence || $6::jsonb,
           confidence = LEAST(0.95, 0.5 + 0.1 * (pattern.occurrences + 1)),
           verified = pattern.verified OR $8,
           last_observed = now(), updated_at = now()
         RETURNING id, occurrences`,
        [rule.kind, key, line.slice(0, 300), s.id, pid, evidence,
         verified ? 0.75 : 0.55, verified, rule.improve],
      );
      await core.dbQuery(
        `INSERT INTO pattern_evidence (pattern_id, session_id, project_id, excerpt) VALUES ($1,$2,$3,$4)`,
        [r.rows[0].id, s.id, pid, line.slice(0, 400)],
      );
      signals++;
    }
    await core.dbQuery(
      `INSERT INTO analysis_state (session_id, source_updated, content_hash, analyzed_at)
       VALUES ($1,$2,$3,now()) ON CONFLICT (session_id) DO UPDATE SET
       source_updated=EXCLUDED.source_updated, content_hash=EXCLUDED.content_hash, analyzed_at=now()`,
      [s.id, s.time_updated || null, hash],
    );
    await core.audit("pattern.session_analyzed", s.id, { signals: signals });
    analyzed++;
  }

  const strategies = await buildStrategyExperiments(project_id);
  await core.audit("pattern.analysis_run", "all", { sessions_seen: sessions.length, analyzed, skipped, signals, strategies });
  return { ok: true, sessions_seen: sessions.length, sessions_analyzed: analyzed, sessions_skipped: skipped, signals, strategies };
}

async function buildStrategyExperiments(project_id) {
  const attempts = (await core.dbQuery(
    `SELECT id, project_id, title, content, confidence, source_session FROM memory
     WHERE source_kind='attempt' AND ($1::text IS NULL OR project_id=$1)`, [project_id || null],
  )).rows;
  const wins = (await core.dbQuery(
    `SELECT id, project_id, title, content, confidence, source_session FROM memory
     WHERE source_kind='verified' AND ($1::text IS NULL OR project_id=$1)`, [project_id || null],
  )).rows;
  let created = 0;
  for (const a of attempts) {
    for (const w of wins) {
      if (a.project_id !== w.project_id) continue;
      const ta = new Set(normalize(a.content).split(" ").filter((x) => x.length > 4));
      const tw = normalize(w.content).split(" ").filter((x) => x.length > 4);
      const overlap = tw.filter((x) => ta.has(x)).length / Math.max(1, tw.length);
      if (overlap < 0.25) continue;
      const exists = await core.dbQuery(
        `SELECT 1 FROM strategy_experiment WHERE project_id=$1 AND previous_approach=$2 AND alternative_approach=$3`,
        [a.project_id, a.content, w.content],
      );
      if (exists.rowCount) continue;
      await core.dbQuery(
        `INSERT INTO strategy_experiment (project_id, previous_approach, alternative_approach, result,
           effort, errors, successful, confidence, evidence_sessions)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,true,$7,$8)`,
        [a.project_id, a.content, w.content, `Verified solution: ${w.title}`, "not measured",
         JSON.stringify([a.title]), Math.max(a.confidence, w.confidence),
         [a.source_session, w.source_session].filter(Boolean)],
      );
      await core.audit("learning.strategy", a.id, { alternative: w.id });
      created++;
    }
  }
  return created;
}

export async function listPatterns({ kind, project_id, limit = 50, min_occurrences = 1 } = {}) {
  const r = await core.dbQuery(
    `SELECT * FROM pattern
     WHERE ($1::text IS NULL OR kind=$1)
       AND ($2::text IS NULL OR $2 = ANY(projects) OR 'global' = ANY(projects))
       AND occurrences >= $3
     ORDER BY occurrences DESC, last_observed DESC LIMIT $4`,
    [kind || null, project_id || null, min_occurrences, Math.min(limit, 200)],
  );
  return r.rows;
}

export async function analytics(days = 30) {
  const one = async (sql, params = []) => (await core.dbQuery(sql, params)).rows[0];
  const totals = await one(
    `SELECT (SELECT count(*)::int FROM session_index) AS sessions,
            (SELECT count(*)::int FROM memory) AS memories,
            (SELECT count(*)::int FROM pattern) AS patterns,
            (SELECT count(*)::int FROM pattern WHERE verified) AS verified_patterns,
            (SELECT count(*)::int FROM learning_activity) AS learning_events,
            (SELECT count(*)::int FROM strategy_experiment) AS strategies`,
  );
  const repeatedMistakes = await one(`SELECT count(*)::int AS n FROM pattern WHERE kind IN ('repeated_failure','workflow_inefficiency') AND occurrences>1`);
  const solutions = await one(`SELECT count(*)::int AS n FROM pattern WHERE kind='successful_solution'`);
  const trend = (await core.dbQuery(
    `SELECT to_char(date_trunc('day', created_at),'YYYY-MM-DD') AS day, count(*)::int AS n
     FROM learning_activity WHERE created_at > now() - ($1::int || ' days')::interval
     GROUP BY 1 ORDER BY 1`, [days],
  )).rows;
  return { ok: true, ...totals, repeated_mistakes: repeatedMistakes.n, successful_solutions: solutions.n, trend };
}

export async function learningActivity({ limit = 50, session_id, action } = {}) {
  return (await core.dbQuery(
    `SELECT id, session_id, project_id, action, memory_id, reason, detail, created_at
     FROM learning_activity
     WHERE ($1::text IS NULL OR session_id=$1) AND ($2::text IS NULL OR action=$2)
     ORDER BY created_at DESC LIMIT $3`,
    [session_id || null, action || null, Math.min(limit, 200)],
  )).rows;
}
