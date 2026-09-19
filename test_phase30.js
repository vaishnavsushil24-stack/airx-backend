// Standalone functional test for Phase 30 — the native storefront that
// replaces Shopify (product catalog fields: description/image_url/slug/
// show_in_store, slug uniqueness, and the public order pricing/validation
// logic used by POST /api/public/order). Express isn't installed in this
// sandbox (same reasoning as test_phase3/6/7/8/9.js, which also require
// db.js directly), so this exercises the real db.js schema/migration and
// reimplements the pure request-validation logic from server.js verbatim.
// Run with: node test_phase30.js   (then delete data/airx.db to reset)

const fs = require("fs");
const path = require("path");
const DATA_DIR = path.join(__dirname, "data");
if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });

const { db, slugify } = require("./db.js");

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("PASS:", msg);
  }
};

// ---- 1. Migration actually added the new columns, with the right defaults ----
const cols = db.prepare("PRAGMA table_info(products)").all();
const colNames = cols.map((c) => c.name);
assert(
  ["description", "image_url", "slug", "show_in_store"].every((c) => colNames.includes(c)),
  "products table has description/image_url/slug/show_in_store after migration"
);
const showInStoreCol = cols.find((c) => c.name === "show_in_store");
assert(showInStoreCol.dflt_value === "1", "show_in_store defaults to 1 (visible) so existing products don't silently disappear from the storefront");

// ---- 2. slugify produces clean, URL-safe segments ----
assert(slugify("Ashwagandha Churna 200g") === "ashwagandha-churna-200g", "slugify lowercases, replaces spaces with hyphens, keeps alphanumerics");
assert(slugify("  Triphala!! Powder  ") === "triphala-powder", "slugify strips punctuation and trims leading/trailing hyphens");
assert(slugify("") === "", "slugify of empty input is empty (caller falls back to a default), not a crash");

// ---- 3. Same logic as uniqueSlug() in server.js, exercised against the real DB ----
function uniqueSlug(desired, excludeSku) {
  let base = slugify(desired) || "product";
  const taken = new Set(
    db
      .prepare(`SELECT slug FROM products WHERE slug IS NOT NULL AND slug != '' ${excludeSku ? "AND sku != ?" : ""}`)
      .all(...(excludeSku ? [excludeSku] : []))
      .map((r) => r.slug)
  );
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${n}`;
    n++;
  }
  return candidate;
}

db.prepare(
  `INSERT INTO products (sku, name, category, dp_price, mrp_price, pv, bv, status, description, image_url, slug, show_in_store)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
).run("SKU-A", "Ashwagandha Churna", "General", 300, 450, 10, 10, "Active", "Stress relief herbal powder", "/uploads/products/a.jpg", uniqueSlug("Ashwagandha Churna"), 1);

assert(
  db.prepare("SELECT slug FROM products WHERE sku = ?").get("SKU-A").slug === "ashwagandha-churna",
  "first product with a given name gets the plain slug"
);

const secondSlug = uniqueSlug("Ashwagandha Churna"); // a second, differently-SKU'd product with the same name
assert(secondSlug === "ashwagandha-churna-2", "a second product with the same name gets a disambiguated slug instead of colliding");

// Editing SKU-A's own name shouldn't collide with itself.
const selfSlug = uniqueSlug("Ashwagandha Churna", "SKU-A");
assert(selfSlug === "ashwagandha-churna", "re-slugifying a product against its own existing slug doesn't append -2 to itself");

db.prepare(
  `INSERT INTO products (sku, name, category, dp_price, mrp_price, pv, bv, status, slug, show_in_store)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
).run("SKU-B", "Triphala Powder", "General", 200, 320, 8, 8, "Active", uniqueSlug("Triphala Powder"), 1);

db.prepare(
  `INSERT INTO products (sku, name, category, dp_price, mrp_price, pv, bv, status, slug, show_in_store)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
).run("SKU-C", "Distributor Only Kit", "General", 500, 800, 20, 20, "Active", uniqueSlug("Distributor Only Kit"), 0); // hidden from storefront

