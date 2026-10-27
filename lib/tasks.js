// proj task / status / finish / checkpoint / resume / review / hook: tracked worktrees and handoffs.
import fs from 'node:fs';
import path from 'node:path';
import {
  die, git, gitOk, gh, ghJson, now, ageDays, out, warn, short, table, writeAtomic, repoContext, loadState,
  updateState, headSha, currentBranch, dirtyFiles, worktrees, baseRef, changedFiles, snapshot, globsOverlap,
} from './core.js';

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,48}$/;
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const isInside = (child, parent) => { const r = path.relative(path.resolve(parent).toLowerCase(), path.resolve(child).toLowerCase()); return !r.startsWith('..') && !path.isAbsolute(r); };
export const isOpen = (t) => t.status === 'active';
export const handoffPath = (ctx, slug) => path.join(ctx.stateDir, 'handoffs', `${slug}.md`);
export const checkpointRef = (slug) => `refs/proj/checkpoints/${slug}`;

export function taskForCwd(ctx, st = loadState(ctx)) {
  return Object.values(st.tasks).find((t) => samePath(t.worktree, ctx.root)) ||
    Object.values(st.tasks).find((t) => isOpen(t) && t.branch === currentBranch(ctx.root)) || null;
}
export function resolveTask(ctx, slug, st = loadState(ctx)) {
  const t = slug ? st.tasks[slug] : taskForCwd(ctx, st);
  if (!t) die(slug ? `no task "${slug}" (see \`proj status\`)` : 'not inside a task worktree: pass the task slug');
  return t;
}

// ---------- GitHub facts (null when gh/GitHub is unavailable) ----------
export function prFor(ctx, branch) {
  if (!ctx.remote?.slug) return null;
  const list = ghJson(['pr', 'list', '-R', ctx.remote.slug, '--head', branch, '--state', 'all', '--limit', '5',
    '--json', 'number,state,isDraft,headRefOid,mergedAt,mergeCommit,url,reviewDecision,baseRefName,updatedAt,title']);
  return list?.sort((a, b) => b.number - a.number)[0] || null;
}

// Verdict of the required check for one exact SHA. Only conclusion=success counts as verified:
// a draft-skipped job reports "skipped", which GitHub's required checks would accept but we never do.
export function ciAt(ctx, sha) {
  if (!ctx.remote?.slug || !sha) return { state: 'unknown' };
  const r = ghJson(['api', `repos/${ctx.remote.slug}/commits/${sha}/check-runs?per_page=100&filter=all`]);
  if (!r) return { state: 'unknown' };
  const runs = r.check_runs.filter((c) => c.name === ctx.cfg.requiredCheck && c.head_sha === sha).sort((a, b) => b.id - a.id);
  const latest = runs[0];
  if (!latest) return { state: 'none' };
  if (latest.status !== 'completed') return { state: 'pending', url: latest.html_url };
  return { state: latest.conclusion === 'success' ? 'verified' : latest.conclusion, url: latest.html_url, runs: runs.length };
}

