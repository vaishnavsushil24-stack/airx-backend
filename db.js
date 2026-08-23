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
-- NOTE: these tables are storage/ledger scaffolding only. The actual
-- compensation-plan MATH (level %, matching bonus rules, global auto pool,
-- repurchase bonus, rank bonus formulas) is NOT implemented yet — those
-- numbers come from AIRX's compensation plan document, which Claude has not
-- been given. See MLM_INTEGRATION_PLAN.md Phase 3 note.
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

module.exports = { db };
