/**
 * POST /api/runs — opt-in contribution of a "clean" CPU benchmark run.
 *
 * Body (JSON):
 *   {
 *     cpuName: string,      // exact PassMark name the user selected
 *     cpuMark: number,      // PassMark reference score
 *     mops: number,         // measured JS throughput (higher better)
 *     cpuMs?: number,       // measured CPU time (ms)
 *     intensity?: string,
 *     threads?: number,
 *     deviceMemory?: number,
 *     clientId?: string     // random per-browser id
 *   }
 *
 * Validation + light rate-limit (per IP) protect data quality.
 * Returns: { ok, inserted, count } where count = total runs for that CPU.
 */

import { json, originOf, num, str } from "./_shared.js";

const MAX_BODY = 4 * 1024; // 4 KB is plenty
const RATE_WINDOW_MS = 60_000; // 1 minute
const RATE_MAX_PER_WINDOW = 5; // max submissions per IP/min

export async function postRun(request, env) {
  const origin = originOf(request);

  if (!env.DB) {
    return json({ ok: false, error: "Base de données non configurée." }, 500, origin);
  }

  // Reject oversized bodies early.
  const len = parseInt(request.headers.get("content-length") || "0", 10);
  if (len > MAX_BODY) {
    return json({ ok: false, error: "Payload trop volumineux." }, 413, origin);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "JSON invalide." }, 400, origin);
  }

  // --- Validate required fields ---
  const cpuName = str(body.cpuName, 120);
  const cpuMark = num(body.cpuMark);
  const mops = num(body.mops);
  if (!cpuName || !cpuMark || !mops) {
    return json(
      { ok: false, error: "Champs requis manquants (cpuName, cpuMark, mops)." },
      400,
      origin
    );
  }
  // Sanity bounds: reject obviously bogus values.
  if (cpuMark < 100 || cpuMark > 500_000) {
    return json({ ok: false, error: "cpuMark hors limites." }, 400, origin);
  }
  if (mops <= 0 || mops > 1_000_000) {
    return json({ ok: false, error: "mops hors limites." }, 400, origin);
  }

  const cpuMs = num(body.cpuMs);
  const intensity = str(body.intensity, 16);
  const threads = num(body.threads);
  const deviceMemory = num(body.deviceMemory);
  const clientId = str(body.clientId, 64) || "anon";
  const ua = str(request.headers.get("user-agent") || "", 180);
  // Rate-limit key: trust the network-level client IP, not the client-supplied
  // id alone (which an attacker can randomize to bypass the limit).
  const ip = str(request.headers.get("CF-Connecting-IP") || "", 64) || "noip";
  const now = Date.now();

  // --- Light rate-limit: count this IP's recent inserts ---
  try {
    const recent = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM runs WHERE ip = ? AND created_at > ?"
    )
      .bind(ip, now - RATE_WINDOW_MS)
      .first();
    if (recent && recent.c >= RATE_MAX_PER_WINDOW) {
      return json(
        { ok: false, error: "Trop de soumissions, réessayez dans une minute." },
        429,
        origin
      );
    }
  } catch (e) {
    // If the rate-check query fails, fail open (still try to insert) but log.
    console.error("rate-check failed", e);
  }

  // --- Insert ---
  try {
    await env.DB.prepare(
      `INSERT INTO runs
        (cpu_name, cpu_mark, mops, cpu_ms, intensity, threads, device_memory, ua, client_id, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        cpuName,
        Math.round(cpuMark),
        mops,
        cpuMs,
        intensity,
        threads != null ? Math.round(threads) : null,
        deviceMemory,
        ua,
        clientId,
        ip,
        now
      )
      .run();
  } catch (e) {
    console.error("insert failed", e);
    return json({ ok: false, error: "Échec d'enregistrement." }, 500, origin);
  }

  // Return the updated count for this CPU.
  let count = 0;
  try {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM runs WHERE cpu_name = ?"
    )
      .bind(cpuName)
      .first();
    count = row ? row.c : 0;
  } catch {
    /* ignore */
  }

  return json({ ok: true, inserted: true, count }, 200, origin);
}
