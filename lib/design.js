// proj shot: render a page to PNG with the local Chrome or Edge (headless), for design directions and critique.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { die, run, out } from './core.js';

const CANDIDATES = {
  win32: [
    `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
  linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'],
};

export function findBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const c of CANDIDATES[process.platform] || CANDIDATES.linux) {
    if (path.isAbsolute(c) ? fs.existsSync(c) : run(c, ['--version'], { timeout: 10000 }).code === 0) return c;
  }
  return null;
}

export function cmdShot(target, output, opts) {
  if (!target || !output) die('usage: proj shot <page.html[#state]|url> <out.png> [--width 1440] [--height 900] [--delay ms]');
  const browser = findBrowser();
  if (!browser) die('no Chrome, Edge or Chromium found: install one or set CHROME_PATH');
  // page.html#state: the page reads location.hash to show one interaction state (focus, error, menu open, ...).
  const [local, state] = target.split('#');
  const url = /^[a-z]+:\/\//i.test(target) ? target : pathToFileURL(path.resolve(local)).href + (state ? `#${state}` : '');
  const file = path.resolve(output);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(file, { force: true });
  const w = Number(opts.width || 1440); const h = Number(opts.height || 900);
  // Headless Chrome lays pages out at least ~500px wide and crops the shot, so a phone-width page would be
  // clipped: render it inside an iframe of exactly that width instead (its media queries see the real width).
  const tmp = w < 500 ? fs.mkdtempSync(path.join(os.tmpdir(), 'proj-shot-')) : null;
  let page = url;
  if (tmp) {
    fs.writeFileSync(path.join(tmp, 'frame.html'), `<!doctype html><body style="margin:0"><iframe src="${url.replace(/"/g, '%22')}" style="border:0;width:${w}px;height:${h}px;display:block"></iframe>`);
    page = pathToFileURL(path.join(tmp, 'frame.html')).href;
  }
  const r = run(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    // --delay: advance the page's clock so entrance animations and timers settle before the shot (motion end frames).
    `--window-size=${w},${h}`, ...(opts.delay ? [`--virtual-time-budget=${Number(opts.delay)}`] : []), `--screenshot=${file}`, page], { timeout: 60000 });
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  if (!fs.existsSync(file)) die(`screenshot failed (exit ${r.code}): ${r.err.split('\n').slice(-1)[0]}`);
  out(`${file} (${w}x${h})`);
}
