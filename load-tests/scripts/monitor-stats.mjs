/**
 * load-tests/scripts/monitor-stats.mjs
 *
 * Node.js helper — continuously stream GET /jobs/stats to stdout while a
 * k6 test is running in another terminal.  Gives a live view of queue depth,
 * completion rate, and failure count.
 *
 * Usage (PowerShell — run in a separate terminal window)
 * -------------------------------------------------------
 *   node load-tests/scripts/monitor-stats.mjs
 *
 * Environment variables
 * ----------------------
 *   BASE_URL        (default: http://localhost:3000)
 *   POLL_INTERVAL   Ms between polls  (default: 3000)
 *
 * Press Ctrl+C to stop.
 */

const BASE_URL      = process.env.BASE_URL      ?? "http://localhost:3000";
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL ?? "3000");

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let prevCompleted = 0;
let prevFailed    = 0;
let prevTotal     = 0;
let iteration     = 0;

process.on("SIGINT", () => {
  console.log("\n[monitor] Stopped.");
  process.exit(0);
});

console.log(`[monitor] Streaming ${BASE_URL}/jobs/stats every ${POLL_INTERVAL}ms — Ctrl+C to stop\n`);
console.log(
  `${"Timestamp".padEnd(25)}  ${"queued".padStart(8)}  ${"processing".padStart(10)}  ` +
  `${"completed".padStart(10)}  ${"failed".padStart(8)}  ${"total".padStart(8)}  ` +
  `${"Δcomplete/s".padStart(12)}`,
);
console.log("─".repeat(100));

// eslint-disable-next-line no-constant-condition
while (true) {
  const t0 = Date.now();

  let stats = null;
  try {
    const res = await fetch(`${BASE_URL}/jobs/stats`);
    if (res.ok) stats = await res.json();
  } catch {
    // ignore transient network errors
  }

  if (stats) {
    const elapsed = (Date.now() - t0) / 1000;
    const deltaCompleted = stats.completed - prevCompleted;
    const ratePerSec     = iteration > 0
      ? (deltaCompleted / (POLL_INTERVAL / 1000)).toFixed(2)
      : "—";

    console.log(
      `${new Date().toISOString().padEnd(25)}  ` +
      `${String(stats.queued).padStart(8)}  ` +
      `${String(stats.processing).padStart(10)}  ` +
      `${String(stats.completed).padStart(10)}  ` +
      `${String(stats.failed).padStart(8)}  ` +
      `${String(stats.total).padStart(8)}  ` +
      `${String(ratePerSec).padStart(12)}`,
    );

    prevCompleted = stats.completed;
    prevFailed    = stats.failed;
    prevTotal     = stats.total;
  } else {
    console.log(`${new Date().toISOString()}  [error] Could not reach ${BASE_URL}/jobs/stats`);
  }

  iteration++;
  const spent = Date.now() - t0;
  const remaining = Math.max(0, POLL_INTERVAL - spent);
  await sleep(remaining);
}
