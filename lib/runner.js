// proj runner: optional ephemeral self-hosted runners (one job, then gone). Docker (isolated, default),
// this machine (opt-in, not isolated), or your configured remote machine. Never provisions paid resources.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { die, gh, ghJson, run, out, warn, now, repoContext, readJson, writeJson, loadConfig, HOME } from './core.js';
import { computeStatus } from './checks.js';

export const RUNNER_VERSION = '2.338.2';
export const LABEL = 'proj-ephemeral';
const IMAGE = `ghcr.io/actions/actions-runner:${RUNNER_VERSION}`;
export const TARGET = JSON.stringify(['self-hosted', LABEL]);
const CONFIG = () => path.join(HOME, 'config.json');
// Minute stamp plus a random suffix: serve can start several runners in the same minute.
const runnerName = (kind) => `proj-${kind}-${os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '')}-${now().replace(/\D/g, '').slice(4, 12)}-${crypto.randomBytes(2).toString('hex')}`;

// Only private repos: a public repo's fork PRs would run strangers' code on this hardware. The CI template
// additionally routes only same-repo PRs not opened by bots, and dispatches of non-bot branches, here.
function guard(ctx) {
  if (!ctx.remote?.slug) die('origin is not a GitHub repository');
  const repo = ghJson(['repo', 'view', ctx.remote.slug, '--json', 'isPrivate,viewerPermission']);
  if (!repo) die('cannot read the repository (gh auth?)');
  if (!repo.isPrivate) die('refusing: self-hosted runners on a public repository would execute fork PR code on your machine');
  if (repo.viewerPermission !== 'ADMIN') die('registering a runner needs admin on the repository');
}

function registrationToken(slug) {
  const r = gh(['api', '-X', 'POST', `repos/${slug}/actions/runners/registration-token`, '--jq', '.token']);
  if (r.code !== 0 || !r.out) die(`could not get a registration token: ${r.err}`);
  return r.out; // valid ~1 hour; host mode hands it to config only through ACTIONS_RUNNER_INPUT_TOKEN
}

// A just-in-time config registers exactly one ephemeral runner for one job: no config.sh, no reusable token.
export function jitConfig(slug, name, labels, ghFn = gh) {
  const r = ghFn(['api', '-X', 'POST', `repos/${slug}/actions/runners/generate-jitconfig`, '-f', `name=${name}`, '-F', 'runner_group_id=1',
    ...labels.flatMap((l) => ['-f', `labels[]=${l}`]), '-f', 'work_folder=_work', '--jq', '.encoded_jit_config']);
  if (r.code !== 0 || !r.out) die(`could not get a runner config for ${slug}: ${r.err}`);
  return r.out;
}

// Script the runner host executes. The JIT config arrives on stdin, so it is in no host argv, no `docker
// inspect` and no file. The runner reads ACTIONS_RUNNER_INPUT_JITCONFIG and removes it from its own
// environment; run.sh and `timeout` above it still hold it, so the one job this container serves could read
// it from /proc, but by then it is spent (single use, that runner is already registered and busy).
export function runnerScript({ maxMin }) {
  return [
    'set -e',
    'IFS= read -r ACTIONS_RUNNER_INPUT_JITCONFIG',
    'export ACTIONS_RUNNER_INPUT_JITCONFIG',
    `timeout --kill-after=30 ${maxMin * 60} ./run.sh`,
  ].join('; ');
}

// No host mounts, no host env, all capabilities dropped, no privilege escalation, capped CPU/memory/pids,
// the Docker host aliases blackholed, removed on exit. Never host networking.
export function dockerArgs({ name, slug, cpus = 4, memory = '8g', maxMin }) {
  return ['run', '-i', '--rm', '--name', name, '--label', 'proj.serve=1', '--label', `proj.repo=${slug}`,
    '--cpus', String(cpus), '--memory', memory, '--pids-limit', '4096', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--add-host', 'host.docker.internal:0.0.0.0', '--add-host', 'gateway.docker.internal:0.0.0.0',
    IMAGE, 'bash', '-c', runnerScript({ maxMin })];
}

