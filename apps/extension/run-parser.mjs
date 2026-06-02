#!/usr/bin/env node
// Standalone harness for the extension's marketplace parsers — iterate on parser
// logic without rebuilding/reinstalling the Chrome extension.
//
//   node apps/extension/run-parser.mjs tokopedia
//   node apps/extension/run-parser.mjs tokopedia path/to/fixture.json
//
// It loads parse-common.js + parse-<platform>.js (browser IIFEs that attach to
// globalThis.__ifScraper), then calls the registered parser with the SAME
// { responses, document } shape bridge.js feeds it. Fixtures are arrays of
// { url, body } captured from real logged-in traffic (see fixtures/).
// Finally it validates each parsed order against the POST /api/ingest contract.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const platform = process.argv[2] || 'tokopedia';
const fixturePath = process.argv[3] || resolve(here, `fixtures/${platform}-orderlist.json`);

// Minimal DOM stub so the parser's DOM-fallback path degrades to [] instead of
// throwing — this harness only exercises the GraphQL path from a fixture.
globalThis.document = { body: { innerText: '' }, querySelectorAll: () => [] };

function loadScript(rel) {
  const code = readFileSync(resolve(here, rel), 'utf8');
  // Indirect eval: runs in global scope; the IIFE attaches to globalThis.__ifScraper.
  (0, eval)(code);
}

loadScript('content/parse-common.js');
loadScript(`content/parse-${platform}.js`);

const NS = globalThis.__ifScraper;
const parser = NS && NS.parsers && NS.parsers[platform];
if (typeof parser !== 'function') {
  console.error(`No parser registered for "${platform}".`);
  process.exit(1);
}

let responses;
try {
  responses = JSON.parse(readFileSync(fixturePath, 'utf8'));
} catch (e) {
  console.error(`Cannot read fixture ${fixturePath}: ${e.message}`);
  process.exit(1);
}

console.log(`Platform : ${platform}`);
console.log(`Fixture  : ${fixturePath}`);
console.log(`Responses: ${Array.isArray(responses) ? responses.length : '(not an array)'}\n`);

const orders = parser({ responses, document: globalThis.document }) || [];
console.log(`Parsed orders: ${orders.length}\n`);
console.log(JSON.stringify(orders, null, 2));

// --- lightweight validation against the /api/ingest contract ----------------
const isInt = (n) => Number.isInteger(n);
const problems = [];
orders.forEach((o, i) => {
  const tag = `order[${i}] ${o.invoiceNumber || '(no invoice)'}`;
  if (!o.invoiceNumber) problems.push(`${tag}: missing invoiceNumber`);
  if (!o.orderDate || !/^\d{4}-\d{2}-\d{2}$/.test(o.orderDate)) problems.push(`${tag}: orderDate not YYYY-MM-DD (${o.orderDate})`);
  if (!isInt(o.totalAmount) || o.totalAmount < 0) problems.push(`${tag}: totalAmount invalid (${o.totalAmount})`);
  if (o.shippingFee != null && !isInt(o.shippingFee)) problems.push(`${tag}: shippingFee not int|null (${o.shippingFee})`);
  if (o.discount != null && !isInt(o.discount)) problems.push(`${tag}: discount not int|null (${o.discount})`);
  if (!Array.isArray(o.lineItems) || o.lineItems.length === 0) problems.push(`${tag}: no lineItems`);
  (o.lineItems || []).forEach((li, j) => {
    const lt = `${tag} line[${j}]`;
    if (!li.marketplaceProductName) problems.push(`${lt}: missing marketplaceProductName`);
    if (!isInt(li.quantity) || li.quantity < 1) problems.push(`${lt}: quantity invalid (${li.quantity})`);
    if (!isInt(li.unitPrice) || li.unitPrice < 0) problems.push(`${lt}: unitPrice invalid (${li.unitPrice})`);
    if (!isInt(li.subtotal) || li.subtotal < 0) problems.push(`${lt}: subtotal invalid (${li.subtotal})`);
  });
});

console.log(`\n--- /api/ingest contract validation ---`);
if (orders.length === 0) {
  console.log('⚠️  0 orders parsed — nothing to validate.');
  process.exitCode = 1;
} else if (problems.length === 0) {
  console.log(`✅ ${orders.length} order(s) pass the line-item + order shape.`);
} else {
  console.log(`❌ ${problems.length} problem(s):`);
  for (const p of problems) console.log('  - ' + p);
  process.exitCode = 1;
}
