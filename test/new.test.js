import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { proj, git, run, tmpDir, exists, read, write } from './helpers.js';

const placeholders = (text) => text.replace(/\$\{\{[\s\S]*?\}\}/g, '').match(/\{\{\s*\w+\s*\}\}/g) || [];

const SKELETON = { node: 'test/index.test.js', typescript: 'test/index.test.ts', python: 'tests/test_hello.py', go: 'hello_test.go', rust: 'src/lib.rs', dotnet: 'Demo-dotnet.sln' };
// Why the stack's real test cannot run here, or '' when it can.
async function toolchainMissing(stack) {
  if (stack === 'python') return (await run('python', ['-m', 'pytest', '--version'])).code === 0 ? '' : 'python with pytest is not installed here';
  const tool = { node: 'npm', typescript: 'npm', go: 'go', rust: 'cargo', dotnet: 'dotnet' }[stack];
  const probe = tool === 'go' ? 'version' : '--version';
  const ok = await run(tool, [probe], { shell: process.platform === 'win32' && tool === 'npm' }).then((r) => r.code === 0, () => false);
  if (!ok) return `\`${tool} ${probe}\` fails here (not installed, or no toolchain): the ${stack} skeleton test was NOT run`;
  if (stack === 'dotnet' && !fs.existsSync(path.join(process.env.NUGET_PACKAGES || path.join(os.homedir(), '.nuget', 'packages'), 'xunit', '2.9.2')))
    return 'xunit 2.9.2 is not in the local NuGet cache (restoring it needs the network): the dotnet skeleton test was NOT run';
  return '';
}

describe('proj new', { concurrency: true }, () => {
  for (const stack of ['node', 'typescript', 'python', 'go', 'rust', 'dotnet', 'generic']) {
    test(`--no-remote renders the ${stack} stack, configures git, makes one commit`, async (t) => {
      const parent = tmpDir('new-');
      const home = path.join(parent, 'home');
      const name = `Demo-${stack}`;
      const r = await proj(['new', name, '--no-remote', '--stack', stack, '--dir', parent, '--description', 'a test project'], { cwd: parent, home });
      assert.equal(r.code, 0, r.err);
      const dir = path.join(parent, name);

      const files = (await git(dir, 'ls-files')).split(/\r?\n/);
      for (const f of ['AGENTS.md', 'CLAUDE.md', '.proj.json', '.gitignore', '.gitattributes', '.github/workflows/ci.yml', '.claude/settings.json'])
        assert.ok(files.includes(f), `${f} committed`);
      if (SKELETON[stack]) assert.ok(files.includes(SKELETON[stack]), `${SKELETON[stack]} rendered`);
      if (stack === 'python') assert.ok(files.includes(`src/demo_python/__init__.py`), 'module dir rendered from {{module}}');
      if (stack === 'dotnet') assert.ok(files.includes('tests/demo_dotnet.Tests/demo_dotnet.Tests.csproj'), 'project dirs rendered from {{module}}');
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

      // The skeleton's own test passes with the real toolchain, when this machine has it (never downloads anything).
      if (stack === 'generic') return; // no skeleton test: its fail-closed check is tested in bootstrap.test.js
      const why = await toolchainMissing(stack);
      if (why) return t.skip(why);
      const [cmd, ...args] = JSON.parse(read(dir, '.proj.json')).test.split(' ');
      const res = await run(cmd, args, { cwd: dir, shell: process.platform === 'win32' && cmd === 'npm' });
      assert.equal(res.code, 0, res.out + res.err);
      assert.match(res.out, /\b(pass 1|1 passed|Passed:\s+1|test result: ok\. 1 passed|ok\s)/, 'one real test ran');
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
