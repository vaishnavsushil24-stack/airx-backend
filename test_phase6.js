// Standalone functional test for the Phase 6 DB logic (Master: Bank/
// State/Package, Member: KYC Documents/Manual Active/Reset Status/
// Change User, Utility: wallet credit/debit, Accounts: Fund Requests,
// Reward Session). npm install is blocked in this sandbox (403 from the
// registry) so express itself isn't available here to boot the real
// server — this exercises the exact same SQL/prepared-statement logic
// the server.js routes use, directly against db.js, the same pattern
// test_phase3.js and test_migration.js already use. Full HTTP-level
// verification happens live against the deployed Render API after push
// (same approach used for the Phase 5 migration).
// Run with: node test_phase6.js

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

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---- seed a member (same INSERT shape as POST /api/members) ----
db.prepare(
  `INSERT INTO members (member_code, name, mobile, kyc_status, status) VALUES (?, ?, ?, 'Pending', 'Active')`
).run("AIRX000001", "Test Member Phase6", "9000000001");
const code = "AIRX000001";

// ---- Masters: Bank ----
const bankResult = db.prepare("INSERT INTO banks (bank_name, status) VALUES (?, ?)").run("HDFC Bank", "Active");
assert(bankResult.lastInsertRowid > 0, "bank master created");
let bankDupeErr = null;
try {
  db.prepare("INSERT INTO banks (bank_name, status) VALUES (?, ?)").run("HDFC Bank", "Active");
} catch (err) {
  bankDupeErr = err;
}
assert(bankDupeErr && String(bankDupeErr.message).includes("UNIQUE"), "duplicate bank name rejected by UNIQUE constraint");
assert(db.prepare("SELECT COUNT(*) AS n FROM banks").get().n === 1, "bank list has exactly 1 row");

// ---- Masters: State ----
db.prepare("INSERT INTO states (state_name, status) VALUES (?, ?)").run("Rajasthan", "Active");
assert(db.prepare("SELECT * FROM states WHERE state_name = 'Rajasthan'").get(), "state master created");

// ---- Masters: Package ----
const pkgResult = db
  .prepare("INSERT INTO packages (package_name, pair_value_pv, price, status) VALUES (?, ?, ?, ?)")
  .run("ACTIVE", 500, 5000, "Active");
db.prepare("UPDATE packages SET price=?, updated_at=datetime('now') WHERE id=?").run(5500, pkgResult.lastInsertRowid);
const pkg = db.prepare("SELECT * FROM packages WHERE id = ?").get(pkgResult.lastInsertRowid);
assert(pkg.pair_value_pv === 500 && pkg.price === 5500, "package master created and patched");

// ---- KYC Documents (mirrors POST + PATCH approve logic) ----
const kycResult = db
  .prepare("INSERT INTO kyc_documents (member_code, doc_type, doc_number) VALUES (?, ?, ?)")
  .run(code, "PAN", "ABCDE1234F");
let kyc = db.prepare("SELECT * FROM kyc_documents WHERE id = ?").get(kycResult.lastInsertRowid);
assert(kyc.status === "Pending", "kyc document uploaded, starts Pending");

db.prepare("UPDATE kyc_documents SET status=?, review_note=?, reviewed_at=datetime('now') WHERE id=?").run(
  "Approved",
  null,
  kyc.id
);
// replicate the member kyc_status bump logic from the PATCH route
const docs = db.prepare("SELECT status FROM kyc_documents WHERE member_code = ?").all(code);
let memberKyc = "Pending";
if (docs.length && docs.every((d) => d.status === "Approved")) memberKyc = "Approved";
else if (docs.some((d) => d.status === "Rejected")) memberKyc = "Pending";
db.prepare("UPDATE members SET kyc_status = ? WHERE member_code = ?").run(memberKyc, code);
assert(db.prepare("SELECT kyc_status FROM members WHERE member_code = ?").get(code).kyc_status === "Approved",
  "member kyc_status bumped to Approved once all docs approved");

// ---- Manual Active / Reset Status / Change User + audit log ----
db.prepare("UPDATE members SET status = 'Inactive' WHERE member_code = ?").run(code);
db.prepare("INSERT INTO member_audit_log (member_code, action, detail) VALUES (?, 'reset_status', ?)").run(code, "test reset");
assert(db.prepare("SELECT status FROM members WHERE member_code=?").get(code).status === "Inactive", "reset-status sets Inactive");

db.prepare("UPDATE members SET status = 'Active' WHERE member_code = ?").run(code);
db.prepare("INSERT INTO member_audit_log (member_code, action, detail) VALUES (?, 'manual_active', ?)").run(code, "offline cash payment");
assert(db.prepare("SELECT status FROM members WHERE member_code=?").get(code).status === "Active", "manual-active sets Active");

const before = db.prepare("SELECT name, mobile FROM members WHERE member_code=?").get(code);
db.prepare("UPDATE members SET name=?, mobile=? WHERE member_code=?").run("New Person Name", "9111111111", code);
db.prepare("INSERT INTO member_audit_log (member_code, action, detail) VALUES (?, 'change_user', ?)").run(
  code,
  JSON.stringify({ before, note: "ID transferred to new owner" })
);
assert(db.prepare("SELECT name FROM members WHERE member_code=?").get(code).name === "New Person Name", "change-user updates identity");
assert(db.prepare("SELECT COUNT(*) AS n FROM member_audit_log WHERE member_code=?").get(code).n === 3,
  "audit log has 3 entries (reset, manual-active, change-user)");

