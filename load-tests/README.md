# Load Tests — Distributed Job Queue

Grafana k6 load-testing suite for the `distributed_job_queue` monorepo.
Tests target the Express API (`apps/api`) and measure the asynchronous
BullMQ email-job pipeline (`apps/worker`).

---

## Table of Contents

1. [Architecture and Tested Endpoints](#1-architecture-and-tested-endpoints)
2. [Prerequisites](#2-prerequisites)
3. [Installing k6](#3-installing-k6)
4. [Email Safety — Test Transport](#4-email-safety--test-transport)
5. [Environment Variables](#5-environment-variables)
6. [Starting Services](#6-starting-services)
7. [Test Scenarios](#7-test-scenarios)
8. [Running the Tests (Windows PowerShell)](#8-running-the-tests-windows-powershell)
9. [Saving and Comparing Results](#9-saving-and-comparing-results)
10. [Asynchronous Job Metrics](#10-asynchronous-job-metrics)
11. [Resource Monitoring](#11-resource-monitoring)
12. [Interpreting Results](#12-interpreting-results)
13. [Resetting Test Data](#13-resetting-test-data)
14. [Observability Limitations](#14-observability-limitations)
15. [Suggested Benchmark Procedure](#15-suggested-benchmark-procedure)

---

## 1. Architecture and Tested Endpoints

```
k6 generator
    │
    ▼  HTTP
┌─────────────────────────────────┐
│  Express API  (apps/api)        │
│                                 │
│  GET  /health                   │  → { status: "ok" }
│  GET  /jobs/stats               │  → { queued, processing, completed, failed, total }
│  GET  /jobs/:id                 │  → full job record (UUID, status, timestamps)
│  POST /jobs                     │  → 202 { jobId, status: "queued" }
│                                 │
│  No authentication (v1 state)   │
└────────────┬────────────────────┘
             │ BullMQ  (Redis queue "email")
             ▼
┌─────────────────────────────────┐
│  Email Worker  (apps/worker)    │
│                                 │
│  - Picks jobs from queue        │
│  - Updates PostgreSQL status    │
│  - Sends email (or JSON mock)   │
│  - Concurrency: 1               │
│  - Retries: 3, exponential 1 s  │
└─────────────────────────────────┘
```

**Important constraints discovered during code inspection:**

- There is **no authentication** in the current codebase. The `.env.example` references `JWT_SECRET`/`JWT_EXPIRES_IN` but no middleware implements it yet. All endpoints are fully public.
- **Worker concurrency is 1.** Maximum sustainable job processing rate is bounded by how fast one worker can process a single job (network I/O to Gmail in production; near-instant with the test transport).
- Redis connection is **hardcoded to `localhost:6379`** (not configurable via env var).

---

## 2. Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | ≥ 22 | Helper scripts (`check-jobs.mjs`, `monitor-stats.mjs`) |
| pnpm | ≥ 12 | Running the API and worker |
| Docker Desktop | ≥ 4 | PostgreSQL and Redis via Docker Compose |
| k6 | ≥ 0.55 | Load generator |

---

## 3. Installing k6

### Windows (recommended — winget)

```powershell
winget install k6 --source winget
```

### Windows (Chocolatey)

```powershell
choco install k6
```

### Windows (manual)

Download the `.msi` installer from https://github.com/grafana/k6/releases/latest,
run it, and restart your terminal.

### Verify installation

```powershell
k6 version
```

Expected output: `k6 v0.5x.x (go1.xx.x, windows/amd64)`

---

## 4. Email Safety — Test Transport

> [!CAUTION]
> **Load tests must never send real emails.** The default production worker
> uses Gmail via Nodemailer. Running load tests against the production
> transport would send thousands of real emails, exhaust Gmail rate limits,
> and expose credentials to test traffic.

The worker's `mailer.ts` supports a safe test transport activated by a
single environment variable:

```
MAIL_TRANSPORT=test
```

When this variable is set the worker uses **Nodemailer's `jsonTransport`**,
which serialises each message to JSON in memory and returns immediately
without opening any network connection. No email is sent; no SMTP
credentials are needed.

**You must set `MAIL_TRANSPORT=test` when starting the worker for any load test.**

Verification: The worker logs the following line on startup when the test
transport is active:

```
[mailer] MAIL_TRANSPORT=test — using JSON transport. No real emails will be sent.
```

If you do not see this line, **stop the test immediately** — the worker is
using the real Gmail transport.

---

## 5. Environment Variables

### Load-test variables (k6)

Set these as PowerShell environment variables **or** pass them with `k6 run --env KEY=VALUE`.

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_URL` | `http://localhost:3000` | API base URL |
| `JOB_POLL_TIMEOUT_MS` | `30000` | Smoke test: max ms to wait for job completion |
| `JOB_POLL_INTERVAL_MS` | `500` | Smoke test: poll retry interval |
| `LOAD_TARGET_RPS` | `5` | Load test: target requests per second |
| `LOAD_DURATION` | `1m` | Load test: duration string (e.g. `"30s"`, `"2m"`) |
| `STRESS_MAX_RPS` | `20` | Stress test: peak rate |
| `SOAK_TARGET_RPS` | `3` | Soak test: sustained rate |
| `SOAK_DURATION` | `5m` | Soak test: duration |
| `MAX_VUS` | `50` | All tests: absolute VU ceiling |

Copy `load-tests/.env.example` to `load-tests/.env` and edit as needed.

### Application variables (worker)

| Variable | Required for tests | Description |
|----------|--------------------|-------------|
| `MAIL_TRANSPORT` | **Yes, must be `test`** | Activates the safe JSON transport |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `GMAIL_USER` | Not needed when `MAIL_TRANSPORT=test` | Gmail username |
| `GMAIL_APP_PASSWORD` | Not needed when `MAIL_TRANSPORT=test` | Gmail app password |

---

## 6. Starting Services

### Step 1 — Start Docker services (PostgreSQL + Redis)

```powershell
docker compose up -d
```

Wait for the postgres healthcheck to pass:

```powershell
docker compose ps
```

Postgres should show `healthy`.

### Step 2 — Run database migrations (first time only)

```powershell
pnpm --filter @repo/database db:migrate
```

### Step 3 — Start the API (Terminal 1)

```powershell
pnpm dev:api
```

Expected: `API running on http://localhost:3000`

Verify:

```powershell
Invoke-RestMethod http://localhost:3000/health
```

Expected: `status: ok`

### Step 4 — Start the worker with the test transport (Terminal 2)

> [!IMPORTANT]
> You MUST include `MAIL_TRANSPORT=test`. Omitting it will cause the worker
> to attempt real Gmail delivery during your load test.

```powershell
$env:MAIL_TRANSPORT = "test"
pnpm dev:worker
```

Expected on startup:

```
[mailer] MAIL_TRANSPORT=test — using JSON transport. No real emails will be sent.
Email worker started
```

### Step 5 (optional) — Start the stats monitor (Terminal 3)

```powershell
node load-tests/scripts/monitor-stats.mjs
```

This streams queue depth and completion counts live while tests run.

---

## 7. Test Scenarios

### Smoke (`scenarios/smoke.js`)

| Property | Value |
|----------|-------|
| Executor | `shared-iterations` |
| VUs | 1 |
| Iterations | 1 |
| Max duration | 2 minutes |
| Target rate | N/A |

**What it does:**
Walks through every endpoint in sequence:
1. `GET /health` — basic liveness
2. `GET /jobs/stats` — observability baseline
3. `POST /jobs` (valid) — creates a job, captures the `jobId`
4. `POST /jobs` (idempotency) — sends identical request twice with same `Idempotency-Key`, verifies 200 deduplicate response with matching `jobId`
5. `POST /jobs` (idempotency conflict) — same key, different payload, expects 409
6. `POST /jobs` (invalid payload) — expects 400 validation error
7. `GET /jobs/:id` (non-UUID) — expects 400
8. `GET /jobs/:id` (nil UUID) — expects 404
9. Polls `GET /jobs/:id` until `completed` or `failed` — end-to-end async verification
10. `GET /jobs/stats` after — verifies total increased

**Requires:** Worker running with `MAIL_TRANSPORT=test`.

---

### Load (`scenarios/load.js`)

| Property | Value |
|----------|-------|
| Executor | `constant-arrival-rate` |
| Rate | `LOAD_TARGET_RPS` (default 5 rps) |
| Duration | `LOAD_DURATION` (default 1 min) |
| Max VUs | `MAX_VUS` (default 50) |

**What it does:**
Submits `POST /jobs` at a constant rate. Every 10 iterations VU 1 also
sends an intentionally invalid payload to verify the validation layer
remains active under load.

**Custom metrics produced:**

| Metric | Description |
|--------|-------------|
| `load_jobs_submitted_total` | Total POST /jobs requests sent |
| `load_jobs_queued_total` | Successful 202 responses |
| `load_submission_errors_total` | Non-202 responses |
| `load_submission_latency_ms` | Wall-clock POST /jobs duration (p50/p90/p95/p99) |
| `load_validation_latency_ms` | 400-path latency |

**Note on `dropped_iterations`:** If k6 reports `dropped_iterations > 0`,
the arrival rate target was not achieved. Either increase `MAX_VUS` or
lower `LOAD_TARGET_RPS`.

---

### Stress (`scenarios/stress.js`)

| Property | Value |
|----------|-------|
| Executor | `ramping-arrival-rate` |
| Start rate | 1 rps |
| Stages | 20 % → 50 % → 100 % of `STRESS_MAX_RPS`, with hold periods |
| Total duration | ~3.5 min (default STRESS_MAX_RPS=20) |
| Max VUs | `MAX_VUS` (default 50) |

**Stage schedule (default values):**

```
  0 →  4 rps  in 30 s
       4 rps  hold  30 s
  4 → 10 rps  in 30 s
      10 rps  hold  30 s
 10 → 20 rps  in 30 s
      20 rps  hold  30 s
 20 →  0 rps  in 15 s  (cooldown)
```

**What it does:**
Drives the API through increasing load levels to find where latency or
error rates cross unacceptable thresholds. The breaking point is the stage
where `http_req_duration{p95}` spikes or `stress_5xx_errors_total`
begins accumulating.

**Custom metrics produced:**

| Metric | Description |
|--------|-------------|
| `stress_jobs_submitted_total` | Total submissions |
| `stress_jobs_queued_total` | Successful 202 responses |
| `stress_5xx_errors_total` | HTTP 500+ responses |
| `stress_submission_latency_ms` | POST /jobs latency per stage |

---

### Soak (`scenarios/soak.js`)

| Property | Value |
|----------|-------|
| Executor | `constant-arrival-rate` |
| Rate | `SOAK_TARGET_RPS` (default 3 rps) |
| Duration | `SOAK_DURATION` (default 5 min) |
| Max VUs | `MAX_VUS` (default 50) |

**What it does:**
Holds a low, steady submission rate for an extended period to expose:
- Memory leaks (Node.js RSS growth)
- Redis key accumulation
- Connection pool exhaustion
- Gradual latency drift

Every ~60 seconds VU 1 calls `GET /jobs/stats` and logs queue depth to
the k6 console. A rising queue depth indicates the worker cannot keep pace.

**Custom metrics produced:**

| Metric | Description |
|--------|-------------|
| `soak_jobs_submitted_total` | Total submissions |
| `soak_jobs_queued_total` | Successful 202 responses |
| `soak_submission_errors_total` | Non-202 responses |
| `soak_submission_latency_ms` | POST /jobs latency |
| `soak_queue_depth` (Gauge) | Last-observed queued + processing count |

---

## 8. Running the Tests (Windows PowerShell)

### Quick-start (all defaults)

```powershell
# Terminal 1
pnpm dev:api

# Terminal 2
$env:MAIL_TRANSPORT = "test"
pnpm dev:worker

# Terminal 3 (optional — live queue monitor)
node load-tests/scripts/monitor-stats.mjs

# Terminal 4 — run tests
k6 run load-tests/scenarios/smoke.js
k6 run load-tests/scenarios/load.js
k6 run load-tests/scenarios/stress.js
k6 run load-tests/scenarios/soak.js
```

### Override specific settings inline

```powershell
# Load test at 10 rps for 2 minutes
k6 run --env LOAD_TARGET_RPS=10 --env LOAD_DURATION=2m load-tests/scenarios/load.js

# Stress test with a higher peak
k6 run --env STRESS_MAX_RPS=40 --env MAX_VUS=100 load-tests/scenarios/stress.js

# Soak at 5 rps for 10 minutes
k6 run --env SOAK_TARGET_RPS=5 --env SOAK_DURATION=10m load-tests/scenarios/soak.js
```

### Using pnpm scripts (added to root package.json)

```powershell
pnpm k6:smoke
pnpm k6:load
pnpm k6:stress
pnpm k6:soak
```

---

## 9. Saving and Comparing Results

### Save JSON output

```powershell
# Create results directory
New-Item -ItemType Directory -Force -Path load-tests/results

# Run and save
k6 run --out json=load-tests/results/smoke-$(Get-Date -Format 'yyyyMMdd-HHmm').json load-tests/scenarios/smoke.js
k6 run --out json=load-tests/results/load-$(Get-Date -Format 'yyyyMMdd-HHmm').json load-tests/scenarios/load.js
k6 run --out json=load-tests/results/stress-$(Get-Date -Format 'yyyyMMdd-HHmm').json load-tests/scenarios/stress.js
k6 run --out json=load-tests/results/soak-$(Get-Date -Format 'yyyyMMdd-HHmm').json load-tests/scenarios/soak.js
```

> [!NOTE]
> The JSON output file contains one data point per sample, which can be large
> for long soak tests. Use k6's `--out csv=` instead for more compact output,
> or redirect only the summary: `k6 run ... 2>&1 | Tee-Object -FilePath results.txt`

### Compare two runs

The k6 summary table is printed at the end of every run. Copy the
`http_req_duration` and `checks` sections from two runs to compare.
For a more structured comparison, parse the JSON output files:

```powershell
# Show p95 from a saved JSON result
Get-Content load-tests/results/load-*.json |
  ConvertFrom-Json |
  Where-Object { $_.type -eq "Point" -and $_.metric -eq "http_req_duration" } |
  Measure-Object -Property value -Average -Maximum
```

---

## 10. Asynchronous Job Metrics

HTTP submission latency and email-job completion latency are **separate
measurements**. `POST /jobs` returns `202 Accepted` as soon as the job is
written to PostgreSQL and enqueued in Redis — typically < 50 ms. The actual
email processing (or test-transport mock) happens asynchronously in the worker.

### Checking job completion after a test

**Option A — poll individual job IDs**

```powershell
node load-tests/scripts/check-jobs.mjs \
  "uuid-1" "uuid-2" "uuid-3"
```

**Option B — poll aggregate stats until queue drains**

```powershell
# Wait up to 5 minutes for all pending jobs to complete
node load-tests/scripts/check-stats.mjs

# If you know how many jobs were submitted (e.g., 300):
$env:EXPECT_TOTAL = "300"
node load-tests/scripts/check-stats.mjs
```

**Option C — query PostgreSQL directly**

```powershell
docker exec -it distributed-job-queue-postgres psql -U jobqueue -d jobqueue -c `
  "SELECT status, COUNT(*) FROM jobs GROUP BY status ORDER BY status;"
```

### End-to-end latency estimation

The `jobs` table has `created_at` (enqueue time) and `completed_at`
(completion time). You can derive end-to-end latency for any test run:

```sql
SELECT
  AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000) AS avg_e2e_ms,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY
    EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000
  ) AS p95_e2e_ms,
  COUNT(*) FILTER (WHERE status = 'completed') AS completed,
  COUNT(*) FILTER (WHERE status = 'failed')    AS failed
FROM jobs
WHERE created_at > NOW() - INTERVAL '10 minutes';
```

Run via:

```powershell
docker exec -it distributed-job-queue-postgres psql -U jobqueue -d jobqueue -c `
  "SELECT AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000) AS avg_e2e_ms, COUNT(*) FROM jobs WHERE created_at > NOW() - INTERVAL '10 minutes' AND completed_at IS NOT NULL;"
```

---

## 11. Resource Monitoring

Run these in separate terminals **while a test is in progress**.

### Docker container stats (all containers)

```powershell
docker stats distributed-job-queue-redis distributed-job-queue-postgres
```

Key columns: `CPU %`, `MEM USAGE / LIMIT`, `NET I/O`, `BLOCK I/O`.

### Redis command activity

```powershell
docker exec -it distributed-job-queue-redis redis-cli monitor
```

Press Ctrl+C to stop. Watch for BullMQ `ZADD`, `XADD`, `LMOVE` commands
to observe queue operations.

### Redis memory and key counts

```powershell
docker exec -it distributed-job-queue-redis redis-cli info memory
docker exec -it distributed-job-queue-redis redis-cli dbsize
```

### PostgreSQL connection count

```powershell
docker exec -it distributed-job-queue-postgres psql -U jobqueue -d jobqueue -c `
  "SELECT count(*) FROM pg_stat_activity WHERE datname = 'jobqueue';"
```

### PostgreSQL active queries (slow query detection)

```powershell
docker exec -it distributed-job-queue-postgres psql -U jobqueue -d jobqueue -c `
  "SELECT pid, now() - pg_stat_activity.query_start AS duration, query, state FROM pg_stat_activity WHERE state != 'idle' ORDER BY duration DESC LIMIT 10;"
```

### Node.js process memory (API)

```powershell
# Get the PID of the tsx / node process
Get-Process -Name "node" | Select-Object Id, CPU, WorkingSet, PagedMemorySize
```

### Distinguishing bottlenecks

| Symptom | Likely bottleneck |
|---------|-------------------|
| API p95 latency climbs, DB CPU low, Redis low | Node.js event loop / connection pool |
| PostgreSQL CPU > 80 % | DB query performance |
| PostgreSQL connections near pool max (10) | Connection exhaustion — reduce `LOAD_TARGET_RPS` |
| Redis memory grows steadily during soak | Worker backlog accumulation; concurrency too low |
| k6 `dropped_iterations` > 0 | Load generator is the bottleneck — increase `MAX_VUS` |
| All metrics stable but Redis memory grows | BullMQ completed-job retention settings |

---

## 12. Interpreting Results

### k6 summary table

```
✓ health → status 200
✓ submit → status 202
✗ end-to-end: job reached 'completed' (not 'failed')

http_req_duration............: avg=12.3ms p(90)=18ms p(95)=22ms p(99)=67ms
http_req_failed..............: 0.00%
checks.......................: 98.50% ✓ 197 ✗ 3
load_jobs_submitted_total....: 300
load_jobs_queued_total.......: 300
load_submission_latency_ms...: p(95)=22ms
dropped_iterations...........: 0
```

**Key fields:**

| Field | What it means |
|-------|---------------|
| `http_req_duration p(95)` | 95th-percentile end-to-end HTTP latency (network + API + DB + Redis) |
| `http_req_failed` | Fraction of requests k6 failed to send (transport error, not HTTP 4xx/5xx) |
| `checks` | Fraction of k6 `check()` assertions that passed |
| `dropped_iterations` | Iterations k6 could not start because all VUs were busy — target rate not achieved |
| `load_jobs_queued_total` | Confirmed successfully enqueued jobs |
| `soak_queue_depth` | Last-sampled pending job count from `GET /jobs/stats` |

### Threshold interpretation

Thresholds marked `✗` cause k6 to exit with code 99 (non-zero). This is
useful for CI but the default thresholds are **initial examples, not proven
performance contracts**. Adjust them in each scenario file after establishing
a baseline on your machine.

---

## 13. Resetting Test Data

> [!WARNING]
> The cleanup query below removes ALL rows from the `jobs` table created by
> load tests. It preserves production rows if you use a different database
> (`DATABASE_URL`). Never run this against a shared or production database.

Identify load-test rows by their synthetic `recipient` field:

```powershell
# Preview what would be deleted
docker exec -it distributed-job-queue-postgres psql -U jobqueue -d jobqueue -c `
  "SELECT COUNT(*) FROM jobs WHERE recipient LIKE '%@loadtest.example.invalid';"

# Delete only load-test rows
docker exec -it distributed-job-queue-postgres psql -U jobqueue -d jobqueue -c `
  "DELETE FROM jobs WHERE recipient LIKE '%@loadtest.example.invalid';"
```

All k6-generated payloads use the `@loadtest.example.invalid` domain, which
is guaranteed not to appear in real traffic.

### Clear Redis BullMQ data (optional)

BullMQ stores job state in Redis. After clearing PostgreSQL rows you may
also want to flush completed BullMQ jobs:

```powershell
docker exec -it distributed-job-queue-redis redis-cli FLUSHDB
```

> [!CAUTION]
> `FLUSHDB` removes ALL keys in the Redis database — including any
> real BullMQ jobs that have not yet been processed. Only run this in
> a local development environment when you are certain no real jobs are pending.

---

## 14. Observability Limitations

The following metrics are **not currently available** from the application
and are therefore not measured in these tests. Implementing them would
require additional code changes beyond the minimal scope of this suite.

| Metric | Why it is unavailable |
|--------|----------------------|
| Per-job queue wait time (inline) | Not exposed in real time; derivable from DB timestamps post-hoc (see §10) |
| Worker processing duration | No timing instrumentation in `email.worker.ts`; derive from `startedAt` and `completedAt` |
| Worker concurrency utilisation | BullMQ does not expose a live concurrency gauge; would require a custom BullMQ `QueueEvents` listener |
| Event-loop lag | No `@matteodisabatino/gc-stats` or `perf_hooks` instrumentation exists |
| Redis connection count from the app | Not exposed; observable from the Redis side via `redis-cli info clients` |
| Retry frequency per job | Not surfaced in the API; query `SELECT id, attempts, error FROM jobs WHERE attempts > 1` |
| Queue throughput as jobs/s | Derivable from `soak_queue_depth` Gauge samples and `soak_jobs_queued_total` counter |

### Implemented observability additions

This suite introduces one new API endpoint to fill the most critical gap:

**`GET /jobs/stats`** — added to `apps/api/src/app.ts`

```json
{
  "queued": 12,
  "processing": 1,
  "completed": 847,
  "failed": 0,
  "total": 860
}
```

This is a single `GROUP BY` aggregate query. Do not call it on a hot path;
it is intended for monitoring tooling only.

---

## 15. Suggested Benchmark Procedure

Follow these four steps to establish a baseline, find a bottleneck, apply one
optimisation, and compare the result.

### Step 1 — Establish a baseline

Run the smoke test to verify everything works end-to-end:

```powershell
k6 run load-tests/scenarios/smoke.js
```

Then run the load test at a conservative rate and save the output:

```powershell
$baseline = "load-tests/results/baseline-$(Get-Date -Format 'yyyyMMdd-HHmm').json"
k6 run --out "json=$baseline" load-tests/scenarios/load.js
```

Note the `http_req_duration` p95 and `load_jobs_queued_total` from the summary.

### Step 2 — Find the breaking point

```powershell
k6 run load-tests/scenarios/stress.js
```

Watch the k6 console output while this runs (open the monitor in a second
terminal). Identify which stage causes latency or errors to spike:

```powershell
node load-tests/scripts/monitor-stats.mjs
```

Record the approximate RPS at which degradation begins. This is your
**system capacity estimate**.

### Step 3 — Reproduce a specific bottleneck

Set `LOAD_TARGET_RPS` to 80 % of the breaking-point rate and run the load
test again to get a stable degradation baseline:

```powershell
k6 run --env LOAD_TARGET_RPS=16 `
       --out "json=load-tests/results/at-capacity-$(Get-Date -Format 'yyyyMMdd-HHmm').json" `
       load-tests/scenarios/load.js
```

Check PostgreSQL active connections and slow queries (§11) to isolate
whether the bottleneck is the API, the DB, Redis, or the worker.

### Step 4 — Apply one change and compare

Common high-impact single changes:
- Increase PostgreSQL connection pool size (in `packages/database/src/client.ts`): `max: 10` → `max: 20`
- Increase worker `concurrency` (in `apps/worker/src/email.worker.ts`): `concurrency: 1` → `concurrency: 4`
- Add a database index on `jobs.status` if the `GET /jobs/stats` query becomes slow

After making the change, re-run the same load configuration:

```powershell
k6 run --env LOAD_TARGET_RPS=16 `
       --out "json=load-tests/results/after-change-$(Get-Date -Format 'yyyyMMdd-HHmm').json" `
       load-tests/scenarios/load.js
```

Compare `http_req_duration p95` and `load_jobs_queued_total` between the
`at-capacity` and `after-change` result files. A meaningful improvement
shows directly in these numbers.

### Step 5 — Verify stability with the soak test

Once the optimised configuration handles the target load, confirm stability:

```powershell
k6 run --env SOAK_TARGET_RPS=12 --env SOAK_DURATION=15m `
       --out "json=load-tests/results/soak-optimised-$(Get-Date -Format 'yyyyMMdd-HHmm').json" `
       load-tests/scenarios/soak.js
```

A flat p95 line and a `soak_queue_depth` gauge that stays near zero indicate
the system is stable at the new configuration.
