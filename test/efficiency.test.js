// CI-efficiency features: test selection, per-SHA dedup, junit profiles, Actions cost analysis, bench, templates.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeRepo, git, write, tmpDir, ROOT } from './helpers.js';
import { selectTests, priorPass } from '../lib/checks.js';
import { parseJunit, withJunit, readJunit, localReport, analyzeRuns, workflowTimeouts, opportunities, estimate, recommend, multiplier } from '../lib/perf.js';

// A check command that proves it ran: appends one byte to $PROJ_TEST_COUNTER (a file outside the repo).
const COUNT = `node -e "require('fs').appendFileSync(process.env.PROJ_TEST_COUNTER,'x')"`;
const counter = () => path.join(tmpDir('cnt-'), 'runs.txt');
const runsOf = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').length : 0);
const lines = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('selectTests (fail-closed change-aware tier)', { concurrency: true }, () => {
  const cfg = { testGlobs: ['test/**/*.test.js'] };
  const tracked = ['src/foo.js', 'src/bar.js', 'src/lonely.js', 'test/foo.test.js', 'test/bar.test.js', 'test/helpers.js', 'test/fixtures/data.json', 'README.md'];

  test('none when nothing or only docs changed', () => {
    assert.equal(selectTests(cfg, tracked, []).mode, 'none');
    assert.equal(selectTests(cfg, tracked, ['README.md', 'docs/guide.md', 'docs/img/logo.png', 'CHANGELOG.md']).mode, 'none');
    // assets, fixtures and text files outside docs may be read by code or tests: fail closed
    for (const f of ['img/logo.png', 'src/templates/mail.txt', 'tests/fixtures/golden.txt']) assert.equal(selectTests(cfg, tracked, [f]).mode, 'full', f);
  });

  test('full for global-impact files, even next to a mapped source change', () => {
    for (const f of ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'npm-shrinkwrap.json', '.github/workflows/ci.yml',
      '.github/dependabot.yml', '.proj.json', 'conftest.py', 'tests/unit/conftest.py', 'pyproject.toml', 'uv.lock']) {
      const sel = selectTests(cfg, tracked, ['src/foo.js', f]);
      assert.equal(sel.mode, 'full', f);
      assert.match(sel.reason, /can affect every test/, f);
    }
  });

  test('full when requirements*.txt changes', () => {
    assert.equal(selectTests(cfg, tracked, ['requirements.txt']).mode, 'full');
    assert.equal(selectTests(cfg, tracked, ['src/foo.js', 'requirements-dev.txt']).mode, 'full');
  });

  test('full when a changed source file maps to no test', () => {
    const sel = selectTests(cfg, tracked, ['src/foo.js', 'src/lonely.js']);
    assert.deepEqual([sel.mode, sel.reason], ['full', 'no test maps to src/lonely.js']);
    assert.equal(selectTests(cfg, tracked, ['src/a.js']).mode, 'full', 'one-letter stems never map');
  });

  test('full when a non-test file under a test root changes (helper or fixture)', () => {
    for (const f of ['test/helpers.js', 'test/fixtures/data.json']) {
      const sel = selectTests(cfg, tracked, ['test/foo.test.js', f]);
      assert.equal(sel.mode, 'full', f);
      assert.match(sel.reason, /shared test helper or fixture/);
    }
  });

  test('full when testGlobs is empty or missing', () => {
    assert.equal(selectTests({ testGlobs: [] }, tracked, ['src/foo.js']).mode, 'full');
    assert.equal(selectTests({}, tracked, ['src/foo.js']).mode, 'full');
  });

  test('affected with exactly the mapped tests plus changed tests', () => {
    assert.deepEqual(selectTests(cfg, tracked, ['src/foo.js', 'README.md']), { mode: 'affected', tests: ['test/foo.test.js'] });
    const sel = selectTests(cfg, tracked, ['src/foo.js', 'test/bar.test.js']);
    assert.equal(sel.mode, 'affected');
    assert.deepEqual(sel.tests.sort(), ['test/bar.test.js', 'test/foo.test.js']);
    const py = selectTests({ testGlobs: ['tests/test_*.py'] }, ['pkg/util.py', 'tests/test_util.py', 'tests/test_other.py'], ['pkg/util.py']);
    assert.deepEqual(py, { mode: 'affected', tests: ['tests/test_util.py'] });
  });
});

