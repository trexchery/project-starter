// proj new / adopt / protect: render the template, configure git, create and harden the GitHub repo.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import {
  STARTER_ROOT, die, git, gitOk, gh, run, readJson, writeJson, sha256, now, out, warn,
  loadConfig, repoContext, registerRepo, updateState, isSecretPath,
} from './core.js';
import { inferProfile, readProfile, flagOverrides, describeProfile, validate, STACKS, stackDir } from './profile.js';
import { editServed, runnerRefusal } from './runner.js';

const TEMPLATE = path.join(STARTER_ROOT, 'template');

// Starter code, manifests and lockfiles: only `proj new` writes them; adopt never adds them to an existing repo.
const SKELETON = /^(src\/|tests?\/|[^/]+\.(go|sln)$|(package(-lock)?\.json|pyproject\.toml|go\.mod|Cargo\.(toml|lock)|nuget\.config)$)/;
// Files the project owns after bootstrap: written once, never upgraded.
const PROJECT_OWNED = new RegExp(`^(README\\.md|DESIGN\\.md|design\\/|docs\\/|scripts\\/|\\.proj\\.json$)|${SKELETON.source}`);

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

// {{#flag}}...{{/flag}} keeps a block when the variable is truthy, {{^flag}}...{{/flag}} when it is not; then only
// known {{key}} tokens are replaced, so GitHub's ${{ expr }} passes through untouched.
export function render(text, vars) {
  const keep = (m, op, k, body) => ((op === '#') === !!vars[k] ? body : '');
  // Tags alone on their line go with their line break (all levels first); inline blocks leave the text around them.
  for (const re of [/^\{\{([#^])(\w+)\}\}\r?\n((?:(?!\{\{\/\2\}\})[\s\S])*?)^\{\{\/\2\}\}\r?\n/gm, /\{\{([#^])(\w+)\}\}((?:(?!\{\{\/\2\}\})[\s\S])*?)\{\{\/\2\}\}/g]) {
    let prev;
    do { prev = text; text = text.replace(re, keep); } while (text !== prev);
  }
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

// Template parts a project gets: the common core, its stack, and only the modules its profile needs.
export const modulesFor = (p) => [p.sensitive.length && 'security', p.database && 'database', p.visual && 'visual', p.tasks && 'tasks'].filter(Boolean);

// Map of relative path -> rendered content. Later layers override earlier ones; "*.merge.json" files are
// deep-merged into the JSON file of the same name without ".merge" (e.g. hooks into .claude/settings.json).
export function renderTemplate(profile, vars) {
  if (!STACKS.includes(profile.stack)) die(`unknown stack "${profile.stack}" (have: ${STACKS.join(', ')})`);
  const layers = [path.join(TEMPLATE, 'common'), path.join(TEMPLATE, 'stacks', stackDir(profile.stack)), ...modulesFor(profile).map((m) => path.join(TEMPLATE, 'modules', m))];
  const files = new Map();
  const merges = [];
  for (const root of layers) {
    for (const rel of walk(root)) {
      const raw = fs.readFileSync(path.join(root, rel), 'utf8');
      const text = render(raw, vars);
      if (rel.endsWith('.merge.json')) merges.push([render(rel, vars).replace(/\.merge\.json$/, '.json'), JSON.parse(text)]);
      // A file wrapped entirely in a block (e.g. {{#ts}}tsconfig{{/ts}}) is left out when the block is.
      else if (raw && !text.trim()) continue;
      // npm never packs a file named .gitignore, so the template stores it as gitignore.
      else files.set(render(rel, vars).replace(/(^|\/)gitignore$/, '$1.gitignore'), text);
    }
  }
  for (const [rel, patch] of merges) files.set(rel, JSON.stringify(deepMerge(JSON.parse(files.get(rel) || '{}'), patch), null, 2) + '\n');
  return files;
}
function deepMerge(a, b) {
  const o = { ...a };
  for (const [k, v] of Object.entries(b)) o[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? deepMerge(a[k], v) : v;
  return o;
}

// One rule that matters most for each kind of project; the rest of AGENTS.md is the same everywhere.
const KIND_RULE = {
  'web-app': 'Every screen works at 390px and 1440px wide and by keyboard alone; keep data access out of UI components.',
  website: 'Static first: no client JavaScript unless a feature needs it; every page has a title, a description and alt text.',
  'mobile-app': 'Small screens and slow networks first: 44px touch targets, and loading, empty, error and offline states on every screen.',
  game: 'Keep game rules and state separate from rendering and input so they can be unit tested; use a fixed time step.',
  api: 'Every endpoint validates its input, returns one consistent error shape and has a test for its failure case; never break a response without a new version.',
  cli: 'Exit 0 only on success; errors go to stderr; output other programs read stays stable; --help documents every flag.',
  library: 'Keep the public API small and documented; a breaking change needs a major version and a changelog entry.',
  data: 'Pipelines can be rerun safely and never modify raw inputs in place; record where every dataset came from.',
  other: '',
};
const SENSITIVE_LABEL = { auth: 'accounts and login', payments: 'payments', pii: 'personal data', secrets: 'keys and credentials' };

// Keywords of C#, Go, Rust and Python, plus names that clash there (Go's main, Python's test, Rust's std/core).
const RESERVED = new Set(('abstract and as assert async await base become bool box break byte case catch chan char checked class const '
  + 'continue core crate decimal def default defer del delegate do double dyn elif else enum event except explicit extern false final '
  + 'finally fixed float fn for foreach from func gen global go goto if impl implicit import in int interface internal is lambda let '
  + 'lock long loop macro main map match mod move mut namespace new nonlocal not null object operator or out override package params '
  + 'pass priv private protected pub public raise range readonly ref return sbyte sealed select self short sizeof stackalloc static std '
  + 'string struct super switch test this throw trait true try type typeof uint ulong unchecked unsafe unsized use ushort using var '
  + 'virtual void volatile where while with yield').split(' '));
const moduleName = (name) => {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(?=\d)/, 'app_') || 'app';
  return RESERVED.has(id) ? `${id}_app` : id;
};

const xml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function templateVars({ name, owner, description, profile: p }) {
  // Each stack's .proj.json says how to set it up and test it (README, AGENTS.md, the PR template).
  const { test, setup } = readJson(path.join(TEMPLATE, 'stacks', stackDir(p.stack), '.proj.json'), {});
  return {
    name, owner: owner || 'OWNER', stack: p.stack, kind: p.kind,
    description: description || 'TODO: one-line goal',
    // A valid identifier in every stack's language: no leading digit, no keyword (Python, Rust, C#, Go).
    module: moduleName(name),
    date: new Date().toISOString().slice(0, 10),
    testCmd: test, setupCmd: setup, verified: p.stack !== 'generic', kindRule: KIND_RULE[p.kind],
    ts: p.stack === 'typescript', ext: p.stack === 'typescript' ? 'ts' : 'js',
    nameXml: xml(name), bannerSize: Math.min(72, Math.floor(1600 / name.length)),
    visual: p.visual, database: p.database, tasks: p.tasks, security: p.sensitive.length > 0,
    sensitiveList: p.sensitive.map((s) => SENSITIVE_LABEL[s]).join(', '),
    auth: p.sensitive.includes('auth'), payments: p.sensitive.includes('payments'), pii: p.sensitive.includes('pii'), secretsData: p.sensitive.includes('secrets'),
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
  if (fs.existsSync(path.join(dir, 'go.mod'))) return 'go';
  if (fs.existsSync(path.join(dir, 'Cargo.toml'))) return 'rust';
  if (fs.readdirSync(dir).some((f) => /\.(sln|csproj)$/.test(f))) return 'dotnet';
  const pkg = readJson(path.join(dir, 'package.json'), null);
  if (pkg) return fs.existsSync(path.join(dir, 'tsconfig.json')) || pkg.dependencies?.typescript || pkg.devDependencies?.typescript ? 'typescript' : 'node';
  if (['pyproject.toml', 'requirements.txt', 'setup.py'].some((f) => fs.existsSync(path.join(dir, f)))) return 'python';
  return 'generic';
}

// ---------- profile resolution: description -> profile, overridable by flags or a profile file ----------
async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

async function resolveProfile(opts, description, { interactive, tty }) {
  const p = opts.profile ? validate({ ...readProfile(opts.profile), ...flagOverrides(opts) }) : inferProfile(description, flagOverrides(opts));
  out(`Understood: ${describeProfile(p)}`);
  for (const r of p.reasons) out(`  - ${r}`);
  if (p.uncertain?.length) out(`  - guessed ${p.uncertain.join(' and ')} (the description does not say): override with --kind / --stack if wrong`);
  if (interactive || (tty && p.uncertain?.length)) {
    const ok = await ask('Build it this way? [Y/n] ');
    if (/^n/i.test(ok)) die(`Adjust with flags and run again: --kind <web-app|website|api|cli|library|data|...> --stack <${STACKS.join('|')}> --visual/--no-visual --sensitive auth,payments,pii,secrets|none --database --tasks`, 0);
  }
  return p;
}

const storedProfile = (p, description) => ({ ...(description ? { description } : {}), kind: p.kind, stack: p.stack, visual: p.visual, sensitive: p.sensitive, database: p.database, tasks: p.tasks });

// ---------- proj new ----------
export async function cmdNew(name, opts, positionalDescription) {
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) die('usage: proj new <name> ["what you are building"] [--stack ..] [--visual|--no-visual] [--sensitive ..] [--database] [--tasks] [--profile file.json] [--dir <parent>] [--no-remote] [--no-protect] [--dry-run]');
  const cfg = loadConfig();
  const interactive = process.stdin.isTTY && process.stdout.isTTY && !opts.profile && !opts['dry-run'];
  let description = opts.description || positionalDescription || (opts.profile ? readProfile(opts.profile).description : '');
  if (!description && interactive) description = await ask('What are you building? One or two sentences (who it is for, what it does): ');
  const profile = await resolveProfile(opts, description, { interactive: interactive && !positionalDescription && !opts.description, tty: interactive });
  const dir = path.resolve(opts.dir || process.cwd(), name);
  const remote = !opts['no-remote'];
  const owner = remote ? opts.owner || cfg.owner || ghLogin() : opts.owner || cfg.owner;
  if (remote && !owner) die('cannot tell the GitHub owner: run `gh auth login` or pass --owner');
  const files = renderTemplate(profile, templateVars({ name, owner, description, profile }));

  // Resume only a bootstrap that proj itself started here (marker in .git/proj); never an existing project.
  const marker = path.join(dir, '.git', 'proj', 'bootstrap-pending.json');
  const resuming = fs.existsSync(marker);
  if (!resuming && fs.existsSync(dir) && fs.readdirSync(dir).length) die(`${dir} exists and is not empty; use \`proj adopt\` inside it instead`);

  if (opts['dry-run']) {
    out(`would create ${dir} (${files.size} files)${remote ? ` and private repo ${owner}/${name}` : ''}`);
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
    writeJson(path.join(dir, '.proj.json'), { ...pj, profile: storedProfile(profile, description), managed });
    gitOk(['init', '-b', cfg.baseBranch], { cwd: dir });
    applyGitConfig(dir, { onlyUnset: false });
    gitOk(['add', '-A'], { cwd: dir });
    const staged = gitOk(['diff', '--cached', '--name-only'], { cwd: dir }).split(/\r?\n/);
    if (staged.some(isSecretPath)) die('refusing to commit a secret-looking file');
    gitOk(['commit', '-q', '-m', 'chore: bootstrap from project-starter'], { cwd: dir });
    if (remote) writeJson(marker, { owner, name, at: now() });
    out(`created ${dir}`);
  } else out(`resuming bootstrap of ${dir}`);

  registerRepo(dir);
  if (remote) {
    const slug = `${owner}/${name}`;
    if (git(['remote', 'get-url', 'origin'], { cwd: dir }).code !== 0) {
      if (gh(['repo', 'view', slug, '--json', 'name']).code === 0) die(`${slug} already exists on GitHub; refusing to reuse it. Add it as origin yourself if it is yours.`);
      const vis = cfg.visibility === 'public' ? '--public' : '--private';
      const r = gh(['repo', 'create', slug, vis, '--source', dir, '--remote', 'origin', '--push', '--description', description || name], { cwd: dir });
      if (r.code !== 0) die(`gh repo create failed: ${r.err}`);
      out(`created ${vis.slice(2)} repo https://github.com/${slug}`);
      if (vis === '--private') runnerDefault(slug, { stack: profile.stack });
    } else if (git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${cfg.baseBranch}`], { cwd: dir }).code !== 0) {
      gitOk(['push', '-u', 'origin', cfg.baseBranch], { cwd: dir });
    }
    // `proj new` hardens only the repository it just created (or a bootstrap it left unfinished).
    // --no-protect leaves main open for the creator's own first push (the new-project skill's tailoring commit).
    if (opts['no-protect']) out(`protection deferred: push your first commits to main, then run \`proj protect\` in ${dir}`);
    else protect(repoContext(dir));
    fs.rmSync(marker, { force: true });
  }
  out(`\nNext: open ${dir} in Claude Code or Codex and describe the first feature.`);
  if (profile.visual) out('      Before building screens, run /creative-director to choose and approve a visual direction.');
  out('      Fill in docs/BRIEF.md (or let the agent draft it from your description).');
  if (profile.stack === 'generic') out("      scripts/check.ps1 fails on purpose until you add the language's real test command to it.");
}

// A new PRIVATE repo joins `proj runner serve` on a machine that opted in (runner.serve in ~/.proj/config.json).
// Only serve sets PROJ_RUNS_ON (heartbeat first, while it runs), so a repo is never routed to a serve that is down.
// Never called for public repos; stacks the runner image cannot build stay GitHub-hosted.
export function runnerDefault(slug, { stack, configFile } = {}) {
  if (!stack || runnerRefusal(stack) || !editServed(slug, true, configFile)) return false;
  out(`added to \`proj runner serve\`: it routes same-repo PR CI to this machine's docker runners while it runs`);
  return true;
}

// What an existing repo looks like, for `proj adopt` without a stored profile.
function profileFromRepo(dir, opts) {
  const has = (rel) => fs.existsSync(path.join(dir, rel));
  const pkg = readJson(path.join(dir, 'package.json'), null);
  const deps = pkg ? Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).join(' ') : '';
  const py = ['pyproject.toml', 'requirements.txt'].map((f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : '')).join(' ');
  const visual = /\b(react|vue|svelte|next|nuxt|@angular\/core|solid-js|astro)\b/.test(deps) || fs.existsSync(path.join(dir, 'index.html'));
  const database = /\b(prisma|pg|mysql2|sqlite3|better-sqlite3|mongoose|drizzle-orm|sqlalchemy|django|psycopg)/i.test(`${deps} ${py}`);
  const settings = has('.claude/settings.json') ? fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8') : '';
  const cargo = has('Cargo.toml') ? fs.readFileSync(path.join(dir, 'Cargo.toml'), 'utf8') : '';
  const tomlDesc = `${py}\n${cargo}`.match(/^description\s*=\s*"([^"]*)"/m)?.[1];
  const agents = has('AGENTS.md') ? fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8') : '';
  const description = pkg?.description || tomlDesc || agents.match(/^\S+: (.+)$/m)?.[1]?.replace(/^TODO.*/, '') || '';
  // Repos bootstrapped by an older proj keep what they already had (hooks, security reviewer, design kit).
  const sensitive = has('.claude/agents/security.md') ? ['secrets'] : [];
  const tasks = settings.includes('proj hook') || has('.codex/hooks.json');
  const said = inferProfile(description);
  const kind = visual ? 'web-app' : said.uncertain.includes('kind') ? 'other' : said.kind;
  return { description, ...validate({ kind, stack: detectStack(dir), visual: visual || has('DESIGN.md'), sensitive, database: database || has('.claude/rules/database.md'), tasks, ...flagOverrides(opts) }) };
}

// ---------- proj adopt (never overwrites; --upgrade refreshes starter files you have not edited) ----------
export function cmdAdopt(opts) {
  const ctx = repoContext();
  const dir = ctx.root; // the checkout or task worktree you are in, so changes land on a reviewable branch
  const pjPath = path.join(dir, '.proj.json');
  const pj = readJson(pjPath, null);
  const detected = profileFromRepo(dir, opts);
  const profile = pj?.profile ? validate({ ...pj.profile, ...flagOverrides(opts) }) : detected;
  const name = ctx.remote?.name || path.basename(dir);
  const files = renderTemplate(profile, templateVars({ name, owner: ctx.remote?.owner, description: pj?.profile?.description || detected.description, profile }));
  const dry = opts['dry-run'];
  const managed = { ...(pj?.managed || {}) };
  const report = { add: [], keep: [], upgrade: [], edited: [], advice: [], skipped: [] };
  out(`profile: ${describeProfile(profile)}${pj?.profile ? '' : ' (detected; adjust with --visual, --sensitive, --database, --tasks)'}`);

  for (const [rel, text] of files) {
    const p = path.join(dir, rel);
    if (!fs.existsSync(p)) {
      if (rel === '.proj.json') continue; // written below
      if (SKELETON.test(rel)) { if (/^(package(-lock)?\.json|pyproject\.toml|go\.mod|Cargo\.toml)$/.test(rel)) report.skipped.push(rel); continue; }
      if (rel === 'docs/assets/banner.svg' && fs.existsSync(path.join(dir, 'README.md'))) continue; // only the generated README shows it
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

  if (report.skipped.length)
    report.advice.push(`not added, since this repo's code and manifests stay its own: ${report.skipped.join(', ')}. CI expects them: adjust .github/workflows/ci.yml if this repo builds differently.`);
  const check = path.join(dir, 'scripts', 'check.ps1');
  if (profile.stack === 'generic' && /^\$tests = @\(\s*\)/m.test(fs.existsSync(check) ? fs.readFileSync(check, 'utf8') : files.get('scripts/check.ps1') || ''))
    report.advice.push('CI fails (exit 2, "NOT VERIFIED") until scripts/check.ps1 lists this repo\'s real test command in $tests.');
  const claude = path.join(dir, 'CLAUDE.md');
  if (fs.existsSync(claude) && !/^@AGENTS\.md\s*$/m.test(fs.readFileSync(claude, 'utf8')))
    report.advice.push('CLAUDE.md exists without an `@AGENTS.md` line: add it so Claude Code also loads AGENTS.md.');
  if (profile.tasks && report.keep.includes('.claude/settings.json') && !fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8').includes('proj hook'))
    report.advice.push(`.claude/settings.json kept as is: merge the hooks from ${path.join(TEMPLATE, 'modules', 'tasks', '.claude', 'settings.merge.json')} yourself.`);

  const gitChanges = dry ? Object.keys(GIT_CONFIG).filter((k) => git(['config', '--local', '--get', k], { cwd: dir }).code !== 0) : applyGitConfig(dir, { onlyUnset: true });
  if (!dry) {
    const stackPj = JSON.parse(files.get('.proj.json'));
    writeJson(pjPath, { ...stackPj, ...(pj || {}), stack: profile.stack, profile: storedProfile(profile, pj?.profile?.description || detected.description), managed });
    registerRepo(ctx.mainRoot);
  }

  const verb = dry ? 'would ' : '';
  out(`${verb}add ${report.add.length}, keep ${report.keep.length}${opts.upgrade ? `, upgrade ${report.upgrade.length}, skip edited ${report.edited.length}` : ''}`);
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

// Only GitHub's plan message means the plan lacks rulesets; any other refusal (a 403 without admin rights) is a failure.
export const rulesetOutcome = (err) => (/upgrade to github pro|make this repository public/i.test(err || '') ? 'plan-gated' : 'failed');

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
  } else if (rulesetOutcome(rs.err) === 'plan-gated') {
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
