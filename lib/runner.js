// proj runner: optional ephemeral self-hosted runners (one job, then gone). Docker (isolated, default),
// this machine (opt-in, not isolated), or an already running ddc box. Never provisions paid resources.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { die, gh, ghJson, run, out, now, repoContext, HOME } from './core.js';
import { computeStatus } from './checks.js';

export const RUNNER_VERSION = '2.338.2';
export const LABEL = 'proj-ephemeral';
const IMAGE = `ghcr.io/actions/actions-runner:${RUNNER_VERSION}`;
const runnerName = (kind) => `proj-${kind}-${os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '')}-${now().replace(/\D/g, '').slice(4, 12)}`;

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
  return r.out; // valid ~1 hour, single purpose; only ever passed on stdin, never argv, env or disk
}

// Script the runner host executes. The token arrives on stdin into an unexported shell variable, so it is
// in no container config, no process environment and no job's view; it is unset before any job can run.
export function runnerScript({ url, name, labels, maxMin }) {
  return [
    'set -e',
    'IFS= read -r RUNNER_TOKEN',
    `./config.sh --url ${url} --token "$RUNNER_TOKEN" --name ${name} --labels ${labels} --ephemeral --unattended --disableupdate --replace`,
    'unset RUNNER_TOKEN',
    `timeout --kill-after=30 ${maxMin * 60} ./run.sh`,
  ].join('; ');
}

export function cmdRunner(sub, opts) {
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
    const target = opts.hosted ? null : JSON.stringify(['self-hosted', LABEL]);
    if (!slug) die('origin is not a GitHub repository');
    if (target) guard(ctx);
    if (opts['dry-run']) return out(`would ${target ? `set PROJ_RUNS_ON=${target}` : 'delete PROJ_RUNS_ON'} on ${slug}`);
    const r = target ? gh(['variable', 'set', 'PROJ_RUNS_ON', '-R', slug, '--body', target]) : gh(['variable', 'delete', 'PROJ_RUNS_ON', '-R', slug]);
    if (r.code !== 0) die(r.err);
    return out(target ? `CI for same-repo PRs now waits for a ${LABEL} runner: start one per run with \`proj runner start --docker\`` : 'CI back on GitHub-hosted runners');
  }
  if (sub === 'clean') {
    if (!slug) die('origin is not a GitHub repository');
    const list = ghJson(['api', `repos/${slug}/actions/runners`])?.runners || [];
    const stale = list.filter((r) => r.name.startsWith('proj-') && r.status === 'offline' && !r.busy);
    if (opts['dry-run'] || !stale.length) { for (const r of stale) out(`would remove offline runner ${r.name}`); return stale.length ? undefined : out('nothing to remove'); }
    for (const r of stale) out(`${gh(['api', '-X', 'DELETE', `repos/${slug}/actions/runners/${r.id}`]).code === 0 ? 'removed' : 'failed to remove'} ${r.name}`);
    return;
  }
  if (sub !== 'start') die('usage: proj runner [status|start|use|clean] [--docker|--host|--ddc] [--hosted] [--dry-run] [--max-minutes N]');

  const mode = opts.host ? 'host' : opts.ddc ? 'ddc' : 'docker';
  guard(ctx);
  if (mode === 'host' && !c.allowHost) die('running jobs directly on this machine is off: enable it with "runner": {"allowHost": true} in ~/.proj/config.json (only there). Prefer --docker, which is isolated.');
  const name = runnerName(mode);
  const url = `https://github.com/${slug}`;
  const labels = `${LABEL},${mode === 'host' ? process.platform : 'linux'}`;
  const script = runnerScript({ url, name, labels, maxMin });

  if (mode === 'docker') {
    if (run('docker', ['version', '--format', '{{.Server.Os}}']).code !== 0) die('docker is not running');
    const token = registrationToken(slug);
    // No host mounts, no host env, all capabilities dropped, no privilege escalation, capped CPU/memory/pids,
    // host.docker.internal blackholed, removed on exit. The client stays attached only to hand over the token.
    const args = ['run', '-i', '--rm', '--name', name, '--cpus', String(c.cpus || 4), '--memory', c.memory || '8g', '--pids-limit', '4096',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--add-host', 'host.docker.internal:0.0.0.0', IMAGE, 'bash', '-c', script];
    const child = spawn('docker', args, { stdio: ['pipe', 'ignore', 'ignore'], detached: true, windowsHide: true });
    child.stdin.end(`${token}\n`);
    child.unref();
    return out(`runner ${name} starting in a container (one job, then it exits; hard stop after ${maxMin} min)`);
  }
  if (mode === 'ddc') {
    const st = computeStatus(ctx);
    if (!st.ok) die(st.why, st.code);
    const token = registrationToken(slug);
    const remote = `set -e; d=/work/proj-runner/${name}; trap 'cd /; rm -rf "$d"' EXIT; mkdir -p $d; cd $d; curl -fsSL https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz | tar -xz; ${script}`;
    const b64 = Buffer.from(remote).toString('base64');
    const ddc = ctx.cfg.compute.ddc;
    const child = spawn(ddc[0], [...ddc.slice(1), 'run', '--timeout', String(maxMin * 60 + 300), `echo ${b64} | base64 -d > /tmp/${name}.sh && bash /tmp/${name}.sh`], { stdio: ['pipe', 'ignore', 'ignore'], detached: true, windowsHide: true });
    child.stdin.end(`${token}\n`);
    child.unref();
    return out(`runner ${name} starting on ${st.host} (already running box; nothing new is rented)`);
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
  const cfgArgs = ['--url', url, '--name', name, '--labels', labels, '--ephemeral', '--unattended', '--disableupdate', '--replace'];
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
