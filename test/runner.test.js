// Self-hosted runners: serve planning, token handling, bootstrap default-on. Hermetic: gh, docker and spawn are fakes.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { tmpDir } from './helpers.js';
import { plan, poll, newServeState, runnerScript, dockerArgs, startDocker, setRouting, editServed, cmdHosted, LABEL, TARGET, OWN, RUNNER_VERSION } from '../lib/runner.js';
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
  test('backlog: queued + pool - idle runners at once; backlog before pool refills; fewest-held repo first', () => {
    assert.deepEqual(plan({ ...up, slots: 10, repos: [{ repo: 'a', idle: 0, queued: 7 }] }).starts, [{ repo: 'a', n: 8 }]);
    assert.deepEqual(plan({ ...up, used: 1, repos: [{ repo: 'a', idle: 0 }, { repo: 'b', idle: 0, queued: 3, held: 1 }] }).starts, [{ repo: 'b', n: 2 }]);
    assert.deepEqual(plan({ ...up, used: 2, repos: [{ repo: 'a', idle: 0, queued: 5, held: 2 }, { repo: 'b', idle: 0, queued: 5 }] }).starts, [{ repo: 'b', n: 1 }], 'b holds none: b first');
  });
  test('preempt: backlog with no free slot recycles idle runners of repos with nothing queued, never while backing off', () => {
    const repos = [{ repo: 'a', idle: 0, queued: 6, held: 1 }, { repo: 'b', idle: 1, held: 1, spare: 1 }, { repo: 'c', idle: 1, queued: 1, held: 1, spare: 1 }];
    const p = plan({ ...up, used: 3, repos });
    assert.deepEqual([p.starts, p.preempt], [[{ repo: 'a', n: 1 }], [{ repo: 'b', n: 1 }]], 'c has a queued job: its idle runner stays');
    assert.deepEqual(plan({ ...up, used: 3, canStart: false, repos }).preempt, []);
    assert.deepEqual(plan({ ...up, used: 3, repos: [{ repo: 'a', idle: 0, held: 2 }, { repo: 'b', idle: 1, held: 1, spare: 1 }] }).preempt, [], 'a pool refill never preempts');
  });
  test('docker healthy again (or state unknown at start): routing goes back to self-hosted once', () => {
    assert.equal(plan({ ...up, hosted: true, downCount: 4 }).variable, 'self');
    assert.equal(plan({ ...up, hosted: true, downCount: 4 }).downCount, 0);
    assert.equal(plan({ ...up, hosted: null }).variable, 'self');
    assert.equal(plan({ slots: 3, pool: 1, dockerUp: false, downCount: 1, hosted: null }).variable, 'hosted');
  });
});

// A fake world for poll(): repos, runners per repo, docker state, and a log of every gh call, docker command and action.
function world({ repos = ['o/a', 'o/b', 'o/c'], docker = true, runners = {}, local = [], queued = {}, jobs = {}, slots, pool } = {}) {
  const w = { repos, docker, runners, local, queued, jobs, calls: [], started: [], acts: [], dock: [], exits: {}, refuse: new Set(), view: {}, vars: {}, t: T0 };
  const json = (args) => {
    w.calls.push(args);
    if (args[0] === 'repo') return w.view[args[2]] !== undefined ? w.view[args[2]] : args[2] === 'o/gone' ? null : { isPrivate: args[2] !== 'o/public', isArchived: args[2] === 'o/archived' };
    const m = args[1].match(/^repos\/([^/]+\/[^/]+)\/actions\/(runners|runs)(?:\/(\d+)\/jobs)?/);
    if (m[2] === 'runners') return { runners: w.runners[m[1]] || [] };
    if (m[3]) return { jobs: w.jobs[m[3]] || [] };
    return { workflow_runs: (w.queued[m[1]] || []).map((r) => ({ status: 'queued', ...r })) };
  };
  w.io = {
    config: () => ({ repos: w.repos, ...(slots && { slots }), ...(pool && { pool }) }),
    ghJson: json,
    // GitHub refuses to delete a runner that holds a job: ids in w.refuse fail. w.vars holds PROJ_RUNS_ON per repo.
    gh: (args) => {
      w.calls.push(args);
      if (args[0] === 'variable' && args[2] === 'PROJ_RUNS_ON') w.vars[args[4]] = args[1] === 'set' ? args[6] : undefined;
      return { code: args[2] === 'DELETE' && w.refuse.has(args[3].split('/').pop()) ? 1 : 0, out: '', err: '' }; },
    run: (cmd, args) => {
      if (args[0] === 'version') return { code: w.docker ? 0 : 1, out: '' };
      if (args[0] === 'ps') return { code: 0, out: w.local.join('\n') };
      w.dock.push(args.join(' '));
      return { code: 0, out: '' };
    },
    start: (o, onExit) => { w.started.push(o.slug); w.maxMin = o.maxMin; const name = `proj-docker-new-${w.started.length}`; w.exits[name] = onExit; return name; },
    act: (what, fn) => { w.acts.push(what); return fn(); },
    warn: () => {},
    now: () => w.t,
  };
  return w;
}
const runner = (name, o = {}) => ({ name, status: 'online', busy: false, labels: [{ name: 'self-hosted' }, { name: LABEL }], ...o });
const T0 = Date.parse('2026-10-27T12:00:00Z');
const ago = (min, t = T0) => Math.floor((t - min * 60000) / 1000); // a proj.started label
const cmds = (w) => w.calls.map((c) => c.join(' '));

