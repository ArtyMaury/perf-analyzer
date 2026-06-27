/**
 * "Health index" logic.
 *
 * Goal (per the user): detect a PC that under-performs relative to what its
 * hardware *should* deliver — a signature of an EDR, VPN, thermal throttling,
 * a power-saving plan, etc.
 *
 * We deliberately use a RELATIVE baseline per CPU model, because the in-browser
 * JS benchmark is NOT directly comparable to PassMark's native CPU Mark (JS vs
 * native, single-loop vs multi-threaded mixed workload). Calibrating an absolute
 * JS->PassMark constant is unreliable.
 *
 * How it works:
 *  - The FIRST clean run for a given CPU model establishes a baseline
 *    (the measured CPU score we expect from a healthy machine with that CPU).
 *  - Every later run is expressed as efficiency = measured / baseline.
 *  - We ALSO show, for context, the PassMark CPU Mark of that CPU so the user
 *    can sanity-check that two different machines rank as expected.
 *
 * The PassMark score is used in two ways:
 *  1) As reference context (display + relative ranking between CPU models).
 *  2) Optionally, to normalize the baseline: if you benchmark CPU A (PassMark
 *     20000) and CPU B (PassMark 40000), B's measured score should be ~2x A's.
 *     A large deviation from the PassMark-implied ratio flags an anomaly.
 */

const BASELINE_KEY = "perf-analyzer.cpu-baselines.v1";

/**
 * @typedef {Object} CpuBaseline
 * @property {string} cpuName
 * @property {number} cpuMark        PassMark multi-thread score (reference)
 * @property {number} measuredMops   measured JS throughput baseline (Mops/s)
 * @property {number} measuredMs     measured CPU time baseline (ms, lower=better)
 * @property {number} when           timestamp
 */

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
 * Record a baseline for a CPU if none exists yet, OR if this run is clearly
 * better (we assume the best observed run ≈ the "healthy" potential).
 *
 * @param {string} cpuName
 * @param {number} cpuMark
 * @param {{ mops:number, ms:number }} measured
 * @returns {CpuBaseline} the (possibly updated) baseline now in effect
 */
export function updateBaseline(cpuName, cpuMark, measured) {
  if (!cpuName) return null;
  const map = loadBaselines();
  const k = keyOf(cpuName);
  const existing = map[k];

  // Use the BEST (highest mops / lowest ms) run as the baseline, on the
  // assumption that the fastest clean run reflects the hardware's potential
  // and slower runs indicate something throttling it.
  if (!existing || measured.mops > existing.measuredMops) {
    map[k] = {
      cpuName,
      cpuMark: cpuMark || (existing ? existing.cpuMark : 0),
      measuredMops: measured.mops,
      measuredMs: measured.ms,
      when: Date.now(),
    };
    saveBaselines(map);
  } else if (cpuMark && !existing.cpuMark) {
    // Backfill PassMark score if we now know it.
    existing.cpuMark = cpuMark;
    saveBaselines(map);
  }
  return map[keyOf(cpuName)];
}

/**
 * Compute the health index for a measured run against its baseline.
 *
 * @param {string} cpuName
 * @param {{ mops:number, ms:number }} measured
 * @returns {null | {
 *   efficiency: number,        // measured/baseline, 1.0 == as good as best run
 *   percent: number,           // efficiency * 100
 *   verdict: 'ok'|'slight'|'degraded'|'baseline',
 *   baseline: CpuBaseline
 * }}
 */
export function computeHealth(cpuName, measured) {
  if (!cpuName) return null;
  const map = loadBaselines();
  const base = map[keyOf(cpuName)];
  if (!base) return null;

  // If this run IS the baseline (same best mops), report 'baseline'.
  if (measured.mops >= base.measuredMops) {
    return {
      efficiency: 1,
      percent: 100,
      verdict: "baseline",
      baseline: base,
    };
  }

  const efficiency = measured.mops / base.measuredMops;
  const percent = efficiency * 100;
  let verdict;
  if (percent >= 92) verdict = "ok";
  else if (percent >= 75) verdict = "slight";
  else verdict = "degraded";

  return { efficiency, percent, verdict, baseline: base };
}

/**
 * Cross-CPU sanity check: given the measured score and the PassMark of THIS
 * cpu, plus a reference baseline from ANOTHER healthy cpu, does the measured
 * performance roughly track the PassMark ratio?
 *
 * Returns an "expected vs observed" ratio. ~1.0 means the machine performs in
 * line with its PassMark rank relative to the reference; <1 means it under-
 * performs what its silicon should deliver (the anomaly the user wants to spot).
 *
 * @param {{ cpuMark:number, mops:number }} current
 * @param {{ cpuMark:number, mops:number }} reference  a known-healthy machine
 * @returns {null | { expectedMops:number, observedRatio:number, percentOfExpected:number }}
 */
export function crossCheckAgainstReference(current, reference) {
  if (
    !current?.cpuMark ||
    !reference?.cpuMark ||
    !reference?.mops ||
    reference.cpuMark <= 0
  ) {
    return null;
  }
  // If PassMark says current is X times the reference, we expect its measured
  // throughput to be ~X times the reference's measured throughput.
  const passmarkRatio = current.cpuMark / reference.cpuMark;
  const expectedMops = reference.mops * passmarkRatio;
  const observedRatio = current.mops / expectedMops;
  return {
    expectedMops,
    observedRatio,
    percentOfExpected: observedRatio * 100,
  };
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
