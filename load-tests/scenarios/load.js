/**
 * load-tests/scenarios/load.js
 *
 * LOAD TEST  (constant-arrival-rate)
 * ===================================
 * Purpose  : Measure API throughput and latency at a steady, configurable
 *            request rate and confirm the application handles it within
 *            acceptable latency bounds.
 *
 * Workload  : Constant-arrival-rate executor at LOAD_TARGET_RPS rps
 *             for LOAD_DURATION.  k6 will warn if the rate could not be
 *             sustained; check `dropped_iterations` in the summary.
 *
 * Covered endpoints
 * -----------------
 *  POST /jobs  (primary — valid payload, no idempotency key)
 *  GET  /health (setup guard only)
 *
 * What is NOT measured here
 * -------------------------
 *  Job completion time is asynchronous.  This test measures only the HTTP
 *  submission path.  Use load-tests/scripts/check-jobs.mjs or monitor
 *  GET /jobs/stats to assess worker throughput after the test.
 *
 * Required environment variables
 * --------------------------------
 *  BASE_URL          (default: http://localhost:3000)
 *  LOAD_TARGET_RPS   (default: 5)   — requests per second
 *  LOAD_DURATION     (default: 1m)  — e.g. "30s", "2m"
 *  MAX_VUS           (default: 50)  — absolute VU ceiling
 *
 * Prerequisites
 * -------------
 *  - Docker services running (postgres + redis)
 *  - API running:    pnpm dev:api
 *  - Worker running: MAIL_TRANSPORT=test pnpm dev:worker
 *
 * Run (PowerShell):
 *   k6 run load-tests/scenarios/load.js
 *
 * Save JSON output for later comparison:
 *   k6 run --out json=load-tests/results/load-result.json load-tests/scenarios/load.js
 */

import http from "k6/http";
import { Counter, Trend } from "k6/metrics";
import {
  BASE_URL,
  LOAD_TARGET_RPS,
  LOAD_DURATION,
  MAX_VUS,
} from "../config.js";
import { emailPayload } from "../helpers/payloads.js";
import { assertJobSubmitted, assertValidationRejected } from "../helpers/assertions.js";

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

/** Total number of POST /jobs requests sent. */
const jobsSubmitted = new Counter("load_jobs_submitted_total");

/** Total number of successfully queued jobs (HTTP 202). */
const jobsQueued = new Counter("load_jobs_queued_total");

/** Total number of submission-path errors (non-202 responses). */
const submissionErrors = new Counter("load_submission_errors_total");

/**
 * End-to-end POST /jobs wall-clock duration measured inside the VU script
 * (independent of k6's built-in http_req_duration to allow custom labelling).
 */
const submissionLatency = new Trend("load_submission_latency_ms", true);

/** Validation-rejection path latency. */
const validationLatency = new Trend("load_validation_latency_ms", true);

// ---------------------------------------------------------------------------
// Test options
// ---------------------------------------------------------------------------

// Pre-allocate enough VUs to sustain the target rate with a safety factor.
// k6 dynamically scales up to maxVUs if needed.
const preAllocated = Math.min(LOAD_TARGET_RPS * 2 + 2, MAX_VUS);

export const options = {
  scenarios: {
    constant_submission_rate: {
      executor: "constant-arrival-rate",
      rate: LOAD_TARGET_RPS,
      timeUnit: "1s",
      duration: LOAD_DURATION,
      preAllocatedVUs: preAllocated,
      maxVUs: MAX_VUS,
    },
  },
  thresholds: {
    // -------------------------------------------------------------------
    // NOTE: These thresholds are INITIAL EXAMPLES, not proven guarantees.
    //       Adjust them based on your hardware and actual measurements.
    // -------------------------------------------------------------------

    // Transport-level: fraction of requests that k6 failed to send at all
    http_req_failed: ["rate<0.05"],

    // HTTP latency (all requests combined)
    http_req_duration: ["p(95)<500", "p(99)<1500"],

    // Submission-specific latency (POST /jobs, 202 path only)
    load_submission_latency_ms: ["p(95)<500", "p(99)<1500"],

    // Check pass rate (API contract assertions)
    checks: ["rate>0.95"],

    // If dropped_iterations > 0 the target rate was not achieved.
    // k6 does not support a threshold on dropped_iterations by default;
    // read the value from the summary output manually.
  },
};

// ---------------------------------------------------------------------------
// Setup: gate the test on a successful health check
// ---------------------------------------------------------------------------

export function setup() {
  const res = http.get(`${BASE_URL}/health`);
  if (res.status !== 200) {
    throw new Error(
      `[load] API health check failed (HTTP ${res.status}). ` +
      `Is the server running at ${BASE_URL}?`,
    );
  }

  const runId = `load-${Date.now()}`;
  console.log(
    `[load] Starting: target=${LOAD_TARGET_RPS} rps, duration=${LOAD_DURATION}, ` +
    `preAllocVUs=${preAllocated}, maxVUs=${MAX_VUS}, runId=${runId}`,
  );
  return { runId };
}

// ---------------------------------------------------------------------------
// Default function: runs once per arrived iteration
// ---------------------------------------------------------------------------

export default function ({ runId }) {
  const params = { headers: { "Content-Type": "application/json" } };

  // Primary path: valid job submission
  const payload = emailPayload(runId);

  const start = Date.now();
  const submitRes = http.post(
    `${BASE_URL}/jobs`,
    JSON.stringify(payload),
    params,
  );
  const elapsed = Date.now() - start;

  jobsSubmitted.add(1);
  submissionLatency.add(elapsed);

  const ok = assertJobSubmitted(submitRes);
  if (ok) {
    jobsQueued.add(1);
  } else {
    submissionErrors.add(1);
    if (submitRes.status >= 500) {
      // Log a snippet only — avoid flooding stdout at high RPS
      console.error(
        `[load] Server error HTTP ${submitRes.status}: ` +
        `${String(submitRes.body).slice(0, 120)}`,
      );
    }
  }

  // Periodically exercise the validation path (roughly 1-in-10 iterations
  // from VU 1 only, to keep the validation traffic share predictable).
  if (__VU === 1 && __ITER % 10 === 0) {
    const badPayload = { to: "bad", subject: "", text: "" };
    const t0 = Date.now();
    const badRes = http.post(
      `${BASE_URL}/jobs`,
      JSON.stringify(badPayload),
      params,
    );
    validationLatency.add(Date.now() - t0);
    assertValidationRejected(badRes);
  }
}

// ---------------------------------------------------------------------------
// Teardown: remind the operator about async observability
// ---------------------------------------------------------------------------

export function teardown({ runId }) {
  console.log(`[load] Test complete. Run ID: ${runId}`);
  console.log(
    "[load] Job completion is asynchronous. " +
    "Poll GET /jobs/stats or run check-jobs.mjs to assess worker throughput.",
  );
  console.log(
    "[load] If 'dropped_iterations' > 0 in the k6 summary, " +
    "the target rate was not fully achieved. " +
    "Increase MAX_VUS or reduce LOAD_TARGET_RPS.",
  );
}
