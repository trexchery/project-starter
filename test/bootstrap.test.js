// The primary experience: a description becomes a tailored project foundation.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { proj, git, tmpDir, exists, read, run } from './helpers.js';
import { inferProfile, flagOverrides } from '../lib/profile.js';
import { render } from '../lib/bootstrap.js';
import { findBrowser } from '../lib/design.js';

const MEALPLAN = 'A web app where families plan weekly meals, share recipes and pay a monthly subscription with Stripe; accounts, Postgres database';

describe('profile inference', () => {
  const cases = [
    [MEALPLAN, { kind: 'web-app', stack: 'node', visual: true, sensitive: ['auth', 'payments'], database: true }],
    ['A Python command-line tool that cleans and validates CSV exports', { kind: 'cli', stack: 'python', visual: false, sensitive: [], database: false }],
    ['A small TypeScript library for structured logging', { kind: 'library', stack: 'node', visual: false, sensitive: [], database: false }],
    ['A landing page for a neighborhood bakery', { kind: 'website', stack: 'node', visual: true, sensitive: [], database: false }],
    ['A REST API in Go for warehouse inventory backed by Postgres', { kind: 'api', stack: 'generic', visual: false, database: true }],
    ['An iOS app that tracks running routes', { kind: 'mobile-app', visual: true }],
    ['A FastAPI backend that stores patient appointments', { kind: 'api', stack: 'python', visual: false, sensitive: ['pii'] }],
    // review regressions: everyday words, "go", mixed stacks, plain "app", C#
    ['A dashboard showing users per region', { kind: 'web-app', sensitive: [] }],
    ['A health check CLI for servers', { kind: 'cli', sensitive: [] }],
    ['A Django backend with a React frontend', { kind: 'web-app', stack: 'node', database: true }],
    ['A website for a board game cafe', { kind: 'website', visual: true }],
    ['A booking app for hair salons', { kind: 'web-app', visual: true }],
    ['A Discord bot that posts daily stats', { sensitive: ['secrets'], visual: false }],
    ['A C# desktop tool', { stack: 'generic' }],
    ["Let's go build something", { stack: 'generic', kind: 'other', uncertain: ['kind', 'stack'] }],
  ];
  for (const [text, want] of cases) {
    test(text, () => {
      const p = inferProfile(text);
      for (const [k, v] of Object.entries(want)) assert.deepEqual(p[k], v, `${k} for "${text}"`);
      assert.ok(p.reasons.length > 0, 'every inference explains itself');
    });
  }
  test('flags override the description', () => {
    const p = inferProfile(MEALPLAN, flagOverrides({ 'no-visual': true, sensitive: 'none', 'no-database': true, tasks: true }));
    assert.deepEqual([p.visual, p.sensitive, p.database, p.tasks], [false, [], false, true]);
  });
});

describe('template rendering', () => {
  test('inline, line-level, nested and inverse blocks', () => {
    const t = 'A{{#x}} x{{/x}}{{^x}} not-x{{/x}}.\n{{#x}}\nline x\n{{#y}}\nline y\n{{/y}}\n{{/x}}\nend {{name}} ${{ github.sha }}\n';
    assert.equal(render(t, { x: true, y: false, name: 'n' }), 'A x.\nline x\nend n ${{ github.sha }}\n');
    assert.equal(render(t, { x: false, name: 'n' }), 'A not-x.\nend n ${{ github.sha }}\n');
  });
  test('an inline block never swallows a later line-level block of the same name; CRLF tag lines vanish', () => {
    assert.equal(render('a{{#x}}1{{/x}}b\n{{#x}}\nkeep\n{{/x}}\nend\n', { x: false }), 'ab\nend\n');
    assert.equal(render('a\r\n{{#x}}\r\nin\r\n{{/x}}\r\nb\r\n', { x: false }), 'a\r\nb\r\n');
  });
});

