// proj perf / bench: per-test-file, job and workflow durations with billed runner-minutes; measured
// benchmarks of parallelism and sharding variants before anyone adopts them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { die, ghJson, now, out, warn, short, table, repoContext, headSha, dirtyFiles } from './core.js';

// ---------- JUnit (node --test junit reporter, pytest --junitxml): seconds per test file ----------
// Per-file time comes from top-level elements that carry file= (node >= 24: a describe's <testsuite> time
// includes its hooks and children); otherwise from leaf testcases (pytest xunit1/2, node 22).
export function parseJunit(xml, root = '') {
  const r = root.replace(/\\/g, '/').replace(/\/?$/, '/');
  const fileOf = (attr) => {
    // node >= 24 writes file=; pytest writes a dotted module classname; anything else stays as reported
    let f = attr.file || (/^\w+(\.\w+)+$/.test(attr.classname || '') ? attr.classname.replace(/\./g, '/') + '.py' : attr.classname || 'unknown');
    f = f.replace(/\\/g, '/');
    return root && f.toLowerCase().startsWith(r.toLowerCase()) ? f.slice(r.length) : f;
  };
  const top = {}; const leaf = {};
  let tests = 0; let depth = 0; let topHasFile = false;
  // quote-aware: node does not escape '>' inside attribute values
  for (const m of xml.matchAll(/<(\/?)(testsuites|testsuite|testcase)\b((?:[^>"]|"[^"]*")*?)(\/?)>/g)) {
    const [, close, tag, rawAttrs, selfClose] = m;
    if (close) { depth--; continue; }
    const attr = Object.fromEntries([...rawAttrs.matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
    if (tag === 'testcase') { tests++; leaf[fileOf(attr)] = (leaf[fileOf(attr)] || 0) + Number(attr.time || 0); }
    if (depth === 1 && tag !== 'testsuites' && attr.file) { topHasFile = true; top[fileOf(attr)] = (top[fileOf(attr)] || 0) + Number(attr.time || 0); }
    if (!selfClose) depth++;
  }
  return { files: topHasFile ? { ...leaf, ...top } : leaf, tests }; // top-level time wins where it exists
}

// Commands may carry {junit}: proj substitutes a temp path and reads per-file timings back.
export function withJunit(cmd) {
  if (!cmd.includes('{junit}')) return { cmd, file: null };
  const file = path.join(os.tmpdir(), `proj-junit-${process.pid}-${Date.now()}.xml`);
  return { cmd: cmd.replaceAll('{junit}', `"${file}"`), file };
}
export function readJunit(file, root) {
  if (!file || !fs.existsSync(file)) return null;
  try { return parseJunit(fs.readFileSync(file, 'utf8'), root); } finally { fs.rmSync(file, { force: true }); }
}

const profileFile = (ctx) => path.join(ctx.stateDir, 'profile.jsonl');
export function recordProfile(ctx, entry) {
  const f = profileFile(ctx);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const lines = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
  lines.push(JSON.stringify(entry));
  fs.writeFileSync(f, lines.slice(-500).join('\n') + '\n');
}
export const loadProfile = (ctx) => (fs.existsSync(profileFile(ctx)) ? fs.readFileSync(profileFile(ctx), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; };
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : 0; };

// Slowest files of the latest full run and files that got slower than their own recent median.
export function localReport(entries) {
  const full = entries.filter((e) => e.kind === 'full' && e.files);
  const last = full.at(-1);
  const slowest = last ? Object.entries(last.files).sort((a, b) => b[1] - a[1]).slice(0, 8) : [];
  const regressions = [];
  if (last) {
    for (const [file, secs] of Object.entries(last.files)) {
      const hist = full.slice(-6, -1).map((e) => e.files[file]).filter((x) => x != null);
      const base = median(hist);
      if (hist.length >= 2 && secs > 0.5 && secs > base * 1.5) regressions.push({ file, secs, base });
    }
  }
  const byKind = {};
  for (const e of entries) (byKind[e.kind] ||= []).push(e.secs);
  return { last, slowest, regressions, kinds: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, { runs: v.length, median: median(v), p95: pct(v, 0.95) }])) };
}

// ---------- GitHub Actions: job/step durations and billed minutes ----------
// Included-minute multipliers for private repos; self-hosted runners bill nothing.
export function multiplier(labels = [], runnerName = '') {
  const l = labels.map((x) => x.toLowerCase());
  if (l.includes('self-hosted') || /^proj-/.test(runnerName || '')) return 0;
  if (l.some((x) => x.startsWith('macos'))) return 10;
  if (l.some((x) => x.startsWith('windows'))) return 2;
  return 1;
}
const secsBetween = (a, b) => (a && b ? Math.max(0, (Date.parse(b) - Date.parse(a)) / 1000) : 0);

export function analyzeRuns(runs) {
  const jobs = [];
  for (const r of runs) for (const j of r.jobs || []) {
    if (!j.started_at || !j.completed_at || j.conclusion === 'skipped') continue;
    const secs = secsBetween(j.started_at, j.completed_at);
    const mult = r.event === 'dynamic' ? 0 : multiplier(j.labels, j.runner_name); // Dependabot's own update jobs are free
    const testsRan = (j.steps || []).some((s) => /test|check|pytest|verify suite/i.test(s.name) && ['success', 'failure'].includes(s.conclusion));
    jobs.push({ run: r.id, workflow: r.name, sha: r.head_sha, event: r.event, job: j.name, conclusion: j.conclusion, secs, billed: Math.ceil(secs / 60) * mult, mult, testsRan,
      steps: (j.steps || []).map((s) => ({ name: s.name, secs: secsBetween(s.started_at, s.completed_at), conclusion: s.conclusion })) });
  }
  const totalBilled = jobs.reduce((a, j) => a + j.billed, 0);
  // repeated work: the same workflow+job really ran its tests more than once for one SHA
  const seen = {};
  for (const j of jobs.filter((x) => x.testsRan && x.conclusion === 'success')) (seen[`${j.workflow}/${j.job}@${j.sha}`] ||= []).push(j);
  const duplicates = Object.entries(seen).filter(([, v]) => v.length > 1).map(([k, v]) => ({ key: k, runs: v.length, wasted: v.slice(1).reduce((a, j) => a + j.billed, 0) }));
  const cancelled = jobs.filter((j) => j.conclusion === 'cancelled').reduce((a, j) => a + j.billed, 0);
  const byJob = {};
  for (const j of jobs) (byJob[`${j.workflow}/${j.job}`] ||= []).push(j);
  const jobStats = Object.entries(byJob).map(([k, v]) => {
    const ok = v.filter((j) => j.conclusion === 'success' && j.testsRan).map((j) => j.secs);
    const recent = ok.slice(0, 5); const older = ok.slice(5, 10);
    return { job: k, runs: v.length, billed: v.reduce((a, j) => a + j.billed, 0), median: median(ok), p95: pct(ok, 0.95),
      regression: older.length >= 3 && recent.length >= 3 && median(recent) > median(older) * 1.3 ? { now: median(recent), before: median(older) } : null };
  }).sort((a, b) => b.billed - a.billed);
  const stepTotals = {};
  for (const j of jobs) for (const s of j.steps) stepTotals[`${j.job}: ${s.name}`] = (stepTotals[`${j.job}: ${s.name}`] || 0) + s.secs * (j.mult || 1);
  const steps = Object.entries(stepTotals).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const wall = runs.filter((r) => r.run_started_at && r.updated_at && r.conclusion !== 'skipped').map((r) => secsBetween(r.run_started_at, r.updated_at));
  return { jobs: jobs.length, totalBilled, duplicates, cancelled, jobStats, steps, wallMedian: median(wall) };
}

// timeout-minutes per job from the workflow files, to compare with observed p95.
export function workflowTimeouts(root) {
  const dir = path.join(root, '.github', 'workflows');
  const res = {};
  if (!fs.existsSync(dir)) return res;
  for (const f of fs.readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n?/g, '\n'); // CRLF checkouts
    const wf = (text.match(/^name:\s*(.+)$/m) || [])[1]?.trim() || f;
    for (const m of text.matchAll(/^ {2}([\w-]+):\n(?:(?: {4}.*)?\n)*? {4}timeout-minutes:\s*(\d+)/gm)) res[`${wf}/${m[1]}`] = Number(m[2]);
  }
  return res;
}

