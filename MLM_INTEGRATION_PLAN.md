# AIRX Ops — Store + Admin (MLM) Integration Plan

## Goal (as given)
"admin and store ke sabhi features hamari airx ops me karna hai" — replicate every feature of
`store.airxplus.com` and `admin.airxplus.com` inside our own AIRX Ops backend (`airx-backend`),
so both systems eventually retire in favor of one system we own and control.

## What each source system actually contains (confirmed by direct login/review)

### 1. store.airxplus.com — Product / Franchise / Warehouse ERP (currently EMPTY — 0 products, 0 franchises)
ASP.NET WebForms app. Menu structure:
- **Master / Product**: Product Report, product categories (General / Mens / Women / Special Wellness)
- **Franchise**: Franchise details (`warehouseView.aspx`), Warehouse (`warehouse.aspx`), franchise
  hierarchy (parent-child franchise code/name)
- **Commission**: Franchise bank details, franchise payout detail, pending payment, payout transfer detail
- **Admin/User**: User creation, user groups, permissions (`MenuMaster`), change password, profile pic
- **Dashboard / Logout**

This is the intended source of truth for the **physical product catalog, SKU/stock levels per
franchise warehouse, and franchise-level (not individual distributor) commission payouts**. It is
a blank slate today — no product or franchise data has been entered yet.

### 2. admin.airxplus.com — MLM Distributor / Compensation-Plan Engine (LIVE, populated data)
ASP.NET app, currently logged in as "Admin" — this account itself shows live business numbers:
Total Joining 2,437 · Total Active 75 · Total PV 67,450 · Total Income ₹22,275.60.
Menu structure:
- **Master**: Bank, State, **Package** (join "kits" — REGISTRATION / ACTIVE, with PairValue —
  these are enrollment packages, not consumer products), News, User, UserGroup, Permissions,
  Meeting, Gallery/Video/Media/Presentations, Training, Testimonial, Slider
- **Member**: Edit Profile, Reset Member Status, Search Member, Downline Members, Date-wise
  Joining, Referral Detail, Leg Structure, KYC Document, View Profile, PAN Card Detail, Manual
  Active, Block/Unblock ID, **Distributor Tree**, Change User
- **Payout**: Weekly MIS Report, Daily Point Detail, Daily Payout Detail
- **Accounts**: View Fund Request, Payout Transfer Weekly, Topup Detail, All TDS Report
- **Utility**: Fund Credit, Fund Credit Detail, Fund Credit/Debit
- **Reports**: View Fund Request, Downline PV Detail, Member Balance
- **Reward**: Reward Session, Reward Master, Reward Details, Rank Achievers List

This is the **individual distributor compensation-plan engine**: enrollment, sponsor/downline
tree, PV/BV accumulation, weekly payout calculation, TDS deduction, wallet (fund credit/debit),
KYC/bank details for payout, and rank/reward tracking. It holds **no physical product catalog** —
"Package" here means join-kits, not SKUs.

### 3. AIRX Ops (airx-backend) — what we have today
Single-file Express app, **flat JSON files on disk** (`leads.json`, `orders.json`, `inventory.json`,
`shop.json`) — no real database. Current features: Meta Lead Ads webhook, Shopify OAuth + order
sync/fulfill, India Post pincode/booking/tracking (via the proxy we just finished), a simple
leads/orders/inventory API, staff summary, WhatsApp notification hooks.

**Gap**: this is fine for a few hundred leads/orders, but an MLM ledger (PV/BV history, weekly
payout runs, TDS statements, wallet transactions across thousands of distributors) needs a real
relational database, not JSON files. This is the first architectural decision to make before
building the MLM features.

## Proposed phased roadmap

**Phase 0 — Foundation (prerequisite for everything else)**
Add a real database (recommend Postgres — Render offers a free/managed Postgres instance that
plugs straight into the existing Render deployment) and a schema/migration setup. Keep existing
JSON-file features working during the migration.

**Phase 1 — Product & Franchise Master** (mirrors store.airxplus.com)
Product catalog (SKU, category, DP/MRP pricing), franchise master (code, name, parent-child
hierarchy), franchise-level warehouse stock.

**Phase 2 — Distributor / Member Master** (mirrors admin.airxplus.com "Member")
Distributor signup/profile, sponsor ID + downline tree (leg structure), KYC documents, PAN + bank
details for payout, block/unblock/manual-active status.

**Phase 3 — Compensation Engine** (highest financial risk — needs careful testing against real
historical numbers from admin.airxplus.com before cutover)
PV/BV accrual per order, weekly payout calculation (matching the existing "Weekly MIS Report" /
"Daily Payout Detail" logic), TDS deduction rules, wallet (fund credit/debit) ledger.

**Phase 4 — Rewards & Reporting**
Rank/reward master and achievers list, downline PV reports, member balance reports.

**Phase 5 — Cutover**
Once Phase 1–4 are validated in parallel against store.airxplus.com / admin.airxplus.com, redirect
data entry to AIRX Ops and retire the two legacy systems.

## Why phase it instead of building everything at once
- Phase 3 (compensation/payout/TDS) directly affects distributor income — getting the PV/BV or
  TDS math wrong has real financial consequences, so it deserves to be built and verified against
  known-good numbers from admin.airxplus.com (e.g. reconcile against the ₹22,275.60 / PV 67,450
  figures we already saw) before anyone relies on it.
- Building the database foundation first avoids having to redo the product/franchise work in
  Phase 1 once the JSON-file limits are hit.

## What I need from you to start
Which phase should I start on first — Phase 0+1 (product/franchise master, lower risk, unblocks
inventory work) or something else? And do you want me to set up a proper database (Postgres) now,
or keep using JSON files a bit longer for the product/franchise data since it's small?
