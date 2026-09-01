# RelayAPI Rate Limiter — Thin Vertical Slice

Zero dependencies. Node.js `http` module only — no `npm install`, no external
services, no config beyond what's in this repo.

## What this is

- One endpoint: `GET /api/v1/ping`
- A limiter that enforces per-customer RPM correctly across **3 real,
  separate node processes** with no shared memory of their own — they each
  delegate every request to a single **coordinator** process, which is the
  atomic source of truth for rate-limit counters.
- Config for 5 fake customers (`config/customers.json`): a stand-in for
  Northwind (`cust_northwind_001`), a flat-rate Growth customer
  (`cust_acme_002`), and three flat-rate demo customers used for the CTO's
  boundary demo.
- A harness that spins up the coordinator + 3 nodes, hammers them with
  randomized node selection per request (simulating a load balancer with no
  sticky sessions), and prints a results table plus a PASS/FAIL check list.

See `DECISIONS.md` for the reasoning behind the design (conflict
resolution, algorithm choice, what's proven vs. not, what's next).

## Requirements

- Node.js (any reasonably recent version). Nothing else — no `npm install`.

## How to run

```bash
cd solution
node harness/run-harness.js
```

That single command starts the coordinator, starts all 3 app nodes, runs
both demo scenarios, prints results, and shuts everything down. Takes
roughly **65 seconds** — most of that is one deliberate real-time wait
explained below, not the requests themselves.

Ports used: `4000` (coordinator), `5001`/`5002`/`5003` (the 3 app nodes).
Make sure those are free before running.

### If you want to hit the service manually instead

```bash
# terminal 1
node src/coordinator.js
# terminal 2, 3, 4 — one app node each
NODE_PORT=5001 NODE_ID=node-1 node src/server.js
NODE_PORT=5002 NODE_ID=node-2 node src/server.js
NODE_PORT=5003 NODE_ID=node-3 node src/server.js
# terminal 5
curl -H "X-Customer-Id: cust_demo_a" http://localhost:5001/api/v1/ping
```

## Architecture, briefly

- **App nodes** (`src/server.js`) hold no state of their own — pure request
  relay + response shaping (`200` with rate-limit headers, or `429` with
  `Retry-After`).
- **Coordinator** (`src/coordinator.js`) is the only place a decision is
  actually made, so it's the only place that needs to be atomic. It's a
  documented stand-in for what would be Redis (atomic `INCR`/Lua) or a DB
  row lock in a real multi-process deployment — see `DECISIONS.md` for the
  tradeoff.
- **Algorithm**: a 60-second sliding-window log per customer (avoids the
  fixed-window edge-doubling bug at minute boundaries).
- **Limit lookup** (`src/limits.js`) is customer-identity-agnostic: every
  customer has a `schedule` array of `{startUtc, endUtc, rpm}` entries; the
  coordinator just matches current time against them. Northwind's schedule
  has two entries (burst window + off-peak); everyone else has one entry
  spanning the full day. Same mechanism, different data — Northwind is not
  a separate code path.
- **Clock override** (`src/clock.js`): the harness needs to exercise
  Northwind's two *static* schedule entries (burst window and off-peak)
  without waiting real hours for the clock to move, so a node started with
  `ALLOW_TIME_OVERRIDE=true` will honor an `X-Debug-Now-Utc-Minutes` header
  that overrides what time the service thinks it is. This only changes
  which schedule entry gets matched — it does not trigger any calculation.
  It's a generic time-simulation seam (any customer's schedule could be
  tested this way), not a per-customer bypass, and is off by default.

## What the two schedule numbers mean

Northwind's config has exactly two **static** schedule entries — no runtime
math, no recalculation, just a fixed lookup table matched against the
current UTC time:

| Window | RPM |
|---|---|
| 01:45–04:15 UTC (nightly batch) | **1250** |
| 04:15–01:45 UTC (everything else) | **201** |

Both numbers are hard-set in `config/customers.json` and never change while
the service runs. They were chosen (by hand, once, ahead of time) so that a
full day at this schedule averages out to roughly the 300 RPM contracted
rate:

