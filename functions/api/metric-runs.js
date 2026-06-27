/**
 * POST /api/metric-runs — opt-in contribution of a "clean" disk/RAM run.
 *
 * Generic counterpart of /api/runs (which is CPU-specific). Disk and RAM have
 * no hardware model exposed by the browser, so community runs are grouped by a
 * coarse `groupKey` (RAM: deviceMemory GB; disk: OS family).
 *
 * Body (JSON):
 *   {
 *     metric: 'disk' | 'ram',
 *     groupKey: string,    // coarse grouping bucket
 *     score: number,       // measured throughput (higher = better)
 *     unit?: string,       // 'Mo/s' | 'Go/s'
 *     readScore?: number,  // secondary read throughput (context)
 *     intensity?: string,
 *     threads?: number,
 *     deviceMemory?: number,
 *     os?: string,
 *     clientId?: string
 *   }
 *
 * Validation + light rate-limit protect data quality.
 * Returns: { ok, inserted, count } where count = runs for that metric+group.
 */

import { json, handleOptions, num, str } from "./_shared.js";

const MAX_BODY = 4 * 1024; // 4 KB is plenty
const RATE_WINDOW_MS = 60_000; // 1 minute
const RATE_MAX_PER_WINDOW = 8; // max submissions per client/min (disk+ram)
const ALLOWED_METRICS = new Set(["disk", "ram"]);

export async function onRequestOptions() {
  return handleOptions();
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.DB) {
    return json({ ok: false, error: "Base de données non configurée." }, 500);
  }

  // Reject oversized bodies early.
  const len = parseInt(request.headers.get("content-length") || "0", 10);
  if (len > MAX_BODY) {
    return json({ ok: false, error: "Payload trop volumineux." }, 413);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "JSON invalide." }, 400);
  }

  // --- Validate required fields ---
  const metric = str(body.metric, 16);
  const groupKey = str(body.groupKey, 80);
  const score = num(body.score);
  if (!metric || !ALLOWED_METRICS.has(metric)) {
    return json({ ok: false, error: "Métrique invalide (disk|ram)." }, 400);
  }
  if (!groupKey || score == null) {
    return json(
      { ok: false, error: "Champs requis manquants (groupKey, score)." },
      400
    );
  }
  // Sanity bounds: reject obviously bogus throughput (0 < score <= 1e6 Mo|Go/s).
  if (score <= 0 || score > 1_000_000) {
    return json({ ok: false, error: "score hors limites." }, 400);
  }

  const unit = str(body.unit, 12);
  const readScore = num(body.readScore);
  const intensity = str(body.intensity, 16);
  const threads = num(body.threads);
  const deviceMemory = num(body.deviceMemory);
  const os = str(body.os, 60);
  const clientId = str(body.clientId, 64) || "anon";
  const ua = str(request.headers.get("user-agent") || "", 180);
  const now = Date.now();

  // --- Light rate-limit: count this client's recent inserts ---
  try {
    const recent = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM metric_runs WHERE client_id = ? AND created_at > ?"
    )
      .bind(clientId, now - RATE_WINDOW_MS)
      .first();
    if (recent && recent.c >= RATE_MAX_PER_WINDOW) {
      return json(
        { ok: false, error: "Trop de soumissions, réessayez dans une minute." },
        429
      );
    }
  } catch (e) {
    console.error("rate-check failed", e);
  }

  // --- Insert ---
  try {
    await env.DB.prepare(
      `INSERT INTO metric_runs
        (metric, group_key, score, unit, read_score, intensity, threads, device_memory, os, ua, client_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        metric,
        groupKey,
        score,
        unit,
        readScore,
        intensity,
        threads != null ? Math.round(threads) : null,
        deviceMemory,
        os,
        ua,
        clientId,
        now
      )
      .run();
  } catch (e) {
    console.error("insert failed", e);
    return json({ ok: false, error: "Échec d'enregistrement." }, 500);
  }

  // Return the updated count for this metric+group.
  let count = 0;
  try {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM metric_runs WHERE metric = ? AND group_key = ?"
    )
      .bind(metric, groupKey)
      .first();
    count = row ? row.c : 0;
  } catch {
    /* ignore */
  }

  return json({ ok: true, inserted: true, count });
}
