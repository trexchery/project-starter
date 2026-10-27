// proj new / adopt / protect: render the template, configure git, create and harden the GitHub repo.
import fs from 'node:fs';
import path from 'node:path';
import {
  STARTER_ROOT, die, git, gitOk, gh, run, readJson, writeJson, sha256, now, out, warn,
  loadConfig, repoContext, registerRepo, updateState, isSecretPath,
} from './core.js';

const TEMPLATE = path.join(STARTER_ROOT, 'template');
export const STACKS = fs.readdirSync(path.join(TEMPLATE, 'stacks'));

// Files the project owns after bootstrap: written once, never upgraded.
const PROJECT_OWNED = /^(README\.md|docs\/|src\/|tests?\/|scripts\/|package\.json$|pyproject\.toml$|\.proj\.json$)/;

// Per-repo git settings (override this machine's system gitconfig: autocrlf=true, pull.rebase=false).
export const GIT_CONFIG = {
  'pull.ff': 'only',
  'fetch.prune': 'true',
  'push.autoSetupRemote': 'true',
  'rerere.enabled': 'true',
  'merge.conflictStyle': 'zdiff3',
  'diff.algorithm': 'histogram',
  'branch.sort': '-committerdate',
  'core.longpaths': 'true',
};

function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [path.relative(base, p).split(path.sep).join('/')];
  });
}

// Only known {{key}} tokens are replaced, so GitHub's ${{ expr }} passes through untouched.
const render = (text, vars) => text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));

// Map of relative path -> rendered content for a stack (stack files override common ones).
export function renderTemplate(stack, vars) {
  if (!STACKS.includes(stack)) die(`unknown stack "${stack}" (have: ${STACKS.join(', ')})`);
  const files = new Map();
  for (const root of [path.join(TEMPLATE, 'common'), path.join(TEMPLATE, 'stacks', stack)]) {
    for (const rel of walk(root)) files.set(render(rel, vars), render(fs.readFileSync(path.join(root, rel), 'utf8'), vars));
  }
  return files;
}

export function templateVars({ name, owner, description, stack }) {
  return {
    name, owner: owner || 'OWNER', stack,
    description: description || 'TODO: one-line goal',
    module: name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'app',
    date: new Date().toISOString().slice(0, 10),
  };
}

function applyGitConfig(dir, { onlyUnset }) {
  const changed = [];
  for (const [k, v] of Object.entries(GIT_CONFIG)) {
    if (onlyUnset && git(['config', '--local', '--get', k], { cwd: dir }).code === 0) continue;
    gitOk(['config', '--local', k, v], { cwd: dir });
    changed.push(`${k}=${v}`);
  }
  return changed;
}

const ghLogin = () => gh(['api', 'user', '--jq', '.login']).out || null;

export function detectStack(dir) {
  if (fs.existsSync(path.join(dir, 'package.json'))) return 'node';
  if (['pyproject.toml', 'requirements.txt', 'setup.py'].some((f) => fs.existsSync(path.join(dir, f)))) return 'python';
  return 'generic';
}

