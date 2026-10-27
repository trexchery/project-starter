// proj doctor / clean: audits and safe cleanup. Cleanup is a dry run unless --apply; it never forces.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HOME, STARTER_ROOT, git, gh, ghJson, run, sh, now, ageDays, out, warn, short, writeAtomic, repoContext, loadState,
  updateState, knownRepos, dirtyFiles, worktrees, baseRef, die,
} from './core.js';
import { analyzeRuns } from './perf.js';
import { samePath, isOpen, wtAlive, prFor, ciAt, removeWorktree, deleteMergedBranch, ignoredKeepers } from './tasks.js';

function dirSize(dir, budget = { n: 300000 }) {
  let total = 0;
  const stack = [dir];
  while (stack.length && budget.n-- > 0) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '.git') stack.push(p); } else { try { total += fs.statSync(p).size; } catch {} }
    }
  }
  return total;
}
const mb = (b) => `${Math.round(b / 1048576)} MB`;

// Branches that are safe to delete: not checked out, not an open task, and provably merged.
export function mergedBranches(ctx, st) {
  const base = baseRef(ctx, ctx.mainRoot);
  const checkedOut = new Set(worktrees(ctx.mainRoot).map((w) => w.branch).filter(Boolean));
  const openBranches = new Set(Object.values(st.tasks).filter(isOpen).map((t) => t.branch));
  const lines = git(['for-each-ref', '--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)', 'refs/heads'], { cwd: ctx.mainRoot }).out.split(/\r?\n/).filter(Boolean);
  const res = { merged: [], stale: [] };
  for (const line of lines) {
    const [name, sha, date] = line.split('\t');
    if (name === ctx.cfg.baseBranch || checkedOut.has(name) || openBranches.has(name)) continue;
    // Branches proj did not create are deleted only with a merge proof and only once they are not brand new.
    const ours = name.startsWith('task/');
    if (!ours && ageDays(date) * 24 < ctx.cfg.activeHours) continue;
    let how = null;
    if (git(['merge-base', '--is-ancestor', sha, base], { cwd: ctx.mainRoot }).code === 0) how = 'merged';
    else {
      const pr = prFor(ctx, name);
      if (pr?.state === 'MERGED' && pr.headRefOid === sha) how = `squash-merged in PR #${pr.number}`;
      else if (ours) {
        // Offline proof: merging the branch into base would change nothing, so its content is already there.
        const mt = git(['merge-tree', '--write-tree', base, sha], { cwd: ctx.mainRoot });
        if (mt.code === 0 && mt.out.split('\n')[0] === git(['rev-parse', `${base}^{tree}`], { cwd: ctx.mainRoot }).out) how = 'content already in base';
      }
    }
    if (how) res.merged.push({ name, sha, how });
    else if (ageDays(date) > ctx.cfg.staleDays) res.stale.push({ name, sha, days: Math.round(ageDays(date)) });
  }
  return res;
}

function actionsMinutes(ctx) {
  const login = gh(['api', 'user', '--jq', '.login']).out;
  if (!login) return null;
  const d = new Date();
  const usage = ghJson(['api', `users/${login}/settings/billing/usage?year=${d.getUTCFullYear()}&month=${d.getUTCMonth() + 1}`]);
  if (usage?.usageItems) {
    const mins = usage.usageItems.filter((u) => u.product === 'actions' && /minute/i.test(u.unitType)).reduce((a, u) => a + u.quantity, 0);
    return { mins: Math.round(mins), source: 'billing API (all repos)' };
  }
  // Fallback without the `user` scope: sum job minutes of this month's runs in this repo (private repos bill).
  if (!ctx.remote?.slug) return null;
  const since = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const runs = ghJson(['api', `repos/${ctx.remote.slug}/actions/runs?per_page=100&created=>=${since}`])?.workflow_runs || [];
  for (const r of runs) r.jobs = ghJson(['api', `repos/${ctx.remote.slug}/actions/runs/${r.id}/jobs?per_page=100`])?.jobs || [];
  const mins = analyzeRuns(runs).totalBilled; // same billing rules as `proj perf` (self-hosted and Dependabot free)
  return { mins, source: `job timings of ${runs.length} run(s) in ${ctx.remote.slug} (run \`gh auth refresh -s user\` for account-wide billing)` };
}

