// Standalone functional test for the Phase 14 replenishment-reminder logic
// (extractOrderProductSegments / computeReplenishmentDue in server.js).
// Express isn't installed in this sandbox, so server.js itself can't be
// required directly here - same reasoning as test_phase3/6/7/8/9.js. The
// two functions below are copied verbatim from server.js; keep them in
// sync if that logic ever changes.
// Run with: node test_phase14.js

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("PASS:", msg);
  }
};

const DEFAULT_REORDER_CYCLE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

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

      const cycleDays = Number(item.reorderCycleDays) > 0 ? Number(item.reorderCycleDays) : DEFAULT_REORDER_CYCLE_DAYS;
      const dueMs = deliveredMs + cycleDays * DAY_MS;
      if (now < dueMs) return;

      const alreadyReordered = orders.some((o2) => {
        if (o2.id === order.id || o2.mobile !== order.mobile) return false;
        const createdMs = new Date(o2.createdAt).getTime();
        if (isNaN(createdMs) || createdMs <= deliveredMs) return false;
        return extractOrderProductSegments(o2.product).some((s2) => s2.nameOnly.includes(item.name.toLowerCase()));
      });
      if (alreadyReordered) return;

      due.push({
        orderId: order.id,
        sku: item.sku,
        product: item.name,
        mobile: order.mobile,
        name: order.name || "",
        deliveredAt,
        daysSinceDelivered: Math.floor((now - deliveredMs) / DAY_MS),
        reorderCycleDays: cycleDays,
        daysOverdue: Math.floor((now - dueMs) / DAY_MS),
      });
    });
  });

  due.sort((a, b) => b.daysOverdue - a.daysOverdue);
  return due;
}

// ---------- fixtures ----------
const NOW = new Date("2026-08-25T12:00:00Z").getTime();
const daysAgo = (n) => new Date(NOW - n * DAY_MS).toISOString();

const inventory = [
  { sku: "SKU-ASH", name: "Ashwagandha Churna 440g", reorderCycleDays: null }, // uses default (30d)
  { sku: "SKU-TRI", name: "Triphala Tablets", reorderCycleDays: 15 }, // shorter custom cycle
];

// ---- 1. Order delivered 40 days ago, default 30d cycle, no reorder since -> due ----
const orders1 = [
  { id: "o1", mobile: "9000000001", name: "Asha", product: "Ashwagandha Churna 440g x1", status: "delivered", createdAt: daysAgo(41), deliveredAt: daysAgo(40) },
];
let due = computeReplenishmentDue(orders1, inventory, [], NOW);
assert(due.length === 1 && due[0].orderId === "o1", "overdue order (40d since delivery, 30d cycle) surfaces");
assert(due[0].daysOverdue === 10, "daysOverdue computed correctly (40 - 30 = 10)");

// ---- 2. Order delivered only 10 days ago -> not due yet ----
const orders2 = [
  { id: "o2", mobile: "9000000002", name: "Ravi", product: "Ashwagandha Churna 440g x1", status: "delivered", createdAt: daysAgo(11), deliveredAt: daysAgo(10) },
];
due = computeReplenishmentDue(orders2, inventory, [], NOW);
assert(due.length === 0, "order delivered only 10 days ago is excluded (not due yet)");

// ---- 3. Custom shorter cycle (Triphala, 15d) triggers earlier than the default would ----
const orders3 = [
  { id: "o3", mobile: "9000000003", name: "Meena", product: "Triphala Tablets x2", status: "delivered", createdAt: daysAgo(21), deliveredAt: daysAgo(20) },
];
due = computeReplenishmentDue(orders3, inventory, [], NOW);
assert(due.length === 1 && due[0].sku === "SKU-TRI", "custom 15-day reorder cycle respected (20d since delivery > 15d cycle)");

// ---- 4. Customer already reordered the same product after the due window started -> excluded ----
const orders4 = [
  { id: "o4a", mobile: "9000000004", name: "Deepak", product: "Ashwagandha Churna 440g x1", status: "delivered", createdAt: daysAgo(41), deliveredAt: daysAgo(40) },
  { id: "o4b", mobile: "9000000004", name: "Deepak", product: "Ashwagandha Churna 440g x1", status: "new", createdAt: daysAgo(5) },
];
due = computeReplenishmentDue(orders4, inventory, [], NOW);
assert(due.length === 0, "customer who already placed a newer order for the same product is excluded");

// ---- 5. Dismissed reminder stays dismissed ----
const orders5 = [
  { id: "o5", mobile: "9000000005", name: "Priya", product: "Ashwagandha Churna 440g x1", status: "delivered", createdAt: daysAgo(41), deliveredAt: daysAgo(40) },
];
due = computeReplenishmentDue(orders5, inventory, [{ orderId: "o5", sku: "SKU-ASH", dismissedAt: daysAgo(1) }], NOW);
assert(due.length === 0, "dismissed order/sku pair is excluded from due list");

// ---- 6. Order not delivered (still pending/booked) -> excluded regardless of age ----
const orders6 = [
  { id: "o6", mobile: "9000000006", name: "Kiran", product: "Ashwagandha Churna 440g x1", status: "booked", createdAt: daysAgo(60) },
];
due = computeReplenishmentDue(orders6, inventory, [], NOW);
assert(due.length === 0, "order that was never delivered is excluded even if old");

// ---- 7. Order missing a mobile number -> excluded (nothing to send a reminder to) ----
const orders7 = [
  { id: "o7", mobile: "", name: "NoPhone", product: "Ashwagandha Churna 440g x1", status: "delivered", createdAt: daysAgo(41), deliveredAt: daysAgo(40) },
];
due = computeReplenishmentDue(orders7, inventory, [], NOW);
assert(due.length === 0, "order with no mobile number is excluded");

// ---- 8. Legacy order with no deliveredAt falls back to createdAt ----
const orders8 = [
  { id: "o8", mobile: "9000000008", name: "Legacy", product: "Ashwagandha Churna 440g x1", status: "delivered", createdAt: daysAgo(40) }, // no deliveredAt field at all
];
due = computeReplenishmentDue(orders8, inventory, [], NOW);
assert(due.length === 1 && due[0].deliveredAt === orders8[0].createdAt, "legacy order with no deliveredAt falls back to createdAt");

// ---- 9. Product with no matching inventory item -> excluded, doesn't throw ----
const orders9 = [
  { id: "o9", mobile: "9000000009", name: "Unknown", product: "Some Untracked Product x1", status: "delivered", createdAt: daysAgo(41), deliveredAt: daysAgo(40) },
];
due = computeReplenishmentDue(orders9, inventory, [], NOW);
assert(due.length === 0, "order for a product with no matching inventory item is safely excluded");

// ---- 10. Multiple products on one order each match their own inventory item ----
const orders10 = [
  { id: "o10", mobile: "9000000010", name: "Combo", product: "Ashwagandha Churna 440g x1, Triphala Tablets x1", status: "delivered", createdAt: daysAgo(41), deliveredAt: daysAgo(40) },
];
due = computeReplenishmentDue(orders10, inventory, [], NOW);
assert(due.length === 2, "multi-product order surfaces one due reminder per matched inventory item");
assert(due.some((d) => d.sku === "SKU-ASH") && due.some((d) => d.sku === "SKU-TRI"), "both products from the combo order are represented");

console.log(process.exitCode ? "\nSome tests FAILED." : "\nAll test_phase14 checks passed.");
