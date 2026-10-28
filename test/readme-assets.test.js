// README art is shown by GitHub as plain images: self-contained, accessible, small, and every local link resolves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.js';

const DIR = path.join(ROOT, 'docs', 'assets', 'readme');

test('README svgs: title, desc, viewBox, no script or external refs, under 10 KB', () => {
  const svgs = fs.readdirSync(DIR).filter((f) => f.endsWith('.svg'));
  assert.ok(svgs.length >= 3);
  for (const f of svgs) {
    const text = fs.readFileSync(path.join(DIR, f), 'utf8');
    assert.ok(Buffer.byteLength(text) < 10240, `${f} is over 10 KB`);
    for (const re of [/<title[^>]*>[^<]+<\/title>/, /<desc[^>]*>[^<]+<\/desc>/, /\sviewBox="[\d.\s]+"/, /role="img"/]) assert.match(text, re, f);
    assert.doesNotMatch(text, /<script|<foreignObject|@import|@font-face/i, f);
    assert.doesNotMatch(text, /(?:href|src)\s*=\s*["'](?!#)|url\((?!#)/i, `${f} references something outside itself`);
  }
});

test('README references only local files that exist', () => {
  const md = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const refs = [...md.matchAll(/(?:src|href)="([^"]+)"|\]\(([^)]+)\)/g)].map((m) => m[1] || m[2]).filter((r) => !/^(https?:|#|mailto:)/.test(r));
  assert.ok(refs.some((r) => r.startsWith('docs/assets/readme/')));
  for (const r of refs) assert.ok(fs.existsSync(path.join(ROOT, r.split('#')[0])), `README links a missing file: ${r}`);
});
