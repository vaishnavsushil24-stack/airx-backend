// AIRX Ops — relational data store (Phase 0 of the store.airxplus.com /
// admin.airxplus.com integration — see MLM_INTEGRATION_PLAN.md).
//
// Uses Node's built-in `node:sqlite` module (stable from Node 22.5+, no npm
// install / native compilation needed — important because native modules
// like better-sqlite3 can be finicky to build on some hosts). The database
// file lives in the same `data/` directory as the existing leads/orders/
// shopify JSON files, so it inherits whatever disk persistence Render is
// already giving that directory.
//
// This file only defines the schema and a couple of small helpers. Route
// handlers live in server.js, same as the rest of the API.

const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, "airx.db");
const db = new DatabaseSync(DB_FILE);

db.exec("PRAGMA foreign_keys = ON;");

// ---------------------------------------------------------------------
// Schema — covers Phases 1-4 of MLM_INTEGRATION_PLAN.md up front (tables
// cost nothing to declare), even though the API endpoints for the later
// phases are added incrementally.
// ---------------------------------------------------------------------
db.exec(`
-- Phase 1: Product & Franchise Master (mirrors store.airxplus.com)
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  dp_price REAL NOT NULL DEFAULT 0,
  mrp_price REAL NOT NULL DEFAULT 0,
  pv REAL NOT NULL DEFAULT 0,
  bv REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS franchises (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  franchise_code TEXT UNIQUE NOT NULL,
  franchise_name TEXT NOT NULL,
  parent_franchise_code TEXT,
  contact_name TEXT,
  contact_mobile TEXT,
  address TEXT,
  state TEXT,
  status TEXT NOT NULL DEFAULT 'Active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (parent_franchise_code) REFERENCES franchises(franchise_code)
);

CREATE TABLE IF NOT EXISTS franchise_stock (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  franchise_code TEXT NOT NULL,
  sku TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (franchise_code, sku),
  FOREIGN KEY (franchise_code) REFERENCES franchises(franchise_code),
  FOREIGN KEY (sku) REFERENCES products(sku)
);

-- Phase 2: Distributor / Member Master (mirrors admin.airxplus.com "Member")
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  sponsor_code TEXT,
  placement_leg TEXT,
  mobile TEXT,
  email TEXT,
  pan_number TEXT,
  bank_account_number TEXT,
  bank_ifsc TEXT,
  bank_name TEXT,
  kyc_status TEXT NOT NULL DEFAULT 'Pending',
  status TEXT NOT NULL DEFAULT 'Active',
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (sponsor_code) REFERENCES members(member_code)
);

-- Phase 3: Compensation engine (PV/BV, payout, TDS, wallet)
CREATE TABLE IF NOT EXISTS pv_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_code TEXT NOT NULL,
  order_ref TEXT,
  pv REAL NOT NULL,
  bv REAL NOT NULL,
  entry_type TEXT NOT NULL DEFAULT 'purchase',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (member_code) REFERENCES members(member_code)
);

CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_code TEXT NOT NULL,
  period_label TEXT NOT NULL,
  gross_amount REAL NOT NULL DEFAULT 0,
  tds_amount REAL NOT NULL DEFAULT 0,
  admin_charge REAL NOT NULL DEFAULT 0,
  net_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (member_code) REFERENCES members(member_code)
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_code TEXT NOT NULL,
  wallet_type TEXT NOT NULL DEFAULT 'Weekly',
  txn_type TEXT NOT NULL,
  amount REAL NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (member_code) REFERENCES members(member_code)
);

-- Phase 4: Rewards & rank achievers
CREATE TABLE IF NOT EXISTS rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reward_name TEXT NOT NULL,
  criteria_pv REAL NOT NULL DEFAULT 0,
  reward_value TEXT,
  session_label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reward_achievers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_code TEXT NOT NULL,
  reward_id INTEGER NOT NULL,
  achieved_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (member_code) REFERENCES members(member_code),
  FOREIGN KEY (reward_id) REFERENCES rewards(id)
);
`);

// ---------------------------------------------------------------------
// Migration: pv_ledger needs a column marking which payout run already
// consumed a row, so the matching engine (server.js computeMatching)
// never double-counts the same PV/BV across two weekly runs. Added
// defensively via PRAGMA table_info since pv_ledger already existed
// (empty, but with this exact shape) in the Phase 0 deploy.
// ---------------------------------------------------------------------
const pvLedgerCols = db.prepare("PRAGMA table_info(pv_ledger)").all().map((c) => c.name);
if (!pvLedgerCols.includes("consumed_in_period")) {
  db.exec("ALTER TABLE pv_ledger ADD COLUMN consumed_in_period TEXT");
}

// ---------------------------------------------------------------------
// Phase 3 continued — compensation engine tables added once the business
// owner decided how to proceed (2026-08-23): admin.airxplus.com does not
// store its matching-bonus formula anywhere accessible (Reward Master,
// Manual Rank and TDS Report are all empty there), and the developer who
// built it wanted extra payment to hand over the real spec. So instead of
// leaving Phase 3 blocked, the owner asked for an ADMIN-CONFIGURABLE
// commission engine: only two numbers below are actually confirmed from
// admin.airxplus.com (pair_value_pv = 500 from KitMaster.aspx "ACTIVE"
// package, admin_charge_percent = 5 from the dashboard Income Summary);
// everything else is a clearly-labeled provisional default that can be
// corrected any time via PUT /api/settings/commission — no code change or
// redeploy needed.
// ---------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS commission_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value REAL NOT NULL,
  label TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pv_balance (
  member_code TEXT PRIMARY KEY,
  left_carry_forward REAL NOT NULL DEFAULT 0,
  right_carry_forward REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (member_code) REFERENCES members(member_code)
);

CREATE TABLE IF NOT EXISTS payout_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_label TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'Draft',
  total_incoming_bv REAL NOT NULL DEFAULT 0,
  total_outgoing_net REAL NOT NULL DEFAULT 0,
  payout_ratio_percent REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  committed_at TEXT
);
`);

const defaultCommissionSettings = [
  ["pair_value_pv", 500, "CONFIRMED (admin.airxplus.com KitMaster.aspx, ACTIVE package) — PV required on each leg to form one matched pair"],
  ["payout_per_pair_amount", 500, "PROVISIONAL — rupees paid out per matched pair; defaulted equal to pair_value_pv until the real figure is known"],
  ["admin_charge_percent", 5, "CONFIRMED (admin.airxplus.com dashboard Income Summary) — admin/maintenance charge deducted from gross payout"],
  ["tds_percent", 5, "PROVISIONAL — confirm the correct statutory TDS rate for direct-selling commission with your CA/accountant"],
  ["max_pairs_per_period", 0, "PROVISIONAL — cap on matched pairs counted per run; 0 = unlimited"],
];
const insertCommissionSetting = db.prepare(
  "INSERT OR IGNORE INTO commission_settings (setting_key, setting_value, label) VALUES (?, ?, ?)"
);
for (const [key, value, label] of defaultCommissionSettings) {
  insertCommissionSetting.run(key, value, label);
}

module.exports = { db };
