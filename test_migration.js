// Standalone functional test for the Phase 5 legacy-data migration logic
// (bulk-import upsert/two-pass sponsor linking, and the dummy-data
// classifier). Exercises the exact same SQL server.js uses, without HTTP.
// Run with: node test_migration.js

const fs = require("fs");
const path = require("path");
const DATA_DIR = path.join(__dirname, "data");
if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });

const { db } = require("./db.js");

function parseLegacyDate(s) {
  if (!s) return null;
  const months = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };
  const m = String(s).trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return s;
  const mon = months[m[2].toLowerCase()];
  if (!mon) return s;
  return `${m[3]}-${mon}-${m[1].padStart(2, "0")}`;
}

function bulkImport(rows) {
  const upsert = db.prepare(`
    INSERT INTO members
      (member_code, name, mobile, pan_number, kyc_status, status, legacy_package, joined_at, data_source)
    VALUES (?, ?, ?, ?, 'Pending', ?, ?, ?, 'legacy_import')
    ON CONFLICT(member_code) DO UPDATE SET
      name = excluded.name,
      mobile = excluded.mobile,
      pan_number = excluded.pan_number,
      status = excluded.status,
      legacy_package = excluded.legacy_package,
      joined_at = excluded.joined_at,
      data_source = 'legacy_import',
      updated_at = datetime('now')
  `);
  const setSponsor = db.prepare(
    "UPDATE members SET sponsor_code = ? WHERE member_code = ? AND (sponsor_code IS NULL OR data_source = 'legacy_import')"
  );
  const existsStmt = db.prepare("SELECT 1 FROM members WHERE member_code = ?");

  let imported = 0, sponsorLinked = 0, orphanedSponsor = 0;
  const errors = [];
  const batchCodes = new Set(rows.map((r) => String(r.idNo || "").trim()).filter(Boolean));

  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const memberCode = String(r.idNo || "").trim();
      const name = String(r.name || "").trim();
      if (!memberCode || !name) {
        errors.push({ idNo: r.idNo, error: "missing idNo or name" });
        continue;
      }
      const pkg = String(r.pkg || "").trim();
      const status = pkg.toUpperCase() === "ACTIVE" ? "Active" : "Inactive";
      upsert.run(
        memberCode, name,
        String(r.mobile || "").trim() || null,
        String(r.pan || "").trim() || null,
        status, pkg || null, parseLegacyDate(r.confDate)
      );
      imported++;
    }
    for (const r of rows) {
      const memberCode = String(r.idNo || "").trim();
      const uplineId = String(r.uplineId || "").trim();
      if (!memberCode || !uplineId || uplineId === memberCode) continue;
      const target = existsStmt.get(uplineId) || (batchCodes.has(uplineId) ? true : null);
      if (target) {
        setSponsor.run(uplineId, memberCode);
        sponsorLinked++;
      } else {
        orphanedSponsor++;
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { imported, sponsor_linked: sponsorLinked, orphaned_sponsor: orphanedSponsor, errors };
}

function flagDummies() {
  const namePattern = /^(mr|mrs|ms)?\.?\s*(airx|mahadev|pranvayu|test|demo|dummy|sample)\s*\d+$/i;
  const mobileDupes = db.prepare(
    `SELECT mobile, COUNT(*) AS n FROM members WHERE mobile IS NOT NULL AND mobile != '' GROUP BY mobile HAVING n > 2`
  ).all();
  const panDupes = db.prepare(
    `SELECT pan_number, COUNT(*) AS n FROM members WHERE pan_number IS NOT NULL AND pan_number != '' GROUP BY pan_number HAVING n > 2`
  ).all();
  const dupeMobiles = new Set(mobileDupes.map((r) => r.mobile));
  const dupePans = new Set(panDupes.map((r) => r.pan_number));
  const all = db.prepare("SELECT member_code, name, mobile, pan_number FROM members").all();
  const clearFlag = db.prepare("UPDATE members SET likely_dummy = 0, dummy_reason = NULL WHERE member_code = ?");
  const setFlag = db.prepare("UPDATE members SET likely_dummy = 1, dummy_reason = ? WHERE member_code = ?");

  let flagged = 0;
  db.exec("BEGIN");
  try {
    for (const m of all) {
      const reasons = [];
      if (namePattern.test((m.name || "").trim())) reasons.push("sequential placeholder name");
      if (m.mobile && dupeMobiles.has(m.mobile)) reasons.push(`mobile shared by ${mobileDupes.find((r) => r.mobile === m.mobile).n} members`);
      if (m.pan_number && dupePans.has(m.pan_number)) reasons.push(`PAN shared by ${panDupes.find((r) => r.pan_number === m.pan_number).n} members`);
      if (reasons.length) { setFlag.run(reasons.join("; "), m.member_code); flagged++; }
      else clearFlag.run(m.member_code);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { total_members: all.length, flagged_dummy: flagged, clean: all.length - flagged };
}

// ---- Sample rows mimicking the real admin.airxplus.com export shape ----
// ROOT (airxplus01, no upline) -> REAL1 (real distributor)
//                              -> D1, D2, D3 (dummy: sequential "Airx" names, shared mobile/PAN)
// Also: a child (D2) appears in the array BEFORE its parent (D1) to prove
// the two-pass sponsor-link handles out-of-order data.
const rows = [
  { idNo: "airxplus01", name: "Mr AIRX PLUS HEALTHCARE PVT LTD", confDate: "30-Apr-2026", pkg: "ACTIVE", mobile: "8290213456", pan: "", uplineId: "" },
  { idNo: "AIRX_D2", name: "Mr Airx2", confDate: "28-Apr-2026", pkg: "FREE USER", mobile: "9509976822", pan: "", uplineId: "AIRX_D1" }, // child before parent
  { idNo: "AIRX_REAL1", name: "Mr Sushil Kumar Vaishnav", confDate: "30-Apr-2026", pkg: "ACTIVE", mobile: "8290213999", pan: "AHOPV0459R", uplineId: "airxplus01" },
  { idNo: "AIRX_D1", name: "Mr Airx1", confDate: "28-Apr-2026", pkg: "FREE USER", mobile: "9509976822", pan: "", uplineId: "airxplus01" },
  { idNo: "AIRX_D3", name: "Mr Airx3", confDate: "28-Apr-2026", pkg: "FREE USER", mobile: "9509976822", pan: "", uplineId: "AIRX_D2" },
  { idNo: "AIRX_ORPHAN", name: "Mr Orphan Case", confDate: "01-May-2026", pkg: "ACTIVE", mobile: "7000000000", pan: "", uplineId: "AIRX_NOTEXIST" },
];

const importResult = bulkImport(rows);
console.log("import:", JSON.stringify(importResult, null, 2));

const assert = (cond, msg) => {
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else console.log("PASS:", msg);
};

assert(importResult.imported === 6, "6 rows imported");
assert(importResult.errors.length === 0, "no import errors");
assert(importResult.orphaned_sponsor === 1, "1 orphaned sponsor (AIRX_NOTEXIST doesn't exist)");
assert(importResult.sponsor_linked === 4, "4 sponsor links resolved (root has no upline, orphan doesn't count)");

const root = db.prepare("SELECT * FROM members WHERE member_code = 'airxplus01'").get();
assert(root.sponsor_code === null, "root has no sponsor_code");

const d2 = db.prepare("SELECT * FROM members WHERE member_code = 'AIRX_D2'").get();
assert(d2.sponsor_code === "AIRX_D1", "out-of-order child D2 correctly links to parent D1 (two-pass works)");

const real1 = db.prepare("SELECT * FROM members WHERE member_code = 'AIRX_REAL1'").get();
assert(real1.sponsor_code === "airxplus01", "REAL1 links to root");
assert(real1.status === "Active", "REAL1 status mapped to Active");
assert(real1.joined_at === "2026-04-30", "REAL1 joined_at parsed to ISO date");

const orphan = db.prepare("SELECT * FROM members WHERE member_code = 'AIRX_ORPHAN'").get();
assert(orphan.sponsor_code === null, "orphan-sponsor row still imported, just unlinked");

const flagResult = flagDummies();
console.log("flag-dummies:", JSON.stringify(flagResult, null, 2));

assert(flagResult.total_members === 6, "flag-dummies scanned all 6 members");
assert(flagResult.flagged_dummy === 3, "exactly 3 flagged dummy (D1, D2, D3 — name pattern AND shared mobile)");

const d1 = db.prepare("SELECT likely_dummy, dummy_reason FROM members WHERE member_code = 'AIRX_D1'").get();
assert(d1.likely_dummy === 1, "D1 flagged likely_dummy");
assert(/sequential placeholder name/.test(d1.dummy_reason), "D1 reason mentions name pattern");
assert(/mobile shared/.test(d1.dummy_reason), "D1 reason mentions shared mobile");

const realFlag = db.prepare("SELECT likely_dummy FROM members WHERE member_code = 'AIRX_REAL1'").get();
assert(realFlag.likely_dummy === 0, "REAL1 NOT flagged as dummy");

// Idempotency check: re-running bulk-import on the same rows should not
// duplicate or error (ON CONFLICT upsert).
const secondRun = bulkImport(rows);
assert(secondRun.imported === 6, "re-import is idempotent (still 6, no duplicate rows)");
const countCheck = db.prepare("SELECT COUNT(*) AS n FROM members").get();
assert(countCheck.n === 6, "member count unchanged after re-import (no dupes created)");

console.log(process.exitCode === 1 ? "\n=== SOME TESTS FAILED ===" : "\n=== ALL TESTS PASSED ===");
