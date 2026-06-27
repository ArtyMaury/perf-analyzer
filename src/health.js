/**
 * "Health index" logic.
 *
 * Goal (per the user): detect a PC that under-performs relative to what its
 * hardware *should* deliver — a signature of an EDR, VPN, thermal throttling,
 * a power-saving plan, etc.
 *
 * How it works (PassMark-normalized, cross-CPU):
 *  - Every clean run is stored as a baseline: { cpuName, cpuMark, measuredMops }.
 *  - The "normalized yield" of a run = measuredMops / cpuMark.
 *    This allows comparison across DIFFERENT CPUs: a healthy machine should
 *    achieve a yield proportional to its PassMark rating.
 *  - The BEST normalized yield ever observed (across all CPUs) is the reference.
 *  - Every new run's yield is compared to the best reference yield:
 *      efficiency = (mops / cpuMark) / bestYield
 *  - If a powerful CPU (high cpuMark) has a low yield relative to the best
 *    reference, it means the machine is under-performing → EDR/VPN/throttling.
 *
 * Example:
 *  - Reference: CPU Mark 6500, measured 30 Mops → yield = 30/6500 = 0.00461
 *  - Test: CPU Mark 23000, measured 20 Mops → yield = 20/23000 = 0.00087
 *  - Efficiency = 0.00087 / 0.00461 = 18.8% → clearly degraded.
 */

const BASELINE_KEY = "perf-analyzer.cpu-baselines.v2";
const MY_CPU_KEY = "perf-analyzer.my-cpu.v1";

/**
 * @typedef {Object} CpuBaseline
 * @property {string} cpuName
 * @property {number} cpuMark        PassMark multi-thread score
 * @property {number} measuredMops   best measured JS throughput (Mops/s)
 * @property {number} measuredMs     best measured CPU time (ms, lower=better)
 * @property {number} yield          normalized yield = measuredMops / cpuMark
 * @property {number} when           timestamp
 */

// ===========================================================================
// "My CPU" — the CPU of the current PC, persisted in localStorage.
// ===========================================================================

/**
 * Load the saved CPU for this PC.
 * @returns {{ n:string, m:number, v:string } | null}
 */
