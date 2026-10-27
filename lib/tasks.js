// proj task / status / finish / checkpoint / resume / review / hook: tracked worktrees and handoffs.
import fs from 'node:fs';
import path from 'node:path';
import {
  die, git, gitOk, gh, ghJson, now, ageDays, out, warn, short, table, writeAtomic, repoContext, loadState,
  updateState, headSha, currentBranch, dirtyFiles, worktrees, changedFiles, snapshot, globsOverlap, isSecretPath,
} from './core.js';

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,48}$/;
// Canonical form: long names (not 8.3 like RUNNER~1), resolved junctions, case-folded on Windows.
const canon = (p) => { let r = path.resolve(p); try { r = fs.realpathSync.native(r); } catch {} return process.platform === 'win32' ? r.toLowerCase() : r; };
export const samePath = (a, b) => canon(a) === canon(b);
const isInside = (child, parent) => { const r = path.relative(canon(parent), canon(child)); return !r.startsWith('..') && !path.isAbsolute(r); };
export const isOpen = (t) => t.status === 'active';
// A worktree is usable only while its .git link exists; a half-deleted directory is not one.
export const wtAlive = (t) => fs.existsSync(path.join(t.worktree, '.git'));
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
export function ciAt(ctx, sha, since = null) {
  if (!ctx.remote?.slug || !sha) return { state: 'unknown' };
  // Runs of the CI workflow file itself for this exact SHA: a job called "verify" in another workflow never counts.
  const r = ghJson(['api', `repos/${ctx.remote.slug}/actions/workflows/${ctx.cfg.ciWorkflow}/runs?head_sha=${sha}&per_page=100`]);
  return r ? verdict(r.workflow_runs, sha, since) : { state: 'unknown' };
}

// Pure part of ciAt (unit-tested). A skipped run (draft stage) never verifies and never hides a real result:
// draft and ready runs can race, so the skip may carry the higher id. `since` only drops older skipped runs.
// Among real runs the newest wins.
export function verdict(runs, sha, since = null) {
  const mine = runs.filter((r) => r.head_sha === sha && !(since && r.conclusion === 'skipped' && r.run_started_at < since)).sort((a, b) => b.id - a.id);
  const latest = mine.find((r) => r.conclusion !== 'skipped') || mine[0];
  if (!latest) return { state: 'none' };
  if (latest.status !== 'completed') return { state: 'pending', url: latest.html_url, runId: latest.id };
  return { state: latest.conclusion === 'success' ? 'verified' : latest.conclusion, url: latest.html_url, runId: latest.id, runs: mine.length };
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
    const theirs = wtAlive(t) ? changedFiles(ctx, t.worktree) : [];
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
  const task = {
    slug, branch, worktree: wt, base, baseSha: null, issue, files, goal: opts.goal || '', owner: opts.owner || process.env.CLAUDE_SESSION_ID || null,
    status: 'active', createdAt: now(), heartbeat: now(), decisions: [], blockers: [], next: 'Read the goal, run `proj check`, make the smallest change that meets it.',
  };
  // Re-check cap and duplicates under the lock and reserve the slot, so concurrent `proj task` runs cannot all pass.
  updateState(ctx, (s) => {
    const live = Object.values(s.tasks).filter(isOpen);
    if (s.tasks[slug] && isOpen(s.tasks[slug])) die(`task "${slug}" was just created by another session`);
    if (issue && live.some((t) => t.issue === issue)) die(`issue #${issue} was just taken by another session`);
    if (live.length >= ctx.cfg.maxAgents) die(`${live.length}/${ctx.cfg.maxAgents} tasks active: finish or abandon one first`, 3);
    s.tasks[slug] = task;
  });
  const added = git(['worktree', 'add', '--lock', '--reason', `proj task ${slug}`, '--no-track', '-b', branch, wt, start], { cwd: ctx.root });
  if (added.code !== 0) { updateState(ctx, (s) => { delete s.tasks[slug]; }); die(`git worktree add failed: ${added.err}`); }
  const baseSha = task.baseSha = headSha(wt);
  updateState(ctx, (s) => { s.tasks[slug].baseSha = baseSha; });
  writeHandoff(ctx, task);
  out(`task ${slug}: ${wt}\n  branch ${branch} from ${start} @ ${short(baseSha)}  (${open.length + 1}/${ctx.cfg.maxAgents} active)`);
  if (overlaps.length) warn(`overlaps with ${overlaps.join(', ')} (allowed)`);
  out(`Next: cd "${wt}"`);
}