// ---------- proj new ----------
export function cmdNew(name, opts) {
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) die('usage: proj new <name> [--stack node|python|generic] [--description ".."] [--dir <parent>] [--no-remote] [--dry-run]');
  const cfg = loadConfig();
  const stack = opts.stack || cfg.defaultStack;
  const dir = path.resolve(opts.dir || process.cwd(), name);
  const remote = !opts['no-remote'];
  const owner = remote ? opts.owner || cfg.owner || ghLogin() : opts.owner || cfg.owner;
  if (remote && !owner) die('cannot tell the GitHub owner: run `gh auth login` or pass --owner');
  const files = renderTemplate(stack, templateVars({ name, owner, description: opts.description, stack }));

  // Resume only a bootstrap that proj itself started here (marker in .git/proj); never an existing project.
  const marker = path.join(dir, '.git', 'proj', 'bootstrap-pending.json');
  const resuming = fs.existsSync(marker);
  if (!resuming && fs.existsSync(dir) && fs.readdirSync(dir).length) die(`${dir} exists and is not empty; use \`proj adopt\` inside it instead`);

  if (opts['dry-run']) {
    out(`would create ${dir} (${stack}, ${files.size} files)${remote ? ` and private repo ${owner}/${name}` : ''}`);
    for (const f of files.keys()) out(`  + ${f}`);
    return;
  }

  if (!resuming) {
    fs.mkdirSync(dir, { recursive: true });
    const managed = {};
    for (const [rel, text] of files) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
      if (!PROJECT_OWNED.test(rel)) managed[rel] = sha256(text);
    }
    const pj = readJson(path.join(dir, '.proj.json'), {});
    writeJson(path.join(dir, '.proj.json'), { ...pj, managed });
    gitOk(['init', '-b', cfg.baseBranch], { cwd: dir });
    applyGitConfig(dir, { onlyUnset: false });
    gitOk(['add', '-A'], { cwd: dir });
    const staged = gitOk(['diff', '--cached', '--name-only'], { cwd: dir }).split(/\r?\n/);
    if (staged.some(isSecretPath)) die('refusing to commit a secret-looking file');
    gitOk(['commit', '-q', '-m', 'chore: bootstrap from project-starter'], { cwd: dir });
    if (remote) writeJson(marker, { owner, name, at: now() });
    out(`created ${dir} (${stack})`);
  } else out(`resuming bootstrap of ${dir}`);

  registerRepo(dir);
  if (!remote) return out(`local only. Next: cd ${dir}; proj task <slug>`);

  const slug = `${owner}/${name}`;
  if (git(['remote', 'get-url', 'origin'], { cwd: dir }).code !== 0) {
    if (gh(['repo', 'view', slug, '--json', 'name']).code === 0) die(`${slug} already exists on GitHub; refusing to reuse it. Add it as origin yourself if it is yours.`);
    const vis = cfg.visibility === 'public' ? '--public' : '--private';
    const r = gh(['repo', 'create', slug, vis, '--source', dir, '--remote', 'origin', '--push', '--description', opts.description || name], { cwd: dir });
    if (r.code !== 0) die(`gh repo create failed: ${r.err}`);
    out(`created ${vis.slice(2)} repo https://github.com/${slug}`);
  } else if (git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${cfg.baseBranch}`], { cwd: dir }).code !== 0) {
    gitOk(['push', '-u', 'origin', cfg.baseBranch], { cwd: dir });
  }
  // `proj new` hardens only the repository it just created (or a bootstrap it left unfinished).
  protect(repoContext(dir));
  fs.rmSync(marker, { force: true });
  out(`\nNext: cd ${dir}; proj task <slug> --goal "..."`);
}

// ---------- proj adopt (never overwrites; --upgrade refreshes starter files you have not edited) ----------
export function cmdAdopt(opts) {
  const ctx = repoContext();
  const dir = ctx.root; // the checkout or task worktree you are in, so changes land on a reviewable branch
  const pjPath = path.join(dir, '.proj.json');
  const pj = readJson(pjPath, null);
  const stack = opts.stack || pj?.stack || detectStack(dir);
  const name = ctx.remote?.name || path.basename(dir);
  const files = renderTemplate(stack, templateVars({ name, owner: ctx.remote?.owner, stack }));
  const dry = opts['dry-run'];
  const managed = { ...(pj?.managed || {}) };
  const report = { add: [], keep: [], upgrade: [], edited: [], advice: [] };

  for (const [rel, text] of files) {
    const p = path.join(dir, rel);
    if (!fs.existsSync(p)) {
      if (rel === '.proj.json') continue; // written below
      report.add.push(rel);
      if (!dry) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
      if (!PROJECT_OWNED.test(rel)) managed[rel] = sha256(text);
      continue;
    }
    const cur = fs.readFileSync(p, 'utf8');
    if (opts.upgrade && managed[rel]) {
      if (sha256(cur) === sha256(text)) report.keep.push(rel);
      else if (sha256(cur) === managed[rel]) {
        report.upgrade.push(rel);
        if (!dry) { fs.writeFileSync(p, text); managed[rel] = sha256(text); }
      } else report.edited.push(rel);
    } else report.keep.push(rel);
  }

  const claude = path.join(dir, 'CLAUDE.md');
  if (fs.existsSync(claude) && !/^@AGENTS\.md\s*$/m.test(fs.readFileSync(claude, 'utf8')))
    report.advice.push('CLAUDE.md exists without an `@AGENTS.md` line: add it so Claude Code also loads AGENTS.md.');
  if (report.keep.includes('.claude/settings.json'))
    report.advice.push(`.claude/settings.json kept as is: merge the proj hooks from ${path.join(TEMPLATE, 'common', '.claude', 'settings.json')} yourself.`);

  const gitChanges = dry ? Object.keys(GIT_CONFIG).filter((k) => git(['config', '--local', '--get', k], { cwd: dir }).code !== 0) : applyGitConfig(dir, { onlyUnset: true });
  if (!dry) {
    const stackPj = JSON.parse(files.get('.proj.json'));
    writeJson(pjPath, { ...stackPj, ...(pj || {}), stack, managed });
    registerRepo(ctx.mainRoot);
  }

  const verb = dry ? 'would ' : '';
  out(`${verb}add ${report.add.length}, keep ${report.keep.length}${opts.upgrade ? `, upgrade ${report.upgrade.length}, skip edited ${report.edited.length}` : ''} (stack ${stack})`);
  for (const f of report.add) out(`  + ${f}`);
  for (const f of report.upgrade) out(`  ~ ${f}`);
  for (const f of report.edited) out(`  = ${f} (you edited it; left alone)`);
  if (gitChanges.length) out(`  git config ${verb}set: ${gitChanges.join(', ')}`);
  for (const a of report.advice) out(`  note: ${a}`);
  if (!dry && (report.add.length || report.upgrade.length)) out('Nothing was committed. Review with `git status`, then commit on a branch.');
}

// ---------- proj protect: repo settings, Dependabot, default-branch ruleset (plan-aware) ----------
const RULESET_NAME = 'proj-default';
function rulesetBody(cfg) {
  return {
    name: RULESET_NAME, target: 'branch', enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      { type: 'required_linear_history' },
      { type: 'pull_request', parameters: {
        required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_code_owner_review: false,
        require_last_push_approval: false, required_review_thread_resolution: false, allowed_merge_methods: ['squash'],
      } },
      { type: 'required_status_checks', parameters: {
        strict_required_status_checks_policy: true, do_not_enforce_on_create: false,
        required_status_checks: [{ context: cfg.requiredCheck, integration_id: 15368 }], // 15368 = GitHub Actions
      } },
    ],
  };
}

function api(method, endpoint, body) {
  const r = gh(['api', '-X', method, endpoint, ...(body ? ['--input', '-'] : [])], { input: body ? JSON.stringify(body) : undefined });
  const status = Number((r.err.match(/HTTP (\d{3})/) || [])[1]) || (r.code === 0 ? 200 : 0);
  return { ok: r.code === 0, status, err: r.err, json: (() => { try { return JSON.parse(r.out); } catch { return null; } })() };
}

export function protect(ctx, opts = {}) {
  const slug = ctx.remote?.slug;
  if (!slug) die('origin is not a GitHub repository');
  const settings = {
    allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false, allow_auto_merge: false,
    delete_branch_on_merge: true, allow_update_branch: true, has_wiki: false,
    squash_merge_commit_title: 'PR_TITLE', squash_merge_commit_message: 'PR_BODY',
  };
  if (opts['dry-run']) {
    out(`would apply to ${slug}: squash-only merges, delete merged branches, Dependabot alerts + security updates,`);
    out(`ruleset "${RULESET_NAME}" on the default branch (PR required, required check "${ctx.cfg.requiredCheck}" up to date, no force push/deletion).`);
    return;
  }
  const results = [];
  const step = (label, r) => { results.push([label, r.ok ? 'ok' : `failed (${r.status || r.err})`]); return r; };
  step('repo settings', api('PATCH', `repos/${slug}`, settings));
  step('dependabot alerts', api('PUT', `repos/${slug}/vulnerability-alerts`));
  step('dependabot security updates', api('PUT', `repos/${slug}/automated-security-fixes`));

  const existing = api('GET', `repos/${slug}/rulesets`);
  const found = existing.json?.find?.((r) => r.name === RULESET_NAME);
  const rs = found ? api('PUT', `repos/${slug}/rulesets/${found.id}`, rulesetBody(ctx.cfg)) : api('POST', `repos/${slug}/rulesets`, rulesetBody(ctx.cfg));
  let enforcement;
  if (rs.ok) {
    // The API can accept a ruleset the plan does not enforce; ask GitHub which rules apply to the branch.
    const active = api('GET', `repos/${slug}/rules/branches/${ctx.cfg.baseBranch}`);
    const types = (active.json || []).map((r) => r.type);
    enforcement = types.includes('required_status_checks') && types.includes('pull_request') ? 'enforced' : 'accepted-not-reported';
    results.push([`ruleset ${RULESET_NAME}`, `${found ? 'updated' : 'created'}; branch rules reported: ${types.join(', ') || 'none'}`]);
  } else if (rs.status === 403 || /upgrade|pro\b|plan/i.test(rs.err)) {
    enforcement = 'plan-gated';
    results.push([`ruleset ${RULESET_NAME}`, 'not available on this plan for private repos: proj enforces the gates locally']);
  } else {
    enforcement = 'failed';
    results.push([`ruleset ${RULESET_NAME}`, `failed (${rs.status}): ${rs.err.split('\n')[0]}`]);
  }
  updateState(ctx, (st) => { st.github = { slug, enforcement, at: now() }; });
  for (const [k, v] of results) out(`  ${k}: ${v}`);
  out(`branch protection: ${enforcement}${enforcement !== 'enforced' ? ' (proj ready/finish still refuse unverified merges)' : ''}`);
  if (results.some(([, v]) => v.startsWith('failed'))) warn('some settings were not applied; re-run `proj protect` after fixing access');
}
