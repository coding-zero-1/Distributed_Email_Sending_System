/**
 * load-tests/scripts/check-stats.mjs
 *
 * Node.js helper — poll GET /jobs/stats repeatedly until all submitted jobs
 * have reached a terminal state (completed or failed) or until timeout.
 *
 * Useful after load / stress / soak tests to verify the worker drained
 * the backlog, without needing to track individual job IDs.
 *
 * Usage (PowerShell)
 * ------------------
 *   node load-tests/scripts/check-stats.mjs
 *
 * Environment variables
 * ----------------------
 *   BASE_URL          (default: http://localhost:3000)
 *   TIMEOUT_MS        Max ms to wait  (default: 300000 = 5 minutes)
 *   POLL_INTERVAL     Ms between polls  (default: 5000)
 *   EXPECT_TOTAL      If set, warn when total < this number
 *
 * Exit code
 *   0 = no jobs in queued/processing state at end of polling
 *   1 = jobs still pending when timeout elapsed, or failed jobs exist
 */

const BASE_URL      = process.env.BASE_URL      ?? "http://localhost:3000";
const TIMEOUT_MS    = parseInt(process.env.TIMEOUT_MS    ?? "300000");
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL ?? "5000");
const EXPECT_TOTAL  = process.env.EXPECT_TOTAL ? parseInt(process.env.EXPECT_TOTAL) : null;

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @returns {Promise<{queued:number, processing:number, completed:number, failed:number, total:number}|null>}
 */
async function fetchStats() {
  try {
    const res = await fetch(`${BASE_URL}/jobs/stats`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

console.log(`Polling ${BASE_URL}/jobs/stats every ${POLL_INTERVAL}ms (timeout=${TIMEOUT_MS}ms) ...\n`);

const start    = Date.now();
const deadline = start + TIMEOUT_MS;
let lastStats  = null;

while (Date.now() < deadline) {
  const stats = await fetchStats();
  lastStats = stats;

  if (!stats) {
    console.warn(`  ${new Date().toISOString()}  [error] Could not fetch stats — is the API running?`);
  } else {
    const pending = stats.queued + stats.processing;
    console.log(
      `  ${new Date().toISOString()}  ` +
      `queued=${stats.queued}  processing=${stats.processing}  ` +
      `completed=${stats.completed}  failed=${stats.failed}  total=${stats.total}`,
    );

    if (pending === 0) {
      console.log(`\n✓ No pending jobs remaining (elapsed ${Date.now() - start}ms).`);
      break;
    }
  }

  await sleep(POLL_INTERVAL);
}

console.log(`\n${"─".repeat(60)}`);

if (!lastStats) {
  console.error("Could not retrieve final stats.");
  process.exit(1);
}

const pending = lastStats.queued + lastStats.processing;
if (pending > 0) {
  console.warn(`WARNING: ${pending} job(s) still in pending state after ${TIMEOUT_MS}ms.`);
  console.warn("The worker may still be processing. Re-run this script later.");
}
if (lastStats.failed > 0) {
  console.warn(`WARNING: ${lastStats.failed} job(s) ended in 'failed' state.`);
  console.warn("Query the database or GET /jobs/<id> to inspect individual failures.");
}
if (EXPECT_TOTAL !== null && lastStats.total < EXPECT_TOTAL) {
  console.warn(
    `WARNING: total=${lastStats.total} is less than expected ${EXPECT_TOTAL}. ` +
    "Some jobs may not have been recorded.",
  );
}

console.log(
  `Final: queued=${lastStats.queued}  processing=${lastStats.processing}  ` +
  `completed=${lastStats.completed}  failed=${lastStats.failed}  total=${lastStats.total}`,
);

process.exit(pending > 0 || lastStats.failed > 0 ? 1 : 0);
