'use strict';
// Renders every store image from vector sources with resvg (deterministic):
//  - driver images: white background, recognisable illustration of the device
//  - app images: composition of the keypad illustration and the widget
//  - widget previews: 1024x1024 transparent, simple shapes, light and dark
// Usage: npm run images
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const inner = svg => svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const render = (svg, w) => new Resvg(svg, { fitTo: { mode: 'width', value: w } }).render().asPng();
const write = (rel, png) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), png);
  console.log('rendered', rel, png.length, 'bytes');
};

// ---------------------------------------------------------------- driver images
function deviceImage(artFile, w, h, scale = 0.9) {
  const art = inner(read(artFile));
  const size = Math.min(w, h) * scale;
  const s = size / 400; // art uses a 0..400 viewBox
  const tx = (w - size) / 2;
  const ty = (h - size) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="#ffffff"/>
  <g transform="translate(${tx} ${ty}) scale(${s})">${art}</g>
</svg>`;
}
for (const [art, out] of [['dev/art/security-panel.svg', 'drivers/panel/assets/images'], ['dev/art/ring-keypad.svg', 'drivers/ring_keypad/assets/images']]) {
  for (const [name, size] of Object.entries({ small: 75, large: 500, xlarge: 1000 })) {
    write(`${out}/${name}.png`, render(deviceImage(art, size, size), size));
  }
}

// ------------------------------------------------------------------ app images
// Composition: brand blue background, keypad illustration left, the widget's
// real render (dev/art/widget-light.png, refresh with: npm run previews then copy) on the right.
function appImage(w, h) {
  const keypad = inner(read('dev/art/ring-keypad.svg'));
  const shield = inner(read('assets/icon.svg'));
  const widgetPng = fs.readFileSync(path.join(root, 'dev/art/widget-light.png')).toString('base64');
  const u = w / 1000; // design at 1000x700
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 1000 700">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0a84ff"/><stop offset="1" stop-color="#0060c0"/></linearGradient>
    <filter id="sh" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#000" flood-opacity=".35"/></filter>
    <clipPath id="card"><rect x="520" y="140" width="400" height="420" rx="28"/></clipPath>
  </defs>
  <rect width="1000" height="700" fill="url(#bg)"/>
  <g opacity=".12" transform="translate(-40 380) scale(3.2)" fill="#ffffff">${shield}</g>
  <g transform="translate(60 110) scale(1.2)">${keypad}</g>
  <g filter="url(#sh)"><rect x="520" y="140" width="400" height="420" rx="28" fill="#ffffff"/></g>
  <image href="data:image/png;base64,${widgetPng}" x="520" y="140" width="400" height="420" preserveAspectRatio="xMidYMid meet" clip-path="url(#card)"/>
</svg>`.replace('${u}', String(u));
}
for (const [name, [w, h]] of Object.entries({ small: [250, 175], large: [500, 350], xlarge: [1000, 700] })) {
  write(`assets/images/${name}.png`, render(appImage(w, h), w));
}

