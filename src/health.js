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

const BASELINE_KEY = "perf-analyzer.cpu-baseline.v3";
const MY_CPU_KEY = "perf-analyzer.my-cpu.v1";

/**
 * @typedef {Object} CpuBaseline
 * @property {number} cpuMark        PassMark score of the reference run
 * @property {number} measuredMops   measured JS throughput (Mops/s)
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
// CPU baseline — a single reference: the best normalized yield ever observed.
// Only the PassMark score matters for comparison, not the CPU model name.
// ===========================================================================

/** @returns {CpuBaseline | null} */
export function loadBaseline() {
  try {
    const raw = localStorage.getItem(BASELINE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveBaseline(baseline) {
  try {
    localStorage.setItem(BASELINE_KEY, JSON.stringify(baseline));
  } catch {
    /* ignore */
  }
}

/**
 * Update the baseline if this run has a better normalized yield.
 * Only the PassMark score and measured mops matter — not the CPU model.
 *
 * @param {number} cpuMark
 * @param {{ mops:number }} measured
 * @returns {CpuBaseline} the current baseline
 */
export function updateBaseline(cpuMark, measured) {
  if (!cpuMark || cpuMark <= 0 || !measured?.mops) return null;
  const currentYield = measured.mops / cpuMark;
  const existing = loadBaseline();

  if (!existing || currentYield > existing.yield) {
    const baseline = {
      cpuMark,
      measuredMops: measured.mops,
      yield: currentYield,
      when: Date.now(),
    };
    saveBaseline(baseline);
    return baseline;
  }
  return existing;
}

/**
 * Compute the health index for a measured run using PassMark-normalized
 * comparison against the best reference.
 *
 * yield = mops / cpuMark. We compare this run's yield to the best yield
 * ever observed. If a CPU under-performs its PassMark rating relative to
 * the best reference, it's flagged.
 *
 * @param {number} cpuMark  PassMark score of the current CPU
 * @param {{ mops:number }} measured
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

  const best = loadBaseline();
  if (!best) return null;

  const bestYield = best.yield;
  const currentYield = measured.mops / cpuMark;

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
