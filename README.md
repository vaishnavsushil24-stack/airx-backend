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

## Pending items — only you can do these (updated 2026-08-27)

Everything buildable without new external permissions, a new paid vendor
key, or a business decision has been built, tested, and deployed (through
Phase 29 below — the full AI Upgrade Roadmap is now complete except for
what's listed here). These seven are genuinely stuck on someone/something
outside this server, so they're listed here together instead of scattered
across sections:

1. **India Post IP whitelisting** — still not approved on India Post's side.
   Submit `64.227.141.75` on `/customer-selfservice/whitelist-ip-address`
   (UAT Environment field). Re-tested today (2026-08-25) and it's still
   blocked with the same signature as before — full detail in section 4a.
   Once approved, real parcel booking + tracking works immediately, no code
   changes needed.
2. **WhatsApp automation activation** — needs a WhatsApp Business Account in
   Meta Business Manager: a Phone Number ID + permanent access token (added
   to Render as `WHATSAPP_PHONE_ID` / `WHATSAPP_TOKEN`), plus four message
   templates approved by Meta: `cod_confirmation`, `tracking_update`,
   `delivery_followup`, and `replenishment_reminder` (new in Phase 14). See
   section 7.
3. **Abandoned-cart recovery** — needs you to re-approve the Shopify app
   with one extra permission (`read_checkouts`) by revisiting
   `/shopify/install` and clicking through Shopify's consent screen again.
   Deliberately not something this server does on its own — an OAuth
   consent screen always needs a human click.
4. **Retiring store.airxplus.com / admin.airxplus.com (the "Cutover" step,
   `MLM_INTEGRATION_PLAN.md` Phase 5)** — everything those two legacy
   systems do has now been rebuilt here (Phases 1–9 below), but switching
   real distributor data-entry and payouts over to this server, and
   shutting the old ones down, is a one-way business decision, not a code
   change. It also directly affects distributor income, so before that
   switch it's worth reconciling this system's commission math against a
   real payout cycle from admin.airxplus.com (e.g. the ₹22,275.60 / PV
   67,450 figures reviewed while planning this — see
   `MLM_INTEGRATION_PLAN.md`) to confirm the numbers match exactly. This
   wasn't flagged as a pending item before this round — noting it now
   rather than ever cutting distributors over silently.
5. **Social Media Hub (Phase 16) needs its own Meta permissions** — the
   current `META_PAGE_ACCESS_TOKEN` only has Lead Ads scopes. Posting,
   replying to comments/DMs, and running ads each need you to re-authorize
   the Meta app with additional scopes (`pages_manage_posts`,
   `pages_read_engagement`, `pages_manage_engagement`, `pages_messaging`,
   `instagram_basic`, `instagram_content_publish`,
   `instagram_manage_comments`, `ads_management`, `ads_read`,
   `business_management`) through Meta's OAuth consent screen, plus
   setting `META_PAGE_ID`, `META_IG_BUSINESS_ID`, and
   `META_ADS_ACCOUNT_ID` on Render. Full detail in Phase 16 below. Until
   then, posts/replies/campaigns all save fine in the admin and just wait.
6. **AI-generated post/ad imagery** — the Social Media Hub (Phase 16) and
   Ads Manager (Phase 25) can suggest captions and ad copy via the
   configured text AI, but generating the actual image needs a separate
   image-generation API key (e.g. OpenAI's `gpt-image-1` / DALL-E, or
   Stability AI) that hasn't been provided. Until then, the media
   URL/upload fields work fine with images you supply yourself. Flagged as
   a Tier 3 AI Upgrade Roadmap item, not built.
7. **Voice AI for phone orders** — letting customers place or check orders
   by phone call would need a voice/telephony vendor integration (e.g.
   Twilio + a speech-to-text/text-to-speech pipeline) that hasn't been set
   up — a genuinely new vendor relationship and cost, not a code change.
   Flagged as a Tier 3 AI Upgrade Roadmap item, not built.

WhatsApp-native multi-turn AI conversations (the other Tier 3 roadmap
item) are covered by pending item #2 above — the moment WhatsApp is
connected, the same AI assistant that already answers on the website
(Phase 13) can be wired to answer inbound WhatsApp messages too; no
separate blocker.

Also worth a periodic manual check (no diagnostic endpoint for this one):
Meta Lead Ads' "Standard Access" review on the `leads_retrieval` /
`pages_manage_metadata` permissions (section 2) — status wasn't
re-confirmed this round.

Everything else — AI Agent (Phase 13), replenishment reminders (Phase 14),
full data backup/export (Phase 15), the Social Media Hub's post
composer/scheduler and AI-drafted engagement replies (Phase 16, minus the
Meta-permission-gated live posting/ads noted above), the referral bridge
(Phase 17 — tracking is live now, just waiting on you to pick a reward
amount whenever you're ready, no rush and no permission needed), automated
tests on every push (Phase 18), semantic KB search (Phase 19), the AI eval
harness (Phase 20), per-customer replenishment timing (Phase 21),
sentiment-aware engagement triage (Phase 22), personalized reminder drafts
(Phase 23), AI demand forecasting (Phase 24), ad-creative variant testing
(Phase 25), payout anomaly detection (Phase 26), referral-propensity
scoring (Phase 27), the daily AI briefing (Phase 28), tiered AI model
routing (Phase 29), inventory/batch/expiry tracking, staff performance,
multi-user admin auth, and the rest of the MLM feature set — is live and
already working autonomously.

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
no further code changes. Re-checked 2026-08-25 via both diagnostic
endpoints below - same signature as before (proxy TCP/CONNECT works fine,
TLS handshake to `test.cept.gov.in` still resets), so this is **still
pending on India Post's side**, not a regression.

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

## Phase 11b — low-stock banner on the Dashboard (2026-08-25)

`loadDashboard()` now also fetches `/api/inventory` and, if any item's
`stock` is at or below its `lowStockThreshold`, shows a red-highlighted
banner listing SKU/name/stock/alert-at right above the member/BV summary
cards — so a low-stock condition is visible the moment anyone opens the
Dashboard, no separate check required. Fails silently (banner just
doesn't show) for a staff user without the `inventory` permission, or on
any fetch error, so it can never break the rest of the dashboard.

Live-verified: temporarily added a test SKU below its threshold, reloaded
the Dashboard, confirmed the banner rendered with the correct item and
values, then deleted the test SKU and confirmed the banner disappeared
and inventory was back to empty.

## Phase 12 — batch/expiry tracking for D2C Inventory (2026-08-25)

**Why:** Ayurvedic formulations are batch-manufactured with a shelf
life; unsold near-expiry stock is a direct write-off risk for a
formulation-based D2C business, and it was previously invisible — the
Inventory tab only tracked stock count, not age.

- `/api/inventory` items now accept optional `batchNumber` and
  `expiryDate` (`YYYY-MM-DD`) fields on create (PATCH already spread
  the request body, so updating them needed no route change).
- Inventory tab: new Batch number + Expiry date inputs on the add-item
  form; the table gained Batch and Expiry columns with color-coded row
  highlighting — purple for expired, amber for expiring within 60 days
  (`NEAR_EXPIRY_DAYS`), red for low stock (unchanged).
- Dashboard: new amber "Batches nearing/past expiry" banner alongside
  the existing low-stock banner, sharing the same single `/api/inventory`
  fetch (no extra request) and the same silent-fail-if-no-access pattern.

Live-verified: created a near-expiry item and an already-expired item
via the API (batch number, expiry date), confirmed both persisted with
the right fields, confirmed PATCH updates `batchNumber` in place,
confirmed the Dashboard's near-expiry banner rendered both correctly
(purple "expired" row for the past-dated item, amber "days left" row
for the near-dated one), then deleted both test items and confirmed
inventory returned to empty — 6/6 checks passed.

## Phase 13 — AI Agent: sales, support & education, across the whole system (2026-08-25)

**Why:** the founder asked to defer Meta/WhatsApp integration and instead
build an AI agent that manages sales, support, education, and the wider
system — so this phase adds one AI layer with three separate surfaces,
built to work the moment an API key exists, with zero effect on anything
else while it doesn't.

- **Public customer assistant** — `POST /api/public/assistant` (outside
  `requireAccess`, same reasoning as Phase 11's tracking page: customers
  have no login) + the new `public/assistant.html` chat page. Answers
  product/usage/order questions. Optionally takes a `mobile` field to pull
  that customer's own order status into context (same minimal, PII-light
  order fields as `/api/public/track`). A visible disclaimer tells the
  customer to consult a doctor for anything the assistant can't answer
  confidently — the assistant is instructed to answer **only** from
  staff-authored Knowledge Base content, never to invent dosage/health
  claims. Rate-limited the same way as `/api/public/track` (hand-rolled
  in-memory per-IP limiter, 15 requests / 10 minutes, keyed on the first
  IP in the `x-forwarded-for` chain — reusing the exact fix Phase 11 had
  to make, not repeating the original bug).
- **Staff system copilot** — `POST /api/ai/ask` (`requireAccess("ai_assistant")`)
  + a new **AI Assistant** tab in `public/admin.html` with a chat panel.
  Unlike the public assistant, this one can call tools to look at live
  system data: low-stock items, batches nearing/past expiry, a leads
  summary, an orders summary, and a staff performance summary — so a staff
  member can ask "which items are low on stock?" or "how are we doing on
  leads this week?" in plain language instead of clicking through tabs.
  Runs a bounded tool-calling loop (up to 5 rounds: ask the model, run
  whatever tools it requested, feed the results back, repeat) rather than
  a single fixed prompt.
- **Sales follow-up drafter** — `POST /api/ai/draft-followup`
  (`requireAccess("leads")`), wired into the Leads tab as an "AI: Draft
  follow-up" button per lead. Drafts a short WhatsApp-style follow-up
  message for that lead using their captured details — the staff member
  reviews/edits/copies it, nothing is sent automatically.
- **Knowledge Base** — `GET/POST/PATCH/DELETE /api/kb`
  (`requireAccess("ai_assistant")`), a flat, staff-authored
  category/title/content store, plus a KB panel next to the chat in the
  AI Assistant tab. Deliberately kept separate from anything AI-generated:
  the public assistant's system prompt is built **only** from KB content
  it's told to answer from, so product/health claims stay under staff
  control rather than model improvisation — the right call for an
  Ayurvedic product line where dosage/health claims carry real liability.
- **Provider-agnostic by design, inert until configured.** The founder
  found Anthropic's console shows a $5 minimum credit purchase with no
  free tier, and asked to use an existing OpenAI (ChatGPT) API key
  instead. Rather than swap one provider for the other, `callAI()` in
  `server.js` normalizes messages/tool-calls into one shape and picks a
  provider at boot: `OPENAI_API_KEY` first, `ANTHROPIC_API_KEY` as a
  fallback, and if neither is set, every AI route replies with a clean
  "not configured yet" message instead of crashing — the same
  inert-until-configured pattern the WhatsApp routes already use. Model
  defaults: `OPENAI_MODEL` (default `gpt-4o-mini`) / `ANTHROPIC_MODEL`
  (default `claude-sonnet-4-5-20250929`), both overridable via Render env
  vars with no code change if a different model is preferred.

**To turn the AI Agent on:** put either `OPENAI_API_KEY` (recommended,
since that's the key already on hand) or `ANTHROPIC_API_KEY` into Render's
environment variables — no other setup needed, and no Meta/WhatsApp
account required for this phase. All three surfaces (public assistant,
staff copilot, follow-up drafter) go live the moment the key is saved and
the service restarts.

Live-verified pre-key (Anthropic-shaped build): 9/9 checks — all three new
routes correctly require the expected auth (or none, for the public one),
and all correctly return a graceful "not configured" response instead of a
500 with no key set. Visually confirmed both the public `assistant.html`
page and the admin AI Assistant tab render correctly. The OpenAI-provider
refactor was then verified with `node -c server.js` (syntax) and confirmed
deployed live on Render; a full end-to-end functional test of real
answers (not just the graceful-fallback path) is still pending the
founder actually pasting an API key into Render.

## Phase 14 — replenishment reminders (repeat-purchase nudges) (2026-08-25)

**Why:** Phase 10's README already flagged this as "the single
highest-leverage lever for an Ayurvedic D2C repeat-purchase business," and
unlike WhatsApp activation or abandoned-cart recovery (which needs a
`read_checkouts` Shopify scope this app wasn't granted, so re-authorizing
it would need an explicit OAuth-consent step), this one needed no new
external permission at all — it runs entirely on data already in the
system, so it was built and fully tested end-to-end without waiting on
anything from outside.

- **`deliveredAt` is now stamped automatically** the first time an order's
  status flips to `"delivered"` — both from the admin "Mark delivered"
  button (`PATCH /api/orders/:id`) and from a real India Post delivery-scan
  webhook event. Orders that were already delivered before this phase have
  no `deliveredAt`, so the reminder engine falls back to `createdAt` for
  those (an approximation, not exact, but good enough to not miss them
  entirely).
- **`GET /api/replenishment/due`** (`requireAccess("orders")`) computes,
  on every call (no separate stored "due" table to go stale), which
  delivered customers are past their product's reorder cycle and haven't
  already reordered. Matching reuses the exact same free-text product
  parsing `decrementInventoryForOrder()` already used (comma-separated
  `"Product x2"` segments, matched by name substring against Inventory) —
  one definition of "which inventory item does this order line mean,"
  not two.
- **Reorder cycle is admin-configurable per inventory item** — a new
  optional `reorderCycleDays` field (Inventory tab, "Reorder cycle
  (days)"), defaulting to 30 if left blank. No real per-product
  consumption data exists yet, so 30 days is a starting assumption for a
  typical month's-supply pack, the same "confirmed vs provisional, tune
  without a code change" spirit as the Phase 3 commission settings —
  correct the number per product as real repeat-purchase timing becomes
  known.
- **A customer who already reordered is automatically excluded** — the
  engine checks for any newer order from the same mobile number
  containing the same product before surfacing a reminder, so staff never
  get told to chase someone who's already bought again.
- **Dashboard banner** (`loadDashboard()` in `admin.html`), same
  best-effort/fails-silently-without-permission pattern as the Phase
  11b/12 low-stock and near-expiry banners, sharing the same "don't break
  the rest of the dashboard" try/catch shape: name, mobile, product,
  delivery date, days overdue, a **Send reminder** button (reuses
  `sendWhatsApp()` — logs and returns `{skipped:true}` until
  `WHATSAPP_TOKEN`/`WHATSAPP_PHONE_ID` are set, same inert-until-configured
  pattern as the other three WhatsApp routes; needs one more approved
  template, `replenishment_reminder`, alongside the existing three once
  WhatsApp is connected), and a **Dismiss** button
  (`POST /api/replenishment/dismiss`) for a reminder that's not
  applicable or was already handled some other way.

A functional test (`test_phase14.js`, 12 assertions, pure-logic — no
server/DB needed) exercises the matching engine directly: an overdue
order surfaces with the correct days-overdue math, a too-recent order is
excluded, a custom shorter reorder cycle triggers earlier than the
default would, a customer who already reordered is excluded, a dismissed
reminder stays dismissed, an order that was never delivered is excluded
regardless of age, an order with no mobile number is excluded, a legacy
order predating the `deliveredAt` stamp falls back to `createdAt`
correctly, a product with no matching inventory item is safely skipped
(no crash), and a multi-product order correctly surfaces one reminder per
matched item. All existing test suites
(`test_phase3/6/7/8/9.js`) were re-run after this change — zero
regressions.

## Phase 15 — full data backup / export (2026-08-25)

**Why:** while re-checking the India Post proxy this round, re-reading the
`DATA_DIR` comment in `server.js` surfaced a real incident from an earlier
phase — the flat JSON files (leads/orders/inventory) were originally
pointed at the container's own ephemeral folder instead of the Render
Persistent Disk, so a deploy silently wiped 14 synced Shopify orders and
the Shopify connection itself before that was caught and fixed. That's
already resolved (both `server.js` and `db.js` now consistently use
`DATA_DIR`, which is set to the mounted disk at `/var/data`, confirmed via
Render's Disks page — 1 GB, daily snapshots kept 7 days). Disk snapshots
cover disaster recovery, but there was still no way for the founder to
grab a copy of the actual data on demand without going through Render's
dashboard — this phase adds that, and needed no new external permission,
so it was built the same way as Phase 14.

- **`GET /api/backup/export`** (`requireAccess("user_management")` — the
  most privileged module key in the app, since a full export includes
  customer names, phone numbers and order history) returns one downloadable
  JSON file containing leads, orders, inventory, the AI Agent's Knowledge
  Base, dismissed-replenishment records, and every MLM/SQLite table
  (products, franchises, members, commissions, payouts, etc.).
- **Live secrets are deliberately left out.** The Shopify and India Post
  connection files hold real OAuth tokens (`accessToken` /
  `refreshToken`), not just config — the export includes only
  `{ shop, connected, connectedAt }` / `{ connected, expiresAt,
  barcodeSeq }` for each, never the token values themselves, so the backup
  file is safe to hand to an accountant or store off-Render without
  handing over live API access too.
- **Admin UI**: a "Data Backup" panel in the User Management tab with a
  single **Download full backup (.json)** button — fetches with the
  logged-in session's own credentials (API key or Bearer token, whichever
  is active) and triggers a normal browser file download, named
  `airx-backup-<date>.json`.

A functional test (`test_phase15.js`, 7 assertions) isolates the
redaction logic specifically — asserting a live Shopify access token and
India Post access/refresh tokens never appear anywhere in the JSON output
for both connected and not-yet-connected states, plus that the
non-secret fields (shop domain, barcode sequence) still come through
correctly. All existing test suites (`test_phase3/6/7/8/9/14.js`) were
re-run after this change — zero regressions.

## Phase 16 — Social Media Hub: posts, AI-answered engagement, Meta Ads (2026-08-25)

**Why:** the founder asked directly for a one-stop A-to-Z social media
solution — daily post scheduling, an AI agent that answers comment/DM
engagement, and proper Meta Ads management, all in one place. This is the
first phase built specifically to *not* be fully usable the moment it's
deployed — posting, replying, and running ads all need Meta permissions
this app's current token doesn't have (see the new pending item below) —
but every piece of it is real, tested code, not a stub: it starts working
the instant those permissions exist, no further code changes needed, same
inert-until-configured pattern as WhatsApp/Shopify/India Post/OpenAI.

- **Post Composer &amp; Calendar** — `GET/POST/PATCH/DELETE
  /api/social/posts`, `POST /api/social/posts/:id/publish`. Staff write or
  AI-suggest (`POST /api/social/posts/suggest-caption` — drafts only,
  reuses the same Knowledge Base + never-invent-claims system prompt as
  the AI Assistant) a caption, optionally schedule it, and a once-a-minute
  background check (`setInterval`, not a separate cron service) publishes
  anything due via `publishSocialPost()` — Facebook via `/​{page}/feed` or
  `/​{page}/photos`, Instagram via the two-step `/media` +
  `/media_publish` container flow. Nothing is lost if Meta posting isn't
  connected yet — a due post just stays "scheduled" and gets picked up on
  a later tick once it is.
- **Engagement Inbox (AI-answered comments &amp; DMs)** — the existing
  `/webhook/meta` handler now also recognizes Facebook Page comments
  (`feed` change, `item:"comment"`), Instagram comments (`comments`
  change), and Messenger DMs (the separate `entry.messaging` array), and
  routes each one through `handleIncomingSocialComment()`: de-duplicated
  by Meta's own id (webhooks can redeliver), then
  `generateSocialReplyDraft()` writes a suggested reply using the same
  Knowledge Base the public AI Assistant uses. **Auto-send stays off by
  default** — an unreviewed AI reply going out publicly under the brand's
  name is a real reputational risk, so every draft waits in the Engagement
  Inbox for a staff member to edit (if needed) and click **Approve &amp;
  Send** (`POST /api/social/engagement/:id/send`). Setting
  `AI_AUTO_REPLY_SOCIAL=true` on Render flips individual future replies to
  fully autonomous once the founder trusts the Knowledge Base coverage and
  tone — a deliberate opt-in, not the starting default.
- **Meta Ads Manager** — local-first campaign records
  (`GET/POST/PATCH/DELETE /api/ads/campaigns`) with a deliberately
  **two-step** path to actually spending money: **Launch**
  (`POST /api/ads/campaigns/:id/launch`) only creates the
  campaign/ad-set/creative/ad in Meta's Marketing API, all with
  `status:"PAUSED"` — ₹0 spent, reviewable in Meta's own Ads Manager first.
  A separate **Activate** (`POST /api/ads/campaigns/:id/activate`) is the
  one that actually starts spending, and requires an explicit
  `{confirm:true}` in the request body on top of the button click itself —
  the admin UI additionally asks staff to type `LAUNCH` before it will
  even send that request. **Pause** is always available and safe/reversible.
  This module hasn't been exercised against a real Meta Ads account yet
  (no ad account is connected) — test with a small daily budget first once
  it is, and keep an eye on Meta Ads Manager directly the first few times.
- **Admin UI**: a new "Social Media" tab with all three panels — Post
  Composer &amp; Calendar, Engagement Inbox, and Meta Ads Manager — gated
  behind a new `social_media` permission module key (Phase 8's role
  system), so it can be handed to specific staff without giving them
  every other tab.

A functional test (`test_phase16.js`, 18 assertions) covers the pieces
most worth protecting from a future regression: the age/gender targeting
mapping, the scheduler's due-posts filter (past/exactly-now due,
future/draft/already-published excluded), webhook redelivery
de-duplication, and — the two guards that matter most here — AI
auto-reply defaulting to OFF (unset, `"false"`, and an empty draft all
correctly stay silent; only an explicit `AI_AUTO_REPLY_SOCIAL=true` *and*
a real draft triggers a send), and ad-campaign activation rejecting
anything other than a literal boolean `confirm:true` (no accidental
truthy bypass via the string `"true"`). All existing test suites
(`test_phase3/6/7/8/9/14/15.js`) were re-run after this change — zero
regressions.

**What this needs from the founder before it does anything live** (added
as a 6th pending item below): the current `META_PAGE_ACCESS_TOKEN` was
issued for Lead Ads only. Posting, replying, and ads each need their own
scopes that require re-authorizing the Meta app through its OAuth consent
screen — `pages_manage_posts`, `pages_read_engagement`,
`pages_manage_engagement`, `pages_messaging`, `instagram_basic`,
`instagram_content_publish`, `instagram_manage_comments`,
`ads_management`, `ads_read`, `business_management` — plus setting
`META_PAGE_ID`, `META_IG_BUSINESS_ID`, and `META_ADS_ACCOUNT_ID` on
Render once those exist. Exactly the same reasoning as the Shopify
`read_checkouts` situation: an OAuth consent screen is never something
this server clicks through on its own.

## Phase 17 — retail-customer-to-distributor referral bridge (2026-08-25)

**Why:** flagged since Phase 14 as needing the founder's own input on the
actual referral/commission rule before it could be built correctly — the
same situation Phase 3 ran into with the MLM compensation plan itself.
Rather than leave it fully unbuilt while waiting on that input, this
follows the exact pattern Phase 3 used there: build the tracking and an
admin-configurable reward setting now, default the reward to **"none"**
(so nothing happens until the founder actually sets a rule), and let the
real number be tuned later with zero code changes.

- **Orders can be tagged "Referred by (mobile)"** — a new field on the
  existing order-add form and accepted on any `PATCH /api/orders/:id`
  (the routes already accepted arbitrary fields, no server change needed
  there). Deliberately a flat JSON ledger
  (`GET/PATCH /api/referrals/settings`, `GET /api/referrals`,
  `POST /api/referrals/:id/mark-paid`, `POST /api/referrals/:id/void`),
  **not** the MLM SQLite `wallet_transactions` table — a retail D2C
  customer who refers a friend isn't automatically a distributor, and
  folding them into the distributor wallet schema would quietly make
  that business-model decision on the founder's behalf instead of
  leaving it for them.
- **Reward becomes "eligible" automatically** the moment the referred
  customer's order is marked delivered (reuses the exact same
  `deliveredAt`-stamping hook Phase 14 already added to both
  `PATCH /api/orders/:id` and the India Post delivery webhook — no new
  webhook needed) — but only if it's genuinely that customer's **first**
  delivered order (repeat orders from an already-converted referred
  customer don't re-trigger a reward), the order is at/above an optional
  configurable minimum amount, and it isn't a self-referral (referrer and
  referred mobile can't match).
- **Reward type is admin-configurable**: no reward (the default), a flat
  ₹ credit, or a % of the referred order's amount. Settlement is manual
  — an admin marks a reward "paid" or "void" from the new Referral Bridge
  panel (Orders tab) — deliberately not wired to auto-issue a live
  Shopify discount code, since that would need yet another OAuth scope
  this app doesn't have; keeping it a manual ledger avoids stacking up
  another pending-permission item for something this uncertain.

A functional test (`test_phase17.js`, 10 assertions) exercises the
eligibility engine directly: the "none" default keeps everything inert,
a flat credit and a percent-of-order reward both compute correctly, a
missing/invalid referrer excludes an order, self-referral is rejected,
the minimum-order-amount threshold is respected in both directions, only
the referred customer's genuinely first delivered order is eligible (a
second order from the same referred customer is correctly excluded —
the repeat-order-abuse guard), and an earlier non-delivered order from
the same customer doesn't block eligibility on the real first delivery.
All existing test suites (`test_phase3/6/7/8/9/14/15/16.js`) were re-run
after this change — zero regressions.

## Phase 18 — automated tests on every push (CI) (2026-08-25)

**Why:** by this point there are 8 pure-logic test files
(`test_phase3/6/7/8/9/14/15/16/17.js` + `test_migration.js`) covering the
riskiest logic in the app, but they only ever ran when I happened to run
them by hand before a push. With 17 phases and growing, that's exactly
the kind of manual step that eventually gets skipped under time pressure.
Adding CI needed no new external permission — GitHub Actions is already
part of a GitHub repo, free for a repo this size, and runs no secrets and
touches no production data (every test file is a pure-logic
reimplementation with no server, database, or real API calls — see each
file's own header comment).

- **`.github/workflows/test.yml`** runs on every push and pull request
  against `main`: syntax-checks `server.js` and `db.js`
  (`node -c`), then runs every `test_phase*.js` and `test_migration.js`
  file in the repo. A future push that breaks any existing test now fails
  visibly in GitHub (a red ✗ next to the commit) instead of only being
  discovered after it's already live on Render.
- Verified by running the exact same steps locally first (syntax checks +
  all 10 test files) before relying on GitHub's own runner to confirm it.

No admin UI or API changes — this is a repo-level safety net, not a
feature.

**Next candidates (not yet started), largely growth-focused per the
founder's Ayurvedic D2C directive:** abandoned-cart recovery for Shopify
checkouts (blocked on a `read_checkouts` OAuth scope this app's current
Shopify connection doesn't have — re-authorizing needs an explicit
OAuth-consent click, so this is flagged for the founder rather than done
silently).

## Phase 19 — semantic search for the Knowledge Base (RAG) (2026-08-27)

**Why:** both AI surfaces that ground themselves in the Knowledge Base —
the public customer assistant (`/api/public/assistant`) and the Social
Media Hub's auto-drafted replies (`generateSocialReplyDraft`) — used to
paste every single KB article into the prompt on every single question.
That's fine with a handful of articles, but it doesn't scale: a growing
KB means a growing prompt (slower, costlier, and eventually past the
model's useful context for the actual question), and stuffing in
irrelevant articles makes it easier for the model to answer from the
wrong one. This is the first item from the AI Upgrade Roadmap's Tier 1.

- **`embedText(text)`** — calls OpenAI's `text-embedding-3-small` model to
  turn a string into a vector. Same "inert until configured" pattern as
  every other integration in this app: with no `OPENAI_API_KEY` set, it
  returns `null` immediately rather than throwing, and every caller
  already has a documented fallback for that case.
- **`cosineSimilarity(a, b)`** and **`rankKBBySimilarity(queryEmbedding, kb, topN)`**
  — pure functions, no I/O. Rank KB articles by how closely their stored
  embedding matches the query's embedding, returning the top N. Both
  degrade safely: no query embedding, an empty/all-unembedded KB, or a
  mismatched vector all fall back to returning the KB untouched rather
  than erroring or silently dropping everything.
- **`retrieveRelevantKB(query, kb, topN=5)`** — the actual entry point
  both AI surfaces now call. Skips embedding entirely (no network call,
  no cost) when the KB is already small enough (`kb.length <= topN`) that
  ranking wouldn't change anything — this keeps small-KB behavior
  byte-for-byte identical to before Phase 19.
- **`POST /api/kb`** and **`PATCH /api/kb/:id`** now compute and store an
  `embedding` field on each article whenever it's created or its
  title/content changes, via `embedText()`. Existing articles created
  before this phase simply have no `embedding` yet — `rankKBBySimilarity`
  already treats those as un-rankable and falls back to including
  everything, so nothing needs a one-time backfill migration for this to
  work correctly; articles pick up an embedding the next time they're
  edited.
- Both `/api/public/assistant` and `generateSocialReplyDraft` now call
  `retrieveRelevantKB(question or item.message, kb)` before building the
  `kbText` block that goes into the AI prompt, instead of using the raw
  KB array directly.
- **Without `OPENAI_API_KEY` configured** (or as long as the KB stays at
  5 articles or fewer), behavior is identical to before this phase — the
  full KB is always included. This only starts narrowing the context once
  both an OpenAI key is present and the KB has grown past a handful of
  articles, so nothing about existing behavior changes until the founder
  is actually running enough KB content for it to matter.
- **`test_phase19.js`** (17 assertions) — `cosineSimilarity` on identical/
  orthogonal/opposite/mismatched/zero-magnitude vectors; `rankKBBySimilarity`
  top-N selection and score-stripping; graceful fallback with no query
  embedding, an all-unembedded KB, and a KB with mixed embedded/
  unembedded articles; `retrieveRelevantKB` skips the network call
  entirely for a small KB and an empty KB, and calls it exactly once for
  a KB larger than `topN`.
- Full regression suite (`test_phase3/6/7/8/9/14/15/16/17/19.js` +
  `test_migration.js`, 11 files) passes, plus `node -c server.js`.

No admin UI changes — this is a backend quality/scaling improvement to AI
surfaces that already exist. `embedText()` itself (the only part that
makes a real network call) isn't unit-tested here, the same way `callAI()`'s
HTTP call isn't unit-tested elsewhere in this repo — it's exercised for
real once `OPENAI_API_KEY` is configured and the assistant is used.

## Phase 20 — AI eval harness (2026-08-27)

**Why:** the assistant's system prompt, the AI provider (OpenAI/Anthropic),
and now the KB retrieval logic (Phase 19) all change over time — with no
fixed set of known-good question/answer checks to run afterward, the only
way to notice a regression was a customer getting a wrong or missing
answer. This is Tier 1 item 2 from the AI Upgrade Roadmap.

- **`scoreEvalResult(answerText, evalCase)`** — pure function. An eval case
  has `expectedKeywords` (all must appear, case-insensitive) and an
  optional `mustNotContain` (none may appear — e.g. to catch the assistant
  inventing a specific dosage number it shouldn't state). Returns
  `{passed, missingKeywords, foundForbidden}`.
- **`runSingleEval(evalCase)`** — runs one case through the *exact* same
  KB-retrieval + system prompt as `/api/public/assistant` (not a
  simplified stand-in), then scores the real answer.
- **`GET/POST/PATCH/DELETE /api/ai/evals`** — admin CRUD for eval cases,
  behind `requireAccess("ai_assistant")`. Starts empty; the founder/admin
  builds up cases through the new "AI Evals" panel on the AI Assistant
  admin tab (question + comma-separated expected/forbidden keywords).
- **`POST /api/ai/evals/run`** — runs every case, stores the results
  (`ai_eval_results.json`) and returns a summary
  (`{total, passed, failed, notConfigured}`). Deliberately **not** wired
  into CI — this makes a real AI API call (costs money, needs a live
  key), so it's an on-demand admin action, same trust level as any other
  `ai_assistant`-gated route, rather than something that runs
  automatically on every push.
- Admin UI: new "AI Evals" panel — add a case, "Run all evals now", see
  pass/fail per case with the actual AI answer and exactly which keyword
  was missing or which forbidden term appeared, for any case that failed.
- **`test_phase20.js`** (10 assertions) — keyword presence/absence,
  case-insensitivity, combined pass/fail logic, empty/null-safe handling,
  reporting every missing keyword rather than just the first.
- Full regression suite (`test_phase3/6/7/8/9/14/15/16/17/19/20.js` +
  `test_migration.js`, 12 files) passes, plus `node -c server.js` and a
  JS-syntax check of the extracted `admin.html` script block.

No new external permission needed — this only runs against the AI
provider the founder has already configured.

## Phase 21 — per-customer replenishment timing (2026-08-27)

**Why:** Phase 14's reorder-reminder logic used one fixed cycle length per
product (admin-configured, or a 30-day default) applied identically to
every customer. Real customers don't consume a pack at the same rate — a
family sharing one order finishes it faster than someone taking it once a
day solo. This is Tier 1 item 3 from the AI Upgrade Roadmap.

- **`computePersonalizedCycleDays(mobile, itemName, orders)`** — pure
  function. Once a customer has 2+ delivered orders of the same product,
  computes the average gap (in days) between their own past deliveries
  and uses that as their personal reorder cycle, clamped to a 7–180 day
  range so a data-entry glitch (two orders logged a day apart) or a
  multi-year gap between unrelated one-off orders can't produce a
  nonsensical cycle.
- **`computeReplenishmentDue`** now calls this per due candidate: a
  customer with reorder history gets their own observed cadence
  (`cycleSource: "personalized"`); a first-time customer still falls back
  to the item's configured cycle or the 30-day default exactly as
  before Phase 21 — nothing changes for customers with no history yet.
- Admin UI: the dashboard's "Replenishment due" table now shows a "Cycle
  used" column with a 👤 personalized badge (tooltip explains why) when a
  reminder is based on that specific customer's own reorder gap rather
  than the product default.
- **`test_phase21.js`** (8 assertions) — no-history fallback, 2-delivery
  and 3-delivery averaging, minimum/maximum clamping, cross-customer
  isolation (one customer's history never leaks into another's cycle),
  and both `cycleSource` paths end-to-end through `computeReplenishmentDue`.
- Full regression suite (`test_phase3/6/7/8/9/14/15/16/17/19/20/21.js` +
  `test_migration.js`, 13 files) passes — including the original
  `test_phase14.js` unchanged, since its fixtures are all single-delivery
  customers where personalization correctly doesn't kick in.

No new external permission needed — this only reshapes numbers already in
`orders.json`.

## Phase 22 — sentiment-aware engagement triage (2026-08-27)

**Why:** Phase 16's Engagement Inbox treated every comment/DM with equal
weight — a "love this, ordered again!" and a "this gave my mother an
allergic reaction, I want a refund" sat side by side in plain arrival
order. A public brand account needs the second one found and handled
fast. This is Tier 1 item 4 from the AI Upgrade Roadmap.

- **`classifyEngagementSentiment(message)`** — pure function, deliberately
  rule-based (keyword matching in English + common Hinglish terms), not
  an extra AI API call per comment: it costs nothing, runs instantly, and
  needs no OpenAI/Anthropic key to work at all — same "cheap,
  deterministic, always-on" reasoning as this app's other non-AI logic.
  Returns `{sentiment, priority, flaggedKeywords}` — `priority` is
  `"high"` for anything touching refunds/fraud/allergic reactions/legal
  threats/etc., `"medium"` for negative-but-not-urgent language, `"normal"`
  otherwise. Deliberately biased toward over-flagging: a false positive
  just tags a normal comment, a false negative could mean a real
  complaint gets missed.
- `handleIncomingSocialComment` now stores `sentiment`/`priority`/
  `flaggedKeywords` on every inbound item, and **a `"high"`-priority item
  now never auto-sends**, even when the founder has opted into
  `AI_AUTO_REPLY_SOCIAL=true` — an AI reply to a possible
  allergic-reaction/refund/legal-threat message going out unreviewed is
  exactly the reputational risk that setting was never meant to cover.
- **`GET /api/social/engagement`** now accepts `?priority=high|medium|normal`
  and always sorts urgent items first, then negative, then the rest
  newest-first within each bucket — no more scrolling past a real
  complaint to find it.
- Admin UI: Engagement Inbox cards now show a 🚨 urgent / ⚠️ negative badge
  with the specific keywords that triggered it, plus a priority filter
  dropdown.
- **`test_phase22.js`** (14 assertions) — sentiment/priority classification
  across positive/neutral/negative/urgent/mixed/Hinglish/empty inputs,
  case-insensitivity, and the updated auto-send gate (urgent always
  blocked; medium/normal unaffected, same flag/draft logic as before).
- Full regression suite (`test_phase3/6/7/8/9/14/15/16/17/19/20/21/22.js`
  + `test_migration.js`, 14 files) passes.

No new external permission needed — this only changes how existing
inbound messages already stored are classified and ordered.

## Phase 23 — personalized reminder/follow-up copy (2026-08-27)

**Why:** the existing "Send reminder" button sends a fixed WhatsApp
*template* with only name/product as blanks — that's a WhatsApp platform
rule, not a limitation to code around: any message sent outside a 24h
customer-initiated conversation window must use a pre-approved template,
free text is rejected there. So instead of trying to personalize the
template itself, this generates a genuinely personalized draft message
(using the customer's name, product, and their own reorder cadence from
Phase 21) that staff can copy today and send manually — and that becomes
usable as real free-text once WhatsApp is connected and a customer
messages in first. This is Tier 1's last item, and completes Tier 1.

- **`generateReplenishmentReminderDraft({name, product, mobile, daysOverdue, cycleSource, reorderCycleDays})`**
  — calls the configured AI provider for a short, warm, specific
  WhatsApp-style message. Always has a plain templated fallback (uses the
  same "inert until configured" pattern as the rest of the app) so a
  missing AI key or a network failure never returns a blank draft.
- **`POST /api/replenishment/draft-message`** — behind
  `requireAccess("orders")`, same access level as the existing reminder
  route.
- Admin UI: a new "AI: Draft message" button per row in the dashboard's
  Replenishment Due table, opening an editable textarea with a "Copy"
  button (`navigator.clipboard`) — explicitly labeled as draft-only, for
  manual send until WhatsApp sending is connected.
- **`test_phase23.js`** (5 assertions) — AI-not-configured fallback stays
  personalized (never blank), a configured provider's response is used
  and trimmed, an empty AI response still falls back safely, a thrown
  network error is caught rather than crashing the route, and missing
  name/product still produce a natural generic fallback.
- Full regression suite (`test_phase3/6/7/8/9/14/15/16/17/19/20/21/22/23.js`
  + `test_migration.js`, 15 files) passes.

No new external permission needed — this only drafts text for a human to
copy; nothing is sent automatically. **This completes Tier 1 of the AI
Upgrade Roadmap.**

## Phase 24 — AI demand forecasting for inventory (2026-08-27)

**Why:** the existing low-stock alert is a static threshold — it only
fires once stock is already at or below a fixed number, with no sense of
how fast that stock is actually moving. A fast-selling item still
comfortably above its threshold can sell out before anyone notices; a
slow-selling item just under threshold isn't actually urgent. This is
Tier 2 item 1 from the AI Upgrade Roadmap.

- **`computeDemandForecast(orders, items, now)`** — pure function.
  Projects each item's sales velocity over a trailing 90-day window
  (excluding cancelled orders) and computes days-of-stock-remaining at
  that rate. Deliberately not a per-item AI/LLM call — a rate projection
  over real order data is cheap, deterministic, and always on regardless
  of whether an AI provider is configured. Items with zero recent
  matching sales are excluded rather than reporting a misleading
  "infinite" runway. Flags `willStockOutSoon` for anything projected to
  run out within 14 days (a typical restock lead time), and sorts
  soonest-to-stock-out first.
- **`GET /api/inventory/forecast`** — behind `requireAccess("inventory")`.
- Admin UI: new "Demand Forecast" panel on the Inventory tab — name,
  current stock, units sold (90d), daily rate, and days left, with a
  ⚠️ restock-soon highlight.
- **`test_phase24.js`** (7 assertions) — no-sales-data exclusion, rate/
  days-left math, the stock-out-soon threshold in both directions,
  cancelled orders excluded from velocity, sales outside the lookback
  window excluded, and sort order.
- Full regression suite (`test_phase3/6/7/8/9/14/15/16/17/19/20/21/22/23/24.js`
  + `test_migration.js`, 16 files) passes.

No new external permission needed — this only re-derives numbers already
in `orders.json`/`inventory.json`.

## Phase 25 — ad-creative variant testing (2026-08-27)

**Why:** Phase 16's Ads Manager could create one campaign at a time, with
no structured way to test which caption/image actually performs better.
This is Tier 2 item 2 from the AI Upgrade Roadmap. The live-spend safety
model from Phase 16 is completely unchanged — this is comparison logic
over campaigns that already went through the existing create-paused,
explicit-`confirm:true`-to-activate flow.

- Campaigns can now optionally carry a `variantGroupId` + `variantLabel`
  (e.g. two campaigns both tagged `"diwali-push"`, labeled "A" and "B")
  when created or edited in draft.
- **`rankAdVariants(variants)`** — pure function. Ranks variants by
  click-through rate (clicks/impressions), tie-broken by lower
  cost-per-click. Deliberately refuses to call a winner until every
  compared variant has at least 500 impressions — an early CTR lead from
  a handful of impressions can easily flip, so declaring a winner too
  soon would actively mislead. A variant not yet launched (no insights)
  sorts last rather than breaking the comparison.
- **`GET /api/ads/campaigns/compare?groupId=...`** — behind
  `requireAccess("social_media")`, fetches live insights for each
  variant in the group (gracefully skips any not yet launched) and
  returns the ranked comparison.
- Admin UI: variant group/label fields on the campaign form, plus a new
  "Ad Variant Comparison" panel showing impressions/clicks/CTR/CPC per
  variant with a 🏆 leading badge once there's enough data.
- **`test_phase25.js`** (6 assertions) — single-variant/no-comparison
  case, the impressions-threshold gate blocking a premature winner call,
  CTR-based ranking, CPC tie-break, a not-yet-launched variant sorting
  last without crashing, and zero-impressions producing a null CTR
  rather than NaN/Infinity.
- Full regression suite (`test_phase3/6/7/8/9/14/15/16/17/19/20/21/22/23/24/25.js`
  + `test_migration.js`, 17 files) passes.

No new external permission needed — real ad spend still requires the
same explicit Launch → review in Meta → Activate (`confirm:true`) flow
from Phase 16, untouched by this phase.

## Phase 26 — distributor payout anomaly detection (2026-08-27)

**Why:** the weekly matching payout run computes dozens of members'
payouts automatically from PV ledger data — a data-entry mistake upstream
(a duplicate order counted twice, a wrongly-placed member) could silently
produce one member's payout being far larger than usual, with nothing
forcing a human to notice before it's committed and real money moves.
This is Tier 2 item 3 from the AI Upgrade Roadmap.

- **`detectPayoutAnomalies(currentMembers, historicalPayoutsByMember)`** —
  pure function. Flags a member's payout when it's more than 3x their own
  historical average (using their real past committed payouts), or — for
  a first-time member with no history — more than 5x this run's median
  payout. **Review only**: nothing is blocked, changed, or auto-corrected,
  exactly the same "surface it, admin decides" principle as the low-stock
  and near-expiry banners.
- **`getHistoricalPayoutsByMember`** — the one DB-touching helper, kept
  separate so the actual detection logic stays a pure, unit-testable
  function.
- **`GET /api/payouts/preview`** and **`POST /api/payouts/commit`** both
  now return an `anomalies` array; commit additionally logs any anomalies
  server-side for the audit trail. Commit is **not** blocked by an
  anomaly — the admin already reviews the full preview before committing,
  same as before this phase.
- Admin UI: the Payouts tab's preview now shows a ⚠️ flagged-for-review
  panel (member, net amount, and why) above the full breakdown when any
  anomalies are found.
- **`test_phase26.js`** (10 assertions) — median calculation (odd/even/
  empty), normal-vs-anomalous payouts against own history, the exact
  multiplier boundary not being flagged, first-time-member comparison
  against the run median, zero-payout members never flagged, and multiple
  anomalies in one run all being reported.
- Full regression suite (`test_phase3/6/7/8/9/14/15/16/17/19/20/21/22/23/24/25/26.js`
  + `test_migration.js`, 18 files) passes.

No new external permission needed — this only re-derives numbers already
in the `payouts` table.

## Phase 27 — referral-propensity scoring (2026-08-27)

**Why:** the Phase 17 referral bridge is entirely reactive — it only
records a referral after someone already used a referral code. There was
no way to tell staff which delivered customers are actually worth
proactively asking. This is Tier 2 item 4 from the AI Upgrade Roadmap.

- **`computeReferralPropensity(mobile, orders, now)`** — pure function.
  Deliberately a simple, explainable points-based heuristic, not a
  trained model — there isn't remotely enough referral history yet to
  train one, and a black-box score staff can't explain to a customer
  isn't useful anyway. Every point has a stated reason in the output.
  Signals: +20 baseline for any delivered customer, +30 for having
  already referred someone else (the strongest signal — proven behavior),
  up to +30 for repeat-purchase loyalty (10 pts/extra delivered order,
  capped), +15 if their most recent delivery was within 30 days. Capped
  at 100 total.
- **`GET /api/referrals/propensity`** — behind `requireAccess("orders")`,
  scores every customer with at least one delivered order and returns
  the top 50 by score.
- Admin UI: new "Referral-Propensity Scoring" panel on the Orders tab's
  Referral Bridge section — customer, mobile, score, and the specific
  reasons behind it.
- **`test_phase27.js`** (8 assertions) — no-delivered-orders returns null,
  baseline-only scoring, the recency bonus, loyalty points and their cap,
  the proven-referrer bonus, all signals combining under the 100 cap,
  cross-customer isolation, and every fired signal having a reason.
- Full regression suite (`test_phase3/6/7/8/9/14/.../26/27.js` +
  `test_migration.js`, 19 files) passes.

No new external permission needed — this only re-derives numbers already
in `orders.json`. Nothing is contacted or changed automatically; it's a
ranking aid for staff.

## Phase 28 — one daily AI briefing (2026-08-27)

**Why:** by this point there are half a dozen separate signals scattered
across different tabs — low stock, near-expiry, replenishment due,
demand-forecast stock-outs, urgent engagement, referral-propensity leads
— all genuinely useful, but nobody has time to check six panels every
morning. This pulls them into one short daily read. This is Tier 2 item
5, the last item, and **completes Tier 2** of the AI Upgrade Roadmap.

- **`gatherBriefingSignals()`** — pulls from the exact same
  functions/logic every other tab already uses (low-stock/near-expiry
  tools, `computeReplenishmentDue`, `computeDemandForecast`, urgent
  engagement items, `computeReferralPropensity`, leads/orders summaries),
  so the briefing can never disagree with what staff sees elsewhere.
- **`summarizeBriefingSignals(signals)`** — pure function. Turns the
  gathered signals into a plain bullet list — only signals with actual
  data produce a line, and an all-clear day says so explicitly rather
  than returning nothing.
- **`generateDailyBriefing()`** — hands that bullet list to the configured
  AI provider for a short, warm 3-5 sentence version; always falls back
  to the plain bulleted list (same "inert until configured" pattern as
  the rest of the app) if no AI provider is set or the call fails.
- **`GET /api/briefing/daily`** — behind `requireAccess("dashboard")`.
  Cached per calendar day (`daily_briefing.json`) so it isn't
  regenerated — and doesn't burn an AI call — on every page load;
  `?refresh=true` forces regeneration.
- Admin UI: new "📋 Today's briefing" panel at the top of the Dashboard
  tab, with a Regenerate button.
- **`test_phase28.js`** (11 assertions) — all-clear messaging, per-signal
  line formatting (low stock, urgent engagement, replenishment,
  referral candidates with scores, leads/order stats with sub-breakdowns),
  and the AI-configured/not-configured/thrown-error paths of the briefing
  generator.
- Full regression suite (`test_phase3/6/7/8/9/14/.../27/28.js` +
  `test_migration.js`, 20 files) passes.

No new external permission needed — this only summarizes numbers already
surfaced elsewhere in the app. **This completes Tier 2 of the AI Upgrade
Roadmap.**

## Phase 29 — tiered AI model routing (2026-08-27)

**Why:** every AI call in this app went through one fixed model per
provider. That was already cheap on OpenAI (`gpt-4o-mini` was always the
default), but on Anthropic every single call — including short
customer-facing replies and caption suggestions — was hitting the full
Sonnet model. Most of what this app asks an AI to do (answer from a fixed
Knowledge Base, draft a short reply, suggest a caption, summarize today's
numbers) doesn't need the strongest available model; only the staff
copilot's multi-step tool-calling genuinely benefits from it. This is the
one buildable Tier 3 item from the AI Upgrade Roadmap.

- **`selectAIModel(provider, tier)`** — pure function. `callAI()` now
  takes an optional `tier: "fast"|"smart"` (defaults to `"fast"`).
  OpenAI fast tier stays `gpt-4o-mini` (zero behavior change), smart tier
  steps up to `gpt-4o`. Anthropic fast tier now defaults to
  `claude-3-5-haiku-20241022` (a real cost reduction), smart tier keeps
  the original `claude-sonnet-4-5-20250929` default.
- The staff system copilot (`/api/ai/ask`, which calls tools over live
  system data across multiple rounds) is the only call site switched to
  `tier: "smart"`. Every other AI call in the app (customer assistant,
  social reply drafts, caption suggestions, AI evals, replenishment
  drafts, daily briefing) now runs on the fast tier by default.
- All four model choices stay overridable via env vars
  (`OPENAI_MODEL_FAST/SMART`, `ANTHROPIC_MODEL_FAST/SMART`) — see the new
  "AI Assistant" section added to `.env.example` (which also now properly
  documents `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` themselves, a
  pre-existing gap from Phase 13 this phase happened to touch).
- **`test_phase29.js`** (7 assertions) — correct model per provider/tier
  combination, the unspecified-tier default matching `callAI`'s own
  default parameter, an unknown provider returning null rather than
  throwing, and an unrecognized tier string safely falling back to the
  cheaper fast tier rather than accidentally routing to the expensive one.
- Full regression suite (`test_phase3/6/7/8/9/14/.../28/29.js` +
  `test_migration.js`, 21 files) passes.

No new external permission needed. **This completes the buildable portion
of the AI Upgrade Roadmap** — Tier 1 and Tier 2 are fully complete, and
this is the one Tier 3 item that didn't require a new vendor/API key. The
remaining Tier 3 items (WhatsApp-native AI conversations, AI-generated
imagery, voice AI for phone orders) are documented in the "Pending items"
list at the top of this README rather than built, since each genuinely
needs something only the founder can provide.
