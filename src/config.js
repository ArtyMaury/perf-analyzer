/**
 * Central config. Tweak intensity presets and the network target here.
 */

// --- Network target ---------------------------------------------------------
// Chosen by user: httpbin.org (third-party).
// NOTE: httpbin enforces aggressive rate-limiting and its throughput reflects
// the *public internet path*, not purely your PC. Swap to a Cloudflare Function
// (e.g. /api/download, /api/echo) for cleaner EDR/VPN measurements.
export const NETWORK = {
  // Returns N bytes of payload. We request a fixed size and measure download speed.
  // httpbin: /bytes/{n} streams n random bytes.
  downloadUrl: (bytes) => `https://httpbin.org/bytes/${bytes}`,
  // Accepts a POST body and echoes metadata. We measure upload speed.
  // httpbin: /post echoes JSON about the request (it reads the whole body).
  uploadUrl: () => `https://httpbin.org/post`,
  // Tiny endpoint for latency pings.
  pingUrl: () => `https://httpbin.org/get`,
  // Fallback if httpbin is rate-limited / down.
  fallbackPingUrl: () => `https://cloudflare.com/cdn-cgi/trace`,
};

// --- Intensity presets ------------------------------------------------------
// Each benchmark scales its workload from these presets.
export const PRESETS = {
  light: {
    label: "Légère",
    cpu: { iterations: 30_000_000 }, // arithmetic loop count
    disk: { fileSizeMB: 16, chunkKB: 256 },
    ram: { bufferMB: 256, passes: 3 },
    net: { downloadBytes: 1_000_000, uploadBytes: 500_000, pings: 8 },
  },
  normal: {
    label: "Normale",
    cpu: { iterations: 120_000_000 },
    disk: { fileSizeMB: 64, chunkKB: 512 },
    ram: { bufferMB: 512, passes: 5 },
    net: { downloadBytes: 5_000_000, uploadBytes: 2_000_000, pings: 12 },
  },
  heavy: {
    label: "Lourde",
    cpu: { iterations: 400_000_000 },
    disk: { fileSizeMB: 256, chunkKB: 1024 },
    ram: { bufferMB: 1024, passes: 8 },
    net: { downloadBytes: 15_000_000, uploadBytes: 6_000_000, pings: 20 },
  },
};

// Order of benchmarks as shown in the UI.
export const BENCH_ORDER = ["cpu", "disk", "ram", "net"];

export const BENCH_META = {
  cpu: { icon: "🧮", title: "CPU — calcul intensif" },
  disk: { icon: "💾", title: "Disque — OPFS I/O" },
  ram: { icon: "🧠", title: "RAM — débit mémoire" },
  net: { icon: "🌐", title: "Réseau — transferts" },
};
