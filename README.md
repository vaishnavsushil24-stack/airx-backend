# AIRX Backend — Meta Leads, without Wetroo

This is a small server that plugs the one hole a plain HTML file (like AIRX Ops)
can't fill: it has a real internet address, so Meta (Facebook) can push new
leads into it the instant someone fills your Lead Ad form — no CRM, no Wetroo,
no manual export needed.

## What it does right now

- `GET /webhook/meta` — one-time handshake so Meta can verify you own this server.
- `POST /webhook/meta` — Meta calls this automatically every time a lead comes
  in. The server fetches the lead's name/phone/email from Meta and saves it.
- `GET /api/leads` — list all captured leads (protected by an API key).
- `PATCH /api/leads/:id` — update a lead's status (new/contacted/converted/lost).
- `GET/POST/PATCH /api/orders` — same idea for orders, so this can later
  replace the WhatsApp-paste step in AIRX Ops too.

Leads and orders are stored in `data/leads.json` / `data/orders.json` — good
enough to start today; swap for a real database later if volume grows past a
few thousand records.

## 1. Deploy it (10 minutes, free tier is enough to start)

Easiest option: **Render.com** (Railway or Fly.io work the same way).

1. Put this folder in a GitHub repo (or ask me — I can prepare it for you).
2. On Render: New → Web Service → connect the repo.
3. Build command: `npm install`   Start command: `npm start`
4. Add the environment variables from `.env.example` under Render's
   "Environment" tab (fill in real values — see step 2 below for where to get
   the Meta ones).
5. Deploy. Render gives you a URL like `https://airx-backend.onrender.com` —
   this is your webhook address.

## 2. Connect Meta (Facebook) Lead Ads — this part only you can do

This needs your Facebook Business login, so I can't click through it for you.
Here's exactly what to do:

1. Go to **developers.facebook.com** → My Apps → Create App → choose
   **"Other" → "Business"**. Name it something like "AIRX Leads".
2. In the app, add the **Webhooks** product. Subscribe to the **Page** object,
   field **leadgen**.
3. Callback URL: `https://<your-render-url>/webhook/meta`
   Verify token: any string you like — put the *same* string in your `.env`
   as `META_VERIFY_TOKEN`. Click "Verify and Save" (this is the GET request
   the server above handles).
4. Under App Settings → Basic, copy the **App Secret** → put it in `.env` as
   `META_APP_SECRET`.
5. Connect your Facebook Page to the app (Webhooks → Page → Subscribe your
   Pranvaayu / AIRX Page), and generate a **Page Access Token** (Graph API
   Explorer, or the "Page access token" shown when you connect the Page) →
   put it in `.env` as `META_PAGE_ACCESS_TOKEN`.
6. Submit the app for **Standard Access** on the `leads_retrieval` and
   `pages_manage_metadata` permissions if prompted — Meta reviews this
   (usually 1–3 days). Until approved, it still works in Development Mode for
   pages you personally admin, so you can test end-to-end immediately.

Once steps 1–6 are done, every new Lead Ad submission lands in
`GET /api/leads` automatically — zero manual work, exactly what you asked for.

Once steps 1–6 are done, every new Lead Ad submission lands in
`GET /api/leads` automatically — zero manual work, exactly what you asked for.

## 3. Connect Shopify (already partly done)

The Shopify custom app **"AIRX Ops Connector"** is already created and
installed on your store, with the right permissions (orders, fulfillments,
customers, products). What's left:

1. Get `SHOPIFY_API_KEY` (Client ID) and `SHOPIFY_API_SECRET` (Client Secret)
   from **dev.shopify.com/dashboard/206208621/apps/413020028929/settings** —
   Client ID is already filled into `.env.example` for you; click "Reveal
   client secret" on that page and copy the secret yourself directly into
   your `.env` / Render environment variables (this is the one value that
   should go straight from Shopify to Render, skipping me, since it's a real
   credential).
2. Confirm `SHOPIFY_SHOP` — Shopify Admin → Settings → Domains → the
   `*.myshopify.com` one.
3. Once deployed, visit `https://<your-render-url>/shopify/install` **once**
   in your browser, click "Install" on Shopify's approval screen — the server
   exchanges that for a permanent access token and saves it itself. No token
   copy-pasting needed after that.
4. Call `POST /api/shopify/sync-orders` (with your `x-api-key` header)
   whenever you want to pull the latest Shopify orders into AIRX Ops — I'll
   wire this to run automatically (e.g. every 10 minutes) once it's live.
5. Once an order is booked with India Post, call
   `POST /api/shopify/fulfill` with `{ shopifyOrderId, trackingNumber }` —
   this marks the Shopify order as fulfilled and emails the customer their
   tracking info. This closes the gap we found earlier where all 262 Shopify
   orders sat "Unfulfilled" forever even though they'd actually shipped.

## 4. Connect India Post (Bulk Customer API) — real auto-booking

This is India Post's official system-to-system booking API. Once configured,
moving an order to "Booked" in AIRX Ops actually books it at India Post
automatically and gets back a real tracking barcode — no post-office counter
needed.

**Update (Aug 2026):** your sandbox account (Customer ID `9999297656`) is now
fully set up on India Post's real developer portal —
**app.indiapost.gov.in/customer-selfservice** → Settings → Sandbox API
Subscription. I subscribed all 12 available sandbox APIs (login, tariff
calculation, bulk booking, tracking, labels) and configured the event
webhooks (Booking + Other Events) to point at this server's
`/webhook/indiapost/event` endpoint, so delivery-scan updates will flow in
automatically once a real booking has happened. I also cross-checked our
booking code against the portal's official API documentation
(`/customer-selfservice/apidoc`) and fixed a few field mismatches (endpoint
path, some string→number/boolean field types, a couple of missing required
fields) that would otherwise have caused every booking to be rejected even
once connectivity works.