export function opportunities(ci, timeouts, local) {
  const ops = [];
  for (const d of ci.duplicates) ops.push({ minutes: d.wasted, what: `${d.key} ran its full tests ${d.runs}x for one SHA`, fix: 'keep the reuse step in CI; avoid re-dispatching a verified SHA' });
  if (ci.cancelled) ops.push({ minutes: ci.cancelled, what: 'minutes billed to cancelled runs', fix: 'push in batches; keep PRs as drafts until the final SHA' });
  for (const j of ci.jobStats) {
    const t = timeouts[j.job];
    if (t && j.p95 && t * 60 > j.p95 * 4 && t > 5) ops.push({ minutes: 0, what: `${j.job}: timeout ${t} min vs p95 ${Math.ceil(j.p95 / 60)} min`, fix: `set timeout-minutes: ${Math.max(5, Math.ceil((j.p95 * 2) / 60))} so a hang costs less` });
    if (j.regression) ops.push({ minutes: Math.ceil((j.regression.now - j.regression.before) / 60) * j.runs, what: `${j.job} slowed from ${Math.round(j.regression.before)}s to ${Math.round(j.regression.now)}s`, fix: 'compare per-file timings (proj perf) around the change' });
  }
  for (const [name, secs] of ci.steps.slice(0, 3)) if (/install|setup|npm ci|pip/i.test(name) && secs > 120) ops.push({ minutes: Math.round(secs / 60), what: `step "${name}" costs ${Math.round(secs / 60)} min in total`, fix: 'benchmark caching with proj bench before adopting it' });
  for (const r of local?.regressions || []) ops.push({ minutes: 0, what: `${r.file} now ${r.secs.toFixed(1)}s (median ${r.base.toFixed(1)}s)`, fix: 'look at the latest change to that file or its fixtures' });
  return ops.sort((a, b) => b.minutes - a.minutes);
}

