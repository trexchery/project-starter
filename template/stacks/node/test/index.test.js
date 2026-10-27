import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hello } from '../src/index.js';

test('hello greets by name', () => {
  assert.equal(hello('proj'), 'hello, proj');
});
