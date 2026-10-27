// Safety regressions: never clobber an existing project, never rewrite corrupt state, never orphan commits or secrets,
// never exceed the task cap under concurrency.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, git, gitTry, proj, write, read, tmpDir, commitAll } from './helpers.js';

// Every file under dir (including .git) -> content, to prove a command changed nothing.
function snapshotDir(dir) {
  const res = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else res[path.relative(dir, p)] = fs.readFileSync(p).toString('base64');
    }
  };
  walk(dir);
  return res;
}

describe('safety regressions', { concurrency: true }, () => {
  test('proj new refuses an existing git repo with .proj.json (no bootstrap marker) and changes nothing', async () => {
    const parent = tmpDir('new-');
    const app = path.join(parent, 'app');
    const home = path.join(parent, 'home');
    await git(parent, 'init', '-q', '-b', 'main', app);
    write(app, '.proj.json', '{"maxAgents": 1}\n');
    write(app, 'src/index.js', 'export {};\n');
    await git(app, 'add', '-A');
    await git(app, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'mine');
    const before = snapshotDir(app);
    const r = await proj(['new', 'app', '--no-remote'], { cwd: parent, home });
    assert.notEqual(r.code, 0);
    assert.match(r.err, /exists and is not empty/);
    assert.deepEqual(snapshotDir(app), before);
    assert.equal(fs.existsSync(path.join(home, 'repos.json')), false, 'not registered');
  });

  test('a corrupt state.json makes commands fail and is left byte-identical', async () => {
    const repo = await makeRepo({ projJson: { checks: { full: 'node -e "1"' } } });
    assert.equal((await repo.proj(['task', 'one'])).code, 0);
    const file = path.join(repo.root, '.git', 'proj', 'state.json');
    const corrupt = Buffer.from('{"tasks": {"one": {"slug": "one", \n');
    fs.writeFileSync(file, corrupt);
    const st = await repo.proj(['status', '--offline']);
    assert.notEqual(st.code, 0);
    assert.match(st.err, /not valid JSON/);
    for (const args of [['task', 'two'], ['check', '--full'], ['status', '--json', '--offline']]) {
      assert.notEqual((await repo.proj(args)).code, 0, args.join(' '));
    }
    assert.equal((await repo.proj(['hook', 'session-start'], { cwd: repo.wt('one'), input: '{}' })).code, 0, 'hooks never fail the session');
    assert.deepEqual(fs.readFileSync(file), corrupt);
  });

  test('finish --abandon refuses a worktree on a detached HEAD holding a commit not on the branch', async () => {
    const repo = await makeRepo();
    assert.equal((await repo.proj(['task', 'det'])).code, 0);
    const w = repo.wt('det');
    await git(w, 'checkout', '-q', '--detach');
    write(w, 'orphan.txt', 'only here\n');
    const lost = await commitAll(w, 'detached work');
    const r = await repo.proj(['finish', 'det', '--abandon']);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /detached/);
    assert.ok(fs.existsSync(path.join(w, '.git')), 'worktree kept');
    assert.equal(await git(w, 'rev-parse', 'HEAD'), lost);
    assert.equal((await gitTry(repo.root, 'cat-file', '-e', `${lost}^{commit}`)).code, 0, 'commit still reachable');
    assert.equal(read(w, 'orphan.txt'), 'only here\n');
    assert.equal(repo.state().tasks.det.status, 'active');
  });

  test('finish --abandon refuses a worktree holding an ignored secret (.env)', async () => {
    const repo = await makeRepo();
    assert.equal((await repo.proj(['task', 'sec'])).code, 0);
    const w = repo.wt('sec');
    write(w, '.gitignore', '.env\n');
    await commitAll(w, 'ignore env');
    write(w, '.env', 'API_KEY=hunter2\n');
    const r = await repo.proj(['finish', 'sec', '--abandon']);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /ignored files that removal would delete: .*\.env/);
    assert.equal(read(w, '.env'), 'API_KEY=hunter2\n');
    assert.equal(repo.state().tasks.sec.status, 'active');
  });

  test('concurrent proj task x4 with maxAgents 2: exactly 2 succeed', async () => {
    const repo = await makeRepo({ projJson: { maxAgents: 2 } });
    const res = await Promise.all([0, 1, 2, 3].map((i) => repo.proj(['task', `c${i}`])));
    const ok = res.filter((r) => r.code === 0);
    assert.equal(ok.length, 2, res.map((r) => `${r.code}: ${r.err}`).join('\n'));
    for (const r of res.filter((x) => x.code !== 0)) assert.match(r.err, /tasks active/);
    const active = Object.values(repo.state().tasks).filter((t) => t.status === 'active');
    assert.equal(active.length, 2);
    assert.equal((await git(repo.root, 'branch', '--list', 'task/*')).split('\n').filter(Boolean).length, 2);
    assert.deepEqual(fs.readdirSync(path.join(repo.parent, 'repo.worktrees')).sort(), active.map((t) => t.slug).sort());
  });
});