function fetchRuns(ctx, n) {
  const runs = ghJson(['api', `repos/${ctx.remote.slug}/actions/runs?per_page=${n}`])?.workflow_runs || [];
  for (const r of runs) r.jobs = ghJson(['api', `repos/${ctx.remote.slug}/actions/runs/${r.id}/jobs?per_page=100`])?.jobs || [];
  return runs;
}

export function cmdPerf(opts) {
  const ctx = repoContext();
  const local = localReport(loadProfile(ctx));
  const ci = ctx.remote?.slug && !opts.offline ? analyzeRuns(fetchRuns(ctx, Number(opts.runs || 20))) : null;
  const ops = opportunities(ci || { duplicates: [], cancelled: 0, jobStats: [], steps: [] }, workflowTimeouts(ctx.mainRoot), local);
  if (opts.json) return out(JSON.stringify({ local, ci, opportunities: ops }, null, 2));
  out('Local checks (proj check):');
  const kinds = Object.entries(local.kinds);
  out(kinds.length ? table([['kind', 'runs', 'median s', 'p95 s'], ...kinds.map(([k, v]) => [k, v.runs, v.median, v.p95])]) : '  none recorded yet (run proj check)');
  if (local.slowest.length) out(`Slowest test files (last full run at ${short(local.last.sha)}):\n${local.slowest.map(([f, s]) => `  ${s.toFixed(2)}s  ${f}`).join('\n')}`);
  if (ci) {
    out(`\nGitHub Actions, last ${opts.runs || 20} runs: ${ci.totalBilled} billed min over ${ci.jobs} job(s), median workflow wall ${Math.round(ci.wallMedian)}s`);
    out(table([['job', 'runs', 'billed min', 'median s', 'p95 s'], ...ci.jobStats.map((j) => [j.job, j.runs, j.billed, Math.round(j.median), Math.round(j.p95)])]));
    if (ci.steps.length) out(`Costliest steps:\n${ci.steps.map(([n, s]) => `  ${Math.round(s)}s  ${n}`).join('\n')}`);
  }
  out(`\nOpportunities:${ops.length ? '' : ' none found'}`);
  for (const o of ops.slice(0, 5)) out(`  ${o.minutes ? `~${o.minutes} min: ` : ''}${o.what} -> ${o.fix}`);
}

