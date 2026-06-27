import "./style.css";
import { detectSpecs } from "./specs.js";
import {
  PRESETS,
  BENCH_ORDER,
  BENCH_META,
} from "./config.js";
import { BENCHMARKS } from "./benchmarks.js";
import { loadCpuDb, searchCpu, findCpuByName, cpuDbSize } from "./cpu-db.js";
import {
  loadMyCpu,
  saveMyCpu,
  updateBaseline,
  computeHealth,
  updateMetricBaseline,
  computeMetricHealth,
} from "./health.js";
import {
  submitRun,
  fetchBaseline,
  submitMetricRun,
  fetchMetricBaseline,
} from "./api.js";

// ===========================================================================
// State
// ===========================================================================
const HISTORY_KEY = "perf-analyzer.history.v1";
/** @type {Array<{ id:string, name:string, when:number, intensity:string, cpu?:object, results:Record<string, any> }>} */
let history = loadHistory();
/** @type {{ n:string, m:number, v:string } | null} */
let selectedCpu = loadMyCpu();

const el = {
  specsList: document.getElementById("specs-list"),
  runBtn: document.getElementById("run-btn"),
  intensity: document.getElementById("intensity-select"),
  status: document.getElementById("run-status"),
  results: document.getElementById("results"),
  compareSection: document.getElementById("compare-section"),
  compareTable: document.getElementById("compare-table"),
  clearHistoryBtn: document.getElementById("clear-history-btn"),
  cpuSearch: document.getElementById("cpu-search"),
  cpuSuggestions: document.getElementById("cpu-suggestions"),
  cpuSelected: document.getElementById("cpu-selected"),
};

// ===========================================================================
// Boot
// ===========================================================================
init();

async function init() {
  renderSpecsLoading();
  renderResultCards(); // empty cards
  renderCompareTable();

  try {
    const specs = await detectSpecs();
    renderSpecs(specs);
  } catch (err) {
    el.specsList.innerHTML = `<p class="specs__note">Erreur détection specs: ${escapeHtml(
      err.message
    )}</p>`;
  }

  el.runBtn.addEventListener("click", runAll);
  el.clearHistoryBtn.addEventListener("click", () => {
    if (confirm("Effacer tout l'historique des runs ?")) {
      history = [];
      saveHistory();
      renderCompareTable();
    }
  });

  setupCpuSelector();
}

// ===========================================================================
// CPU reference selector (autocomplete over the PassMark DB)
// ===========================================================================
let cpuActiveIndex = -1;
let cpuCurrentResults = [];

async function setupCpuSelector() {
  // Restore a previously chosen CPU.
  if (selectedCpu) renderSelectedCpu();

  // Load the DB lazily on first focus to keep startup fast.
  let dbReady = false;
  const ensureDb = async () => {
    if (dbReady) return;
    await loadCpuDb();
    dbReady = true;
  };

  el.cpuSearch.addEventListener("focus", ensureDb);

  el.cpuSearch.addEventListener("input", async () => {
    await ensureDb();
    const q = el.cpuSearch.value.trim();
    cpuCurrentResults = searchCpu(q, 8);
    cpuActiveIndex = -1;
    renderCpuSuggestions(cpuCurrentResults);
  });

  el.cpuSearch.addEventListener("keydown", (e) => {
    if (el.cpuSuggestions.hidden) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      cpuActiveIndex = Math.min(cpuActiveIndex + 1, cpuCurrentResults.length - 1);
      highlightSuggestion();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      cpuActiveIndex = Math.max(cpuActiveIndex - 1, 0);
      highlightSuggestion();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (cpuActiveIndex >= 0 && cpuCurrentResults[cpuActiveIndex]) {
        chooseCpu(cpuCurrentResults[cpuActiveIndex]);
      } else if (cpuCurrentResults[0]) {
        chooseCpu(cpuCurrentResults[0]);
      }
    } else if (e.key === "Escape") {
      el.cpuSuggestions.hidden = true;
    }
  });

  // Hide suggestions when clicking outside.
  document.addEventListener("click", (e) => {
    if (!el.cpuSearch.contains(e.target) && !el.cpuSuggestions.contains(e.target)) {
      el.cpuSuggestions.hidden = true;
    }
  });
}

