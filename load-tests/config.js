/**
 * load-tests/config.js
 *
 * Shared configuration for all k6 test scenarios.
 * Every value is driven by an environment variable so you can override it
 * from the command line without editing this file.
 *
 * Example (PowerShell):
 *   $env:BASE_URL = "http://localhost:3000"
 *   $env:LOAD_TARGET_RPS = "10"
 *   k6 run load-tests/scenarios/load.js
 *
 * Example (bash):
 *   BASE_URL=http://localhost:3000 LOAD_TARGET_RPS=10 k6 run load-tests/scenarios/load.js
 *
 * Or pass via k6 --env flag:
 *   k6 run --env BASE_URL=http://localhost:3000 load-tests/scenarios/load.js
 */

// ---------------------------------------------------------------------------
// API target
// ---------------------------------------------------------------------------
export const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

// ---------------------------------------------------------------------------
// Smoke test
// ---------------------------------------------------------------------------
/** Maximum time to wait for a single job to reach a terminal state. */
export const JOB_POLL_TIMEOUT_MS = parseInt(__ENV.JOB_POLL_TIMEOUT_MS || "30000");
/** How often to re-poll while waiting for job completion. */
export const JOB_POLL_INTERVAL_MS = parseInt(__ENV.JOB_POLL_INTERVAL_MS || "500");

// ---------------------------------------------------------------------------
// Load test  (constant-arrival-rate)
// ---------------------------------------------------------------------------
/** Target request rate in requests per second. */
export const LOAD_TARGET_RPS = parseInt(__ENV.LOAD_TARGET_RPS || "5");
/** How long to sustain the constant rate. */
export const LOAD_DURATION = __ENV.LOAD_DURATION || "1m";

// ---------------------------------------------------------------------------
// Stress test  (ramping-arrival-rate)
// ---------------------------------------------------------------------------
/** Peak request rate to reach during the stress ramp. */
export const STRESS_MAX_RPS = parseInt(__ENV.STRESS_MAX_RPS || "20");

// ---------------------------------------------------------------------------
// Soak test  (constant-arrival-rate, extended)
// ---------------------------------------------------------------------------
/** Sustained request rate for the soak test. */
export const SOAK_TARGET_RPS = parseInt(__ENV.SOAK_TARGET_RPS || "3");
/** How long to hold the soak load. */
export const SOAK_DURATION = __ENV.SOAK_DURATION || "5m";

// ---------------------------------------------------------------------------
// Common concurrency ceiling
// ---------------------------------------------------------------------------
/**
 * Absolute upper bound on virtual users across all tests.
 * Prevents the generator itself from starving the machine.
 * With constant-arrival-rate executors k6 will warn if this ceiling is hit
 * and the actual throughput will be lower than the target.
 */
export const MAX_VUS = parseInt(__ENV.MAX_VUS || "50");
