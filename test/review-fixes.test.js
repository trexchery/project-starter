// Regression tests for the final review: config opt-ins, importer-aware selection, command-aware reuse,
// quote-aware JUnit parsing, CRLF workflow files.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, write, tmpDir } from './helpers.js';
import { selectTests, priorPass } from '../lib/checks.js';
import { parseJunit, workflowTimeouts } from '../lib/perf.js';

describe('review fixes', { concurrency: true }, () => {
  test('a committed .proj.json cannot switch on external compute or self-hosted runners', async () => {
    const repo = await makeRepo({ projJson: { compute: { enabled: true, command: [process.execPath, '-e', 'process.exit(0)'] }, runner: { allowHost: true } } });
    const r = await repo.proj(['offload']);
    assert.equal(r.code, 4, r.out + r.err);
    assert.match(r.out + r.err, /offload is off/);
    const cfg = JSON.parse((await repo.proj(['config'])).out);
    assert.equal(cfg.compute.enabled, false);
    assert.equal(cfg.runner, undefined);
  });

  test('selectTests includes tests that import the changed module under another name', () => {
    const dir = tmpDir('sel-');
    write(dir, 'tests/util.test.js', "import u from '../src/util.js';\n");
    write(dir, 'tests/api.test.js', "import { u } from '../src/util.js';\nimport a from '../src/api.js';\n");
    const cfg = { testGlobs: ['tests/**/*.test.js'] };
    const tracked = ['src/util.js', 'src/api.js', 'tests/util.test.js', 'tests/api.test.js'];
    assert.deepEqual(selectTests(cfg, tracked, ['src/util.js'], dir).tests.sort(), ['tests/api.test.js', 'tests/util.test.js']);
    // a deleted test file is not handed to the runner
    assert.deepEqual(selectTests(cfg, tracked, ['tests/gone.test.js', 'src/api.js'], dir).tests, ['tests/api.test.js']);
  });

  test('a recorded pass stops counting once the configured command changes', () => {
    const st = { checks: { abc: [{ kind: 'full', cmd: 'npm test', exit: 0, dirty: false }] } };
    assert.ok(priorPass(st, 'abc', 'full', { full: 'npm test' }));
    assert.equal(priorPass(st, 'abc', 'full', { full: 'npm test -- --coverage' }), null);
    assert.equal(priorPass(st, 'abc', 'affected', { full: 'npm test -- --coverage' }), null, 'a stale full pass does not satisfy affected either');
  });

  test('parseJunit: ">" inside attributes, and describe time from top-level suites', () => {
    const xml = `<testsuites>
  <testsuite name="a > b" time="2.5" file="/r/test/a.test.js">
    <testcase name="x > y" time="0.5" file="/r/test/a.test.js"/>
    <testcase name="z" time="0.5" file="/r/test/a.test.js"/>
  </testsuite>
  <testcase name="top" time="0.25" file="/r/test/b.test.js"/>
</testsuites>`;
    const j = parseJunit(xml, '/r');
    assert.equal(j.tests, 3);
    assert.deepEqual(j.files, { 'test/a.test.js': 2.5, 'test/b.test.js': 0.25 }); // hooks/body time of the describe kept
  });

  test('workflowTimeouts reads CRLF workflow files', () => {
    const dir = tmpDir('wf-');
    write(dir, '.github/workflows/ci.yml', 'name: CI\r\njobs:\r\n  verify:\r\n    runs-on: x\r\n    timeout-minutes: 12\r\n');
    assert.deepEqual(workflowTimeouts(dir), { 'CI/verify': 12 });
  });
});
