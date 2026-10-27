// Shared test helpers: temp repos with a local bare origin, and the proj CLI as a child process.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const BIN = path.join(ROOT, 'bin', 'proj.js');
export const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-test-'));
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 2 }); } catch {} });

// Hermetic git: no user global config (hooks, signing), fixed identity, discovery stops at SCRATCH.
const globalCfg = path.join(SCRATCH, 'gitconfig');
fs.writeFileSync(globalCfg, '');
export const ENV = { ...process.env, PROJ_OFFLINE: '1', GIT_CONFIG_GLOBAL: globalCfg, GIT_CEILING_DIRECTORIES: SCRATCH,
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
for (const k of ['CLAUDE_SESSION_ID', 'PROJ_DEBUG', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete ENV[k];

// Async so tests inside a { concurrency: true } describe really run in parallel.
export function run(cmd, args, { cwd, env, input = '', shell = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env: { ...ENV, ...env }, shell, windowsHide: true });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, out: out.trimEnd(), err: err.trim() }));
    p.stdin.end(input);
  });
}

export const proj = (args, { cwd, home, input, env } = {}) =>
  run(process.execPath, [BIN, ...args], { cwd, input, env: { PROJ_HOME: home || path.join(SCRATCH, 'home-default'), ...env } });

export async function git(cwd, ...args) {
  const r = await run('git', args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} (${cwd}) failed: ${r.err}`);
  return r.out;
}
export const gitTry = (cwd, ...args) => run('git', args, { cwd });

export function write(dir, rel, text) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}
export const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
export const exists = (...p) => fs.existsSync(path.join(...p));
export const tmpDir = (prefix = 'd-') => fs.mkdtempSync(path.join(SCRATCH, prefix));

// <parent>/repo (main, pushed) + <parent>/origin.git; task worktrees land in <parent>/repo.worktrees/<slug>.
export async function makeRepo({ files = {}, projJson } = {}) {
  const parent = tmpDir('r-');
  const root = path.join(parent, 'repo');
  const origin = path.join(parent, 'origin.git');
  const home = path.join(parent, 'home');
  await git(parent, 'init', '-q', '--bare', '-b', 'main', origin);
  await git(parent, 'init', '-q', '-b', 'main', root);
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) await git(root, 'config', k, v);
  write(root, 'README.md', '# test\n');
  for (const [rel, text] of Object.entries(files)) write(root, rel, text);
  if (projJson) write(root, '.proj.json', JSON.stringify(projJson, null, 2));
  await git(root, 'add', '-A');
  await git(root, 'commit', '-q', '-m', 'init');
  await git(root, 'remote', 'add', 'origin', origin);
  await git(root, 'push', '-q', '-u', 'origin', 'main');
  return {
    parent, root, origin, home,
    wt: (slug) => path.join(parent, 'repo.worktrees', slug),
    proj: (args, o = {}) => proj(args, { cwd: root, home, ...o }),
    state: () => JSON.parse(fs.readFileSync(path.join(root, '.git', 'proj', 'state.json'), 'utf8')),
  };
}

export async function commitAll(cwd, msg) {
  await git(cwd, 'add', '-A');
  await git(cwd, 'commit', '-q', '-m', msg);
  return git(cwd, 'rev-parse', 'HEAD');
}
