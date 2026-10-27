// proj check / ready / offload: local-first verification, CI on ready only, optional ddc compute.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  die, git, gitOk, gh, run, sh, now, out, warn, short, repoContext, loadState, updateState, headSha,
  dirtyFiles, changedFiles, globToRe, isSecretPath,
} from './core.js';
import { taskForCwd, checkpoint, pushTask, prFor, ciAt } from './tasks.js';

const DOC_ONLY = /\.(md|txt|png|jpe?g|gif|svg)$|^docs\//i;

// Tests worth running for the changed files: changed tests plus tests whose name mentions a changed file's stem.
export function affectedTests(ctx, cwd, changed) {
  const globs = (ctx.cfg.testGlobs || []).map(globToRe);
  if (!globs.length) return null;
  const tracked = gitOk(['ls-files', '-co', '--exclude-standard'], { cwd }).split(/\r?\n/);
  const tests = tracked.filter((f) => globs.some((g) => g.test(f)) && fs.existsSync(path.join(cwd, f)));
  const stems = changed.filter((f) => !DOC_ONLY.test(f)).map((f) => path.basename(f).replace(/\.[^.]+$/, '').replace(/^test_|\.test$|_test$/, '').toLowerCase()).filter((s) => s.length > 1);
  return tests.filter((t) => changed.includes(t) || stems.some((s) => path.basename(t).toLowerCase().includes(s)));
}

function record(ctx, sha, entry) {
  updateState(ctx, (st) => { st.checks[sha] = [...(st.checks[sha] || []).slice(-9), entry]; });
}

export function cmdCheck(opts) {
  const ctx = repoContext();
  const cwd = ctx.root;
  const sha = headSha(cwd);
  const dirty = dirtyFiles(cwd).length > 0;
  const checks = ctx.cfg.checks || {};

  if (opts.heavy && opts.ci) return dispatchHeavy(ctx, sha, opts);
  let kind = opts.heavy ? 'heavy' : opts.full ? 'full' : 'affected';
  let cmd = checks[kind];
  if (!cmd) die(`no "${kind}" check configured in .proj.json (checks.${kind})`);

  if (kind === 'affected') {
    const changed = changedFiles(ctx, cwd);
    if (!changed.length) return out('nothing changed against the base branch; nothing to test (run --full to test anyway)');
    if (changed.every((f) => DOC_ONLY.test(f))) return out(`only docs changed (${changed.length} file(s)); no tests needed. Not recorded as tested.`);
    if (cmd.includes('{tests}')) {
      const tests = affectedTests(ctx, cwd, changed);
      if (tests?.length) cmd = cmd.replace('{tests}', tests.map((t) => `"${t}"`).join(' '));
      else { kind = 'full'; cmd = checks.full; out('no test maps to the changed files: running the full suite instead'); }
    }
  }

  const where = opts.remote ? 'remote' : 'local';
  out(`[${kind}/${where}] ${cmd}${dirty ? '   (dirty tree: result will not count for the SHA)' : ''}`);
  const started = Date.now();
  const exit = opts.remote ? offload(ctx, cmd, opts) : sh(cmd, { cwd, env: { PROJ_MAX_WORKERS: String(ctx.cfg.compute.maxWorkers) } });
  record(ctx, sha, { kind, cmd, exit, dirty, where, at: now(), secs: Math.round((Date.now() - started) / 1000) });
  out(`${exit === 0 ? 'PASS' : `FAIL (exit ${exit})`} ${kind} at ${short(sha)}${dirty ? ' + uncommitted changes' : ''}`);
  const t = taskForCwd(ctx);
  if (t) checkpoint(ctx, t, {});
  process.exitCode = exit === 0 ? 0 : 1;
}

function dispatchHeavy(ctx, sha, opts) {
  if (!ctx.remote?.slug) die('no GitHub origin');
  if (!opts.yes) die('dispatching the Heavy workflow spends Actions minutes: re-run with --yes once the owner approved it');
  if (dirtyFiles(ctx.root).length) die('commit and push first: CI verifies an exact pushed SHA');
  const r = gh(['workflow', 'run', 'heavy.yml', '-R', ctx.remote.slug, '--ref', ctx.cfg.baseBranch, '-f', `sha=${sha}`]);
  if (r.code !== 0) die(`dispatch failed: ${r.err}`);
  out(`Heavy workflow dispatched for ${short(sha)}. Watch: gh run list -R ${ctx.remote.slug} -w Heavy`);
}

// ---------- proj ready: local full suite at the exact SHA, push, mark ready (this starts paid CI) ----------
export function cmdReady(opts) {
  const ctx = repoContext();
  const t = taskForCwd(ctx);
  if (!t) die('run inside a task worktree');
  if (dirtyFiles(ctx.root).length) die('uncommitted changes: commit them so CI and the local suite verify the same SHA');
  const sha = headSha(ctx.root);
  const st = loadState(ctx);
  const full = (st.checks[sha] || []).find((c) => c.kind === 'full' && c.exit === 0 && !c.dirty);
  if (!full) die(`no passing full suite recorded for ${short(sha)}: run \`proj check --full\` first`);
  if (!opts.yes) {
    out(`ready to push ${t.branch} @ ${short(sha)} and mark its PR ready for review.`);
    return out('That starts the required CI run (Actions minutes). Re-run with --yes once the owner approved.');
  }
  let pr = pushTask(ctx, t, { draft: true });
  if (pr.isDraft) {
    const r = gh(['pr', 'ready', String(pr.number), '-R', ctx.remote.slug]);
    if (r.code !== 0) die(`gh pr ready failed: ${r.err}`);
  }
  out(`PR #${pr.number} marked ready at ${short(sha)}: CI "${ctx.cfg.requiredCheck}" now runs on that exact SHA.`);
  updateState(ctx, (s) => { s.tasks[t.slug].next = `wait for CI at ${short(sha)}, then the owner runs: proj finish ${t.slug} --merge --yes`; });
  if (opts.wait) waitCi(ctx, sha, Number(opts.timeout || 20));
}