// ------------------------------------------------------------- widget previews
// Guideline: 1024x1024, transparent, simple shapes, no text, light + dark.
function widgetPreview(dark) {
  const card = dark ? '#1c1c1e' : '#ffffff';
  const key = dark ? '#2c2c2e' : '#f2f2f7';
  const text = dark ? '#48484a' : '#d1d1d6';
  const shadow = `<defs><filter id="sh" x="-10%" y="-10%" width="120%" height="120%"><feDropShadow dx="0" dy="24" stdDeviation="28" flood-color="#000" flood-opacity="${dark ? '.5' : '.22'}"/></filter></defs>`;
  if (!dark) {
    // Disarmed view: status bar, sensor rows (icon, name bar, mode pill), Arm / Home keys
    const rows = [];
    for (let r = 0; r < 6; r++) {
      const y = 300 + r * 84;
      rows.push(`<rect x="132" y="${y}" width="760" height="68" rx="22" fill="${r === 0 ? '#ffefd6' : key}"/>
  <rect x="156" y="${y + 18}" width="32" height="32" rx="8" fill="${text}"/>
  <rect x="212" y="${y + 24}" width="${260 + (r % 3) * 60}" height="20" rx="10" fill="${text}"/>
  <rect x="780" y="${y + 16}" width="88" height="36" rx="12" fill="${dark ? '#3a3a3c' : '#e3e3e8'}"/>
  <circle cx="806" cy="${y + 34}" r="9" fill="#ff3b30"/><circle cx="842" cy="${y + 34}" r="9" fill="#ff9500" opacity="${r === 2 || r === 4 ? '.25' : '1'}"/>`);
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  ${shadow}
  <g filter="url(#sh)"><rect x="92" y="92" width="840" height="840" rx="64" fill="${card}"/></g>
  <rect x="132" y="140" width="760" height="120" rx="30" fill="${key}"/>
  <circle cx="196" cy="200" r="22" fill="#34c759"/>
  <rect x="244" y="176" width="260" height="30" rx="15" fill="${text}"/>
  <rect x="244" y="216" width="120" height="16" rx="8" fill="${text}" opacity=".6"/>
  ${rows.join('\n  ')}
  <rect x="132" y="824" width="368" height="84" rx="24" fill="${key}"/>
  <rect x="524" y="824" width="368" height="84" rx="24" fill="${key}"/>
  <path d="M316 846l20 8v14c0 12-9 20-20 24-11-4-20-12-20-24v-14z" fill="none" stroke="#ff3b30" stroke-width="5" stroke-linejoin="round"/>
  <path d="M690 870l18-16 18 16v20h-36z" fill="none" stroke="#ff9500" stroke-width="5" stroke-linejoin="round"/>
</svg>`;
  }
  // Armed view: bordered panel with a shield mark and one Disarm key
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  ${shadow}
  <g filter="url(#sh)"><rect x="92" y="92" width="840" height="840" rx="64" fill="${card}" stroke="#ff3b30" stroke-width="10"/></g>
  <rect x="132" y="140" width="760" height="620" rx="36" fill="#2b1f1f"/>
  <path d="M512 300l90 36v64c0 56-40 94-90 112-50-18-90-56-90-112v-64z" fill="none" stroke="#ff3b30" stroke-width="22" stroke-linejoin="round"/>
  <path d="M470 418l30 30 54-60" fill="none" stroke="#ff3b30" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="402" y="560" width="220" height="34" rx="17" fill="#ff3b30"/>
  <rect x="362" y="620" width="300" height="18" rx="9" fill="#6e5a5a"/>
  <rect x="132" y="800" width="760" height="100" rx="28" fill="${key}"/>
  <rect x="490" y="836" width="44" height="34" rx="8" fill="none" stroke="#34c759" stroke-width="6"/>
  <path d="M500 836v-10a12 12 0 0 1 24-4" fill="none" stroke="#34c759" stroke-width="6" stroke-linecap="round"/>
</svg>`;
}
write('widgets/keypad/preview-light.png', render(widgetPreview(false), 1024));
write('widgets/keypad/preview-dark.png', render(widgetPreview(true), 1024));

// Sensor status widget: a short list of rows (icon, name bar, state dot + bar), no card chrome.
function sensorsPreview(dark) {
  const card = dark ? '#1c1c1e' : '#ffffff';
  const key = dark ? '#2c2c2e' : '#f2f2f7';
  const text = dark ? '#48484a' : '#d1d1d6';
  const rows = [];
  for (let r = 0; r < 5; r++) {
    const y = 160 + r * 148;
    const open = r === 0;
    rows.push(`<rect x="132" y="${y}" width="760" height="124" rx="28" fill="${open ? (dark ? '#3a2d1f' : '#ffefd6') : key}"/>
  <rect x="168" y="${y + 40}" width="44" height="44" rx="10" fill="${text}"/>
  <rect x="244" y="${y + 34}" width="${280 + (r % 3) * 70}" height="26" rx="13" fill="${text}"/>
  <rect x="244" y="${y + 74}" width="140" height="16" rx="8" fill="${text}" opacity=".6"/>
  <circle cx="724" cy="${y + 50}" r="12" fill="${open ? '#ff9500' : '#34c759'}"/>
  <rect x="748" y="${y + 38}" width="110" height="24" rx="12" fill="${open ? '#ff9500' : text}" opacity="${open ? '.8' : '1'}"/>
  <rect x="700" y="${y + 76}" width="158" height="14" rx="7" fill="${text}" opacity=".6"/>`);
  }
  const shadow = `<defs><filter id="sh" x="-10%" y="-10%" width="120%" height="120%"><feDropShadow dx="0" dy="24" stdDeviation="28" flood-color="#000" flood-opacity="${dark ? '.5' : '.22'}"/></filter></defs>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  ${shadow}
  <g filter="url(#sh)"><rect x="92" y="92" width="840" height="840" rx="64" fill="${card}"/></g>
  ${rows.join('\n  ')}
</svg>`;
}
write('widgets/sensors/preview-light.png', render(sensorsPreview(false), 1024));
write('widgets/sensors/preview-dark.png', render(sensorsPreview(true), 1024));

// Timeline widget: time bar, icon, name bar and a state pill per row, one muted system row.
function timelinePreview(dark) {
  const card = dark ? '#1c1c1e' : '#ffffff';
  const key = dark ? '#2c2c2e' : '#f2f2f7';
  const text = dark ? '#48484a' : '#d1d1d6';
  const rows = [];
  for (let r = 0; r < 6; r++) {
    const y = 150 + r * 124;
    if (r === 3) {
      rows.push(`<rect x="132" y="${y}" width="760" height="100" rx="24" fill="${key}" opacity=".6"/>
  <rect x="380" y="${y + 40}" width="264" height="20" rx="10" fill="${text}"/>`);
      continue;
    }
    const open = r % 2 === 0;
    rows.push(`<rect x="132" y="${y}" width="760" height="100" rx="24" fill="${key}"/>
  <rect x="160" y="${y + 38}" width="88" height="24" rx="12" fill="${text}"/>
  <rect x="276" y="${y + 30}" width="40" height="40" rx="10" fill="${text}"/>
  <rect x="340" y="${y + 26}" width="${220 + (r % 3) * 60}" height="24" rx="12" fill="${text}"/>
  <rect x="340" y="${y + 62}" width="120" height="14" rx="7" fill="${text}" opacity=".6"/>
  <circle cx="760" cy="${y + 50}" r="11" fill="${open ? '#ff9500' : '#34c759'}"/>
  <rect x="784" y="${y + 39}" width="84" height="22" rx="11" fill="${open ? '#ff9500' : text}" opacity="${open ? '.8' : '1'}"/>`);
  }
  const shadow = `<defs><filter id="sh" x="-10%" y="-10%" width="120%" height="120%"><feDropShadow dx="0" dy="24" stdDeviation="28" flood-color="#000" flood-opacity="${dark ? '.5' : '.22'}"/></filter></defs>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  ${shadow}
  <g filter="url(#sh)"><rect x="92" y="92" width="840" height="840" rx="64" fill="${card}"/></g>
  ${rows.join('\n  ')}
</svg>`;
}
write('widgets/timeline/preview-light.png', render(timelinePreview(false), 1024));
write('widgets/timeline/preview-dark.png', render(timelinePreview(true), 1024));

