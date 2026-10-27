// Shared helpers: process runner, git/gh wrappers, config, per-repo state with a lock.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const HOME = process.env.PROJ_HOME || path.join(os.homedir(), '.proj');
export const STARTER_ROOT = path.resolve(import.meta.dirname, '..');

export class ProjError extends Error {
  constructor(msg, code = 1) { super(msg); this.code = code; }
}
export const die = (msg, code = 1) => { throw new ProjError(msg, code); };

// Run a program without a shell (no quoting surprises on Windows). Returns {code, out, err}.
export function run(cmd, args = [], { cwd, input, allowFail = true, env, timeout, raw = false } = {}) {
  const [bin, ...pre] = Array.isArray(cmd) ? cmd : [cmd];
  const r = spawnSync(bin, [...pre, ...args], {
    cwd, input, env: env ? { ...process.env, ...env } : process.env, encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024, timeout, windowsHide: true,
  });
  const res = { code: r.error ? 127 : r.status ?? 1, out: raw ? r.stdout || '' : (r.stdout || '').trim(), err: (r.stderr || r.error?.message || '').trim() };
  if (!allowFail && res.code !== 0) die(`${bin} ${[...pre, ...args].join(' ')} failed (${res.code}): ${res.err || res.out}`);
  return res;
}

// Run a user-configured command string through the platform shell, streaming output.
export function sh(command, { cwd, env, timeout } = {}) {
  const r = spawnSync(command, { cwd, shell: true, stdio: 'inherit', env: { ...process.env, ...env }, timeout, windowsHide: true });
  return r.error ? 127 : r.status ?? 1;
}

export const git = (args, opts = {}) => run('git', args, opts);
export const gitOk = (args, opts = {}) => run('git', args, { ...opts, allowFail: false }).out;

// gh is optional: commands that need GitHub degrade to "unknown" when it is absent or the remote is not GitHub.
export function gh(args, opts = {}) {
  if (process.env.PROJ_OFFLINE === '1') return { code: 127, out: '', err: 'offline' };
  return run('gh', args, opts);
}
export function ghJson(args, opts = {}) {
  const r = gh(args, opts);
  if (r.code !== 0) return null;
  try { return JSON.parse(r.out); } catch { return null; }
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
export const sha256 = (text) => crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
export const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
export const ageDays = (iso) => (Date.now() - Date.parse(iso)) / 86400000;

// ---------- config: built-in defaults <- ~/.proj/config.json <- <repo>/.proj.json ----------
export const DEFAULTS = {
  owner: null,              // GitHub owner for `proj new`; null = the gh-authenticated user
  visibility: 'private',
  defaultStack: 'node',
  maxAgents: 3,             // concurrent active tasks (worktrees) per repo
  maxOpenPRs: 3,            // open PRs per repo before `proj task` refuses
  staleDays: 21,
  activeHours: 6,           // a task with a heartbeat this recent belongs to a live session
  baseBranch: 'main',
  requiredCheck: 'verify',
  ci: { monthlyMinutes: 2000, warnAt: 0.8 },
  compute: {
    enabled: false,         // owner opt-in for offloading checks to an already-running ddc box
    ddc: ['ddc'],
    knownHosts: path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'drill-dev-cloud', 'known_hosts'),
    maxRuntimeMin: 30,
    maxWorkers: 8,
  },
};

function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? merge(a[k], v) : v;
  }
  return out;
}
export function loadConfig(repoRoot) {
  let cfg = merge(DEFAULTS, readJson(path.join(HOME, 'config.json'), {}));
  if (repoRoot) cfg = merge(cfg, readJson(path.join(repoRoot, '.proj.json'), {}));
  return cfg;
}

// ---------- repo context ----------
export function repoContext(cwd = process.cwd()) {
  const top = git(['rev-parse', '--show-toplevel'], { cwd });
  if (top.code !== 0) die('not inside a git repository');
  const root = path.resolve(top.out);
  const common = path.resolve(root, gitOk(['rev-parse', '--git-common-dir'], { cwd: root }));
  const mainRoot = path.basename(common) === '.git' ? path.dirname(common) : root;
  const stateDir = path.join(common, 'proj');
  const cfg = loadConfig(mainRoot);
  return { cwd, root, mainRoot, common, stateDir, cfg, remote: remoteInfo(root) };
}

export function remoteInfo(root) {
  const url = git(['remote', 'get-url', 'origin'], { cwd: root });
  if (url.code !== 0) return null;
  const m = url.out.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  return m ? { url: url.out, owner: m[1], name: m[2], slug: `${m[1]}/${m[2]}` } : { url: url.out };
}

// ---------- per-repo state, shared by every worktree (lives in the git common dir) ----------
export function withLock(stateDir, fn) {
  const lock = path.join(stateDir, 'lock');
  fs.mkdirSync(stateDir, { recursive: true });
  const deadline = Date.now() + 15000;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 60000) { fs.rmdirSync(lock); continue; } } catch {}
      if (Date.now() > deadline) die(`state is locked by another proj process (${lock})`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch {} }
}
export const statePath = (ctx) => path.join(ctx.stateDir, 'state.json');
export const loadState = (ctx) => ({ tasks: {}, checks: {}, reviews: {}, ...readJson(statePath(ctx), {}) });
export function updateState(ctx, fn) {
  return withLock(ctx.stateDir, () => {
    const st = loadState(ctx);
    const res = fn(st);
    writeJson(statePath(ctx), st);
    return res;
  });
}

