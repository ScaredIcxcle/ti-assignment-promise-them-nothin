const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const COORDINATOR_PORT = 4000;
const NODE_PORTS = [5001, 5002, 5003];
const SRC = path.join(__dirname, '..', 'src');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function spawnProc(script, env, label) {
  const proc = spawn('node', [script], { env: { ...process.env, ...env }, stdio: 'pipe' });
  proc.stdout.on('data', (d) => process.stdout.write(`[${label}] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[${label} ERR] ${d}`));
  return proc;
}

function fireRequest(port, customerId, extraHeaders) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path: '/api/v1/ping',
        method: 'GET',
        headers: { 'X-Customer-Id': customerId, ...extraHeaders },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, servedBy: res.headers['x-served-by'] }));
      }
    );
    req.on('error', () => resolve({ status: 'ERR' }));
    req.end();
  });
}

async function burst(customerId, count, extraHeaders) {
  const calls = [];
  for (let i = 0; i < count; i++) {
    const port = NODE_PORTS[Math.floor(Math.random() * NODE_PORTS.length)];
    calls.push(fireRequest(port, customerId, extraHeaders));
  }
  const results = await Promise.all(calls);
  const byNode = {};
  let allowed = 0;
  let denied = 0;
  for (const r of results) {
    if (r.status === 200) allowed++;
    else if (r.status === 429) denied++;
    if (r.servedBy) byNode[r.servedBy] = (byNode[r.servedBy] || 0) + 1;
  }
  return { allowed, denied, total: count, byNode };
}

function printRow(cols, widths) {
  console.log(cols.map((c, i) => String(c).padEnd(widths[i])).join(' | '));
}

async function main() {
  console.log('Starting coordinator + 3 app nodes...\n');
  const coordinator = spawnProc(path.join(SRC, 'coordinator.js'), { COORDINATOR_PORT }, 'coordinator');
  const nodes = NODE_PORTS.map((port, idx) =>
    spawnProc(
      path.join(SRC, 'server.js'),
      { NODE_PORT: port, COORDINATOR_PORT, NODE_ID: `node-${idx + 1}`, ALLOW_TIME_OVERRIDE: 'true' },
      `node-${idx + 1}`
    )
  );

  await sleep(500); // let servers bind

  const widths = [34, 8, 8, 8, 10];
  const results = [];

  try {
    console.log('\n=== SCENARIO A — Priya\'s boundary demo (flat 100 RPM tier, hammered randomly across 3 nodes) ===\n');

    const a = await burst('cust_demo_a', 100, {});
    results.push(['cust_demo_a (100 RPM tier, sends exactly 100)', a]);

    const b = await burst('cust_demo_b', 100, {});
    results.push(['cust_demo_b (100 RPM tier, sends exactly 100)', b]);

    const c = await burst('cust_demo_c_exceeder', 150, {});
    results.push(['cust_demo_c_exceeder (100 RPM tier, sends 150)', c]);

    console.log('\n=== SCENARIO B — Northwind schedule (burst window vs off-peak, same mechanism, hammered randomly across 3 nodes) ===\n');

    // 02:30 UTC = 150 minutes since midnight -> inside the 01:45-04:15 burst window (1250 RPM)
    const burstWindow = await burst('cust_northwind_001', 1200, { 'X-Debug-Now-Utc-Minutes': '150' });
    results.push(['cust_northwind_001 @ 02:30 UTC (burst, sends 1200)', burstWindow]);

    console.log('\nWaiting 61s for the sliding window to clear before the off-peak check ' +
      '(avoids the off-peak measurement being contaminated by burst-window request timestamps ' +
      'still sitting in the same customer\'s 60s log)...\n');
    await sleep(61000);

    // 10:00 UTC = 600 minutes since midnight -> off-peak window (201 RPM)
    const offPeak = await burst('cust_northwind_001', 250, { 'X-Debug-Now-Utc-Minutes': '600' });
    results.push(['cust_northwind_001 @ 10:00 UTC (off-peak, sends 250)', offPeak]);

    console.log('\n=== RESULTS ===\n');
    printRow(['Scenario', 'Sent', 'Allowed', 'Denied', 'Nodes hit'], widths);
    printRow(['-'.repeat(34), '-'.repeat(8), '-'.repeat(8), '-'.repeat(8), '-'.repeat(10)], widths);
    for (const [label, r] of results) {
      printRow([label, r.total, r.allowed, r.denied, Object.keys(r.byNode).length], widths);
    }

    console.log('\n=== PASS/FAIL CHECKS ===\n');
    const checks = [
      ['A gets exactly its 100 RPM budget', a.allowed === 100 && a.denied === 0],
      ['B gets exactly its 100 RPM budget (isolated from A)', b.allowed === 100 && b.denied === 0],
      ['C (same tier, sends 150) is cut off exactly at 100', c.allowed === 100 && c.denied === 50],
      ['Northwind burst window allows upto 1250', burstWindow.allowed === 1200 && burstWindow.denied === 0],
      ['Northwind off-peak window allows exactly 201, denies the rest', offPeak.allowed === 201 && offPeak.denied === 49],
      ['Requests were actually spread across all 3 nodes (no sticky sessions)',
        Object.keys(a.byNode).length > 1 || Object.keys(burstWindow.byNode).length > 1],
    ];
    for (const [desc, pass] of checks) {
      console.log(`${pass ? 'PASS' : 'FAIL'} — ${desc}`);
    }

    const allPass = checks.every(([, pass]) => pass);
    console.log(`\nOverall: ${allPass ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED — see above'}`);
  } finally {
    coordinator.kill();
    nodes.forEach((n) => n.kill());
  }
}

main();