// ---------- proj bench: measure before adopting parallelism / sharding / caching changes ----------
function timeRun(cmd, cwd) {
  const { cmd: c, file } = withJunit(cmd);
  const t0 = process.hrtime.bigint();
  const r = spawnSync(c, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  const j = readJunit(file, cwd);
  return { ok: r.status === 0, secs, tests: j?.tests ?? null };
}

// CI estimate for a variant split into k shards: each shard is a job that pays setup and rounds up.
export function estimate(shardSecs, setupSecs) {
  const wall = setupSecs + Math.max(...shardSecs);
  const billed = shardSecs.reduce((a, s) => a + Math.ceil((setupSecs + s) / 60), 0);
  return { wall, billed };
}

// Pick the fastest variant that passed every run, covered every test, and does not raise billed minutes
// by more than `maxExtra` (fraction) over the baseline.
export function recommend(results, maxExtra = 0.25) {
  const base = results.find((r) => r.baseline);
  // Coverage must be proven: a non-baseline variant needs a known test count equal to the baseline's.
  const ok = results.filter((r) => r.ok && (r.baseline || (base && r.tests != null && base.tests != null && r.tests === base.tests)));
  const cands = ok.filter((r) => !base || r.billed <= base.billed * (1 + maxExtra));
  return cands.sort((a, b) => a.wall - b.wall || a.billed - b.billed)[0] || null;
}

export function cmdBench(opts) {
  const ctx = repoContext();
  const b = ctx.cfg.bench || {};
  const runs = Number(opts.runs ?? b.runs ?? 3);
  const setup = Number(opts.setup ?? b.setupSecs ?? 45);
  const variants = { baseline: ctx.cfg.checks?.full, ...(b.variants || {}) };
  if (!variants.baseline) die('no checks.full configured to benchmark');
  if (dirtyFiles(ctx.root).length) warn('dirty tree: results describe your working copy, not a commit');
  const results = [];
  const plan = Object.entries(variants).map(([name, cmd]) => ({ name, cmd, shards: 1 }));
  if (b.shardCmd) for (const k of b.shards || [2, 4]) plan.push({ name: `shards=${k}`, cmd: b.shardCmd, shards: k });
  for (const v of plan) {
    const samples = [];
    let ok = true; let tests = null;
    for (let i = 0; i < runs; i++) {
      const shardSecs = [];
      let count = 0;
      for (let s = 1; s <= v.shards; s++) {
        const r = timeRun(v.cmd.replaceAll('{shard}', s).replaceAll('{shards}', v.shards), ctx.root);
        ok &&= r.ok; shardSecs.push(r.secs);
        count = count == null || r.tests == null ? null : count + r.tests;
      }
      tests = count;
      samples.push(estimate(shardSecs, setup));
    }
    const wall = median(samples.map((s) => s.wall)); const billed = median(samples.map((s) => s.billed));
    results.push({ name: v.name, cmd: v.cmd, shards: v.shards, ok, tests, wall, billed, local: median(samples.map((s) => s.wall - setup)), baseline: v.name === 'baseline' });
    out(`${v.name}: ${ok ? 'pass' : 'FAIL'} local ${median(samples.map((s) => s.wall - setup)).toFixed(1)}s${tests != null ? `, ${tests} tests` : ''}`);
  }
  const best = recommend(results, b.maxExtraBilled ?? 0.25);
  const file = path.join(ctx.stateDir, 'bench.jsonl');
  fs.mkdirSync(ctx.stateDir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ at: now(), sha: headSha(ctx.root), setupSecs: setup, runs, results, best: best?.name ?? null }) + '\n');
  out(table([['variant', 'ok', 'tests', 'local s', 'est CI wall s', 'est billed min'], ...results.map((r) => [r.name, r.ok ? 'yes' : 'NO', r.tests ?? '?', r.local.toFixed(1), r.wall.toFixed(0), r.billed])]));
  const base = results.find((r) => r.baseline);
  if (!best || best.name === 'baseline') out('Keep the current setup: no variant was faster without failing, losing tests or costing more minutes.');
  else out(`Measured winner: ${best.name} (${best.wall.toFixed(0)}s vs ${base.wall.toFixed(0)}s wall, ${best.billed} vs ${base.billed} billed min). Adopt it in a task with this evidence; never by turning off durability, isolation or security checks.`);
}
