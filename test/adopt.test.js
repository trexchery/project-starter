import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, git, read, write, exists, ROOT } from './helpers.js';
import { sha256 } from '../lib/core.js';

// Every file under dir (including .git/config, excluding git objects) with its content.
function tree(dir) {
  const res = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p);
      if (e.isDirectory()) { if (!/^\.git[\\/](objects|logs)$/.test(rel)) walk(p); } else res[rel] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return res;
}

describe('proj adopt', { concurrency: true }, () => {
  test('never overwrites existing files, commits nothing, and is idempotent', async () => {
    const repo = await makeRepo({ files: { 'AGENTS.md': 'my own agents file\n', '.gitignore': 'custom\n', 'CLAUDE.md': 'my claude\n' } });
    const head = await git(repo.root, 'rev-parse', 'HEAD');
    const first = await repo.proj(['adopt']);
    assert.equal(first.code, 0, first.err);
    const added = Number(first.out.match(/add (\d+)/)[1]);
    assert.ok(added > 5, first.out);
    assert.equal(read(repo.root, 'README.md'), '# test\n');
    assert.equal(read(repo.root, 'AGENTS.md'), 'my own agents file\n');
    assert.equal(read(repo.root, '.gitignore'), 'custom\n');
    assert.match(first.out, /CLAUDE\.md exists without an `@AGENTS\.md` line/);
    assert.ok(exists(repo.root, '.claude', 'settings.json') && exists(repo.root, '.proj.json'));
    assert.equal(await git(repo.root, 'rev-parse', 'HEAD'), head, 'nothing committed');
    assert.equal(await git(repo.root, 'config', '--local', 'pull.ff'), 'only');

    const before = tree(repo.root);
    const second = await repo.proj(['adopt']);
    assert.equal(second.code, 0, second.err);
    assert.match(second.out, /^add 0,/m);
    const after = tree(repo.root);
    assert.deepEqual(Object.keys(after).filter((f) => !f.startsWith('.git')).sort(), Object.keys(before).filter((f) => !f.startsWith('.git')).sort());
    for (const f of Object.keys(before)) if (!f.startsWith('.git') && f !== '.proj.json') assert.equal(after[f], before[f], f);
  });

  test('a Go repo gets the go stack and CI, never starter code or a manifest; the kind comes from its description', async () => {
    const repo = await makeRepo({ files: { 'go.mod': 'module example.com/inv\n\ngo 1.24\n', 'main.go': 'package main\n\nfunc main() {}\n' } });
    const r = await repo.proj(['adopt']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /profile: other on go/);
    assert.equal(read(repo.root, 'go.mod'), 'module example.com/inv\n\ngo 1.24\n');
    assert.ok(!exists(repo.root, 'hello.go') && !exists(repo.root, 'hello_test.go'), 'no skeleton written');
    assert.match(read(repo.root, '.github/workflows/ci.yml'), /run: go test \.\/\.\.\./);
    assert.match(read(repo.root, '.github/dependabot.yml'), /package-ecosystem: gomod/);
    assert.doesNotMatch(r.out, /NOT VERIFIED|not added/);

    const rust = await makeRepo({ files: { 'Cargo.toml': '[package]\nname = "tally"\ndescription = "A command-line tool that counts words"\n' } });
    const rr = await rust.proj(['adopt', '--dry-run']);
    assert.match(rr.out, /profile: cli on rust/, 'kind read from the manifest description');
    assert.doesNotMatch(rr.out, /\+ src\/|Cargo\.toml/);
  });

  test('a package.json repo with tsconfig.json or a typescript dependency is the typescript stack; without, node', async () => {
    const cases = [[{ 'package.json': '{"name":"a"}\n', 'tsconfig.json': '{}\n' }, 'typescript'],
      [{ 'package.json': '{"name":"a","devDependencies":{"typescript":"^5.6.0"}}\n' }, 'typescript'],
      [{ 'package.json': '{"name":"a"}\n' }, 'node']];
    for (const [files, stack] of cases) {
      const repo = await makeRepo({ files });
      const r = await repo.proj(['adopt', '--dry-run']);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, new RegExp(`profile: \\S+ on ${stack}\\b`), JSON.stringify(files));
    }
  });

  test('a requirements.txt repo gets no skeleton, and is told what CI still expects', async () => {
    const repo = await makeRepo({ files: { 'requirements.txt': 'requests\n', 'app.py': 'print(1)\n' } });
    const r = await repo.proj(['adopt']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /profile: other on python/);
    for (const f of ['pyproject.toml', 'tests', 'src']) assert.ok(!exists(repo.root, f), `${f} not added`);
    assert.match(r.out, /not added, .*: pyproject\.toml\. CI expects them/);
  });

  test('a repo with no known toolchain is warned that CI fails until check.ps1 lists a test command', async () => {
    const repo = await makeRepo({ files: { 'main.zig': 'pub fn main() void {}\n' } });
    const r = await repo.proj(['adopt']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /note: CI fails \(exit 2, "NOT VERIFIED"\) until scripts\/check\.ps1 lists/);
  });

  test('--dry-run writes nothing anywhere', async () => {
    const repo = await makeRepo();
    const before = tree(repo.root);
    const r = await repo.proj(['adopt', '--dry-run']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^would add \d+/m);
    assert.match(r.out, /git config would set: pull\.ff, fetch\.prune/);
    assert.deepEqual(tree(repo.root), before);
    assert.ok(!exists(repo.home), 'PROJ_HOME untouched');
  });

  test('--upgrade refreshes an unmodified managed file and keeps an edited one', async () => {
    const repo = await makeRepo();
    assert.equal((await repo.proj(['adopt'])).code, 0);
    // Pretend both files came from an older template, then the user edited one of them.
    const pjPath = path.join(repo.root, '.proj.json');
    const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
    const OLD = 'old template text\n';
    for (const f of ['.editorconfig', 'SECURITY.md']) { write(repo.root, f, OLD); pj.managed[f] = sha256(OLD); }
    write(repo.root, 'SECURITY.md', 'edited by the owner\n');
    fs.writeFileSync(pjPath, JSON.stringify(pj, null, 2));

    const dry = await repo.proj(['adopt', '--upgrade', '--dry-run']);
    assert.equal(dry.code, 0, dry.err);
    assert.equal(read(repo.root, '.editorconfig'), OLD, 'dry run upgrades nothing');

    const r = await repo.proj(['adopt', '--upgrade']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /upgrade 1, skip edited 1/);
    assert.match(r.out, /~ \.editorconfig/);
    assert.match(r.out, /= SECURITY\.md \(you edited it; left alone\)/);
    const fresh = fs.readFileSync(path.join(ROOT, 'template', 'common', '.editorconfig'), 'utf8');
    assert.equal(read(repo.root, '.editorconfig'), fresh);
    assert.equal(read(repo.root, 'SECURITY.md'), 'edited by the owner\n');
    const pj2 = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
    assert.equal(pj2.managed['.editorconfig'], sha256(fresh));
    assert.equal(pj2.managed['SECURITY.md'], sha256(OLD), 'edited file keeps its old baseline');
  });
});
