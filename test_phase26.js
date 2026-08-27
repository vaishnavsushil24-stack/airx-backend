// Standalone functional test for the Phase 26 distributor payout anomaly
// detection logic (computeMedian, detectPayoutAnomalies in server.js).
// better-sqlite3/Express aren't exercised here (same reasoning as
// test_phase3/6/7/8/9.js, which reimplement the SQL-adjacent pure logic
// directly) — this reimplements the pure functions verbatim. The one
// DB-touching helper (getHistoricalPayoutsByMember) is intentionally NOT
// tested here, same as every other thin DB-lookup wrapper in this repo.
// Run with: node test_phase26.js

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("PASS:", msg);
  }
};

// Copied verbatim from server.js - keep in sync if that logic ever changes.
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
const PAYOUT_ANOMALY_OWN_HISTORY_MULTIPLIER = 3;
const PAYOUT_ANOMALY_NO_HISTORY_MULTIPLIER = 5;

function computeMedian(numbers) {
  if (!numbers.length) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function detectPayoutAnomalies(currentMembers, historicalPayoutsByMember) {
  const positiveAmounts = currentMembers.map((m) => Number(m.net_amount) || 0).filter((a) => a > 0);
  const runMedian = computeMedian(positiveAmounts);
  const anomalies = [];
  currentMembers.forEach((m) => {
    const amount = Number(m.net_amount) || 0;
    if (amount <= 0) return;
    const history = (historicalPayoutsByMember[m.member_code] || []).map(Number).filter((a) => a > 0);
    if (history.length) {
      const avg = round2(history.reduce((s, a) => s + a, 0) / history.length);
      if (avg > 0 && amount > avg * PAYOUT_ANOMALY_OWN_HISTORY_MULTIPLIER) {
        anomalies.push({ member_code: m.member_code, net_amount: amount, reason: `₹${amount} is ${round2(amount / avg)}x this member's own average payout (₹${avg}) — worth a quick check before paying out` });
      }
    } else if (runMedian > 0 && amount > runMedian * PAYOUT_ANOMALY_NO_HISTORY_MULTIPLIER) {
      anomalies.push({ member_code: m.member_code, net_amount: amount, reason: `first payout of ₹${amount} is ${round2(amount / runMedian)}x this run's median payout (₹${runMedian}) — worth a quick check before paying out` });
    }
  });
  return anomalies;
}

// ---- 1. computeMedian: odd and even counts ----
assert(computeMedian([10, 30, 20]) === 20, "median of an odd-length array is the middle value once sorted");
assert(computeMedian([10, 20, 30, 40]) === 25, "median of an even-length array is the average of the two middle values");
assert(computeMedian([]) === 0, "median of an empty array is 0, not NaN");

// ---- 2. A payout in line with the member's own history is not flagged ----
const r2 = detectPayoutAnomalies([{ member_code: "M1", net_amount: 550 }], { M1: [500, 480, 520] });
assert(r2.length === 0, "a payout close to this member's own historical average is not flagged");

// ---- 3. A payout far above the member's own history IS flagged ----
const r3 = detectPayoutAnomalies([{ member_code: "M1", net_amount: 2000 }], { M1: [500, 480, 520] });
assert(r3.length === 1 && r3[0].member_code === "M1", "a payout far above (>3x) this member's own historical average is flagged");

// ---- 4. Right at the multiplier boundary is not flagged (strictly greater-than) ----
const r4 = detectPayoutAnomalies([{ member_code: "M1", net_amount: 1500 }], { M1: [500] }); // exactly 3x
assert(r4.length === 0, "a payout at exactly 3x (not beyond) the member's own average is not flagged");

// ---- 5. A first-time member (no history) is compared against the run's median instead ----
const batch5 = [
  { member_code: "M1", net_amount: 500 },
  { member_code: "M2", net_amount: 520 },
  { member_code: "M3", net_amount: 480 },
  { member_code: "NEW", net_amount: 5000 }, // no history, way above median
];
const r5 = detectPayoutAnomalies(batch5, {});
assert(r5.length === 1 && r5[0].member_code === "NEW", "a first-time member's payout is compared against the run's median, not flagged just for having no history");

// ---- 6. A first-time member with a normal-sized payout is NOT flagged ----
const batch6 = [
  { member_code: "M1", net_amount: 500 },
  { member_code: "NEW", net_amount: 550 },
];
const r6 = detectPayoutAnomalies(batch6, {});
assert(r6.length === 0, "a first-time member's normal-sized payout is not flagged");

// ---- 7. Members with zero/no payout this run are never flagged ----
const r7 = detectPayoutAnomalies([{ member_code: "M1", net_amount: 0 }], { M1: [1] });
assert(r7.length === 0, "a member with zero net_amount this run (no matched pairs) is never flagged");

// ---- 8. Multiple anomalies in one run are all reported ----
const batch8 = [
  { member_code: "A", net_amount: 5000 },
  { member_code: "B", net_amount: 6000 },
];
const r8 = detectPayoutAnomalies(batch8, { A: [500], B: [600] });
assert(r8.length === 2, "multiple flagged members in the same run are all reported, not just the first");

console.log(process.exitCode ? "\nSome tests FAILED." : "\nAll test_phase26 checks passed.");