1. **Confirm your login.** Already done — `INDIAPOST_USERNAME` /
   `INDIAPOST_PASSWORD` should be your sandbox Customer ID `9999297656` and
   its password, straight from you to Render, same rule as the Shopify
   secret — I never see these.
2. **The real blocker: IP whitelisting (see step 4a below).** Every sandbox
   API call has been failing with "fetch failed" from every environment
   tested (my sandbox, my browser, this Render server) — turns out this
   isn't a bug, it's expected. The portal's "Whitelist my IP Address" page
   confirms: *"UAT environment IP addresses are required for sandbox
   testing"*, and right now **0 IPs are whitelisted** on your account.
   Nothing will connect until this is fixed — see step 4a.
3. **One-time lookup:** once connectivity works, call
   `GET /api/indiapost/pincode/<your pickup PIN>` (with your `x-api-key`
   header) — it returns nearby post offices. Find the one you actually drop
   parcels at, where `delivery_office_flag` is true, and put its `office_id`
   into Render as `INDIAPOST_DROPOFF_OFFICE_ID`. Booking will refuse to run
   without this.
4. Fill in your sender details (`INDIAPOST_SENDER_NAME/ADDRESS/CITY/STATE/
   PINCODE/MOBILE`) — these print on every label.

### 4a. Fix the IP whitelisting block (done - DigitalOcean static-IP proxy)

India Post's whitelist form only accepts **individual IPv4 addresses** — no
IP ranges. Render's free tier doesn't give this server one fixed address; it
shares a pool of ~500 addresses, so there's no single IP I could hand India
Post that would reliably match every request.

**What's actually running now:** a small $4/mo DigitalOcean droplet
(`airx-indiapost-proxy-8`, Bangalore region) running `tinyproxy`, with a
fixed public IP: **64.227.141.75**. This server's India Post calls are
routed through it via the `INDIAPOST_PROXY_URL` env var in Render
(`http://airxproxy:<password>@64.227.141.75:8888`) - already set. The proxy
itself is confirmed working: the CONNECT tunnel to India Post's server opens
successfully and tinyproxy is live (verified via `/api/diag/indiapost-proxy`
and `/api/diag/proxy-connect-test`, two small diagnostic endpoints added to
this server specifically for this - see below).

**What's still needed - one click on India Post's side:** their sandbox
still rejects the TLS handshake itself (not a "fetch failed", a clean
connection reset during the handshake), which matches exactly what you'd
expect from a server that resets connections from any IP that isn't on its
allowlist yet. **64.227.141.75 needs to be submitted on
`/customer-selfservice/whitelist-ip-address`** (UAT Environment field) -
once India Post approves it, bookings should start working immediately with
no further code changes.

Two small diagnostic endpoints exist on this server for verifying the proxy
chain without ever touching the real `AIRX_API_KEY` - both guarded by a
separate, non-secret header (`x-diag-key: airx-diag-check-2026`):
- `GET /api/diag/indiapost-proxy` - TCP-probes the proxy droplet's ports and
  (unless you pass `?host=`) attempts a real India Post login through it.
- `GET /api/diag/proxy-connect-test` - opens a raw CONNECT tunnel through
  the proxy and reports tinyproxy's exact response line, useful if this
  ever breaks again and you need to tell "proxy problem" apart from
  "India Post problem" quickly.

If DigitalOcean ever needs to be replaced (e.g. this proxy droplet gets
rebuilt), the working startup script is `proxy-cloud-init.yaml` in this
repo - it's a **plain `#!/bin/bash` script**, not a `#cloud-init` YAML
cloud-config. On this DigitalOcean account, the multi-section cloud-config
format (`packages:` / `write_files:` / `runcmd:`) reliably failed to execute
at all, while a flat shell script worked in under 30 seconds - so stick with
the flat-script format for any future droplet here.

5. Leave `INDIAPOST_BULK_CUSTOMER_ID`, `INDIAPOST_CONTRACT_ID`, and the
   barcode range vars blank to use the shared sandbox test values for now;
   India Post will give you your own once your account is confirmed — swap
   them in later without any code changes.
6. That's it. From then on:
   - `POST /api/indiapost/book` — books one parcel, returns a real tracking
     barcode (generated via India Post's own S10 checksum algorithm).
   - `POST /api/indiapost/track` — bulk tracking status for up to 500
     barcodes at once.
   - `POST /webhook/indiapost/event` — if India Post whitelists this
     server's IP for real-time push events, delivery scans update orders
     automatically (marks "delivered" the moment India Post scans it).
   - In AIRX Ops, dragging an order to "Booked" now calls this automatically
     — if it's a Shopify order, the resulting barcode is also sent straight
     to Shopify as the tracking number, so the customer gets their shipping
     email with zero manual steps. If India Post isn't configured yet (e.g.
     credentials still pending), it falls back to the old manual-tracking
     prompt so nothing breaks in the meantime.

## 5. Inventory — stock tracking, auto-decrements on booking

`GET/POST/PATCH/DELETE /api/inventory` (all need your `x-api-key` header).
Add each product once (name should match how it appears on orders, e.g.
"Pranvaayu churan 440g") with a starting stock count and a low-stock line.
Every time an order is booked with India Post, stock quietly goes down by
the quantity in that order — you'll see it live in the new **Inventory** tab
in AIRX Ops, with anything below its low-stock line flagged in red.

## 6. Staff performance

The **Staff** tab in AIRX Ops now ranks your team by total sales handled
(not just order count), with pending/booked/delivered breakdowns per
person — same data as before, just now sorted so the top performer is
obvious at a glance. No setup needed, it reads straight from the orders
already in the board.

## 7. WhatsApp automation (COD confirmation, tracking, follow-ups) — ready to activate

The backend has three endpoints ready to go the moment you connect a
WhatsApp Business Account:

