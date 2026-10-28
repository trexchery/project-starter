// Self-hosted runners: serve planning, token handling, bootstrap default-on. Hermetic: gh, docker and spawn are fakes.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { tmpDir } from './helpers.js';
import { plan, poll, newServeState, runnerScript, dockerArgs, startDocker, setRouting, editServed, LABEL, TARGET } from '../lib/runner.js';
import { runnerDefault } from '../lib/bootstrap.js';

const SECRET = 'JITSECRETLITERAL0123456789';

describe('plan', { concurrency: true }, () => {
  const up = { slots: 3, pool: 1, dockerUp: true, hosted: false };
  test('starts pool - idle per repo, capped by free slots in repo order', () => {
    const p = plan({ ...up, used: 1, repos: [{ repo: 'a', idle: 0 }, { repo: 'b', idle: 1 }, { repo: 'c', idle: 0 }, { repo: 'd', idle: 0 }] });
    assert.deepEqual(p.starts, [{ repo: 'a', n: 1 }, { repo: 'c', n: 1 }]);
    assert.equal(p.variable, null);
    assert.equal(p.rescue, false);
    assert.deepEqual(plan({ ...up, pool: 2, used: 0, repos: [{ repo: 'a', idle: 0 }] }).starts, [{ repo: 'a', n: 2 }]);
    assert.deepEqual(plan({ ...up, used: 3, repos: [{ repo: 'a', idle: 0 }] }).starts, []);
    assert.deepEqual(plan({ ...up, used: 5, repos: [{ repo: 'a', idle: 0 }] }).starts, [], 'over-full never goes negative');
  });
  test('docker down: no starts; falls back only on the second poll in a row, then rescues', () => {
    const one = plan({ slots: 3, pool: 1, dockerUp: false, downCount: 0, hosted: false, repos: [{ repo: 'a', idle: 0 }] });
    assert.deepEqual([one.starts, one.variable, one.rescue, one.downCount], [[], null, false, 1]);
    const two = plan({ slots: 3, pool: 1, dockerUp: false, downCount: 1, hosted: false });
    assert.deepEqual([two.variable, two.rescue, two.downCount], ['hosted', true, 2]);
    const three = plan({ slots: 3, pool: 1, dockerUp: false, downCount: 2, hosted: true });
    assert.deepEqual([three.variable, three.rescue], [null, true], 'already hosted: no second flip, keep rescuing');
  });
  test('docker healthy again (or state unknown at start): routing goes back to self-hosted once', () => {
    assert.equal(plan({ ...up, hosted: true, downCount: 4 }).variable, 'self');
    assert.equal(plan({ ...up, hosted: true, downCount: 4 }).downCount, 0);
    assert.equal(plan({ ...up, hosted: null }).variable, 'self');
    assert.equal(plan({ slots: 3, pool: 1, dockerUp: false, downCount: 1, hosted: null }).variable, 'hosted');
  });
});

// A fake world for poll(): repos, runners per repo, docker state, and a log of every gh call and action.
function world({ repos = ['o/a', 'o/b', 'o/c'], docker = true, runners = {}, local = [], queued = {}, jobs = {} } = {}) {
  const w = { docker, calls: [], started: [], acts: [], t: Date.parse('2026-10-27T12:00:00Z') };
  const json = (args) => {
    w.calls.push(args);
    if (args[0] === 'repo') return args[2] === 'o/gone' ? null : { isPrivate: args[2] !== 'o/public', isArchived: args[2] === 'o/archived' };
    const m = args[1].match(/^repos\/([^/]+\/[^/]+)\/actions\/(runners|runs)(?:\/(\d+)\/jobs)?/);
    if (m[2] === 'runners') return { runners: runners[m[1]] || [] };
    if (m[3]) return { jobs: jobs[m[3]] || [] };
    return { workflow_runs: queued[m[1]] || [] };
  };
  w.io = {
    config: () => ({ repos }),
    ghJson: json,
    gh: (args) => { w.calls.push(args); return { code: 0, out: '', err: '' }; },
    run: (cmd, args) => (args[0] === 'version' ? { code: w.docker ? 0 : 1, out: '' } : { code: 0, out: local.join('\n') }),
    start: (o) => { w.started.push(o.slug); },
    act: (what, fn) => { w.acts.push(what); return fn(); },
    warn: () => {},
    now: () => w.t,
  };
  return w;
}
const runner = (name, o = {}) => ({ name, status: 'online', busy: false, labels: [{ name: 'self-hosted' }, { name: LABEL }], ...o });

