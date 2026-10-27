// checkpoint / resume --restore / hooks
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeRepo, git, gitTry, proj, read, write, exists, tmpDir, commitAll } from './helpers.js';

const REF = (slug) => `refs/proj/checkpoints/${slug}`;

async function taskRepo(slug = 'a') {
  const repo = await makeRepo({ files: { 'keep.txt': 'keep\n', 'gone.txt': 'gone\n' } });
  const r = await repo.proj(['task', slug, '--goal', 'test goal']);
  assert.equal(r.code, 0, r.err);
  return { ...repo, w: repo.wt(slug) };
}

describe('checkpoint, resume, hooks', { concurrency: true }, () => {
  test('checkpoint snapshots staged, unstaged and untracked work without touching the tree or index', async () => {
    const repo = await taskRepo();
    const w = repo.w;
    write(w, 'keep.txt', 'staged change\n');
    await git(w, 'add', 'keep.txt');
    write(w, 'README.md', '# unstaged change\n');
    write(w, 'new/untracked.txt', 'brand new\n');
    const before = [await git(w, 'status', '--porcelain=v1', '--untracked-files=all'), await git(w, 'ls-files', '-s'), await git(w, 'diff', '--cached')];
    const head = await git(w, 'rev-parse', 'HEAD');

    const r = await proj(['checkpoint', '--next', 'carry on'], { cwd: w, home: repo.home });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /uncommitted work saved to refs\/proj\/checkpoints\/a/);

    assert.deepEqual([await git(w, 'status', '--porcelain=v1', '--untracked-files=all'), await git(w, 'ls-files', '-s'), await git(w, 'diff', '--cached')], before);
    assert.equal(await git(w, 'rev-parse', 'HEAD'), head);
    assert.equal(read(w, 'README.md'), '# unstaged change\n');
    assert.equal(await git(repo.root, 'rev-parse', `${REF('a')}^`), head);
    assert.equal(await git(repo.root, 'show', `${REF('a')}:new/untracked.txt`), 'brand new');
    assert.equal(await git(repo.root, 'show', `${REF('a')}:keep.txt`), 'staged change');
    assert.equal(await git(repo.root, 'show', `${REF('a')}:README.md`), '# unstaged change');
    assert.equal(repo.state().tasks.a.next, 'carry on');
  });

  test('checkpoint of a clean tree makes no ref', async () => {
    const repo = await taskRepo();
    const r = await proj(['checkpoint'], { cwd: repo.w, home: repo.home });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /tree clean/);
    assert.notEqual((await gitTry(repo.root, 'rev-parse', '--verify', '--quiet', REF('a'))).code, 0);
  });

  test('resume --restore recreates a deleted worktree with its uncommitted and untracked files', async () => {
    const repo = await taskRepo();
    const w = repo.w;
    write(w, 'feature.txt', 'committed\n');
    const tip = await commitAll(w, 'feat');
    write(w, 'keep.txt', 'uncommitted edit\n');
    write(w, 'deep/dir/untracked.txt', 'untracked\n');
    assert.equal((await proj(['checkpoint'], { cwd: w, home: repo.home })).code, 0);
    fs.rmSync(w, { recursive: true, force: true });

    const peek = await repo.proj(['resume', 'a']);
    assert.equal(peek.code, 0, peek.err);
    assert.match(peek.out, /--restore/);
    assert.ok(!exists(w), 'plain resume does not recreate anything');

    const r = await repo.proj(['resume', 'a', '--restore']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /restored uncommitted work/);
    assert.equal(await git(w, 'rev-parse', 'HEAD'), tip);
    assert.equal(await git(w, 'symbolic-ref', '--short', 'HEAD'), 'task/a');
    assert.equal(read(w, 'keep.txt'), 'uncommitted edit\n');
    assert.equal(read(w, 'deep/dir/untracked.txt'), 'untracked\n');
    assert.equal(read(w, 'feature.txt'), 'committed\n');
    assert.equal(await git(w, 'diff', '--cached', '--name-only'), '', 'restored work is unstaged');
    const status = await git(w, 'status', '--porcelain=v1', '--untracked-files=all');
    assert.match(status, /^ M keep\.txt$/m);
    assert.match(status, /^\?\? deep\/dir\/untracked\.txt$/m);
    assert.match(await git(repo.root, 'worktree', 'list', '--porcelain'), /locked proj task a/);
  });

  test('resume --restore keeps an uncommitted deletion deleted', async () => {
    const repo = await taskRepo();
    fs.rmSync(`${repo.w}/gone.txt`);
    write(repo.w, 'keep.txt', 'edit\n');
    assert.equal((await proj(['checkpoint'], { cwd: repo.w, home: repo.home })).code, 0);
    assert.equal(await gitTry(repo.root, 'cat-file', '-e', `${REF('a')}:gone.txt`).then((r) => r.code), 128, 'snapshot records the deletion');
    fs.rmSync(repo.w, { recursive: true, force: true });
    assert.equal((await repo.proj(['resume', 'a', '--restore'])).code, 0);
    assert.ok(!exists(repo.w, 'gone.txt'), 'gone.txt was resurrected');
  });

  test('a checkpoint after a partial commit still lets --restore bring back the remaining work', async () => {
    const repo = await taskRepo();
    const w = repo.w;
    write(w, 'keep.txt', 'part one\n');
    write(w, 'README.md', '# part two\n');
    assert.equal((await proj(['checkpoint'], { cwd: w, home: repo.home })).code, 0);
    await git(w, 'add', 'keep.txt');
    await git(w, 'commit', '-q', '-m', 'part one');
    const cp = await proj(['checkpoint'], { cwd: w, home: repo.home });
    assert.match(cp.out, /uncommitted work saved/);
    assert.equal(await git(repo.root, 'rev-parse', `${REF('a')}^`), await git(w, 'rev-parse', 'HEAD'), 'snapshot parent is the current HEAD');
    fs.rmSync(w, { recursive: true, force: true });
    assert.equal((await repo.proj(['resume', 'a', '--restore'])).code, 0);
    assert.equal(read(w, 'README.md'), '# part two\n');
  });

  test('hook session-start prints handoff JSON inside a task worktree', async () => {
    const repo = await taskRepo();
    const r = await proj(['hook', 'session-start'], { cwd: repo.w, home: repo.home, input: JSON.stringify({ cwd: repo.w, session_id: 's-1' }) });
    assert.equal(r.code, 0, r.err);
    const j = JSON.parse(r.out);
    assert.equal(j.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(j.hookSpecificOutput.additionalContext, /# Handoff: a/);
    assert.match(j.hookSpecificOutput.additionalContext, /Goal: test goal/);
    assert.equal(repo.state().tasks.a.owner, 's-1');

    const main = await proj(['hook', 'session-start'], { cwd: repo.root, home: repo.home, input: '{}' });
    assert.equal(main.code, 0);
    assert.match(JSON.parse(main.out).hookSpecificOutput.additionalContext, /1\/3 tasks active \(a -> /);
  });

  test('hook session-start is silent outside a repo and exits 0 on garbage stdin', async () => {
    const plain = tmpDir('plain-');
    const home = tmpDir('home-');
    const out = await proj(['hook', 'session-start'], { cwd: plain, home, input: '{}' });
    assert.equal(out.code, 0, out.err);
    assert.equal(out.out, '');
    const repo = await taskRepo();
    for (const input of ['not json {{', '\x00\xff garbage', 'null', '[1,2]', JSON.stringify({ cwd: 'Z:\\does\\not\\exist' })]) {
      const r = await proj(['hook', 'session-start'], { cwd: repo.w, home: repo.home, input });
      assert.equal(r.code, 0, `input ${JSON.stringify(input)}: ${r.err}`);
      if (r.out) assert.ok(JSON.parse(r.out).hookSpecificOutput, `valid JSON for ${JSON.stringify(input)}`);
    }
    for (const ev of ['pre-compact', 'session-end', 'bogus', '']) {
      const r = await proj(['hook', ev], { cwd: plain, home, input: 'garbage' });
      assert.equal(r.code, 0, `hook ${ev}`);
    }
  });

  test('hook pre-compact checkpoints dirty work', async () => {
    const repo = await taskRepo();
    write(repo.w, 'wip.txt', 'work in progress\n');
    const r = await proj(['hook', 'pre-compact'], { cwd: repo.w, home: repo.home, input: JSON.stringify({ cwd: repo.w }) });
    assert.equal(r.code, 0, r.err);
    assert.equal(await git(repo.root, 'show', `${REF('a')}:wip.txt`), 'work in progress');
    assert.ok(exists(repo.w, 'wip.txt'));
  });
});
