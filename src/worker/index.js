/**
 * Worker entry point — perf-analyzer.
 *
 * Serves the Vite-built SPA via the static-assets binding (`env.ASSETS`) and
 * handles the same-origin JSON API under `/api/*` (community baseline sharing,
 * backed by D1). This replaces the former Cloudflare Pages + Pages Functions
 * setup with a single Worker (Workers + static assets).
 *
 * Routing: `run_worker_first = ["/api/*"]` in wrangler.toml means this Worker
 * is invoked first only for `/api/*`; everything else is served directly from
 * static assets. The ASSETS fallback below covers any non-API request that
 * still reaches the Worker.
 *
 * Bindings (wrangler.toml):
 *   - DB      : D1 database (binding name kept as "DB" for parity with the
 *               former Pages Functions code).
 *   - ASSETS  : static assets fetcher (the built SPA in ./dist).
 */

import { json, handleOptions, originOf } from "./_shared.js";
import { postRun } from "./runs.js";
import { getBaseline } from "./baseline.js";
import { postMetricRun } from "./metric-runs.js";
import { getMetricBaseline } from "./metric-baseline.js";

// Method+path → handler. Keeps dispatch explicit and easy to audit.
const ROUTES = {
  "POST /api/runs": postRun,
  "GET /api/baseline": getBaseline,
  "POST /api/metric-runs": postMetricRun,
  "GET /api/metric-baseline": getMetricBaseline,
};

export default {
  /**
   * @param {Request} request
   * @param {{ DB: D1Database, ASSETS: Fetcher }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname.startsWith("/api/")) {
      // CORS preflight for any API route.
      if (request.method === "OPTIONS") {
        return handleOptions(request);
      }

      const handler = ROUTES[`${request.method} ${pathname}`];
      if (handler) {
        try {
          return await handler(request, env);
        } catch (e) {
          console.error("unhandled API error", pathname, e);
          return json(
            { ok: false, error: "Erreur interne." },
            500,
            originOf(request)
          );
        }
      }

      // Unknown /api/* route → JSON 404 (not the SPA shell).
      return json({ ok: false, error: "Not found." }, 404, originOf(request));
    }

    // Non-API request: serve a static asset (SPA). With
    // not_found_handling = "single-page-application", unmatched paths return
    // index.html so client-side routing works.
    return env.ASSETS.fetch(request);
  },
};
