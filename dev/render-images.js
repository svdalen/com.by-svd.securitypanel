'use strict';
// Renders every store image from vector sources with resvg (deterministic):
//  - driver images: white background, recognisable illustration of the device
//  - app images: composition of the keypad illustration and the widget
//  - widget previews are real renders, see dev/render-previews.js (npm run previews)
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