export function doctor(ctx, opts = {}) {
  const st = loadState(ctx);
  const F = [];
  const add = (sev, what, fix) => F.push({ sev, what, fix });
  const online = !opts.offline && ctx.remote?.slug;
  const wts = worktrees(ctx.mainRoot);

  for (const t of Object.values(st.tasks).filter(isOpen)) {
    if (!wtAlive(t)) add('warn', `task ${t.slug}: worktree missing`, `proj resume ${t.slug} --restore`);
    else if (ageDays(t.heartbeat) > ctx.cfg.staleDays) add('warn', `task ${t.slug}: no activity for ${Math.round(ageDays(t.heartbeat))} days`, `proj resume ${t.slug}, or proj finish ${t.slug} --abandon`);
  }
  for (const w of wts) {
    if (w.prunable) add('info', `orphaned worktree metadata: ${w.path}`, 'proj clean --apply');
    else if (!samePath(w.path, ctx.mainRoot) && !Object.values(st.tasks).some((t) => samePath(t.worktree, w.path)))
      add('info', `worktree not tracked by proj: ${w.path} (${w.branch || 'detached'}${w.locked ? ', locked' : ''})`, 'leave it if another tool owns it');
  }
  const sizes = wts.filter((w) => !w.prunable && fs.existsSync(w.path)).map((w) => [w.path, dirSize(w.path)]);
  const total = sizes.reduce((a, [, s]) => a + s, 0);
  if (total > 2 * 1024 ** 3) add('warn', `worktrees use ${mb(total)}: ${sizes.sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p, s]) => `${path.basename(p)} ${mb(s)}`).join(', ')}`, 'finish idle tasks');
  else add('ok', `worktrees use ${mb(total)} across ${sizes.length}`, null);

  const br = mergedBranches(ctx, st);
  if (br.merged.length) add('info', `${br.merged.length} merged branch(es): ${br.merged.slice(0, 5).map((b) => b.name).join(', ')}`, 'proj clean --apply');
  for (const b of br.stale) add('info', `branch ${b.name} unmerged, untouched for ${b.days} days`, 'review it; proj never deletes unmerged work');

  if (online) {
    const prs = ghJson(['pr', 'list', '-R', ctx.remote.slug, '--state', 'open', '--limit', '100', '--json', 'number,title,isDraft,updatedAt,headRefOid,headRefName']) || [];
    if (prs.length > ctx.cfg.maxOpenPRs) add('warn', `${prs.length} open PRs (cap ${ctx.cfg.maxOpenPRs})`, 'land or close some');
    for (const p of prs) {
      if (ageDays(p.updatedAt) > ctx.cfg.staleDays) add('warn', `PR #${p.number} "${p.title}" idle ${Math.round(ageDays(p.updatedAt))} days`, `finish it or close it: gh pr close ${p.number}`);
      if (!p.isDraft) {
        const ci = ciAt(ctx, p.headRefOid);
        if (['failure', 'cancelled', 'timed_out', 'action_required'].includes(ci.state)) add('warn', `PR #${p.number}: CI ${ci.state} at ${short(p.headRefOid)}`, ci.url);
      }
    }
    const issues = ghJson(['issue', 'list', '-R', ctx.remote.slug, '--state', 'open', '--limit', '200', '--json', 'number,title']) || [];
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2).sort().join(' ');
    const groups = {};
    for (const i of issues) (groups[norm(i.title)] ||= []).push(i.number);
    for (const nums of Object.values(groups)) if (nums.length > 1) add('warn', `possible duplicate issues: ${nums.map((n) => `#${n}`).join(', ')}`, 'close duplicates, keep one');
    const m = actionsMinutes(ctx);
    if (m) {
      const cap = ctx.cfg.ci.monthlyMinutes;
      add(m.mins >= cap * ctx.cfg.ci.warnAt ? 'warn' : 'ok', `Actions minutes this month: ${m.mins}/${cap} (${m.source})`, m.mins >= cap * ctx.cfg.ci.warnAt ? 'keep PRs as drafts; batch ready-for-review' : null);
    }
  }
  if (opts.deps && fs.existsSync(path.join(ctx.mainRoot, 'package.json'))) {
    const r = run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['outdated', '--json'], { cwd: ctx.mainRoot, timeout: 120000 });
    let o = {};
    try { o = JSON.parse(r.out || '{}'); } catch {}
    const names = Object.keys(o);
    if (names.length) add('info', `${names.length} outdated npm package(s): ${names.slice(0, 6).join(', ')}`, 'Dependabot opens grouped PRs monthly; or update in a task');
  }
  const settings = path.join(ctx.mainRoot, '.claude', 'settings.json');
  if (!fs.existsSync(settings) || !fs.readFileSync(settings, 'utf8').includes('proj hook')) add('info', 'Claude hooks for checkpoints are not installed', 'proj adopt (adds them when .claude/settings.json is missing)');
  return F;
}

function starterUpdate() {
  if (git(['fetch', '--quiet', 'origin'], { cwd: STARTER_ROOT, timeout: 30000 }).code !== 0) return null;
  const behind = Number(git(['rev-list', '--count', 'HEAD..@{u}'], { cwd: STARTER_ROOT }).out || 0);
  return behind ? { sev: 'info', what: `project-starter is ${behind} commit(s) behind`, fix: 'proj self-update' } : null;
}

