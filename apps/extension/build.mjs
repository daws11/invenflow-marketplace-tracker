// Copies the loadable extension files into ./dist so Chrome's "Load unpacked"
// can point at a clean folder (no package.json / README / build script). Zero
// dependencies — there is nothing to bundle (content scripts are plain
// classic scripts; the background SW is a native ES module).
//
// You can equally well load the package root directly in Chrome; `dist/` just
// keeps things tidy.

import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const ITEMS = [
  'manifest.json',
  'background.js',
  'lib',
  'content',
  'options.html',
  'options.js',
  'popup.html',
  'popup.js',
];

for (const item of ITEMS) {
  cpSync(join(root, item), join(dist, item), { recursive: true });
}

console.log(`Built extension -> ${dist}`);
