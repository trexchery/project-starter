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
export const IMAGE = `ghcr.io/actions/actions-runner:${RUNNER_VERSION}`;
export const TARGET = JSON.stringify(['self-hosted', LABEL]);
const CONFIG = () => path.join(HOME, 'config.json');
// Minute stamp plus a random suffix: serve can start several runners in the same minute.
const HOST = os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '');
export const OWN = `proj-docker-${HOST}-`; // registrations this machine's docker runners made
const runnerName = (kind) => `proj-${kind}-${HOST}-${now().replace(/\D/g, '').slice(4, 12)}-${crypto.randomBytes(2).toString('hex')}`;

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
export function dockerArgs({ name, slug, cpus = 4, memory = '8g', maxMin, started = Math.floor(Date.now() / 1000) }) {
  return ['run', '-i', '--rm', '--name', name, '--label', 'proj.serve=1', '--label', `proj.repo=${slug}`, '--label', `proj.started=${started}`,
    '--cpus', String(cpus), '--memory', memory, '--pids-limit', '4096', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--add-host', 'host.docker.internal:0.0.0.0', '--add-host', 'gateway.docker.internal:0.0.0.0',
    IMAGE, 'bash', '-c', runnerScript({ maxMin })];
}

// One ephemeral container runner. The docker client stays attached only to hand over the JIT config on stdin.
export function startDocker({ slug, cpus, memory, maxMin }, { ghFn = gh, spawnFn = spawn, onExit } = {}) {
  const name = runnerName('docker');
  const jit = jitConfig(slug, name, ['self-hosted', LABEL, 'linux'], ghFn);
  const child = spawnFn('docker', dockerArgs({ name, slug, cpus, memory, maxMin }), { stdio: ['pipe', 'ignore', 'ignore'], detached: true, windowsHide: true });
  if (onExit) child.on('exit', onExit); // the client stays attached for the container's life
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
  if (sub === 'hosted') return cmdHosted();
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
  if (sub !== 'start') die('usage: proj runner [status|start|use|clean|serve|hosted] [--docker|--host|--remote] [--hosted] [--dry-run] [--once] [--max-minutes N]');

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
// maxMinutes: the longest job. idleMinutes: an unused pool runner is replaced after this long, because its
// container's hard stop counts from container start and so covers idle time plus one whole job.
export const SERVE_DEFAULTS = { repos: [], slots: 3, pool: 1, cpus: 4, memory: '8g', pollSec: 60, idleMinutes: 20, maxMinutes: 60 };
const MIN = 60000;
const DOWN_POLLS = 2;            // docker must fail this many polls in a row before CI falls back to GitHub-hosted
const RESCUE_AFTER_MS = 5 * MIN; // a proj job queued this long (with a slot free) means no runner is coming
const START_GRACE_MS = 5 * MIN;  // a started runner not online by then failed
const SICK_MS = 30 * MIN;        // after stuck jobs or repeated failed starts, CI stays GitHub-hosted this long
const BEAT_MS = 5 * MIN;         // PROJ_RUNS_ON_HEARTBEAT cadence (the optional watchdog acts after 10 min)
export const hardStopMin = (c) => c.idleMinutes + c.maxMinutes + 10;

// Pure decision for one poll. repos: [{repo, idle}] (idle = online idle runners + runners still starting),
// used: serve containers running or spawned, hosted: true/false/null (null = unknown, e.g. just started),
// sick: docker answers but runners do not serve jobs, canStart: false while backing off after failed starts.
// variable: 'self' | 'hosted' | null (no change). rescue: cancel+rerun runs stuck on proj labels.
export function plan({ repos = [], slots, used = 0, pool, dockerUp, downCount = 0, hosted = null, sick = false, canStart = true }) {
  const down = dockerUp ? 0 : downCount + 1;
  const fallen = dockerUp ? sick : down >= DOWN_POLLS;
  let free = dockerUp && canStart ? Math.max(0, slots - used) : 0;
  const starts = [];
  for (const { repo, idle } of repos) {
    const n = Math.min(free, Math.max(0, pool - idle));
    if (n) starts.push({ repo, n });
    free -= n;
  }
  const variable = fallen ? (hosted !== true ? 'hosted' : null) : dockerUp && hosted !== false ? 'self' : null;
  return { starts, variable, rescue: fallen, downCount: down };
}

// Unreadable repos (deleted, or the API is down) stay served for one refresh and are dropped on the second.
function refresh(st, io) {
  st.cfg = { ...SERVE_DEFAULTS, ...io.config() };
  const prev = st.live;
  st.live = st.cfg.repos.filter((r) => {
    const v = io.ghJson(['repo', 'view', r, '--json', 'isPrivate,isArchived']);
    if (v) { st.miss[r] = 0; return v.isPrivate && !v.isArchived; }
    st.miss[r] = (st.miss[r] || 0) + 1;
    return prev.includes(r) && st.miss[r] < 2;
  });
  // A repo that left (public, archived, deleted, removed from config): CI back to hosted, its containers stop.
  for (const r of prev) if (!st.live.includes(r)) st.gone.set(r, false);
  for (const r of st.live) st.gone.delete(r);
}

// Runs with a job queued on proj labels since before cutoff. A run with a proj job in progress is never one: a
// runner is serving it (a matrix backlog waits for slots), and cancelling would kill that job.
const queuedOnProj = (io, repo, cutoff) => (io.ghJson(['api', `repos/${repo}/actions/runs?status=queued&per_page=20`])?.workflow_runs || [])
  .filter((x) => Date.parse(x.created_at) < cutoff)
  .filter((x) => {
    const jobs = (io.ghJson(['api', `repos/${repo}/actions/runs/${x.id}/jobs`])?.jobs || []).filter((j) => j.labels.includes(LABEL));
    return !jobs.some((j) => j.status === 'in_progress') && jobs.some((j) => j.status === 'queued' && Date.parse(j.created_at) < cutoff);
  });

// One poll. API budget per served repo: 1 runner list (docker up) or 1 queued-run list (docker down), a repo
// view every 10th poll, a queued-run list, a heartbeat and a PROJ_RUNS_ON re-set every 5 min, plus one call per runner started,
// removed or run rescued. 3 repos at one poll a minute: under 300 calls an hour.
export function poll(st, io) {
  const t = io.now();
  if (st.n++ % 10 === 0) refresh(st, io);
  const c = st.cfg;
  const del = (repo, r) => io.act(`remove runner ${r.name} from ${repo}`, () => io.gh(['api', '-X', 'DELETE', `repos/${repo}/actions/runners/${r.id}`]).code === 0);
  const stop = (name) => io.act(`stop container ${name}`, () => io.run('docker', ['rm', '-f', name]).code === 0);
  const failed = (at = t) => { st.fails++; st.nextStart = at + Math.min(30 * MIN, c.pollSec * 1000 * 2 ** st.fails); };
  for (const [r, done] of st.gone) if (!done) st.gone.set(r, io.act(`delete PROJ_RUNS_ON on ${r}`, () => setRouting(r, false, io.gh)));

  const dockerUp = io.run('docker', ['version', '--format', '{{.Server.Os}}'], { timeout: 20000 }).code === 0;
  const local = dockerUp
    ? io.run('docker', ['ps', '--filter', 'label=proj.serve=1', '--format', '{{.Names}}\t{{.Label "proj.repo"}}\t{{.Label "proj.started"}}']).out
      .split('\n').filter(Boolean).map((l) => l.split('\t')).map(([name, repo, s]) => ({ name, repo, started: Number(s) * 1000 || t }))
      .filter((l) => !(st.gone.has(l.repo) && stop(l.name)))
    : [];
  // Spawned but not listed by docker yet: counted until docker lists it, or its client exits or the grace runs out
  // (both a failed start).
  for (const [name, p] of st.pending) {
    if (local.some((l) => l.name === name)) st.pending.delete(name);
    else if (t - p.t > START_GRACE_MS) { st.pending.delete(name); failed(); }
  }
  let removed = 0;
  const repos = dockerUp ? st.live.map((repo) => {
    const list = io.ghJson(['api', `repos/${repo}/actions/runners?per_page=100`])?.runners || [];
    const mine = local.filter((l) => l.repo === repo);
    const gone = new Set();
    for (const l of mine) {
      const r = list.find((x) => x.name === l.name);
      if (r?.status === 'online') {
        st.seen.add(l.name);
        st.fails = 0;
        // Idle too long: unregister first (GitHub refuses while it holds a job), only then stop the container.
        if (!r.busy && t - l.started > c.idleMinutes * MIN && del(repo, r)) { stop(l.name); gone.add(l.name); }
      } else if (!r?.busy && !st.seen.has(l.name) && t - l.started > START_GRACE_MS) {
        // Never came online: a broken start. Remove it and back off.
        if (r) del(repo, r);
        stop(l.name);
        gone.add(l.name);
        failed();
      }
    }
    removed += gone.size;
    // Offline registrations of ours with no container (killed, crashed, PC restarted): delete them.
    for (const r of list) if (r.name.startsWith(OWN) && r.status === 'offline' && !r.busy && !mine.some((l) => l.name === r.name) && !st.pending.has(r.name)) del(repo, r);
    const idleOnline = list.filter((r) => r.status === 'online' && !r.busy && r.labels.some((l) => l.name === LABEL) && !gone.has(r.name)).length;
    const starting = mine.filter((l) => !gone.has(l.name) && list.find((x) => x.name === l.name)?.status !== 'online').length;
    return { repo, idle: idleOnline + starting + [...st.pending.values()].filter((p) => p.repo === repo).length };
  }) : [];
  const used = local.length - removed + st.pending.size;
  // Jobs waiting over 5 min while a slot is really free and their repo has no runner idle or starting: runners
  // are not serving them. Checked every 5 min, first 5 min after serve starts, so jobs that waited for serve (PC
  // was off) get its runners first. A slot that freed on this very poll is not free yet (a backlog job is about
  // to take it): the repo must have had a free slot and no runner since the previous poll.
  const freeSince = {};
  for (const r of repos) if (used < c.slots && !r.idle) freeSince[r.repo] = st.freeSince[r.repo] ?? t;
  st.freeSince = freeSince;
  st.checked ??= t;
  if (dockerUp && used < c.slots && t - st.checked >= RESCUE_AFTER_MS) {
    st.checked = t;
    const stuck = (r) => t - (freeSince[r.repo] ?? t) >= c.pollSec * 1000 && queuedOnProj(io, r.repo, t - RESCUE_AFTER_MS).length;
    if (repos.some(stuck)) st.sickUntil = t + SICK_MS;
  }
  if (st.fails >= 2) st.sickUntil = Math.max(st.sickUntil, t + SICK_MS);
  const p = plan({ repos, slots: c.slots, used, pool: c.pool, dockerUp, downCount: st.down,
    hosted: st.hosted, sick: t < st.sickUntil, canStart: t >= st.nextStart });
  st.down = p.downCount;
  const beat = (at) => st.live.map((r) => io.act(`heartbeat on ${r}`, () => io.gh(['variable', 'set', 'PROJ_RUNS_ON_HEARTBEAT', '-R', r, '--body', String(Math.floor(at / 1000))]).code === 0)).every(Boolean);
  // Heartbeat before routing: the watchdog must never see a fresh PROJ_RUNS_ON next to a stale heartbeat. Each
  // heartbeat while routed here also sets PROJ_RUNS_ON again, undoing a watchdog deletion once serve is alive.
  let variable = p.variable;
  if (((st.hosted === false && p.variable !== 'hosted') || p.variable === 'self') && t - st.beat >= BEAT_MS && beat(t)) {
    st.beat = t;
    variable ||= 'self';
  }
  if (variable) {
    const on = variable === 'self';
    const ok = st.live.map((r) => io.act(`${on ? 'set' : 'delete'} PROJ_RUNS_ON on ${r}`, () => setRouting(r, on, io.gh))).every(Boolean);
    if (ok) st.hosted = !on; // a failed flip is retried next poll
    if (!on) st.beat = 0;
  }
  if (p.starts.length && !st.pulled) {
    // Pull once up front: a slow pull inside `docker run` would hide starting containers from `docker ps`.
    st.pulled = io.act(`pull ${IMAGE}`, () => io.run('docker', ['pull', IMAGE], { timeout: 900000 }).code === 0);
    if (!st.pulled) { failed(); p.starts = []; }
    else if (st.hosted === false && beat(io.now())) st.beat = io.now(); // a slow first pull must not trip the watchdog
  }
  for (const { repo, n } of p.starts) {
    for (let i = 0; i < n; i++) {
      try {
        io.act(`start a runner for ${repo}`, () => {
          // Client exited before docker ever listed the container (crash on start, failed registration): a failed
          // start. Once listed it left pending, so a runner exiting after its job is not one.
          const name = io.start({ slug: repo, cpus: c.cpus, memory: c.memory, maxMin: hardStopMin(c) }, (code) => { if (st.pending.delete(name) && code !== 0) failed(io.now()); }); // exit 0 = finished its one job
          if (name) st.pending.set(name, { repo, t });
          return true;
        });
      } catch (e) { io.warn(e.message); failed(); }
    }
  }
  if (st.reruns.size) drain(st, io); // also after recovery: cancelled runs must not stay cancelled
  if (p.rescue) rescue(st, io);
  return p;
}

// Re-run the jobs rescue() cancelled, once cancelling finished (later polls).
function drain(st, io) {
  for (const [id, repo] of st.reruns) {
    const r = io.act(`re-run ${repo} run ${id}`, () => io.gh(['run', 'rerun', String(id), '--failed', '-R', repo]).code === 0);
    if (r || ++st.tries[id] > 10) st.reruns.delete(id);
  }
}

// Runs whose jobs sit queued on proj labels after the fallback: runs-on was evaluated at queue time, so they
// would wait forever. Cancel them; drain() re-runs them.
function rescue(st, io) {
  for (const repo of st.live) {
    for (const run of queuedOnProj(io, repo, io.now() - RESCUE_AFTER_MS).filter((x) => !st.reruns.has(x.id))) {
      if (io.act(`cancel ${repo} run ${run.id} (queued on ${LABEL})`, () => io.gh(['run', 'cancel', String(run.id), '-R', repo]).code === 0)) {
        st.reruns.set(run.id, repo);
        st.tries[run.id] = 0;
      }
    }
  }
}

export function newServeState() {
  return { n: 0, down: 0, hosted: null, cfg: null, live: [], reruns: new Map(), tries: {}, miss: {}, gone: new Map(), pending: new Map(),
    seen: new Set(), fails: 0, nextStart: 0, sickUntil: 0, checked: null, freeSince: {}, beat: 0, pulled: false };
}

// `proj runner hosted`: every served repo back to GitHub-hosted now, still in runner.serve.repos. For when serve
// stopped without a signal (schtasks /End, crash); serve sets PROJ_RUNS_ON again when it runs.
export function cmdHosted({ ghFn = gh, repos = loadConfig().runner?.serve?.repos || [] } = {}) {
  if (!repos.length) die('no served repos (runner.serve.repos in ~/.proj/config.json)');
  const bad = repos.filter((r) => !setRouting(r, false, ghFn));
  for (const r of repos) out(`${bad.includes(r) ? 'could not delete' : 'deleted'} PROJ_RUNS_ON on ${r}`);
  if (bad.length) die('some repos are still routed to self-hosted');
}

async function cmdServe(opts) {
  const dry = !!opts['dry-run'];
  const io = {
    gh, ghJson, run, warn, now: Date.now,
    config: () => loadConfig().runner?.serve || {},
    start: (o, onExit) => startDocker(o, { onExit }),
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
