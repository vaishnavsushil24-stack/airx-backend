// Standalone functional test for the Phase 3 compensation engine logic.
// Express isn't installed in this sandbox, so this exercises the exact
// same SQL/JS the routes in server.js use, without going through HTTP.
// Run with: node test_phase3.js   (then delete data/airx.db to reset)

const fs = require("fs");
const path = require("path");
const DATA_DIR = path.join(__dirname, "data");
if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });

const { db } = require("./db.js");

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function getCommissionSettings() {
  const rows = db.prepare("SELECT setting_key, setting_value FROM commission_settings").all();
  const s = {};
  for (const r of rows) s[r.setting_key] = r.setting_value;
  return s;
}

function computeMatching(periodLabel) {
  const settings = getCommissionSettings();
  const pairValue = settings.pair_value_pv || 500;
  const payoutPerPair = settings.payout_per_pair_amount || pairValue;
  const adminChargePct = settings.admin_charge_percent || 0;
  const tdsPct = settings.tds_percent || 0;
  const maxPairs = settings.max_pairs_per_period || 0;

  const members = db.prepare("SELECT member_code, sponsor_code, placement_leg FROM members").all();
  const children = {};
  for (const m of members) {
    if (!m.sponsor_code) continue;
    (children[m.sponsor_code] = children[m.sponsor_code] || []).push(m);
  }

  const ledgerRows = db
    .prepare(
      `SELECT member_code, COALESCE(SUM(pv),0) AS pv, COALESCE(SUM(bv),0) AS bv
       FROM pv_ledger WHERE consumed_in_period IS NULL GROUP BY member_code`
    )
    .all();
  const ownPv = {};
  let totalIncomingBv = 0;
  for (const r of ledgerRows) {
    ownPv[r.member_code] = r.pv;
    totalIncomingBv += r.bv;
  }

  const balances = {};
  for (const b of db.prepare("SELECT * FROM pv_balance").all()) balances[b.member_code] = b;

  const MAX_DEPTH = 50;
  const subtreePv = {};
  function subtreeSum(code, depth, seen) {
    if (subtreePv[code] !== undefined) return subtreePv[code];
    if (depth > MAX_DEPTH || seen.has(code)) return 0;
    seen.add(code);
    let sum = ownPv[code] || 0;
    for (const child of children[code] || []) sum += subtreeSum(child.member_code, depth + 1, seen);
    subtreePv[code] = sum;
    return sum;
  }
  for (const m of members) subtreeSum(m.member_code, 0, new Set());

  const results = [];
  for (const m of members) {
    const kids = children[m.member_code] || [];
    const bf = balances[m.member_code] || { left_carry_forward: 0, right_carry_forward: 0 };
    if (kids.length === 0 && bf.left_carry_forward === 0 && bf.right_carry_forward === 0) continue;

    let leftNew = 0;
    let rightNew = 0;
    for (const child of kids) {
      const val = subtreePv[child.member_code] || 0;
      if (child.placement_leg === "Left") leftNew += val;
      else if (child.placement_leg === "Right") rightNew += val;
    }

    const leftTotal = bf.left_carry_forward + leftNew;
    const rightTotal = bf.right_carry_forward + rightNew;
    let matchedPairs = Math.floor(Math.min(leftTotal, rightTotal) / pairValue);
    if (maxPairs > 0) matchedPairs = Math.min(matchedPairs, maxPairs);

    const grossAmount = matchedPairs * payoutPerPair;
    const adminCharge = round2((grossAmount * adminChargePct) / 100);
    const tds = round2((grossAmount * tdsPct) / 100);
    const netAmount = round2(grossAmount - adminCharge - tds);
    const usedPv = matchedPairs * pairValue;

    results.push({
      member_code: m.member_code,
      left_total: round2(leftTotal),
      right_total: round2(rightTotal),
      matched_pairs: matchedPairs,
      gross_amount: round2(grossAmount),
      admin_charge: adminCharge,
      tds_amount: tds,
      net_amount: netAmount,
      left_carry_forward: round2(leftTotal - usedPv),
      right_carry_forward: round2(rightTotal - usedPv),
    });
  }

  const totalOutgoingNet = round2(results.reduce((sum, r) => sum + r.net_amount, 0));
  const payoutRatioPercent = totalIncomingBv > 0 ? round2((totalOutgoingNet / totalIncomingBv) * 100) : 0;

  return {
    period_label: periodLabel,
    total_incoming_bv: round2(totalIncomingBv),
    total_outgoing_net: totalOutgoingNet,
    payout_ratio_percent: payoutRatioPercent,
    members: results,
  };
}

// ---- Build a tiny known tree ----
// ROOT
//  ├─ L1 (Left)  -> owns 300 PV/BV purchase
//  │    ├─ L1A (Left)  -> owns 400 PV/BV
//  │    └─ L1B (Right) -> owns 100 PV/BV
//  └─ R1 (Right) -> owns 900 PV/BV
//
// ROOT's Left subtree total = 300+400+100 = 800 PV
// ROOT's Right subtree total = 900 PV
// pair_value_pv = 500 -> matched pairs = floor(min(800,900)/500) = 1
// gross = 1 * 500 = 500; admin 5% = 25; tds 5% = 25; net = 450
// leftover CF: left 800-500=300, right 900-500=400

const insertMember = db.prepare(
  `INSERT INTO members (member_code, name, sponsor_code, placement_leg) VALUES (?, ?, ?, ?)`
);
insertMember.run("ROOT", "Root Member", null, null);
insertMember.run("L1", "Left One", "ROOT", "Left");
insertMember.run("R1", "Right One", "ROOT", "Right");
insertMember.run("L1A", "Left One A", "L1", "Left");
insertMember.run("L1B", "Left One B", "L1", "Right");

const insertPv = db.prepare(
  `INSERT INTO pv_ledger (member_code, pv, bv, entry_type) VALUES (?, ?, ?, 'purchase')`
);
insertPv.run("L1", 300, 300);
insertPv.run("L1A", 400, 400);
insertPv.run("L1B", 100, 100);
insertPv.run("R1", 900, 900);

const preview = computeMatching("TEST-WEEK-1");
const root = preview.members.find((m) => m.member_code === "ROOT");

console.log(JSON.stringify(preview, null, 2));

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("PASS:", msg);
  }
};

assert(root.left_total === 800, "ROOT left_total = 800");
assert(root.right_total === 900, "ROOT right_total = 900");
assert(root.matched_pairs === 1, "ROOT matched_pairs = 1");
assert(root.gross_amount === 500, "ROOT gross_amount = 500");
assert(root.admin_charge === 25, "ROOT admin_charge = 25 (5%)");
assert(root.tds_amount === 25, "ROOT tds_amount = 25 (5%)");
assert(root.net_amount === 450, "ROOT net_amount = 450");
assert(root.left_carry_forward === 300, "ROOT left_carry_forward = 300");
assert(root.right_carry_forward === 400, "ROOT right_carry_forward = 400");
assert(preview.total_incoming_bv === 1700, "total_incoming_bv = 1700 (300+400+100+900)");
assert(preview.total_outgoing_net === 450, "total_outgoing_net = 450 (only ROOT matched)");
assert(
  preview.payout_ratio_percent === round2((450 / 1700) * 100),
  "payout_ratio_percent computed correctly"
);

console.log(process.exitCode === 1 ? "\n=== SOME TESTS FAILED ===" : "\n=== ALL TESTS PASSED ===");