// Global list of repos proj manages (for `doctor --all` and scheduled audits).
export function registerRepo(root) {
  const file = path.join(HOME, 'repos.json');
  withLock(HOME, () => {
    const list = readJson(file, []);
    const p = path.resolve(root);
    if (!list.includes(p)) { list.push(p); writeJson(file, list); }
  });
}
export const knownRepos = () => readJson(path.join(HOME, 'repos.json'), []).filter((p) => fs.existsSync(p));

// ---------- git facts ----------
export const headSha = (cwd) => git(['rev-parse', 'HEAD'], { cwd }).out || null;
export const currentBranch = (cwd) => git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd }).out || null;

// Dirty files including untracked (not ignored). Returns [{xy, file}].
export function dirtyFiles(cwd) {
  const r = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd, raw: true });
  if (r.code !== 0) return [];
  const parts = r.out.split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const xy = parts[i].slice(0, 2);
    out.push({ xy, file: parts[i].slice(3) });
    if (xy[0] === 'R' || xy[0] === 'C') i++; // rename source follows
  }
  return out;
}

export function worktrees(root) {
  const r = git(['worktree', 'list', '--porcelain'], { cwd: root });
  const list = [];
  let cur = null;
  for (const line of r.out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) { cur = { path: path.resolve(line.slice(9)) }; list.push(cur); }
    else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (line.startsWith('locked')) cur.locked = line.slice(7) || true;
    else if (line.startsWith('prunable')) cur.prunable = line.slice(9) || true;
    else if (line === 'bare') cur.bare = true;
    else if (line === 'detached') cur.detached = true;
  }
  return list;
}

// Best base ref to compare against: origin/<base> when it exists, else local <base>.
export function baseRef(ctx, cwd = ctx.root) {
  const b = ctx.cfg.baseBranch;
  return git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`], { cwd }).code === 0 ? `origin/${b}` : b;
}

export function changedFiles(ctx, cwd) {
  const base = baseRef(ctx, cwd);
  const mb = git(['merge-base', base, 'HEAD'], { cwd }).out;
  const committed = mb ? git(['diff', '--name-only', `${mb}..HEAD`], { cwd }).out.split(/\r?\n/) : [];
  return [...new Set([...committed, ...dirtyFiles(cwd).map((d) => d.file)])].filter(Boolean);
}

// Snapshot the working tree (tracked + untracked, not ignored) as a commit, without touching the
// index or any file. Returns the commit SHA, or null when the tree is clean.
export function snapshot(cwd, message) {
  if (!dirtyFiles(cwd).length) return null;
  const tmpIndex = path.join(os.tmpdir(), `proj-index-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    run('git', ['read-tree', 'HEAD'], { cwd, env, allowFail: false });
    run('git', ['add', '-A', '--', '.'], { cwd, env, allowFail: false });
    const tree = run('git', ['write-tree'], { cwd, env, allowFail: false }).out;
    return run('git', ['commit-tree', tree, '-p', 'HEAD', '-m', message], { cwd, allowFail: false }).out;
  } finally { fs.rmSync(tmpIndex, { force: true }); }
}

// Simple glob matcher for scope declarations: ** any depth, * within a segment.
export function globToRe(glob) {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '.*');
  return new RegExp(`^${re}$`);
}
export const matchesAny = (file, globs) => globs.some((g) => globToRe(g).test(file) || file.startsWith(g.replace(/\/$/, '') + '/'));
// Two scope globs may touch the same files when one's literal prefix contains the other's.
// ponytail: prefix heuristic, can report overlap that a real glob intersection would rule out.
export function globsOverlap(a, b) {
  const lit = (g) => g.split(/[*?[]/)[0];
  return a.some((x) => b.some((y) => lit(x).startsWith(lit(y)) || lit(y).startsWith(lit(x))));
}

// Paths that must never leave this machine (offload) or be committed by `proj new`.
export const SECRET_RE = /(^|\/)\.env($|\.)|\.(pem|key|keystore|p12|pfx)$|(^|\/)id\.json$|keypair[^/]*\.json$|secrets?\.(env|json|ya?ml)$|(^|\/)id_(rsa|ed25519|ecdsa)$/i;
export const isSecretPath = (f) => SECRET_RE.test(f) && !/\.env\.example$/.test(f);

// ---------- output ----------
export const out = (...a) => console.log(...a);
export const warn = (msg) => console.error(`! ${msg}`);
export const short = (sha) => (sha ? sha.slice(0, 10) : '-');
export function table(rows) {
  if (!rows.length) return '';
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i] ?? '').length)));
  return rows.map((r) => r.map((c, i) => String(c ?? '').padEnd(w[i])).join('  ').trimEnd()).join('\n');
}
