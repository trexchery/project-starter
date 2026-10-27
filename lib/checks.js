// proj check / ready / offload: change-aware local tiers, CI only on the final SHA (never twice),
// optional remote compute. Every result is keyed by the exact SHA it verified.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  die, git, gitOk, gh, ghJson, run, sh, now, out, warn, short, repoContext, loadState, updateState, headSha,
  currentBranch, dirtyFiles, changedFiles, globToRe, isSecretPath,
} from './core.js';
import { taskForCwd, checkpoint, pushTask, prFor, ciAt } from './tasks.js';
import { withJunit, readJunit, recordProfile } from './perf.js';

// Documentation nobody's code reads. Anything else (fixtures, snapshots, assets, .txt under src) counts as code.
const DOC_ONLY = /^(docs\/|(README|CHANGELOG|CONTRIBUTING|SECURITY|LICENSE)[^/]*$|\.github\/(ISSUE_TEMPLATE\/|pull_request_template))|^[^/]+\.md$/i;
// Files whose change can affect any test: dependency manifests, test runner config, CI, proj config.
const GLOBAL_IMPACT = /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|pyproject\.toml|poetry\.lock|uv\.lock|requirements[^/]*\.txt|setup\.(py|cfg)|tox\.ini|pytest\.ini|conftest\.py|tsconfig[^/]*\.json|(vitest|jest|playwright|babel|vite)\.config\.\w+|\.proj\.json|\.nvmrc|\.node-version|\.python-version)$|^\.github\//;