describe('per-SHA duplicate prevention', { concurrency: true }, () => {
  test('priorPass: clean passes only; full covers affected, not the reverse', () => {
    const st = { checks: { s: [{ kind: 'full', exit: 1, dirty: false }, { kind: 'affected', exit: 0, dirty: false }, { kind: 'heavy', exit: 0, dirty: true }] } };
    assert.equal(priorPass(st, 's', 'full'), null);
    assert.equal(priorPass(st, 's', 'affected').kind, 'affected');
    assert.equal(priorPass(st, 's', 'heavy'), null, 'a dirty pass never counts');
    st.checks.s.push({ kind: 'full', exit: 0, dirty: false });
    assert.equal(priorPass(st, 's', 'full').kind, 'full');
    assert.equal(priorPass(st, 'other', 'full'), null);
  });

  test('second check at a clean SHA is skipped; --again reruns; full satisfies affected; a dirty tree always runs', async () => {
    const cnt = counter();
    const repo = await makeRepo({ projJson: { checks: { full: COUNT, affected: COUNT } } });
    const p = (...args) => repo.proj(['check', ...args], { env: { PROJ_TEST_COUNTER: cnt } });

    let r = await p('--full');
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(runsOf(cnt), 1);
    r = await p('--full');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /already passed/);
    assert.equal(runsOf(cnt), 1, 'the command did not run again');
    r = await p('--full', '--again');
    assert.equal(r.code, 0, r.err);
    assert.equal(runsOf(cnt), 2);
    r = await p();
    assert.match(r.out, /affected: already passed .*\(full,/);
    assert.equal(runsOf(cnt), 2, 'a prior full pass satisfies the affected tier');

    write(repo.root, 'scratch.txt', 'untracked\n');
    for (const n of [3, 4]) {
      r = await p('--full');
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /dirty tree: will not count/);
      assert.equal(runsOf(cnt), n);
    }
  });

  test('a command that modifies a tracked file while running is recorded dirty and never reused', async () => {
    const cnt = counter();
    const touch = `node -e "const f=require('fs');f.appendFileSync(process.env.PROJ_TEST_COUNTER,'x');f.appendFileSync('README.md','x')"`;
    const repo = await makeRepo({ projJson: { checks: { full: touch } } });
    const sha = await git(repo.root, 'rev-parse', 'HEAD');
    const r = await repo.proj(['check', '--full'], { env: { PROJ_TEST_COUNTER: cnt } });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /not counted for the SHA/);
    const rec = repo.state().checks[sha];
    assert.deepEqual([rec.length, rec[0].exit, rec[0].dirty], [1, 0, true]);
    await git(repo.root, 'checkout', '--', 'README.md');
    const again = await repo.proj(['check', '--full'], { env: { PROJ_TEST_COUNTER: cnt } });
    assert.doesNotMatch(again.out, /already passed/);
    assert.equal(runsOf(cnt), 2);
  });
});

