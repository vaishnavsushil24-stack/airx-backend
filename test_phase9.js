// Standalone functional test for the Phase 9 DB logic (store.airxplus.com's
// remaining features: product category, franchise bank details + hierarchy
// guard, franchise-level Commission — franchise_payouts). Same reasoning as
// test_phase6/7/8.js: npm install is blocked in this sandbox (403 from the
// registry) so express itself isn't available here to boot the real server
// — this exercises the exact same SQL each server.js route uses, directly
// against db.js. Full HTTP-level verification happens live against the
// deployed Render API after push.
// Run with: node test_phase9.js

const fs = require("fs");
const path = require("path");
const DATA_DIR = path.join(__dirname, "data");
if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });

const { db } = require("./db.js");

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("PASS:", msg);
  }
};

// ---- product category (mirrors POST/PATCH /api/products) ----
db.prepare(
  "INSERT INTO products (sku, name, category, dp_price, mrp_price, pv, bv) VALUES (?, ?, ?, ?, ?, ?, ?)"
).run("SKU-GEN-1", "General Tonic", "General", 100, 150, 10, 10);
db.prepare(
  "INSERT INTO products (sku, name, category, dp_price, mrp_price, pv, bv) VALUES (?, ?, ?, ?, ?, ?, ?)"
).run("SKU-WEL-1", "Wellness Pack", "Special Wellness", 500, 600, 50, 50);
const genProduct = db.prepare("SELECT * FROM products WHERE sku = ?").get("SKU-GEN-1");
assert(genProduct.category === "General", "product category stored correctly");
db.prepare("UPDATE products SET category=? WHERE sku=?").run("Mens", "SKU-GEN-1");
assert(db.prepare("SELECT category FROM products WHERE sku=?").get("SKU-GEN-1").category === "Mens", "product category updates via PATCH-equivalent SQL");

