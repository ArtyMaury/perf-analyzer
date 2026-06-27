import { NETWORK } from "./config.js";
import { hasOPFS } from "./specs.js";

/**
 * Each benchmark is an async function: (cfg, onProgress) => resultObject
 *  - cfg: the per-bench config slice from the active intensity preset.
 *  - onProgress: (fraction 0..1, optionalLabel) => void
 *  - returns a plain object of metrics (numbers/strings) used for display + compare.
 *
 * Results always include a `primary` { value, unit, label } used as the headline
 * metric on the card and in the comparison table.
 */

// Small helper to let the event loop/paint happen between heavy steps.
const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

// ============================================================================
// CPU — runs in a Web Worker (see workers/cpu.worker.js)
// ============================================================================
export function runCpuBench(cfg, onProgress) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL("./workers/cpu.worker.js", import.meta.url), {
        type: "module",
      });
    } catch (err) {
      reject(new Error("Impossible de créer le Worker CPU: " + err.message));
      return;
    }

    // We can't get fine-grained progress from inside the tight loop without
    // slowing it down, so we animate an indeterminate-ish progress estimate.
    onProgress(0.05, "calcul…");
    let fake = 0.05;
    const timer = setInterval(() => {
      fake = Math.min(0.92, fake + 0.07);
      onProgress(fake, "calcul…");
    }, 150);

    worker.onmessage = (e) => {
      clearInterval(timer);
      onProgress(1);
      const { ms, mops, iterations } = e.data;
      worker.terminate();
      resolve({
        durationMs: ms,
        mops,
        iterations,
        primary: {
          value: ms,
          unit: "ms",
          label: "Temps de calcul",
          lowerIsBetter: true,
        },
        secondary: [
          { label: "Débit", value: `${mops.toFixed(1)} Mops/s` },
          { label: "Itérations", value: iterations.toLocaleString("fr-FR") },
        ],
      });
    };

    worker.onerror = (err) => {
      clearInterval(timer);
      worker.terminate();
      reject(new Error("Erreur Worker CPU: " + (err.message || "inconnue")));
    };

    worker.postMessage({ iterations: cfg.iterations });
  });
}

// ============================================================================
// DISK — real I/O via OPFS (Origin Private File System)
// ============================================================================
export async function runDiskBench(cfg, onProgress) {
  if (!hasOPFS()) {
    const err = new Error(
      "OPFS indisponible dans ce navigateur — test disque ignoré."
    );
    err.skipped = true;
    throw err;
  }

  const fileSizeBytes = cfg.fileSizeMB * 1024 * 1024;
  const chunkBytes = cfg.chunkKB * 1024;
  const chunkCount = Math.ceil(fileSizeBytes / chunkBytes);

  const root = await navigator.storage.getDirectory();
  const fileName = `perf-bench-${Date.now()}.bin`;

  // Pre-fill a chunk with pseudo-random data (so EDR scanning has real content).
  const chunk = new Uint8Array(chunkBytes);
  for (let i = 0; i < chunkBytes; i++) chunk[i] = (i * 31 + 7) & 0xff;

  let writeMs = 0;
  let readMs = 0;

  try {
    // ---- WRITE ----
    const fh = await root.getFileHandle(fileName, { create: true });
    const writable = await fh.createWritable();
    const tWrite0 = performance.now();
    for (let i = 0; i < chunkCount; i++) {
      await writable.write(chunk);
      if (i % 8 === 0) {
        onProgress((i / chunkCount) * 0.5, "écriture…");
      }
    }
    await writable.close();
    writeMs = performance.now() - tWrite0;
    onProgress(0.5, "lecture…");
    await yieldToUI();

    // ---- READ ----
    const file = await fh.getFile();
    const tRead0 = performance.now();
    let offset = 0;
    let readChecksum = 0;
    while (offset < file.size) {
      const slice = file.slice(offset, offset + chunkBytes);
      const buf = await slice.arrayBuffer();
      const view = new Uint8Array(buf);
      // Touch some bytes so the read isn't optimized into a no-op.
      readChecksum += view[0] + view[view.length - 1];
      offset += chunkBytes;
      if (offset % (chunkBytes * 8) === 0) {
        onProgress(0.5 + (offset / file.size) * 0.5, "lecture…");
      }
    }
    readMs = performance.now() - tRead0;
    onProgress(1);

    const writeMBps = cfg.fileSizeMB / (writeMs / 1000);
    const readMBps = cfg.fileSizeMB / (readMs / 1000);

    return {
      fileSizeMB: cfg.fileSizeMB,
      writeMs,
      readMs,
      writeMBps,
      readMBps,
      _checksum: readChecksum,
      primary: {
        value: writeMBps,
        unit: "Mo/s",
        label: "Débit écriture",
        lowerIsBetter: false,
      },
      secondary: [
        { label: "Lecture", value: `${readMBps.toFixed(1)} Mo/s` },
        { label: "Écriture", value: `${writeMs.toFixed(0)} ms` },
        { label: "Lecture (t)", value: `${readMs.toFixed(0)} ms` },
        { label: "Fichier", value: `${cfg.fileSizeMB} Mo` },
      ],
    };
  } finally {
    // Always clean up the temp file.
    try {
      await root.removeEntry(fileName);
    } catch {
      /* ignore */
    }
  }
}