// ---------- proj task ----------
export function cmdTask(slug, opts) {
  const ctx = repoContext();
  if (!slug || !SLUG_RE.test(slug)) die('usage: proj task <slug> [--goal ".."] [--issue N] [--files "src/a/**,docs/x.md"] [--base main]  (slug: lowercase, digits, . _ -)');
  const st = loadState(ctx);
  const open = Object.values(st.tasks).filter(isOpen);
  const branch = `task/${slug}`;
  const issue = opts.issue ? Number(opts.issue) : null;
  const files = opts.files ? String(opts.files).split(',').map((s) => s.trim()).filter(Boolean) : [];

  // duplicates and caps
  if (st.tasks[slug] && isOpen(st.tasks[slug])) die(`task "${slug}" is already active at ${st.tasks[slug].worktree}\n  resume it: proj resume ${slug}`);
  const dupIssue = issue && open.find((t) => t.issue === issue);
  if (dupIssue) die(`issue #${issue} already belongs to active task "${dupIssue.slug}" (${dupIssue.worktree})`);
  if (open.length >= ctx.cfg.maxAgents) die(`${open.length}/${ctx.cfg.maxAgents} tasks active (${open.map((t) => t.slug).join(', ')}): finish or abandon one first, or raise maxAgents in .proj.json`, 3);
  if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: ctx.root }).code === 0) die(`branch ${branch} already exists: pick another slug or \`proj resume ${slug} --restore\``);
  if (ctx.remote?.slug) {
    const prs = ghJson(['pr', 'list', '-R', ctx.remote.slug, '--state', 'open', '--limit', '100', '--json', 'number,headRefName,body,title']);
    if (prs) {
      if (prs.length >= ctx.cfg.maxOpenPRs) die(`${prs.length}/${ctx.cfg.maxOpenPRs} PRs open: land or close one before starting more work`, 3);
      const same = prs.find((p) => p.headRefName === branch || (issue && new RegExp(`#${issue}\\b`).test(`${p.title} ${p.body}`)));
      if (same) die(`open PR #${same.number} (${same.headRefName}) already covers this; continue there instead of opening a second PR`);
    }
  }

  // overlapping scope with other active tasks (declared globs or files they already changed)
  const overlaps = [];
  for (const t of open) {
    const theirs = fs.existsSync(t.worktree) ? changedFiles(ctx, t.worktree) : [];
    if (files.length && (globsOverlap(files, t.files || []) || globsOverlap(files, theirs))) overlaps.push(t.slug);
  }
  if (overlaps.length && !opts['allow-overlap']) die(`declared files overlap active task(s): ${overlaps.join(', ')}. Coordinate, narrow --files, or pass --allow-overlap.`);

  const base = opts.base || ctx.cfg.baseBranch;
  if (ctx.remote) git(['fetch', '--quiet', 'origin', base], { cwd: ctx.root });
  const start = git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`], { cwd: ctx.root }).code === 0 ? `origin/${base}` : base;
  const wtRoot = path.join(path.dirname(ctx.mainRoot), `${path.basename(ctx.mainRoot)}.worktrees`);
  const wt = path.join(wtRoot, slug);
  if (fs.existsSync(wt)) die(`${wt} already exists; refusing to reuse a directory that may hold someone's work`);
  fs.mkdirSync(wtRoot, { recursive: true });
  gitOk(['worktree', 'add', '--lock', '--reason', `proj task ${slug}`, '--no-track', '-b', branch, wt, start], { cwd: ctx.root });
  const baseSha = headSha(wt);
  const task = {
    slug, branch, worktree: wt, base, baseSha, issue, files, goal: opts.goal || '', owner: opts.owner || process.env.CLAUDE_SESSION_ID || null,
    status: 'active', createdAt: now(), heartbeat: now(), decisions: [], blockers: [], next: 'Read the goal, run `proj check`, make the smallest change that meets it.',
  };
  updateState(ctx, (s) => { s.tasks[slug] = task; });
  writeHandoff(ctx, task);
  out(`task ${slug}: ${wt}\n  branch ${branch} from ${start} @ ${short(baseSha)}  (${open.length + 1}/${ctx.cfg.maxAgents} active)`);
  if (overlaps.length) warn(`overlaps with ${overlaps.join(', ')} (allowed)`);
  out(`Next: cd "${wt}"`);
}