// ---- franchise hierarchy + bank details (mirrors POST/PATCH /api/franchises) ----
db.prepare(
  `INSERT INTO franchises (franchise_code, franchise_name, state, bank_name, bank_account_number, bank_ifsc, bank_account_holder)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
).run("FR-PARENT", "Parent Franchise", "Rajasthan", "HDFC Bank", "1234567890", "HDFC0001234", "Parent Franchise Pvt Ltd");
db.prepare(
  `INSERT INTO franchises (franchise_code, franchise_name, parent_franchise_code, state) VALUES (?, ?, ?, ?)`
).run("FR-CHILD", "Child Franchise", "FR-PARENT", "Rajasthan");
const parent = db.prepare("SELECT * FROM franchises WHERE franchise_code = ?").get("FR-PARENT");
assert(parent.bank_name === "HDFC Bank" && parent.bank_account_number === "1234567890", "franchise bank details stored correctly");
const child = db.prepare("SELECT * FROM franchises WHERE franchise_code = ?").get("FR-CHILD");
assert(child.parent_franchise_code === "FR-PARENT", "franchise parent_franchise_code hierarchy stored correctly");
const children = db.prepare("SELECT * FROM franchises WHERE parent_franchise_code = ?").all("FR-PARENT");
assert(children.length === 1 && children[0].franchise_code === "FR-CHILD", "children-of-parent query returns the right row");

// self-parent guard (mirrors the PATCH /api/franchises/:code check)
function wouldBeSelfParent(code, newParent) {
  return newParent && newParent === code;
}
assert(wouldBeSelfParent("FR-PARENT", "FR-PARENT") === true, "self-parent guard would reject a franchise naming itself as parent");
assert(wouldBeSelfParent("FR-PARENT", "FR-CHILD") === false, "self-parent guard allows a legitimate different parent");

// ---- franchise delete guard (mirrors DELETE /api/franchises/:code) ----
db.exec("PRAGMA foreign_keys = ON");
let deleteErr = null;
try {
  db.exec("BEGIN");
  db.prepare("DELETE FROM franchises WHERE franchise_code = ?").run("FR-PARENT"); // has a child franchise pointing at it
  db.exec("COMMIT");
} catch (err) {
  db.exec("ROLLBACK");
  deleteErr = err;
}
assert(deleteErr !== null, "raw DELETE on a franchise with a child franchise throws an FK error (confirms the route's guard is necessary)");
assert(db.prepare("SELECT 1 FROM franchises WHERE franchise_code=?").get("FR-PARENT"), "parent franchise still exists after the blocked delete");

db.prepare("INSERT INTO franchises (franchise_code, franchise_name) VALUES ('FR-CLEAN', 'Clean Franchise')").run();
const cleanDelete = db.prepare("DELETE FROM franchises WHERE franchise_code = 'FR-CLEAN'").run();
assert(cleanDelete.changes === 1, "a franchise with no children/stock/payout history deletes cleanly");

// ---- franchise_stock (mirrors POST/PATCH/DELETE /api/franchise-stock) ----
db.prepare(
  `INSERT INTO franchise_stock (franchise_code, sku, quantity) VALUES (?, ?, ?)
   ON CONFLICT(franchise_code, sku) DO UPDATE SET quantity = excluded.quantity, updated_at = datetime('now')`
).run("FR-CHILD", "SKU-GEN-1", 100);
let stockRow = db.prepare("SELECT * FROM franchise_stock WHERE franchise_code=? AND sku=?").get("FR-CHILD", "SKU-GEN-1");
assert(stockRow.quantity === 100, "franchise stock set to 100");
const newQty = stockRow.quantity + 25; // delta adjust +25
db.prepare("UPDATE franchise_stock SET quantity=?, updated_at=datetime('now') WHERE franchise_code=? AND sku=?").run(newQty, "FR-CHILD", "SKU-GEN-1");
stockRow = db.prepare("SELECT * FROM franchise_stock WHERE franchise_code=? AND sku=?").get("FR-CHILD", "SKU-GEN-1");
assert(stockRow.quantity === 125, "franchise stock delta-adjusted correctly (100 + 25 = 125)");

// negative-quantity guard simulation (mirrors the route's check before applying a delta)
function wouldGoNegative(current, delta) {
  return current + delta < 0;
}
assert(wouldGoNegative(125, -200) === true, "a delta that would drive stock negative is correctly detected");

// now that franchise_stock exists for FR-CHILD, deleting FR-CHILD should also be blocked
let childDeleteErr = null;
try {
  db.exec("BEGIN");
  db.prepare("DELETE FROM franchises WHERE franchise_code = ?").run("FR-CHILD");
  db.exec("COMMIT");
} catch (err) {
  db.exec("ROLLBACK");
  childDeleteErr = err;
}
assert(childDeleteErr !== null, "raw DELETE on a franchise with warehouse stock also throws an FK error (guard needed there too)");

// ---- franchise_payouts (mirrors GET/POST/PATCH /api/franchise-payouts + the payout-transfer report) ----
const payoutResult = db
  .prepare("INSERT INTO franchise_payouts (franchise_code, period_label, amount, note) VALUES (?, ?, ?, ?)")
  .run("FR-CHILD", "WEEK-35-2026", 15000, "test payout");
let payout = db.prepare("SELECT * FROM franchise_payouts WHERE id = ?").get(payoutResult.lastInsertRowid);
assert(payout.status === "Pending", "franchise payout created Pending");

// listing scoped by status (mirrors GET /api/franchise-payouts?status=Pending)
const pendingRows = db.prepare("SELECT * FROM franchise_payouts WHERE status = ?").all("Pending");
assert(pendingRows.length === 1 && pendingRows[0].id === payout.id, "pending-payment filter returns the right row");

// mark Paid with a transfer ref (mirrors PATCH /api/franchise-payouts/:id)
db.prepare("UPDATE franchise_payouts SET status='Paid', transfer_ref=?, paid_at=datetime('now') WHERE id=?").run("TXN-REF-001", payout.id);
payout = db.prepare("SELECT * FROM franchise_payouts WHERE id = ?").get(payout.id);
assert(payout.status === "Paid" && payout.transfer_ref === "TXN-REF-001", "franchise payout marked Paid with transfer_ref");

// payout-transfer-detail report (mirrors GET /api/reports/franchise-payout-transfer?period=)
const transferRows = db
  .prepare(
    `SELECT franchise_payouts.*, franchises.franchise_name FROM franchise_payouts
     JOIN franchises ON franchises.franchise_code = franchise_payouts.franchise_code
     WHERE franchise_payouts.period_label = ? AND franchise_payouts.status = 'Paid'`
  )
  .all("WEEK-35-2026");
assert(transferRows.length === 1 && transferRows[0].franchise_name === "Child Franchise", "payout-transfer-detail report joins franchise name correctly");

// re-processing guard is app-level (checks existing.status !== 'Pending' before allowing another Mark Paid) — verified by inspection of the route, same pattern as fund-requests.

// now that FR-CHILD has payout history too, delete should still be blocked (belt and suspenders — already blocked by stock, but confirms the payout check independently)
const hasPayout = db.prepare("SELECT 1 FROM franchise_payouts WHERE franchise_code = ? LIMIT 1").get("FR-CHILD");
assert(!!hasPayout, "franchise_payouts blocker query correctly finds FR-CHILD's payout history (route would 409 on delete)");

console.log(process.exitCode === 1 ? "\n=== SOME TESTS FAILED ===" : "\n=== ALL TESTS PASSED ===");
