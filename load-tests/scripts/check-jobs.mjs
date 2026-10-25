/**
 * load-tests/scripts/check-jobs.mjs
 *
 * Node.js helper — poll individual job IDs to completion after a load test.
 *
 * Usage
 * -----
 *   node load-tests/scripts/check-jobs.mjs <jobId1> [jobId2] ...
 *
 * Environment variables
 * ----------------------
 *   BASE_URL     API base URL  (default: http://localhost:3000)
 *   TIMEOUT_MS   Max ms to wait for each job  (default: 60000)
 *
 * Exit code
 *   0 = all polled jobs completed successfully
 *   1 = one or more jobs failed or timed out
 *
 * Example (PowerShell)
 * --------------------
 *   $env:BASE_URL = "http://localhost:3000"
 *   node load-tests/scripts/check-jobs.mjs `
 *     "uuid-from-test-1" "uuid-from-test-2"
 *
 * @remarks
 * Because k6 does not support writing to the filesystem during a test, you
 * must capture job IDs manually (e.g., from k6 --out json output or from the
 * database) and pass them as arguments to this script.
 *
 * For bulk post-test verification use check-stats.mjs instead, which polls
 * the aggregate GET /jobs/stats endpoint.
 */

const BASE_URL      = process.env.BASE_URL      ?? "http://localhost:3000";
const TIMEOUT_MS    = parseInt(process.env.TIMEOUT_MS    ?? "60000");
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL ?? "1000");

const jobIds = process.argv.slice(2);

if (jobIds.length === 0) {
  console.error(
    "Error: no job IDs supplied.\n" +
    "Usage: node load-tests/scripts/check-jobs.mjs <jobId1> [jobId2] ...",
  );
  process.exit(1);
}

/**
 * Poll GET /jobs/:id until status is "completed" or "failed", or timeout.
 *
 * @param {string} id
 * @returns {Promise<{status: string, attempts: number, error: string|null} | null>}
 */
async function pollJob(id) {
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    let res;
    try {
      res = await fetch(`${BASE_URL}/jobs/${id}`);
    } catch (err) {
      console.warn(`  [network error] ${err.message}`);
      await sleep(POLL_INTERVAL);
      continue;
    }

    if (res.status === 404) {
      return { status: "not_found", attempts: 0, error: "job not found in database" };
    }

    if (res.ok) {
      const body = await res.json();
      if (body.status === "completed" || body.status === "failed") {
        return body;
      }
    }

    await sleep(POLL_INTERVAL);
  }

  return null; // timed out
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`Polling ${jobIds.length} job(s) via ${BASE_URL} (timeout=${TIMEOUT_MS}ms each) ...\n`);

const results = { completed: 0, failed: 0, notFound: 0, timedOut: 0 };

for (const id of jobIds) {
  process.stdout.write(`  ${id}  →  `);
  const result = await pollJob(id);

  if (!result) {
    results.timedOut++;
    console.log("TIMED OUT");
  } else if (result.status === "not_found") {
    results.notFound++;
    console.log("NOT FOUND");
  } else if (result.status === "completed") {
    results.completed++;
    console.log(`COMPLETED  (attempts=${result.attempts})`);
  } else {
    results.failed++;
    console.log(`FAILED     (attempts=${result.attempts}, error=${result.error})`);
  }
}

console.log(`\n${"─".repeat(50)}`);
console.log(`Completed : ${results.completed} / ${jobIds.length}`);
console.log(`Failed    : ${results.failed}`);
console.log(`Not found : ${results.notFound}`);
console.log(`Timed out : ${results.timedOut}`);

process.exit(
  results.failed > 0 || results.timedOut > 0 || results.notFound > 0 ? 1 : 0,
);
