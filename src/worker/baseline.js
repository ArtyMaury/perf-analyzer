/**
 * GET /api/baseline?cpu=<exact CPU name>
 *
 * Returns the community baseline for a CPU, computed from opt-in "clean" runs.
 *
 * Robust averaging: a naive mean is vulnerable to a single mistakenly-submitted
 * throttled run dragging it down. So we compute a TRIMMED mean — we drop runs
 * whose mops is far below the median (likely-not-clean), then average the rest.
 *
 * Response:
 *   {
 *     ok: true,
 *     cpuName, count,
 *     baselineMops,     // robust average measured throughput (the reference)
 *     rawAvgMops,       // naive average (for transparency)
 *     cpuMark           // PassMark reference (mode of submitted values)
 *   }
 * If no data: { ok: true, count: 0, baselineMops: null }
 */

import { json, originOf, str, mean, median, mode, round } from "./_shared.js";

// We only need a bounded number of samples to compute a stable average.
const SAMPLE_LIMIT = 500;
// Drop runs below this fraction of the median (treat as not-clean / throttled).
const LOW_OUTLIER_FRACTION = 0.7;

export async function getBaseline(request, env) {
  const origin = originOf(request);

  if (!env.DB) {
    return json({ ok: false, error: "Base de données non configurée." }, 500, origin);
  }

  const url = new URL(request.url);
  const cpuName = str(url.searchParams.get("cpu"), 120);
  if (!cpuName) {
    return json({ ok: false, error: "Paramètre 'cpu' requis." }, 400, origin);
  }

  let rows;
  try {
    const res = await env.DB.prepare(
      `SELECT mops, cpu_mark FROM runs
       WHERE cpu_name = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
      .bind(cpuName, SAMPLE_LIMIT)
      .all();
    rows = res.results || [];
  } catch (e) {
    console.error("baseline query failed", e);
    return json({ ok: false, error: "Échec de lecture." }, 500, origin);
  }

  if (rows.length === 0) {
    return json({
      ok: true,
      cpuName,
      count: 0,
      baselineMops: null,
      rawAvgMops: null,
      cpuMark: null,
    }, 200, origin);
  }

  const mopsValues = rows.map((r) => r.mops).filter((v) => v > 0);
  const rawAvg = mean(mopsValues);

  // Robust: trim low outliers relative to the median.
  const med = median(mopsValues);
  const threshold = med * LOW_OUTLIER_FRACTION;
  const kept = mopsValues.filter((v) => v >= threshold);
  const baseline = kept.length ? mean(kept) : rawAvg;

  // Reference PassMark = most common submitted value (robust to a stray typo).
  const cpuMark = mode(rows.map((r) => r.cpu_mark));

  return json({
    ok: true,
    cpuName,
    count: rows.length,
    baselineMops: round(baseline, 2),
    rawAvgMops: round(rawAvg, 2),
    keptSamples: kept.length,
    cpuMark,
  }, 200, origin);
}
