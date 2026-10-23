'use strict';
// Renders the real keypad widget with headless Edge/Chrome into dev/art/*.png,
// used by dev/render-images.js for the app store composition. The store
// widget previews themselves are simple-shape mockups (guideline), drawn there.
// Usage: npm run previews
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const candidates = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];
const browser = candidates.find(p => fs.existsSync(p));
if (!browser) throw new Error('No Edge/Chrome found for headless rendering');

const page = `file:///${path.join(root, 'dev', 'widget-shot.html').replace(/\\/g, '/')}`;
const shots = [
  { out: 'dev/art/widget-light.png', query: 'state=disarmed' },
  { out: 'dev/art/widget-dark.png', query: 'state=armed&dark=1' },
];
for (const s of shots) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'homey-shot-'));
  execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--allow-file-access-from-files', '--hide-scrollbars', '--no-first-run',
    `--user-data-dir=${profile}`, '--force-device-scale-factor=2', '--window-size=400,420',
    '--virtual-time-budget=2000', '--default-background-color=00000000',
    `--screenshot=${path.join(root, s.out)}`, `${page}?${s.query}`,
  ], { stdio: 'ignore' });
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (err) { /* browser may still hold files */ }
  console.log('rendered', s.out, fs.statSync(path.join(root, s.out)).size, 'bytes');
}