describe('perf: junit profiles and local report', { concurrency: true }, () => {
  test('parseJunit: node-style absolute file attrs, root stripped, Windows backslashes, times summed', () => {
    const xml = `<?xml version="1.0"?><testsuites>
      <testcase name="a" time="0.25" classname="test" file="C:\\Work\\Repo\\test\\a.test.js"/>
      <testcase name="b" time="0.5" classname="test" file="c:\\work\\repo\\test\\a.test.js"/>
      <testsuite name="s"><testcase name="c" time="1" classname="test" file="C:\\Work\\Repo\\test\\sub\\b.test.js"></testcase></testsuite>
      <testcase name="d" time="2" file="/elsewhere/x.test.js"/></testsuites>`;
    const r = parseJunit(xml, 'C:\\Work\\Repo');
    assert.equal(r.tests, 4);
    assert.deepEqual(r.files, { 'test/a.test.js': 0.75, 'test/sub/b.test.js': 1, '/elsewhere/x.test.js': 2 });
    assert.deepEqual(parseJunit('<testcase name="x" time="1" file="/home/u/repo/t/x.test.js"/>', '/home/u/repo/').files, { 't/x.test.js': 1 });
  });

  test('parseJunit: pytest classname maps to a path', () => {
    const xml = `<testsuites><testsuite name="pytest" tests="3">
      <testcase classname="tests.test_api" name="test_get" time="0.4" />
      <testcase classname="tests.test_api" name="test_put" time="0.1" />
      <testcase classname="tests.unit.test_db" name="test_x" time="2.0"><failure message="boom">x</failure></testcase>
    </testsuite></testsuites>`;
    const r = parseJunit(xml);
    assert.equal(r.tests, 3);
    assert.deepEqual(r.files, { 'tests/test_api.py': 0.5, 'tests/unit/test_db.py': 2 });
  });

  test('withJunit / readJunit round trip removes the temp file', () => {
    assert.deepEqual(withJunit('npm test'), { cmd: 'npm test', file: null });
    assert.equal(readJunit(null, '/x'), null);
    const { cmd, file } = withJunit('run --a={junit} --b={junit}');
    assert.equal(path.dirname(file), os.tmpdir());
    assert.equal(cmd, `run --a="${file}" --b="${file}"`);
    const root = path.join(os.tmpdir(), 'some-repo');
    fs.writeFileSync(file, `<testcase name="t" time="0.3" file="${path.join(root, 'test', 'x.test.js')}"/>`);
    assert.deepEqual(readJunit(file, root), { files: { 'test/x.test.js': 0.3 }, tests: 1 });
    assert.equal(fs.existsSync(file), false);
  });

  test('a real node project: check --full writes per-file timings and the test count to profile.jsonl', async () => {
    const repo = await makeRepo({
      files: {
        'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }),
        'test/a.test.js': "import test from 'node:test';\ntest('a1', () => {});\ntest('a2', () => {});\n",
        'test/b.test.js': "import test from 'node:test';\ntest('b1', () => {});\n",
      },
      projJson: { checks: { full: 'node --test --test-reporter=junit --test-reporter-destination={junit}' }, testGlobs: ['test/**/*.test.js'] },
    });
    const r = await repo.proj(['check', '--full']);
    assert.equal(r.code, 0, r.out + r.err);
    const prof = lines(path.join(repo.root, '.git', 'proj', 'profile.jsonl'));
    assert.equal(prof.length, 1);
    const e = prof[0];
    assert.deepEqual([e.kind, e.exit, e.where, e.tests], ['full', 0, 'local', 3]);
    assert.deepEqual(Object.keys(e.files).sort(), ['test/a.test.js', 'test/b.test.js']);
    assert.ok(Object.values(e.files).every((s) => typeof s === 'number' && s >= 0));
  });

  test('localReport flags a file slower than 1.5x its recent median', () => {
    const full = (a, b) => ({ kind: 'full', secs: 10, files: { 'test/a.test.js': a, 'test/b.test.js': b } });
    const rep = localReport([full(1, 0.2), full(1.1, 0.2), full(0.9, 0.2), { kind: 'affected', secs: 2 }, full(3, 0.3)]);
    assert.deepEqual(rep.regressions, [{ file: 'test/a.test.js', secs: 3, base: 1 }]);
    assert.equal(rep.slowest[0][0], 'test/a.test.js');
    assert.deepEqual(rep.kinds.affected, { runs: 1, median: 2, p95: 2 });
    assert.deepEqual(localReport([full(1, 1), full(5, 5)]).regressions, [], 'one data point is not a baseline');
  });
});