// ============================================================================
// RAM — allocation + sequential read/write throughput
// ============================================================================
export async function runRamBench(cfg, onProgress) {
  const bytes = cfg.bufferMB * 1024 * 1024;
  let buffer;
  try {
    buffer = new ArrayBuffer(bytes);
  } catch (err) {
    const e = new Error(
      `Allocation de ${cfg.bufferMB} Mo impossible (mémoire insuffisante).`
    );
    e.skipped = true;
    throw e;
  }

  // Use Float64 for write, Uint32 for read mixing.
  const f64 = new Float64Array(buffer);
  const u32 = new Uint32Array(buffer);
  const elements = f64.length;

  let writeMs = 0;
  let readMs = 0;
  let checksum = 0;

  const tWrite0 = performance.now();
  for (let p = 0; p < cfg.passes; p++) {
    for (let i = 0; i < elements; i++) {
      f64[i] = i * 1.000001 + p;
    }
    onProgress(((p + 1) / cfg.passes) * 0.5, "écriture RAM…");
    // Yield occasionally so the UI can paint between passes.
    if (p % 2 === 1) await yieldToUI();
  }
  writeMs = performance.now() - tWrite0;

  const tRead0 = performance.now();
  for (let p = 0; p < cfg.passes; p++) {
    let local = 0;
    // Read as u32 to exercise the full buffer at native word size.
    for (let i = 0; i < u32.length; i++) {
      local ^= u32[i];
    }
    checksum ^= local;
    onProgress(0.5 + ((p + 1) / cfg.passes) * 0.5, "lecture RAM…");
    if (p % 2 === 1) await yieldToUI();
  }
  readMs = performance.now() - tRead0;
  onProgress(1);

  // Total bytes moved = bufferBytes * passes (per direction).
  const movedMB = cfg.bufferMB * cfg.passes;
  const writeGBps = movedMB / 1024 / (writeMs / 1000);
  const readGBps = movedMB / 1024 / (readMs / 1000);

  return {
    bufferMB: cfg.bufferMB,
    passes: cfg.passes,
    writeGBps,
    readGBps,
    _checksum: checksum,
    primary: {
      value: writeGBps,
      unit: "Go/s",
      label: "Débit écriture",
      lowerIsBetter: false,
    },
    secondary: [
      { label: "Lecture", value: `${readGBps.toFixed(2)} Go/s` },
      { label: "Buffer", value: `${cfg.bufferMB} Mo × ${cfg.passes}` },
      {
        label: "Note swap",
        value: "non mesurable (API absente)",
      },
    ],
  };
}

