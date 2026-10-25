/**
 * load-tests/scenarios/soak.js
 *
 * SOAK TEST  (constant-arrival-rate, extended)
 * =============================================
 * Purpose  : Sustain a modest, predictable load for an extended period and
 *            detect problems that only emerge over time:
 *              - Node.js heap or RSS memory growth
 *              - Redis memory growth (unconsumed job data accumulation)
 *              - PostgreSQL connection leak or bloat
 *              - Gradual latency drift (compare p95 in the first minute vs last)
 *              - Worker backlog growth (tracked via GET /jobs/stats polling)
 *
 * Workload  : SOAK_TARGET_RPS rps for SOAK_DURATION (default 3 rps / 5 min).
 *             This is deliberately conservative — the goal is stability
 *             observation, not throughput maximization.
 *
 * Covered endpoints
 * -----------------
 *  POST /jobs  (primary — valid payload, no idempotency key)
 *  GET  /jobs/stats  (periodic — every ~60 s from VU 1 to track queue depth)
 *
 * What to monitor externally during this test
 * -------------------------------------------
 *  See README.md § "Resource Monitoring" for docker stats and process-level
 *  commands.  The most important signals are:
 *    docker stats distributed-job-queue-redis distributed-job-queue-postgres
 *    The worker's console output (job completion messages)
 *
 * Required environment variables
 * --------------------------------
 *  BASE_URL          (default: http://localhost:3000)
 *  SOAK_TARGET_RPS   (default: 3)    — sustained requests per second
 *  SOAK_DURATION     (default: 5m)   — e.g. "10m", "30m"
 *  MAX_VUS           (default: 50)   — absolute VU ceiling
 *
 * Prerequisites
 * -------------
 *  - Docker services running (postgres + redis)
 *  - API running:    pnpm dev:api
 *  - Worker running: MAIL_TRANSPORT=test pnpm dev:worker
 *
 * Run (PowerShell):
 *   k6 run load-tests/scenarios/soak.js
 *
 * Save JSON output:
 *   k6 run --out json=load-tests/results/soak-result.json load-tests/scenarios/soak.js
 */

import http from "k6/http";
import { sleep } from "k6";
import { Counter, Trend, Gauge } from "k6/metrics";
import {
  BASE_URL,
  SOAK_TARGET_RPS,
  SOAK_DURATION,
  MAX_VUS,
} from "../config.js";
import { emailPayload } from "../helpers/payloads.js";
import { assertJobSubmitted, assertStatsResponse } from "../helpers/assertions.js";

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const jobsSubmitted     = new Counter("soak_jobs_submitted_total");
const jobsQueued        = new Counter("soak_jobs_queued_total");
const submissionErrors  = new Counter("soak_submission_errors_total");
const submissionLatency = new Trend("soak_submission_latency_ms", true);

/**
 * Gauge tracking the last-observed queue depth (queued + processing).
 * A steadily rising value indicates the worker cannot keep up.
 */
const queueDepth = new Gauge("soak_queue_depth");

// ---------------------------------------------------------------------------
// Test options
// ---------------------------------------------------------------------------

const preAllocated = Math.min(SOAK_TARGET_RPS * 3 + 2, MAX_VUS);

