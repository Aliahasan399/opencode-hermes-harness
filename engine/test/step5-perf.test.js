import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ENGINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ENGINE_DIR, "scripts", "step5-perf.mjs");

async function runBenchmark(inputs) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT], {
    cwd: ENGINE_DIR,
    env: {
      ...process.env,
      HARNESS_PERF_MODE: "mock",
      HARNESS_PERF_INPUTS: inputs,
    },
    timeout: 8000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(stderr, "");
  return JSON.parse(stdout);
}

test("mock benchmark emits one credential-free, measured sample per bounded size", { timeout: 10000 }, async () => {
  const report = await runBenchmark("8,16,24");

  assert.deepEqual(Object.keys(report).sort(), ["mode", "note", "samples", "summary"]);
  assert.equal(report.mode, "mock");
  assert.match(report.note, /real mode uses actual OpenCode auth/i);
  assert.deepEqual(Object.keys(report.summary).sort(), ["max_ms", "mean_ms", "min_ms"]);
  assert.equal(report.samples.length, 3);
  assert.deepEqual(report.samples.map((sample) => sample.input_chars), [8, 16, 24]);
  for (const sample of report.samples) {
    assert.deepEqual(Object.keys(sample).sort(), ["input_chars", "kind", "ok", "output", "usage", "wall_ms"]);
    assert.equal(sample.ok, true);
    assert.equal(sample.kind, "success");
    assert.equal(typeof sample.wall_ms, "number");
    assert.ok(sample.wall_ms >= 0);
    assert.deepEqual(sample.usage, { input: 7, output: 3 });
    assert.deepEqual(sample.output, { language: "en", category: "technical_knowledge", confidence: 0.9 });
  }
  const times = report.samples.map((sample) => sample.wall_ms);
  assert.equal(report.summary.min_ms, Math.min(...times));
  assert.equal(report.summary.max_ms, Math.max(...times));
  assert.ok(Number.isFinite(report.summary.mean_ms));
  assert.ok(!JSON.stringify(report).includes("step5-perf-dummy-credential"));
});

test("benchmark rejects input sizes above the documented maximum", { timeout: 5000 }, async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [SCRIPT], {
      cwd: ENGINE_DIR,
      env: { ...process.env, HARNESS_PERF_MODE: "mock", HARNESS_PERF_INPUTS: "10001" },
      timeout: 3000,
      maxBuffer: 1024 * 1024,
    }),
    (error) => error.code === 1 && /between 1 and 10000/i.test(error.stderr),
  );
});

test("benchmark rejects too many incremental sizes", { timeout: 5000 }, async () => {
  const inputs = Array.from({ length: 21 }, (_, index) => index + 1).join(",");
  await assert.rejects(
    execFileAsync(process.execPath, [SCRIPT], {
      cwd: ENGINE_DIR,
      env: { ...process.env, HARNESS_PERF_MODE: "mock", HARNESS_PERF_INPUTS: inputs },
      timeout: 3000,
      maxBuffer: 1024 * 1024,
    }),
    (error) => error.code === 1 && /at most 20/i.test(error.stderr),
  );
});
