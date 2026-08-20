// AIRX Ops backend
// - Receives Meta (Facebook) Lead Ads leads automatically via webhook (no human touch)
// - Stores them in leads.json (swap for a real DB later if volume grows)
// - Exposes a small API the AIRX Ops dashboard (or any future frontend) can read/write
//
// Run locally:   npm install && npm start
// Deploy:        push this folder to Render / Railway / Fly.io (see README.md)

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

let fetchFn = global.fetch;
if (!fetchFn) {
  fetchFn = require("node-fetch");
}

const app = express();
const PORT = process.env.PORT || 3000;
const LEADS_FILE = path.join(__dirname, "data", "leads.json");
const ORDERS_FILE = path.join(__dirname, "data", "orders.json");
const SHOP_FILE = path.join(__dirname, "data", "shopify.json");

// Keep the raw body around (needed to verify Meta's signature) while still parsing JSON.
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ---------- tiny file-based storage ----------
function ensureDataFiles() {
  const dir = path.join(__dirname, "data");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(LEADS_FILE)) fs.writeFileSync(LEADS_FILE, "[]");
  if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, "[]");
  if (!fs.existsSync(SHOP_FILE)) fs.writeFileSync(SHOP_FILE, "{}");
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
ensureDataFiles();

// ---------- simple API key guard for our own endpoints ----------
function requireApiKey(req, res, next) {
  const key = req.header("x-api-key");
  if (!process.env.AIRX_API_KEY || key !== process.env.AIRX_API_KEY) {
    return res.status(401).json({ error: "invalid or missing x-api-key" });
  }
  next();
}

// =====================================================================
// META (FACEBOOK) LEAD ADS WEBHOOK
// =====================================================================

// Step 1 of Meta's setup: Meta calls this once with a GET to verify you own
// the endpoint. Must echo back hub.challenge if the verify token matches.
app.get("/webhook/meta", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
    console.log("Meta webhook verified successfully.");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Step 2: every time someone fills your Meta Lead Ad form, Meta POSTs a
// lightweight "a lead exists" notification here. We then call the Graph API
// to fetch the actual name/phone/email, and store it - fully automatic.
app.post("/webhook/meta", async (req, res) => {
  // Acknowledge immediately - Meta expects a fast 200, retries if you're slow.
  res.sendStatus(200);

  try {
    if (!verifyMetaSignature(req)) {
      console.warn("Meta webhook: signature check failed, ignoring payload.");
      return;
    }

    const entries = req.body.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        if (change.field !== "leadgen") continue;
        const leadgenId = change.value.leadgen_id;
        const formId = change.value.form_id;
        const pageId = change.value.page_id;
        await fetchAndStoreLead(leadgenId, { formId, pageId });
      }
    }
  } catch (err) {
    console.error("Error processing Meta webhook payload:", err);
  }
});