// ============================================================================
// NETWORK — download / upload / latency via httpbin (see config.js)
// ============================================================================
export async function runNetBench(cfg, onProgress) {
  const out = {
    pings: [],
    latencyMs: null,
    jitterMs: null,
    downloadMbps: null,
    uploadMbps: null,
    errors: [],
  };

  // ---- LATENCY (ping) ----
  onProgress(0.02, "latence…");
  const pingTimes = [];
  for (let i = 0; i < cfg.pings; i++) {
    const t0 = performance.now();
    try {
      const res = await fetch(NETWORK.pingUrl() + `?_=${Date.now()}_${i}`, {
        cache: "no-store",
        // httpbin supports CORS for simple GET.
      });
      // Drain body to complete the request.
      await res.arrayBuffer();
      const dt = performance.now() - t0;
      pingTimes.push(dt);
    } catch (err) {
      out.errors.push("ping: " + (err.message || "échec"));
    }
    onProgress(0.02 + (i / cfg.pings) * 0.25, "latence…");
  }
  if (pingTimes.length) {
    pingTimes.sort((a, b) => a - b);
    const median = pingTimes[Math.floor(pingTimes.length / 2)];
    const mean = pingTimes.reduce((a, b) => a + b, 0) / pingTimes.length;
    const variance =
      pingTimes.reduce((a, b) => a + (b - mean) ** 2, 0) / pingTimes.length;
    out.latencyMs = median;
    out.jitterMs = Math.sqrt(variance);
  }

  // ---- DOWNLOAD ----
  onProgress(0.3, "download…");
  try {
    const url = NETWORK.downloadUrl(cfg.downloadBytes) + `?_=${Date.now()}`;
    const t0 = performance.now();
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    // Stream to measure progress when possible.
    let received = 0;
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        onProgress(
          0.3 + Math.min(received / cfg.downloadBytes, 1) * 0.35,
          "download…"
        );
      }
    } else {
      const buf = await res.arrayBuffer();
      received = buf.byteLength;
    }
    const dt = (performance.now() - t0) / 1000;
    out.downloadMbps = (received * 8) / 1e6 / dt; // megabits/s
    out._downloadBytes = received;
  } catch (err) {
    out.errors.push("download: " + (err.message || "échec"));
  }

  // ---- UPLOAD ----
  onProgress(0.7, "upload…");
  try {
    const payload = new Uint8Array(cfg.uploadBytes);
    // Fill with non-zero data (some proxies/EDR treat zero-pages specially).
    for (let i = 0; i < payload.length; i += 4096) payload[i] = (i & 0xff) || 1;

    const t0 = performance.now();
    const res = await fetch(NETWORK.uploadUrl(), {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/octet-stream" },
      body: payload,
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    await res.arrayBuffer(); // wait for full round-trip
    const dt = (performance.now() - t0) / 1000;
    out.uploadMbps = (cfg.uploadBytes * 8) / 1e6 / dt;
  } catch (err) {
    out.errors.push("upload: " + (err.message || "échec"));
  }

  onProgress(1);

  // Choose a sensible headline metric: download speed if available, else latency.
  let primary;
  if (out.downloadMbps != null) {
    primary = {
      value: out.downloadMbps,
      unit: "Mb/s",
      label: "Débit download",
      lowerIsBetter: false,
    };
  } else if (out.latencyMs != null) {
    primary = {
      value: out.latencyMs,
      unit: "ms",
      label: "Latence (médiane)",
      lowerIsBetter: true,
    };
  } else {
    const e = new Error(
      "Réseau injoignable (CORS, rate-limit httpbin, ou hors-ligne)."
    );
    e.skipped = out.errors.length > 0;
    e.details = out.errors.join(" | ");
    throw e;
  }

  return {
    ...out,
    primary,
    secondary: [
      out.latencyMs != null
        ? { label: "Latence", value: `${out.latencyMs.toFixed(0)} ms` }
        : null,
      out.jitterMs != null
        ? { label: "Jitter", value: `${out.jitterMs.toFixed(0)} ms` }
        : null,
      out.uploadMbps != null
        ? { label: "Upload", value: `${out.uploadMbps.toFixed(1)} Mb/s` }
        : null,
      out.errors.length
        ? { label: "Erreurs", value: String(out.errors.length) }
        : null,
    ].filter(Boolean),
  };
}

// Registry used by the orchestrator.
export const BENCHMARKS = {
  cpu: runCpuBench,
  disk: runDiskBench,
  ram: runRamBench,
  net: runNetBench,
};