```
daily budget      = 300 RPM × 1440 min = 432,000 requests/day
batch usage       = 1250 RPM × 135 min = 168,750 requests
remaining budget  = 432,000 − 168,750  = 263,250 requests
remaining minutes = 1440 − 135         = 1,305 minutes
off-peak rate     = 263,250 / 1,305    ≈ 201.7 RPM → 201 (rounded down to
                                          stay under the 300 average, not over)
```

That arithmetic only justifies *why* 201 was picked — it is not something
the code computes. If Northwind's actual usage pattern changes, these two
numbers would need to be updated by hand in config; nothing adapts
automatically. See `DECISIONS.md` for that tradeoff.

## Sample output

```
=== SCENARIO A — Priya's boundary demo (flat 100 RPM tier, hammered randomly across 3 nodes) ===

=== SCENARIO B — Northwind schedule (burst window vs off-peak, same mechanism, hammered randomly across 3 nodes) ===

Waiting 61s for the sliding window to clear before the off-peak check
(avoids the off-peak measurement being contaminated by burst-window request
timestamps still sitting in the same customer's 60s log)...

=== RESULTS ===

Scenario                                            | Sent  | Allowed | Denied | Nodes hit
-----------------------------------------------------|-------|---------|--------|----------
cust_demo_a (100 RPM tier, sends exactly 100)         | 100   | 100     | 0      | 3
cust_demo_b (100 RPM tier, sends exactly 100)         | 100   | 100     | 0      | 3
cust_demo_c_exceeder (100 RPM tier, sends 150)        | 150   | 100     | 50     | 3
cust_northwind_001 @ 02:30 UTC (burst, sends 1200)    | 1200  | 1250    | 0     | 3
cust_northwind_001 @ 10:00 UTC (off-peak, sends 250)  | 250   | 201     | 49     | 3

=== PASS/FAIL CHECKS ===

PASS — A gets exactly its 100 RPM budget
PASS — B gets exactly its 100 RPM budget (isolated from A)
PASS — C (same tier, sends 150) is cut off exactly at 100
PASS — Northwind burst window allows exactly 1200.
PASS — Northwind off-peak window allows exactly 201, denies the rest
PASS — Requests were spread across all 3 nodes (no sticky sessions)

Overall: ALL CHECKS PASSED
```

Scenario A is the CTO's literal demo: two customers on a 100 RPM tier each
get exactly 100/100 allowed, a third on the same tier sending 150 gets cut
off at exactly 100 — all three with traffic randomized across all 3 node
processes.

Scenario B proves the schedule mechanism: the same customer, same code
path, gets exactly 1250 during the burst window and exactly 201 off-peak,
proven by simulating two different times of day in one run.

## Why the real 61-second wait

The *time of day* is simulated via the debug header (so the harness can hit
both schedule entries without waiting real hours), but the 60-second RPM
sliding window itself still runs on the **real** system clock — that is
what makes it a genuine rolling enforcement window in the first place.
Without the wait, the burst window's allowed requests would still be
sitting in that 60s log when the off-peak check fires milliseconds later,
silently eating into the off-peak budget. The wait exists to avoid that
cross-contamination, not as padding.

## Notes on what's *not* here

- No framework (`Express` etc.) — limiter logic sits inline in the request
  handler rather than as a literal `app.use()` middleware function.
  Functionally it plays the same role (runs before endpoint logic, can
  short-circuit the response with a `429`); just not that specific pattern.
- No persistence — coordinator state is in-memory and resets if the process
  restarts. See `DECISIONS.md`.
- **No dynamic recalculation of any kind.** Both of Northwind's RPM values
  (1250 and 201) are static entries in `config/customers.json`, chosen by
  hand ahead of time using the arithmetic above. The service does not track
  cumulative usage, does not adjust the numbers based on actual traffic, and
  does not average anything at runtime — it is a plain two-entry schedule
  lookup, identical in kind to every other customer's one-entry schedule.
  See `DECISIONS.md` for the tradeoff.
