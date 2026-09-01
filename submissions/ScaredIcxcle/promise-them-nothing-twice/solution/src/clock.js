// Returns "now" as minutes-since-midnight UTC.
//
// By default this is the real clock. The harness needs to demonstrate
// Northwind's behavior at 02:30 UTC (burst) AND at, say, 10:00 UTC
// (off-peak) in the same run, without waiting for real time to pass.
// A node started with ALLOW_TIME_OVERRIDE=true will honor an
// `X-Debug-Now-Utc-Minutes` request header.
//
// This override is generic (changes what time the whole service thinks it
// is), not customer-specific - a test seam, not a per-customer bypass -
// and is OFF by default.
function nowUtcMinutes(headers) {
  if (process.env.ALLOW_TIME_OVERRIDE === 'true' && headers && headers['x-debug-now-utc-minutes']) {
    const override = parseInt(headers['x-debug-now-utc-minutes'], 10);
    if (!Number.isNaN(override)) return override;
  }
  const d = new Date();
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

module.exports = { nowUtcMinutes };