// One ephemeral container runner. The docker client stays attached only to hand over the JIT config on stdin.
export function startDocker({ slug, cpus, memory, maxMin }, { ghFn = gh, spawnFn = spawn } = {}) {
  const name = runnerName('docker');
  const jit = jitConfig(slug, name, ['self-hosted', LABEL, 'linux'], ghFn);
  const child = spawnFn('docker', dockerArgs({ name, slug, cpus, memory, maxMin }), { stdio: ['pipe', 'ignore', 'ignore'], detached: true, windowsHide: true });
  child.stdin.end(`${jit}\n`);
  child.unref();
  return name;
}

// PROJ_RUNS_ON set = same-repo PR CI waits for a proj-ephemeral runner; deleted = GitHub-hosted.
export function setRouting(slug, on, ghFn = gh) {
  const r = on ? ghFn(['variable', 'set', 'PROJ_RUNS_ON', '-R', slug, '--body', TARGET]) : ghFn(['variable', 'delete', 'PROJ_RUNS_ON', '-R', slug]);
  return r.code === 0 || (!on && /404|not found/i.test(r.err));
}

// The repos `proj runner serve` keeps runners for: ~/.proj/config.json runner.serve.repos. Maintained only on
// a machine that opted in (runner.serve present); returns false otherwise.
export function editServed(slug, add, file = CONFIG()) {
  const cfg = readJson(file, {});
  const s = cfg.runner?.serve;
  if (!s) return false;
  const set = new Set(s.repos || []);
  if (add) set.add(slug); else set.delete(slug);
  s.repos = [...set];
  writeJson(file, cfg);
  return true;
}

