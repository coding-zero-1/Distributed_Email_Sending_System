/**
 * load-tests/scenarios/stress.js
 *
 * STRESS TEST  (ramping-arrival-rate)
 * =====================================
 * Purpose  : Ramp the request rate through progressively higher stages to
 *            locate the point at which latency, error rate, or resource
 *            consumption become unacceptable.
 *
 * Workload  : Ramping-arrival-rate executor.  Rate climbs through three
 *             steps (20 %, 50 %, 100 % of STRESS_MAX_RPS), each with a
 *             ramp period and a hold period, then cooldown.
 *
 *             Stage schedule (default STRESS_MAX_RPS=20, ~3.5 minutes total):
 *               0 → 4 rps   in 30 s  → hold 4 rps   for 30 s
 *               4 → 10 rps  in 30 s  → hold 10 rps  for 30 s
 *               10 → 20 rps in 30 s  → hold 20 rps  for 30 s
 *               20 → 0 rps  in 15 s  (cooldown)
 *
 * Covered endpoints
 * -----------------
 *  POST /jobs (valid payload, no idempotency key)
 *
 * What to look for
 * ----------------
 *  - At which stage do p95 / p99 latency spikes begin?
 *  - At which stage does the error rate exceed 5 %?
 *  - Does the API return 500s or does it queue-back-pressure gracefully?
 *  - Compare k6's `dropped_iterations` count vs `load_jobs_queued_total` to
 *    see where the generator itself became the bottleneck.
 *
 * Required environment variables
 * --------------------------------
 *  BASE_URL         (default: http://localhost:3000)
 *  STRESS_MAX_RPS   (default: 20)  — peak rate at the top stage
 *  MAX_VUS          (default: 50)  — absolute VU ceiling
 *
 * Prerequisites
 * -------------
 *  - Docker services running (postgres + redis)
 *  - API running:    pnpm dev:api
 *  - Worker running: MAIL_TRANSPORT=test pnpm dev:worker
 *
 * Run (PowerShell):
 *   k6 run load-tests/scenarios/stress.js
 *
 * Save JSON output:
 *   k6 run --out json=load-tests/results/stress-result.json load-tests/scenarios/stress.js
 */

import http from "k6/http";
import { Counter, Trend } from "k6/metrics";
import { BASE_URL, STRESS_MAX_RPS, MAX_VUS } from "../config.js";
import { emailPayload } from "../helpers/payloads.js";
import { assertJobSubmitted } from "../helpers/assertions.js";

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const jobsSubmitted     = new Counter("stress_jobs_submitted_total");
const jobsQueued        = new Counter("stress_jobs_queued_total");
const server5xxErrors   = new Counter("stress_5xx_errors_total");
const submissionLatency = new Trend("stress_submission_latency_ms", true);

// ---------------------------------------------------------------------------
// Stage configuration
// ---------------------------------------------------------------------------

/**
 * Build ramping stages as a fraction of STRESS_MAX_RPS.
 * Using Math.max(1, ...) prevents zero-rate stages on very low STRESS_MAX_RPS.
 */
const low  = Math.max(1, Math.ceil(STRESS_MAX_RPS * 0.20));
const mid  = Math.max(1, Math.ceil(STRESS_MAX_RPS * 0.50));
const peak = Math.max(1, STRESS_MAX_RPS);

const stages = [
  // Ramp to low tier
  { target: low,  duration: "30s" },
  // Hold at low tier
  { target: low,  duration: "30s" },
  // Ramp to mid tier
  { target: mid,  duration: "30s" },
  // Hold at mid tier
  { target: mid,  duration: "30s" },
  // Ramp to peak
  { target: peak, duration: "30s" },
  // Hold at peak
  { target: peak, duration: "30s" },
  // Cooldown
  { target: 0,    duration: "15s" },
];

// ---------------------------------------------------------------------------
// Test options
// ---------------------------------------------------------------------------

export const options = {
  scenarios: {
    ramping_submission_rate: {
      executor: "ramping-arrival-rate",
      startRate: 1,
      timeUnit: "1s",
      stages,
      preAllocatedVUs: Math.min(mid, MAX_VUS),
      maxVUs: MAX_VUS,
    },
  },
  thresholds: {
    // Stress thresholds are intentionally relaxed — degradation is expected
    // at peak load.  The goal is to observe *where* it starts, not to pass.
    http_req_failed: ["rate<0.20"],
    http_req_duration: ["p(95)<3000"],
    stress_submission_latency_ms: ["p(95)<3000"],
    checks: ["rate>0.80"],
  },
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function setup() {
  const res = http.get(`${BASE_URL}/health`);
  if (res.status !== 200) {
    throw new Error(
      `[stress] API not reachable at ${BASE_URL} (HTTP ${res.status}). ` +
      "Start the API before running the stress test.",
    );
  }

  const runId = `stress-${Date.now()}`;
  const totalDuration = stages.reduce((acc, s) => {
    const n = parseInt(s.duration);
    const unit = s.duration.replace(/\d/g, "");
    return acc + (unit === "s" ? n : n * 60);
  }, 0);

  console.log(
    `[stress] Starting: peak=${peak} rps, maxVUs=${MAX_VUS}, ` +
    `~${totalDuration}s total, runId=${runId}`,
  );
  console.log(
    `[stress] Stage targets (rps): ${low} → ${low} → ${mid} → ${mid} → ${peak} → ${peak} → 0`,
  );
  return { runId };
}

// ---------------------------------------------------------------------------
// Default function
// ---------------------------------------------------------------------------

export default function ({ runId }) {
  const params = { headers: { "Content-Type": "application/json" } };
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
  }
  if (res.status >= 500) {
    server5xxErrors.add(1);
  }
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

export function teardown({ runId }) {
  console.log(`[stress] Test complete. Run ID: ${runId}`);
  console.log(
    "[stress] Examine the k6 summary table: compare p95/p99 latency " +
    "across the time windows corresponding to each stage. " +
    "The stage where latency or errors jump sharply is the capacity ceiling.",
  );
  console.log(
    "[stress] If stress_5xx_errors_total > 0, the API returned 500 errors — " +
    "check the API logs for connection pool exhaustion or Redis timeouts.",
  );
}
