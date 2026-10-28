// The Claude Code plugin ships from this repo: manifests, skill and versions must stay consistent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.js';

const json = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

test('plugin manifest, marketplace and package.json agree', () => {
  const pkg = json('package.json');
  const plugin = json('.claude-plugin/plugin.json');
  const market = json('.claude-plugin/marketplace.json');
  assert.equal(plugin.version, pkg.version, 'bump plugin.json with package.json: users only get updates on a version bump');
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].name, plugin.name);
  assert.equal(market.plugins[0].source, './');
  assert.doesNotThrow(() => new URL(plugin.homepage));
});

test('proj-audit skill: frontmatter, triggers and the safety contract', () => {
  const text = fs.readFileSync(path.join(ROOT, 'skills', 'proj-audit', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  const fm = Object.fromEntries(text.split('---\n')[1].trim().split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));
  assert.equal(fm.name, 'proj-audit');
  assert.ok(fm.description.length <= 1536, 'the skill listing truncates longer descriptions');
  assert.match(fm.description, /worktree/);
  assert.doesNotMatch(fm['allowed-tools'], /--apply|--force|-D\b/, 'cleanup that changes refs must not be pre-approved');
  assert.match(text, /proj doctor --json/);
  assert.match(text, /never touches dirty/);
});

test('every shipped skill: valid frontmatter, no model or effort override, no destructive pre-approval', () => {
  const dir = path.join(ROOT, 'skills');
  const names = fs.readdirSync(dir);
  assert.deepEqual(names.sort(), ['new-project', 'proj-audit']);
  for (const n of names) {
    const text = fs.readFileSync(path.join(dir, n, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
    const fm = Object.fromEntries(text.split('---\n')[1].trim().split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));
    assert.equal(fm.name, n);
    assert.ok(fm.description && fm.description.length <= 1536, `${n} description`);
    assert.equal(fm.model, undefined, `${n} must not switch the owner's model`);
    assert.equal(fm.effort, undefined, `${n} must not switch the owner's effort`);
    assert.doesNotMatch(fm['allowed-tools'] || '', /--apply|--force|-D\b|rm /, `${n} pre-approves something destructive`);
  }
});

test("bin shims delegate to proj.js on both of Claude Code's shells (the plugin puts bin/ on PATH)", () => {
  assert.match(fs.readFileSync(path.join(ROOT, 'bin', 'proj'), 'utf8'), /exec node "\$\(dirname "\$0"\)\/proj\.js" "\$@"/);
  // PowerShell cannot run the extensionless sh shim: without proj.cmd, `proj protect` silently did nothing there.
  assert.match(fs.readFileSync(path.join(ROOT, 'bin', 'proj.cmd'), 'utf8'), /^@node "%~dp0proj\.js" %\*\r?\n$/);
});
