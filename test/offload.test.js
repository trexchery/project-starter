import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, write, exists, ROOT } from './helpers.js';

const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-ddc.mjs');
const DEV = (host) => ({ leases: [{ role: 'dev', host, cpu: 64 }], burn_usd_hr: 1.2, balance_usd: 40 });

// Repo + PROJ_HOME/config.json pointing compute.ddc at the fake. Returns the scenario file path.
async function setup({ status, exit = 0, known = 'box.example.net ssh-ed25519 AAAAC3Nza\n', files, stateDir = true } = {}) {
  const repo = await makeRepo({ files: { 'tracked.txt': 'tracked\n', ...files } });
  const scenario = path.join(repo.parent, 'scenario.json');
  fs.writeFileSync(scenario, JSON.stringify({ status, exit }));
  const knownHosts = path.join(repo.parent, 'known_hosts');
  fs.writeFileSync(knownHosts, known);
  write(repo.home, 'config.json', JSON.stringify({ compute: { enabled: true, ddc: [process.execPath, FAKE, scenario], knownHosts } }));
  // offload works whether or not proj has written state in this repo yet.
  if (stateDir) fs.mkdirSync(path.join(repo.root, '.git', 'proj'), { recursive: true });
  return { ...repo, scenario, ran: () => (exists(`${scenario}.ran`) ? JSON.parse(fs.readFileSync(`${scenario}.ran`, 'utf8')) : null) };
}

describe('proj offload', { concurrency: true }, () => {
  test('compute disabled: exit 4, ddc never called', async () => {
    const repo = await makeRepo();
    for (const args of [['offload'], ['offload', 'npm test']]) {
      const r = await repo.proj(args);
      assert.equal(r.code, 4, r.out + r.err);
      assert.match(r.out + r.err, /offload is off/);
    }
  });

  test('no dev lease: exit 2', async () => {
    const s = await setup({ status: { leases: [{ role: 'gpu', host: 'box.example.net' }] } });
    assert.equal((await s.proj(['offload'])).code, 2);
    const r = await s.proj(['offload', 'npm test']);
    assert.equal(r.code, 2);
    assert.match(r.err, /no ddc dev box is running/);
    assert.equal(s.ran(), null);
  });

  test('ddc missing or printing garbage: exit 2', async () => {
    const s = await setup({ status: DEV('box.example.net') });
    write(s.home, 'config.json', JSON.stringify({ compute: { enabled: true, ddc: [path.join(s.parent, 'no-such-ddc.exe')] } }));
    assert.equal((await s.proj(['offload', 'x'])).code, 2);
    write(s.home, 'config.json', JSON.stringify({ compute: { enabled: true, ddc: [process.execPath, '-e', 'console.log("oops")'] } }));
    assert.equal((await s.proj(['offload', 'x'])).code, 2);
  });

  test('lease host not in compute.knownHosts: exit 5', async () => {
    const s = await setup({ status: DEV('box.example.net'), known: 'other.example.net ssh-ed25519 AAAAC3Nza\n' });
    const r = await s.proj(['offload', 'npm test']);
    assert.equal(r.code, 5, r.out + r.err);
    assert.match(r.err, /host identity unverified/);
    assert.equal(s.ran(), null);
  });

  test('a known_hosts entry that merely contains the lease host is not a pinned key', async () => {
    const s = await setup({ status: DEV('box.example.net'), known: 'evilbox.example.net ssh-ed25519 AAAAC3Nza\n', exit: 0 });
    const r = await s.proj(['offload', 'npm test']);
    assert.equal(r.code, 5, 'evilbox.example.net accepted as the key for box.example.net');
    assert.equal(s.ran(), null);
  });

  test('pinned host: ships tracked + untracked files (not ignored ones) and passes the exit code through', async () => {
    const s = await setup({ status: DEV('box.example.net'), exit: 7, files: { '.gitignore': 'ignored.txt\n.env\n' } });
    write(s.root, 'untracked.txt', 'untracked\n');
    write(s.root, 'ignored.txt', 'IGNORED-MARKER\n');
    write(s.root, '.env', 'SECRET=hunter2\n');
    const avail = await s.proj(['offload']);
    assert.equal(avail.code, 0, avail.err);
    assert.match(avail.out, /available: box\.example\.net/);

    const r = await s.proj(['offload', 'npm test']);
    assert.equal(r.code, 7, r.out + r.err);
    const ran = s.ran();
    assert.equal(ran.args[0], '--timeout', 'ddc run --timeout <secs> <script>');
    assert.equal(ran.args[1], String(30 * 60 + 60));
    assert.ok(ran.bytes > 0);
    assert.match(ran.tar, /tracked\.txt/);
    assert.match(ran.tar, /untracked\.txt/);
    assert.doesNotMatch(ran.tar, /IGNORED-MARKER|hunter2/);

    fs.writeFileSync(s.scenario, JSON.stringify({ status: DEV('box.example.net'), exit: 0 }));
    assert.equal((await s.proj(['offload', 'npm test'])).code, 0);
  });

  test('offload works in a repo proj has never written state for', async () => {
    const s = await setup({ status: DEV('box.example.net'), exit: 7, stateDir: false });
    const r = await s.proj(['offload', 'npm test']);
    assert.doesNotMatch(r.err, /ENOENT/);
    assert.equal(r.code, 7);
  });

  test('refuses (exit 3) when a .env file is untracked and not ignored', async () => {
    const s = await setup({ status: DEV('box.example.net') });
    write(s.root, '.env', 'SECRET=hunter2\n');
    const r = await s.proj(['offload', 'npm test']);
    assert.equal(r.code, 3, r.out + r.err);
    assert.match(r.err, /secret-looking files would ship: \.env/);
    assert.equal(s.ran(), null, 'nothing was sent');
  });
});
