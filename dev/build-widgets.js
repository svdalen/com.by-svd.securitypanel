'use strict';
// Inlines dev/widget-shared.js into every widget between the shared markers,
// then rebuilds the mock harness pages for the keypad widget.
// Usage: npm run widgets
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const write = (p, s) => fs.writeFileSync(path.join(root, p), s);

const START = '      /* shared:start */';
const END = '      /* shared:end */';
const shared = read('dev/widget-shared.js').trim().split('\n').map(l => (l ? '      ' + l : '')).join('\n');

for (const id of fs.readdirSync(path.join(root, 'widgets'))) {
  const file = `widgets/${id}/public/index.html`;
  if (!fs.existsSync(path.join(root, file))) continue;
  const html = read(file);
  const a = html.indexOf(START);
  const b = html.indexOf(END);
  if (a < 0 || b < 0) { console.log('no shared block in', file); continue; }
  const out = html.slice(0, a + START.length) + '\n' + shared + '\n' + html.slice(b);
  if (out !== html) { write(file, out); console.log('updated', file); } else console.log('unchanged', file);
}

// Mock harness pages: the real keypad widget plus a mock Homey client tail.
const keypad = read('widgets/keypad/public/index.html');
const head = keypad.slice(0, keypad.lastIndexOf('</body>'));
const font = '<style id="shot-font">body{font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}</style>';
const dark = '<style>body.homey-dark-mode{color:#f2f2f7;background:#1c1c1e}</style>';
for (const [file, marker, extra] of [
  ['dev/widget-shot.html', '<script>\n(function(){\n  var q = new URLSearchParams', font + '\n' + dark + '\n'],
  ['dev/widget-preview.html', '<script>\n(function(){\n  var listeners', ''],
]) {
  const page = read(file);
  const i = page.lastIndexOf(marker);
  if (i < 0) { console.log('mock tail not found in', file); continue; }
  write(file, head + extra + page.slice(i));
  console.log('rebuilt', file);
}
