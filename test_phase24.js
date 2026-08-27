// Standalone functional test for the Phase 24 AI demand forecasting logic
// (computeDemandForecast in server.js). Express isn't installed in this
// sandbox (same reasoning as test_phase3/6/7/8/9/14/15/16/17/19/20/21/22/23.js),
// so this reimplements the pure function verbatim and exercises it directly.
// Run with: node test_phase24.js

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

const DEMAND_FORECAST_LOOKBACK_DAYS = 90;
const DEMAND_FORECAST_LEAD_TIME_DAYS = 14;

function computeDemandForecast(orders, items, now) {
  now = now || Date.now();
  const windowStartMs = now - DEMAND_FORECAST_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  return items
    .map((item) => {
      const nameLower = (item.name || "").toLowerCase();
      let unitsSold = 0;
      if (nameLower) {
        orders.forEach((order) => {
          if (order.status === "cancelled") return;
          const createdMs = new Date(order.createdAt).getTime();
          if (isNaN(createdMs) || createdMs < windowStartMs || createdMs > now) return;
          extractOrderProductSegments(order.product).forEach((seg) => {
            if (seg.nameOnly.includes(nameLower)) unitsSold += seg.qty;
          });
        });
      }
      const dailyRate = unitsSold / DEMAND_FORECAST_LOOKBACK_DAYS;
      const stock = Number(item.stock) || 0;
      const daysOfStockLeft = dailyRate > 0 ? Math.floor(stock / dailyRate) : null;
      return {
        sku: item.sku, name: item.name, stock, unitsSoldLast90Days: unitsSold,
        dailyRate: Math.round(dailyRate * 100) / 100, daysOfStockLeft,
        willStockOutSoon: daysOfStockLeft !== null && daysOfStockLeft <= DEMAND_FORECAST_LEAD_TIME_DAYS,
      };
    })
    .filter((f) => f.daysOfStockLeft !== null)
    .sort((a, b) => a.daysOfStockLeft - b.daysOfStockLeft);
}

const NOW = new Date("2026-08-27T00:00:00Z").getTime();
const RECENT = (daysAgo) => new Date(NOW - daysAgo * 24 * 60 * 60 * 1000).toISOString();

// ---- 1. An item with no matching sales in the lookback window is excluded (no meaningful rate to project) ----
const itemsA = [{ sku: "A", name: "Product A", stock: 100 }];
const ordersA = [{ status: "delivered", product: "Product B x1", createdAt: RECENT(10) }];
assert(computeDemandForecast(ordersA, itemsA, NOW).length === 0, "an item with zero recent matching sales is excluded rather than reporting an infinite/meaningless runway");

// ---- 2. Basic rate + days-left math ----
const itemsB = [{ sku: "B", name: "Product B", stock: 90 }];
// 9 units sold over 90 days -> 0.1/day -> 90 stock / 0.1 = 900 days left
const ordersB = [
  { status: "delivered", product: "Product B x3", createdAt: RECENT(80) },
  { status: "delivered", product: "Product B x6", createdAt: RECENT(20) },
];
const resultB = computeDemandForecast(ordersB, itemsB, NOW);
assert(resultB.length === 1 && resultB[0].unitsSoldLast90Days === 9 && resultB[0].dailyRate === 0.1 && resultB[0].daysOfStockLeft === 900, "units sold, daily rate, and days-of-stock-left are computed correctly from real order history");

// ---- 3. willStockOutSoon flags an item within the lead-time window ----
const itemsC = [{ sku: "C", name: "Product C", stock: 10 }];
// 30 units sold over 90 days -> 1/3 per day -> 10 / (1/3) = 30 days left... too slow to flag; use faster rate
const ordersC = [{ status: "delivered", product: "Product C x60", createdAt: RECENT(30) }]; // 60/90 = 0.667/day -> 10/0.667 = 15d, still not <=14
const ordersC2 = [{ status: "delivered", product: "Product C x90", createdAt: RECENT(30) }]; // 1/day -> 10 days left
const resultC = computeDemandForecast(ordersC2, itemsC, NOW);
assert(resultC[0].daysOfStockLeft === 10 && resultC[0].willStockOutSoon === true, "an item projected to run out within the 14-day lead time is flagged willStockOutSoon");

// ---- 4. An item with plenty of runway is NOT flagged ----
const itemsD = [{ sku: "D", name: "Product D", stock: 1000 }];
const ordersD = [{ status: "delivered", product: "Product D x9", createdAt: RECENT(30) }]; // 0.1/day -> 10000 days left
const resultD = computeDemandForecast(ordersD, itemsD, NOW);
assert(resultD[0].willStockOutSoon === false, "an item with ample runway is not flagged as stocking out soon");

// ---- 5. Cancelled orders are excluded from the sales-velocity calculation ----
const itemsE = [{ sku: "E", name: "Product E", stock: 50 }];
const ordersE = [
  { status: "delivered", product: "Product E x9", createdAt: RECENT(10) },
  { status: "cancelled", product: "Product E x90", createdAt: RECENT(10) }, // should not count
];
const resultE = computeDemandForecast(ordersE, itemsE, NOW);
assert(resultE[0].unitsSoldLast90Days === 9, "cancelled orders don't inflate the sales-velocity calculation");

// ---- 6. Orders outside the 90-day lookback window are excluded ----
const itemsF = [{ sku: "F", name: "Product F", stock: 50 }];
const ordersF = [{ status: "delivered", product: "Product F x100", createdAt: RECENT(200) }]; // way outside window
assert(computeDemandForecast(ordersF, itemsF, NOW).length === 0, "sales older than the 90-day lookback window don't count toward the current velocity");

// ---- 7. Results are sorted soonest-to-stock-out first ----
const itemsG = [
  { sku: "G1", name: "Slow Mover", stock: 1000 },
  { sku: "G2", name: "Fast Mover", stock: 10 },
];
const ordersG = [
  { status: "delivered", product: "Slow Mover x9", createdAt: RECENT(10) }, // 0.1/day -> 10000 days left
  { status: "delivered", product: "Fast Mover x90", createdAt: RECENT(10) }, // 1/day -> 10 days left
];
const resultG = computeDemandForecast(ordersG, itemsG, NOW);
assert(resultG[0].sku === "G2" && resultG[1].sku === "G1", "results are sorted soonest-to-stock-out first, so the most urgent item is always on top");

console.log(process.exitCode ? "\nSome tests FAILED." : "\nAll test_phase24 checks passed.");