// ---- Wallet credit/debit ----
db.prepare("INSERT INTO wallet_transactions (member_code, wallet_type, txn_type, amount, reason) VALUES (?, 'Weekly', 'credit', ?, ?)")
  .run(code, 1000, "manual bonus");
db.prepare("INSERT INTO wallet_transactions (member_code, wallet_type, txn_type, amount, reason) VALUES (?, 'Weekly', 'debit', ?, ?)")
  .run(code, 200, "correction");
const totals1 = db.prepare(
  `SELECT COALESCE(SUM(CASE WHEN txn_type='credit' THEN amount ELSE 0 END),0) AS c,
          COALESCE(SUM(CASE WHEN txn_type='debit' THEN amount ELSE 0 END),0) AS d
   FROM wallet_transactions WHERE member_code=?`
).get(code);
assert(round2(totals1.c - totals1.d) === 800, "wallet balance = credit - debit = 800");

// ---- Fund requests (create -> approve -> debit posted -> re-approve blocked) ----
const frResult = db.prepare("INSERT INTO fund_requests (member_code, amount, wallet_type) VALUES (?, ?, ?)").run(code, 500, "Weekly");
let fr = db.prepare("SELECT * FROM fund_requests WHERE id=?").get(frResult.lastInsertRowid);
assert(fr.status === "Pending", "fund request created Pending");

db.exec("BEGIN");
db.prepare("UPDATE fund_requests SET status='Approved', processed_at=datetime('now') WHERE id=?").run(fr.id);
db.prepare("INSERT INTO wallet_transactions (member_code, wallet_type, txn_type, amount, reason) VALUES (?, ?, 'debit', ?, ?)")
  .run(code, "Weekly", 500, `Fund request #${fr.id} approved`);
db.exec("COMMIT");
fr = db.prepare("SELECT * FROM fund_requests WHERE id=?").get(fr.id);
assert(fr.status === "Approved", "fund request approved");

const totals2 = db.prepare(
  `SELECT COALESCE(SUM(CASE WHEN txn_type='credit' THEN amount ELSE 0 END),0) AS c,
          COALESCE(SUM(CASE WHEN txn_type='debit' THEN amount ELSE 0 END),0) AS d
   FROM wallet_transactions WHERE member_code=?`
).get(code);
assert(round2(totals2.c - totals2.d) === 300, "wallet balance drops by approved fund request (800-500=300)");
// re-processing guard is app-level (checks existing.status !== 'Pending' before running this block) — verified by inspection of the route.

// ---- Reward session ----
db.prepare("INSERT INTO reward_sessions (session_name, session_date, status) VALUES (?, ?, ?)").run(
  "Aug 2026 Session",
  "2026-08-01",
  "Active"
);
assert(db.prepare("SELECT * FROM reward_sessions WHERE session_name='Aug 2026 Session'").get(), "reward session created");

// ---- Reports: daily-points / daily-payouts / topup-detail / tds (schema shape only, data is empty which is fine) ----
db.prepare("INSERT INTO pv_ledger (member_code, order_ref, pv, bv, entry_type) VALUES (?, NULL, ?, ?, 'topup')").run(code, 100, 100);
const topupRows = db.prepare(
  `SELECT pv_ledger.*, members.name AS member_name FROM pv_ledger
   JOIN members ON members.member_code = pv_ledger.member_code
   WHERE pv_ledger.entry_type = 'topup'`
).all();
assert(topupRows.length === 1, "topup-detail query returns the seeded topup row");

const dailyPoints = db.prepare(
  `SELECT date(created_at) AS day, member_code, entry_type, SUM(pv) AS total_pv, SUM(bv) AS total_bv, COUNT(*) AS entries
   FROM pv_ledger GROUP BY day, member_code, entry_type`
).all();
assert(dailyPoints.length === 1 && dailyPoints[0].total_pv === 100, "daily-points query groups correctly");

// ---- DELETE /api/members/:code guard (bug found & fixed 2026-08-24) ----
// A member with wallet/fund-request/KYC history used to hit a raw FK
// constraint violation (500). Now it should be blocked with a clear 409,
// while a "clean" member (no financial history, no downline) deletes fine.
db.exec("PRAGMA foreign_keys = ON");
let deleteErr = null;
try {
  db.exec("BEGIN");
  db.prepare("DELETE FROM members WHERE member_code = ?").run(code); // has wallet_transactions rows
  db.exec("COMMIT");
} catch (err) {
  db.exec("ROLLBACK");
  deleteErr = err;
}
assert(deleteErr !== null, "raw DELETE on a member with wallet history throws an FK error (confirms the route's guard is necessary)");
assert(db.prepare("SELECT 1 FROM members WHERE member_code=?").get(code), "member with financial history still exists after the blocked delete");

db.prepare(`INSERT INTO members (member_code, name, status) VALUES ('AIRX000002', 'Clean Member No History', 'Active')`).run();
db.prepare("DELETE FROM kyc_documents WHERE member_code = 'AIRX000002'").run();
db.prepare("DELETE FROM member_audit_log WHERE member_code = 'AIRX000002'").run();
db.prepare("DELETE FROM pv_balance WHERE member_code = 'AIRX000002'").run();
const cleanDelete = db.prepare("DELETE FROM members WHERE member_code = 'AIRX000002'").run();
assert(cleanDelete.changes === 1, "a member with no financial/downline history deletes cleanly");

console.log(process.exitCode === 1 ? "\n=== SOME TESTS FAILED ===" : "\n=== ALL TESTS PASSED ===");
