import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, git, gitTry, exists } from './helpers.js';

const hasBranch = async (repo, b) => (await gitTry(repo.root, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`)).code === 0;

describe('proj task', { concurrency: true }, () => {
  test('creates a locked worktree on task/<slug> from origin/main', async () => {
    const repo = await makeRepo();
    const r = await repo.proj(['task', 'alpha', '--goal', 'do it', '--issue', '3']);
    assert.equal(r.code, 0, r.err);
    assert.ok(exists(repo.wt('alpha'), 'README.md'));
    assert.equal(await git(repo.wt('alpha'), 'symbolic-ref', '--short', 'HEAD'), 'task/alpha');
    assert.equal(await git(repo.wt('alpha'), 'rev-parse', 'HEAD'), await git(repo.root, 'rev-parse', 'origin/main'));
    assert.match(await git(repo.root, 'worktree', 'list', '--porcelain'), /locked proj task alpha/);
    const t = repo.state().tasks.alpha;
    assert.equal(t.status, 'active');
    assert.equal(t.issue, 3);
    assert.equal(t.goal, 'do it');
    assert.ok(exists(repo.root, '.git', 'proj', 'handoffs', 'alpha.md'));
  });

  test('cap from .proj.json maxAgents refuses with exit 3', async () => {
    const repo = await makeRepo({ projJson: { maxAgents: 2 } });
    assert.equal((await repo.proj(['task', 'a'])).code, 0);
    assert.equal((await repo.proj(['task', 'b'])).code, 0);
    const r = await repo.proj(['task', 'c']);
    assert.equal(r.code, 3, r.err);
    assert.match(r.err, /2\/2 tasks active/);
    assert.ok(!exists(repo.wt('c')));
    assert.ok(!(await hasBranch(repo, 'task/c')));
    assert.equal(repo.state().tasks.c, undefined);
  });

  test('refuses a duplicate slug and a duplicate --issue', async () => {
    const repo = await makeRepo();
    assert.equal((await repo.proj(['task', 'a', '--issue', '7'])).code, 0);
    const dup = await repo.proj(['task', 'a']);
    assert.equal(dup.code, 1);
    assert.match(dup.err, /already active/);
    const issue = await repo.proj(['task', 'b', '--issue', '7']);
    assert.equal(issue.code, 1);
    assert.match(issue.err, /issue #7 already belongs to active task "a"/);
    assert.ok(!exists(repo.wt('b')));
    assert.ok(!(await hasBranch(repo, 'task/b')));
    const bad = await repo.proj(['task', 'Bad Slug']);
    assert.notEqual(bad.code, 0);
  });

  test('overlapping --files is refused unless --allow-overlap', async () => {
    const repo = await makeRepo();
    assert.equal((await repo.proj(['task', 'api', '--files', 'src/api/**'])).code, 0);
    const r = await repo.proj(['task', 'fix', '--files', 'src/api/routes.js']);
    assert.equal(r.code, 1);
    assert.match(r.err, /overlap active task\(s\): api/);
    assert.ok(!exists(repo.wt('fix')));
    const ok = await repo.proj(['task', 'fix', '--files', 'src/api/routes.js', '--allow-overlap']);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.err, /overlaps with api \(allowed\)/);
    const disjoint = await repo.proj(['task', 'docs', '--files', 'docs/**']);
    assert.equal(disjoint.code, 0, disjoint.err);
  });
});