- `POST /api/whatsapp/confirm-cod` — ask the customer to confirm before you
  book with India Post (cuts down fake/wrong COD orders and RTO losses).
- `POST /api/whatsapp/tracking-update` — send the India Post barcode the
  moment an order is booked.
- `POST /api/whatsapp/delivery-followup` — nudge for a review or reorder
  once delivered.

**To turn this on:** same Meta Business Manager login as the Lead Ads setup
above. Open **business.facebook.com** → WhatsApp → set up (or link) a
WhatsApp Business number → API Setup tab gives you a **Phone number ID**
and lets you generate a permanent **access token**. Put those in Render as
`WHATSAPP_PHONE_ID` and `WHATSAPP_TOKEN`. Then, in the same WhatsApp
Manager, create and submit for approval three message templates named
exactly `cod_confirmation`, `tracking_update`, and `delivery_followup`
(Meta typically approves simple templates within a few hours). Until both
the env vars and templates exist, these endpoints just log quietly and skip
sending — nothing breaks by leaving them unconfigured for now.

## 8. Next step (already planned)

Once WhatsApp is connected, the plan is: an AI agent that answers a lead's
product questions automatically over WhatsApp the moment they come in
(before/alongside a staff follow-up), and sends them their own booking
link once they're ready to buy. AI voice calling is a later phase — it
needs a telephony provider and costs per minute, so it's worth proving out
the WhatsApp flow first.

## 9. MLM integration (replacing store.airxplus.com + admin.airxplus.com)

Full plan and phase breakdown: see `MLM_INTEGRATION_PLAN.md` in this repo.
Short version: those two legacy sites are being folded into AIRX Ops —
`store.airxplus.com` is the (currently empty) product/franchise ERP,
`admin.airxplus.com` is the live MLM distributor/commission engine
(members, downline, PV/BV, weekly payout, TDS, rewards). Both get rebuilt
here, phase by phase, so they can eventually be retired.

**Phase 0 — database (done).** Added `db.js`, backed by Node's built-in
`node:sqlite` module (no `better-sqlite3`/native compile needed — just
plain Node 22.5+). The database file lives at `data/airx.db`, next to the
existing `leads.json`/`orders.json`, so it gets whatever disk persistence
Render already gives that folder. **Important:** this repo now requires
**Node ≥ 22.5** (`package.json` "engines" + `.node-version` pin it, and
`.npmrc` has `engine-strict=true` so the Render build fails loudly instead
of crashing at runtime if the wrong Node version is selected). If the
Render service's Node version setting is older, update it in the Render
dashboard (Settings → Environment → Node Version, or set a `NODE_VERSION`
env var) before this deploy will boot.

**Phase 1 — Product & Franchise Master (done).** Mirrors
store.airxplus.com's Master/Product and Franchise sections. All endpoints
need the `x-api-key` header like the rest of the API:

- `GET/POST /api/products`, `GET/PATCH/DELETE /api/products/:sku` — product
  catalog (sku, name, category, dp_price, mrp_price, pv, bv, status). Note:
  this is separate from the existing `/api/inventory` JSON store, which
  only tracks sellable stock for the India Post auto-decrement — `products`
  is the fuller catalog (pricing tiers, PV/BV point values for the
  compensation engine later).
- `GET/POST /api/franchises`, `GET/PATCH/DELETE /api/franchises/:code`,
  `GET /api/franchises/:code/children` — franchise master with
  parent-child hierarchy (`parent_franchise_code`).
- `GET/POST /api/franchise-stock`, `PATCH /api/franchise-stock/:code/:sku`
  — per-franchise warehouse stock (PATCH takes `{ "delta": ±N }` to
  add/remove stock rather than needing the caller to know the current
  quantity).

**Phase 2 — Distributor / Member Master (done).** Mirrors admin.airxplus.com's
Member section:

- `GET/POST /api/members`, `GET/PATCH/DELETE /api/members/:code` — member
  profile (sponsor_code, placement_leg, mobile, email, PAN, bank details,
  kyc_status, status). `GET /api/members?status=Active` and
  `?sponsor_code=X` filter the list. `member_code` in the POST body is
  optional — leave it out and the server auto-generates one in
  admin.airxplus.com's own structure, `AIRX` + 6 digits (e.g.
  `AIRX849817`), the same format seen live on that system's
  membersearch.aspx. No extra validation is applied beyond DB
  uniqueness, per the business owner's instruction to just reuse that
  same ID structure as-is.
- `GET /api/members/:code/downline` — direct (one-level) downline, mirrors
  "Downline Members".
- `GET /api/members/:code/tree` — full recursive downline tree, mirrors
  "Leg Structure" / "Distributor Tree" (depth-capped at 50 and cycle-safe,
  so bad sponsor data can't cause an infinite loop).
- `POST /api/members/:code/block` / `.../unblock` — mirrors "Block Id" /
  "Unblock Id" / "Manual Active".

**Phase 4 — Rewards & Reporting (done).** Mirrors admin.airxplus.com's
Reward and Reports sections:

- `GET/POST /api/rewards`, `PATCH/DELETE /api/rewards/:id` — reward master
  (name, PV criteria, reward value, session label), mirrors "Reward
  Master"/"Reward Session".
- `GET/POST/DELETE /api/reward-achievers` (filter with `?member_code=` or
  `?reward_id=`) — who's earned what, mirrors "Reward Details".
- `GET /api/reports/member-balance/:code` — nets wallet_transactions into
  a credit/debit/balance, mirrors "Member Balance".
- `GET /api/reports/downline-pv/:code` — this member's PV/BV plus every
  downline member's, mirrors "Downline PV Detail" (same cycle-safe walk as
  the Phase 2 tree endpoint).
- `GET /api/reports/rank-achievers` — every reward achieved, most recent
  first, mirrors "Rank Achivers List".

