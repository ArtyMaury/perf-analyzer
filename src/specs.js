/**
 * Detects whatever hardware/software information a browser is willing to expose.
 *
 * IMPORTANT REALITY CHECK:
 *  - There is NO web API for: CPU model/frequency, exact RAM size, swap/pagefile.
 *  - navigator.hardwareConcurrency -> number of *logical* cores (threads), nothing more.
 *  - navigator.deviceMemory       -> RAM rounded & capped at 8 GB (values: 0.25,0.5,1,2,4,8).
 *  - User-Agent Client Hints      -> coarse OS/arch/platform hints, often imprecise.
 *
 * So this module returns "best effort" values and flags what is unknowable.
 */

/** @typedef {{ label: string, value: string, unknown?: boolean, hint?: string }} SpecRow */

/**
 * @returns {Promise<SpecRow[]>}
 */
export async function detectSpecs() {
  /** @type {SpecRow[]} */
  const rows = [];

  // --- CPU logical cores ---
  const cores = navigator.hardwareConcurrency;
  rows.push({
    label: "CPU (threads logiques)",
    value: Number.isFinite(cores) ? String(cores) : "inconnu",
    unknown: !Number.isFinite(cores),
    hint: "navigator.hardwareConcurrency — nombre de threads, pas le modèle.",
  });

  // --- RAM (deviceMemory) ---
  const mem = /** @type {any} */ (navigator).deviceMemory;
  if (typeof mem === "number") {
    rows.push({
      label: "RAM (approx.)",
      value: `≈ ${mem} Go`,
      hint: "navigator.deviceMemory — arrondi et plafonné à 8 Go par le navigateur.",
    });
  } else {
    rows.push({
      label: "RAM (approx.)",
      value: "non exposée",
      unknown: true,
      hint: "navigator.deviceMemory indisponible (Firefox/Safari ne l'exposent pas).",
    });
  }

  // --- Swap / pagefile ---
  rows.push({
    label: "Swap / pagefile",
    value: "inaccessible",
    unknown: true,
    hint: "Aucune API navigateur n'expose le swap. Sandbox total.",
  });

  // --- JS heap limit (Chrome only, gives a hint about memory pressure) ---
  const perfMem = /** @type {any} */ (performance).memory;
  if (perfMem && typeof perfMem.jsHeapSizeLimit === "number") {
    rows.push({
      label: "Limite heap JS",
      value: formatBytes(perfMem.jsHeapSizeLimit),
      hint: "performance.memory.jsHeapSizeLimit — limite mémoire du contexte JS (Chrome).",
    });
  }

  // --- OS / platform via UA Client Hints (async, high entropy) ---
  const ch = await getClientHints();
  rows.push({
    label: "Système",
    value: ch.os || "inconnu",
    unknown: !ch.os,
  });
  rows.push({
    label: "Architecture",
    value: ch.arch || "inconnue",
    unknown: !ch.arch,
  });
  rows.push({
    label: "Navigateur",
    value: ch.browser || detectBrowserFromUA(),
  });

  // --- GPU renderer (WebGL) — sometimes reveals integrated vs discrete ---
  const gpu = detectGpu();
  if (gpu) {
    rows.push({
      label: "GPU",
      value: gpu,
      hint: "WebGL UNMASKED_RENDERER — peut être masqué par le navigateur.",
    });
  }

  // --- Capabilities relevant to the benchmarks ---
  rows.push({
    label: "OPFS (disque)",
    value: hasOPFS() ? "disponible" : "indisponible",
    unknown: !hasOPFS(),
    hint: "Origin Private File System — utilisé pour le test disque réel.",
  });

  rows.push({
    label: "Connexion (type)",
    value: getConnectionInfo() || "inconnue",
    unknown: !getConnectionInfo(),
    hint: "navigator.connection — type/effectif estimé, souvent absent.",
  });

  return rows;
}

/** Whether OPFS is usable for real disk I/O. */
export function hasOPFS() {
  return (
    typeof navigator !== "undefined" &&
    navigator.storage &&
    typeof navigator.storage.getDirectory === "function"
  );
}

async function getClientHints() {
  const out = { os: "", arch: "", browser: "" };
  const uaData = /** @type {any} */ (navigator).userAgentData;
  if (!uaData) {
    out.os = osFromUA();
    return out;
  }
  out.browser = (uaData.brands || [])
    .filter((b) => !/Not.?A.?Brand/i.test(b.brand))
    .map((b) => `${b.brand} ${b.version}`)
    .join(" / ");
  try {
    const high = await uaData.getHighEntropyValues([
      "platform",
      "platformVersion",
      "architecture",
      "bitness",
      "model",
    ]);
    out.os = [high.platform, high.platformVersion].filter(Boolean).join(" ");
    out.arch = [high.architecture, high.bitness && `${high.bitness}-bit`]
      .filter(Boolean)
      .join(" ");
  } catch {
    out.os = uaData.platform || osFromUA();
  }
  return out;
}

function osFromUA() {
  const ua = navigator.userAgent;
  if (/Windows NT 10/.test(ua)) return "Windows 10/11";
  if (/Windows/.test(ua)) return "Windows";
  if (/Mac OS X/.test(ua)) return "macOS";
  if (/Android/.test(ua)) return "Android";
  if (/(iPhone|iPad|iPod)/.test(ua)) return "iOS";
  if (/Linux/.test(ua)) return "Linux";
  return "";
}

function detectBrowserFromUA() {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return "Edge";
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Safari\//.test(ua)) return "Safari";
  return "inconnu";
}

function detectGpu() {
  try {
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) return "";
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    if (!dbg) return "";
    const renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
    return typeof renderer === "string" ? renderer : "";
  } catch {
    return "";
  }
}

function getConnectionInfo() {
  const c = /** @type {any} */ (navigator).connection;
  if (!c) return "";
  const parts = [];
  if (c.effectiveType) parts.push(c.effectiveType);
  if (typeof c.downlink === "number") parts.push(`~${c.downlink} Mb/s`);
  return parts.join(" · ");
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["o", "Ko", "Mo", "Go", "To"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
