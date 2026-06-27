/**
 * CPU benchmark worker.
 * Runs a deterministic, branch-y, FP + integer mixed workload so that it is
 * hard for the JIT to optimize away, and reports elapsed time.
 *
 * Why a worker: the heavy loop would otherwise freeze the main thread/UI.
 */

self.onmessage = (e) => {
  const { iterations } = e.data;
  const result = runCpuBench(iterations);
  self.postMessage(result);
};

function runCpuBench(iterations) {
  const t0 = performance.now();

  // Mixed workload: floating point transcendental + integer hashing.
  // Accumulators are returned so the engine can't dead-code-eliminate the loop.
  let acc = 0;
  let hash = 2166136261 >>> 0; // FNV-1a basis

  for (let i = 0; i < iterations; i++) {
    // FP work
    const x = (i % 9973) * 0.001 + 1.0;
    acc += Math.sqrt(x) * Math.sin(x) - Math.log(x);

    // Integer / bitwise work (FNV-1a-ish mixing)
    hash ^= i & 0xff;
    hash = Math.imul(hash, 16777619) >>> 0;
  }

  const t1 = performance.now();
  const ms = t1 - t0;

  // Throughput as Mops/s (million arithmetic ops per second), rough proxy.
  const mops = iterations / 1000 / ms; // iterations / (ms) -> kops/ms == Mops/s

  return {
    ms,
    mops,
    iterations,
    // Returned to prevent optimization; not displayed meaningfully.
    checksum: acc + hash,
  };
}