**Note:** `/api/reports/member-balance` and `/api/reports/downline-pv`
aggregate whatever rows exist in `pv_ledger` / `wallet_transactions` —
those tables start filling in once Phase 3 (below) commits payout runs.

**Phase 3 — PV/BV + weekly matching payout + TDS engine (done, admin-configurable).**

admin.airxplus.com does not store its real compensation-plan formula
anywhere reachable in its own UI — Reward Master and Manual Rank are
both empty, TDS Report shows zero records for any date range, and
PayoutAnaysisReport only shows an observed historical ratio, not a
configured rule. The developer who originally built that system wanted
extra payment to hand over the real spec. Rather than stay blocked on
that, the business owner (2026-08-23) asked for an **admin-configurable**
commission engine instead: build the calculation with whatever numbers
are actually confirmed, expose every other number as something the
owner can tune from the API with no code change, and surface
incoming-vs-outgoing so the owner can see whether payouts are
sustainable against sales.

What's confirmed vs provisional (see `commission_settings` table /
`GET /api/settings/commission` for the live values and labels):

| setting | value | source |
|---|---|---|
| `pair_value_pv` | 500 | **Confirmed** — admin.airxplus.com KitMaster.aspx, "ACTIVE" package |
| `admin_charge_percent` | 5 | **Confirmed** — admin.airxplus.com dashboard Income Summary |
| `payout_per_pair_amount` | 500 | Provisional — defaulted equal to `pair_value_pv`; edit via `PUT /api/settings/commission` the moment the real ₹-per-pair figure is known |
| `tds_percent` | 5 | Provisional — confirm the correct statutory rate for direct-selling commission with a CA/accountant |
| `max_pairs_per_period` | 0 (unlimited) | Provisional — a per-run pair cap, if the business wants one |

How it works (binary plan, Left/Right matching — confirmed structurally
from admin.airxplus.com's ManualPowerBinery.aspx and weeklypointcf.aspx
field labels): each run totals PV purchased across a member's whole
Left subtree and whole Right subtree (via `members.placement_leg`),
adds carry-forward from previous runs (`pv_balance`), matches pairs =
`floor(min(left, right) / pair_value_pv)`, pays `payout_per_pair_amount`
per pair minus `admin_charge_percent` and `tds_percent`, and carries the
PV remainder forward — mirroring the "BF / New / Total / Paid / CF"
columns on admin.airxplus.com's weeklypointcf.aspx.

Endpoints:

- `GET/PUT /api/settings/commission` — the admin screen for the plan
  itself. `PUT` takes any subset of numeric settings, e.g.
  `{"payout_per_pair_amount": 75, "tds_percent": 5}`.
- `GET /api/payouts/preview?period=WEEK-35` — **read-only**, computes
  what a run would pay without writing anything. Always call this
  before committing.
- `POST /api/payouts/commit` with `{"period_label": "WEEK-35"}` — real
  money: writes `payouts` + `wallet_transactions` rows, updates
  `pv_balance` carry-forward, marks the consumed `pv_ledger` rows so the
  next run never double-counts them. A `period_label` can only be
  committed once.
- `GET /api/payouts/runs` — history of committed runs.
- `GET /api/reports/payout-health` — **the incoming-vs-outgoing check the
  owner asked for**: total BV brought in vs total net commission paid
  out, and the payout ratio (%) across all committed runs, so it's easy
  to see if the plan is paying out more than the business is taking in.

A functional test of the matching math (`test_phase3.js`, run with
`node test_phase3.js`) verifies the Left/Right subtree totals, matched
pairs, gross/admin-charge/TDS/net split, and carry-forward math against
a small hand-checked binary tree.

**Phase 5 (cutover)** — after Phase 3 is validated in production, see the plan doc.

## Phase 6 — the remaining admin.airxplus.com menus (2026-08-24)

After the Phase 5 cutover (2,437 members re-migrated, parity confirmed:
Total=2437, Active=75), the owner asked for every remaining feature to be
added. This phase covers what was still missing against the full
admin.airxplus.com menu list in `MLM_INTEGRATION_PLAN.md`:

**Master** — `GET/POST/PATCH/DELETE /api/masters/banks`,
`/api/masters/states`, `/api/masters/packages` (join-kit master: name,
pair-value PV, price — separate from the single `pair_value_pv` the
commission engine actually matches with, so different kit prices can be
tracked even though matching still uses one plan-wide PV figure).

**Member** — `GET/POST /api/members/:code/kyc-documents` +
`PATCH /api/kyc-documents/:id` (approve/reject; a member's own
`kyc_status` auto-bumps to Approved once every document on file is
Approved). `POST /api/members/:code/manual-active`,
`POST /api/members/:code/reset-status`,
`POST /api/members/:code/change-user` (re-assign an ID to a different
person's identity — every prior value is written to
`GET /api/members/:code/audit-log` so nothing is silently overwritten).

