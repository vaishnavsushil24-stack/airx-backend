// Standalone functional test for the Phase 21 per-customer replenishment
// timing logic (computePersonalizedCycleDays, and computeReplenishmentDue's
// use of it, in server.js). Express isn't installed in this sandbox (same
// reasoning as test_phase3/6/7/8/9/14/15/16/17/19/20.js), so this
// reimplements the pure functions verbatim and exercises them directly.
// Run with: node test_phase21.js

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("PASS:", msg);
  }
};

// Copied verbatim from server.js - keep in sync if that logic ever changes.
function extractOrderProductSegments(productText) {
  return (productText || "")
    .split(",")
    .map((segment) => {
      const trimmed = segment.trim();
      const qtyMatch = trimmed.match(/x\s*(\d+)\s*$/i);
      const qty = qtyMatch ? Number(qtyMatch[1]) : 1;
      const nameOnly = trimmed.replace(/x\s*\d+\s*$/i, "").trim().toLowerCase();
      return { nameOnly, qty };
    })
    .filter((s) => s.nameOnly);
}

function computePersonalizedCycleDays(mobile, itemName, orders) {
  const nameLower = itemName.toLowerCase();
  const deliveries = orders
    .filter((o) => o.mobile === mobile && o.status === "delivered")
    .filter((o) => extractOrderProductSegments(o.product).some((s) => s.nameOnly.includes(nameLower)))
    .map((o) => new Date(o.deliveredAt || o.createdAt).getTime())
    .filter((ms) => !isNaN(ms))
    .sort((a, b) => a - b);
  if (deliveries.length < 2) return null;
  const intervalsDays = [];
  for (let i = 1; i < deliveries.length; i++) {
    intervalsDays.push((deliveries[i] - deliveries[i - 1]) / (24 * 60 * 60 * 1000));
  }
  const avg = intervalsDays.reduce((s, d) => s + d, 0) / intervalsDays.length;
  return Math.round(Math.min(180, Math.max(7, avg)));
}

const DEFAULT_REORDER_CYCLE_DAYS = 30;

function computeReplenishmentDue(orders, items, dismissed, now) {
  now = now || Date.now();
  const isDismissed = (orderId, sku) => dismissed.some((d) => d.orderId === orderId && d.sku === sku);
  const due = [];
  orders.forEach((order) => {
    if (order.status !== "delivered" || !order.mobile) return;
    const deliveredAt = order.deliveredAt || order.createdAt;
    if (!deliveredAt) return;
    const deliveredMs = new Date(deliveredAt).getTime();
    if (isNaN(deliveredMs)) return;
    extractOrderProductSegments(order.product).forEach(({ nameOnly }) => {
      const item = items.find((i) => i.name && nameOnly.includes(i.name.toLowerCase()));
      if (!item) return;
      if (isDismissed(order.id, item.sku)) return;
      const personalizedCycleDays = computePersonalizedCycleDays(order.mobile, item.name, orders);
      const cycleDays = personalizedCycleDays || (Number(item.reorderCycleDays) > 0 ? Number(item.reorderCycleDays) : DEFAULT_REORDER_CYCLE_DAYS);
      const cycleSource = personalizedCycleDays ? "personalized" : (Number(item.reorderCycleDays) > 0 ? "item-configured" : "default");
      const dueMs = deliveredMs + cycleDays * 24 * 60 * 60 * 1000;
      if (now < dueMs) return;
      const alreadyReordered = orders.some((o2) => {
        if (o2.id === order.id || o2.mobile !== order.mobile) return false;
        const createdMs = new Date(o2.createdAt).getTime();
        if (isNaN(createdMs) || createdMs <= deliveredMs) return false;
        return extractOrderProductSegments(o2.product).some((s2) => s2.nameOnly.includes(item.name.toLowerCase()));
      });
      if (alreadyReordered) return;
      due.push({
        orderId: order.id, sku: item.sku, product: item.name, mobile: order.mobile, name: order.name || "",
        deliveredAt, daysSinceDelivered: Math.floor((now - deliveredMs) / (24 * 60 * 60 * 1000)),
        reorderCycleDays: cycleDays, cycleSource, daysOverdue: Math.floor((now - dueMs) / (24 * 60 * 60 * 1000)),
      });
    });
  });
  due.sort((a, b) => b.daysOverdue - a.daysOverdue);
  return due;
}

const ITEM = { sku: "SKU1", name: "Product A", reorderCycleDays: 30 };
const NOW = new Date("2026-08-27T00:00:00Z").getTime();

// ---- 1. Fewer than 2 deliveries -> no personalization, returns null ----
assert(computePersonalizedCycleDays("9000000001", "Product A", [
  { mobile: "9000000001", status: "delivered", product: "Product A x1", deliveredAt: "2026-07-01T00:00:00Z" },
]) === null, "a single delivery gives no personalized cycle yet (falls back to item/default)");

