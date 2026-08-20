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

## 4. Next step (already planned)

Once this is live, I'll wire the AIRX Ops dashboard to read `/api/leads`,
`/api/orders`, and trigger `/api/shopify/*` from here instead of relying on
manual paste — that gets rid of the browser-storage limitation AIRX Ops has
today, and gives every device (you, staff, phone) the same live data.