async function create(args) {
  const parent = tmpDir('new-');
  const home = path.join(parent, 'home');
  const r = await proj(['new', ...args, '--no-remote', '--dir', parent], { cwd: parent, home });
  assert.equal(r.code, 0, r.out + r.err);
  const dir = path.join(parent, args[0]);
  const files = (await git(dir, 'ls-files')).split('\n');
  return { dir, files, out: r.out, has: (f) => files.includes(f) };
}
const frontmatter = (text) => Object.fromEntries((text.replace(/\r\n/g, '\n').split('---\n')[1] || '').trim().split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));

describe('proj new tailors the foundation', { concurrency: true }, () => {
  test('a visual web app with accounts, payments and a database gets every relevant module, explained', async () => {
    const p = await create(['mealplan', MEALPLAN]);
    assert.match(p.out, /Understood: web-app on node · visual/);
    for (const f of ['DESIGN.md', '.claude/skills/creative-director/SKILL.md', '.claude/agents/visual-critic.md', '.claude/agents/design-researcher.md',
      '.claude/rules/ui.md', '.claude/agents/security.md', '.claude/rules/security.md', '.claude/rules/database.md', '.codex/agents/security.toml'])
      assert.ok(p.has(f), f);
    const agents = read(p.dir, 'AGENTS.md');
    for (const s of ['## Sensitive areas: accounts and login, payments', '- Accounts:', '- Payments:', '## Database', '## Design', '/creative-director']) assert.ok(agents.includes(s), s);
    assert.doesNotMatch(agents, /- Personal data:|Task workflow/);
    assert.match(agents, /Every screen works at 390px/, 'kind-specific rule');
    assert.deepEqual(JSON.parse(read(p.dir, '.proj.json')).profile, { description: MEALPLAN, kind: 'web-app', stack: 'node', visual: true, sensitive: ['auth', 'payments'], database: true, tasks: false });
    assert.equal((await run('npm', ['test'], { cwd: p.dir, shell: true })).code, 0, 'the generated tests pass');
  });

  test('a non-visual CLI inherits no design, security or database infrastructure', async () => {
    const p = await create(['csvkit', 'A Python command-line tool that cleans and validates CSV exports']);
    for (const f of p.files) assert.doesNotMatch(f, /DESIGN|design|visual|creative|security|database|ui\.md|hooks\.json/, f);
    const agents = read(p.dir, 'AGENTS.md');
    assert.doesNotMatch(agents, /DESIGN\.md|visual-critic|Sensitive areas|## Database|proj task/);
    assert.match(agents, /Tests: `python -m pytest`/);
  });

  test('task hooks are opt-in (--tasks), and generated repos never require proj otherwise', async () => {
    const plain = await create(['plain', 'A small TypeScript library for structured logging']);
    assert.equal(JSON.parse(read(plain.dir, '.claude/settings.json')).hooks, undefined);
    assert.ok(!plain.has('.codex/hooks.json'));
    assert.doesNotMatch(read(plain.dir, 'AGENTS.md') + read(plain.dir, 'README.md'), /\bproj /);
    const tasks = await create(['tracked', 'A small TypeScript library for structured logging', '--tasks']);
    const settings = JSON.parse(read(tasks.dir, '.claude/settings.json'));
    assert.deepEqual(Object.keys(settings.hooks).sort(), ['PreCompact', 'SessionEnd', 'SessionStart']);
    assert.ok(settings.permissions.deny.length > 0, 'merging hooks keeps the permission rules');
    assert.ok(tasks.has('.codex/hooks.json'));
    assert.match(read(tasks.dir, 'AGENTS.md'), /## Task workflow \(optional\)/);
  });

  test('the owner keeps the main model, effort and Ultracode; every subagent chooses its own', async () => {
    const p = await create(['everything', `${MEALPLAN}; personal data and API keys`, '--tasks']);
    const settings = JSON.parse(read(p.dir, '.claude/settings.json'));
    for (const k of ['model', 'effortLevel', 'alwaysThinkingEnabled', 'disableWorkflows', 'workflowSizeGuideline', 'availableModels'])
      assert.equal(settings[k], undefined, `settings.json must not set ${k}`);
    const agents = p.files.filter((f) => f.startsWith('.claude/agents/'));
    assert.ok(agents.length >= 7);
    for (const f of agents) {
      const fm = frontmatter(read(p.dir, f));
      assert.match(fm.model, /^(haiku|sonnet|opus)$/, `${f} model`);
      assert.match(fm.effort, /^(low|medium|high|xhigh|max)$/, `${f} effort`);
    }
    for (const f of p.files.filter((x) => x.endsWith('SKILL.md'))) {
      const fm = frontmatter(read(p.dir, f));
      assert.equal(fm.model, undefined, `${f} must not switch the session model`);
      assert.equal(fm.effort, undefined, `${f} must not switch the session effort`);
    }
    for (const f of p.files) assert.doesNotMatch(read(p.dir, f), /\{\{[#^/]?\w+\}\}/, `${f} has an unrendered placeholder`);
    // workflows run their own safe commands without prompting, on both of Claude Code's shells
    const cd = frontmatter(read(p.dir, '.claude/skills/creative-director/SKILL.md'))['allowed-tools'];
    assert.match(cd, /Bash\(proj shot \*\)/);
    assert.match(cd, /PowerShell\(proj shot \*\)/);
  });

  test('a profile file (as written by the new-project skill) drives the result', async () => {
    const parent = tmpDir('prof-');
    const file = path.join(parent, 'profile.json');
    fs.writeFileSync(file, JSON.stringify({ description: 'Internal admin dashboard', kind: 'web-app', stack: 'node', visual: true, sensitive: ['auth'], database: false }));
    const r = await proj(['new', 'admin', '--profile', file, '--no-remote', '--dir', parent], { cwd: parent, home: path.join(parent, 'home') });
    assert.equal(r.code, 0, r.err);
    const dir = path.join(parent, 'admin');
    assert.ok(exists(dir, 'DESIGN.md') && exists(dir, '.claude/agents/security.md') && !exists(dir, '.claude/rules/database.md'));
    assert.match(read(dir, 'AGENTS.md'), /admin: Internal admin dashboard/);
    assert.match(r.out, /Understood: web-app on node · visual/, 'a profile file is echoed like an inferred one');
    const bad = await proj(['new', 'admin2', '--profile', file, '--kind', 'spaceship', '--no-remote', '--dir', parent], { cwd: parent, home: path.join(parent, 'home') });
    assert.notEqual(bad.code, 0, 'flag overrides on a profile file are validated');
    assert.ok(!exists(parent, 'admin2'));
  });

  test('adopt --upgrade keeps the description and what an older bootstrap installed', async () => {
    const p = await create(['keeper', 'A Python command-line tool that cleans and validates CSV exports']);
    const home = path.join(path.dirname(p.dir), 'home');
    const pjFile = path.join(p.dir, '.proj.json');
    const pj = JSON.parse(read(p.dir, '.proj.json'));
    delete pj.profile; // as written by an older proj
    fs.writeFileSync(pjFile, JSON.stringify(pj));
    fs.mkdirSync(path.join(p.dir, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(p.dir, '.claude', 'agents', 'security.md'), 'x');
    const r = await proj(['adopt', '--upgrade'], { cwd: p.dir, home });
    assert.equal(r.code, 0, r.err);
    assert.match(read(p.dir, 'AGENTS.md'), /keeper: A Python command-line tool/, 'description survives');
    assert.deepEqual(JSON.parse(read(p.dir, '.proj.json')).profile.sensitive, ['secrets'], 'security reviewer kept');
  });

  test('adopt in a generated repo reads the stored profile and adds nothing', async () => {
    const p = await create(['again', MEALPLAN]);
    const r = await proj(['adopt'], { cwd: p.dir, home: path.join(path.dirname(p.dir), 'home') });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^add 0,/m);
  });
});

test('proj shot renders a page with the local browser', { skip: !findBrowser() && 'no Chrome/Edge/Chromium here' }, async () => {
  const dir = tmpDir('shot-');
  fs.writeFileSync(path.join(dir, 'p.html'), '<!doctype html><body style="background:#123">hi</body>');
  const r = await proj(['shot', path.join(dir, 'p.html'), path.join(dir, 'p.png'), '--width', '320', '--height', '200'], { cwd: dir });
  assert.equal(r.code, 0, r.err);
  const png = fs.readFileSync(path.join(dir, 'p.png'));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 320, 'width');
});