describe('poll', { concurrency: true }, () => {
  test('first healthy poll sets routing and fills the pool; containers still starting count as idle', () => {
    const w = world({ runners: { 'o/a': [runner('proj-docker-x-1')], 'o/b': [runner('busy', { busy: true })] }, local: ['proj-docker-x-1\to/a', 'proj-docker-x-2\to/b', 'proj-docker-x-3\to/a'] });
    const st = newServeState();
    poll(st, w.io);
    assert.deepEqual(w.acts.filter((a) => a.includes('PROJ_RUNS_ON')), ['set PROJ_RUNS_ON on o/a', 'set PROJ_RUNS_ON on o/b', 'set PROJ_RUNS_ON on o/c']);
    assert.ok(w.calls.some((c) => c.join(' ') === `variable set PROJ_RUNS_ON -R o/a --body ${TARGET}`));
    assert.deepEqual(w.started, [], '3 of 3 slots in use');
    assert.equal(st.hosted, false);
    const w2 = world({ runners: { 'o/a': [runner('r1')] } });
    poll(newServeState(), w2.io);
    assert.deepEqual(w2.started, ['o/b', 'o/c']);
  });

  test('archived, public or missing repos are skipped quietly: never served, never flipped', () => {
    const w = world({ repos: ['o/a', 'o/archived', 'o/public', 'o/gone'] });
    const st = newServeState();
    poll(st, w.io);
    assert.deepEqual(st.live, ['o/a']);
    assert.deepEqual(w.started, ['o/a']);
    assert.ok(!w.acts.some((a) => /archived|public|gone/.test(a)));
  });

  test('docker down twice: flip to hosted, cancel runs queued >5 min on proj labels, re-run them later; flip back when healthy', () => {
    const old = '2026-10-27T11:50:00Z'; const fresh = '2026-10-27T11:58:00Z';
    const w = world({
      repos: ['o/a'],
      queued: { 'o/a': [{ id: 7, created_at: old }, { id: 8, created_at: fresh }, { id: 9, created_at: old }] },
      jobs: { 7: [{ status: 'queued', labels: ['self-hosted', LABEL], created_at: old }], 9: [{ status: 'queued', labels: ['ubuntu-latest'], created_at: old }] },
    });
    const st = newServeState();
    poll(st, w.io); // healthy: routing on
    w.docker = false;
    poll(st, w.io);
    assert.equal(st.hosted, false, 'one failed poll is not enough');
    poll(st, w.io);
    assert.equal(st.hosted, true);
    assert.ok(w.calls.some((c) => c.join(' ') === 'variable delete PROJ_RUNS_ON -R o/a'));
    assert.ok(w.calls.some((c) => c.join(' ') === 'run cancel 7 -R o/a'));
    assert.ok(!w.calls.some((c) => /run cancel (8|9)/.test(c.join(' '))), 'fresh runs and hosted jobs are left alone');
    poll(st, w.io);
    assert.ok(w.calls.some((c) => c.join(' ') === 'run rerun 7 --failed -R o/a'));
    assert.equal(w.calls.filter((c) => c[0] === 'variable').length, 2, 'no repeated flips while down');
    w.docker = true;
    poll(st, w.io);
    assert.equal(st.hosted, false);
    assert.equal(w.calls.filter((c) => c.join(' ').startsWith('variable set')).length, 2);
  });

  test('API budget: under 300 gh calls per hour for 3 repos at one poll a minute', () => {
    const w = world({ runners: { 'o/a': [runner('r1')], 'o/b': [runner('r2')], 'o/c': [runner('r3')] }, local: ['r1\to/a', 'r2\to/b', 'r3\to/c'] });
    const st = newServeState();
    for (let i = 0; i < 60; i++) poll(st, w.io);
    assert.ok(w.calls.length < 300, `${w.calls.length} calls`);
    const d = world({ queued: {} });
    const sd = newServeState();
    d.docker = false;
    for (let i = 0; i < 60; i++) poll(sd, d.io);
    assert.ok(d.calls.length < 300, `${d.calls.length} calls while docker is down`);
  });
});

