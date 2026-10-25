/**
 * load-tests/scenarios/smoke.js
 *
 * SMOKE TEST
 * ==========
 * Purpose  : Verify that every endpoint is reachable, returns the expected
 *            HTTP status codes and response shapes, and that the async
 *            email-job pipeline completes end-to-end.
 *
 * Workload : 1 VU, 1 iteration.
 * Duration : Up to 2 minutes (dominated by the job-completion polling).
 *
 * What it covers
 * --------------
 *  1. GET  /health              → 200 { status: "ok" }
 *  2. GET  /jobs/stats          → 200 { queued, processing, completed, failed, total }
 *  3. POST /jobs (valid)        → 202 { jobId, status: "queued" }
 *  4. POST /jobs (idempotency)  → 202 on first, 200 with same jobId on duplicate
 *  5. POST /jobs (invalid)      → 400 validation error
 *  6. GET  /jobs/:id (non-UUID) → 400
 *  7. GET  /jobs/:id (nil UUID) → 404
 *  8. GET  /jobs/:id → poll until "completed" or "failed" (end-to-end smoke)
 *
 * Required environment variables
 * --------------------------------
 *  BASE_URL              (default: http://localhost:3000)
 *  JOB_POLL_TIMEOUT_MS   (default: 30000) — ms before giving up on async poll
 *  JOB_POLL_INTERVAL_MS  (default: 500)   — ms between poll retries
 *
 * Prerequisites
 * -------------
 *  - Docker services running (postgres + redis)
 *  - API running:    pnpm dev:api
 *  - Worker running: MAIL_TRANSPORT=test pnpm dev:worker
 *
 * Run (PowerShell):
 *   k6 run load-tests/scenarios/smoke.js
 */

import http from "k6/http";
import { sleep, check } from "k6";
import {
  BASE_URL,
  JOB_POLL_TIMEOUT_MS,
  JOB_POLL_INTERVAL_MS,
} from "../config.js";
import {
  emailPayload,
  invalidEmailPayload,
  idempotentEmailPayload,
} from "../helpers/payloads.js";
import {
  assertHealthResponse,
  assertJobSubmitted,
  assertIdempotentDuplicate,
  assertValidationRejected,
  assertJobStatusResponse,
  assertJobNotFound,
  assertInvalidUUID,
  assertStatsResponse,
} from "../helpers/assertions.js";

// Unique per-execution run ID (shared across VUs via closure; safe because
// the smoke test has a single VU and single iteration).
const RUN_ID = `smoke-${Date.now()}`;

export const options = {
  scenarios: {
    smoke: {
      executor: "shared-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: "2m",
    },
  },
  thresholds: {
    // Smoke test must pass cleanly — zero tolerance for failures.
    // Note: http_req_failed counts *all* non-2xx responses, including
    // intentional 400/404/409 validation checks.  We scope it to
    // requests that were expected to succeed (tagged expected_response=true).
    "http_req_failed{expected_response:true}": ["rate<0.01"],
    http_req_duration: ["p(95)<3000"],
    checks: ["rate>0.99"],
  },
};

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

