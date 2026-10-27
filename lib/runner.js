// proj runner: optional ephemeral self-hosted runners (one job, then gone). Docker (isolated, default),
// the host itself (opt-in), or an already running ddc box. Never provisions paid resources.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { die, gh, ghJson, run, out, warn, now, repoContext, HOME } from './core.js';
import { computeStatus } from './checks.js';

export const RUNNER_VERSION = '2.338.2';
export const LABEL = 'proj-ephemeral';
const IMAGE = `ghcr.io/actions/actions-runner:${RUNNER_VERSION}`;
const runnerName = (kind) => `proj-${kind}-${os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '')}-${now().replace(/\D/g, '').slice(4, 12)}`;

// Only private repos: a public repo's fork PRs would run stranger code on this hardware. The CI template
// additionally routes only same-repo, non-Dependabot PRs and owner dispatches to self-hosted runners.
function guard(ctx, opts) {
  if (!ctx.remote?.slug) die('origin is not a GitHub repository');
  const repo = ghJson(['repo', 'view', ctx.remote.slug, '--json', 'isPrivate,viewerPermission']);
  if (!repo) die('cannot read the repository (gh auth?)');
  if (!repo.isPrivate) die('refusing: self-hosted runners on a public repository would execute fork PR code on your machine');
  if (repo.viewerPermission !== 'ADMIN') die('registering a runner needs admin on the repository');
}

function registrationToken(slug) {
  const r = gh(['api', '-X', 'POST', `repos/${slug}/actions/runners/registration-token`, '--jq', '.token']);
  if (r.code !== 0 || !r.out) die(`could not get a registration token: ${r.err}`);
  return r.out; // valid ~1 hour, single purpose; never written to disk or logs
}

// Shell script the runner host executes. The token arrives via environment, not argv.
export function runnerScript({ url, name, labels, maxMin }) {
  return [
    'set -e',
    `./config.sh --url ${url} --token "$RUNNER_TOKEN" --name ${name} --labels ${labels} --ephemeral --unattended --disableupdate --replace`,
    'unset RUNNER_TOKEN',
    `timeout ${maxMin * 60} ./run.sh`,
  ].join(' && ').replace('set -e &&', 'set -e;');
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
    if (opts['dry-run']) return out(`would ${target ? `set PROJ_RUNS_ON=${target}` : 'delete PROJ_RUNS_ON'} on ${slug}`);
    const r = target ? gh(['variable', 'set', 'PROJ_RUNS_ON', '-R', slug, '--body', target]) : gh(['variable', 'delete', 'PROJ_RUNS_ON', '-R', slug]);
    if (r.code !== 0) die(r.err);
    return out(target ? `CI for same-repo PRs now waits for a ${LABEL} runner: start one per run with \`proj runner start --docker\`` : 'CI back on GitHub-hosted runners');
  }
  if (sub === 'clean') {
    const list = ghJson(['api', `repos/${slug}/actions/runners`])?.runners || [];
    const stale = list.filter((r) => r.name.startsWith('proj-') && r.status === 'offline' && !r.busy);
    if (opts['dry-run']) { for (const r of stale) out(`would remove offline runner ${r.name}`); return out(stale.length ? '' : 'nothing to remove'); }
    for (const r of stale) out(`${gh(['api', '-X', 'DELETE', `repos/${slug}/actions/runners/${r.id}`]).code === 0 ? 'removed' : 'failed to remove'} ${r.name}`);
    return;
  }
  if (sub !== 'start') die('usage: proj runner [status|start|use|clean] [--docker|--host|--ddc] [--hosted] [--dry-run] [--max-minutes N]');

  const mode = opts.host ? 'host' : opts.ddc ? 'ddc' : 'docker';
  guard(ctx, opts);
  if (mode === 'host' && !c.allowHost) die('running jobs directly on this machine is off: the owner enables it with "runner": {"allowHost": true} in ~/.proj/config.json. Prefer --docker (isolated).');
  const name = runnerName(mode);
  const url = `https://github.com/${slug}`;
  const labels = `${LABEL},${mode === 'host' ? process.platform : 'linux'}`;
  const script = runnerScript({ url, name, labels, maxMin });

  if (mode === 'docker') {
    if (run('docker', ['version', '--format', '{{.Server.Os}}']).code !== 0) die('docker is not running');
    const token = registrationToken(slug);
    // No host mounts, no host env, capped CPU/memory, removed on exit.
    const args = ['run', '-d', '--rm', '--name', name, '--cpus', String(c.cpus || 4), '--memory', c.memory || '8g', '--pids-limit', '4096',
      '--security-opt', 'no-new-privileges', '-e', 'RUNNER_TOKEN', IMAGE, 'bash', '-c', script];
    const r = run('docker', args, { env: { RUNNER_TOKEN: token } });
    if (r.code !== 0) die(`docker run failed: ${r.err}`);
    return out(`runner ${name} started in container ${r.out.slice(0, 12)} (one job, then it exits; hard stop after ${maxMin} min)`);
  }
  if (mode === 'ddc') {
    const st = computeStatus(ctx);
    if (!st.ok) die(st.why, st.code);
    const token = registrationToken(slug);
    const remote = `set -e; d=/work/proj-runner/${name}; mkdir -p $d; cd $d; curl -fsSL https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz | tar -xz; RUNNER_TOKEN=$(cat); export RUNNER_TOKEN; ${script}; cd /; rm -rf $d`;
    const b64 = Buffer.from(remote).toString('base64');
    const ddc = ctx.cfg.compute.ddc;
    const child = spawn(ddc[0], [...ddc.slice(1), 'run', '--timeout', String(maxMin * 60 + 300), `echo ${b64} | base64 -d > /tmp/${name}.sh && bash /tmp/${name}.sh`], { stdio: ['pipe', 'ignore', 'ignore'], detached: true, windowsHide: true });
    child.stdin.end(token + '\n');
    child.unref();
    return out(`runner ${name} starting on ${st.host} (already running box; nothing new is rented)`);
  }
  // host: dedicated directory, environment reduced to the basics so no tokens or keys leak into jobs.
  const dir = path.join(HOME, 'runners', name);
  fs.mkdirSync(dir, { recursive: true });
  const win = process.platform === 'win32';
  const pkg = `actions-runner-${win ? 'win' : process.platform === 'darwin' ? 'osx' : 'linux'}-x64-${RUNNER_VERSION}.${win ? 'zip' : 'tar.gz'}`;
  const dl = run('curl', ['-fsSL', '-o', path.join(dir, pkg), `https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${pkg}`], { timeout: 300000 });
  if (dl.code !== 0) die(`download failed: ${dl.err}`);
  run('tar', ['-xf', pkg], { cwd: dir, allowFail: false });
  const keep = ['SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramData', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'];
  const env = Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  const token = registrationToken(slug);
  const cfgArgs = ['--url', url, '--token', token, '--name', name, '--labels', labels, '--ephemeral', '--unattended', '--disableupdate', '--replace'];
  const conf = win ? run('cmd', ['/c', 'config.cmd', ...cfgArgs], { cwd: dir, env }) : run('./config.sh', cfgArgs, { cwd: dir, env });
  if (conf.code !== 0) die(`runner config failed: ${conf.err || conf.out}`);
  const child = spawn(win ? 'cmd' : './run.sh', win ? ['/c', 'run.cmd'] : [], { cwd: dir, env, detached: true, stdio: 'ignore', windowsHide: true, timeout: maxMin * 60000 });
  child.unref();
  out(`runner ${name} started on this machine in ${dir} (one job, then it unregisters)`);
}