export function cmdDoctor(opts) {
  if (opts.schedule) return schedule(opts.schedule);
  const repos = opts.all ? knownRepos() : [repoContext().mainRoot];
  const lines = [`# proj doctor ${now()}`];
  const json = { at: now(), starter: null, repos: [] }; // --json: the same findings, for skills and scripts
  let worst = 0;
  const up = opts.offline ? null : starterUpdate();
  if (up) { lines.push(`- [${up.sev}] ${up.what} -> ${up.fix}`); json.starter = up; }
  for (const r of repos) {
    let ctx;
    try { ctx = repoContext(r); } catch (e) {
      lines.push(`\n## ${r}\n- [warn] ${e.message}`);
      json.repos.push({ repo: r, findings: [{ sev: 'warn', what: e.message, fix: null }] });
      worst = 1;
      continue;
    }
    lines.push(`\n## ${ctx.remote?.slug || r}`);
    const findings = doctor(ctx, opts);
    json.repos.push({ repo: ctx.remote?.slug || r, path: ctx.mainRoot, findings });
    for (const f of findings) {
      if (f.sev === 'ok' && !opts.verbose) { lines.push(`- ${f.what}`); continue; }
      worst = Math.max(worst, f.sev === 'warn' ? 1 : 0);
      lines.push(`- [${f.sev}] ${f.what}${f.fix ? ` -> ${f.fix}` : ''}`);
    }
  }
  const text = lines.join('\n') + '\n';
  out(opts.json ? JSON.stringify(json, null, 2) : text.trimEnd());
  if (opts.report) {
    const file = path.join(HOME, 'reports', `doctor-${now().slice(0, 10)}.md`);
    writeAtomic(file, text);
    out(`report: ${file}`);
  }
  process.exitCode = worst;
}

// Weekly local audit through Windows Task Scheduler (cron line elsewhere). /F replaces our own task: idempotent.
function schedule(when) {
  if (process.platform !== 'win32') return out(`add to crontab: 0 9 * * 1 proj doctor --all --report --offline`);
  if (when === 'off') return out(run('schtasks', ['/Delete', '/TN', 'proj-doctor', '/F']).out || 'removed');
  const cmd = `cmd /c proj doctor --all --report > "%USERPROFILE%\\.proj\\reports\\last-run.log" 2>&1`;
  const r = run('schtasks', ['/Create', '/TN', 'proj-doctor', '/SC', 'WEEKLY', '/D', 'MON', '/ST', '09:00', '/TR', cmd, '/F']);
  fs.mkdirSync(path.join(HOME, 'reports'), { recursive: true });
  out(r.code === 0 ? 'scheduled: proj doctor --all --report every Monday 09:00 (reports in ~/.proj/reports)' : `schtasks failed: ${r.err}`);
}

// ---------- proj clean ----------
export function cmdClean(opts) {
  const ctx = repoContext();
  const apply = !!opts.apply;
  const st = loadState(ctx);
  const plan = [];
  const skipped = [];

  if (worktrees(ctx.mainRoot).some((w) => w.prunable && !w.locked)) plan.push({ what: 'prune metadata of worktrees whose directory is gone', do: () => git(['worktree', 'prune'], { cwd: ctx.mainRoot }) });

  for (const t of Object.values(st.tasks).filter(isOpen)) {
    if (ageDays(t.heartbeat) * 24 < ctx.cfg.activeHours) { skipped.push(`${t.slug}: active in the last ${ctx.cfg.activeHours}h`); continue; }
    const pr = prFor(ctx, t.branch);
    if (pr?.state !== 'MERGED') continue;
    const exists = wtAlive(t);
    const tip = git(['rev-parse', '--verify', '--quiet', `refs/heads/${t.branch}`], { cwd: ctx.mainRoot }).out;
    if (exists && dirtyFiles(t.worktree).length) { skipped.push(`${t.slug}: merged but has uncommitted changes`); continue; }
    if (tip && tip !== pr.headRefOid) { skipped.push(`${t.slug}: local commits not in the merged PR`); continue; }
    if (exists && ignoredKeepers(t.worktree).length) { skipped.push(`${t.slug}: ignored non-build files in the worktree`); continue; }
    plan.push({ what: `finish merged task ${t.slug} (PR #${pr.number}): remove clean worktree, archive + delete branch`, do: () => {
      if (exists) removeWorktree(ctx, t);
      if (tip) deleteMergedBranch(ctx, t.branch, tip);
      updateState(ctx, (s) => Object.assign(s.tasks[t.slug], { status: 'finished', endedAt: now(), pr: pr.number }));
    } });
  }
  for (const b of mergedBranches(ctx, st).merged) plan.push({ what: `delete branch ${b.name} (${b.how}); archived under refs/proj-archive/`, do: () => deleteMergedBranch(ctx, b.name, b.sha) });

  if (!plan.length) out('nothing to clean');
  for (const p of plan) {
    out(`${apply ? 'doing' : 'would'}: ${p.what}`);
    if (apply) { try { p.do(); } catch (e) { warn(`skipped: ${e.message}`); } }
  }
  for (const s of skipped) out(`kept: ${s}`);
  if (!apply && plan.length) out('Dry run. Apply with: proj clean --apply');
}
