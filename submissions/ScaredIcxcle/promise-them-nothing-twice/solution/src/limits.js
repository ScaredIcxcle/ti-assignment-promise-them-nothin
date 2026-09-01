const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'customers.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// "HH:MM" -> minutes since midnight UTC
function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Does `nowMin` fall inside [startMin, endMin), handling midnight wraparound
// (endMin < startMin means the window crosses midnight, e.g. 04:15 -> 01:45).
function inWindow(nowMin, startMin, endMin) {
  if (startMin === endMin) return true; // 00:00 -> 00:00 = "always on"
  if (endMin > startMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin; // wraps past midnight
}

// The ONLY function the rate-limiting middleware calls to find a customer's
// limit. No customerId-specific branches - Northwind's higher number lives
// in config data (customers.json), not in this code.
function getEffectiveLimit(customerId, nowUtcMinutes, config) {
  const cfg = config || loadConfig();
  const customer = cfg.customers.find((c) => c.customerId === customerId);
  if (!customer) {
    return { rpm: 0, reason: 'unknown customer — denied by default', found: false };
  }
  for (const entry of customer.schedule) {
    const startMin = toMinutes(entry.startUtc);
    const endMin = toMinutes(entry.endUtc);
    if (inWindow(nowUtcMinutes, startMin, endMin)) {
      return {
        rpm: entry.rpm,
        reason: entry.reason,
        approvedBy: entry.approvedBy,
        effectiveDate: entry.effectiveDate,
        found: true,
      };
    }
  }
  // Fail closed, per Priya's "under-limit, never over-limit" directive.
  return { rpm: 0, reason: 'no matching schedule window — denied by default', found: false };
}

module.exports = { loadConfig, getEffectiveLimit, toMinutes, inWindow };