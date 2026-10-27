import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, write, exists, ROOT } from './helpers.js';

const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-remote.mjs');

// Repo + PROJ_HOME/config.json whose compute.command is the fake remote. Returns the scenario file path.
async function setup({ scenario = {}, files, stateDir = true } = {}) {
  const repo = await makeRepo({ files: { 'tracked.txt': 'tracked\n', ...files } });
  const file = path.join(repo.parent, 'scenario.json');
  fs.writeFileSync(file, JSON.stringify(scenario));
  write(repo.home, 'config.json', JSON.stringify({ compute: { enabled: true, command: [process.execPath, FAKE, file] } }));
  if (stateDir) fs.mkdirSync(path.join(repo.root, '.git', 'proj'), { recursive: true });
  return { ...repo, scenario: file, ran: () => (exists(`${file}.ran`) ? JSON.parse(fs.readFileSync(`${file}.ran`, 'utf8')) : null) };
}

describe('proj offload', { concurrency: true }, () => {
  test('compute disabled: exit 4, the remote is never called', async () => {
    const repo = await makeRepo();
    for (const args of [['offload'], ['offload', 'npm test']]) {
      const r = await repo.proj(args);
      assert.equal(r.code, 4, r.out + r.err);
      assert.match(r.out + r.err, /offload is off/);
    }
  });

  test('enabled without a remote configured: exit 2', async () => {
    const repo = await makeRepo();
    write(repo.home, 'config.json', JSON.stringify({ compute: { enabled: true } }));
    const r = await repo.proj(['offload']);
    assert.equal(r.code, 2);
    assert.match(r.out + r.err, /no remote configured/);
  });

  test('remote unreachable, missing or printing garbage: exit 2, nothing shipped', async () => {
    const s = await setup({ scenario: { probeExit: 255, probeErr: 'ssh: connect to host box port 22: Connection timed out' } });
    const r = await s.proj(['offload', 'npm test']);
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.err, /not reachable/);
    assert.equal(s.ran(), null);
    write(s.home, 'config.json', JSON.stringify({ compute: { enabled: true, command: [path.join(s.parent, 'no-such-tool.exe')] } }));
    assert.equal((await s.proj(['offload', 'x'])).code, 2);
    write(s.home, 'config.json', JSON.stringify({ compute: { enabled: true, command: [process.execPath, '-e', 'console.log("oops")'] } }));
    assert.equal((await s.proj(['offload', 'x'])).code, 2);
  });

  test('host key not verified: exit 5, nothing shipped', async () => {
    const s = await setup({ scenario: { probeExit: 255, probeErr: 'Host key verification failed.' } });
    const r = await s.proj(['offload', 'npm test']);
    assert.equal(r.code, 5, r.out + r.err);
    assert.match(r.err, /host identity unverified/);
    assert.equal(s.ran(), null);
  });

  test('ships tracked + untracked files (not ignored ones) and passes the exit code through', async () => {
    const s = await setup({ scenario: { exit: 7, cpus: 32 }, files: { '.gitignore': 'ignored.txt\n.env\n' } });
    write(s.root, 'untracked.txt', 'untracked\n');
    write(s.root, 'ignored.txt', 'IGNORED-MARKER\n');
    write(s.root, '.env', 'SECRET=hunter2\n');
    const avail = await s.proj(['offload']);
    assert.equal(avail.code, 0, avail.err);
    assert.match(avail.out, /available: .*\(32 cpus\)/);

    const r = await s.proj(['offload', 'npm test']);
    assert.equal(r.code, 7, r.out + r.err);
    const ran = s.ran();
    assert.match(ran.script, /base64 -d/);
    assert.ok(ran.bytes > 0);
    assert.match(ran.tar, /tracked\.txt/);
    assert.match(ran.tar, /untracked\.txt/);
    assert.doesNotMatch(ran.tar, /IGNORED-MARKER|hunter2/);
    const script = Buffer.from(ran.script.match(/echo (\S+) \| base64/)[1], 'base64').toString();
    assert.match(script, /timeout 1800 sh -c "npm test"/, 'runtime is capped at compute.maxRuntimeMin');
    assert.match(script, /PROJ_MAX_WORKERS=8/);

    fs.writeFileSync(s.scenario, JSON.stringify({ exit: 0 }));
    assert.equal((await s.proj(['offload', 'npm test'])).code, 0);
  });

  test('offload works in a repo proj has never written state for', async () => {
    const s = await setup({ scenario: { exit: 7 }, stateDir: false });
    const r = await s.proj(['offload', 'npm test']);
    assert.doesNotMatch(r.err, /ENOENT/);
    assert.equal(r.code, 7);
  });

  test('refuses (exit 3) when a .env file is untracked and not ignored', async () => {
    const s = await setup();
    write(s.root, '.env', 'SECRET=hunter2\n');
    const r = await s.proj(['offload', 'npm test']);
    assert.equal(r.code, 3, r.out + r.err);
    assert.match(r.err, /secret-looking files would ship: \.env/);
    assert.equal(s.ran(), null, 'nothing was sent');
  });

  test('ssh transport uses strict host key checking and batch mode', async () => {
    const { transport } = await import('../lib/checks.js');
    const t = transport({ ssh: 'me@box', port: 2222 });
    assert.deepEqual(t.argv, ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-p', '2222', 'me@box']);
    assert.equal(transport({}), null);
  });
});