// ---------- handoff rendering (goal, decisions, SHA, dirty files, progress, tests, blockers, next) ----------
export function handoffText(ctx, t, st = loadState(ctx)) {
  const exists = wtAlive(t);
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
  if (wtAlive(t)) {
    snap = snapshot(t.worktree, `proj checkpoint ${t.slug} ${now()}`);
    if (snap) {
      // refresh when the tree OR the parent changed (a partial commit moves the parent, not the tree)
      const key = (ref) => git(['log', '-1', '--format=%T %P', ref], { cwd: t.worktree }).out;
      const prev = git(['rev-parse', '--verify', '--quiet', checkpointRef(t.slug)], { cwd: t.worktree }).code === 0 ? key(checkpointRef(t.slug)) : '';
      if (prev !== key(snap)) gitOk(['update-ref', '--create-reflog', '-m', `checkpoint ${now()}`, checkpointRef(t.slug), snap], { cwd: t.worktree });
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
    cur.lastSha = wtAlive(t) ? headSha(t.worktree) : cur.lastSha;
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
    for (const t of open) out(`${t.slug}: next: ${t.next}  (${t.worktree}${wtAlive(t) ? '' : ', MISSING'})`);
    return out('Resume one: proj resume <slug>');
  }
  const t = resolveTask(ctx, slug, st);
  if (!wtAlive(t)) {
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
  if (fs.existsSync(t.worktree) && fs.readdirSync(t.worktree).length) die(`${t.worktree} still holds files but is no longer a worktree; move them aside first (nothing was changed)`);
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
    gitOk(['read-tree', '-u', '--reset', snap], { cwd: t.worktree }); // exact snapshot tree, uncommitted deletions included
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
  const exists = wtAlive(t);
  const sha = exists ? headSha(t.worktree) : git(['rev-parse', '--verify', '--quiet', `refs/heads/${t.branch}`], { cwd: ctx.mainRoot }).out || t.lastSha;
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
    slug: t.slug, status: t.status, sha, dirty, ahead, exists, pr,
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
  const open = rows.filter((r) => r.status === 'active');
  const live = open.filter((r) => r.released === 'no');
  if (opts.json) return out(JSON.stringify(rows, null, 2));
  out(`${ctx.remote?.slug || path.basename(ctx.mainRoot)}  ${open.length}/${ctx.cfg.maxAgents} tasks active  protection: ${st.github?.enforcement || 'unknown'}`);
  if (!rows.length) return out('no active tasks. Start one: proj task <slug> --goal "..."');
  out(table([
    ['task', 'sha', 'dirty', 'implemented', 'tested', 'reviewed', 'ci@sha', 'released', 'pr'],
    ...rows.map((r) => [r.slug, short(r.sha), r.exists ? r.dirty : r.status === 'active' ? 'MISSING' : r.status, r.implemented, r.tested, r.reviewed, r.ci, r.released, r.pr ? `#${r.pr.number}${r.pr.isDraft ? ' draft' : ''}` : '-']),
  ]));
  // overlap report between active tasks (files actually changed)
  const changed = tasks.filter((t) => isOpen(t) && wtAlive(t)).map((t) => [t.slug, new Set(changedFiles(ctx, t.worktree))]);
  for (let i = 0; i < changed.length; i++) for (let j = i + 1; j < changed.length; j++) {
    const both = [...changed[i][1]].filter((f) => changed[j][1].has(f));
    if (both.length) warn(`${changed[i][0]} and ${changed[j][0]} both change: ${both.slice(0, 5).join(', ')}`);
  }
  const pick = (f) => live.find(f)?.slug;
  const merged = open.find((r) => r.released !== 'no')?.slug;
  const next = pick((r) => r.dirty) ? `commit or checkpoint dirty work in ${pick((r) => r.dirty)}`
    : merged ? `proj finish ${merged} (its PR is merged; this removes the worktree and archives the branch)`
    : pick((r) => r.tested !== 'full' && r.ahead) ? `proj check --full in ${pick((r) => r.tested !== 'full' && r.ahead)}`
    : pick((r) => r.ci !== 'verified' && r.ahead) ? `proj ready in ${pick((r) => r.ci !== 'verified' && r.ahead)} (starts the one CI run for that SHA)`
    : pick((r) => r.ci === 'verified') ? `proj finish ${pick((r) => r.ci === 'verified')} --merge` : null;
  if (next) out(`Next: ${next}`);
}

// ---------- proj finish ----------
// Ignored files a worktree removal may delete: top-level build output and caches only. Secrets never.
const REGENERABLE = /^(node_modules|dist|build|coverage|\.venv|venv|\.pytest_cache|\.mypy_cache|\.ruff_cache|[^/]+\.egg-info)\/|(^|\/)__pycache__\/|\.pyc$/;

export function cmdFinish(slug, opts) {
  const ctx = repoContext();
  const st = loadState(ctx);
  const t = resolveTask(ctx, slug, st);
  if (isInside(process.cwd(), t.worktree)) die(`run this from outside the worktree (Windows cannot remove a directory in use):\n  cd "${ctx.mainRoot}"; proj finish ${t.slug}`);
  const exists = wtAlive(t);
  if (exists && dirtyFiles(t.worktree).length) die(`${t.slug} has uncommitted changes; commit or \`proj checkpoint\` them first. Nothing was removed.`);
  const tip = git(['rev-parse', '--verify', '--quiet', `refs/heads/${t.branch}`], { cwd: ctx.mainRoot }).out;

  if (opts.abandon) {
    archive(ctx, t.branch, tip);
    if (exists) removeWorktree(ctx, t);
    updateState(ctx, (s) => { s.tasks[t.slug].status = 'abandoned'; s.tasks[t.slug].endedAt = now(); });
    return out(`abandoned ${t.slug}; branch ${t.branch} kept${t.pr ? `. PR #${t.pr} is still open: close it yourself if that is intended` : ''}`);
  }

  let pr = prFor(ctx, t.branch);
  if (!pr) die(`no PR for ${t.branch}. Push and open one with \`proj checkpoint --push\` or \`proj ready\`, or use --abandon.`);
  if (pr.state === 'OPEN') {
    if (!opts.merge) return out(`PR #${pr.number} is open${pr.isDraft ? ' (draft)' : ''}. Merge it with: proj finish ${t.slug} --merge`);
    if (pr.isDraft) die('PR is still a draft: run `proj ready` first');
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
  if (pr.state === 'CLOSED') die(`PR #${pr.number} was closed without merging; use --abandon to retire the task`);
  if (pr.state !== 'MERGED') die(`unexpected PR state ${pr.state}`);
  if (tip && tip !== pr.headRefOid) die(`local ${t.branch} has commits the merged PR never saw (${short(tip)} vs ${short(pr.headRefOid)}); kept everything`);

  if (exists) removeWorktree(ctx, t);
  else forgetWorktree(ctx, t);
  if (tip) deleteMergedBranch(ctx, t.branch, tip);
  git(['fetch', '--quiet', '--prune', 'origin'], { cwd: ctx.mainRoot });
  // Bring the main checkout up to date when that cannot touch anyone's work (clean, on base, fast-forward only).
  if (currentBranch(ctx.mainRoot) === pr.baseRefName && !dirtyFiles(ctx.mainRoot).length) git(['merge', '--ff-only', '--quiet', `origin/${pr.baseRefName}`], { cwd: ctx.mainRoot });
  updateState(ctx, (s) => { Object.assign(s.tasks[t.slug], { status: 'finished', endedAt: now(), lastSha: pr.headRefOid, pr: pr.number }); });
  out(`finished ${t.slug}: PR #${pr.number} merged, worktree removed, branch archived under refs/proj-archive/`);
}

export function ignoredKeepers(dir) {
  const r = git(['ls-files', '-o', '-i', '--exclude-standard', '-z'], { cwd: dir, raw: true }); // one entry per file
  if (r.code !== 0) die(`cannot list ignored files in ${dir}: ${r.err}`);
  return r.out.split('\0').filter(Boolean).filter((f) => isSecretPath(f) || !REGENERABLE.test(f));
}

export function removeWorktree(ctx, t) {
  // Commits made on a detached HEAD (or another branch) in this worktree would be orphaned by removal.
  const on = git(['symbolic-ref', '--quiet', 'HEAD'], { cwd: t.worktree }).out;
  const wtHead = headSha(t.worktree);
  const tip = git(['rev-parse', '--verify', '--quiet', `refs/heads/${t.branch}`], { cwd: ctx.mainRoot }).out;
  if (on !== `refs/heads/${t.branch}` || wtHead !== tip) die(`${t.worktree} is not on ${t.branch} at its tip (HEAD ${short(wtHead)}${on ? ` on ${on}` : ', detached'}); check out ${t.branch} there first. Nothing was removed.`);
  const keep = ignoredKeepers(t.worktree);
  if (keep.length) die(`${t.worktree} holds ignored files that removal would delete: ${keep.slice(0, 8).join(', ')}. Move them out first.`);
  // Windows: a directory that is some process's cwd (a terminal, editor, agent) cannot be deleted, and git
  // would fail only after emptying it. A rename fails the same way, so probe with one before deleting anything.
  try { fs.renameSync(t.worktree, `${t.worktree}.proj-probe`); fs.renameSync(`${t.worktree}.proj-probe`, t.worktree); } catch {
    die(`${t.worktree} is in use by another process (a terminal, editor or agent session is inside it). Close it and re-run; nothing was removed.`);
  }
  git(['worktree', 'unlock', t.worktree], { cwd: ctx.mainRoot });
  const r = git(['worktree', 'remove', t.worktree], { cwd: ctx.mainRoot }); // never --force: git refuses dirty trees
  if (r.code !== 0) {
    git(['worktree', 'lock', '--reason', `proj task ${t.slug}`, t.worktree], { cwd: ctx.mainRoot });
    die(`git refused to remove ${t.worktree}: ${r.err}`);
  }
}

// Worktree directory already gone (or emptied): drop git's stale record of it. Only an empty directory is removed.
function forgetWorktree(ctx, t) {
  git(['worktree', 'unlock', t.worktree], { cwd: ctx.mainRoot });
  git(['worktree', 'prune'], { cwd: ctx.mainRoot });
  try { fs.rmdirSync(t.worktree); } catch {}
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
  if (!input || typeof input !== 'object') input = {};
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