function renderCpuSuggestions(results) {
  if (!results.length) {
    el.cpuSuggestions.hidden = true;
    el.cpuSuggestions.innerHTML = "";
    return;
  }
  el.cpuSuggestions.innerHTML = results
    .map(
      (r, i) => `
      <li class="cpuref__suggestion" data-index="${i}">
        <span><span class="vendor">${r.v}</span> ${escapeHtml(r.n)}</span>
        <span class="mark">${r.m.toLocaleString("fr-FR")}</span>
      </li>`
    )
    .join("");
  el.cpuSuggestions.hidden = false;

  el.cpuSuggestions.querySelectorAll(".cpuref__suggestion").forEach((li) => {
    li.addEventListener("click", () => {
      const idx = parseInt(li.dataset.index, 10);
      chooseCpu(cpuCurrentResults[idx]);
    });
  });
}

function highlightSuggestion() {
  el.cpuSuggestions.querySelectorAll(".cpuref__suggestion").forEach((li, i) => {
    li.classList.toggle("is-active", i === cpuActiveIndex);
  });
}

function chooseCpu(entry) {
  if (!entry) return;
  selectedCpu = { n: entry.n, m: entry.m, v: entry.v };
  saveMyCpu(selectedCpu);
  el.cpuSearch.value = "";
  el.cpuSuggestions.hidden = true;
  renderSelectedCpu();
}

function renderSelectedCpu() {
  if (!selectedCpu) {
    el.cpuSelected.hidden = true;
    return;
  }
  el.cpuSelected.hidden = false;
  el.cpuSelected.innerHTML = `
    <button class="clear" title="Retirer" aria-label="Retirer le CPU">×</button>
    <span class="name">${escapeHtml(selectedCpu.n)}</span>
    PassMark&nbsp;: <span class="mark">${selectedCpu.m.toLocaleString(
      "fr-FR"
    )}</span> <span style="color:var(--text-faint)">CPU Mark</span>
  `;
  el.cpuSelected.querySelector(".clear").addEventListener("click", () => {
    selectedCpu = null;
    saveMyCpu(null);
    renderSelectedCpu();
  });
}



// ===========================================================================
// Specs sidebar
// ===========================================================================
function renderSpecsLoading() {
  el.specsList.innerHTML = `<p class="specs__note">Détection en cours…</p>`;
}

function renderSpecs(rows) {
  el.specsList.innerHTML = rows
    .map(
      (r) => `
      <div class="spec-row" ${r.hint ? `title="${escapeAttr(r.hint)}"` : ""}>
        <dt>${escapeHtml(r.label)}</dt>
        <dd class="${r.unknown ? "is-unknown" : ""}">${escapeHtml(r.value)}</dd>
      </div>`
    )
    .join("");
}

// ===========================================================================
// Result cards
// ===========================================================================
function renderResultCards() {
  el.results.innerHTML = BENCH_ORDER.map((key) => {
    const meta = BENCH_META[key];
    return `
      <div class="card" id="card-${key}">
        <div class="card__head">
          <span class="card__icon">${meta.icon}</span>
          <h3 class="card__title">${escapeHtml(meta.title)}</h3>
          <span class="card__state" id="state-${key}" data-state="idle">en attente</span>
        </div>
        <div class="card__metric">
          <span class="card__value" id="value-${key}">—</span>
          <span class="card__unit" id="unit-${key}"></span>
        </div>
        <p class="card__sub" id="sub-${key}"></p>
        <div class="card__progress"><div class="card__progress-bar" id="bar-${key}"></div></div>
      </div>`;
  }).join("");
}

function setCardState(key, state, label) {
  const stateEl = document.getElementById(`state-${key}`);
  if (stateEl) {
    stateEl.dataset.state = state;
    stateEl.textContent =
      label ||
      { idle: "en attente", running: "en cours", done: "terminé", error: "erreur", skipped: "ignoré" }[
        state
      ];
  }
}

function setCardProgress(key, fraction) {
  const bar = document.getElementById(`bar-${key}`);
  if (bar) bar.style.width = `${Math.round(fraction * 100)}%`;
}

