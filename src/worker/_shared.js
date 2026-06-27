/**
 * Shared helpers for the Worker API (CORS, JSON responses, validation).
 *
 * Ported from the former Pages Functions `functions/api/_shared.js`. The logic
 * is unchanged; only the surrounding runtime (Worker `fetch` handler instead of
 * Pages `onRequest*`) differs.
 */

// Origins allowed to call the API from a browser. Same-origin (the app itself)
// always works regardless of this list; this only constrains cross-origin
// browser callers. Keep it tight to reduce cross-site abuse.
const ALLOWED_ORIGINS = new Set([
  "https://perf.maury.app",
  "https://perf-analyzer.pages.dev",
  // Workers.dev preview/production subdomain for this Worker.
  "https://perf-analyzer.workers.dev",
]);

/** Build CORS headers for a given request Origin (echo only if allowlisted). */
export function corsHeaders(origin) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "";
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (allow) headers["Access-Control-Allow-Origin"] = allow;
  return headers;
}

/** Extract the Origin header from a request (or "" if absent). */
export function originOf(request) {
  return (request && request.headers.get("Origin")) || "";
}

export function json(data, status = 200, origin = "", extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(origin),
      ...extraHeaders,
    },
  });
}

export function handleOptions(request) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(originOf(request)),
  });
}

/** Clamp and sanitize a finite number, or return null. */
export function num(v) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** Trim a string to a max length, or return null. */
export function str(v, max = 200) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

// --- stats helpers (shared by the baseline endpoints) ----------------------

export function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function mode(arr) {
  const counts = new Map();
  let best = null;
  let bestN = 0;
  for (const v of arr) {
    const n = (counts.get(v) || 0) + 1;
    counts.set(v, n);
    if (n > bestN) {
      bestN = n;
      best = v;
    }
  }
  return best;
}

export function round(n, dp) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
