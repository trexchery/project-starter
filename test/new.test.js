import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { proj, git, run, tmpDir, exists, read, write } from './helpers.js';

const placeholders = (text) => text.replace(/\$\{\{[\s\S]*?\}\}/g, '').match(/\{\{\s*\w+\s*\}\}/g) || [];

describe('proj new', { concurrency: true }, () => {
  for (const stack of ['node', 'python', 'generic']) {
    test(`--no-remote renders the ${stack} stack, configures git, makes one commit`, async () => {
      const parent = tmpDir('new-');
      const home = path.join(parent, 'home');
      const name = `Demo-${stack}`;
      const r = await proj(['new', name, '--no-remote', '--stack', stack, '--dir', parent, '--description', 'a test project'], { cwd: parent, home });
      assert.equal(r.code, 0, r.err);
      const dir = path.join(parent, name);

      const files = (await git(dir, 'ls-files')).split(/\r?\n/);
      for (const f of ['AGENTS.md', 'CLAUDE.md', '.proj.json', '.gitignore', '.gitattributes', '.github/workflows/ci.yml', '.claude/settings.json'])
        assert.ok(files.includes(f), `${f} committed`);
      if (stack === 'node') assert.ok(files.includes('package.json') && files.includes('test/index.test.js'));
      if (stack === 'python') assert.ok(files.includes(`src/demo_python/__init__.py`), 'module dir rendered from {{module}}');
      for (const f of files) {
        assert.deepEqual(placeholders(f), [], `placeholder in file name ${f}`);
        assert.deepEqual(placeholders(read(dir, f)), [], `leftover placeholder in ${f}`);
      }
      if (stack === 'node') assert.equal(JSON.parse(read(dir, 'package.json')).name, name);

      for (const [k, v] of [['pull.ff', 'only'], ['fetch.prune', 'true'], ['push.autoSetupRemote', 'true'], ['rerere.enabled', 'true'], ['merge.conflictStyle', 'zdiff3']])
        assert.equal(await git(dir, 'config', '--local', '--get', k), v, k);
      assert.equal(await git(dir, 'rev-list', '--count', 'HEAD'), '1');
      assert.equal(await git(dir, 'symbolic-ref', '--short', 'HEAD'), 'main');
      assert.equal(await git(dir, 'status', '--porcelain'), '', 'nothing left uncommitted');
      assert.equal((await git(dir, 'remote')), '', 'no remote with --no-remote');

      const pj = JSON.parse(read(dir, '.proj.json'));
      assert.equal(pj.stack, stack);
      assert.ok(pj.managed['AGENTS.md'] && !pj.managed['README.md'], 'managed hashes cover starter files, not project-owned ones');
      assert.ok(JSON.parse(fs.readFileSync(path.join(home, 'repos.json'), 'utf8')).includes(dir), 'registered in PROJ_HOME');

      if (stack === 'node') {
        const t = await run('npm test', [], { cwd: dir, shell: true });
        assert.equal(t.code, 0, t.out + t.err);
      }
    });
  }

  test('refuses a non-empty directory and leaves it alone', async () => {
    const parent = tmpDir('new-');
    write(parent, 'busy/notes.txt', 'mine\n');
    const r = await proj(['new', 'busy', '--no-remote', '--dir', parent], { cwd: parent, home: path.join(parent, 'home') });
    assert.notEqual(r.code, 0);
    assert.match(r.err, /not empty/);
    assert.deepEqual(fs.readdirSync(path.join(parent, 'busy')), ['notes.txt']);
    assert.equal(read(parent, 'busy/notes.txt'), 'mine\n');
  });

  test('--dry-run writes nothing; bad names are refused', async () => {
    const parent = tmpDir('new-');
    const home = path.join(parent, 'home');
    const r = await proj(['new', 'dry', '--no-remote', '--dry-run', '--dir', parent], { cwd: parent, home });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /would create/);
    assert.ok(!exists(parent, 'dry') && !exists(home));
    const bad = await proj(['new', '../escape', '--no-remote', '--dir', parent], { cwd: parent, home });
    assert.notEqual(bad.code, 0);
    assert.ok(!exists(parent, '..', 'escape'));
  });
});