function verifyMetaSignature(req) {
  const signature = req.header("x-hub-signature-256");
  if (!signature || !process.env.META_APP_SECRET) return false;
  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", process.env.META_APP_SECRET)
      .update(req.rawBody)
      .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function fetchAndStoreLead(leadgenId, meta) {
  const url = `https://graph.facebook.com/v21.0/${leadgenId}?access_token=${process.env.META_PAGE_ACCESS_TOKEN}`;
  const resp = await fetchFn(url);
  const data = await resp.json();

  if (data.error) {
    console.error("Graph API error fetching lead", leadgenId, data.error);
    return;
  }

  // Meta returns field_data as an array of {name, values:[...]}. Flatten it.
  const fields = {};
  (data.field_data || []).forEach((f) => {
    fields[f.name] = (f.values || [])[0] || "";
  });

  const lead = {
    id: leadgenId,
    createdAt: data.created_time || new Date().toISOString(),
    formId: meta.formId,
    pageId: meta.pageId,
    name: fields.full_name || fields.name || "",
    phone: fields.phone_number || fields.phone || "",
    email: fields.email || "",
    raw: fields,
    status: "new", // new -> contacted -> converted -> lost  (staff/Wetroo-replacement updates this)
  };

  const leads = readJson(LEADS_FILE);
  if (!leads.some((l) => l.id === lead.id)) {
    leads.unshift(lead);
    writeJson(LEADS_FILE, leads);
    console.log("Stored new Meta lead:", lead.name || lead.id);
  }
}

// =====================================================================
// SHOPIFY — OAuth install + order sync + fulfillment writeback
// =====================================================================
//
// Why OAuth instead of a static token: apps created in the new Shopify Dev
// Dashboard (the one you now use, custom apps are retired) authenticate via
// OAuth using the app's Client ID + Secret. Visit /shopify/install once
// (after setting SHOPIFY_API_KEY/SHOPIFY_API_SECRET/SHOPIFY_SHOP below and
// deploying), approve on Shopify, and this server stores the resulting
// Admin API access token itself — nobody has to copy/paste a token by hand.

const SHOPIFY_SCOPES =
  "read_orders,write_orders,read_fulfillments,write_fulfillments,read_customers,read_products";

app.get("/shopify/install", (req, res) => {
  const shop = process.env.SHOPIFY_SHOP; // e.g. airx-plus-healthcare-pvt-ltd.myshopify.com
  const apiKey = process.env.SHOPIFY_API_KEY;
  if (!shop || !apiKey) {
    return res.status(500).send("Set SHOPIFY_SHOP and SHOPIFY_API_KEY env vars first.");
  }
  const redirectUri = `${baseUrl(req)}/shopify/callback`;
  const state = crypto.randomBytes(16).toString("hex");
  const url =
    `https://${shop}/admin/oauth/authorize?client_id=${apiKey}` +
    `&scope=${encodeURIComponent(SHOPIFY_SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}`;
  res.redirect(url);
});

app.get("/shopify/callback", async (req, res) => {
  try {
    const { shop, code, hmac } = req.query;
    if (!shop || !code) return res.status(400).send("Missing shop or code.");
    if (!verifyShopifyHmac(req.query, hmac)) return res.status(400).send("HMAC check failed.");

    const tokenResp = await fetchFn(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code,
      }),
    });
    const tokenData = await tokenResp.json();
    if (!tokenData.access_token) {
      console.error("Shopify token exchange failed:", tokenData);
      return res.status(400).send("Could not get access token from Shopify.");
    }

    writeJson(SHOP_FILE, { shop, accessToken: tokenData.access_token, connectedAt: new Date().toISOString() });
    console.log("Shopify connected for", shop);
    res.send("Shopify connected! You can close this tab.");
  } catch (err) {
    console.error("Shopify callback error:", err);
    res.status(500).send("Something went wrong connecting Shopify.");
  }
});

function baseUrl(req) {
  return process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
}

function verifyShopifyHmac(query, hmac) {
  if (!hmac || !process.env.SHOPIFY_API_SECRET) return false;
  const { hmac: _drop, signature: _drop2, ...rest } = query;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(",") : rest[k]}`)
    .join("&");
  const digest = crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET)
    .update(message)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
  } catch {
    return false;
  }
}

async function shopifyFetch(pathAndQuery, options = {}) {
  const { shop, accessToken } = readJson(SHOP_FILE);
  if (!shop || !accessToken) throw new Error("Shopify not connected yet - visit /shopify/install first.");
  const resp = await fetchFn(`https://${shop}/admin/api/2024-10${pathAndQuery}`, {
    ...options,
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  return resp.json();
}

