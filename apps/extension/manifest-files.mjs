// The files/folders Chrome needs to "Load unpacked" — kept in one place so
// build.mjs (copies them into dist/) and build-zip.mjs (packs them into the
// downloadable zip served by the web app) can't drift. Add a new top-level
// extension file here and both build paths pick it up.
export const LOADABLE_ITEMS = [
  'manifest.json',
  'background.js',
  'lib',
  'content',
  'options.html',
  'options.js',
  'popup.html',
  'popup.js',
];
