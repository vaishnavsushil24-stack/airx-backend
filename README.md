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
  `?sponsor_code=X` filter the list.
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

**Important caveat:** these reports aggregate whatever rows already exist
in `pv_ledger` / `wallet_transactions` — nothing writes to those tables
yet, because that's Phase 3 (see below), so today these reports return
zeros. The reporting *shape* is ready; the data will start flowing once
Phase 3 is built.

**Phase 3 — PV/BV + weekly payout + TDS engine (NOT STARTED — blocked).**
This is the one phase Claude will not build from guesswork: the real
compensation-plan math (level-income %, direct bonus, matching bonus
rules, how the global auto pool is funded/split, repurchase bonus, rank
bonus criteria) has to come from AIRX's actual compensation plan
document, since getting it wrong misallocates real distributor money.
Waiting on that document (or a decision to reverse-engineer it from
admin.airxplus.com's historical payout records instead, which is slower
and less reliable) before this phase starts.

**Phase 5 (cutover)** — after Phase 3 is validated, see the plan doc.