**Payout** — `GET /api/reports/daily-points`,
`GET /api/reports/daily-payouts` — the existing weekly-run data sliced
by the calendar day it was recorded (payouts still run weekly, not as
separate daily jobs, so "daily" here means "this week's activity by
day", same numbers as the Weekly MIS Report / payout-health report).

**Accounts** — `GET/POST /api/fund-requests` +
`PATCH /api/fund-requests/:id` (approve posts an immediate wallet debit;
this same data answers Reports > "View Fund Request" too),
`GET /api/reports/payout-transfer-weekly?period=...`,
`GET /api/reports/topup-detail` (pv_ledger rows with
`entry_type = 'topup'`), `GET /api/reports/tds` (TDS withheld per
committed period).

**Utility** — `GET /api/wallet/:code`, `GET /api/wallet/transactions`,
`POST /api/wallet/credit`, `POST /api/wallet/debit` — direct API for the
`wallet_transactions` table, which existed since Phase 3 (the weekly
payout engine writes to it) but had no manual-adjustment or ledger-view
endpoints of its own until now.

**Reward** — `GET/POST/PATCH/DELETE /api/reward-sessions` (the Master
behind the `session_label` field `rewards` already had).

All of the above also got matching UI in `public/admin.html`: a new
**Masters** tab (Bank/State/Package), a new **Accounts & Wallet** tab
(Fund Requests, wallet credit/debit + lookup, Payout Transfer Weekly),
a new **Reports** tab (TDS, Topup Detail, Daily Point/Payout Detail,
Downline PV / Member Balance lookup), and the member detail panel grew
an "Admin actions" block (Manual Active / Reset Status / Change User)
and a KYC Documents section.

A functional test (`test_phase6.js`, run with `node test_phase6.js`)
exercises every new table and the exact SQL each route uses — masters
CRUD + uniqueness, KYC approve bumping `kyc_status`, the three
member-state actions plus their audit trail, wallet credit/debit
balance math, fund-request approve posting a debit, and the delete-guard
below. Every new endpoint was also re-verified live against the
deployed Render API after each push (not just locally), the same way
the Phase 5 migration was.

**Bug found and fixed in the same pass:** `DELETE /api/members/:code`
pre-dates Phase 6 but had never been exercised against a member with
real financial/child records. With `PRAGMA foreign_keys = ON`, deleting
a member that has ever had a payout, wallet transaction, fund request,
reward achievement, PV ledger entry, or downline pointing at them as
sponsor used to throw a raw, unhandled foreign-key error (500). It now
returns a clear `409` telling the caller to use Block instead (which
already existed) to preserve that history, and only actually deletes —
cascading the safe metadata (KYC docs, audit log, empty PV balance row)
— when a member is genuinely "clean" (no money history, no downline).

**Deliberately not built** (flagged, not silently skipped): store.airxplus.com's
own Admin/User/UserGroup/Permissions screens. This is a full multi-role
login system — a separate, security-sensitive project on top of the
current single-shared-`AIRX_API_KEY` model, not something to bolt on
casually — so it's still waiting on an explicit go-ahead.

## Phase 7 — CMS content menus (2026-08-24)

admin.airxplus.com's remaining public-facing content menus — **News**,
**Meeting**, **Gallery**, **Video**, **Media/Presentations**,
**Training**, **Testimonial**, **Slider** — are all structurally the
same thing: a list of entries with a title, some text, an optional
image/link, a date, a display order and a status. Rather than eight
near-identical tables and route sets, they share one table,
`cms_content` (`content_type` column selects which menu a row belongs
to), and one generic route family:

`GET/POST /api/cms/:type`, `PATCH/DELETE /api/cms/:type/:id` — `:type`
is one of `news`, `meeting`, `gallery`, `video`, `media`, `training`,
`testimonial`, `slider` (validated, `400` on anything else). Fields:
`title` (required), `description`, `image_url`, `link_url`,
`event_date`, `display_order`, `status`.

There's no file-upload infrastructure in this app — KYC documents
(Phase 6) are metadata-only too (`doc_type`/`doc_number`, no binary
storage) — so `image_url`/`link_url` are pasted URLs (an already-hosted
image or video link) rather than uploaded files, consistent with that
existing pattern.

`public/admin.html` got a new **Content (CMS)** tab with one panel per
menu, each with an add-form (title/order/date/description/image/link)
and a table with Activate/Deactivate and Delete actions per row — one
shared renderer parameterized by content type rather than eight copies
of the same panel.

A functional test (`test_phase7.js`, run with `node test_phase7.js`)
exercises the exact SQL the routes use: an insert per content type,
type-scoped listing + ordering, patch/update, and that delete is scoped
to `(id, content_type)` together (a delete call for the right id but
wrong type is correctly a no-op). All 15 assertions pass, and every
endpoint was also re-verified live against the deployed Render API
after push.

## Phase 8 — multi-user admin auth: Admin / User / UserGroup / Permissions (2026-08-24)

store.airxplus.com's / admin.airxplus.com's own Admin, User, UserGroup and
Permissions screens — the one category explicitly deferred at the end of
Phase 6 as "a separate, security-sensitive project on top of the current
single-shared-`AIRX_API_KEY` model." Built additively: the master
`AIRX_API_KEY` still works exactly as it always has, unchanged, for
anything already using it (this app's own "API Key" login option included)
— nothing that worked before this phase stopped working. What's new is an
*alternative* credential: individual staff logins with real
username/password authentication, session tokens, and per-role
module-level permissions actually enforced by the server, not just hidden
in the UI.

**Schema** (`db.js`): `admin_roles` (a role/UserGroup — `role_name` +
`permissions`, a JSON array of module keys, or `["*"]` for every module —
Super Admin), `admin_users` (username, `password_hash`/`password_salt` via
Node's built-in `crypto.scryptSync` — no bcrypt dependency needed, since
`npm install` is blocked in this sandbox and Render's build environment is
the only place new dependencies would actually get installed and tested),
`admin_sessions` (a random 32-byte token per login, 7-day expiry).

**Auth endpoints** (all public — that's the point): `GET
/api/auth/bootstrap-status` (does any admin user exist yet?), `POST
/api/auth/bootstrap` (creates the first Super Admin — self-disables with a
`409` the moment one admin user exists, so it can only ever run once),
`POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`.

**User/Role management** (`GET/POST/PATCH/DELETE /api/admin/roles`,
`GET/POST/PATCH/DELETE /api/admin/users`, `POST
/api/admin/users/:id/reset-password` — the last one wipes all of that
user's sessions, forcing re-login everywhere) — all gated by the new
`requireAccess("user_management")` middleware, which accepts either the
master `x-api-key` (unrestricted, same as always) or a `Bearer` session
token whose role includes `"user_management"` or `"*"`. Guards: a role
still assigned to a user can't be deleted (`409`, reassign first, same
pattern as the Phase 6 member delete-guard), and the last remaining admin
user can't be deleted (`409` — prevents ever locking the new login system
out entirely, though the master API key would still work regardless).

**Wiring `requireAccess` into the existing ~80 feature routes.** A
session token is useless if it can only reach the two new auth/admin
route groups — a staff login needs to actually be able to use
Members/Masters/Payouts/etc. So every existing route that
`public/admin.html` calls got its `requireApiKey` swapped for
`requireAccess("<module>")`, where `<module>` matches whichever
admin.html tab actually calls that endpoint (verified by grepping every
`api('...')` call inside each tab's `loadX()` function, not guessed):
`products`, `franchises`, `members` (including KYC documents, manual
active/reset/change-user, audit log), `dashboard` (the two summary
endpoints `loadDashboard()` calls), `commission`, `payouts`, `rewards`
(including reward-achievers and rank-achievers, unused by the UI today
but conceptually the same menu group), `reports`, `masters`, `accounts`
(fund requests + wallet), `cms`. Deliberately **left untouched** — still
master-key-only, `requireApiKey` unchanged — are the endpoints
`public/admin.html` never calls at all: `/api/shopify/*`,
`/api/indiapost/*`, `/api/leads*`, `/api/orders*`, `/api/inventory*`,
`/api/staff/summary`, `/api/whatsapp/*`, `/api/franchise-stock*`. Those
predate the MLM admin panel entirely (Phase 0's lead/e-commerce ops) and
are out of scope for "admin.airxplus.com's own user system" — no reason
to touch them.

`requireAccess(moduleKey)` (`server.js`): checks `x-api-key` first (master
bypass, identical behavior to the old `requireApiKey` — this is the
invariant the whole migration leans on for safety), then falls back to
`Authorization: Bearer <token>` — looks up the session, checks it hasn't
expired, checks the user is `Active`, checks the role's permissions
include the module or `"*"`. `401` for no/invalid credentials, `403` for
"valid login, wrong permissions."

**`public/admin.html`** gained: a login screen with three modes (API Key
— unchanged default; "staff user" username/password; and a first-run
"create the first Super Admin" form that auto-shows when
`bootstrap-status` reports no admin users exist yet — an existing
browser with a saved API key never sees it, since that check only runs
when there's no stored credential at all) — plus a new **User
Management** tab with a Roles & Permissions panel (add a role, tick
which modules it grants, or check "All permissions" for Super Admin) and
an Admin Users panel (add a user, assign a role, Activate/Deactivate,
Reset Password, Delete). `renderNav()` now filters which tabs even
render based on the signed-in identity's permissions — a staff user
without `"masters"` never sees a Masters tab to begin with, and even if
they hit the API directly they'd get a `403` from the server, not just a
hidden button.

A functional test (`test_phase8.js`) exercises the password hashing
(`scryptSync` correct/wrong/near-miss), session issue/lookup/expiry, the
permission-check logic (`"*"` vs a specific module list), and both delete
guards, directly against `db.js` + Node's `crypto` — 18 assertions, all
passing. The `requireAccess` wiring itself (Express middleware) can only
be verified live, the same constraint as every other phase in this
sandbox (`npm install` is blocked here — Render's build is the only place
`express` actually installs) — verified against the deployed Render API
after push: the master key still reaches every route exactly as before
(regression check), a fresh staff login with a limited role gets `200` on
its granted modules and `403` on everything else, and an expired/garbage
token gets `401`.

**Deliberately not built in this pass:** two-factor auth, password
complexity rules beyond an 8-character minimum, and an audit trail of
*who* (which admin user) performed each Members/Masters/etc. action —
`member_audit_log` (Phase 6) still just records whatever free-text note
the caller supplies, it doesn't yet look up `req.identity.user.username`
automatically. That's a natural small follow-up once staff accounts are
actually in daily use, not assumed here.

## Phase 9 — store.airxplus.com's own features (2026-08-25)

store.airxplus.com is a *separate* legacy system from admin.airxplus.com
— a Product/Franchise/Warehouse ERP, not the distributor compensation
engine (see `MLM_INTEGRATION_PLAN.md` lines 10-21). It was 0
products/0 franchises when we reviewed it directly, so unlike the Phase 5
member migration there's no historical data to reconcile against here —
this phase is pure feature-parity build-out. Its confirmed menu
structure: **Master/Product** (Product Report, categories: General/Mens/
Women/Special Wellness), **Franchise** (franchise details, Warehouse),
**Commission** (franchise bank details, payout detail, pending payment,
payout transfer detail), **Admin/User** (user creation, groups,
permissions — already covered by Phase 8's unified auth system, built
generically rather than duplicated per legacy system), **Dashboard/Logout**
(already covered by the existing Dashboard tab + Disconnect button).

**What already existed vs. what Phase 9 added.** A repo audit found the
Product and Franchise *backend* (tables + full CRUD API) already existed
from early phases — `products.category` and `franchises.parent_franchise_code`
were already there — but `public/admin.html` only exposed an add-only
form for each with no category field, no edit/delete, and none of the
franchise contact/address/hierarchy fields visible. `franchise_stock`
(the Warehouse) had a complete backend (`GET/POST/PATCH /api/franchise-stock`)
but **zero UI** — never wired into admin.html at all. Franchise-level
Commission (bank details, payout tracking) didn't exist anywhere —
confirmed via grep, zero matches for franchise+commission/payout/bank in
both server.js and db.js.

**Schema** (`db.js`): `franchises` gained four columns via the same
`PRAGMA table_info` + `ALTER TABLE` migration pattern used for `members`
in earlier phases (`bank_name`, `bank_account_number`, `bank_ifsc`,
`bank_account_holder` — kept on the franchises table itself rather than
a separate table, since it's a simple 1:1 relation, same reasoning as
the member bank fields). New table `franchise_payouts` (franchise_code,
period_label, amount, status Pending/Paid, transfer_ref, note,
created_at, paid_at) — franchise-level payout tracking, entirely
separate from the member-level `payouts`/`commission_settings` tables
built in Phase 3.

**Routes**: `franchise-stock`'s three routes were switched from the bare
`requireApiKey` to `requireAccess("franchises")` (they'd been left on
the master-key-only check since Phase 1, before the Phase 8 permission
system existed — now consistent with the rest of the Franchises module),
plus a new `DELETE /api/franchise-stock/:franchise_code/:sku` for
cleanup. `POST`/`PATCH /api/franchises` extended to accept the four bank
fields, plus a new guard rejecting a franchise naming itself as its own
parent. New module key `franchise_commission` (added to `MODULE_KEYS` in
both server.js and admin.html) gates `GET/POST /api/franchise-payouts`,
`PATCH /api/franchise-payouts/:id` (mark Paid + transfer_ref; blocks
re-processing an already-Paid row, same pattern as fund-requests), and
`GET /api/reports/franchise-payout-transfer?period=` (the dedicated
"Payout Transfer Detail" report — "Pending Payment" and "Payout Detail"
are both served by the same `GET /api/franchise-payouts` with an
optional `?status=` filter, rather than three overlapping endpoints).

**Bug found and fixed proactively, before it shipped:** `DELETE
/api/franchises/:code` had the exact same latent flaw the Phase 6 member
delete-guard fixed — with `PRAGMA foreign_keys = ON`, deleting a
franchise that anything else pointed at (a child franchise, warehouse
stock, payout history) would throw a raw, unhandled foreign-key error
(500) the first time anyone actually tried it. Caught by code review
while adding `franchise_payouts`' and `franchise_stock`'s FKs onto
`franchises`, not by a live failure this time — fixed with the same
guard-and-explain `409` pattern, and covered in `test_phase9.js` (a raw
delete against a franchise with a child franchise, and separately one
with warehouse stock, both correctly throw; a clean franchise still
deletes fine).

**`public/admin.html`**: Products tab gained a category dropdown (the
exact four store.airxplus.com categories), a full products table with
Edit (populates the form, "Save changes" instead of "+ Add") and Delete.
Franchises tab gained parent-franchise selection, contact/address
fields, the bank-details fields, Edit/Delete, and a new **Warehouse /
Stock** panel (set stock, delta-adjust, per-row delete) — all backed by
the exact franchise-stock endpoints that already existed with no UI. New
**Franchise Commission** tab: a status-filtered payout table (Pending by
default — this is the Pending Payment view), a new-payout-entry form, a
Mark Paid action per pending row, and a period-lookup Payout Transfer
Detail panel — deliberately mirroring the Accounts tab's Fund
Requests / Payout Transfer Weekly panels (same interaction pattern, just
franchise-scoped instead of member-scoped) rather than inventing a new one.

A functional test (`test_phase9.js`, 19 assertions) exercises the exact
SQL each route uses: product category storage/update, franchise bank
details + hierarchy (parent/children query), the self-parent guard, the
new franchise delete-guard (raw delete against a franchise with a child,
and separately one with stock, both correctly throw an FK error; a
clean one deletes fine), stock set/delta-adjust and the negative-quantity
guard, and the full franchise-payout lifecycle (create Pending → filter
by status → mark Paid with a transfer ref → payout-transfer-detail
report joins the franchise name correctly). All existing test suites
(`test_phase3/6/7/8.js`, `test_migration.js`) were re-run after every
change in this phase — zero regressions. Every new/changed endpoint was
also re-verified live against the deployed Render API after push,
including confirming the master `x-api-key` still reaches every
newly-rewired `franchise-stock` route exactly as before.

## Phase 10 — surface Shopify, Orders, Leads, Inventory, Staff in admin.html (2026-08-25)

This phase didn't add new backend capability so much as switch on and
finish exposing capability that was already fully coded from an earlier
AIRX Ops build (Shopify OAuth sync/fulfillment, Meta Lead Ads capture,
India Post booking/tracking, D2C inventory with auto-decrement, staff
performance summary, WhatsApp Cloud API automation) but had zero
representation in this admin.html dashboard — the one actually in use.
An audit of server.js turned up ~18 routes that were fully built and
tested in an earlier session but simply never wired into any UI.

**Shopify — went from "coded, never connected" to live.** `SHOPIFY_API_KEY`
/ `SHOPIFY_API_SECRET` / `SHOPIFY_SHOP` were already set in Render's
environment, but the OAuth install handshake (`/shopify/install` →
Shopify → `/shopify/callback`) had never actually been completed, so
`shopifyFetch()` always failed with "Shopify not connected yet." Since
the browser already had an authorized Shopify admin session, visiting
`/shopify/install` completed the handshake with no password entry
involved — verified live by syncing all 14 existing Shopify orders into
AIRX Ops on the first pull.

**Bug found and fixed: JSON-file storage wasn't on the persistent disk.**
A post-deploy smoke test showed the 14 just-synced orders — and the
Shopify connection itself — had vanished after the very next push. Root
cause: `LEADS_FILE` / `ORDERS_FILE` / `SHOP_FILE` / `INDIAPOST_FILE` /
`INVENTORY_FILE` / `PROXY_STATUS_FILE` all resolved to `__dirname/data`
(the container's own throwaway filesystem) instead of `DATA_DIR` (the
Render Persistent Disk mount), unlike `db.js`'s SQLite database which
was already correctly wired to `DATA_DIR`. Every deploy — including
routine future ones — was silently wiping D2C orders, leads, inventory,
and forcing a Shopify reconnect. Fixed by pointing all six at the same
`DATA_DIR` `db.js` already uses; reconnected Shopify once more afterward
and confirmed the data survived a further live regression pass.

**Auth:** the 18 routes above moved from the old blanket `requireApiKey`
to `requireAccess(moduleKey)`, adding four new module keys — `orders`,
`leads`, `inventory`, `staff` — to the same permission system built in
Phase 8. The master `x-api-key` still works everywhere unchanged; staff
logins can now be scoped to just Orders, or just Inventory, etc.

**Automatic Shopify sync:** a `setInterval` loop (every 5 minutes, no
new dependency) calls the same `syncShopifyOrders()` function the manual
button uses, so new Shopify orders land in AIRX Ops without anyone
clicking anything. It no-ops quietly if Shopify isn't connected yet,
so a fresh deploy before reconnecting doesn't spam error logs.

**admin.html — four new tabs:**
- **Orders** — one list for both Shopify and WhatsApp-sourced orders,
  a manual "Sync from Shopify" button, search/status/source filters, a
  manual-order-entry form, per-order "Book (India Post)" (assigns a real
  Speed Post barcode and auto-decrements inventory), "Mark delivered,"
  and three WhatsApp trigger buttons (COD confirm, tracking update,
  delivery follow-up/reorder nudge) that call the existing
  `sendWhatsApp()` scaffolding.
- **Leads** — Meta/Facebook Lead Ads captured automatically via
  `/webhook/meta`, with a status dropdown (new → contacted → converted
  → lost) per row.
- **D2C Inventory** — separate from the MLM franchise-warehouse stock
  table; this is the storefront's own SKU stock, with low-stock rows
  highlighted and auto-decrement on order booking.
- **Staff Performance** — per-staff orders/sales/delivered/pending,
  read straight from the Orders data so no one has to compile it by hand.

**The one still-open gap:** WhatsApp automation (COD confirmation,
tracking updates, delivery follow-up/reorder nudges — the single
highest-leverage lever for an Ayurvedic D2C repeat-purchase business)
is fully coded but inert — `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_ID` aren't
set, so `sendWhatsApp()` currently just logs and returns `{skipped:true}`
(verified live — it does this cleanly, no crash). Turning it on needs a
WhatsApp Business Account created in Meta Business Manager and three
message templates (`cod_confirmation`, `tracking_update`,
`delivery_followup`) approved by Meta — an account-ownership step tied
to the business's identity, not something that can be done by password
or API key alone.

Live-verified after push: 20/20 checks on the first pass (all master-key
regression + new-route + auth-boundary checks), then a further 10/10
after the `DATA_DIR` fix and Shopify reconnect, including confirming the
synced Shopify orders survived the fix being deployed.

## Phase 11 — public order-tracking page, no login (2026-08-25)

**Why:** the single biggest source of avoidable staff load in a COD-first
D2C business is "where is my order" messages. This closes that loop
without adding any headcount.

- **`GET /api/public/track?mobile=`** — a new route deliberately placed
  *outside* `requireAccess`/`requireApiKey`, since customers have no
  login and shouldn't need one. Normalizes the `mobile` query param to
  its last 10 digits, 400s on anything else, and looks up orders by
  exact mobile match from the same `ORDERS_FILE` the admin Orders tab
  uses. Returns up to 5 matches with a deliberately minimal field set
  (`createdAt`, `product`, `status`, `codAmount`, `trackingBarcode`,
  `latestEvent`) — no name, address, or the mobile number itself, so a
  guessed number can't harvest anything beyond order status.
- **Threat model, stated plainly:** looking someone's order up by their
  own mobile number (the same number the courier already has) is a
  proportionate trade for a small COD-grocery-sized D2C business — not
  the right trade for anything carrying financial or medical data. A
  full login system was rejected on purpose: it would push customers
  back to messaging staff on WhatsApp, defeating the entire point of a
  self-serve tracking page.
- **Rate limiting:** a hand-rolled in-memory per-IP limiter (15 lookups
  per 10-minute window, no new npm dependency — `express-rate-limit`
  isn't installable in this environment) caps enumeration attempts.
  **Bug found and fixed during live verification:** the limiter was
  first keyed on the raw `x-forwarded-for` header string, but Render's
  edge can vary the proxy hop chain in that header per request even for
  the same client, so the limiter's Map key never matched twice and it
  silently never tripped (confirmed live: 17 rapid requests, zero
  429s). Fixed by keying on just the first (client) IP in the chain;
  re-verified live — now trips reliably (confirmed at request #16, i.e.
  immediately after the 15th allowed lookup).
- **`public/track.html`** — new customer-facing page (mobile-number
  input, one button, no login) styled to match the AIRX PLUS brand,
  automatically served at `/track.html` via the existing
  `express.static("public")` mount (no new static-serving code needed).
  Renders each order's product, status (color-coded badge), COD amount,
  India Post tracking barcode, and latest tracking event.

Live-verified after push: real order lookup by mobile returns the
correct order with no PII beyond what's listed above, invalid/missing
mobile returns 400, a valid-but-unmatched mobile returns an empty list
(not a 404 — avoids confirming/denying whether a number has ever
ordered), and the rate limiter trips at the correct threshold.

**Next candidates (not yet started), largely growth-focused per the
founder's Ayurvedic D2C directive:** WhatsApp automation activation
(blocked on Meta Business Manager setup, not code), a low-stock banner
on the admin Dashboard surfacing the D2C Inventory data already being
tracked, repeat-purchase/replenishment WhatsApp nudges timed to typical
Ayurvedic-formulation consumption cycles, abandoned-cart recovery for
Shopify checkouts, batch/expiry tracking for formulations, and a
retail-customer-to-distributor referral bridge tying the D2C storefront
into the existing MLM structure.