export function cmdRunner(sub, opts) {
  if (sub === 'serve') return cmdServe(opts);
  const ctx = repoContext();
  const c = ctx.cfg.runner || {};
  const maxMin = Number(opts['max-minutes'] || c.maxMinutes || 60);
  const slug = ctx.remote?.slug;
  if (!sub || sub === 'status') {
    const list = slug ? ghJson(['api', `repos/${slug}/actions/runners`])?.runners || [] : [];
    const v = slug ? gh(['variable', 'get', 'PROJ_RUNS_ON', '-R', slug]).out : '';
    out(`CI runs on: ${v || 'GitHub-hosted (PROJ_RUNS_ON unset)'}`);
    for (const r of list) out(`  ${r.name}  ${r.status}${r.busy ? ' busy' : ''}  [${r.labels.map((l) => l.name).join(', ')}]`);
    if (!list.length) out('  no self-hosted runners registered');
    return;
  }
  if (sub === 'use') {
    // Route same-repo PR CI to proj-ephemeral runners, or back to GitHub-hosted.
    const on = !opts.hosted;
    if (!slug) die('origin is not a GitHub repository');
    if (on) guard(ctx);
    if (opts['dry-run']) return out(`would ${on ? `set PROJ_RUNS_ON=${TARGET}` : 'delete PROJ_RUNS_ON'} on ${slug}`);
    if (!setRouting(slug, on)) die(`could not ${on ? 'set' : 'delete'} PROJ_RUNS_ON on ${slug}`);
    const served = editServed(slug, on);
    if (!on) return out('CI back on GitHub-hosted runners');
    return out(`CI for same-repo PRs now waits for a ${LABEL} runner: ${served ? '`proj runner serve` keeps them ready' : 'start one per run with `proj runner start --docker`'}`);
  }
  if (sub === 'clean') {
    if (!slug) die('origin is not a GitHub repository');
    const list = ghJson(['api', `repos/${slug}/actions/runners`])?.runners || [];
    const stale = list.filter((r) => r.name.startsWith('proj-') && r.status === 'offline' && !r.busy);
    if (opts['dry-run'] || !stale.length) { for (const r of stale) out(`would remove offline runner ${r.name}`); return stale.length ? undefined : out('nothing to remove'); }
    for (const r of stale) out(`${gh(['api', '-X', 'DELETE', `repos/${slug}/actions/runners/${r.id}`]).code === 0 ? 'removed' : 'failed to remove'} ${r.name}`);
    return;
  }
  if (sub !== 'start') die('usage: proj runner [status|start|use|clean|serve] [--docker|--host|--remote] [--hosted] [--dry-run] [--once] [--max-minutes N]');

  const mode = opts.host ? 'host' : opts.remote ? 'remote' : 'docker';
  guard(ctx);
  if (mode === 'host' && !c.allowHost) die('running jobs directly on this machine is off: enable it with "runner": {"allowHost": true} in ~/.proj/config.json (only there). Prefer --docker, which is isolated.');
  const url = `https://github.com/${slug}`;

  if (mode === 'docker') {
    if (run('docker', ['version', '--format', '{{.Server.Os}}']).code !== 0) die('docker is not running');
    const name = startDocker({ slug, cpus: c.cpus, memory: c.memory, maxMin });
    return out(`runner ${name} starting in a container (one job, then it exits; hard stop after ${maxMin} min)`);
  }
  const name = runnerName(mode);
  if (mode === 'remote') {
    const st = computeStatus(ctx);
    if (!st.ok) die(st.why, st.code);
    const jit = jitConfig(slug, name, ['self-hosted', LABEL, 'linux']);
    // The script deletes its own file first (bash already holds it open); the work dir goes on exit.
    const remote = `rm -f -- "$0"; set -e; d="\${TMPDIR:-/tmp}/proj-runner/${name}"; trap 'cd /; rm -rf "$d"' EXIT; mkdir -p "$d"; cd "$d"; curl -fsSL https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz | tar -xz; ${runnerScript({ maxMin })}`;
    const b64 = Buffer.from(remote).toString('base64');
    const child = spawn(st.argv[0], [...st.argv.slice(1), `echo ${b64} | base64 -d > /tmp/${name}.sh && bash /tmp/${name}.sh`], { stdio: ['pipe', 'ignore', 'ignore'], detached: true, windowsHide: true });
    child.stdin.end(`${jit}\n`);
    child.unref();
    return out(`runner ${name} starting on ${st.label} (an existing machine; nothing new is rented)`);
  }

  // host: NOT isolated from your user account; same trust as running the tests yourself. Jobs get a private
  // profile (HOME/APPDATA/gh config point into the runner dir) so CLIs do not pick up your credentials, but
  // files elsewhere on disk stay readable. Use --docker for isolation.
  const dir = path.join(HOME, 'runners', name);
  const prof = path.join(dir, '_profile');
  fs.mkdirSync(path.join(prof, 'AppData', 'Roaming'), { recursive: true });
  fs.mkdirSync(path.join(prof, 'AppData', 'Local'), { recursive: true });
  const win = process.platform === 'win32';
  const pkg = `actions-runner-${win ? 'win' : process.platform === 'darwin' ? 'osx' : 'linux'}-x64-${RUNNER_VERSION}.${win ? 'zip' : 'tar.gz'}`;
  const dl = run('curl', ['-fsSL', '-o', path.join(dir, pkg), `https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${pkg}`], { timeout: 300000 });
  if (dl.code !== 0) die(`download failed: ${dl.err}`);
  run('tar', ['-xf', pkg], { cwd: dir, allowFail: false });
  const keep = ['SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATH', 'Path', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'ProgramFiles', 'ProgramData'];
  const env = {
    ...Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
    HOME: prof, USERPROFILE: prof, APPDATA: path.join(prof, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(prof, 'AppData', 'Local'),
    TEMP: path.join(dir, '_tmp'), TMP: path.join(dir, '_tmp'), GH_CONFIG_DIR: path.join(prof, 'gh'), GIT_CONFIG_GLOBAL: path.join(prof, '.gitconfig'),
  };
  fs.mkdirSync(env.TEMP, { recursive: true });
  const token = registrationToken(slug);
  const cfgArgs = ['--url', url, '--name', name, '--labels', `${LABEL},${process.platform}`, '--ephemeral', '--unattended', '--disableupdate', '--replace'];
  // The runner reads ACTIONS_RUNNER_INPUT_TOKEN from the environment of the config step only.
  const cenv = { ...env, ACTIONS_RUNNER_INPUT_TOKEN: token };
  const conf = win ? run('cmd', ['/c', 'config.cmd', ...cfgArgs], { cwd: dir, env: cenv }) : run('./config.sh', cfgArgs, { cwd: dir, env: cenv });
  if (conf.code !== 0) die(`runner config failed: ${conf.err || conf.out}`);
  const child = spawn(win ? 'cmd' : './run.sh', win ? ['/c', 'run.cmd'] : [], { cwd: dir, env, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  // Hard stop for the whole process tree (the listener and any job), independent of this process.
  const kill = win
    ? spawn('powershell', ['-NoProfile', '-Command', `Start-Sleep -Seconds ${maxMin * 60}; taskkill /T /F /PID ${child.pid}`], { detached: true, stdio: 'ignore', windowsHide: true })
    : spawn('sh', ['-c', `sleep ${maxMin * 60}; kill -TERM -${child.pid} 2>/dev/null; sleep 30; kill -KILL -${child.pid} 2>/dev/null`], { detached: true, stdio: 'ignore' });
  kill.unref();
  out(`runner ${name} started on this machine in ${dir} (one job, then it unregisters; hard stop after ${maxMin} min). Not isolated: prefer --docker.`);
}

// ---------- proj runner serve: keep a small docker pool ready for every served private repo ----------
export const SERVE_DEFAULTS = { repos: [], slots: 3, pool: 1, cpus: 4, memory: '8g', pollSec: 60, maxMinutes: 60 };
const DOWN_POLLS = 2;          // docker must fail this many polls in a row before CI falls back to GitHub-hosted
const RESCUE_AFTER_MS = 5 * 60000;

// Pure decision for one poll. repos: [{repo, idle}] (idle = online idle runners + containers still starting),
// used: serve containers running, hosted: true/false/null (null = unknown, e.g. just started).
// variable: 'self' | 'hosted' | null (no change). rescue: cancel+rerun runs stuck on proj labels.
export function plan({ repos = [], slots, used = 0, pool, dockerUp, downCount = 0, hosted = null }) {
  const down = dockerUp ? 0 : downCount + 1;
  if (!dockerUp) {
    const fallen = down >= DOWN_POLLS;
    return { starts: [], variable: fallen && hosted !== true ? 'hosted' : null, rescue: fallen, downCount: down };
  }
  let free = Math.max(0, slots - used);
  const starts = [];
  for (const { repo, idle } of repos) {
    const n = Math.min(free, Math.max(0, pool - idle));
    if (n) starts.push({ repo, n });
    free -= n;
  }
  return { starts, variable: hosted !== false ? 'self' : null, rescue: false, downCount: down };
}

// One poll. API budget per served repo: 1 runner list (docker up) or 1 queued-run list (docker down), plus a
// repo view every 10th poll, plus one call per runner started or run rescued. 3 repos: ~200 calls/hour.
export function poll(st, io) {
  if (st.n++ % 10 === 0) {
    st.cfg = { ...SERVE_DEFAULTS, ...io.config() };
    // Private, existing, unarchived only; anything else is skipped quietly (never served, never flipped).
    st.live = st.cfg.repos.filter((r) => { const v = io.ghJson(['repo', 'view', r, '--json', 'isPrivate,isArchived']); return v?.isPrivate && !v.isArchived; });
  }
  const c = st.cfg;
  const dockerUp = io.run('docker', ['version', '--format', '{{.Server.Os}}'], { timeout: 20000 }).code === 0;
  const local = dockerUp
    ? io.run('docker', ['ps', '--filter', 'label=proj.serve=1', '--format', '{{.Names}}\t{{.Label "proj.repo"}}']).out.split('\n').filter(Boolean).map((l) => l.split('\t'))
    : [];
  const repos = dockerUp ? st.live.map((repo) => {
    const list = io.ghJson(['api', `repos/${repo}/actions/runners?per_page=100`])?.runners || [];
    const names = new Set(list.map((r) => r.name));
    const idle = list.filter((r) => r.status === 'online' && !r.busy && r.labels.some((l) => l.name === LABEL)).length;
    return { repo, idle: idle + local.filter(([n, r]) => r === repo && !names.has(n)).length };
  }) : [];
  const p = plan({ repos, slots: c.slots, used: local.length, pool: c.pool, dockerUp, downCount: st.down, hosted: st.hosted });
  st.down = p.downCount;
  if (p.variable) {
    const on = p.variable === 'self';
    const ok = st.live.map((r) => io.act(`${on ? 'set' : 'delete'} PROJ_RUNS_ON on ${r}`, () => setRouting(r, on, io.gh))).every(Boolean);
    if (ok) st.hosted = !on; // a failed flip is retried next poll
  }
  for (const { repo, n } of p.starts) {
    for (let i = 0; i < n; i++) {
      try { io.act(`start a runner for ${repo}`, () => io.start({ slug: repo, cpus: c.cpus, memory: c.memory, maxMin: c.maxMinutes })); } catch (e) { io.warn(e.message); }
    }
  }
  if (p.rescue) rescue(st, io);
  return p;
}

// Runs whose jobs sit queued on proj labels after the fallback: runs-on was evaluated at queue time, so they
// would wait forever. Cancel them, then re-run the cancelled jobs once cancelling finished (next polls).
function rescue(st, io) {
  for (const [id, repo] of st.reruns) {
    const r = io.act(`re-run ${repo} run ${id}`, () => io.gh(['run', 'rerun', String(id), '--failed', '-R', repo]).code === 0);
    if (r || ++st.tries[id] > 10) st.reruns.delete(id);
  }
  const cutoff = io.now() - RESCUE_AFTER_MS;
  for (const repo of st.live) {
    const runs = io.ghJson(['api', `repos/${repo}/actions/runs?status=queued&per_page=20`])?.workflow_runs || [];
    for (const run of runs.filter((x) => Date.parse(x.created_at) < cutoff && !st.reruns.has(x.id))) {
      const jobs = io.ghJson(['api', `repos/${repo}/actions/runs/${run.id}/jobs`])?.jobs || [];
      if (!jobs.some((j) => j.status === 'queued' && j.labels.includes(LABEL) && Date.parse(j.created_at) < cutoff)) continue;
      if (io.act(`cancel ${repo} run ${run.id} (queued on ${LABEL})`, () => io.gh(['run', 'cancel', String(run.id), '-R', repo]).code === 0)) {
        st.reruns.set(run.id, repo);
        st.tries[run.id] = 0;
      }
    }
  }
}

export function newServeState() {
  return { n: 0, down: 0, hosted: null, cfg: null, live: [], reruns: new Map(), tries: {} };
}

async function cmdServe(opts) {
  const dry = !!opts['dry-run'];
  const io = {
    gh, ghJson, run, warn, now: Date.now,
    config: () => loadConfig().runner?.serve || {},
    start: (o) => startDocker(o),
    act: (what, fn) => { if (dry) { out(`would ${what}`); return true; } return fn(); },
  };
  const st = newServeState();
  if (!(io.config().repos || []).length) die('nothing to serve: add "runner": {"serve": {"repos": ["owner/private-repo"]}} to ~/.proj/config.json, or run `proj runner use` in a private repo once runner.serve exists');
  // Stopping serve means no runner will come: put CI back on GitHub-hosted first.
  const stop = () => { for (const r of st.live) io.act(`delete PROJ_RUNS_ON on ${r}`, () => setRouting(r, false)); out('serve stopped; CI is on GitHub-hosted runners'); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  for (;;) {
    try {
      const p = poll(st, io);
      const started = p.starts.reduce((a, s) => a + s.n, 0);
      if (started || p.variable || opts.once || dry) out(`${new Date().toISOString()} docker ${st.down ? 'down' : 'up'}; served ${st.live.join(', ') || 'none'}; started ${started}${p.variable ? `; CI -> ${p.variable}` : ''}`);
    } catch (e) { warn(e.message); }
    if (opts.once) return;
    await new Promise((r) => setTimeout(r, (st.cfg?.pollSec || 60) * 1000));
  }
}
