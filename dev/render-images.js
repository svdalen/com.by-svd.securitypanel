'use strict';
// Renders every store image from vector sources with resvg (deterministic):
//  - driver images: white background, recognisable illustration of the device
//  - app images: composition of the keypad illustration and the widget
//  - widget previews: 1024x1024 transparent, simplified shapes, no text (App Store guideline)
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
// App Store guideline: 1024x1024, transparent background, simplified shapes,
// no text, no screenshots; light and dark. Drawn to match the widgets' real
// surfaces: a state-tinted header, naked rows with hairlines, tinted open rows.
const SHADOW = dark => `<defs><filter id="sh" x="-10%" y="-10%" width="120%" height="120%"><feDropShadow dx="0" dy="24" stdDeviation="28" flood-color="#000" flood-opacity="${dark ? '.5' : '.22'}"/></filter></defs>`;
const palette = dark => ({
  card: dark ? '#1c1c1e' : '#ffffff',
  key: dark ? '#2c2c2e' : '#f2f2f7',
  text: dark ? '#48484a' : '#d1d1d6',
  line: dark ? '#2e2e31' : '#e8e8ec',
  greenTint: dark ? '#1e2f22' : '#e3f6e8',
  amberTint: dark ? '#3a2d1f' : '#ffefd6',
  redTint: dark ? '#3a1f1f' : '#ffe2e0',
});
const tile = (dark, inner, extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  ${SHADOW(dark)}
  <g filter="url(#sh)"><rect x="92" y="92" width="840" height="840" rx="64" fill="${palette(dark).card}"${extra}/></g>
  ${inner}
</svg>`;
const shieldPath = (cx, cy, s, color, w) => `<path d="M${cx} ${cy - 10 * s}l${9 * s} ${3.6 * s}v${6.4 * s}c0 ${5.6 * s}-${4 * s} ${9.4 * s}-${9 * s} ${11.2 * s}-${5 * s}-${1.8 * s}-${9 * s}-${5.6 * s}-${9 * s}-${11.2 * s}v-${6.4 * s}z" fill="none" stroke="${color}" stroke-width="${w}" stroke-linejoin="round"/>`;
const housePath = (cx, cy, s, color, w) => `<path d="M${cx - 9 * s} ${cy - 1 * s}l${9 * s}-${8 * s} ${9 * s} ${8 * s}v${10 * s}h-${18 * s}z" fill="none" stroke="${color}" stroke-width="${w}" stroke-linejoin="round"/>`;

// Sensor row: icon mark, name bar + zone bar, mode marks, state dot + bar. `tint` tints the row.
function sensorRow(p, y, { tint = null, open = false, modes = true, nameW = 280 } = {}) {
  const dot = tint === 'red' ? '#ff3b30' : open ? '#ff9500' : '#34c759';
  const bg = tint === 'red' ? p.redTint : tint === 'amber' ? p.amberTint : null;
  return `${bg ? `<rect x="132" y="${y}" width="760" height="84" rx="20" fill="${bg}"/>` : `<rect x="148" y="${y}" width="728" height="2" fill="${p.line}"/>`}
  <rect x="156" y="${y + 24}" width="36" height="36" rx="9" fill="${p.text}"/>
  <rect x="214" y="${y + 22}" width="${nameW}" height="20" rx="10" fill="${p.text}"/>
  <rect x="214" y="${y + 52}" width="110" height="12" rx="6" fill="${p.text}" opacity=".6"/>
  ${modes ? `${shieldPath(654, y + 42, 1.6, '#ff3b30', 3)}${housePath(690, y + 44, 1.6, '#ff9500', 3)}` : ''}
  <circle cx="752" cy="${y + 42}" r="9" fill="${dot}"/>
  <rect x="772" y="${y + 33}" width="${open || tint ? 72 : 96}" height="18" rx="9" fill="${dot}" opacity="${open || tint ? '.85' : '.55'}"/>`;
}

function widgetPreview(dark) {
  const p = palette(dark);
  if (!dark) {
    // Disarmed: green header, naked rows (one open row tinted), Arm / Home keys
    const rows = [];
    for (let r = 0; r < 6; r++) rows.push(sensorRow(p, 296 + r * 86, { open: r === 0, tint: r === 0 ? 'amber' : null, nameW: 260 + (r % 3) * 50 }));
    return tile(dark, `
  <rect x="132" y="140" width="760" height="124" rx="30" fill="${p.greenTint}"/>
  <rect x="156" y="164" width="76" height="76" rx="22" fill="#34c759" opacity=".25"/>
  <rect x="178" y="196" width="32" height="24" rx="5" fill="none" stroke="#34c759" stroke-width="5"/><path d="M186 196v-8a8 8 0 0 1 16-2" fill="none" stroke="#34c759" stroke-width="5" stroke-linecap="round"/>
  <rect x="256" y="176" width="240" height="28" rx="14" fill="${p.text}"/>
  <rect x="256" y="214" width="150" height="16" rx="8" fill="#34c759" opacity=".5"/>
  ${rows.join('\n  ')}
  <rect x="132" y="824" width="368" height="84" rx="24" fill="${p.key}"/>
  <rect x="524" y="824" width="368" height="84" rx="24" fill="${p.key}"/>
  ${shieldPath(290, 866, 2.4, '#ff3b30', 5)}<rect x="322" y="856" width="90" height="20" rx="10" fill="${p.text}"/>
  ${housePath(682, 870, 2.4, '#ff9500', 5)}<rect x="716" y="856" width="90" height="20" rx="10" fill="${p.text}"/>`);
  }
  // Armed: the crimson-to-charcoal tile, glow ring with a shield, one Disarm key
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  ${SHADOW(true)}
  <defs>
    <linearGradient id="armed" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7a1410"/><stop offset=".6" stop-color="#3a0c0a"/><stop offset="1" stop-color="#1c1c1e"/></linearGradient>
    <radialGradient id="glow"><stop offset="0" stop-color="#ff5a50" stop-opacity=".5"/><stop offset="1" stop-color="#ff5a50" stop-opacity="0"/></radialGradient>
  </defs>
  <g filter="url(#sh)"><rect x="92" y="92" width="840" height="840" rx="64" fill="url(#armed)"/></g>
  <circle cx="512" cy="150" r="7" fill="#ff5a50"/><rect x="532" y="142" width="110" height="16" rx="8" fill="#ffffff" opacity=".35"/>
  <circle cx="512" cy="420" r="150" fill="url(#glow)"/>
  <circle cx="512" cy="420" r="120" fill="none" stroke="#ff7b72" stroke-width="3" opacity=".6"/>
  <path d="M512 334l76 30v54c0 48-34 80-76 96-42-16-76-48-76-96v-54z" fill="none" stroke="#ff7b72" stroke-width="12" stroke-linejoin="round"/>
  <path d="M476 426l26 26 48-54" fill="none" stroke="#ff7b72" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="402" y="606" width="220" height="38" rx="19" fill="#ffffff"/>
  <rect x="352" y="664" width="320" height="18" rx="9" fill="#ffffff" opacity=".45"/>
  <rect x="132" y="808" width="760" height="100" rx="28" fill="none" stroke="#ffffff" stroke-opacity=".35" stroke-width="4"/>
  <rect x="464" y="844" width="40" height="30" rx="7" fill="none" stroke="#4cd964" stroke-width="6"/><path d="M472 844v-9a11 11 0 0 1 22-4" fill="none" stroke="#4cd964" stroke-width="6" stroke-linecap="round"/>
  <rect x="520" y="848" width="70" height="20" rx="10" fill="#ffffff"/>
</svg>`;
}
write('widgets/keypad/preview-light.png', render(widgetPreview(false), 1024));
write('widgets/keypad/preview-dark.png', render(widgetPreview(true), 1024));