export default function () {
  const params = { headers: { "Content-Type": "application/json" } };

  // ------------------------------------------------------------------
  // 1. Health check
  // ------------------------------------------------------------------
  const healthRes = http.get(`${BASE_URL}/health`);
  if (!assertHealthResponse(healthRes)) {
    console.error(`[smoke] /health failed: ${healthRes.status} — is the API running at ${BASE_URL}?`);
    return; // No point continuing if the server is not up
  }

  // ------------------------------------------------------------------
  // 2. Stats endpoint (observability baseline)
  // ------------------------------------------------------------------
  const statsRes = http.get(`${BASE_URL}/jobs/stats`);
  assertStatsResponse(statsRes);
  const statsBefore = JSON.parse(statsRes.body);
  console.log(`[smoke] Job stats before: ${JSON.stringify(statsBefore)}`);

  // ------------------------------------------------------------------
  // 3. Valid job submission
  // ------------------------------------------------------------------
  const payload = emailPayload(RUN_ID);
  const submitRes = http.post(
    `${BASE_URL}/jobs`,
    JSON.stringify(payload),
    params,
  );
  const submitOk = assertJobSubmitted(submitRes);

  if (!submitOk) {
    console.error(`[smoke] Job submission failed: HTTP ${submitRes.status}\n${submitRes.body}`);
    return;
  }

  const { jobId } = JSON.parse(submitRes.body);
  console.log(`[smoke] Submitted job ${jobId}`);

  // ------------------------------------------------------------------
  // 4. Idempotency: same key + identical payload → 200 with same jobId
  // ------------------------------------------------------------------
  const idemKey   = `smoke-idem-${RUN_ID}`;
  const idemPayload = idempotentEmailPayload(RUN_ID, "smoke-check");

  const idem1 = http.post(
    `${BASE_URL}/jobs`,
    JSON.stringify(idemPayload),
    { headers: { "Content-Type": "application/json", "Idempotency-Key": idemKey } },
  );
  check(idem1, { "idempotency first call → 202": (r) => r.status === 202 });
  const idem1Body = JSON.parse(idem1.body);

  const idem2 = http.post(
    `${BASE_URL}/jobs`,
    JSON.stringify(idemPayload),
    { headers: { "Content-Type": "application/json", "Idempotency-Key": idemKey } },
  );
  assertIdempotentDuplicate(idem2, idem1Body.jobId);

  // ------------------------------------------------------------------
  // 4b. Idempotency conflict: same key, different payload → 409
  // ------------------------------------------------------------------
  const conflictPayload = {
    to: `different-${RUN_ID}@loadtest.example.invalid`,
    subject: `[conflict] ${RUN_ID}`,
    text: "Different payload for conflict test",
  };
  const conflict = http.post(
    `${BASE_URL}/jobs`,
    JSON.stringify(conflictPayload),
    { headers: { "Content-Type": "application/json", "Idempotency-Key": idemKey } },
  );
  check(conflict, {
    "idempotency conflict (different payload) → 409": (r) => r.status === 409,
  });

  // ------------------------------------------------------------------
  // 5. Validation rejection: all fields invalid
  // ------------------------------------------------------------------
  const invalidRes = http.post(
    `${BASE_URL}/jobs`,
    JSON.stringify(invalidEmailPayload()),
    params,
  );
  assertValidationRejected(invalidRes);

  // ------------------------------------------------------------------
  // 6. Validation rejection: non-UUID job ID in path
  // ------------------------------------------------------------------
  const badUUIDRes = http.get(`${BASE_URL}/jobs/not-a-valid-uuid`);
  assertInvalidUUID(badUUIDRes);

  // ------------------------------------------------------------------
  // 7. Not found: valid UUID that doesn't exist in the database
  // ------------------------------------------------------------------
  const notFoundRes = http.get(
    `${BASE_URL}/jobs/00000000-0000-0000-0000-000000000000`,
  );
  assertJobNotFound(notFoundRes);

  // ------------------------------------------------------------------
  // 8. End-to-end async verification: poll until terminal state
  //
  // The worker must be running with MAIL_TRANSPORT=test for this to pass.
  // If the worker is not running, this check will fail with a clear message.
  // ------------------------------------------------------------------
  console.log(
    `[smoke] Polling job ${jobId} for completion ` +
    `(timeout=${JOB_POLL_TIMEOUT_MS}ms, interval=${JOB_POLL_INTERVAL_MS}ms) ...`,
  );

  const deadline   = Date.now() + JOB_POLL_TIMEOUT_MS;
  let finalStatus  = null;
  let finalJobBody = null;

  while (Date.now() < deadline) {
    const statusRes = http.get(`${BASE_URL}/jobs/${jobId}`);

    if (statusRes.status === 200) {
      const body = JSON.parse(statusRes.body);
      assertJobStatusResponse(statusRes);

      if (body.status === "completed" || body.status === "failed") {
        finalStatus  = body.status;
        finalJobBody = body;
        break;
      }
    }

    sleep(JOB_POLL_INTERVAL_MS / 1000); // k6 sleep takes seconds
  }

  if (finalStatus !== null) {
    check(finalStatus, {
      "end-to-end: job reached 'completed' (not 'failed')": (s) =>
        s === "completed",
    });

    if (finalStatus === "completed") {
      check(finalJobBody, {
        "end-to-end: completedAt is set": (b) => b?.completedAt != null,
        "end-to-end: startedAt is set":   (b) => b?.startedAt   != null,
      });
      console.log(`[smoke] Job ${jobId} completed successfully.`);
    } else {
      console.error(
        `[smoke] Job ${jobId} ended in state 'failed': ${finalJobBody?.error}`,
      );
    }
  } else {
    check(null, {
      "end-to-end: job completed within timeout": () => false,
    });
    console.warn(
      `[smoke] Job ${jobId} did not reach a terminal state within ` +
      `${JOB_POLL_TIMEOUT_MS}ms.\n` +
      "       Ensure the worker is running: MAIL_TRANSPORT=test pnpm dev:worker",
    );
  }

  // ------------------------------------------------------------------
  // 9. Stats after (sanity check that totals moved)
  // ------------------------------------------------------------------
  sleep(0.5);
  const statsAfterRes = http.get(`${BASE_URL}/jobs/stats`);
  assertStatsResponse(statsAfterRes);
  const statsAfter = JSON.parse(statsAfterRes.body);
  console.log(`[smoke] Job stats after:  ${JSON.stringify(statsAfter)}`);
  check(statsAfter, {
    "stats: total increased after submissions": (s) =>
      s.total > (statsBefore?.total ?? 0),
  });
}