// Pull recent Shopify orders into our own orders list, so they show up in
// AIRX Ops next to WhatsApp-sourced orders instead of only living in Shopify.
app.post("/api/shopify/sync-orders", requireApiKey, async (req, res) => {
  try {
    const data = await shopifyFetch("/orders.json?status=any&limit=50");
    const orders = readJson(ORDERS_FILE);
    let added = 0;
    (data.orders || []).forEach((so) => {
      const existingId = "shopify-" + so.id;
      if (orders.some((o) => o.id === existingId)) return;
      orders.unshift({
        id: existingId,
        source: "shopify",
        shopifyOrderId: so.id,
        createdAt: so.created_at,
        name: so.shipping_address
          ? `${so.shipping_address.first_name || ""} ${so.shipping_address.last_name || ""}`.trim()
          : so.customer
          ? `${so.customer.first_name || ""} ${so.customer.last_name || ""}`.trim()
          : "",
        mobile: (so.shipping_address && so.shipping_address.phone) || so.phone || "",
        address: so.shipping_address
          ? [so.shipping_address.address1, so.shipping_address.city, so.shipping_address.province, so.shipping_address.pin]
              .filter(Boolean)
              .join(", ")
          : "",
        pin: so.shipping_address ? so.shipping_address.zip : "",
        product: (so.line_items || []).map((li) => `${li.title} x${li.quantity}`).join(", "),
        codAmount: so.total_price,
        fulfillmentStatus: so.fulfillment_status || "unfulfilled",
        status: "new",
      });
      added++;
    });
    writeJson(ORDERS_FILE, orders);
    res.json({ synced: added, total: orders.length });
  } catch (err) {
    console.error("Shopify sync error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Once an order is booked with India Post, call this so Shopify stops
// showing it as "Unfulfilled" forever - this closes the gap we found where
// all 262 orders sat unfulfilled even though they'd actually shipped.
app.post("/api/shopify/fulfill", requireApiKey, async (req, res) => {
  try {
    const { shopifyOrderId, trackingNumber, trackingCompany } = req.body;
    if (!shopifyOrderId) return res.status(400).json({ error: "shopifyOrderId required" });

    const foList = await shopifyFetch(`/orders/${shopifyOrderId}/fulfillment_orders.json`);
    const fulfillmentOrderId = foList.fulfillment_orders?.[0]?.id;
    if (!fulfillmentOrderId) return res.status(404).json({ error: "No fulfillment order found" });

    const result = await shopifyFetch("/fulfillments.json", {
      method: "POST",
      body: JSON.stringify({
        fulfillment: {
          line_items_by_fulfillment_order: [{ fulfillment_order_id: fulfillmentOrderId }],
          tracking_info: {
            number: trackingNumber || "",
            company: trackingCompany || "India Post - Speed Post",
          },
          notify_customer: true,
        },
      }),
    });
    res.json(result);
  } catch (err) {
    console.error("Shopify fulfill error:", err);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// SIMPLE API for the AIRX Ops dashboard (leads + orders)
// =====================================================================

app.get("/api/leads", requireApiKey, (req, res) => {
  res.json(readJson(LEADS_FILE));
});

app.patch("/api/leads/:id", requireApiKey, (req, res) => {
  const leads = readJson(LEADS_FILE);
  const idx = leads.findIndex((l) => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  leads[idx] = { ...leads[idx], ...req.body };
  writeJson(LEADS_FILE, leads);
  res.json(leads[idx]);
});

app.get("/api/orders", requireApiKey, (req, res) => {
  res.json(readJson(ORDERS_FILE));
});

app.post("/api/orders", requireApiKey, (req, res) => {
  const orders = readJson(ORDERS_FILE);
  const order = { id: "o" + Date.now(), createdAt: new Date().toISOString(), ...req.body };
  orders.unshift(order);
  writeJson(ORDERS_FILE, orders);
  res.json(order);
});

app.patch("/api/orders/:id", requireApiKey, (req, res) => {
  const orders = readJson(ORDERS_FILE);
  const idx = orders.findIndex((o) => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  orders[idx] = { ...orders[idx], ...req.body };
  writeJson(ORDERS_FILE, orders);
  res.json(orders[idx]);
});

app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`AIRX backend listening on port ${PORT}`);
});