export function waitCi(ctx, sha, minutes) {
  const deadline = Date.now() + minutes * 60000;
  let ci;
  for (;;) {
    ci = ciAt(ctx, sha);
    if (!['pending', 'none', 'unknown'].includes(ci.state) || Date.now() > deadline) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
  }
  out(`CI at ${short(sha)}: ${ci.state}${ci.state === 'skipped' ? ' (NOT verified: the job did not run)' : ''} ${ci.url || ''}`);
  process.exitCode = ci.state === 'verified' ? 0 : 1;
  return ci;
}

// ---------- optional external compute: an already-running ddc (Akash) box ----------
// Never starts, scales, extends or stops a box: those spend money and stay with the owner.
export function computeStatus(ctx) {
  const c = ctx.cfg.compute;
  if (!c.enabled) return { ok: false, code: 4, why: 'offload is off: the owner enables it with "compute": {"enabled": true} in ~/.proj/config.json' };
  const s = run(c.ddc, ['status', '--json'], { timeout: 60000 });
  if (s.code === 127) return { ok: false, code: 2, why: 'ddc is not installed' };
  let j;
  try { j = JSON.parse(s.out); } catch { return { ok: false, code: 2, why: `ddc status failed: ${s.err.split('\n')[0]}` }; }
  const dev = (j.leases || []).find((l) => l.role === 'dev');
  if (!dev) return { ok: false, code: 2, why: 'no ddc dev box is running (proj never starts one: that is the owner\'s `ddc start`)' };
  const host = dev.host || dev.ssh_host || dev.hostname || (String(dev.ssh || '').match(/@([^:\s]+)/) || [])[1];
  const known = fs.existsSync(c.knownHosts) ? fs.readFileSync(c.knownHosts, 'utf8') : '';
  if (!host || !known.includes(host)) return { ok: false, code: 5, why: `host identity unverified: ${host || 'unknown host'} has no pinned key in ${c.knownHosts}` };
  return { ok: true, host, dev, burn: j.burn_usd_hr, balance: j.balance_usd, cpu: dev.cpu || dev.cpus };
}

export function offload(ctx, cmd, opts = {}) {
  const st = computeStatus(ctx);
  if (!st.ok) { warn(st.why); return st.code; }
  const c = ctx.cfg.compute;
  out(`offloading to ${st.host} (cpu ${st.cpu ?? '?'}, burn $${st.burn ?? '?'}/h, balance $${st.balance ?? '?'}); cap ${c.maxRuntimeMin} min, ${c.maxWorkers} workers`);
  const files = gitOk(['ls-files', '-co', '--exclude-standard', '-z'], { cwd: ctx.root }).split('\0').filter((f) => f && fs.existsSync(path.join(ctx.root, f)));
  const secret = files.filter(isSecretPath);
  if (secret.length) { warn(`refusing: secret-looking files would ship: ${secret.slice(0, 5).join(', ')}`); return 3; }
  const listFile = path.join(ctx.stateDir, `offload-${process.pid}.lst`);
  fs.writeFileSync(listFile, files.join('\0'));
  try {
    const tar = spawnSync('tar', ['--null', '-T', listFile, '-cf', '-'], { cwd: ctx.root, maxBuffer: 1 << 30 });
    if (tar.status !== 0) { warn(`tar failed: ${tar.stderr}`); return 1; }
    const name = `${path.basename(ctx.mainRoot)}-${path.basename(ctx.root)}`.replace(/[^A-Za-z0-9._-]/g, '_');
    const secs = c.maxRuntimeMin * 60;
    const script = `set -e; d=/work/proj/${name}; rm -rf "$d"; mkdir -p "$d"; cd "$d"; tar -xf -; export PROJ_MAX_WORKERS=${c.maxWorkers}; timeout ${secs} sh -c ${JSON.stringify(cmd)}`;
    const b64 = Buffer.from(script).toString('base64');
    const r = spawnSync(c.ddc[0], [...c.ddc.slice(1), 'run', '--timeout', String(secs + 60), `echo ${b64} | base64 -d > /tmp/proj-${name}.sh && sh /tmp/proj-${name}.sh`],
      { input: tar.stdout, stdio: ['pipe', 'inherit', 'inherit'], timeout: (secs + 120) * 1000, windowsHide: true });
    return r.error ? 1 : r.status ?? 1;
  } finally { fs.rmSync(listFile, { force: true }); }
}

export function cmdOffload(command, opts) {
  const ctx = repoContext();
  if (!command) {
    const s = computeStatus(ctx);
    out(s.ok ? `available: ${s.host} cpu ${s.cpu ?? '?'} burn $${s.burn}/h balance $${s.balance}` : `unavailable: ${s.why}`);
    process.exitCode = s.ok ? 0 : s.code;
    return;
  }
  process.exitCode = offload(ctx, command, opts);
}
