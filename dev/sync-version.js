'use strict';
// Copies the version from .homeycompose/app.json into package.json so both
// move together on every `npm run push`.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = JSON.parse(fs.readFileSync(path.join(root, '.homeycompose', 'app.json'), 'utf8'));
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

if (pkg.version !== app.version) {
  pkg.version = app.version;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`package.json version -> ${app.version}`);
}
