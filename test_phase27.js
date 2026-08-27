// Standalone functional test for the Phase 27 referral-propensity scoring
// logic (computeReferralPropensity in server.js). Express isn't installed
// in this sandbox (same reasoning as test_phase3/6/7/8/9/14/.../26.js), so
// this reimplements the pure function verbatim and exercises it directly.
// Run with: node test_phase27.js

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("PASS:", msg);
  }
};

// Copied verbatim from server.js - keep in sync if that logic ever changes.
const REFERRAL_PROPENSITY_RECENT_DAYS = 30;

function computeReferralPropensity(mobile, orders, now) {
  now = now || Date.now();
  const customerOrders = orders.filter((o) => o.mobile === mobile);
  const deliveredOrders = customerOrders.filter((o) => o.status === "delivered");
  if (!deliveredOrders.length) return null;

  let score = 20;
  const reasons = ["baseline: has at least one delivered order (+20)"];

  const referredOthers = orders.filter((o) => o.referredByMobile === mobile).length;
  if (referredOthers > 0) {
    score += 30;
    reasons.push(`already referred ${referredOthers} other order${referredOthers > 1 ? "s" : ""} (+30)`);
  }

  const loyaltyPoints = Math.min(30, (deliveredOrders.length - 1) * 10);
  if (loyaltyPoints > 0) {
    score += loyaltyPoints;
    reasons.push(`${deliveredOrders.length} delivered orders total (+${loyaltyPoints})`);
  }

  const mostRecentDeliveredMs = Math.max(...deliveredOrders.map((o) => new Date(o.deliveredAt || o.createdAt).getTime()).filter((ms) => !isNaN(ms)));
  if (isFinite(mostRecentDeliveredMs)) {
    const daysSince = Math.floor((now - mostRecentDeliveredMs) / (24 * 60 * 60 * 1000));
    if (daysSince >= 0 && daysSince <= REFERRAL_PROPENSITY_RECENT_DAYS) {
      score += 15;
      reasons.push(`most recent delivery was ${daysSince} day${daysSince === 1 ? "" : "s"} ago (+15)`);
    }
  }

  return { mobile, score: Math.min(100, score), reasons, deliveredOrderCount: deliveredOrders.length, alreadyReferredCount: referredOthers };
}

const NOW = new Date("2026-08-27T00:00:00Z").getTime();
const DAYS_AGO = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

// ---- 1. A customer with no delivered orders is not scored at all ----
const r1 = computeReferralPropensity("9000000001", [{ mobile: "9000000001", status: "booked", createdAt: DAYS_AGO(5) }], NOW);
assert(r1 === null, "a customer with no delivered orders returns null - nothing to score yet");

// ---- 2. A single old delivered order gets just the baseline score ----
const r2 = computeReferralPropensity("9000000002", [{ mobile: "9000000002", status: "delivered", deliveredAt: DAYS_AGO(200) }], NOW);
assert(r2.score === 20, "a single delivered order outside the recency window scores just the 20-point baseline");

// ---- 3. Recent delivery adds the recency bonus ----
const r3 = computeReferralPropensity("9000000003", [{ mobile: "9000000003", status: "delivered", deliveredAt: DAYS_AGO(5) }], NOW);
assert(r3.score === 35, "a recently delivered order (within 30 days) adds the +15 recency bonus on top of the +20 baseline");

// ---- 4. Repeat deliveries add loyalty points, capped at +30 ----
const manyOrders = [1, 2, 3, 4, 5].map((n) => ({ mobile: "9000000004", status: "delivered", deliveredAt: DAYS_AGO(100 + n) }));
const r4 = computeReferralPropensity("9000000004", manyOrders, NOW);
assert(r4.score === 50, "5 delivered orders (4 repeats x 10pts, capped at 30) plus the 20 baseline scores 50, with recency not applying (all old)");

// ---- 5. Having referred someone else is the strongest single signal ----
const referrerOrders = [
  { mobile: "9000000005", status: "delivered", deliveredAt: DAYS_AGO(200) },
  { mobile: "9111111111", status: "delivered", deliveredAt: DAYS_AGO(50), referredByMobile: "9000000005" },
];
const r5 = computeReferralPropensity("9000000005", referrerOrders, NOW);
assert(r5.score === 50 && r5.alreadyReferredCount === 1, "a customer who has already referred someone else gets the +30 proven-referrer bonus on top of baseline");

// ---- 6. All signals combine, capped at 100 ----
const maxedOrders = [
  { mobile: "9000000006", status: "delivered", deliveredAt: DAYS_AGO(500) },
  { mobile: "9000000006", status: "delivered", deliveredAt: DAYS_AGO(300) },
  { mobile: "9000000006", status: "delivered", deliveredAt: DAYS_AGO(100) },
  { mobile: "9000000006", status: "delivered", deliveredAt: DAYS_AGO(5) }, // recent
  { mobile: "9222222222", status: "delivered", deliveredAt: DAYS_AGO(10), referredByMobile: "9000000006" },
];
const r6 = computeReferralPropensity("9000000006", maxedOrders, NOW);
// 20 baseline + 30 referred-others + 30 loyalty (capped, 3 repeats->30) + 15 recency = 95
assert(r6.score === 95 && r6.score <= 100, "all signals combine additively and the total never exceeds the 100 cap");

// ---- 7. Only this customer's own order history is used ----
const crossOrders = [
  { mobile: "9000000007", status: "delivered", deliveredAt: DAYS_AGO(200) },
  { mobile: "9000000099", status: "delivered", deliveredAt: DAYS_AGO(2) }, // another customer, recent
];
const r7 = computeReferralPropensity("9000000007", crossOrders, NOW);
assert(r7.score === 20, "another customer's recent delivery doesn't leak into this customer's score");

// ---- 8. reasons array explains every point awarded (explainability, not a black box) ----
assert(r6.reasons.length === 4, "every scoring signal that fired has a corresponding human-readable reason");

console.log(process.exitCode ? "\nSome tests FAILED." : "\nAll test_phase27 checks passed.");