function setCardResult(key, result) {
  const valueEl = document.getElementById(`value-${key}`);
  const unitEl = document.getElementById(`unit-${key}`);
  const subEl = document.getElementById(`sub-${key}`);
  const p = result.primary;
  valueEl.textContent = formatNumber(p.value);
  unitEl.textContent = p.unit;
  const subParts = [p.label];
  if (result.secondary && result.secondary.length) {
    subParts.push(
      result.secondary.map((s) => `${s.label}: ${s.value}`).join("  ·  ")
    );
  }
  subEl.textContent = subParts.join("\n");
  subEl.style.whiteSpace = "pre-line";
}

function setCardError(key, message, skipped) {
  const valueEl = document.getElementById(`value-${key}`);
  const subEl = document.getElementById(`sub-${key}`);
  valueEl.textContent = skipped ? "N/A" : "✕";
  subEl.textContent = message;
  setCardState(key, skipped ? "skipped" : "error");
  setCardProgress(key, skipped ? 0 : 1);
}

const HEALTH_TEXT = {
  baseline: "Référence établie",
  ok: "Conforme au matériel",
  slight: "Légèrement bridé",
  degraded: "Bridé — anomalie",
};

function renderHealthBadge(key, health) {
  const card = document.getElementById(`card-${key}`);
  if (!card) return;
  // Remove any previous badge.
  const prev = card.querySelector(".health-badge");
  if (prev) prev.remove();

  const badge = document.createElement("span");
  badge.className = "health-badge";
  badge.dataset.verdict = health.verdict;
  const pct = `${health.percent.toFixed(0)}%`;
  const label = HEALTH_TEXT[health.verdict] || "";
  const arrow =
    health.verdict === "baseline" ? "◆" : health.verdict === "ok" ? "✓" : "▼";
  badge.textContent = `${arrow} Indice ${pct} — ${label}`;
  const base = health.baseline || {};
  if (base.cpuName != null && base.cpuMark) {
    // CPU baseline (cross-CPU normalized via PassMark).
    badge.title =
      `Rendement normalisé (mops / PassMark) vs meilleure référence.\n` +
      `Réf: « ${base.cpuName} » (PassMark ${Number(base.cpuMark).toLocaleString("fr-FR")}) ` +
      `— ${Number(base.measuredMops || 0).toFixed(1)} Mops/s.\n` +
      `Rendement réf: ${((base.yield || base.measuredMops / base.cpuMark) * 1000).toFixed(3)} ` +
      `mMops/Mark.`;
  } else if (base.score != null) {
    // Generic metric baseline (disk/RAM): best throughput seen on this machine.
    badge.title =
      `Efficacité = perf mesurée / meilleure perf observée sur ce PC.\n` +
      `Baseline: ${Number(base.score || 0).toFixed(1)} ${base.unit || ""}.`;
  }

  // Insert before the progress bar.
  const progress = card.querySelector(".card__progress");
  card.insertBefore(badge, progress);
}

// ===========================================================================
// Run orchestration
// ===========================================================================
let running = false;
let lastCpuMeasurement = null;
/** Per-metric measurements remembered for the community panel after a run. */
let lastMetricMeasurements = {};

// Config describing each "health-tracked" metric (disk/ram). Mirrors the CPU
// path but generic: how to read the throughput score from a benchmark result,
// its display unit, and the coarse key used to group community runs.
const METRIC_HEALTH = {
  disk: {
    label: "SSD",
    unit: "Mo/s",
    // Throughput where higher = better.
    score: (r) => r.writeMBps,
    readScore: (r) => r.readMBps,
    // No disk model is exposed: group community runs by OS family.
    groupKey: (ctx) => `os:${ctx.os || "inconnu"}`,
    groupLabel: (ctx) => ctx.os || "OS inconnu",
  },
  ram: {
    label: "RAM",
    unit: "Go/s",
    score: (r) => r.writeGBps,
    readScore: (r) => r.readGBps,
    // No RAM model is exposed: group by approximate deviceMemory (GB).
    groupKey: (ctx) =>
      ctx.deviceMemory ? `mem:${ctx.deviceMemory}` : "mem:inconnu",
    groupLabel: (ctx) =>
      ctx.deviceMemory ? `≈ ${ctx.deviceMemory} Go RAM` : "RAM inconnue",
  },
};