// Decide what the change-aware tier runs. Fail closed: any change whose impact is uncertain runs the full suite.
export function selectTests(cfg, tracked, changed, cwd = process.cwd()) {
  const code = changed.filter((f) => GLOBAL_IMPACT.test(f) || !DOC_ONLY.test(f)); // requirements.txt is not a doc
  if (!changed.length) return { mode: 'none', reason: 'nothing changed against the base branch' };
  if (!code.length) return { mode: 'none', reason: `only docs changed (${changed.length} file(s))` };
  const globs = (cfg.testGlobs || []).map(globToRe);
  if (!globs.length) return { mode: 'full', reason: 'no testGlobs configured, so impact is unknown' };
  const global = code.find((f) => GLOBAL_IMPACT.test(f));
  if (global) return { mode: 'full', reason: `${global} can affect every test` };
  const isTest = (f) => globs.some((g) => g.test(f));
  const testRoots = (cfg.testGlobs || []).map((g) => g.split(/[*?[]/)[0]).filter(Boolean);
  const helper = code.find((f) => !isTest(f) && testRoots.some((r) => f.startsWith(r)));
  if (helper) return { mode: 'full', reason: `${helper} is a shared test helper or fixture` };
  const tests = tracked.filter(isTest);
  const stem = (f) => path.basename(f).replace(/\.[^.]+$/, '').replace(/^test_|\.(test|spec)$|_test$/, '').toLowerCase();
  // Tests that name the module in their file name or reference it in an import/require/path.
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const refers = (t, s) => { try { return new RegExp(`[/\\\\.'"\`]${esc(s)}(['"\`./]|$)`, 'im').test(fs.readFileSync(path.join(cwd, t), 'utf8')); } catch { return false; } };
  const picked = new Set(code.filter((f) => isTest(f) && tracked.includes(f))); // a deleted test is not runnable
  for (const f of code.filter((x) => !isTest(x))) {
    const s = stem(f);
    const hits = s.length > 1 ? tests.filter((t) => stem(t) === s || path.basename(t).toLowerCase().includes(s) || refers(t, s)) : [];
    if (!hits.length) return { mode: 'full', reason: `no test maps to ${f}` };
    hits.forEach((h) => picked.add(h));
  }
  const list = [...picked];
  if (process.platform === 'win32' && list.some((t) => /[%^!&"]/.test(t))) return { mode: 'full', reason: 'a test path holds characters cmd.exe would expand' };
  return { mode: 'affected', tests: list };
}

function record(ctx, sha, entry) {
  updateState(ctx, (st) => { st.checks[sha] = [...(st.checks[sha] || []).slice(-9), entry]; });
}
// A clean-tree pass of this tier (or a stronger one) at this SHA, made with the command configured now:
// reuse it instead of running again. A changed check command invalidates old passes.
export function priorPass(st, sha, kind, checks = null) {
  const ok = (st.checks[sha] || []).filter((c) => c.exit === 0 && !c.dirty && (!checks || c.kind === 'affected' || c.cmd === checks[c.kind]));
  const covers = { affected: ['affected', 'full'], full: ['full'], heavy: ['heavy'] }[kind] || [kind];
  return ok.find((c) => covers.includes(c.kind)) || null;
}
const treeState = (cwd) => `${headSha(cwd)}|${dirtyFiles(cwd).map((d) => d.xy + d.file).join(',')}`;

export function cmdCheck(opts) {
  const ctx = repoContext();
  const cwd = ctx.root;
  const sha = headSha(cwd);
  const before = treeState(cwd);
  const dirty = !before.endsWith('|');
  const checks = ctx.cfg.checks || {};

  if (opts.heavy && opts.ci) return dispatchHeavy(ctx, sha, opts);
  let kind = opts.heavy ? 'heavy' : opts.full ? 'full' : 'affected';
  let cmd = checks[kind];
  if (!cmd) die(`no "${kind}" check configured in .proj.json (checks.${kind})`);

  const prior = !dirty && !opts.again && priorPass(loadState(ctx), sha, kind, checks);
  if (prior) return out(`${kind}: already passed at ${short(sha)} (${prior.kind}, ${prior.where}, ${prior.at}); not running it again. --again forces a rerun.`);

  if (kind === 'affected') {
    const tracked = gitOk(['ls-files', '-co', '--exclude-standard'], { cwd }).split(/\r?\n/).filter((f) => f && fs.existsSync(path.join(cwd, f)));
    const sel = selectTests(ctx.cfg, tracked, changedFiles(ctx, cwd), cwd);
    if (sel.mode === 'none') return out(`${sel.reason}; no tests needed. Not recorded as tested (run --full to test anyway).`);
    if (sel.mode === 'full') { out(`full suite: ${sel.reason}`); kind = 'full'; cmd = checks.full; }
    else if (cmd.includes('{tests}')) cmd = cmd.replace('{tests}', sel.tests.map((t) => `"${t}"`).join(' '));
  }

  const where = opts.remote ? 'remote' : 'local';
  const { cmd: runCmd, file: junit } = opts.remote ? { cmd: cmd.replaceAll('{junit}', 'junit.xml'), file: null } : withJunit(cmd);
  out(`[${kind}/${where}] ${cmd}${dirty ? '   (dirty tree: will not count for the SHA)' : ''}`);
  const started = Date.now();
  const exit = opts.remote ? offload(ctx, runCmd) : sh(runCmd, { cwd, env: { PROJ_MAX_WORKERS: String(ctx.cfg.compute.maxWorkers) } });
  const secs = Math.round((Date.now() - started) / 100) / 10;
  // The tree may change while tests run; only a tree identical before and after counts for the SHA.
  const counted = !dirty && treeState(cwd) === before;
  const prof = readJunit(junit, cwd);
  record(ctx, sha, { kind, cmd, exit, dirty: !counted, where, at: now(), secs });
  recordProfile(ctx, { at: now(), sha, kind, where, exit, secs, tests: prof?.tests ?? null, files: prof?.files ?? null });
  out(`${exit === 0 ? 'PASS' : `FAIL (exit ${exit})`} ${kind} at ${short(sha)} in ${secs}s${counted ? '' : ' (tree was dirty or changed: not counted for the SHA)'}`);
  const t = taskForCwd(ctx);
  if (t) checkpoint(ctx, t, {});
  process.exitCode = exit === 0 ? 0 : 1;
}

function heavyRuns(ctx) {
  return ghJson(['run', 'list', '-R', ctx.remote.slug, '-w', 'heavy.yml', '-L', '50', '--json', 'databaseId,displayTitle,status,conclusion,url']) || [];
}
function dispatchHeavy(ctx, sha, opts) {
  if (!ctx.remote?.slug) die('no GitHub origin');
  if (dirtyFiles(ctx.root).length) die('commit and push first: CI verifies an exact pushed SHA');
  git(['fetch', '--quiet', 'origin'], { cwd: ctx.root });
  if (!git(['branch', '-r', '--contains', sha], { cwd: ctx.root }).out) die(`${short(sha)} is not on origin yet: push it first (proj checkpoint --push)`);
  const local = priorPass(loadState(ctx), sha, 'heavy', ctx.cfg.checks);
  if (local && !opts.again) die(`heavy suite already passed at ${short(sha)} (${local.where}); not spending CI minutes on it again. --again overrides.`);
  const same = heavyRuns(ctx).find((r) => r.displayTitle.includes(sha) && (r.status !== 'completed' || r.conclusion === 'success'));
  if (same && !opts.again) die(`Heavy already ${same.status === 'completed' ? 'passed' : same.status} for ${short(sha)}: ${same.url}`);
  const r = gh(['workflow', 'run', 'heavy.yml', '-R', ctx.remote.slug, '--ref', ctx.cfg.baseBranch, '-f', `sha=${sha}`]);
  if (r.code !== 0) die(`dispatch failed: ${r.err}`);
  out(`Heavy workflow dispatched for ${short(sha)}. Watch: gh run list -R ${ctx.remote.slug} -w heavy.yml`);
}

// ---------- proj ready: final tiers at the exact SHA, push, mark ready (this starts paid CI) once ----------
export function cmdReady(opts) {
  const ctx = repoContext();
  const t = taskForCwd(ctx);
  if (!t) die('run inside a task worktree');
  if (currentBranch(ctx.root) !== t.branch) die(`HEAD is not on ${t.branch}: check it out so the tested SHA is the one pushed`);
  if (dirtyFiles(ctx.root).length) die('uncommitted changes: commit them so CI and the local suite verify the same SHA');
  const sha = headSha(ctx.root);
  const st = loadState(ctx);
  if (!priorPass(st, sha, 'full', ctx.cfg.checks)) die(`no passing full suite recorded for ${short(sha)}: run \`proj check --full\` first`);
  if (ctx.cfg.checks?.heavy && ctx.cfg.heavyBeforeReady !== false && !priorPass(st, sha, 'heavy', ctx.cfg.checks))
    die(`checks.heavy is configured: run it first, locally or on approved compute (\`proj check --heavy [--remote]\`)`);

  const pr = prFor(ctx, t.branch);
  if (pr?.state === 'OPEN' && !pr.isDraft && pr.headRefOid === sha) {
    const ci = ciAt(ctx, sha);
    if (['verified', 'pending'].includes(ci.state)) {
      out(`PR #${pr.number} is already ready at ${short(sha)} and CI is ${ci.state}: not triggering another run.`);
      if (opts.wait && ci.state === 'pending') waitCi(ctx, sha, Number(opts.timeout || 20));
      return;
    }
    // Ready already, same SHA, CI did not pass: nothing new would trigger a run. Re-run the failed one.
    if (ci.state !== 'none' && ci.state !== 'unknown') die(`CI is ${ci.state} at ${short(sha)} (${ci.url || 'no url'}). Fix and push a new commit, or re-run it: gh run rerun ${ci.runId || '<run id>'} --failed -R ${ctx.remote.slug}`);
  }
  warnIfNoRunner(ctx);
  const since = new Date(Date.now() - 60000).toISOString(); // skew margin; only skipped runs are filtered by it
  const p = pushTask(ctx, t, { draft: true });
  if (p.isDraft) {
    const r = gh(['pr', 'ready', String(p.number), '-R', ctx.remote.slug]);
    if (r.code !== 0) die(`gh pr ready failed: ${r.err}`);
  }
  out(`PR #${p.number} ready at ${short(sha)}: CI "${ctx.cfg.requiredCheck}" runs once on that exact SHA.`);
  updateState(ctx, (s) => { s.tasks[t.slug].next = `wait for CI at ${short(sha)}, then: proj finish ${t.slug} --merge`; });
  if (opts.wait) waitCi(ctx, sha, Number(opts.timeout || 20), since);
}

function warnIfNoRunner(ctx) {
  const v = gh(['variable', 'get', 'PROJ_RUNS_ON', '-R', ctx.remote.slug]).out;
  if (!v) return;
  const online = (ghJson(['api', `repos/${ctx.remote.slug}/actions/runners`])?.runners || []).filter((r) => r.status === 'online');
  if (!online.length) warn(`CI is routed to self-hosted runners (${v}) but none is online: start one with \`proj runner start --docker\``);
}

// Poll the required check for one SHA. `since` ignores runs from before the PR became ready (draft skips).
export function waitCi(ctx, sha, minutes, since = null) {
  const deadline = Date.now() + minutes * 60000;
  let ci;
  for (;;) {
    ci = ciAt(ctx, sha, since);
    // A skipped run is never a verdict while waiting: the real run for the ready PR may not have started yet.
    if (!['pending', 'none', 'unknown', 'skipped'].includes(ci.state) || Date.now() > deadline) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
  }
  out(`CI at ${short(sha)}: ${ci.state}${ci.state === 'skipped' ? ' (NOT verified: the job did not run)' : ''} ${ci.url || ''}`);
  process.exitCode = ci.state === 'verified' ? 0 : 1;
  return ci;
}

// ---------- optional external compute: a machine you already run, reached by ssh or by your own command ----------
// compute.ssh: "user@host" — ssh runs with StrictHostKeyChecking=yes, so an unknown or changed host key is refused.
// compute.command: any CLI that runs a shell script on your remote machine and forwards stdin, e.g. ["mybox", "run"].
// proj never starts, rents, scales or stops machines: if the machine is not reachable, nothing happens.
export const PROBE = 'nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 1';
export function transport(c) {
  const argv = typeof c.command === 'string' ? c.command.trim().split(/\s+/).filter(Boolean) : c.command;
  if (argv != null && !Array.isArray(argv)) die('compute.command must be a list, e.g. ["mybox", "run"]');
  if (argv?.length) return { argv, label: argv.join(' ') };
  if (c.ssh) return { argv: ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', ...(c.port ? ['-p', String(c.port)] : []), c.ssh], label: c.ssh };
  return null;
}

export function computeStatus(ctx) {
  const c = ctx.cfg.compute;
  if (!c.enabled) return { ok: false, code: 4, why: 'offload is off: enable it with "compute": {"enabled": true, "ssh": "user@host"} in ~/.proj/config.json' };
  const t = transport(c);
  if (!t) return { ok: false, code: 2, why: 'no remote configured: set compute.ssh ("user@host") or compute.command in ~/.proj/config.json' };
  const s = run(t.argv, [PROBE], { timeout: 60000 });
  if (/host key verification failed|remote host identification has changed/i.test(s.err)) return { ok: false, code: 5, why: `host identity unverified for ${t.label}: add its key to known_hosts yourself first` };
  if (s.code !== 0 || !/^\d+$/.test(s.out.trim())) return { ok: false, code: 2, why: `remote not reachable via ${t.label} (${(s.err || s.out).split('\n')[0] || `exit ${s.code}`}); proj never starts one` };
  return { ok: true, label: t.label, argv: t.argv, cpu: Number(s.out.trim()) };
}

export function offload(ctx, cmd) {
  const st = computeStatus(ctx);
  if (!st.ok) { warn(st.why); return st.code; }
  const c = ctx.cfg.compute;
  out(`offloading to ${st.label} (${st.cpu} cpus); cap ${c.maxRuntimeMin} min, ${c.maxWorkers} workers`);
  const files = gitOk(['ls-files', '-co', '--exclude-standard', '-z'], { cwd: ctx.root }).split('\0').filter((f) => f && fs.existsSync(path.join(ctx.root, f)));
  const secret = files.filter(isSecretPath);
  if (secret.length) { warn(`refusing: secret-looking files would ship: ${secret.slice(0, 5).join(', ')}`); return 3; }
  const listFile = path.join(os.tmpdir(), `proj-offload-${process.pid}-${Date.now()}.lst`);
  fs.writeFileSync(listFile, files.join('\0'));
  try {
    const tar = spawnSync('tar', ['--null', '-T', listFile, '-cf', '-'], { cwd: ctx.root, maxBuffer: 1 << 30 });
    if (tar.status !== 0) { warn(`tar failed: ${tar.stderr}`); return 1; }
    // Unique per checkout and run, so two clones or two concurrent runs never wipe each other.
    const id = crypto.createHash('sha1').update(path.resolve(ctx.root)).digest('hex').slice(0, 8);
    const name = `${path.basename(ctx.root).replace(/[^A-Za-z0-9._-]/g, '_')}-${id}-${process.pid}`;
    const secs = c.maxRuntimeMin * 60;
    const script = `set -e; d="\${TMPDIR:-/tmp}/proj/${name}"; mkdir -p "$d"; cd "$d"; tar -xf -; export PROJ_MAX_WORKERS=${c.maxWorkers}; set +e; timeout ${secs} sh -c ${JSON.stringify(cmd)}; rc=$?; cd /; rm -rf "$d"; exit $rc`;
    const b64 = Buffer.from(script).toString('base64');
    const r = spawnSync(st.argv[0], [...st.argv.slice(1), `echo ${b64} | base64 -d > /tmp/proj-${name}.sh && sh /tmp/proj-${name}.sh`],
      { input: tar.stdout, stdio: ['pipe', 'inherit', 'inherit'], timeout: (secs + 120) * 1000, windowsHide: true });
    return r.error ? 1 : r.status ?? 1;
  } finally { fs.rmSync(listFile, { force: true }); }
}

export function cmdOffload(command) {
  const ctx = repoContext();
  if (!command) {
    const s = computeStatus(ctx);
    out(s.ok ? `available: ${s.label} (${s.cpu} cpus)` : `unavailable: ${s.why}`);
    process.exitCode = s.ok ? 0 : s.code;
    return;
  }
  process.exitCode = offload(ctx, command);
}