// ---- 2. Exactly 2 deliveries -> personalized cycle = the observed gap ----
const twoOrders = [
  { mobile: "9000000002", status: "delivered", product: "Product A x1", deliveredAt: "2026-06-01T00:00:00Z" },
  { mobile: "9000000002", status: "delivered", product: "Product A x1", deliveredAt: "2026-06-21T00:00:00Z" }, // 20 days later
];
assert(computePersonalizedCycleDays("9000000002", "Product A", twoOrders) === 20, "2 deliveries 20 days apart personalize to a 20-day cycle");

// ---- 3. 3+ deliveries -> personalized cycle = the average of observed gaps ----
const threeOrders = [
  { mobile: "9000000003", status: "delivered", product: "Product A x1", deliveredAt: "2026-01-01T00:00:00Z" },
  { mobile: "9000000003", status: "delivered", product: "Product A x1", deliveredAt: "2026-01-21T00:00:00Z" }, // +20
  { mobile: "9000000003", status: "delivered", product: "Product A x1", deliveredAt: "2026-02-20T00:00:00Z" }, // +30
];
assert(computePersonalizedCycleDays("9000000003", "Product A", threeOrders) === 25, "3 deliveries with 20d and 30d gaps average to a 25-day personalized cycle");

// ---- 4. Clamped to a minimum of 7 days (protects against a data-entry glitch) ----
const rapidOrders = [
  { mobile: "9000000004", status: "delivered", product: "Product A x1", deliveredAt: "2026-06-01T00:00:00Z" },
  { mobile: "9000000004", status: "delivered", product: "Product A x1", deliveredAt: "2026-06-02T00:00:00Z" }, // 1 day later
];
assert(computePersonalizedCycleDays("9000000004", "Product A", rapidOrders) === 7, "an implausibly short 1-day gap is clamped up to a 7-day minimum");

// ---- 5. Clamped to a maximum of 180 days (protects against a stale one-off pair) ----
const slowOrders = [
  { mobile: "9000000005", status: "delivered", product: "Product A x1", deliveredAt: "2024-01-01T00:00:00Z" },
  { mobile: "9000000005", status: "delivered", product: "Product A x1", deliveredAt: "2025-06-01T00:00:00Z" }, // ~1.5 years later
];
assert(computePersonalizedCycleDays("9000000005", "Product A", slowOrders) === 180, "an implausibly long multi-year gap is clamped down to a 180-day maximum");

// ---- 6. Only that customer's own history is used, not another customer's orders for the same product ----
const crossCustomer = [
  { mobile: "9000000006", status: "delivered", product: "Product A x1", deliveredAt: "2026-08-01T00:00:00Z" }, // only 1 delivery for this customer
  { mobile: "9000000099", status: "delivered", product: "Product A x1", deliveredAt: "2026-01-01T00:00:00Z" },
  { mobile: "9000000099", status: "delivered", product: "Product A x1", deliveredAt: "2026-01-11T00:00:00Z" },
];
assert(computePersonalizedCycleDays("9000000006", "Product A", crossCustomer) === null, "another customer's order history never leaks into this customer's personalized cycle");

// ---- 7. computeReplenishmentDue: a customer with 2+ prior deliveries gets cycleSource "personalized" ----
const repeatCustomerOrders = [
  { id: "r1", mobile: "9000000007", status: "delivered", product: "Product A x1", deliveredAt: "2026-06-01T00:00:00Z", createdAt: "2026-06-01T00:00:00Z" },
  { id: "r2", mobile: "9000000007", status: "delivered", product: "Product A x1", deliveredAt: "2026-06-16T00:00:00Z", createdAt: "2026-06-16T00:00:00Z" }, // 15-day gap -> personalized cycle 15
];
const dueRepeat = computeReplenishmentDue(repeatCustomerOrders, [ITEM], [], NOW);
assert(dueRepeat.length === 1 && dueRepeat[0].cycleSource === "personalized" && dueRepeat[0].reorderCycleDays === 15, "a customer with observed reorder history gets a personalized 15-day cycle instead of the 30-day item default");

// ---- 8. computeReplenishmentDue: a first-time customer still falls back to item-configured/default cycle ----
const firstTimeOrders = [
  { id: "f1", mobile: "9000000008", status: "delivered", product: "Product A x1", deliveredAt: "2026-06-01T00:00:00Z", createdAt: "2026-06-01T00:00:00Z" },
];
const dueFirstTime = computeReplenishmentDue(firstTimeOrders, [ITEM], [], NOW);
assert(dueFirstTime.length === 1 && dueFirstTime[0].cycleSource === "item-configured" && dueFirstTime[0].reorderCycleDays === 30, "a first-time customer (no reorder history) still uses the item-configured 30-day cycle, unchanged from Phase 14 behavior");

console.log(process.exitCode ? "\nSome tests FAILED." : "\nAll test_phase21 checks passed.");