async function runAll() {
  if (running) return;
  running = true;
  el.runBtn.disabled = true;
  el.intensity.disabled = true;

  const intensity = el.intensity.value;
  const preset = PRESETS[intensity];
  renderResultCards();

  const runResults = {};
  lastCpuMeasurement = null;
  lastMetricMeasurements = {};

  for (const key of BENCH_ORDER) {
    const meta = BENCH_META[key];
    el.status.textContent = `▶ ${meta.title}…`;
    setCardState(key, "running");
    setCardProgress(key, 0);

    const fn = BENCHMARKS[key];
    const cfg = preset[key];
    const onProgress = (frac, label) => {
      setCardProgress(key, frac);
      if (label) setCardState(key, "running", label);
    };

    try {
      const result = await fn(cfg, onProgress);
      setCardResult(key, result);
      setCardState(key, "done");
      setCardProgress(key, 1);
      runResults[key] = serializeResult(result);

      // CPU health index: compare measured throughput using PassMark-normalized
      // yield against the best reference (cross-CPU comparison).
      if (key === "cpu" && selectedCpu) {
        const measured = { mops: result.mops, ms: result.durationMs };
        // Establish/refresh the LOCAL baseline (best run for this CPU model).
        updateBaseline(selectedCpu.n, selectedCpu.m, measured);
        // Compute health via normalized yield comparison (cross-CPU).
        const health = computeHealth(selectedCpu.m, measured);
        if (health) {
          renderHealthBadge(key, health);
          runResults[key].health = {
            percent: health.percent,
            verdict: health.verdict,
          };
          runResults[key].cpuName = selectedCpu.n;
          runResults[key].cpuMark = selectedCpu.m;
        }
        // Remember the measurement for the optional "contribute" action and
        // for community-baseline comparison after the run completes.
        lastCpuMeasurement = {
          cpuName: selectedCpu.n,
          cpuMark: selectedCpu.m,
          mops: result.mops,
          cpuMs: result.durationMs,
          intensity,
        };
      }

      // Disk / RAM health index: same logic as CPU but keyed per metric.
      // Baseline = best throughput ever seen on THIS machine (healthy potential).
      const mh = METRIC_HEALTH[key];
      if (mh) {
        const score = mh.score(result);
        if (Number.isFinite(score)) {
          updateMetricBaseline(key, { score, unit: mh.unit });
          const health = computeMetricHealth(key, { score });
          if (health) {
            renderHealthBadge(key, health);
            runResults[key].health = {
              percent: health.percent,
              verdict: health.verdict,
            };
          }
          lastMetricMeasurements[key] = {
            metric: key,
            score,
            readScore: mh.readScore ? mh.readScore(result) : null,
            unit: mh.unit,
            intensity,
          };
        }
      }
    } catch (err) {
      const skipped = !!err.skipped;
      setCardError(key, err.message + (err.details ? ` (${err.details})` : ""), skipped);
      runResults[key] = { error: err.message, skipped };
    }

    // Let UI settle and give the system a brief pause between heavy tests.
    await new Promise((r) => setTimeout(r, 120));
  }

  el.status.textContent = "✓ Terminé";

  // Save to history.
  const run = {
    id: cryptoRandomId(),
    name: defaultRunName(intensity),
    when: Date.now(),
    intensity,
    cpu: selectedCpu ? { n: selectedCpu.n, m: selectedCpu.m } : null,
    results: runResults,
  };
  history.unshift(run);
  // Keep history bounded.
  if (history.length > 12) history = history.slice(0, 12);
  saveHistory();
  renderCompareTable();

  running = false;
  el.runBtn.disabled = false;
  el.intensity.disabled = false;

  // After the run: compare against the COMMUNITY baseline and offer to
  // contribute this run (opt-in) if a CPU was selected.
  if (lastCpuMeasurement) {
    showCommunityPanel(lastCpuMeasurement);
  }

  // Same community comparison for disk/RAM (grouped by OS / RAM size).
  const metricKeys = Object.keys(lastMetricMeasurements);
  if (metricKeys.length) {
    const ctx = await getContextSpecs();
    for (const key of metricKeys) {
      showMetricCommunityPanel(key, lastMetricMeasurements[key], ctx);
    }
  }
}