describe('poll', { concurrency: true }, () => {
  test('first healthy poll sets routing and fills the pool; containers still starting count as idle', () => {
    const w = world({ runners: { 'o/a': [runner('proj-docker-x-1')], 'o/b': [runner('busy', { busy: true })] }, local: ['proj-docker-x-1\to/a', 'proj-docker-x-2\to/b', 'proj-docker-x-3\to/a'] });
    const st = newServeState();
    poll(st, w.io);
    assert.deepEqual(w.acts.filter((a) => /^(set|delete) PROJ_RUNS_ON/.test(a)), ['set PROJ_RUNS_ON on o/a', 'set PROJ_RUNS_ON on o/b', 'set PROJ_RUNS_ON on o/c']);
    assert.ok(cmds(w).includes(`variable set PROJ_RUNS_ON -R o/a --body ${TARGET}`));
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
    const w = world({ repos: ['o/a'] });
    const st = newServeState();
    poll(st, w.io); // healthy: routing on
    w.queued = { 'o/a': [{ id: 7, created_at: old }, { id: 8, created_at: fresh }, { id: 9, created_at: old }] };
    w.jobs = { 7: [{ status: 'queued', labels: ['self-hosted', LABEL], created_at: old }], 9: [{ status: 'queued', labels: ['ubuntu-latest'], created_at: old }] };
    w.docker = false;
    poll(st, w.io);
    assert.equal(st.hosted, false, 'one failed poll is not enough');
    poll(st, w.io);
    assert.equal(st.hosted, true);
    assert.ok(cmds(w).includes('variable delete PROJ_RUNS_ON -R o/a'));
    assert.ok(cmds(w).includes('run cancel 7 -R o/a'));
    assert.ok(!cmds(w).some((c) => /run cancel (8|9)/.test(c)), 'fresh runs and hosted jobs are left alone');
    poll(st, w.io);
    assert.ok(cmds(w).includes('run rerun 7 --failed -R o/a'));
    assert.equal(w.calls.filter((c) => c[0] === 'variable' && c[2] === 'PROJ_RUNS_ON').length, 2, 'no repeated flips while down');
    w.docker = true;
    w.queued = {};
    poll(st, w.io);
    assert.equal(st.hosted, false);
    assert.equal(cmds(w).filter((c) => c.startsWith('variable set PROJ_RUNS_ON ')).length, 2);
  });

  test('cancelled runs are re-run even when docker recovers before the next poll', () => {
    const old = '2026-10-27T11:50:00Z';
    const w = world({ repos: ['o/a'], docker: false, queued: { 'o/a': [{ id: 7, created_at: old }] }, jobs: { 7: [{ status: 'queued', labels: [LABEL], created_at: old }] } });
    const st = newServeState();
    poll(st, w.io);
    poll(st, w.io);
    assert.ok(cmds(w).includes('run cancel 7 -R o/a'));
    w.docker = true;
    w.queued = {};
    poll(st, w.io);
    assert.ok(cmds(w).includes('run rerun 7 --failed -R o/a'));
    assert.equal(st.reruns.size, 0);
  });

  test('an idle pool runner older than idleMinutes is unregistered, then stopped; a busy one never is', () => {
    const w = world({
      repos: ['o/a'],
      runners: { 'o/a': [runner('old', { id: 11 }), runner('busy', { id: 12, busy: true }), runner('young', { id: 13 }), runner('raced', { id: 14 })] },
      local: [`old\to/a\t${ago(25)}`, `busy\to/a\t${ago(80)}`,
        `young\to/a\t${ago(5)}`, `raced\to/a\t${ago(30)}`],
    });
    w.refuse.add('14'); // took a job between the list and the delete: GitHub refuses, the container stays
    const st = newServeState();
    poll(st, w.io);
    assert.ok(cmds(w).includes('api -X DELETE repos/o/a/actions/runners/11'));
    assert.deepEqual(w.dock, ['rm -f old']);
    assert.ok(!cmds(w).some((c) => /runners\/(12|13)$/.test(c)), 'busy and young runners are left alone');
    assert.deepEqual(w.started, [], 'young and raced still cover pool 1');
    const w2 = world({ repos: ['o/a'] });
    poll(newServeState(), w2.io);
    assert.equal(w2.maxMin, 90, 'hard stop = idleMinutes 20 + maxMinutes 60 + 10');
  });

  test('a slow image pull never pushes the total past slots: spawned runners count until docker lists them', () => {
    const w = world();
    const st = newServeState();
    poll(st, w.io);
    assert.deepEqual(w.dock, [`pull ghcr.io/actions/actions-runner:${RUNNER_VERSION}`], 'pulled once, before the first start');
    assert.deepEqual(w.started, ['o/a', 'o/b', 'o/c']);
    w.t += 60000;
    poll(st, w.io); // docker ps still lists nothing
    assert.deepEqual(w.started, ['o/a', 'o/b', 'o/c'], 'no second batch');
    w.local = ['proj-docker-new-1\to/a', 'proj-docker-new-2\to/b'];
    w.t += 60000;
    poll(st, w.io);
    assert.equal(w.started.length, 3, 'two listed, one still spawning: 3 of 3');
    w.exits['proj-docker-new-3'](125);  // its client exited non-zero before docker listed it: a failed start, backs off one round
    w.t += 2 * 60000;
    poll(st, w.io);
    assert.deepEqual(w.started, ['o/a', 'o/b', 'o/c', 'o/c']);
    assert.equal(w.dock.filter((d) => d.startsWith('pull')).length, 1);
  });

  test('unhealthy while docker is up: proj jobs queued >5 min with a free slot and no runner coming -> hosted + rescue', () => {
    const old = '2026-10-27T11:50:00Z';
    const w = world({ repos: ['o/a'], runners: { 'o/a': [runner('r1', { busy: true })] }, local: ['r1\to/a'], queued: { 'o/a': [{ id: 5, created_at: old }] }, jobs: { 5: [{ status: 'queued', labels: [LABEL], created_at: old }] } });
    const st = newServeState();
    st.nextStart = Infinity; // starts backing off: no runner of o/a is idle or starting
    poll(st, w.io);
    assert.equal(st.hosted, false, 'just started: jobs that waited for serve get its runners first');
    w.t += 5 * 60000;
    poll(st, w.io);
    assert.equal(st.hosted, true);
    assert.ok(cmds(w).includes('variable delete PROJ_RUNS_ON -R o/a'));
    assert.ok(cmds(w).includes('run cancel 5 -R o/a'));
    w.queued = {};
    w.t += 10 * 60000;
    poll(st, w.io);
    assert.equal(st.hosted, true, 'stays hosted for a while instead of flapping');
    w.t += 30 * 60000;
    poll(st, w.io);
    assert.equal(st.hosted, false);
    const busy = world({ repos: ['o/a'], slots: 1, runners: { 'o/a': [runner('r1', { busy: true })] }, local: ['r1\to/a'], queued: w.queued = { 'o/a': [{ id: 5, created_at: old }] }, jobs: { 5: [{ status: 'queued', labels: [LABEL], created_at: old }] } });
    const sb = newServeState();
    poll(sb, busy.io);
    busy.t += 5 * 60000;
    poll(sb, busy.io);
    assert.equal(sb.hosted, false, 'every slot busy: queueing is expected');
  });

  test('stuck check: never while slots are full or filling, never with a runner coming, never cancels a run with a proj job in progress', () => {
    const old = '2026-10-27T11:50:00Z';
    const backlog = [{ status: 'queued', labels: [LABEL], created_at: old }, { status: 'queued', labels: [LABEL], created_at: old }];
    const inProgress = [{ status: 'in_progress', labels: [LABEL], created_at: old }, ...backlog];
    const check = (jobs, { local, runners, backoff, docker = true }) => {
      const w = world({ repos: ['o/a'], runners: { 'o/a': runners }, local, queued: { 'o/a': [{ id: 5, created_at: old }] }, jobs: { 5: jobs } });
      const st = newServeState();
      if (backoff) st.nextStart = Infinity;
      poll(st, w.io);
      w.docker = docker;
      for (let i = 0; i < 5; i++) { w.t += 60000; poll(st, w.io); }
      return { st, c: cmds(w) };
    };
    const busy = [runner('r1', { busy: true })];
    const filling = { runners: busy, local: ['r1\to/a', 's2\to/a', 's3\to/a'] }; // s2, s3 still starting
    const free = { runners: busy, local: ['r1\to/a'], backoff: true };
    const coming = { runners: busy, local: ['r1\to/a', 's2\to/a'] };
    for (const [name, jobs, o] of [['slots filling, matrix backlog', backlog, filling], ['slots filling, one job in progress', inProgress, filling],
      ['slot free, a runner of the repo starting', backlog, coming], ['slot free, one job in progress', inProgress, free],
      ['docker down, one job in progress', inProgress, { ...free, docker: false }]]) {
      const { st, c } = check(jobs, o);
      assert.ok(!c.some((x) => x.startsWith('run cancel')), `${name}: no cancel`);
      if (o.docker !== false) assert.equal(st.hosted, false, `${name}: no hosted flip`);
    }
  });

  test('stuck check: a slot that frees on the check poll is not free; one free since the previous poll with no runner coming is', () => {
    const old = '2026-10-27T11:50:00Z';
    // slots 3, all busy; r3 finishes (container exits, unregisters) after `busyPolls` polls a minute apart.
    const run = (busyPolls, backoff) => {
      const busy = ['r1', 'r2', 'r3'].map((n) => runner(n, { busy: true }));
      const w = world({ repos: ['o/a'], slots: 3, runners: { 'o/a': busy }, local: ['r1\to/a', 'r2\to/a', 'r3\to/a'],
        queued: { 'o/a': [{ id: 7, created_at: old }] }, jobs: { 7: [{ status: 'queued', labels: [LABEL], created_at: old }] } });
      const st = newServeState();
      if (backoff) st.nextStart = Infinity;
      poll(st, w.io);
      for (let i = 1; i < busyPolls; i++) { w.t += 60000; poll(st, w.io); }
      w.runners['o/a'] = busy.slice(0, 2); w.local = ['r1\to/a', 'r2\to/a'];
      while (w.t < T0 + 5 * 60000) { w.t += 60000; poll(st, w.io); }
      return { st, c: cmds(w) };
    };
    const freed = run(5, false); // r3 gone on the 5-minute check poll itself
    assert.ok(!freed.c.some((x) => x.startsWith('run cancel')), 'no cancel');
    assert.equal(freed.st.hosted, false, 'no hosted flip');
    const held = run(4, true); // free and nothing coming on the 4th and 5th minute polls
    assert.equal(held.st.hosted, true, 'free for a whole poll with no runner coming: hosted');
    assert.ok(held.c.includes('run cancel 7 -R o/a'));
  });

  // Every runner container exits right away (crash on start, failed registration): docker never lists it.
  const crashLoop = (polls, jobAt) => {
    const w = world({ repos: ['o/a'], slots: 3, queued: { 'o/a': [] } });
    const st = newServeState();
    const perPoll = [];
    for (let i = 0; i < polls; i++) {
      w.t = T0 + i * 60000;
      if (jobAt !== undefined && w.t >= jobAt && !w.queued['o/a'].length) {
        const at = new Date(jobAt).toISOString();
        w.queued['o/a'] = [{ id: 7, created_at: at }];
        w.jobs[7] = [{ status: 'queued', labels: [LABEL], created_at: at }];
      }
      const before = w.started.length;
      poll(st, w.io);
      perPoll.push(w.started.length - before);
      for (const k of Object.keys(w.exits)) { w.exits[k](); delete w.exits[k]; }
    }
    return { w, st, perPoll };
  };

  test('runners that exit before docker lists them: a job queued after serve started still falls back to hosted and is cancelled', () => {
    const { w, st } = crashLoop(16, T0 + 30000); // polls up to T0+15 min
    assert.equal(st.hosted, true);
    assert.ok(cmds(w).includes('run cancel 7 -R o/a'));
  });

  test('stuck check: a job queued after the slot went free still counts once it waited 5 min', () => {
    const at = new Date(T0 + 30000).toISOString();
    const w = world({ repos: ['o/a'], queued: { 'o/a': [{ id: 7, created_at: at }] }, jobs: { 7: [{ status: 'queued', labels: [LABEL], created_at: at }] } });
    const st = newServeState();
    st.nextStart = Infinity; // no runner starting, and no failed start either
    for (let i = 0; i <= 10; i++) { w.t = T0 + i * 60000; poll(st, w.io); }
    assert.equal(st.fails, 0);
    assert.equal(st.hosted, true);
    assert.ok(cmds(w).includes('run cancel 7 -R o/a'));
  });

  test('runners that exit before docker lists them are failed starts: backoff, not one start per poll forever', () => {
    const { st, perPoll } = crashLoop(11);
    assert.ok(st.fails >= 2);
    assert.ok(perPoll.filter(Boolean).length <= 4, `starts per poll: ${perPoll}`);
    assert.equal(perPoll[1], 0, 'no start on the poll right after a failed one');
  });

  test('a listed runner that exits after its job is not a failed start', () => {
    const w = world({ repos: ['o/a'], slots: 3 });
    const st = newServeState();
    poll(st, w.io);
    assert.deepEqual(w.started, ['o/a']);
    w.local = ['proj-docker-new-1\to/a'];
    w.runners['o/a'] = [runner('proj-docker-new-1', { busy: true })];
    w.t += 60000;
    poll(st, w.io); // listed, online, running its job
    w.local = []; w.runners['o/a'] = [];
    w.exits['proj-docker-new-1'](); // job done, container gone
    w.t += 60000;
    poll(st, w.io);
    assert.equal(st.fails, 0);
    assert.deepEqual(w.started, ['o/a', 'o/a'], 'replaced at once, no backoff');
  });

  test('routing re-asserted with each heartbeat: a PROJ_RUNS_ON the watchdog deleted is set again while serve polls', () => {
    const w = world({ repos: ['o/a'], runners: { 'o/a': [runner('r1')] }, local: ['r1\to/a'] });
    const st = newServeState();
    poll(st, w.io);
    assert.equal(w.vars['o/a'], TARGET);
    w.vars['o/a'] = undefined; // the watchdog saw a stale heartbeat (PC asleep) and deleted it
    for (let i = 0; i < 5; i++) { w.t += 60000; poll(st, w.io); }
    assert.equal(w.vars['o/a'], TARGET);
    const c = cmds(w);
    assert.ok(c.lastIndexOf(`variable set PROJ_RUNS_ON_HEARTBEAT -R o/a --body ${w.t / 1000}`) < c.lastIndexOf(`variable set PROJ_RUNS_ON -R o/a --body ${TARGET}`), 'heartbeat first');
  });

  test('a slow first image pull writes a heartbeat right after it, so the watchdog never sees serve as silent', () => {
    const w = world({ repos: ['o/a'] });
    const run = w.io.run;
    w.io.run = (cmd, args, o) => { if (args[0] === 'pull') w.t += 12 * 60000; return run(cmd, args, o); };
    poll(newServeState(), w.io);
    assert.ok(cmds(w).includes(`variable set PROJ_RUNS_ON_HEARTBEAT -R o/a --body ${w.t / 1000}`));
  });

  test('pool 2, two repos, 3 slots: runners still spawning count against slots, so no 4th start', () => {
    const w = world({ repos: ['o/a', 'o/b'], slots: 3, pool: 2 });
    const st = newServeState();
    poll(st, w.io);
    assert.deepEqual(w.started, ['o/a', 'o/a', 'o/b']);
    w.t += 60000;
    poll(st, w.io); // docker ps still lists nothing
    assert.deepEqual(w.started, ['o/a', 'o/a', 'o/b']);
  });

  test('runners that never come online are removed and back off; two failures -> hosted; orphan offline runners deleted', () => {
    const w = world({ repos: ['o/a'], runners: { 'o/a': [runner('stuck1', { id: 21, status: 'offline' }), runner(`${OWN}orphan`, { id: 22, status: 'offline' }), runner('proj-docker-otherpc-1', { id: 23, status: 'offline' })] },
      local: [`stuck1\to/a\t${ago(6)}`] });
    const st = newServeState();
    st.pulled = true;
    poll(st, w.io);
    assert.ok(cmds(w).includes('api -X DELETE repos/o/a/actions/runners/21'));
    assert.ok(w.dock.includes('rm -f stuck1'));
    assert.ok(cmds(w).includes('api -X DELETE repos/o/a/actions/runners/22'), 'own orphan removed');
    assert.ok(!cmds(w).some((c) => c.endsWith('runners/23')), "another machine's runner is not ours");
    assert.equal(st.fails, 1);
    assert.deepEqual(w.started, [], 'backing off after a failed start');
    assert.equal(st.hosted, false);
    w.runners['o/a'] = [];
    w.local = [`stuck2\to/a\t${ago(6, w.t)}`];
    w.t += 2 * 60000 + 1000;
    poll(st, w.io);
    assert.equal(st.fails, 2);
    assert.equal(st.hosted, true, 'repeated failed starts: CI goes to GitHub-hosted');
    w.local = [];
    w.t += 4 * 60000 + 1000;
    poll(st, w.io);
    assert.deepEqual(w.started, ['o/a'], 'retries after the backoff');
  });

  test('a repo that leaves the live set gets PROJ_RUNS_ON deleted and its containers stopped', () => {
    const w = world({ repos: ['o/a', 'o/b', 'o/c'], local: ['ca\to/a', 'cb\to/b', 'cc\to/c'], runners: { 'o/a': [runner('ca')], 'o/b': [runner('cb', { busy: true })], 'o/c': [runner('cc')] } });
    const st = newServeState();
    for (let i = 0; i < 10; i++) poll(st, w.io);
    w.repos = ['o/a', 'o/c'];          // removed from config
    w.view['o/c'] = { isPrivate: false, isArchived: false }; // made public
    poll(st, w.io);
    assert.deepEqual(st.live, ['o/a']);
    for (const r of ['o/b', 'o/c']) assert.ok(cmds(w).includes(`variable delete PROJ_RUNS_ON -R ${r}`), r);
    assert.deepEqual(w.dock, ['rm -f cb', 'rm -f cc']);
    assert.ok(!cmds(w).includes('variable delete PROJ_RUNS_ON -R o/a'));
    w.view['o/a'] = null;             // unreadable once (API blip): still served
    for (let i = 0; i < 10; i++) poll(st, w.io);
    assert.deepEqual(st.live, ['o/a']);
    for (let i = 0; i < 10; i++) poll(st, w.io);
    assert.deepEqual(st.live, [], 'unreadable twice in a row (deleted): dropped');
    assert.ok(cmds(w).includes('variable delete PROJ_RUNS_ON -R o/a'));
  });

  test('heartbeat: written before PROJ_RUNS_ON is set, every 5 min while self-hosted, never while hosted', () => {
    const w = world({ repos: ['o/a'], runners: { 'o/a': [runner('r1')] }, local: ['r1\to/a'] });
    const st = newServeState();
    poll(st, w.io);
    const c = cmds(w);
    const beat = `variable set PROJ_RUNS_ON_HEARTBEAT -R o/a --body ${w.t / 1000}`;
    assert.ok(c.indexOf(beat) >= 0 && c.indexOf(beat) < c.indexOf(`variable set PROJ_RUNS_ON -R o/a --body ${TARGET}`));
    for (let i = 0; i < 9; i++) { w.t += 60000; poll(st, w.io); }
    assert.equal(cmds(w).filter((x) => x.includes('HEARTBEAT')).length, 2, 'minutes 0 and 5');
    w.docker = false;
    for (let i = 0; i < 2; i++) { w.t += 60000; poll(st, w.io); }
    assert.equal(st.hosted, true);
    const n = cmds(w).filter((x) => x.includes('HEARTBEAT')).length;
    for (let i = 0; i < 10; i++) { w.t += 60000; poll(st, w.io); }
    assert.equal(cmds(w).filter((x) => x.includes('HEARTBEAT')).length, n, 'no heartbeat while hosted');
  });

  test('API budget: under 300 gh calls per hour for 3 repos at one poll a minute', () => {
    const w = world({ runners: { 'o/a': [runner('r1')], 'o/b': [runner('r2')], 'o/c': [runner('r3')] }, local: ['r1\to/a', 'r2\to/b', 'r3\to/c'] });
    const st = newServeState();
    for (let i = 0; i < 60; i++) { poll(st, w.io); w.t += 60000; }
    assert.ok(w.calls.length < 300, `${w.calls.length} calls`);
    const d = world({ queued: {} });
    const sd = newServeState();
    d.docker = false;
    for (let i = 0; i < 60; i++) { poll(sd, d.io); d.t += 60000; }
    assert.ok(d.calls.length < 300, `${d.calls.length} calls while docker is down`);
  });

  // One push, 3 short parallel proj jobs. Each replacement registers, takes the next job and exits 0
  // before the next 60 s poll lists it: a normal ephemeral exit, not a failed start.
  test('fast normal ephemeral jobs on unlisted runners are not failed starts: no backoff, no fallback', () => {
    const w = world({ repos: ['o/a'], slots: 3, runners: { 'o/a': [runner('r1')] }, local: ['r1\to/a'] });
    const st = newServeState();
    poll(st, w.io);
    assert.equal(st.hosted, false);
    const at = new Date(T0 + 10000).toISOString();
    w.queued['o/a'] = [{ id: 9, created_at: at }];
    w.jobs[9] = [{ status: 'in_progress', labels: [LABEL], created_at: at }, { status: 'queued', labels: [LABEL], created_at: at }, { status: 'queued', labels: [LABEL], created_at: at }];
    w.runners['o/a'] = [runner('r1', { busy: true })];
    let jobsLeft = 2;
    for (let i = 1; i <= 12; i++) {
      w.t = T0 + i * 60000;
      if (i === 2) { w.local = []; w.runners['o/a'] = []; } // r1 finished job 1 and left
      poll(st, w.io);
      for (const k of Object.keys(w.exits)) {
        if (jobsLeft > 0) { jobsLeft--; w.t += 50000; w.exits[k](0, null); w.t -= 50000; delete w.exits[k]; }
        else if (!w.local.some((l) => l.startsWith(k))) { w.local.push(`${k}\to/a\t${Math.floor(w.t / 1000)}`); w.runners['o/a'] = [...(w.runners['o/a'] || []), runner(k)]; }
      }
    }
    assert.equal(st.fails, 0, 'normal job exits counted as failed starts');
    assert.notEqual(st.hosted, true, 'CI flipped to hosted after 3 short jobs');
  });

  // Live pilot 2026-10-28, slots 3, pool 1: a drill-desk push queued 8 proj jobs (1.5-3 min each) in 3 runs while
  // project-starter sat idle with its pool runner. Serve used to start one runner a poll, keep project-starter's idle
  // runner on a slot, then call the steady churn "stuck" and cancel the queued runs. 10 s ticks, polls every 60 s.
  test('live pilot replay: 8-job burst, other repo idle -> scales to the backlog, recycles the idle runner, no fallback', () => {
    const DD = 'o/drill-desk'; const PS = 'o/project-starter';
    const w = world({ repos: [DD, PS], slots: 3, pool: 1 });
    let ids = 100;
    const reg = (repo, name, at) => { w.local.push(`${name}\t${repo}\t${Math.floor(at / 1000)}`); (w.runners[repo] ||= []).push(runner(name, { id: ++ids })); };
    const drop = (name) => { w.local = w.local.filter((l) => !l.startsWith(`${name}\t`)); for (const r of [DD, PS]) w.runners[r] = (w.runners[r] || []).filter((x) => x.name !== name); };
    reg(DD, 'dd0', T0 - 12 * 60000); reg(PS, 'ps0', T0 - 12 * 60000);
    const jobs = [[1, 0, 95], [1, 0, 175], [1, 0, 120], [1, 0, 100], [1, 0, 160], [2, 0, 140], [3, 105, 180], [3, 105, 90]]
      .map(([run, q, dur]) => ({ run, at: T0 + q * 1000, dur: dur * 1000, status: 'queued' }));
    const sync = () => {
      w.queued[DD] = [];
      for (const run of [1, 2, 3]) {
        const js = jobs.filter((j) => j.run === run && j.at <= w.t);
        if (!js.length || js.every((j) => j.status === 'completed')) continue;
        const created = new Date(js[0].at).toISOString();
        w.queued[DD].push({ id: run, created_at: created, status: js.some((j) => j.status !== 'queued') ? 'in_progress' : 'queued' });
        w.jobs[run] = js.map((j) => ({ status: j.status, labels: ['self-hosted', LABEL], created_at: created }));
      }
    };
    const st = newServeState();
    let started = 0; let docked = 0; let peak = 0; let peakAt; let recycledAt; let recycledWithBacklog = false; const newbies = [];
    for (w.t = T0 - 10 * 60000; w.t <= T0 + 20 * 60000; w.t += 10000) {
      for (const j of jobs.filter((x) => x.status === 'in_progress' && x.end <= w.t)) { j.status = 'completed'; drop(j.runner); w.exits[j.runner]?.(0); }
      for (const [repo, name] of newbies.splice(0)) reg(repo, name, w.t); // registered 10 s after its start
      sync();
      if ((w.t - T0) % 60000 === 30000) {
        poll(st, w.io);
        assert.notEqual(st.hosted, true, `hosted at T0+${(w.t - T0) / 1000}s`);
        for (; docked < w.dock.length; docked++) {
          const name = w.dock[docked].match(/^rm -f (.+)/)?.[1];
          if (!name) continue;
          if (name === 'ps0') { recycledAt = w.t; recycledWithBacklog = jobs.some((j) => j.status === 'queued' && j.at <= w.t); }
          drop(name);
        }
        for (; started < w.started.length; started++) newbies.push([w.started[started], `proj-docker-new-${started + 1}`]);
      }
      // GitHub hands each idle runner the oldest queued job of its repo.
      for (const r of w.runners[DD].filter((x) => !x.busy)) {
        const j = jobs.find((x) => x.status === 'queued' && x.at <= w.t);
        if (!j) break;
        Object.assign(j, { status: 'in_progress', end: w.t + j.dur, runner: r.name });
        r.busy = true;
      }
      const busy = w.runners[DD].filter((x) => x.busy).length;
      if (busy > peak) { peak = busy; peakAt = w.t; }
    }
    const c = cmds(w);
    assert.ok(!c.some((x) => x.startsWith('run cancel')), 'no run cancelled');
    assert.ok(!c.some((x) => x.startsWith('variable delete PROJ_RUNS_ON ')), 'no hosted flip');
    assert.ok(jobs.every((j) => j.status === 'completed'), `every job ran: ${jobs.map((j) => j.status)}`);
    assert.equal(peak, 3, 'drill-desk reaches all 3 slots');
    assert.ok(peakAt <= T0 + 3 * 60000, `3 busy by T0+3 min, not at T0+${(peakAt - T0) / 1000}s`);
    assert.ok(recycledWithBacklog && recycledAt <= T0 + 2 * 60000, "project-starter's idle runner recycled for the backlog (it would age out only at T0+8 min)");
    const a = w.acts;
    assert.ok(a.indexOf(`remove runner ps0 from ${PS}`) < a.indexOf('stop container ps0'), 'unregistered before the container stops');
    assert.equal(w.runners[PS].length, 1, 'project-starter gets its pool runner back once the backlog is gone');
    assert.equal(st.fails, 0);
    const burst = w.calls.length;
    assert.ok(burst < 150, `${burst} gh calls in 30 min (2 repos, under 300 an hour)`);
  });

  test('stuck check: a backlog that keeps moving while starts back off is not stuck; one that stops moving is', () => {
    const old = new Date(T0 - 10 * 60000).toISOString();
    // o/a: 3 slots busy with a matrix (run 1, in progress); run 2 queued 10 min ago waits behind it. Starts back off.
    const run = (moving) => {
      const w = world({ repos: ['o/a'], slots: 3, queued: { 'o/a': [{ id: 1, created_at: old, status: 'in_progress' }, { id: 2, created_at: old }] },
        jobs: { 1: [{ status: 'in_progress', labels: [LABEL], created_at: old }], 2: [{ status: 'queued', labels: [LABEL], created_at: old }] } });
      const st = newServeState();
      st.nextStart = Infinity;
      let k = 0;
      for (let i = 0; i <= 12; i++) {
        w.t = T0 + i * 60000;
        // Each minute one runner finished and another took the next job: 2 busy, one slot changing hands.
        if (moving || i === 0) { k++; w.runners['o/a'] = [runner(`b${k}`, { busy: true }), runner(`b${k + 1}`, { busy: true })]; w.local = [`b${k}\to/a`, `b${k + 1}\to/a`]; }
        poll(st, w.io);
      }
      return { st, c: cmds(w) };
    };
    const moving = run(true);
    assert.equal(moving.st.hosted, false, 'slot churn is progress');
    assert.ok(!moving.c.some((x) => x.startsWith('run cancel')));
    const stalled = run(false);
    assert.equal(stalled.st.hosted, true, 'no runner took a job for 5 min and none can start: hosted');
    assert.ok(stalled.c.includes('run cancel 2 -R o/a'));
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

describe('when serve is not running', { concurrency: true }, () => {
  test('proj runner hosted deletes PROJ_RUNS_ON on every served repo; the docs point to it, with a /TR that survives argv parsing', () => {
    const calls = [];
    cmdHosted({ repos: ['o/a', 'o/b'], ghFn: (a) => { calls.push(a.join(' ')); return { code: 0 }; } });
    assert.deepEqual(calls, ['variable delete PROJ_RUNS_ON -R o/a', 'variable delete PROJ_RUNS_ON -R o/b']);
    assert.throws(() => cmdHosted({ repos: ['o/a'], ghFn: () => ({ code: 1, err: 'HTTP 403' }) }), /still routed/);
    const doc = fs.readFileSync(path.join(import.meta.dirname, '..', 'docs', 'UTILITIES.md'), 'utf8');
    assert.match(doc, /proj runner hosted/);
    assert.doesNotMatch(doc, /use --hosted` in each repo/);
    // Verified with an argv echo in PowerShell 7.6: schtasks receives /TR "\"C:\...\node.exe\" \"C:\...\proj.js\" runner serve".
    assert.match(doc, /\$tr = '"\{0\}" "\{1\}" runner serve' -f/);
    assert.doesNotMatch(doc, /\/TR "\\"/, 'no backslash-escaped quotes inside a PowerShell string');
  });

  test('watchdog: a heartbeat over 10 min old routes CI to hosted and re-runs proj-queued runs; fresh or missing does nothing', { skip: process.platform === 'win32' && 'needs a POSIX shell' }, () => {
    const yml = fs.readFileSync(path.join(import.meta.dirname, '..', 'docs', 'runner-watchdog.yml'), 'utf8');
    assert.match(yml, /cron: '\*\/15 \* \* \* \*'/);
    assert.match(yml, /runs-on: ubuntu-latest/);
    const script = yml.split('run: |\n')[1].split('\n').map((l) => l.slice(10)).join('\n');
    const dir = tmpDir('wd-');
    fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/bash
echo "$*" >> "$LOG"
case "$1 $2 $3" in
  "variable get PROJ_RUNS_ON") [ -n "$RUNS_ON" ] && echo "$RUNS_ON"; [ -n "$RUNS_ON" ]; exit ;;
  "variable get PROJ_RUNS_ON_HEARTBEAT") [ -n "$HB" ] && echo "$HB"; [ -n "$HB" ]; exit ;;
esac
case "$1 $2" in
  "api repos/o/a/actions/runs?status=queued&per_page=50") echo 7; echo 8 ;;
  "api repos/o/a/actions/runs/7/jobs") echo self-hosted; echo proj-ephemeral ;;
  "api repos/o/a/actions/runs/8/jobs") echo ubuntu-latest ;;
  "run view") echo completed ;;
esac
exit 0
`, { mode: 0o755 });
    const go = (HB, RUNS_ON = TARGET) => {
      const LOG = path.join(dir, `log-${Math.random()}`);
      const r = spawnSync('bash', ['-c', script], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: 'x', REPOS: 'o/a', LOG, HB, RUNS_ON }, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n') : [];
    };
    const s = Math.floor(Date.now() / 1000);
    const stale = go(String(s - 700));
    assert.ok(stale.includes('variable delete PROJ_RUNS_ON -R o/a'));
    assert.ok(stale.includes('run cancel 7 -R o/a') && stale.includes('run rerun 7 --failed -R o/a'));
    assert.ok(!stale.some((l) => / 8 /.test(l) && l.startsWith('run')), 'a hosted run is left alone');
    for (const log of [go(String(s - 60)), go(''), go('garbage'), go(String(s - 700), '')]) assert.ok(!log.some((l) => /delete|cancel|rerun/.test(l)), log.join('|'));
  });
});