export function loadMyCpu() {
  try {
    const raw = localStorage.getItem(MY_CPU_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Save the CPU of this PC to localStorage.
 * @param {{ n:string, m:number, v:string } | null} cpu
 */
export function saveMyCpu(cpu) {
  try {
    if (cpu) localStorage.setItem(MY_CPU_KEY, JSON.stringify(cpu));
    else localStorage.removeItem(MY_CPU_KEY);
  } catch {
    /* ignore */
  }
}

// ===========================================================================
// CPU baselines — keyed by CPU name, stores the best run per CPU model.
// The "best reference" is whichever baseline has the highest normalized yield.
// ===========================================================================

/** @returns {Record<string, CpuBaseline>} keyed by normalized cpuName */
export function loadBaselines() {
  try {
    const raw = localStorage.getItem(BASELINE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveBaselines(map) {
  try {
    localStorage.setItem(BASELINE_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

function keyOf(cpuName) {
  return cpuName.trim().toLowerCase();
}

/**
 * Find the baseline with the best normalized yield (mops / cpuMark).
 * This is the "gold standard" reference against which all runs are compared.
 *
 * @returns {CpuBaseline | null}
 */
export function getBestReference() {
  const map = loadBaselines();
  let best = null;
  for (const entry of Object.values(map)) {
    if (!entry.cpuMark || entry.cpuMark <= 0) continue;
    const y = entry.yield ?? entry.measuredMops / entry.cpuMark;
    if (!best || y > (best.yield ?? best.measuredMops / best.cpuMark)) {
      best = entry;
    }
  }
  return best;
}

/**
 * Record a baseline for a CPU if none exists yet, OR if this run is better
 * (highest mops for that CPU model). The best run ≈ the healthy potential.
 *
 * @param {string} cpuName
 * @param {number} cpuMark
 * @param {{ mops:number, ms:number }} measured
 * @returns {CpuBaseline} the (possibly updated) baseline for that CPU
 */
export function updateBaseline(cpuName, cpuMark, measured) {
  if (!cpuName || !cpuMark || cpuMark <= 0) return null;
  const map = loadBaselines();
  const k = keyOf(cpuName);
  const existing = map[k];

  // Use the BEST (highest mops) run as the baseline for this CPU model.
  if (!existing || measured.mops > existing.measuredMops) {
    map[k] = {
      cpuName,
      cpuMark,
      measuredMops: measured.mops,
      measuredMs: measured.ms,
      yield: measured.mops / cpuMark,
      when: Date.now(),
    };
    saveBaselines(map);
  } else if (cpuMark && !existing.cpuMark) {
    // Backfill PassMark score if we now know it.
    existing.cpuMark = cpuMark;
    existing.yield = existing.measuredMops / cpuMark;
    saveBaselines(map);
  }
  return map[k];
}

/**
 * Compute the health index for a measured run using PassMark-normalized
 * comparison against the best reference (cross-CPU).
 *
 * The logic: yield = mops / cpuMark. We compare this run's yield to the
 * best yield ever observed. If a powerful CPU under-performs its PassMark
 * rating relative to the best reference, it's flagged.
 *
 * @param {number} cpuMark  PassMark score of the current CPU
 * @param {{ mops:number, ms:number }} measured
 * @returns {null | {
 *   efficiency: number,        // currentYield / bestYield, 1.0 == matches best
 *   percent: number,           // efficiency * 100
 *   verdict: 'ok'|'slight'|'degraded'|'baseline',
 *   baseline: CpuBaseline,
 *   currentYield: number,
 *   bestYield: number
 * }}
 */
export function computeHealth(cpuMark, measured) {
  if (!cpuMark || cpuMark <= 0 || !measured?.mops) return null;

  const best = getBestReference();
  if (!best) return null;

  const bestYield = best.yield ?? best.measuredMops / best.cpuMark;
  const currentYield = measured.mops / cpuMark;

  // If this run has a yield >= the best reference, it becomes the new best.
  if (currentYield >= bestYield) {
    return {
      efficiency: 1,
      percent: 100,
      verdict: "baseline",
      baseline: best,
      currentYield,
      bestYield: currentYield,
    };
  }

  const efficiency = currentYield / bestYield;
  const percent = efficiency * 100;
  let verdict;
  if (percent >= 92) verdict = "ok";
  else if (percent >= 75) verdict = "slight";
  else verdict = "degraded";

  return { efficiency, percent, verdict, baseline: best, currentYield, bestYield };
}

export function clearBaselines() {
  try {
    localStorage.removeItem(BASELINE_KEY);
  } catch {
    /* ignore */
  }
}

// ===========================================================================
// Generic per-metric baselines (SSD / RAM — same idea as the CPU one).
//
// The CPU health above is keyed by CPU model. For disk and RAM there is no
// hardware model exposed by the browser, so we keep ONE baseline per metric
// per browser: the best throughput we ever observed on this machine = the
// "healthy potential". Every later run is expressed as measured / baseline,
// which is exactly what flags an EDR/VPN/throttling slowdown.
//
// We store throughput where HIGHER IS BETTER (Mo/s for disk, Go/s for RAM),
// mirroring `mops` for the CPU.
// ===========================================================================

const METRIC_BASELINE_KEY = "perf-analyzer.metric-baselines.v1";

/**
 * @typedef {Object} MetricBaseline
 * @property {string} metric     'disk' | 'ram'
 * @property {number} score      best measured throughput (higher = better)
 * @property {string} unit       display unit (e.g. 'Mo/s', 'Go/s')
 * @property {number} when       timestamp
 */

/** @returns {Record<string, MetricBaseline>} keyed by metric */
export function loadMetricBaselines() {
  try {
    const raw = localStorage.getItem(METRIC_BASELINE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveMetricBaselines(map) {
  try {
    localStorage.setItem(METRIC_BASELINE_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

/**
 * Record/refresh the baseline for a metric if this run is the best so far.
 *
 * @param {string} metric  'disk' | 'ram'
 * @param {{ score:number, unit?:string }} measured  throughput, higher=better
 * @returns {MetricBaseline | null}
 */
export function updateMetricBaseline(metric, measured) {
  if (!metric || !Number.isFinite(measured?.score)) return null;
  const map = loadMetricBaselines();
  const existing = map[metric];

  if (!existing || measured.score > existing.score) {
    map[metric] = {
      metric,
      score: measured.score,
      unit: measured.unit || (existing ? existing.unit : ""),
      when: Date.now(),
    };
    saveMetricBaselines(map);
  }
  return map[metric];
}

/**
 * Compute the health index for a metric run against its local baseline.
 * Same verdict thresholds as the CPU index.
 *
 * @param {string} metric  'disk' | 'ram'
 * @param {{ score:number }} measured
 * @returns {null | {
 *   efficiency:number, percent:number,
 *   verdict:'ok'|'slight'|'degraded'|'baseline',
 *   baseline: MetricBaseline
 * }}
 */
export function computeMetricHealth(metric, measured) {
  if (!metric || !Number.isFinite(measured?.score)) return null;
  const map = loadMetricBaselines();
  const base = map[metric];
  if (!base || !base.score) return null;

  if (measured.score >= base.score) {
    return { efficiency: 1, percent: 100, verdict: "baseline", baseline: base };
  }

  const efficiency = measured.score / base.score;
  const percent = efficiency * 100;
  let verdict;
  if (percent >= 92) verdict = "ok";
  else if (percent >= 75) verdict = "slight";
  else verdict = "degraded";

  return { efficiency, percent, verdict, baseline: base };
}

export function clearMetricBaselines() {
  try {
    localStorage.removeItem(METRIC_BASELINE_KEY);
  } catch {
    /* ignore */
  }
}