// ===========================================================================
// Community baseline panel (compare + opt-in contribute)
// ===========================================================================
async function showCommunityPanel(measurement) {
  const card = document.getElementById("card-cpu");
  if (!card) return;

  // Remove any previous panel.
  const prev = card.querySelector(".community");
  if (prev) prev.remove();

  const panel = document.createElement("div");
  panel.className = "community";
  panel.innerHTML = `<div class="community__loading">Comparaison communautaire…</div>`;
  card.appendChild(panel);

  // Fetch the community baseline for this CPU.
  const data = await fetchBaseline(measurement.cpuName);

  if (!data) {
    // API unavailable (e.g. local `vite dev` without the Worker).
    panel.innerHTML = `
      <div class="community__row">
        <span class="community__label">Baseline communautaire</span>
        <span class="community__muted">indisponible</span>
      </div>
      ${renderContributeBlock(measurement, 0)}`;
    wireContribute(panel, measurement);
    return;
  }

  let comparisonHtml = "";
  if (data.count > 0 && data.baselineMops) {
    const eff = (measurement.mops / data.baselineMops) * 100;
    const verdict =
      eff >= 92 ? "ok" : eff >= 75 ? "slight" : "degraded";
    const label =
      verdict === "ok"
        ? "Conforme à la communauté"
        : verdict === "slight"
        ? "Sous la moyenne"
        : "Nettement sous la moyenne — bridage probable";
    comparisonHtml = `
      <div class="community__row">
        <span class="community__label">vs communauté (${data.count} run${
      data.count > 1 ? "s" : ""
    })</span>
        <span class="health-badge" data-verdict="${verdict}">${eff.toFixed(
      0
    )}% — ${label}</span>
      </div>
      <div class="community__detail">
        Réf. communautaire : ${data.baselineMops.toFixed(
          1
        )} Mops/s · votre run : ${measurement.mops.toFixed(1)} Mops/s
      </div>`;
  } else {
    comparisonHtml = `
      <div class="community__row">
        <span class="community__label">Baseline communautaire</span>
        <span class="community__muted">aucune donnée pour ce CPU</span>
      </div>
      <div class="community__detail">Soyez le premier à contribuer une référence saine.</div>`;
  }

  panel.innerHTML = comparisonHtml + renderContributeBlock(measurement, data.count);
  wireContribute(panel, measurement);
}

