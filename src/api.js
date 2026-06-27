/**
 * Client for the shared-baseline API (Cloudflare Pages Functions + D1).
 *
 * Endpoints are same-origin (/api/*) in production. During `vite dev` they are
 * NOT available (no Functions runtime) unless you run `npm run dev:full` via
 * `wrangler pages dev`. Calls fail gracefully when the API is absent.
 */

// Same-origin: works in production on *.pages.dev and the custom domain.
const API_BASE = "/api";

/** Stable-ish per-browser id so the server can rate-limit / dedupe loosely. */
export function getClientId() {
  const KEY = "perf-analyzer.client-id.v1";
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id =
        (crypto.randomUUID && crypto.randomUUID()) ||
        "c-" + Math.random().toString(36).slice(2);
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return "anon";
  }
}

/**
 * Submit an opt-in clean run.
 * @returns {Promise<{ ok:boolean, count?:number, error?:string }>}
 */
export async function submitRun(payload) {
  try {
    const res = await fetch(`${API_BASE}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, clientId: getClientId() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: data.error || `HTTP ${res.status}` };
    }
    return data;
  } catch (err) {
    return { ok: false, error: "API injoignable (" + (err.message || "réseau") + ")" };
  }
}

/**
 * Fetch the community baseline for a CPU.
 * @returns {Promise<null | { count:number, baselineMops:number|null, cpuMark:number|null }>}
 */
export async function fetchBaseline(cpuName) {
  if (!cpuName) return null;
  try {
    const res = await fetch(
      `${API_BASE}/baseline?cpu=${encodeURIComponent(cpuName)}`,
      { cache: "no-store" }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
