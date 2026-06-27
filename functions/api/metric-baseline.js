/**
 * GET /api/metric-baseline?metric=<disk|ram>&group=<group key>
 *
 * Generic counterpart of /api/baseline (CPU-specific). Returns the community
 * baseline for a disk/RAM metric within a coarse grouping bucket, computed from
 * opt-in "clean" runs.
 *
 * Robust averaging: drop runs whose score is far below the median (likely-not-
 * clean / throttled), then average the rest — same approach as the CPU baseline.
 *
 * Response:
 *   {
 *     ok: true,
 *     metric, groupKey, count,
 *     baselineScore,   // robust average throughput (the reference)
 *     rawAvgScore,     // naive average (transparency)
 *     keptSamples,
 *     unit             // most common submitted unit (display)
 *   }
 * If no data: { ok: true, count: 0, baselineScore: null }
 */

import { json, handleOptions, originOf, str } from "./_shared.js";

const SAMPLE_LIMIT = 500;
const LOW_OUTLIER_FRACTION = 0.7;
const ALLOWED_METRICS = new Set(["disk", "ram"]);

export async function onRequestOptions({ request }) {
  return handleOptions(request);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const origin = originOf(request);

  if (!env.DB) {
    return json({ ok: false, error: "Base de données non configurée." }, 500, origin);
  }

  const url = new URL(request.url);
  const metric = str(url.searchParams.get("metric"), 16);
  const groupKey = str(url.searchParams.get("group"), 80);
  if (!metric || !ALLOWED_METRICS.has(metric)) {
    return json({ ok: false, error: "Métrique invalide (disk|ram)." }, 400, origin);
  }
  if (!groupKey) {
    return json({ ok: false, error: "Paramètre 'group' requis." }, 400, origin);
  }

  let rows;
  try {
    const res = await env.DB.prepare(
      `SELECT score, unit FROM metric_runs
       WHERE metric = ? AND group_key = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
      .bind(metric, groupKey, SAMPLE_LIMIT)
      .all();
    rows = res.results || [];
  } catch (e) {
    console.error("metric-baseline query failed", e);
    return json({ ok: false, error: "Échec de lecture." }, 500, origin);
  }

  if (rows.length === 0) {
    return json({
      ok: true,
      metric,
      groupKey,
      count: 0,
      baselineScore: null,
      rawAvgScore: null,
      unit: null,
    }, 200, origin);
  }

  const scores = rows.map((r) => r.score).filter((v) => v > 0);
  const rawAvg = mean(scores);

  // Robust: trim low outliers relative to the median.
  const med = median(scores);
  const threshold = med * LOW_OUTLIER_FRACTION;
  const kept = scores.filter((v) => v >= threshold);
  const baseline = kept.length ? mean(kept) : rawAvg;

  const unit = mode(rows.map((r) => r.unit).filter(Boolean));

  return json({
    ok: true,
    metric,
    groupKey,
    count: rows.length,
    baselineScore: round(baseline, 2),
    rawAvgScore: round(rawAvg, 2),
    keptSamples: kept.length,
    unit,
  }, 200, origin);
}

// --- stats helpers ---------------------------------------------------------

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mode(arr) {
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

function round(n, dp) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