// Sensor status widget: summary bar, zone captions, naked rows (one open, one tamper)
function sensorsPreview(dark) {
  const p = palette(dark);
  const caption = y => `<rect x="148" y="${y}" width="120" height="14" rx="7" fill="${p.text}" opacity=".7"/>`;
  const rows = [
    caption(196),
    sensorRow(p, 224, { open: true, tint: 'amber', modes: false, nameW: 300 }),
    sensorRow(p, 312, { modes: false, nameW: 340 }),
    caption(416),
    sensorRow(p, 444, { tint: 'red', modes: false, nameW: 280 }),
    `<rect x="214" y="512" width="36" height="36" rx="9" fill="none" stroke="#ff3b30" stroke-width="3" transform="translate(-40 -8) scale(.9)"/><rect x="230" y="526" width="190" height="14" rx="7" fill="#ff3b30" opacity=".7"/>`,
    sensorRow(p, 556, { modes: false, nameW: 260 }),
    caption(660),
    sensorRow(p, 688, { modes: false, nameW: 320 }),
    sensorRow(p, 776, { modes: false, nameW: 240 }),
  ];
  return tile(dark, `
  <rect x="148" y="140" width="200" height="18" rx="9" fill="${p.text}"/>
  <rect x="364" y="142" width="150" height="14" rx="7" fill="${p.text}" opacity=".6"/>
  <rect x="660" y="142" width="216" height="14" rx="7" fill="${p.text}" opacity=".6"/>
  ${rows.join('\n  ')}`);
}
write('widgets/sensors/preview-light.png', render(sensorsPreview(false), 1024));
write('widgets/sensors/preview-dark.png', render(sensorsPreview(true), 1024));

