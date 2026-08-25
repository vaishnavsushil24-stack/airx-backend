// Standalone functional test for the Phase 17 referral-bridge eligibility
// logic (computeReferralEligibility in server.js). Express isn't installed
// in this sandbox (same reasoning as test_phase3/6/7/8/9/14/15/16.js), so
// this reimplements the pure function verbatim and exercises it directly.
// Run with: node test_phase17.js

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("PASS:", msg);
  }
};

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Copied verbatim from server.js - keep in sync if that logic ever changes.
function computeReferralEligibility(order, allOrders, settings) {
  if (!settings || settings.rewardType === "none" || !settings.rewardValue) return { eligible: false, reason: "no reward configured yet" };
  if (!order.referredByMobile) return { eligible: false, reason: "no referrer tagged on this order" };
  const referrer = String(order.referredByMobile).replace(/\D/g, "");
  const referred = String(order.mobile || "").replace(/\D/g, "");
  if (!referred) return { eligible: false, reason: "order has no customer mobile" };
  if (!referrer) return { eligible: false, reason: "referrer mobile is invalid" };
  if (referrer === referred) return { eligible: false, reason: "self-referral not allowed" };
  const amount = Number(order.codAmount || order.cod || 0);
  if (settings.minOrderAmount && amount < settings.minOrderAmount) return { eligible: false, reason: "order below the configured minimum amount" };
  const orderDeliveredMs = new Date(order.deliveredAt || order.createdAt).getTime();
  const isFirstDelivered = !allOrders.some((o) => {
    if (o.id === order.id || String(o.mobile || "").replace(/\D/g, "") !== referred || o.status !== "delivered") return false;
    const otherMs = new Date(o.deliveredAt || o.createdAt).getTime();
    return !isNaN(otherMs) && otherMs < orderDeliveredMs;
  });
  if (!isFirstDelivered) return { eligible: false, reason: "not the referred customer's first delivered order" };
  const rewardValue = settings.rewardType === "percent_discount" ? round2(amount * (Number(settings.rewardValue) / 100)) : Number(settings.rewardValue);
  return { eligible: true, rewardType: settings.rewardType, rewardValue };
}

const NONE = { rewardType: "none", rewardValue: 0 };
const FLAT_100 = { rewardType: "flat_credit", rewardValue: 100 };
const PCT_10 = { rewardType: "percent_discount", rewardValue: 10 };

// ---- 1. Default "no reward configured" keeps everything inert ----
const o1 = { id: "o1", mobile: "9000000001", referredByMobile: "9000000002", status: "delivered", deliveredAt: "2026-08-25T10:00:00Z", codAmount: 500 };
assert(computeReferralEligibility(o1, [o1], NONE).eligible === false, 'rewardType "none" (the default) never makes anything eligible');

// ---- 2. A tagged, first-delivered order becomes eligible with a flat reward ----
const result2 = computeReferralEligibility(o1, [o1], FLAT_100);
assert(result2.eligible === true && result2.rewardValue === 100, "a first-delivered, referred order is eligible for the configured flat credit");

// ---- 3. Percent reward is computed off the order amount ----
const result3 = computeReferralEligibility(o1, [o1], PCT_10);
assert(result3.eligible === true && result3.rewardValue === 50, "10% of a ₹500 order computes to ₹50 reward");

// ---- 4. No referrer tagged -> not eligible ----
const o4 = { id: "o4", mobile: "9000000003", referredByMobile: "", status: "delivered", deliveredAt: "2026-08-25T10:00:00Z", codAmount: 500 };
assert(computeReferralEligibility(o4, [o4], FLAT_100).eligible === false, "an order with no referrer tagged is never eligible");

// ---- 5. Self-referral guard ----
const o5 = { id: "o5", mobile: "9000000004", referredByMobile: "9000000004", status: "delivered", deliveredAt: "2026-08-25T10:00:00Z", codAmount: 500 };
assert(computeReferralEligibility(o5, [o5], FLAT_100).eligible === false, "a customer 'referring' their own number is rejected");

// ---- 6. Minimum order amount respected ----
const o6 = { id: "o6", mobile: "9000000005", referredByMobile: "9000000006", status: "delivered", deliveredAt: "2026-08-25T10:00:00Z", codAmount: 200 };
assert(computeReferralEligibility(o6, [o6], { ...FLAT_100, minOrderAmount: 300 }).eligible === false, "an order below the configured minimum amount is excluded");
assert(computeReferralEligibility(o6, [o6], { ...FLAT_100, minOrderAmount: 100 }).eligible === true, "an order at/above the configured minimum amount is included");

// ---- 7. Only the referred customer's FIRST delivered order counts ----
const earlier = { id: "o7a", mobile: "9000000007", referredByMobile: "9000000008", status: "delivered", deliveredAt: "2026-08-20T10:00:00Z", codAmount: 500 };
const later = { id: "o7b", mobile: "9000000007", referredByMobile: "9000000008", status: "delivered", deliveredAt: "2026-08-25T10:00:00Z", codAmount: 500 };
assert(computeReferralEligibility(earlier, [earlier, later], FLAT_100).eligible === true, "the customer's genuinely first delivered order is eligible");
assert(computeReferralEligibility(later, [earlier, later], FLAT_100).eligible === false, "a repeat order from the same referred customer is not eligible (prevents repeat-order abuse)");

// ---- 8. Non-delivered orders from the same customer don't block first-order eligibility ----
const pending = { id: "o8a", mobile: "9000000009", referredByMobile: "9000000010", status: "booked", createdAt: "2026-08-20T10:00:00Z" };
const delivered = { id: "o8b", mobile: "9000000009", referredByMobile: "9000000010", status: "delivered", deliveredAt: "2026-08-25T10:00:00Z", codAmount: 500 };
assert(computeReferralEligibility(delivered, [pending, delivered], FLAT_100).eligible === true, "an earlier non-delivered order from the same customer doesn't block eligibility on the real first delivery");

console.log(process.exitCode ? "\nSome tests FAILED." : "\nAll test_phase17 checks passed.");