// ---------- handoff rendering (goal, decisions, SHA, dirty files, progress, tests, blockers, next) ----------
export function handoffText(ctx, t, st = loadState(ctx)) {
  const exists = fs.existsSync(t.worktree);
  const sha = exists ? headSha(t.worktree) : git(['rev-parse', '--verify', '--quiet', t.branch], { cwd: ctx.mainRoot }).out || t.lastSha;
  const dirty = exists ? dirtyFiles(t.worktree) : [];
  const log = sha ? git(['log', '--format=%h %s', '-n', '6', `${t.baseSha}..${sha}`], { cwd: ctx.mainRoot }).out : '';
  const snap = git(['rev-parse', '--verify', '--quiet', checkpointRef(t.slug)], { cwd: ctx.mainRoot }).out;
  const checks = (st.checks[sha] || []).slice(-3);
  const L = [];
  L.push(`# Handoff: ${t.slug} (${now()})`);
  L.push(`Goal: ${t.goal || '(none recorded: ask the owner or read the issue)'}${t.issue ? ` (issue #${t.issue})` : ''}`);
  L.push(`Branch: ${t.branch} @ ${sha || '?'}  (base ${t.base} @ ${short(t.baseSha)})`);
  L.push(`Worktree: ${t.worktree}${exists ? '' : '  MISSING: run `proj resume ' + t.slug + ' --restore`'}`);
  L.push(`Dirty: ${dirty.length ? `${dirty.length} file(s): ${dirty.slice(0, 12).map((d) => d.file).join(', ')}${dirty.length > 12 ? ', ...' : ''}` : 'clean'}`);
  if (snap) L.push(`Last snapshot of uncommitted work: ${checkpointRef(t.slug)} = ${short(snap)}`);
  L.push(`Progress:${log ? '\n' + log.split('\n').map((l) => `- ${l}`).join('\n') : ' no commits yet'}`);
  L.push(`Tests at this SHA: ${checks.length ? checks.map((c) => `${c.kind} ${c.exit === 0 ? 'PASS' : `FAIL(${c.exit})`}${c.dirty ? ' (dirty tree, not SHA-verified)' : ''} [${c.where}] \`${c.cmd}\``).join('; ') : 'none recorded'}`);
  if (t.pr) L.push(`PR: #${t.pr}`);
  if (t.files?.length) L.push(`Scope: ${t.files.join(', ')}`);
  if (t.decisions?.length) L.push(`Decisions:\n${t.decisions.map((d) => `- ${d}`).join('\n')}`);
  L.push(`Blockers: ${t.blockers?.length ? '\n' + t.blockers.map((b) => `- ${b}`).join('\n') : 'none'}`);
  L.push(`Next: ${t.next || '(not set)'}`);
  return L.join('\n') + '\n';
}
export function writeHandoff(ctx, t) {
  writeAtomic(handoffPath(ctx, t.slug), handoffText(ctx, t));
}

// ---------- proj checkpoint ----------
export function checkpoint(ctx, t, opts = {}) {
  let snap = null;
  if (fs.existsSync(t.worktree)) {
    snap = snapshot(t.worktree, `proj checkpoint ${t.slug} ${now()}`);
    if (snap) {
      const prev = git(['rev-parse', '--verify', '--quiet', `${checkpointRef(t.slug)}^{tree}`], { cwd: t.worktree }).out;
      const tree = gitOk(['rev-parse', `${snap}^{tree}`], { cwd: t.worktree });
      if (prev !== tree) gitOk(['update-ref', '--create-reflog', '-m', `checkpoint ${now()}`, checkpointRef(t.slug), snap], { cwd: t.worktree });
    }
  }
  const updated = updateState(ctx, (st) => {
    const cur = st.tasks[t.slug];
    if (opts.note) cur.decisions = [...(cur.decisions || []), opts.note];
    if (opts.decision) cur.decisions = [...(cur.decisions || []), opts.decision];
    if (opts.blocker) cur.blockers = [...(cur.blockers || []), opts.blocker];
    if (opts['clear-blockers']) cur.blockers = [];
    if (opts.next) cur.next = opts.next;
    if (opts.goal) cur.goal = opts.goal;
    if (opts.owner) cur.owner = opts.owner;
    cur.heartbeat = now();
    cur.lastSha = fs.existsSync(t.worktree) ? headSha(t.worktree) : cur.lastSha;
    return cur;
  });
  writeHandoff(ctx, updated);
  return { task: updated, snap };
}

export function cmdCheckpoint(opts) {
  const ctx = repoContext();
  const t = resolveTask(ctx, opts.task);
  const { task, snap } = checkpoint(ctx, t, opts);
  if (opts.push) pushTask(ctx, task, { draft: true });
  if (!opts.quiet) out(`checkpoint ${task.slug} @ ${short(task.lastSha)}${snap ? `, uncommitted work saved to ${checkpointRef(task.slug)}` : ', tree clean'}\n  handoff: ${handoffPath(ctx, task.slug)}`);
}

// Push the task branch (plain push, never forced) and make sure exactly one PR exists for it.
export function pushTask(ctx, t, { draft }) {
  if (!ctx.remote?.slug) die('no GitHub origin to push to');
  const r = git(['push', '--quiet', '-u', 'origin', `${t.branch}:${t.branch}`], { cwd: t.worktree });
  if (r.code !== 0) die(`push rejected (no force push is ever attempted): ${r.err}`);
  let pr = prFor(ctx, t.branch);
  if (!pr || pr.state === 'CLOSED') {
    const body = `${t.goal || ''}${t.issue ? `\n\nCloses #${t.issue}` : ''}\n\nOpened by \`proj\` as a draft: CI runs when it is marked ready.`;
    const c = gh(['pr', 'create', '-R', ctx.remote.slug, '--head', t.branch, '--base', t.base, '--title', t.goal?.slice(0, 70) || t.slug, '--body', body, ...(draft ? ['--draft'] : [])], { cwd: t.worktree });
    if (c.code !== 0) die(`gh pr create failed: ${c.err}`);
    pr = prFor(ctx, t.branch);
  }
  updateState(ctx, (st) => { st.tasks[t.slug].pr = pr?.number ?? null; });
  out(`pushed ${t.branch}; PR #${pr?.number} ${pr?.isDraft ? '(draft: no CI minutes)' : ''} ${pr?.url || ''}`);
  return pr;
}

// ---------- proj resume ----------
export function cmdResume(slug, opts) {
  const ctx = repoContext();
  const st = loadState(ctx);
  if (!slug && !taskForCwd(ctx, st)) {
    const open = Object.values(st.tasks).filter(isOpen);
    if (!open.length) return out('no active tasks. Start one: proj task <slug> --goal "..."');
    for (const t of open) out(`${t.slug}: next: ${t.next}  (${t.worktree}${fs.existsSync(t.worktree) ? '' : ', MISSING'})`);
    return out('Resume one: proj resume <slug>');
  }
  const t = resolveTask(ctx, slug, st);
  if (!fs.existsSync(t.worktree)) {
    if (!opts.restore) { out(handoffText(ctx, t, st)); return out(`worktree is missing. Recreate it: proj resume ${t.slug} --restore`); }
    restore(ctx, t);
  }
  const prevSha = t.lastSha;
  const { task } = checkpoint(ctx, t, { owner: opts.owner });
  out(fs.readFileSync(handoffPath(ctx, task.slug), 'utf8'));
  if (prevSha && prevSha !== task.lastSha) out(`HEAD moved since the last checkpoint: ${short(prevSha)} -> ${short(task.lastSha)}`);
  out(`cd "${task.worktree}"`);
}

// Recreate a lost worktree from the branch (local, else origin), then lay the last snapshot of
// uncommitted work on top. It only ever writes into the fresh, empty worktree.
function restore(ctx, t) {
  const local = git(['rev-parse', '--verify', '--quiet', `refs/heads/${t.branch}`], { cwd: ctx.mainRoot }).code === 0;
  git(['worktree', 'prune'], { cwd: ctx.mainRoot }); // drop metadata of the vanished directory (locked entries are kept by git)
  const stale = worktrees(ctx.mainRoot).find((w) => samePath(w.path, t.worktree));
  if (stale) { gitOk(['worktree', 'unlock', t.worktree], { cwd: ctx.mainRoot }); gitOk(['worktree', 'prune'], { cwd: ctx.mainRoot }); }
  if (!local) {
    if (git(['fetch', '--quiet', 'origin', `${t.branch}:refs/remotes/origin/${t.branch}`], { cwd: ctx.mainRoot }).code !== 0) die(`branch ${t.branch} exists neither locally nor on origin`);
    gitOk(['branch', '--no-track', t.branch, `origin/${t.branch}`], { cwd: ctx.mainRoot });
  }
  gitOk(['worktree', 'add', '--lock', '--reason', `proj task ${t.slug}`, t.worktree, t.branch], { cwd: ctx.mainRoot });
  const snap = git(['rev-parse', '--verify', '--quiet', checkpointRef(t.slug)], { cwd: ctx.mainRoot }).out;
  const tip = headSha(t.worktree);
  if (snap && git(['rev-parse', `${snap}^`], { cwd: ctx.mainRoot }).out === tip) {
    gitOk(['checkout', snap, '--', '.'], { cwd: t.worktree });
    gitOk(['reset', '-q'], { cwd: t.worktree }); // keep the restored changes uncommitted and unstaged, as they were
    out(`restored uncommitted work from ${checkpointRef(t.slug)} (${short(snap)})`);
  } else if (snap) warn(`snapshot ${short(snap)} was taken on another commit than ${t.branch}; inspect it with: git diff ${t.branch} ${snap}`);
  out(`worktree recreated at ${t.worktree}`);
}

// ---------- proj review: record a reviewer verdict for the exact SHA ----------
export function cmdReview(opts) {
  const ctx = repoContext();
  const sha = headSha(ctx.root);
  if (dirtyFiles(ctx.root).length) die('commit first: a review is recorded against an exact SHA');
  const verdict = opts.verdict || 'pass';
  if (!['pass', 'fail'].includes(verdict)) die('--verdict pass|fail');
  updateState(ctx, (st) => { (st.reviews[sha] ||= []).push({ verdict, by: opts.by || 'agent', note: opts.note || '', at: now() }); });
  out(`review ${verdict} recorded for ${short(sha)}`);
}

// ---------- proj status: one line per task, honest delivery levels ----------
export function taskLevels(ctx, t, st, { online = true } = {}) {
  const exists = fs.existsSync(t.worktree);
  const sha = exists ? headSha(t.worktree) : t.lastSha;
  const dirty = exists ? dirtyFiles(t.worktree).length : 0;
  const ahead = sha ? Number(git(['rev-list', '--count', `${t.baseSha}..${sha}`], { cwd: ctx.mainRoot }).out || 0) : 0;
  const checks = (st.checks[sha] || []).filter((c) => !c.dirty);
  const passed = checks.filter((c) => c.exit === 0).map((c) => c.kind);
  const failed = checks.some((c) => c.exit !== 0);
  const reviewed = (st.reviews[sha] || []).at(-1)?.verdict;
  const pr = online ? prFor(ctx, t.branch) : null;
  const ci = online && pr ? ciAt(ctx, sha) : { state: 'unknown' };
  const released = pr?.state === 'MERGED' && pr.headRefOid === sha;
  return {
    slug: t.slug, sha, dirty, ahead, exists, pr,
    implemented: ahead > 0 ? `${ahead} commit(s)` : 'no',
    tested: passed.includes('full') ? 'full' : passed.length ? passed.join('+') : failed ? 'FAILED' : 'no',
    reviewed: reviewed || (pr?.reviewDecision === 'APPROVED' ? 'approved' : 'no'),
    ci: ci.state,
    released: released ? 'merged' : pr?.state === 'MERGED' ? 'merged (different SHA!)' : 'no',
  };
}

export function cmdStatus(opts) {
  const ctx = repoContext();
  const st = loadState(ctx);
  const tasks = Object.values(st.tasks).filter((t) => opts.all || isOpen(t));
  const online = !opts.offline;
  const rows = tasks.map((t) => taskLevels(ctx, t, st, { online }));
  if (opts.json) return out(JSON.stringify(rows, null, 2));
  const open = Object.values(st.tasks).filter(isOpen).length;
  out(`${ctx.remote?.slug || path.basename(ctx.mainRoot)}  ${open}/${ctx.cfg.maxAgents} tasks active  protection: ${st.github?.enforcement || 'unknown'}`);
  if (!rows.length) return out('no active tasks. Start one: proj task <slug> --goal "..."');
  out(table([
    ['task', 'sha', 'dirty', 'implemented', 'tested', 'reviewed', 'ci@sha', 'released', 'pr'],
    ...rows.map((r) => [r.slug, short(r.sha), r.exists ? r.dirty : 'MISSING', r.implemented, r.tested, r.reviewed, r.ci, r.released, r.pr ? `#${r.pr.number}${r.pr.isDraft ? ' draft' : ''}` : '-']),
  ]));
  // overlap report between active tasks (files actually changed)
  const changed = tasks.filter((t) => isOpen(t) && fs.existsSync(t.worktree)).map((t) => [t.slug, new Set(changedFiles(ctx, t.worktree))]);
  for (let i = 0; i < changed.length; i++) for (let j = i + 1; j < changed.length; j++) {
    const both = [...changed[i][1]].filter((f) => changed[j][1].has(f));
    if (both.length) warn(`${changed[i][0]} and ${changed[j][0]} both change: ${both.slice(0, 5).join(', ')}`);
  }
  const next = rows.find((r) => r.dirty) ? `commit or checkpoint dirty work in ${rows.find((r) => r.dirty).slug}`
    : rows.find((r) => r.tested !== 'full' && r.ahead) ? `proj check --full in ${rows.find((r) => r.tested !== 'full' && r.ahead).slug}`
    : rows.find((r) => r.ci !== 'verified' && r.ahead) ? `proj ready --yes in ${rows.find((r) => r.ci !== 'verified' && r.ahead).slug} (owner approval: uses CI minutes)`
    : rows.find((r) => r.ci === 'verified' && r.released === 'no') ? `proj finish ${rows.find((r) => r.ci === 'verified' && r.released === 'no').slug} --merge --yes (owner approval)` : null;
  if (next) out(`Next: ${next}`);
}

// ---------- proj finish ----------
const REGENERABLE = /(^|\/)(node_modules|dist|build|coverage|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|[^/]+\.egg-info)(\/|$)|\.pyc$/;

export function cmdFinish(slug, opts) {
  const ctx = repoContext();
  const st = loadState(ctx);
  const t = resolveTask(ctx, slug, st);
  if (isInside(process.cwd(), t.worktree)) die(`run this from outside the worktree (Windows cannot remove a directory in use):\n  cd "${ctx.mainRoot}"; proj finish ${t.slug}`);
  const exists = fs.existsSync(t.worktree);
  if (exists && dirtyFiles(t.worktree).length) die(`${t.slug} has uncommitted changes; commit or \`proj checkpoint\` them first. Nothing was removed.`);
  const tip = git(['rev-parse', '--verify', '--quiet', `refs/heads/${t.branch}`], { cwd: ctx.mainRoot }).out;

  if (opts.abandon) {
    if (!opts.yes) die(`abandon keeps branch ${t.branch} and its archive ref but removes the clean worktree. Re-run with --yes.`);
    archive(ctx, t.branch, tip);
    if (exists) removeWorktree(ctx, t);
    updateState(ctx, (s) => { s.tasks[t.slug].status = 'abandoned'; s.tasks[t.slug].endedAt = now(); });
    return out(`abandoned ${t.slug}; branch ${t.branch} kept${t.pr ? `. PR #${t.pr} is still open: close it yourself if that is intended` : ''}`);
  }

  let pr = prFor(ctx, t.branch);
  if (!pr) die(`no PR for ${t.branch}. Push and open one with \`proj checkpoint --push\` or \`proj ready\`, or use --abandon.`);
  if (pr.state === 'OPEN') {
    if (!opts.merge) return out(`PR #${pr.number} is open${pr.isDraft ? ' (draft)' : ''}. Merge it with: proj finish ${t.slug} --merge --yes  (owner approval)`);
    if (!opts.yes) die('merging needs explicit owner approval: add --yes');
    if (pr.isDraft) die('PR is still a draft: run `proj ready --yes` first');
    if (tip !== pr.headRefOid) die(`local ${t.branch} (${short(tip)}) differs from the PR head (${short(pr.headRefOid)}): push or pull first`);
    const ci = ciAt(ctx, pr.headRefOid);
    if (ci.state !== 'verified') die(`required check "${ctx.cfg.requiredCheck}" is ${ci.state} at ${short(pr.headRefOid)}; refusing to merge unverified code`);
    git(['fetch', '--quiet', 'origin', pr.baseRefName], { cwd: ctx.mainRoot });
    if (git(['merge-base', '--is-ancestor', `origin/${pr.baseRefName}`, pr.headRefOid], { cwd: ctx.mainRoot }).code !== 0)
      die(`${t.branch} is behind ${pr.baseRefName}: rebase or merge ${pr.baseRefName} in, push, and let CI verify the new SHA`);
    const m = gh(['pr', 'merge', String(pr.number), '-R', ctx.remote.slug, '--squash', '--match-head-commit', pr.headRefOid], { cwd: ctx.mainRoot });
    if (m.code !== 0) die(`merge failed: ${m.err}`);
    out(`merged PR #${pr.number} at exact SHA ${short(pr.headRefOid)}`);
    pr = prFor(ctx, t.branch);
  }
  if (pr.state === 'CLOSED') die(`PR #${pr.number} was closed without merging; use --abandon --yes to retire the task`);
  if (pr.state !== 'MERGED') die(`unexpected PR state ${pr.state}`);
  if (tip && tip !== pr.headRefOid) die(`local ${t.branch} has commits the merged PR never saw (${short(tip)} vs ${short(pr.headRefOid)}); kept everything`);

  if (exists) removeWorktree(ctx, t);
  if (tip) deleteMergedBranch(ctx, t.branch, tip);
  git(['fetch', '--quiet', '--prune', 'origin'], { cwd: ctx.mainRoot });
  updateState(ctx, (s) => { Object.assign(s.tasks[t.slug], { status: 'finished', endedAt: now(), lastSha: pr.headRefOid, pr: pr.number }); });
  out(`finished ${t.slug}: PR #${pr.number} merged, worktree removed, branch archived under refs/proj-archive/`);
}

export function ignoredKeepers(dir) {
  const r = git(['status', '--porcelain', '--ignored=matching', '--untracked-files=all', '-z'], { cwd: dir, raw: true });
  return r.out.split('\0').filter((l) => l.startsWith('!! ')).map((l) => l.slice(3)).filter((f) => !REGENERABLE.test(f));
}

export function removeWorktree(ctx, t) {
  const keep = ignoredKeepers(t.worktree);
  if (keep.length) die(`${t.worktree} holds ignored files that removal would delete: ${keep.slice(0, 8).join(', ')}. Move them out first.`);
  git(['worktree', 'unlock', t.worktree], { cwd: ctx.mainRoot });
  const r = git(['worktree', 'remove', t.worktree], { cwd: ctx.mainRoot }); // never --force: git refuses dirty trees
  if (r.code !== 0) {
    git(['worktree', 'lock', '--reason', `proj task ${t.slug}`, t.worktree], { cwd: ctx.mainRoot });
    die(`git refused to remove ${t.worktree}: ${r.err}`);
  }
}

// Keep a recoverable ref before any branch deletion; create-only (empty old value).
export function archive(ctx, branch, sha) {
  if (!sha) return null;
  const ref = `refs/proj-archive/${branch}/${now().replace(/[-:]/g, '')}`;
  gitOk(['update-ref', '-m', 'proj archive', ref, sha, ''], { cwd: ctx.mainRoot });
  return ref;
}

// Called only after the branch tip was proven merged (PR head == tip, or content already in base).
export function deleteMergedBranch(ctx, branch, tip) {
  archive(ctx, branch, tip);
  if (git(['branch', '-d', branch], { cwd: ctx.mainRoot }).code === 0) return;
  // Squash-merged branches look unmerged to `branch -d`. Compare-and-swap delete: fails if the tip moved.
  gitOk(['update-ref', '-d', `refs/heads/${branch}`, tip], { cwd: ctx.mainRoot });
}

// ---------- proj hook <event>: Claude Code / Codex lifecycle hooks. Never fails the session. ----------
export function cmdHook(event) {
  let input = {};
  try { if (!process.stdin.isTTY) input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {}
  try {
    const ctx = repoContext(input.cwd || process.cwd());
    const st = loadState(ctx);
    const t = taskForCwd(ctx, st);
    if (event === 'session-start') {
      const open = Object.values(st.tasks).filter(isOpen);
      let ctxText = '';
      if (t) {
        const { task } = checkpoint(ctx, t, { owner: input.session_id });
        ctxText = fs.readFileSync(handoffPath(ctx, task.slug), 'utf8');
      } else if (open.length) {
        ctxText = `proj: ${open.length}/${ctx.cfg.maxAgents} tasks active (${open.map((o) => `${o.slug} -> ${o.worktree}`).join('; ')}). ` +
          'Do not edit their files from here. Start new work with `proj task <slug> --goal "..."`; continue one with `proj resume <slug>`.\n';
      }
      if (ctxText) out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctxText } }));
    } else if (t && ['pre-compact', 'session-end', 'stop'].includes(event)) {
      checkpoint(ctx, t, { owner: input.session_id });
    }
  } catch (e) {
    if (process.env.PROJ_DEBUG) console.error(e);
  }
  process.exitCode = 0;
}
