// Packs the loadable extension files into a single zip the web app serves at
// /extension.zip (Settings → Extension → "Download extension"). Output lands in
// apps/web/public/extension.zip, which the web Docker image already ships
// (apps/web/Dockerfile copies apps/web/public into the runner). Wired into the
// web app's `build` + `dev` scripts so the artifact is always fresh.
//
// Zero dependencies on purpose (matches build.mjs + the codebase's
// no-new-packages ethos). Node 20 has no zlib.crc32 (added in 22.2) and the
// extension is only tens of KB, so we emit STORED (uncompressed) zip entries
// with a hand-rolled CRC32 rather than pulling in an archive library.

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOADABLE_ITEMS } from './manifest-files.mjs';

const root = dirname(fileURLToPath(import.meta.url));
// apps/extension -> apps/web/public/extension.zip
const outFile = join(root, '..', 'web', 'public', 'extension.zip');

// ---------------------------------------------------------------------------
// CRC32 (IEEE 802.3, reflected) — table built once, computed over raw bytes.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Collect every file under the loadable items, with forward-slash zip paths.
// ---------------------------------------------------------------------------

/** @returns {Array<{ name: string, data: Buffer }>} */
function collectEntries() {
  const entries = [];
  const walk = (absPath, zipPath) => {
    const st = statSync(absPath);
    if (st.isDirectory()) {
      for (const child of readdirSync(absPath).sort()) {
        walk(join(absPath, child), posix.join(zipPath, child));
      }
    } else {
      entries.push({ name: zipPath, data: readFileSync(absPath) });
    }
  };
  for (const item of LOADABLE_ITEMS) {
    walk(join(root, item), item);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Minimal ZIP writer — STORED entries only (no compression).
// ---------------------------------------------------------------------------

// Fixed DOS timestamp so the zip is byte-stable across builds (no churn from
// mtime). 1980-01-01 00:00:00 — the zip epoch.
const DOS_TIME = 0;
const DOS_DATE = 0x21; // (1980-1980)<<9 | 1<<5 | 1

function localHeader(entry) {
  const nameBuf = Buffer.from(entry.name, 'utf8');
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0); // local file header signature
  head.writeUInt16LE(20, 4); // version needed to extract (2.0)
  head.writeUInt16LE(0, 6); // general purpose flags
  head.writeUInt16LE(0, 8); // compression method: 0 = stored
  head.writeUInt16LE(DOS_TIME, 10);
  head.writeUInt16LE(DOS_DATE, 12);
  head.writeUInt32LE(entry.crc, 14);
  head.writeUInt32LE(entry.data.length, 18); // compressed size
  head.writeUInt32LE(entry.data.length, 22); // uncompressed size
  head.writeUInt16LE(nameBuf.length, 26);
  head.writeUInt16LE(0, 28); // extra field length
  return Buffer.concat([head, nameBuf, entry.data]);
}

function centralHeader(entry) {
  const nameBuf = Buffer.from(entry.name, 'utf8');
  const head = Buffer.alloc(46);
  head.writeUInt32LE(0x02014b50, 0); // central directory header signature
  head.writeUInt16LE(20, 4); // version made by
  head.writeUInt16LE(20, 6); // version needed to extract
  head.writeUInt16LE(0, 8); // flags
  head.writeUInt16LE(0, 10); // compression: stored
  head.writeUInt16LE(DOS_TIME, 12);
  head.writeUInt16LE(DOS_DATE, 14);
  head.writeUInt32LE(entry.crc, 16);
  head.writeUInt32LE(entry.data.length, 20); // compressed size
  head.writeUInt32LE(entry.data.length, 24); // uncompressed size
  head.writeUInt16LE(nameBuf.length, 28);
  head.writeUInt16LE(0, 30); // extra field length
  head.writeUInt16LE(0, 32); // comment length
  head.writeUInt16LE(0, 34); // disk number start
  head.writeUInt16LE(0, 36); // internal attributes
  head.writeUInt32LE(0, 38); // external attributes
  head.writeUInt32LE(entry.offset, 42); // local header offset
  return Buffer.concat([head, nameBuf]);
}

function buildZip(entries) {
  const locals = [];
  let offset = 0;
  for (const entry of entries) {
    entry.crc = crc32(entry.data);
    entry.offset = offset;
    const local = localHeader(entry);
    locals.push(local);
    offset += local.length;
  }

  const centrals = entries.map(centralHeader);
  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const centralOffset = offset;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4); // this disk number
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(entries.length, 8); // entries on this disk
  end.writeUInt16LE(entries.length, 10); // total entries
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, ...centrals, end]);
}

// ---------------------------------------------------------------------------

const entries = collectEntries();
const zip = buildZip(entries);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, zip);

console.log(
  `Packed extension -> ${outFile} (${entries.length} files, ${zip.length} bytes)`,
);
