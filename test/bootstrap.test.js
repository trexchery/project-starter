// The primary experience: a description becomes a tailored project foundation.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { proj, git, tmpDir, exists, read, run, ROOT } from './helpers.js';
import { inferProfile, flagOverrides } from '../lib/profile.js';
import { render, renderTemplate, templateVars, rulesetOutcome } from '../lib/bootstrap.js';
import { findBrowser } from '../lib/design.js';

const MEALPLAN = 'A web app where families plan weekly meals, share recipes and pay a monthly subscription with Stripe; accounts, Postgres database';

describe('profile inference', () => {
  const cases = [
    [MEALPLAN, { kind: 'web-app', stack: 'node', visual: true, sensitive: ['auth', 'payments'], database: true }],
    ['A Python command-line tool that cleans and validates CSV exports', { kind: 'cli', stack: 'python', visual: false, sensitive: [], database: false }],
    ['A small TypeScript library for structured logging', { kind: 'library', stack: 'typescript', visual: false, sensitive: [], database: false }],
    ['A landing page for a neighborhood bakery', { kind: 'website', stack: 'node', visual: true, sensitive: [], database: false }],
    ['A REST API in Go for warehouse inventory backed by Postgres', { kind: 'api', stack: 'go', visual: false, database: true }],
    ['An iOS app that tracks running routes', { kind: 'mobile-app', visual: true }],
    ['A FastAPI backend that stores patient appointments', { kind: 'api', stack: 'python', visual: false, sensitive: ['pii'] }],
    // review regressions: everyday words, "go", mixed stacks, plain "app", C#
    ['A dashboard showing users per region', { kind: 'web-app', sensitive: [] }],
    ['A health check CLI for servers', { kind: 'cli', sensitive: [] }],
    ['A Django backend with a React frontend', { kind: 'web-app', stack: 'node', database: true }],
    ['A website for a board game cafe', { kind: 'website', visual: true }],
    ['A booking app for hair salons', { kind: 'web-app', visual: true }],
    ['A Discord bot that posts daily stats', { sensitive: ['secrets'], visual: false }],
    ['A C# desktop tool', { stack: 'dotnet' }],
    // a named language beats domain hints; games by engine or genre; crate/gem/module libraries; console apps
    ['A Bevy game in Rust', { kind: 'game', stack: 'rust', visual: true }],
    ['A 2D roguelike in C#', { kind: 'game', stack: 'dotnet', visual: true }],
    ['A Unity game in C#', { kind: 'game', stack: 'generic' }],
    ['A web scraper in Go', { kind: 'data', stack: 'go' }],
    ['A machine learning model in Rust', { kind: 'data', stack: 'rust' }],
    ['A dotnet console app', { kind: 'cli', stack: 'dotnet', visual: false }],
    ['Go microservice', { kind: 'api', stack: 'go', uncertain: [] }],
    ['A Ruby gem', { kind: 'library', stack: 'generic' }],
    ['A node module for dates', { kind: 'library', stack: 'node' }],
    ['A crate for parsing dates', { kind: 'library', stack: 'rust' }],
    ['A C library for ring buffers', { kind: 'library', stack: 'generic', uncertain: [] }],
    ["Let's go build something", { stack: 'generic', kind: 'other', uncertain: ['kind', 'stack'] }],
    // "game(s)" as a topic is not a game; a leading "Go" is the language only before a product word; C#/.NET with slashes
    ['A CLI that tracks my board games collection', { kind: 'cli' }],
    ['A library for parsing chess games', { kind: 'library' }],
    ['An API that serves game scores', { kind: 'api' }],
    ['A games leaderboard API in Go', { kind: 'api', stack: 'go' }],
    ['Go-to dashboard for sales', { kind: 'web-app', stack: 'node' }],
    ['Go through my inbox and archive newsletters, a CLI', { kind: 'cli', stack: 'generic' }],
    ['Go CLI for backups', { kind: 'cli', stack: 'go' }],
    ['A Go REST API', { kind: 'api', stack: 'go' }],
    ['A C#/.NET API', { kind: 'api', stack: 'dotnet' }],
    ['An ASP.NET/C# web API', { kind: 'api', stack: 'dotnet' }],
    ['A .NET/C# tool', { stack: 'dotnet' }],
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

describe('generated README and banner', () => {
  const rendered = (name, stack) => {
    const profile = inferProfile('a tool', { stack, kind: 'cli' });
    return renderTemplate(profile, templateVars({ name, description: 'x', profile }));
  };
  test('the banner stays well-formed XML for a name with &, < and quotes', () => {
    const svg = rendered(`R&D <"tools">`, 'node').get('docs/assets/banner.svg');
    assert.ok(svg.length < 2048, `banner is ${svg.length} bytes`);
    assert.doesNotMatch(svg, /&(?!(#\d+|amp|lt|gt|quot|apos);)|\{\{/, 'no raw & and no leftover placeholder');
    assert.doesNotMatch(svg.replace(/<\/?\w+(\s+[\w:-]+="[^"<]*")*\s*\/?>/g, ''), /[<>]/, 'every < and > belongs to a tag');
    const stack = [];
    for (const [, close, tag, self] of svg.matchAll(/<(\/?)(\w+)[^>]*?(\/?)>/g)) {
      if (self) continue;
      if (close) assert.equal(stack.pop(), tag, `</${tag}> closes its own tag`); else stack.push(tag);
    }
    assert.deepEqual(stack, [], 'all tags closed');
    assert.match(svg, /role="img"/);
    assert.match(svg, /<title id="t">R&#38;D &#60;&#34;tools&#34;&#62;<\/title>/);
  });
  test('quick start names the stack\'s own commands; only generic warns NOT VERIFIED; no CI badges', () => {
    for (const [stack, cmds] of [['node', ['npm ci', 'npm test']], ['python', ['python -m pytest']], ['go', ['go test ./...']], ['rust', ['cargo test']], ['dotnet', ['dotnet restore', 'dotnet test']], ['generic', ['pwsh -NoProfile -File scripts/check.ps1']]]) {
      const readme = rendered('demo', stack).get('README.md');
      for (const c of cmds) assert.ok(readme.includes(`\n${c}\n`), `${stack}: ${c}`);
      assert.equal(/NOT VERIFIED/.test(readme), stack === 'generic', stack);
      assert.doesNotMatch(readme, /img\.shields\.io\/github\/actions|badge\.svg|\{\{/);
    }
  });
  test('a name starting with a digit still gives a valid module identifier', () => {
    assert.equal(templateVars({ name: '2048-solver', profile: inferProfile('a python cli') }).module, 'app_2048_solver');
  });
});

test('protect: only GitHub\'s plan message is plan-gated; any other refusal is a failure', () => {
  assert.equal(rulesetOutcome('HTTP 403: Upgrade to GitHub Pro or make this repository public to enable this feature.'), 'plan-gated');
  assert.equal(rulesetOutcome('HTTP 403: Resource not accessible by personal access token'), 'failed');
  assert.equal(rulesetOutcome('HTTP 404: Not Found'), 'failed');
  assert.equal(rulesetOutcome(''), 'failed');
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

describe('final review: strict profiles, fail-closed generic check, verified push', { concurrency: true }, () => {
  const profileRun = async (profile) => {
    const parent = tmpDir('strict-');
    const file = path.join(parent, 'p.json');
    fs.writeFileSync(file, JSON.stringify(profile));
    const r = await proj(['new', 'x', '--profile', file, '--no-remote', '--dir', parent], { cwd: parent, home: path.join(parent, 'home') });
    return { r, created: exists(parent, 'x') };
  };
  for (const bad of [{ visual: 'false' }, { database: 'true' }, { tasks: 1 }, { sensitive: 'auth' }, { sensitive: [true] }, { kind: ['cli'] }]) {
    test(`a profile with ${JSON.stringify(bad)} is refused, nothing is created`, async () => {
      const { r, created } = await profileRun({ description: 'x', kind: 'cli', stack: 'node', ...bad });
      assert.notEqual(r.code, 0);
      assert.match(r.err, /must be/);
      assert.equal(created, false);
    });
  }

  const pwsh = (cwd) => run('pwsh', ['-NoProfile', '-File', 'scripts/check.ps1'], { cwd });
  test('the generic placeholder check fails closed until a real test command is listed', async (t) => {
    if ((await run('pwsh', ['-NoProfile', '-Command', 'exit 0'])).code !== 0) return t.skip('no PowerShell 7 here');
    const p = await create(['gadget', 'A Zig service that ingests telemetry from field sensors']);
    assert.match(p.out, /check\.ps1 fails on purpose/);
    const none = await pwsh(p.dir);
    assert.equal(none.code, 2, 'placeholder must not pass');
    assert.match(none.err + none.out, /NOT VERIFIED/);
    const file = path.join(p.dir, 'scripts', 'check.ps1');
    const original = read(p.dir, 'scripts/check.ps1');
    // check.ps1 is checked out with CRLF on CI (.gitattributes: *.ps1 eol=crlf) and may be LF locally.
    const withTest = (cmd) => {
      const next = original.replace(/^\$tests = @\(\r?\n/m, (m) => `${m}  '${cmd}'\n`);
      assert.notEqual(next, original, 'test command inserted');
      fs.writeFileSync(file, next);
    };
    withTest('pwsh -NoProfile -Command exit 7');
    assert.equal((await pwsh(p.dir)).code, 7, 'a failing test fails the check');
    withTest('pwsh -NoProfile -Command exit 0');
    const ok = await pwsh(p.dir);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /checks passed/);
  });

  test('--no-protect is accepted; the skill pushes, compares the remote SHA, then protects', async () => {
    const p = await create(['shipped', 'A small TypeScript library for structured logging', '--no-protect']);
    const skill = fs.readFileSync(path.join(ROOT, 'skills', 'new-project', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
    const step5 = skill.slice(skill.indexOf('## 5.'), skill.indexOf('## 6.'));
    const order = ['git commit', 'git push origin main', 'git rev-parse HEAD', 'git ls-remote origin refs/heads/main', 'proj protect'];
    const at = order.map((c) => step5.indexOf(c));
    assert.ok(at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1])), `step 5 runs ${order.join(' -> ')} in order`);
    assert.match(skill, /proj new <name> "<description>" --kind <kind> .* --no-protect/, 'profile passed as flags: no temp file to write or delete');
    assert.match(skill, /`cd <repo> && <command>`/);
    assert.match(skill, /No other chains, no `git -C`/);
    const allowed = frontmatter(skill)['allowed-tools'];
    for (const c of ['npm test', 'go test ./...', 'cargo test', 'dotnet test', 'git add -A', 'git push origin main', 'git rev-parse HEAD', 'git ls-remote origin *', 'proj protect']) {
      for (const f of [c, `cd * && ${c}`]) assert.ok(allowed.includes(`Bash(${f})`) && allowed.includes(`PowerShell(${f})`), `${f} pre-approved on both shells`);
    }

    // The flow itself, against a local bare remote: create -> push -> tailor -> commit -> push -> remote == HEAD.
    const bare = path.join(path.dirname(p.dir), 'remote.git');
    await git(path.dirname(p.dir), 'init', '-q', '--bare', '-b', 'main', bare);
    await git(p.dir, 'remote', 'add', 'origin', bare);
    await git(p.dir, 'push', '-q', '-u', 'origin', 'main');
    fs.appendFileSync(path.join(p.dir, 'docs', 'BRIEF.md'), '\nUsers: library authors.\n');
    await git(p.dir, 'add', '-A');
    await git(p.dir, 'commit', '-q', '-m', 'docs: tailor brief and agent instructions');
    await git(p.dir, 'push', '-q', 'origin', 'main');
    const remoteSha = (await git(p.dir, 'ls-remote', 'origin', 'refs/heads/main')).split(/\s/)[0];
    assert.equal(remoteSha, await git(p.dir, 'rev-parse', 'HEAD'), 'remote head is the tailored commit');

    // A refused push (what a protected main does) leaves the remote behind, and the comparison catches it.
    fs.writeFileSync(path.join(bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho "protected branch" >&2\nexit 1\n', { mode: 0o755 });
    fs.appendFileSync(path.join(p.dir, 'docs', 'BRIEF.md'), 'More.\n');
    await git(p.dir, 'commit', '-q', '-am', 'docs: more');
    await git(p.dir, 'push', '-q', 'origin', 'main').catch(() => {});
    const after = (await git(p.dir, 'ls-remote', 'origin', 'refs/heads/main')).split(/\s/)[0];
    assert.notEqual(after, await git(p.dir, 'rev-parse', 'HEAD'), 'a rejected push is detected, not reported as shipped');
  });
});

test('Creative Director: behaviour checks are conditional and the static path is unchanged', () => {
  const cd = fs.readFileSync(path.join(ROOT, 'template', 'modules', 'visual', '.claude', 'skills', 'creative-director', 'SKILL.md'), 'utf8');
  assert.match(cd, /### Behaviour checks \(only when the product needs them\)/);
  assert.match(cd, /Static screenshots are enough for most products/);
  for (const s of ['--width 1440 --height 900', '--width 390 --height 844', 'index.html#error', '--delay 2000', '#reduced-motion', 'measured once screens exist', 'reported as not verified'])
    assert.ok(cd.includes(s), s);
  assert.match(frontmatter(cd)['allowed-tools'], /^Bash\(proj shot \*\), PowerShell\(proj shot \*\)/, 'no new tools pre-approved');
});

// First pixel of a PNG: row 0 has no row above, so every PNG filter leaves its first pixel's bytes as stored.
const firstPixel = (file) => {
  const png = fs.readFileSync(file); const idat = [];
  for (let o = 8; o < png.length;) { const len = png.readUInt32BE(o); if (png.toString('ascii', o + 4, o + 8) === 'IDAT') idat.push(png.subarray(o + 8, o + 8 + len)); o += 12 + len; }
  return [...zlib.inflateSync(Buffer.concat(idat)).subarray(1, 4)].join(',');
};

test('proj shot captures interaction states (#hash) and settled motion (--delay), at desktop and phone width', { skip: !findBrowser() && 'no Chrome/Edge/Chromium here' }, async () => {
  const dir = tmpDir('states-');
  fs.writeFileSync(path.join(dir, 'p.html'), `<!doctype html><body style="margin:0;background:rgb(255,0,0)"><script>
if (location.hash === '#on') document.body.style.background = 'rgb(0,0,255)';
setTimeout(() => { if (!location.hash) document.body.style.background = 'rgb(0,128,0)'; }, 1500);</script>`);
  const shot = async (target, ...extra) => {
    const r = await proj(['shot', path.join(dir, target), path.join(dir, 'o.png'), ...extra], { cwd: dir });
    assert.equal(r.code, 0, r.err);
    return firstPixel(path.join(dir, 'o.png'));
  };
  for (const size of [['--width', '800', '--height', '300'], ['--width', '390', '--height', '300']]) {
    assert.equal(await shot('p.html', ...size), '255,0,0', 'default state');
    assert.equal(await shot('p.html#on', ...size), '0,0,255', 'hash state');
    assert.equal(await shot('p.html', ...size, '--delay', '3000'), '0,128,0', 'after the timer settles');
  }
});
