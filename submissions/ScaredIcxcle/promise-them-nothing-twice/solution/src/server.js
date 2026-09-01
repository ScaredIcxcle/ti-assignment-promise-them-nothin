// APP NODE
//
// Stateless: holds no counters itself, delegates every rate-limit decision
// to the coordinator. Run 3 of these on different ports to simulate the
// 3-node deployment behind a (harness-simulated) load balancer.

const http = require('http');
const { nowUtcMinutes } = require('./clock');

const PORT = process.env.NODE_PORT || 5001;
const COORDINATOR_PORT = process.env.COORDINATOR_PORT || 4000;
const NODE_ID = process.env.NODE_ID || `node-${PORT}`;

function askCoordinator(customerId, nowMin) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ customerId, nowUtcMinutes: nowMin });
    const req = http.request(
      {
        hostname: 'localhost',
        port: COORDINATOR_PORT,
        path: '/consume',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url !== '/api/v1/ping') {
    res.writeHead(404);
    res.end();
    return;
  }
  const customerId = req.headers['x-customer-id'];
  if (!customerId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing X-Customer-Id header' }));
    return;
  }

  const nowMin = nowUtcMinutes(req.headers);

  try {
    const result = await askCoordinator(customerId, nowMin);
    if (result.allowed) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Served-By': NODE_ID,
        'X-RateLimit-Limit': result.limit,
        'X-RateLimit-Remaining': result.remaining,
      });
      res.end(JSON.stringify({ ok: true, servedBy: NODE_ID, limit: result.limit, remaining: result.remaining }));
    } else {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'X-Served-By': NODE_ID,
        'Retry-After': result.retryAfterSeconds,
      });
      res.end(
        JSON.stringify({ ok: false, servedBy: NODE_ID, limit: result.limit, retryAfterSeconds: result.retryAfterSeconds })
      );
    }
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'coordinator unreachable', detail: String(err) }));
  }
});

server.listen(PORT, () => {
  console.log(`[${NODE_ID}] listening on ${PORT}`);
});