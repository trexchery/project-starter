// check / status / finish / clean
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, git, gitTry, proj, read, write, exists, commitAll } from './helpers.js';

const CHECKS = { checks: { full: 'node -e "process.exit(0)"', affected: 'node -e "process.exit(0)"' } };
const refs = (repo) => git(repo.root, 'for-each-ref', '--format=%(refname) %(objectname)');
const hasRef = async (cwd, ref) => (await gitTry(cwd, 'rev-parse', '--verify', '--quiet', ref)).code === 0;
const statusJson = async (repo, ...extra) => {
  const r = await repo.proj(['status', '--json', '--offline', ...extra]);
  assert.equal(r.code, 0, r.err);
  return Object.fromEntries(JSON.parse(r.out).map((x) => [x.slug, x]));
};

async function taskWithCommit(repo, slug) {
  assert.equal((await repo.proj(['task', slug])).code, 0);
  const w = repo.wt(slug);
  write(w, `${slug}.txt`, `${slug}\n`);
  return { w, sha: await commitAll(w, `feat ${slug}`) };
}

describe('check, status, finish, clean', { concurrency: true }, () => {
  test('check records results by SHA; a dirty-tree pass does not count as tested', async () => {
    const repo = await makeRepo({ projJson: CHECKS });
    const clean = await taskWithCommit(repo, 'clean');
    const r = await proj(['check', '--full'], { cwd: clean.w, home: repo.home });
    assert.equal(r.code, 0, r.out + r.err);
    const rec = repo.state().checks[clean.sha];
    assert.equal(rec.length, 1);
    assert.deepEqual([rec[0].kind, rec[0].exit, rec[0].dirty, rec[0].where], ['full', 0, false, 'local']);

    const dirty = await taskWithCommit(repo, 'dirty');
    write(dirty.w, 'dirty.txt', 'changed after commit\n');
    const d = await proj(['check', '--full'], { cwd: dirty.w, home: repo.home });
    assert.equal(d.code, 0, d.out + d.err);
    assert.match(d.out, /dirty tree: will not count/);
    assert.equal(repo.state().checks[dirty.sha][0].dirty, true);

    const st = await statusJson(repo);
    assert.equal(st.clean.tested, 'full');
    assert.equal(st.clean.sha, clean.sha);
    assert.equal(st.dirty.tested, 'no');
    assert.equal(st.dirty.dirty, 1);
    assert.equal(st.dirty.ci, 'unknown', 'offline never claims CI');

    // A new commit makes the old result irrelevant.
    write(clean.w, 'more.txt', 'more\n');
    await commitAll(clean.w, 'more');
    assert.equal((await statusJson(repo)).clean.tested, 'no');
  });

  test('a failing check exits non-zero and shows as FAILED', async () => {
    const repo = await makeRepo({ projJson: { checks: { full: 'node -e "process.exit(3)"' } } });
    const t = await taskWithCommit(repo, 'red');
    const r = await proj(['check', '--full'], { cwd: t.w, home: repo.home });
    assert.equal(r.code, 1);
    assert.equal(repo.state().checks[t.sha][0].exit, 3);
    assert.equal((await statusJson(repo)).red.tested, 'FAILED');
  });

  test('finish refuses a dirty worktree and refuses from inside the worktree', async () => {
    const repo = await makeRepo();
    const t = await taskWithCommit(repo, 'a');
    write(t.w, 'wip.txt', 'unfinished\n');
    const dirty = await repo.proj(['finish', 'a', '--abandon', '--yes']);
    assert.equal(dirty.code, 1);
    assert.match(dirty.err, /uncommitted changes/);
    assert.equal(read(t.w, 'wip.txt'), 'unfinished\n');

    fs.rmSync(path.join(t.w, 'wip.txt'));
    for (const args of [['finish', 'a', '--abandon', '--yes'], ['finish', '--abandon', '--yes']]) {
      const inside = await proj(args, { cwd: t.w, home: repo.home });
      assert.equal(inside.code, 1, args.join(' '));
      assert.match(inside.err, /outside the worktree/);
    }
    const sub = path.join(t.w, 'sub');
    fs.mkdirSync(sub);
    assert.equal((await proj(['finish', 'a', '--abandon', '--yes'], { cwd: sub, home: repo.home })).code, 1, 'a subdirectory is inside too');
    assert.ok(exists(t.w, 'a.txt'));
    assert.equal(repo.state().tasks.a.status, 'active');

    const noPr = await repo.proj(['finish', 'a']);
    assert.equal(noPr.code, 1);
    assert.match(noPr.err, /no PR for task\/a/);
    assert.ok(exists(t.w, 'a.txt'));
  });

  test('finish --abandon needs --yes, then keeps the branch and archives it', async () => {
    const repo = await makeRepo();
    const t = await taskWithCommit(repo, 'a');
    const no = await repo.proj(['finish', 'a', '--abandon']);
    assert.equal(no.code, 1);
    assert.match(no.err, /--yes/);
    assert.ok(exists(t.w, 'a.txt'));

    const r = await repo.proj(['finish', 'a', '--abandon', '--yes']);
    assert.equal(r.code, 0, r.err);
    assert.ok(!exists(t.w));
    assert.equal(await git(repo.root, 'rev-parse', 'refs/heads/task/a'), t.sha, 'branch kept at its tip');
    const archived = (await git(repo.root, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/proj-archive/task/a/')).split('\n');
    assert.equal(archived.length, 1);
    assert.ok(archived[0].endsWith(` ${t.sha}`));
    assert.equal(repo.state().tasks.a.status, 'abandoned');
    assert.doesNotMatch(await git(repo.root, 'worktree', 'list'), /repo\.worktrees/);
  });

  test('clean is a dry run by default; --apply deletes only provably merged, unused branches', async () => {
    // activeHours 0: branches proj did not create are otherwise protected while fresh
    const repo = await makeRepo({ projJson: { activeHours: 0 } });
    const R = repo.root;
    // merged-ff: fast-forwarded into main
    await git(R, 'switch', '-q', '-c', 'merged-ff');
    write(R, 'ff.txt', 'ff\n');
    const ffSha = await commitAll(R, 'ff');
    await git(R, 'switch', '-q', 'main');
    await git(R, 'merge', '-q', '--ff-only', 'merged-ff');
    // squashed: its content landed on main as a different commit
    await git(R, 'switch', '-q', '-c', 'task/squashed', 'HEAD');
    write(R, 'sq.txt', 'sq\n');
    const sqSha = await commitAll(R, 'sq on branch');
    await git(R, 'switch', '-q', 'main');
    write(R, 'sq.txt', 'sq\n');
    await commitAll(R, 'squash-merge sq');
    // unmerged: unique work
    await git(R, 'switch', '-q', '-c', 'unmerged');
    write(R, 'unique.txt', 'only here\n');
    const unSha = await commitAll(R, 'unique');
    await git(R, 'switch', '-q', 'main');
    await git(R, 'push', '-q', 'origin', 'main');
    // merged branch checked out in a dirty, non-proj worktree
    await git(R, 'branch', 'in-wt');
    const wt = path.join(repo.parent, 'other-wt');
    await git(R, 'worktree', 'add', '-q', wt, 'in-wt');
    write(wt, 'wip.txt', 'dirty work\n');
    // an active proj task whose branch is at main (merged by ancestry)
    assert.equal((await repo.proj(['task', 'live'])).code, 0);
    write(repo.wt('live'), 'live-wip.txt', 'live dirty\n');

    const before = await refs(repo);
    const dry = await repo.proj(['clean']);
    assert.equal(dry.code, 0, dry.err);
    assert.match(dry.out, /would: delete branch merged-ff \(merged\)/);
    assert.match(dry.out, /would: delete branch task\/squashed \(content already in base\)/);
    assert.match(dry.out, /Dry run/);
    assert.doesNotMatch(dry.out, /unmerged|in-wt|task\/live/);
    assert.equal(await refs(repo), before, 'dry run changes no ref');

    const r = await repo.proj(['clean', '--apply']);
    assert.equal(r.code, 0, r.err);
    assert.ok(!(await hasRef(R, 'refs/heads/merged-ff')));
    assert.ok(!(await hasRef(R, 'refs/heads/task/squashed')));
    for (const [b, sha] of [['merged-ff', ffSha], ['task/squashed', sqSha]]) {
      const a = await git(R, 'for-each-ref', '--format=%(objectname)', `refs/proj-archive/${b}/`);
      assert.equal(a, sha, `archive ref for ${b}`);
    }
    assert.equal(await git(R, 'rev-parse', 'refs/heads/unmerged'), unSha);
    assert.ok(await hasRef(R, 'refs/heads/in-wt'));
    assert.ok(await hasRef(R, 'refs/heads/task/live'));
    assert.equal(read(wt, 'wip.txt'), 'dirty work\n');
    assert.equal(read(repo.wt('live'), 'live-wip.txt'), 'live dirty\n');
    assert.equal(repo.state().tasks.live.status, 'active');

    const again = await repo.proj(['clean', '--apply']);
    assert.equal(again.code, 0);
    assert.match(again.out, /nothing to clean/);
  });

  test('clean keeps a diverged branch whose content is not on main', async () => {
    const repo = await makeRepo();
    const R = repo.root;
    await git(R, 'switch', '-q', '-c', 'feature');
    write(R, 'f.txt', 'f\n');
    const sha = await commitAll(R, 'f');
    await git(R, 'switch', '-q', 'main');
    write(R, 'other.txt', 'o\n');
    await commitAll(R, 'other');
    await git(R, 'push', '-q', 'origin', 'main');
    const r = await repo.proj(['clean', '--apply']);
    assert.equal(r.code, 0, r.err);
    assert.equal(await git(R, 'rev-parse', 'refs/heads/feature'), sha, 'diverged unmerged branch kept');
  });
});
