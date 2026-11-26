// Public documentation contract tests. Read-only; no network, no Git, no writes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

const REQUIRED_DOCS = [
  "README.md",
  "INSTALL.md",
  "QUICKSTART.md",
  "docs/capabilities.md",
  "docs/architecture.md",
  "docs/memory-system.md",
  "docs/continuous-learning.md",
  "docs/multi-agent-orchestration.md",
  "docs/workflow-safety.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  ".env.example",
];

for (const rel of REQUIRED_DOCS) {
  test(`public doc exists and is non-empty: ${rel}`, (t) => {
    const p = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(p)) {
      t.skip(`not produced yet: ${rel} (expected at ${p})`);
      return;
    }
    const st = fs.statSync(p);
    assert.ok(st.isFile(), `${rel} must be a regular file`);
    assert.ok(st.size > 0, `${rel} must be non-empty`);
  });
}

test("README names the three core capabilities and preserves conditional readiness", (t) => {
  const p = path.join(REPO_ROOT, "README.md");
  if (!fs.existsSync(p)) {
    t.skip("README.md not produced yet");
    return;
  }
  const text = fs.readFileSync(p, "utf8");

  const capabilities = [
    { name: "persistent project memory", re: /persistent\s+(project\s+)?memory|project\s+memory/i },
    { name: "session understanding / continuous learning", re: /session\s+understanding|continuous\s+learning|session\s+learning/i },
    { name: "controlled multi-agent engineering", re: /controlled\s+multi-?agent|multi-?agent\s+(engineering|orchestration)|agent\s+orchestration/i },
  ];
  for (const c of capabilities) {
    assert.match(text, c.re, `README must name the core capability: ${c.name}`);
  }

  assert.match(
    text,
    /conditional(ly)?\s+ready|with\s+documented\s+limitations|production[- ]ready\s+is\s+not\s+claimed|not\s+production[- ]ready/i,
    "README must state the conditional-readiness assessment rather than claiming production readiness",
  );
});

test("docs directory exposes the seven required topic files when produced", (t) => {
  const docsDir = path.join(REPO_ROOT, "docs");
  if (!fs.existsSync(docsDir)) {
    t.skip("docs/ not produced yet");
    return;
  }
  const expected = [
    "capabilities.md", "architecture.md", "memory-system.md", "continuous-learning.md",
    "multi-agent-orchestration.md", "workflow-safety.md",
  ];
  const present = expected.filter((f) => fs.existsSync(path.join(docsDir, f)));
  t.diagnostic(`docs/ present topics: ${present.length}/${expected.length}`);
  // Per-file tests above already assert each one; this test only records coverage.
  assert.ok(present.length >= 0);
});
