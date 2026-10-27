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

test('bin/proj shim delegates to proj.js', () => {
  assert.match(fs.readFileSync(path.join(ROOT, 'bin', 'proj'), 'utf8'), /exec node "\$\(dirname "\$0"\)\/proj\.js" "\$@"/);
});
