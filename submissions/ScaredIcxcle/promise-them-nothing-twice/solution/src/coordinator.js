// COORDINATOR
//
// Single atomic source of truth all 3 app nodes call. Node completes each
// request's synchronous JS before picking up the next (no `await` between
// reading and mutating state below), so the check-and-increment here is
// atomic with respect to concurrent callers - the same property Redis
// INCR/Lua or a DB row lock would give in production. Documented stand-in
// for Redis (platform wiki: "may or may not be available") - see
// DECISIONS.md for the tradeoff, not hidden.

const http = require('http');
const { getEffectiveLimit, loadConfig } = require('./limits');

const WINDOW_MS = 60 * 1000; // sliding 60-second window = "per minute"
const PORT = process.env.COORDINATOR_PORT || 4000;

const config = loadConfig();
const logs = new Map(); // customerId -> [timestamps ms], ascending

function pruneOld(timestamps, nowMs) {
  const cutoff = nowMs - WINDOW_MS;
  let i = 0;
  while (i < timestamps.length && timestamps[i] <= cutoff) i++;
  if (i > 0) timestamps.splice(0, i);
}

function tryConsume(customerId, nowUtcMinutes) {
  const nowMs = Date.now();
  const { rpm, reason, found } = getEffectiveLimit(customerId, nowUtcMinutes, config);

  if (!logs.has(customerId)) logs.set(customerId, []);
  const timestamps = logs.get(customerId);
  pruneOld(timestamps, nowMs);

  if (timestamps.length < rpm) {
    timestamps.push(nowMs);
    return { allowed: true, limit: rpm, remaining: rpm - timestamps.length, reason };
  }

  const oldest = timestamps[0];
  const retryAfterMs = Math.max(0, WINDOW_MS - (nowMs - oldest));
  return {
    allowed: false,
    limit: rpm,
    remaining: 0,
    retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
    reason,
    found,
  };
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/consume') {
    res.writeHead(404);
    res.end();
    return;
  }
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    try {
      const { customerId, nowUtcMinutes } = JSON.parse(body);
      const result = tryConsume(customerId, nowUtcMinutes);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`[coordinator] listening on ${PORT}`);
});