describe('runner token handling', { concurrency: true }, () => {
  test('the JIT config travels on stdin only: never in docker argv, never config.sh/--token', () => {
    let argv; let stdin = '';
    const spawnFn = (cmd, args) => {
      argv = [cmd, ...args];
      const c = new EventEmitter();
      c.stdin = { end: (s) => { stdin += s; } };
      c.unref = () => {};
      return c;
    };
    const ghCalls = [];
    const ghFn = (args) => { ghCalls.push(args); return { code: 0, out: SECRET, err: '' }; };
    const name = startDocker({ slug: 'o/a', cpus: 4, memory: '8g', maxMin: 30 }, { ghFn, spawnFn });
    assert.ok(!argv.join(' ').includes(SECRET), 'not in argv');
    assert.equal(stdin, `${SECRET}\n`);
    assert.ok(!ghCalls.flat().join(' ').includes(SECRET));
    assert.match(ghCalls[0].join(' '), /generate-jitconfig .*labels\[\]=self-hosted .*labels\[\]=proj-ephemeral/);
    assert.ok(ghCalls[0].includes(`name=${name}`));
    const a = argv.join(' ');
    for (const want of ['--cap-drop ALL', 'no-new-privileges', '--rm', 'host.docker.internal:0.0.0.0', 'gateway.docker.internal:0.0.0.0', '--label proj.serve=1', '--label proj.repo=o/a', '--cpus 4', '--memory 8g']) assert.ok(a.includes(want), want);
    assert.doesNotMatch(a, /--network|--net=|host-mode|-v |--volume|--privileged|--env|-e /);
  });

  test('runnerScript reads the config from stdin into the runner env, never a --token argument, with a hard timeout', () => {
    const s = runnerScript({ maxMin: 30 });
    assert.doesNotMatch(s, /--token|config\.sh|--jitconfig/);
    assert.match(s, /^set -e; IFS= read -r ACTIONS_RUNNER_INPUT_JITCONFIG; export ACTIONS_RUNNER_INPUT_JITCONFIG; /);
    assert.match(s, /timeout --kill-after=30 1800 \.\/run\.sh$/);
    assert.equal(dockerArgs({ name: 'n', slug: 'o/a', maxMin: 30 }).at(-1), s);
  });

  test('setRouting: set the target, delete for hosted, a missing variable already counts as hosted', () => {
    const calls = [];
    assert.equal(setRouting('o/a', true, (a) => { calls.push(a.join(' ')); return { code: 0 }; }), true);
    assert.equal(setRouting('o/a', false, () => ({ code: 1, err: 'HTTP 404: Not Found' })), true);
    assert.equal(setRouting('o/a', true, () => ({ code: 1, err: 'HTTP 403' })), false);
    assert.deepEqual(calls, [`variable set PROJ_RUNS_ON -R o/a --body ${TARGET}`]);
  });
});

describe('bootstrap default-on', { concurrency: true }, () => {
  test('a new private repo joins runner.serve and gets PROJ_RUNS_ON, only on a machine that opted in', () => {
    const file = path.join(tmpDir('cfg-'), 'config.json');
    const calls = [];
    const ghFn = (a) => { calls.push(a.join(' ')); return { code: 0 }; };
    assert.equal(runnerDefault('o/new', { ghFn, configFile: file }), false, 'no config: not opted in');
    fs.writeFileSync(file, JSON.stringify({ owner: 'o', runner: { cpus: 4 } }));
    assert.equal(runnerDefault('o/new', { ghFn, configFile: file }), false, 'runner without serve: not opted in');
    assert.deepEqual(calls, []);
    fs.writeFileSync(file, JSON.stringify({ owner: 'o', runner: { cpus: 4, serve: { repos: ['o/old'], slots: 3 } } }));
    assert.equal(runnerDefault('o/new', { ghFn, configFile: file }), true);
    assert.equal(runnerDefault('o/new', { ghFn, configFile: file }), true);
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(cfg.runner.serve, { repos: ['o/old', 'o/new'], slots: 3 });
    assert.equal(cfg.owner, 'o');
    assert.deepEqual(calls, [`variable set PROJ_RUNS_ON -R o/new --body ${TARGET}`, `variable set PROJ_RUNS_ON -R o/new --body ${TARGET}`]);
    assert.equal(editServed('o/new', false, file), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).runner.serve.repos, ['o/old']);
  });

  test('cmdNew calls the default only for a private repo it just created', () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'bootstrap.js'), 'utf8');
    assert.match(src, /if \(vis === '--private'\) runnerDefault\(slug\);/);
    assert.equal(src.match(/runnerDefault\(/g).length, 2, 'one definition, one call');
  });
});