// ===========================================================================
// Confirmation modal for contributions
// ===========================================================================
function showConfirmModal(title, message, onConfirm) {
  // Remove any existing modal
  const existing = document.querySelector(".confirm-modal-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.className = "confirm-modal-overlay";
  overlay.innerHTML = `
    <div class="confirm-modal">
      <h3 class="confirm-modal__title">${title}</h3>
      <p class="confirm-modal__message">${message}</p>
      <div class="confirm-modal__actions">
        <button class="btn btn--ghost confirm-modal__cancel">Annuler</button>
        <button class="btn confirm-modal__confirm">Confirmer et envoyer</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  const cancelBtn = overlay.querySelector(".confirm-modal__cancel");
  const confirmBtn = overlay.querySelector(".confirm-modal__confirm");

  function close() {
    overlay.remove();
  }

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  cancelBtn.addEventListener("click", close);
  confirmBtn.addEventListener("click", () => {
    close();
    onConfirm();
  });

  // Close on Escape
  function onKey(e) {
    if (e.key === "Escape") {
      close();
      document.removeEventListener("keydown", onKey);
    }
  }
  document.addEventListener("keydown", onKey);
}

function renderContributeBlock(measurement, count) {
  return `
    <div class="community__contribute">
      <button class="btn btn--ghost community__btn" id="contribute-btn">
        Contribuer ce résultat
      </button>
      <p class="community__note">
        Anonyme. Aide à établir la référence « ${escapeHtml(
          measurement.cpuName
        )} ». Ne partagez que des runs propres.
      </p>
      <div class="community__status" id="contribute-status" aria-live="polite"></div>
    </div>`;
}

function wireContribute(panel, measurement) {
  const btn = panel.querySelector("#contribute-btn");
  const status = panel.querySelector("#contribute-status");
  if (!btn) return;

  btn.addEventListener("click", () => {
    showConfirmModal(
      "Confirmer la contribution",
      "Ce PC est <strong>sain</strong> (pas d'EDR, VPN, throttling ou autre facteur limitant actif).",
      async () => {
        btn.disabled = true;
        status.textContent = "Envoi…";

        const specs = await getContextSpecs();
        const res = await submitRun({
          cpuName: measurement.cpuName,
          cpuMark: measurement.cpuMark,
          mops: measurement.mops,
          cpuMs: measurement.cpuMs,
          intensity: measurement.intensity,
          threads: specs.threads,
          deviceMemory: specs.deviceMemory,
        });

        if (res.ok) {
          status.innerHTML = `<span style="color:var(--good)">✓ Merci ! ${
            res.count ? res.count + " run(s) pour ce CPU." : ""
          }</span>`;
        } else {
          status.innerHTML = `<span style="color:var(--bad)">Échec : ${escapeHtml(
            res.error || "inconnu"
          )}</span>`;
          btn.disabled = false;
        }
      }
    );
  });
}

// ===========================================================================
// Community baseline panel for disk / RAM (generic metric endpoint).
// ===========================================================================
async function showMetricCommunityPanel(metric, measurement, ctx) {
  const meta = METRIC_HEALTH[metric];
  const card = document.getElementById(`card-${metric}`);
  if (!card || !meta) return;

  const prev = card.querySelector(".community");
  if (prev) prev.remove();

  const panel = document.createElement("div");
  panel.className = "community";
  panel.innerHTML = `<div class="community__loading">Comparaison communautaire…</div>`;
  card.appendChild(panel);

  const groupKey = meta.groupKey(ctx);
  const groupLabel = meta.groupLabel(ctx);
  const data = await fetchMetricBaseline(metric, groupKey);

  if (!data) {
    panel.innerHTML = `
      <div class="community__row">
        <span class="community__label">Baseline communautaire</span>
        <span class="community__muted">indisponible</span>
      </div>
      ${renderMetricContributeBlock(metric, groupLabel)}`;
    wireMetricContribute(panel, metric, measurement, ctx, groupKey);
    return;
  }

  let comparisonHtml = "";
  if (data.count > 0 && data.baselineScore) {
    const eff = (measurement.score / data.baselineScore) * 100;
    const verdict = eff >= 92 ? "ok" : eff >= 75 ? "slight" : "degraded";
    const label =
      verdict === "ok"
        ? "Conforme à la communauté"
        : verdict === "slight"
        ? "Sous la moyenne"
        : "Nettement sous la moyenne — bridage probable";
    const unit = data.unit || meta.unit;
    comparisonHtml = `
      <div class="community__row">
        <span class="community__label">vs communauté (${data.count} run${
      data.count > 1 ? "s" : ""
    }, ${escapeHtml(groupLabel)})</span>
        <span class="health-badge" data-verdict="${verdict}">${eff.toFixed(
      0
    )}% — ${label}</span>
      </div>
      <div class="community__detail">
        Réf. communautaire : ${data.baselineScore.toFixed(
          1
        )} ${unit} · votre run : ${measurement.score.toFixed(1)} ${unit}
      </div>`;
  } else {
    comparisonHtml = `
      <div class="community__row">
        <span class="community__label">Baseline communautaire (${escapeHtml(
          groupLabel
        )})</span>
        <span class="community__muted">aucune donnée</span>
      </div>
      <div class="community__detail">Soyez le premier à contribuer une référence saine.</div>`;
  }

  panel.innerHTML =
    comparisonHtml + renderMetricContributeBlock(metric, groupLabel);
  wireMetricContribute(panel, metric, measurement, ctx, groupKey);
}

function renderMetricContributeBlock(metric, groupLabel) {
  return `
    <div class="community__contribute">
      <button class="btn btn--ghost community__btn metric-contribute-btn">
        Contribuer ce résultat
      </button>
      <p class="community__note">
        Anonyme. Aide à établir la référence « ${escapeHtml(groupLabel)} ».
        Ne partagez que des runs propres.
      </p>
      <div class="community__status metric-contribute-status" aria-live="polite"></div>
    </div>`;
}

function wireMetricContribute(panel, metric, measurement, ctx, groupKey) {
  const btn = panel.querySelector(".metric-contribute-btn");
  const status = panel.querySelector(".metric-contribute-status");
  if (!btn) return;

  btn.addEventListener("click", () => {
    showConfirmModal(
      "Confirmer la contribution",
      "Ce PC est <strong>sain</strong> (pas d'EDR, VPN, throttling ou autre facteur limitant actif).",
      async () => {
        btn.disabled = true;
        status.textContent = "Envoi…";

        const res = await submitMetricRun({
          metric,
          groupKey,
          score: measurement.score,
          unit: measurement.unit,
          readScore: measurement.readScore,
          intensity: measurement.intensity,
          threads: ctx.threads,
          deviceMemory: ctx.deviceMemory,
          os: ctx.os,
        });

        if (res.ok) {
          status.innerHTML = `<span style="color:var(--good)">✓ Merci ! ${
            res.count ? res.count + " run(s) pour ce groupe." : ""
          }</span>`;
        } else {
          status.innerHTML = `<span style="color:var(--bad)">Échec : ${escapeHtml(
            res.error || "inconnu"
          )}</span>`;
          btn.disabled = false;
        }
      }
    );
  });
}

async function getContextSpecs() {
  let os = "";
  try {
    const uaData = /** @type {any} */ (navigator).userAgentData;
    if (uaData) {
      const high = await uaData.getHighEntropyValues(["platform"]);
      os = high.platform || uaData.platform || "";
    }
  } catch {
    /* ignore */
  }
  if (!os) os = osFromUA();
  return {
    threads: navigator.hardwareConcurrency || null,
    deviceMemory: /** @type {any} */ (navigator).deviceMemory || null,
    os: os || null,
  };
}

/** Coarse OS family from the UA string (fallback when UA-CH is absent). */
function osFromUA() {
  const ua = navigator.userAgent;
  if (/Windows NT 10/.test(ua)) return "Windows";
  if (/Windows/.test(ua)) return "Windows";
  if (/Mac OS X/.test(ua)) return "macOS";
  if (/Android/.test(ua)) return "Android";
  if (/(iPhone|iPad|iPod)/.test(ua)) return "iOS";
  if (/Linux/.test(ua)) return "Linux";
  return "";
}

// Only keep the comparable bits in storage.
function serializeResult(result) {
  return {
    primary: result.primary,
    secondary: result.secondary,
  };
}

// ===========================================================================
// Comparison table
// ===========================================================================
const COMPARE_ROWS = [
  { key: "cpu", label: "CPU — temps de calcul" },
  { key: "disk", label: "Disque — écriture" },
  { key: "ram", label: "RAM — écriture" },
  { key: "net", label: "Réseau — download" },
];

function renderCompareTable() {
  if (!history.length) {
    el.compareSection.hidden = true;
    return;
  }
  el.compareSection.hidden = false;

  const runs = history;
  const thead = el.compareTable.querySelector("thead");
  const tbody = el.compareTable.querySelector("tbody");

  // Header: metric + one column per run.
  thead.innerHTML =
    `<tr><th>Métrique</th>` +
    runs
      .map(
        (run, i) => `
        <th>
          <input class="run-name-input" data-run-id="${run.id}" value="${escapeAttr(
          run.name
        )}" title="Nom du run (éditable)" />
          <div class="run-meta">
            <span class="run-badge run-badge--${run.intensity}">${escapeHtml(
          PRESETS[run.intensity] ? PRESETS[run.intensity].label : run.intensity
        )}</span>
            <span class="run-date">${formatDateTime(run.when)}</span>
            ${i === 0 ? '<span class="run-latest">récent</span>' : ""}
          </div>
          ${
            run.cpu
              ? `<div class="run-cpu" title="CPU de référence">${escapeHtml(
                  run.cpu.n
                )}</div>`
              : ""
          }
        </th>`
      )
      .join("") +
    `</tr>`;

  // Rows: each metric across runs, with delta vs the most recent run's neighbor.
  tbody.innerHTML = renderHealthRows(runs) + COMPARE_ROWS.map((row) => {
    const cells = runs
      .map((run, i) => {
        const r = run.results[row.key];
        if (!r || r.error) {
          return `<td class="num" style="color:var(--text-faint)">${
            r && r.skipped ? "N/A" : "—"
          }</td>`;
        }
        const p = r.primary;
        const valStr = `${formatNumber(p.value)} ${p.unit}`;

        // Compute delta vs the PREVIOUS run in the list (i+1, older).
        let deltaHtml = "";
        const older = runs[i + 1] && runs[i + 1].results[row.key];
        if (older && older.primary && !older.error) {
          const cur = p.value;
          const prev = older.primary.value;
          if (prev > 0) {
            const pct = ((cur - prev) / prev) * 100;
            const better = p.lowerIsBetter ? cur < prev : cur > prev;
            const cls = better ? "delta-better" : "delta-worse";
            const sign = pct >= 0 ? "+" : "";
            deltaHtml = ` <span class="${cls}" style="font-size:11px">(${sign}${pct.toFixed(
              0
            )}%)</span>`;
          }
        }
        return `<td class="num">${valStr}${deltaHtml}</td>`;
      })
      .join("");
    return `<tr><td class="metric-name">${escapeHtml(row.label)}</td>${cells}</tr>`;
  }).join("");

  // Wire up name editing.
  tbody.closest("table").querySelectorAll(".run-name-input").forEach((input) => {
    input.addEventListener("change", (e) => {
      const id = e.target.dataset.runId;
      const run = history.find((r) => r.id === id);
      if (run) {
        run.name = e.target.value.trim() || run.name;
        saveHistory();
      }
    });
  });
}

// Health index rows — one per tracked metric (CPU, SSD, RAM), shown only when
// at least one run has a health index for that metric (mesuré / potentiel).
function renderHealthRows(runs) {
  const HEALTH_METRICS = [
    { key: "cpu", label: "Indice CPU" },
    { key: "disk", label: "Indice SSD" },
    { key: "ram", label: "Indice RAM" },
  ];
  return HEALTH_METRICS.map((m) => renderHealthRow(runs, m.key, m.label)).join(
    ""
  );
}

function renderHealthRow(runs, metricKey, label) {
  const hasAny = runs.some(
    (r) => r.results[metricKey] && r.results[metricKey].health
  );
  if (!hasAny) return "";
  const cells = runs
    .map((run) => {
      const h = run.results[metricKey] && run.results[metricKey].health;
      if (!h) return `<td class="num" style="color:var(--text-faint)">—</td>`;
      const cls =
        h.verdict === "degraded"
          ? "delta-worse"
          : h.verdict === "ok" || h.verdict === "baseline"
          ? "delta-better"
          : "";
      return `<td class="num ${cls}">${h.percent.toFixed(0)}%</td>`;
    })
    .join("");
  return `<tr style="background:var(--bg-elev-2)"><td class="metric-name"><strong>${escapeHtml(
    label
  )}</strong><br><span style="font-size:10px;color:var(--text-faint)">mesuré / potentiel</span></td>${cells}</tr>`;
}

// ===========================================================================
// Persistence
// ===========================================================================
function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    /* storage full / disabled — ignore */
  }
}

// ===========================================================================
// Helpers
// ===========================================================================
function defaultRunName(intensity) {
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  return `${PRESETS[intensity].label} ${hh}:${mm}`;
}

function formatDateTime(ts) {
  const d = new Date(ts);
  const date = d.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });
  const time = d.toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${date} ${time}`;
}

function formatNumber(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1000) return n.toLocaleString("fr-FR", { maximumFractionDigits: 0 });
  if (n >= 100) return n.toFixed(0);
  if (n >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

function cryptoRandomId() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Math.random().toString(36).slice(2);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
