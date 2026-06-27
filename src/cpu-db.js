/**
 * CPU reference database (PassMark CPU Mark) + tolerant search.
 *
 * The JSON is loaded lazily (dynamic import) so it doesn't bloat the initial
 * bundle. Each entry: { n: name, m: cpuMark (multi-thread), v: vendor }.
 *
 * Search is normalized & token-based so users can type things like:
 *   "i7 12700h", "ryzen7 5800x", "12700", "core i9 14900k"
 * and still match.
 */

/** @typedef {{ n: string, m: number, v: string }} CpuEntry */

let _db = null; // loaded array
let _loadPromise = null;

/** Lazily load the CPU database (cached). */
export async function loadCpuDb() {
  if (_db) return _db;
  if (_loadPromise) return _loadPromise;
  _loadPromise = import("./data/cpu-passmark.json")
    .then((mod) => {
      _db = mod.default || mod;
      return _db;
    })
    .catch((err) => {
      console.error("Échec chargement base CPU:", err);
      _db = [];
      return _db;
    });
  return _loadPromise;
}

/** Normalize a string for matching: lowercase, strip accents & punctuation. */
function normalize(s) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // accents
    .replace(/[®™]/g, "")
    .replace(/[^a-z0-9]+/g, " ") // any non-alphanumeric -> space
    .trim();
}

/**
 * Normalize a NAME for substring matching, but also collapse letter/digit
 * boundaries so "ryzen7" matches "ryzen 7". We index names with separators
 * removed entirely for a second, looser comparison.
 */
function compact(s) {
  return normalize(s).replace(/\s+/g, "");
}

/** Split into tokens, dropping noise words that add no discriminating value. */
const NOISE = new Set([
  "intel",
  "amd",
  "cpu",
  "processor",
  "with",
  "radeon",
  "graphics",
  "core",
  "gen",
  "th",
  "ghz",
]);

function tokenize(s) {
  return normalize(s)
    .split(" ")
    .filter((t) => t && !NOISE.has(t));
}

/**
 * Search the DB for a free-text query.
 * @param {string} query
 * @param {number} limit
 * @returns {Array<CpuEntry & { score: number }>}
 */
export function searchCpu(query, limit = 8) {
  if (!_db || !query) return [];
  const qNorm = normalize(query);
  if (qNorm.length < 2) return [];
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const qCompact = compact(query);

  const results = [];

  for (const entry of _db) {
    const nameNorm = normalize(entry.n);
    const nameCompact = compact(entry.n);
    let score = 0;

    // Strong signal: the whole normalized query is a substring of the name.
    if (nameNorm.includes(qNorm)) {
      score += 100 + qNorm.length;
    } else if (qCompact.length >= 3 && nameCompact.includes(qCompact)) {
      // Looser: "ryzen7 5800x" -> "ryzen75800x" still inside the compact name.
      score += 80 + qCompact.length;
    }

    // Token coverage: how many query tokens appear in the name (compact-aware).
    let matchedTokens = 0;
    for (const tok of qTokens) {
      const tokCompact = tok.replace(/\s+/g, "");
      if (nameNorm.includes(tok) || nameCompact.includes(tokCompact)) {
        matchedTokens++;
        // Bonus for matching a model-number-like token (contains a digit).
        score += /\d/.test(tok) ? 12 : 6;
      }
    }
    // Require that ALL query tokens match somewhere, otherwise it's noise.
    if (matchedTokens < qTokens.length) {
      // Allow partial only if a full-substring matched (normal or compact).
      if (!nameNorm.includes(qNorm) && !nameCompact.includes(qCompact)) continue;
    }

    // Prefer shorter names (less padding around the match).
    score -= nameNorm.length * 0.05;

    if (score > 0) {
      results.push({ ...entry, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/** Exact-ish lookup by name (used when restoring a saved selection). */
export function findCpuByName(name) {
  if (!_db || !name) return null;
  const target = normalize(name);
  return _db.find((e) => normalize(e.n) === target) || null;
}

/** Total number of CPUs in the DB (for UI hints). */
export function cpuDbSize() {
  return _db ? _db.length : 0;
}
