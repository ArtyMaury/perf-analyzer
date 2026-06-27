/**
 * Build-time parser for PassMark CPU data.
 *
 * Input : a saved copy of https://www.cpubenchmark.net/cpu-list/all
 * Output: src/data/cpu-passmark.json  — a compact array used by the app.
 *
 * Each row in the source HTML looks like:
 *   <tr id="cpu5717"><td><a href="/cpu_lookup.php?cpu=Intel+Core+i9-14900K&id=5717">Intel Core i9-14900K</a></td><td>58,306</td><td>189</td>...
 *
 * We keep: name, cpuMark (multi-thread score), vendor.
 * We drop ancient/very-low CPUs to keep the file small.
 *
 * Usage:
 *   node scripts/parse-passmark.js <path-to-all.html>
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: node scripts/parse-passmark.js <path-to-all.html>");
  process.exit(1);
}

// Keep CPUs with at least this CPU Mark. Filters out 20-year-old chips that
// no one is benchmarking, shrinking the JSON a lot. Lower if you want more.
const MIN_CPU_MARK = 1500;

const html = readFileSync(resolve(inputPath), "utf8");

// Match each table row: id, the cpu= param (URL-encoded name), the visible
// name, then the first <td> after the link = CPU Mark.
const rowRe =
  /<tr id="cpu(\d+)"><td><a href="\/cpu_lookup\.php\?cpu=([^"&]+)(?:&amp;|&)id=\d+">([^<]+)<\/a><\/td><td>([\d,]+)<\/td>/g;

/** @type {{n:string, m:number, v:string}[]} */
const out = [];
let match;
let total = 0;

while ((match = rowRe.exec(html)) !== null) {
  total++;
  const name = decodeName(match[3]);
  const cpuMark = parseInt(match[4].replace(/,/g, ""), 10);
  if (!Number.isFinite(cpuMark) || cpuMark < MIN_CPU_MARK) continue;

  out.push({
    n: name, // name
    m: cpuMark, // multi-thread CPU Mark
    v: vendorOf(name), // vendor: intel | amd | other
  });
}

// Sort by score descending (nicer for debugging; search doesn't rely on order).
out.sort((a, b) => b.m - a.m);

const outDir = resolve(__dirname, "..", "src", "data");
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, "cpu-passmark.json");

// Write minified JSON (no pretty spacing) to keep bundle small.
writeFileSync(outPath, JSON.stringify(out));

console.log(`Parsed ${total} rows from source.`);
console.log(`Kept ${out.length} CPUs (CPU Mark >= ${MIN_CPU_MARK}).`);
console.log(`Wrote ${outPath} (${(JSON.stringify(out).length / 1024).toFixed(0)} KB).`);

// --- helpers ---------------------------------------------------------------

function decodeName(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

function vendorOf(name) {
  if (/^Intel\b/i.test(name)) return "intel";
  if (/^AMD\b/i.test(name)) return "amd";
  return "other";
}