describe('perf: GitHub Actions cost analysis', { concurrency: true }, () => {
  const T0 = Date.parse('2026-01-01T00:00:00Z');
  const at = (s) => new Date(T0 + s * 1000).toISOString();
  const TEST_STEP = { name: 'Run npm test', conclusion: 'success', started_at: at(0), completed_at: at(5) };
  const job = (secs, o = {}) => ({ name: 'verify', conclusion: 'success', labels: ['ubuntu-latest'], runner_name: 'GitHub Actions 1', started_at: at(0), completed_at: at(secs), steps: [TEST_STEP], ...o });
  const runOf = (id, sha, jobs, o = {}) => ({ id, name: 'CI', head_sha: sha, event: 'pull_request', conclusion: 'success', run_started_at: at(0), updated_at: at(100), jobs, ...o });

  test('billed minutes round up per job, with runner multipliers; skipped and unfinished jobs ignored', () => {
    const a = analyzeRuns([runOf(1, 's1', [
      job(61), // 2 x1
      job(90, { name: 'win', labels: ['windows-latest'] }), // 2 x2
      job(30, { name: 'mac', labels: ['macos-14'] }), // 1 x10
      job(600, { name: 'self', labels: ['self-hosted', 'proj-ephemeral'] }), // 0
      job(600, { name: 'eph', labels: ['linux'], runner_name: 'proj-docker-box-1' }), // 0
      job(300, { name: 'skip', conclusion: 'skipped' }),
      job(300, { name: 'running', completed_at: null }),
    ])]);
    assert.equal(a.jobs, 5);
    assert.equal(a.totalBilled, 2 + 4 + 10);
    assert.deepEqual([multiplier(['ubuntu-24.04']), multiplier(['Windows-2022']), multiplier(['macos-latest']), multiplier(['self-hosted'])], [1, 2, 10, 0]);
  });

  test('duplicate full runs for one SHA are counted with wasted minutes; a reused run is not a duplicate', () => {
    const reused = job(20, { steps: [
      { name: 'Set up job', conclusion: 'success' },
      { name: 'Reuse a passing result for this exact SHA', conclusion: 'success' },
      { name: 'Run actions/checkout@v7', conclusion: 'skipped' },
      { name: 'Record the exact SHA under test', conclusion: 'skipped' },
      { name: 'Run npm test', conclusion: 'skipped' },
    ] });
    const a = analyzeRuns([runOf(3, 'dup', [job(130)]), runOf(2, 'dup', [job(61)]), runOf(1, 'dup', [reused]), runOf(4, 'other', [job(50)])]);
    assert.deepEqual(a.duplicates, [{ key: 'CI/verify@dup', runs: 2, wasted: 2 }]);
    const only = analyzeRuns([runOf(2, 'r', [job(61)]), runOf(1, 'r', [reused])]);
    assert.deepEqual(only.duplicates, [], 'a reuse hit ran no tests');
    const ops = opportunities(a, {}, null);
    assert.match(ops.find((o) => o.minutes === 2).what, /ran its full tests 2x for one SHA/);
  });

  test('cancelled minutes are summed; a slowdown of recent runs is a regression', () => {
    const c = analyzeRuns([runOf(1, 'a', [job(125, { conclusion: 'cancelled' })]), runOf(2, 'b', [job(10, { conclusion: 'cancelled' })])]);
    assert.equal(c.cancelled, 4);
    // API order is newest first: 5 recent runs at 200 s, 5 older at 100 s.
    const runs = Array.from({ length: 10 }, (_, i) => runOf(i, `s${i}`, [job(i < 5 ? 200 : 100)]));
    const st = analyzeRuns(runs).jobStats.find((j) => j.job === 'CI/verify');
    assert.deepEqual(st.regression, { now: 200, before: 100 });
    const flat = analyzeRuns(Array.from({ length: 10 }, (_, i) => runOf(i, `s${i}`, [job(100)]))).jobStats[0];
    assert.equal(flat.regression, null);
    assert.ok(opportunities(analyzeRuns(runs), {}, null).some((o) => /slowed from 100s to 200s/.test(o.what)));
  });

  test('workflowTimeouts parses the shipped templates; a small p95 suggests a lower timeout', () => {
    for (const stack of ['node', 'python', 'generic']) {
      const t = workflowTimeouts(path.join(ROOT, 'template', 'stacks', stack));
      assert.equal(t['CI/verify'], 15, stack);
      assert.equal(t['Heavy/heavy'], 30, stack);
    }
    const timeouts = workflowTimeouts(path.join(ROOT, 'template', 'stacks', 'node'));
    const fast = analyzeRuns([runOf(1, 'a', [job(60)])]);
    const hint = opportunities(fast, timeouts, null).find((o) => o.what.startsWith('CI/verify: timeout 15 min'));
    assert.ok(hint, 'suggests a lower timeout');
    assert.match(hint.fix, /timeout-minutes: 5\b/);
    const slow = analyzeRuns([runOf(1, 'a', [job(400)])]);
    assert.equal(opportunities(slow, timeouts, null).filter((o) => /timeout/.test(o.what)).length, 0);
    assert.deepEqual(workflowTimeouts(tmpDir('nowf-')), {});
  });
});