db.prepare(
  `INSERT INTO products (sku, name, category, dp_price, mrp_price, pv, bv, status, slug, show_in_store)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
).run("SKU-D", "Discontinued Oil", "General", 150, 250, 5, 5, "Inactive", uniqueSlug("Discontinued Oil"), 1); // inactive - shouldn't show either

// ---- 4. Public catalog query (mirrors GET /api/public/products) only returns Active + show_in_store products ----
const publicRows = db
  .prepare("SELECT sku, name, category, description, image_url, slug, mrp_price FROM products WHERE status = 'Active' AND show_in_store = 1 ORDER BY name")
  .all();
const publicSkus = publicRows.map((r) => r.sku).sort();
assert(publicSkus.length === 2 && publicSkus.includes("SKU-A") && publicSkus.includes("SKU-B"), "public catalog includes only Active + show_in_store products (SKU-A, SKU-B)");
assert(!publicSkus.includes("SKU-C"), "a distributor-only product (show_in_store=0) is excluded from the public catalog even though it's Active");
assert(!publicSkus.includes("SKU-D"), "an Inactive product is excluded from the public catalog even though show_in_store=1");
assert(!("dp_price" in publicRows[0]) && !("pv" in publicRows[0]) && !("bv" in publicRows[0]), "public catalog rows never leak internal MLM economics (dp_price/pv/bv)");

// =====================================================================
// Order validation/pricing — copied verbatim from the POST /api/public/order
// handler in server.js (minus the Express req/res plumbing), so the same
// server-side-priced, tamper-resistant cart logic is tested directly
// against the real DB rows seeded above.
// =====================================================================
function buildOrderFromCart(items) {
  if (!Array.isArray(items) || !items.length) return { error: "Cart is empty." };
  if (items.length > 20) return { error: "Too many different items in one order." };
  let codAmount = 0;
  const productParts = [];
  const orderItems = [];
  for (const raw of items) {
    const sku = String((raw && raw.sku) || "").trim();
    const qty = Math.max(1, Math.min(20, Number(raw && raw.qty) || 1));
    const product = db.prepare("SELECT sku, name, mrp_price FROM products WHERE sku = ? AND status = 'Active' AND show_in_store = 1").get(sku);
    if (!product) return { error: `One of the items in your cart is no longer available (${sku || "unknown item"}). Please refresh and try again.` };
    codAmount += product.mrp_price * qty;
    productParts.push(`${product.name} x${qty}`);
    orderItems.push({ sku: product.sku, name: product.name, qty, price: product.mrp_price });
  }
  return { codAmount: Math.round(codAmount * 100) / 100, product: productParts.join(", "), items: orderItems };
}

// ---- 5. A normal cart prices correctly from the DB, not the client ----
const normalOrder = buildOrderFromCart([{ sku: "SKU-A", qty: 2 }, { sku: "SKU-B", qty: 1 }]);
assert(normalOrder.codAmount === 450 * 2 + 320, "cart total is computed server-side from live DB prices (900 + 320 = 1220)");
assert(normalOrder.product === "Ashwagandha Churna x2, Triphala Powder x1", "product summary string matches the same 'Name xQty, Name xQty' shape used by WhatsApp/Shopify orders elsewhere in the app");

// ---- 6. A tampered/fake price in the request body is ignored entirely - only sku+qty are read ----
const tamperedOrder = buildOrderFromCart([{ sku: "SKU-A", qty: 1, price: 1 }]);
assert(tamperedOrder.codAmount === 450, "a client-supplied price field is ignored - the real DB mrp_price (450) is always used, not the tampered value (1)");

// ---- 7. A product hidden from the storefront (or inactive) cannot be ordered even if its SKU is guessed ----
const hiddenOrder = buildOrderFromCart([{ sku: "SKU-C", qty: 1 }]);
assert(hiddenOrder.error && hiddenOrder.error.includes("no longer available"), "a show_in_store=0 product cannot be added to a public order, even by SKU");
const inactiveOrder = buildOrderFromCart([{ sku: "SKU-D", qty: 1 }]);
assert(inactiveOrder.error && inactiveOrder.error.includes("no longer available"), "an Inactive product cannot be ordered through the public storefront");

// ---- 8. An unknown SKU is rejected with a clear error, not a crash or a free item ----
const unknownOrder = buildOrderFromCart([{ sku: "SKU-DOES-NOT-EXIST", qty: 1 }]);
assert(unknownOrder.error && unknownOrder.error.includes("SKU-DOES-NOT-EXIST"), "an unknown SKU is rejected by name so the customer/UI can identify which cart line failed");

// ---- 9. Quantity is clamped to a sane range (1-20) even if the client sends something wild ----
const wildQty = buildOrderFromCart([{ sku: "SKU-A", qty: 999 }]);
assert(wildQty.codAmount === 450 * 20, "a wildly large requested quantity is clamped to the 20-unit cap, not honored as-is");
const zeroQty = buildOrderFromCart([{ sku: "SKU-A", qty: 0 }]);
assert(zeroQty.codAmount === 450, "a zero/invalid quantity falls back to 1, not 0 (never a free line item)");

// ---- 10. An empty cart is rejected up front ----
assert(buildOrderFromCart([]).error === "Cart is empty.", "an empty items array is rejected before touching the DB");
assert(buildOrderFromCart(null).error === "Cart is empty.", "a missing/non-array items value is rejected safely, not a crash");

// ---- 11. Same mobile-cleaning rule as /api/public/track, reused here for consistency ----
function cleanMobile(raw) {
  return String(raw || "").replace(/\D/g, "").slice(-10);
}
assert(cleanMobile("+91 98765-43210") === "9876543210", "mobile numbers with country code/punctuation are cleaned to the last 10 digits, matching /api/public/track's own rule");
assert(cleanMobile("12345").length !== 10, "a too-short mobile number correctly fails the 10-digit check");

console.log(process.exitCode ? "\nSome tests FAILED." : "\nAll test_phase30 checks passed.");
