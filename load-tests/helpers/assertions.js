/**
 * load-tests/helpers/assertions.js
 *
 * Reusable k6 check wrappers for every endpoint.
 *
 * Each function calls k6's `check()` and returns true when all checks pass,
 * false otherwise.  The check names appear verbatim in the k6 summary output,
 * so keep them descriptive.
 */

import { check } from "k6";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Safely parse a response body as JSON.
 * Returns null (not undefined) on any error so callers can use ?.
 *
 * @param {import("k6/http").Response} response
 * @returns {Record<string, unknown> | null}
 */
function parseBody(response) {
  try {
    return JSON.parse(response.body);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Endpoint-specific assertion functions
// ---------------------------------------------------------------------------

/**
 * Assert the response from GET /health.
 *
 * Expected: 200 { status: "ok" }
 *
 * @param {import("k6/http").Response} response
 * @returns {boolean}
 */
export function assertHealthResponse(response) {
  return check(response, {
    "health → status 200": (r) => r.status === 200,
    "health → body.status === 'ok'": (r) => parseBody(r)?.status === "ok",
  });
}

/**
 * Assert a successful job submission response from POST /jobs.
 *
 * Expected: 202 { jobId: <uuid>, status: "queued" }
 *
 * @param {import("k6/http").Response} response
 * @returns {boolean}
 */
export function assertJobSubmitted(response) {
  return check(response, {
    "submit → status 202": (r) => r.status === 202,
    "submit → body.jobId is a string": (r) => {
      const b = parseBody(r);
      return typeof b?.jobId === "string" && b.jobId.length > 0;
    },
    "submit → body.status === 'queued'": (r) => parseBody(r)?.status === "queued",
  });
}

/**
 * Assert a successful idempotency deduplication response from POST /jobs.
 * This is the 200 returned when the same idempotency key is reused with an
 * identical payload.
 *
 * Expected: 200 { jobId: <uuid>, status: <any valid status> }
 *
 * @param {import("k6/http").Response} response
 * @param {string} expectedJobId - The job ID from the original submission.
 * @returns {boolean}
 */
export function assertIdempotentDuplicate(response, expectedJobId) {
  return check(response, {
    "idempotency duplicate → status 200": (r) => r.status === 200,
    "idempotency duplicate → same jobId": (r) => {
      return parseBody(r)?.jobId === expectedJobId;
    },
  });
}

/**
 * Assert that the server rejected a request due to payload validation.
 *
 * Expected: 400 { error: <string> }
 *
 * @param {import("k6/http").Response} response
 * @returns {boolean}
 */
export function assertValidationRejected(response) {
  return check(response, {
    "validation → status 400": (r) => r.status === 400,
    "validation → body.error is a string": (r) =>
      typeof parseBody(r)?.error === "string",
  });
}

/**
 * Assert the response from GET /jobs/:id.
 *
 * @param {import("k6/http").Response} response
 * @param {string[]} [validStatuses] - Acceptable values for body.status.
 *   Defaults to all four defined statuses.
 * @returns {boolean}
 */
export function assertJobStatusResponse(response, validStatuses) {
  const allowed = validStatuses ?? ["queued", "processing", "completed", "failed"];
  return check(response, {
    "job status → status 200": (r) => r.status === 200,
    "job status → body.id is a string": (r) =>
      typeof parseBody(r)?.id === "string",
    "job status → body.status is valid": (r) =>
      allowed.includes(String(parseBody(r)?.status)),
  });
}

/**
 * Assert that GET /jobs/:id returns 404 for a non-existent job.
 *
 * @param {import("k6/http").Response} response
 * @returns {boolean}
 */
export function assertJobNotFound(response) {
  return check(response, {
    "job not found → status 404": (r) => r.status === 404,
    "job not found → body.error is a string": (r) =>
      typeof parseBody(r)?.error === "string",
  });
}

/**
 * Assert that GET /jobs/:id returns 400 for a non-UUID path parameter.
 *
 * @param {import("k6/http").Response} response
 * @returns {boolean}
 */
export function assertInvalidUUID(response) {
  return check(response, {
    "invalid UUID → status 400": (r) => r.status === 400,
    "invalid UUID → body.error is a string": (r) =>
      typeof parseBody(r)?.error === "string",
  });
}

/**
 * Assert the response from GET /jobs/stats.
 *
 * Expected: 200 { queued, processing, completed, failed, total }
 *
 * @param {import("k6/http").Response} response
 * @returns {boolean}
 */
export function assertStatsResponse(response) {
  return check(response, {
    "stats → status 200": (r) => r.status === 200,
    "stats → body.total is a number": (r) =>
      typeof parseBody(r)?.total === "number",
    "stats → body.queued is a number": (r) =>
      typeof parseBody(r)?.queued === "number",
    "stats → body.completed is a number": (r) =>
      typeof parseBody(r)?.completed === "number",
  });
}
