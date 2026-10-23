'use strict';
// Renders the real widgets with headless Edge/Chrome:
//  - widgets/<id>/preview-light.png and preview-dark.png (1024x1024,
//    transparent, the widget as a dashboard tile) for the App Store
//  - dev/art/widget-light.png and widget-dark.png, embedded in the app
//    images by dev/render-images.js
// Usage: npm run previews   (then npm run images for the app images)
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

const pageUrl = file => `file:///${path.join(root, 'dev', file).replace(/\\/g, '/')}`;

const shots = [
  // store previews: the tile on a transparent 512x512 page, rendered at 2x
  { out: 'widgets/keypad/preview-light.png', page: 'preview-shot.html', query: 'widget=keypad&state=disarmed', size: [512, 512] },
  { out: 'widgets/keypad/preview-dark.png', page: 'preview-shot.html', query: 'widget=keypad&state=armed&dark=1', size: [512, 512] },
  { out: 'widgets/sensors/preview-light.png', page: 'preview-shot.html', query: 'widget=sensors', size: [512, 512] },
  { out: 'widgets/sensors/preview-dark.png', page: 'preview-shot.html', query: 'widget=sensors&dark=1', size: [512, 512] },
  { out: 'widgets/timeline/preview-light.png', page: 'preview-shot.html', query: 'widget=timeline&window=all', size: [512, 512] },
  { out: 'widgets/timeline/preview-dark.png', page: 'preview-shot.html', query: 'widget=timeline&window=all&dark=1', size: [512, 512] },
  // the keypad on its own, for the app images
  { out: 'dev/art/widget-light.png', page: 'widget-shot.html', query: 'state=disarmed&w=400&h=420', size: [416, 428] },
  { out: 'dev/art/widget-dark.png', page: 'widget-shot.html', query: 'state=armed&dark=1&w=400&h=420', size: [416, 428] },
];

for (const s of shots) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'homey-shot-'));
  const out = path.join(root, s.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--allow-file-access-from-files', '--hide-scrollbars', '--no-first-run',
    `--user-data-dir=${profile}`, '--force-device-scale-factor=2', `--window-size=${s.size[0]},${s.size[1]}`,
    '--default-background-color=00000000', '--virtual-time-budget=3000',
    `--screenshot=${out}`, `${pageUrl(s.page)}?${s.query}`,
  ], { stdio: 'ignore' });
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (err) { /* the browser may still hold a lock; the temp dir is harmless */ }
  console.log('rendered', s.out, fs.statSync(out).size, 'bytes');
}