export const options = {
  scenarios: {
    sustained_submission_rate: {
      executor: "constant-arrival-rate",
      rate: SOAK_TARGET_RPS,
      timeUnit: "1s",
      duration: SOAK_DURATION,
      preAllocatedVUs: preAllocated,
      maxVUs: MAX_VUS,
    },
  },
  thresholds: {
    // -------------------------------------------------------------------
    // NOTE: These are example targets — adjust after establishing a baseline.
    // -------------------------------------------------------------------

    // Low tolerance for errors during soak — transient spikes should not
    // be silently absorbed by default.
    http_req_failed: ["rate<0.05"],

    // Latency must stay bounded for the full duration.
    // If p95 drifts upward over time, compare the k6 time-series output.
    http_req_duration: ["p(95)<500", "p(99)<2000"],

    soak_submission_latency_ms: ["p(95)<500"],

    // Checks must stay high
    checks: ["rate>0.95"],
  },
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function setup() {
  const res = http.get(`${BASE_URL}/health`);
  if (res.status !== 200) {
    throw new Error(
      `[soak] API not reachable at ${BASE_URL} (HTTP ${res.status}). ` +
      "Start the API before running the soak test.",
    );
  }

  const runId = `soak-${Date.now()}`;
  console.log(
    `[soak] Starting: ${SOAK_TARGET_RPS} rps for ${SOAK_DURATION}, ` +
    `preAllocVUs=${preAllocated}, maxVUs=${MAX_VUS}, runId=${runId}`,
  );
  console.log(
    "[soak] While this test runs, monitor resource usage with:\n" +
    "         docker stats distributed-job-queue-redis distributed-job-queue-postgres\n" +
    "         node --inspect (if process inspector is attached)\n" +
    "       and watch the worker console for job completions.",
  );
  return { runId };
}

// ---------------------------------------------------------------------------
// Default function
// ---------------------------------------------------------------------------

// Track the last stats poll time per-VU so VU 1 polls periodically.
let lastStatsPollMs = 0;
const STATS_POLL_INTERVAL_MS = 60_000; // every ~1 minute

export default function ({ runId }) {
  const params = { headers: { "Content-Type": "application/json" } };

  // --- Primary: job submission ---
  const payload = emailPayload(runId);

  const t0 = Date.now();
  const res = http.post(
    `${BASE_URL}/jobs`,
    JSON.stringify(payload),
    params,
  );
  submissionLatency.add(Date.now() - t0);
  jobsSubmitted.add(1);

  const ok = assertJobSubmitted(res);
  if (ok) {
    jobsQueued.add(1);
  } else {
    submissionErrors.add(1);
    if (res.status >= 500) {
      console.error(
        `[soak] VU=${__VU} ITER=${__ITER} HTTP ${res.status}: ` +
        `${String(res.body).slice(0, 100)}`,
      );
    }
  }

  // --- Periodic: queue-depth sampling (VU 1 only) ---
  if (__VU === 1) {
    const now = Date.now();
    if (now - lastStatsPollMs >= STATS_POLL_INTERVAL_MS) {
      lastStatsPollMs = now;
      const statsRes = http.get(`${BASE_URL}/jobs/stats`);
      assertStatsResponse(statsRes);
      if (statsRes.status === 200) {
        const stats = JSON.parse(statsRes.body);
        const depth = (stats.queued ?? 0) + (stats.processing ?? 0);
        queueDepth.add(depth);
        console.log(
          `[soak] Queue depth at ${new Date().toISOString()}: ` +
          `queued=${stats.queued} processing=${stats.processing} ` +
          `completed=${stats.completed} failed=${stats.failed} total=${stats.total}`,
        );
        if (depth > SOAK_TARGET_RPS * 30) {
          // Backlog > 30 s worth of submissions — worker is falling behind
          console.warn(
            `[soak] WARNING: Queue depth (${depth}) exceeds 30s of submissions. ` +
            "Worker may not be keeping up.",
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

export function teardown({ runId }) {
  // Final queue-depth snapshot
  const statsRes = http.get(`${BASE_URL}/jobs/stats`);
  if (statsRes.status === 200) {
    const stats = JSON.parse(statsRes.body);
    const depth = (stats.queued ?? 0) + (stats.processing ?? 0);
    console.log(
      `[soak] Final queue state: queued=${stats.queued} processing=${stats.processing} ` +
      `completed=${stats.completed} failed=${stats.failed} total=${stats.total}`,
    );
    if (depth > 0) {
      console.log(
        `[soak] ${depth} job(s) still pending when the test ended. ` +
        "The worker will continue processing them. " +
        "Re-check GET /jobs/stats in a few minutes.",
      );
    }
  }

  console.log(`[soak] Test complete. Run ID: ${runId}`);
  console.log(
    "[soak] Compare p95 latency in the first and last minute of the " +
    "k6 time-series output to detect latency drift.",
  );
}