describe('bench: estimate and recommend', { concurrency: true }, () => {
  test('estimate: wall is setup + slowest shard; billed is the sum of per-shard rounded minutes', () => {
    assert.deepEqual(estimate([30, 50], 45), { wall: 95, billed: 2 + 2 });
    assert.deepEqual(estimate([10, 10, 10, 10], 45), { wall: 55, billed: 4 });
    assert.deepEqual(estimate([60], 0), { wall: 60, billed: 1 });
    assert.deepEqual(estimate([61], 0), { wall: 61, billed: 2 });
  });

  test('recommend never picks a failing variant, one that lost tests, or one that costs too many extra minutes', () => {
    const base = { name: 'baseline', baseline: true, ok: true, tests: 10, wall: 100, billed: 2 };
    const failing = { name: 'failing', ok: false, tests: 10, wall: 5, billed: 1 };
    const fewer = { name: 'fewer', ok: true, tests: 9, wall: 10, billed: 1 };
    const costly = { name: 'costly', ok: true, tests: 10, wall: 20, billed: 3 };
    const good = { name: 'good', ok: true, tests: 10, wall: 60, billed: 2 };
    assert.equal(recommend([base, failing, fewer, costly, good]).name, 'good');
    assert.equal(recommend([base, failing, fewer, costly]).name, 'baseline');
    assert.equal(recommend([base, costly], 0.5).name, 'costly', 'within maxExtra');
    assert.equal(recommend([{ ...base, ok: false }, failing]), null);
  });

  test('CLI: proj bench picks the faster passing variant with proven equal coverage and appends bench.jsonl', async () => {
    const J = '--test-reporter=junit --test-reporter-destination={junit}';
    const slow = "import { test } from 'node:test';\ntest('t', () => new Promise((r) => setTimeout(r, 700)));\n";
    const repo = await makeRepo({ files: { 'test/a.test.js': slow, 'test/b.test.js': slow, 'package.json': '{"type":"module"}' }, projJson: {
      checks: { full: `node --test --test-concurrency=1 ${J}` },
      bench: { variants: {
        fast: `node --test --test-concurrency=2 ${J}`,         // same 2 tests, in parallel
        lossy: `node --test ${J} test/a.test.js`,               // faster but drops a test: never recommended
        unproven: 'node -e "1"',                                // no junit: coverage unknown, never recommended
        broken: 'node -e "process.exit(1)"',
      } },
    } });
    const r = await repo.proj(['bench', '--runs', '1', '--setup', '0']);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /Measured winner: fast/);
    const [rec] = lines(path.join(repo.root, '.git', 'proj', 'bench.jsonl'));
    assert.equal(rec.best, 'fast');
    assert.equal(rec.setupSecs, 0);
    assert.deepEqual(rec.results.map((x) => [x.name, x.ok, x.tests]), [['baseline', true, 2], ['fast', true, 2], ['lossy', true, 1], ['unproven', true, null], ['broken', false, null]]);
    assert.equal(rec.sha, await git(repo.root, 'rev-parse', 'HEAD'));
  });

  test('CLI: proj bench works in a repo proj has never written state for', async () => {
    const repo = await makeRepo({ projJson: { checks: { full: 'node -e "1"' } } });
    const r = await repo.proj(['bench', '--runs', '1', '--setup', '0']);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(lines(path.join(repo.root, '.git', 'proj', 'bench.jsonl')).length, 1);
  });

  test('CLI: bench.setupSecs 0 in .proj.json is honoured', async () => {
    const repo = await makeRepo({ projJson: { checks: { full: 'node -e "1"' }, bench: { setupSecs: 0 } } });
    fs.mkdirSync(path.join(repo.root, '.git', 'proj'), { recursive: true });
    const r = await repo.proj(['bench', '--runs', '1']);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(lines(path.join(repo.root, '.git', 'proj', 'bench.jsonl'))[0].setupSecs, 0);
  });
});

