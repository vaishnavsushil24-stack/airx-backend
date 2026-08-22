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

### 4a. Fix the IP whitelisting block (needs a decision from you)

India Post's whitelist form only accepts **individual IPv4 addresses** — no
IP ranges. Render's free tier doesn't give this server one fixed address; it
shares a pool of ~500 addresses (`74.220.48.0/24` and `74.220.56.0/24`), so
there's no single IP I can hand India Post that will reliably match every
request. I found two ways to get this server a real, whitelistable static
IP — this is a real recurring cost either way, so I didn't want to spend
your money without asking:

| Option | Cost | Notes |
|---|---|---|
| **QuotaGuard Static** (via Render, officially documented at render.com/docs/quotaguard) | **$19/mo**, 3-day free trial | Just an env var (`QUOTAGUARDSTATIC_URL`) — no server changes needed once set. 20,000 requests/month is far more than this business needs. **This is what I'd pick.** |
| Render's own Dedicated IP add-on | $25/mo (Pro plan, required first) + $100/mo per IP set = **~$125/mo** | Much more expensive for the same result — only makes sense at real enterprise scale. |

**What I need from you:** sign up for QuotaGuard's free trial at
quotaguard.com (or tell me to go with the Render Dedicated IP option
instead), then either paste me the `QUOTAGUARDSTATIC_URL` value they give
you (safe to share — it's a proxy address, not a password) or add it
yourself as an env var named `QUOTAGUARDSTATIC_URL` in Render. Once that
exists, tell me and I'll wire the India Post calls to route through it, get
the resulting static IP whitelisted on the India Post portal
(`/customer-selfservice/whitelist-ip-address`), and re-test end-to-end.

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