// Timeline widget: a text timeline, time bars left of a vertical line with coloured dots, bars for header and sub line, a red episode band
function timelinePreview(dark) {
  const p = palette(dark);
  const entries = [];
  const ys = [196, 290, 384, 470, 552, 634, 716, 810];
  const kinds = ['open', 'clear', 'open', 'sys', 'red', 'red', 'red', 'clear'];
  for (let i = 0; i < ys.length; i++) {
    const y = ys[i], k = kinds[i];
    const dot = k === 'open' ? '#ff9500' : k === 'red' ? '#ff3b30' : k === 'sys' ? '#34c759' : '#34c759';
    entries.push(`<rect x="152" y="${y + 4}" width="72" height="16" rx="8" fill="${p.text}" opacity=".7"/>
  <circle cx="262" cy="${y + 12}" r="${k === 'sys' || k === 'red' ? 8 : 10}" fill="${dot}"/>
  <rect x="300" y="${y}" width="${k === 'sys' ? 160 : 260 + (i % 3) * 60}" height="${k === 'sys' || k === 'red' ? 20 : 24}" rx="10" fill="${k === 'red' ? '#ff3b30' : k === 'sys' ? '#34c759' : p.text}" opacity="${k === 'red' || k === 'sys' ? '.8' : '1'}"/>
  ${k === 'open' || k === 'clear' ? `<rect x="300" y="${y + 34}" width="60" height="14" rx="7" fill="${k === 'open' ? '#ff9500' : '#34c759'}" opacity=".8"/><rect x="372" y="${y + 34}" width="120" height="14" rx="7" fill="${p.text}" opacity=".6"/>` : ''}`);
  }
  return tile(dark, `
  <rect x="300" y="140" width="110" height="14" rx="7" fill="${p.text}" opacity=".6"/>
  <rect x="261" y="196" width="3" height="660" fill="${p.line}"/>
  <rect x="286" y="540" width="600" height="206" rx="14" fill="${p.redTint}" opacity=".7"/>
  ${entries.join('\n  ')}`);
}
write('widgets/timeline/preview-light.png', render(timelinePreview(false), 1024));
write('widgets/timeline/preview-dark.png', render(timelinePreview(true), 1024));