describe('runner', { concurrency: true }, () => {
  test('runner start refuses a non-GitHub origin and touches nothing', async () => {
    const repo = await makeRepo();
    for (const mode of ['--docker', '--host', '--remote']) {
      const r = await repo.proj(['runner', 'start', mode]);
      assert.notEqual(r.code, 0, mode);
      assert.match(r.err, /origin is not a GitHub repository/);
    }
    await git(repo.root, 'remote', 'set-url', 'origin', 'https://github.com/acme/widget.git');
    const off = await repo.proj(['runner', 'start', '--docker']);
    assert.notEqual(off.code, 0);
    assert.match(off.err, /cannot read the repository/);
    assert.equal(fs.existsSync(path.join(repo.root, '.git', 'proj')), false);
    assert.equal(fs.existsSync(path.join(repo.home, 'runners')), false);
    assert.equal(await git(repo.root, 'status', '--porcelain'), '');
  });
});

describe('CI templates (static)', { concurrency: true }, () => {
  const STACKS = fs.readdirSync(path.join(ROOT, 'template', 'stacks'));
  const wf = (stack, f) => fs.readFileSync(path.join(ROOT, 'template', 'stacks', stack, '.github', 'workflows', f), 'utf8').replace(/\r\n/g, '\n');
  const topKeys = (text, key) => { const m = text.match(new RegExp(`^${key}:\\n((?: .*\\n|\\n)*)`, 'm')); return m ? [...m[1].matchAll(/^ {2}([\w-]+):/gm)].map((x) => x[1]) : []; };
  const steps = (text) => text.split(/\n {4}steps:\n/)[1].split(/\n(?= {6}- )/);

  for (const stack of STACKS) for (const file of ['ci.yml', 'heavy.yml']) {
    test(`${stack}/${file}: job-level concurrency, reuse-gated steps, safe runs-on and checkout, no cache`, () => {
      const text = wf(stack, file);
      assert.doesNotMatch(text, /^concurrency:/m, 'no workflow-level concurrency');
      assert.match(text, /^ {4}concurrency:\n {6}group: /m);
      const list = steps(text);
      const reuse = list.findIndex((s) => /\n\s+id: reuse\b/.test(s));
      assert.ok(reuse >= 0, 'has the reuse step');
      assert.ok(list.length > reuse + 1);
      for (const s of list.slice(reuse + 1)) assert.match(s, /\n {8}if: .*steps\.reuse\.outputs\.hit != 'true'/, s.split('\n')[0]);
      const runsOn = text.match(/^ {4}runs-on: (.*)$/m)[1];
      assert.match(runsOn, /!endsWith\(github\.event\.pull_request\.user\.login, '\[bot\]'\)/, 'no bot-authored PR on self-hosted');
      assert.match(runsOn, /!startsWith\(github\.ref_name, 'dependabot\/'\)/, 'no dispatch of bot branches on self-hosted');
      assert.match(runsOn, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
      const co = list.find((s) => /uses: actions\/checkout@/.test(s));
      assert.match(co, /persist-credentials: false/);
      assert.match(co, file === 'ci.yml' ? /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/ : /ref: \$\{\{ inputs\.sha \}\}/);
      assert.doesNotMatch(text, /^\s*(- )?cache(-dependency-path)?:/m, 'caching must be benchmarked first');
      assert.doesNotMatch(text, /actions\/cache@/);
    });
  }

  for (const stack of STACKS) {
    test(`${stack}: ci.yml skips drafts and runs on ready_for_review; heavy.yml is dispatch-only per SHA`, () => {
      const ci = wf(stack, 'ci.yml');
      assert.match(ci, /^ {2}verify:\n {4}if: .*github\.event\.pull_request\.draft == false/m);
      assert.match(ci.match(/^ {4}types: \[(.*)\]$/m)[1], /\bready_for_review\b/);
      const heavy = wf(stack, 'heavy.yml');
      assert.deepEqual(topKeys(heavy, 'on'), ['workflow_dispatch']);
      assert.match(heavy.match(/^run-name: (.*)$/m)[1], /\$\{\{ inputs\.sha \}\}/);
    });
  }
});

describe('CI verdict for an exact SHA', () => {
  const run = (id, conclusion, extra = {}) => ({ id, head_sha: 'abc', status: 'completed', conclusion, run_started_at: '2026-10-27T10:00:00Z', html_url: `u${id}`, ...extra });
  test('a draft-stage skip with a higher id does not hide the real success', async () => {
    const { verdict } = await import('../lib/tasks.js');
    assert.equal(verdict([run(1, 'success'), run(2, 'skipped')], 'abc').state, 'verified');
  });
  test('skipped alone is never verified; cancelled and failure are reported as such', async () => {
    const { verdict } = await import('../lib/tasks.js');
    assert.equal(verdict([run(2, 'skipped')], 'abc').state, 'skipped');
    assert.equal(verdict([run(1, 'success'), run(3, 'failure')], 'abc').state, 'failure');
    assert.equal(verdict([run(4, 'cancelled')], 'abc').state, 'cancelled');
  });
  test('other SHAs never count; since drops only older skipped runs; in-progress is pending', async () => {
    const { verdict } = await import('../lib/tasks.js');
    assert.equal(verdict([run(1, 'success', { head_sha: 'zzz' })], 'abc').state, 'none');
    assert.equal(verdict([run(2, 'skipped', { run_started_at: '2026-10-27T09:00:00Z' })], 'abc', '2026-10-27T09:30:00Z').state, 'none');
    assert.equal(verdict([run(3, 'success', { run_started_at: '2026-10-27T09:00:00Z' })], 'abc', '2026-10-27T09:30:00Z').state, 'verified');
    assert.equal(verdict([run(5, null, { status: 'in_progress' })], 'abc').state, 'pending');
  });
});

test('analyzeRuns: Dependabot update jobs (event dynamic) bill nothing', async () => {
  const { analyzeRuns } = await import('../lib/perf.js');
  const job = { name: 'Dependabot', conclusion: 'success', started_at: '2026-10-27T10:00:00Z', completed_at: '2026-10-27T10:03:00Z', labels: ['ubuntu-latest'], steps: [] };
  assert.equal(analyzeRuns([{ id: 1, name: 'npm_and_yarn', event: 'dynamic', head_sha: 'a', jobs: [job] }]).totalBilled, 0);
  assert.equal(analyzeRuns([{ id: 2, name: 'CI', event: 'pull_request', head_sha: 'a', jobs: [job] }]).totalBilled, 3);
});
