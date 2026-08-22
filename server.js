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
// INDIA POST — real Bulk Customer API (booking, tracking, events)
// =====================================================================
//
// This is the actual official India Post integration from the approach
// document Sushil received. Two modes, picked by INDIAPOST_BASE_URL:
//   Sandbox (default): https://test.cept.gov.in  - safe to test against,
//     uses India Post's own published shared test values below.
//   Production: whatever URL India Post gives after UAT sign-off.
//
// Credentials (INDIAPOST_USERNAME / INDIAPOST_PASSWORD) go straight into
// Render's environment variables - never typed here, never seen by Claude -
// same pattern as SHOPIFY_API_SECRET.

const INDIAPOST_FILE = path.join(__dirname, "data", "indiapost.json");
if (!fs.existsSync(INDIAPOST_FILE)) {
  fs.writeFileSync(
    INDIAPOST_FILE,
    JSON.stringify({ accessToken: null, refreshToken: null, expiresAt: 0, barcodeSeq: null }, null, 2)
  );
}

function indiaPostBase() {
  return process.env.INDIAPOST_BASE_URL || "https://test.cept.gov.in";
}

// Non-secret shared UAT reference values from the approach doc (customer ID
// range identifiers, not credentials). The actual login (INDIAPOST_USERNAME /
// INDIAPOST_PASSWORD) is REQUIRED as env vars - no default, no fallback, so
// nothing resembling a real credential ever lives in this file.
const INDIAPOST_DEFAULTS = {
  bulkCustomerId: "3000064781",
  contractId: "41585456", // maps to SP_INLAND_DOC / SP_INLAND_PARCEL
  barcodePrefix: "ET",
  barcodeRangeStart: 21433001,
  barcodeRangeEnd: 21434000,
};

async function indiaPostLogin() {
  const state = readJson(INDIAPOST_FILE);
  if (state.accessToken && state.expiresAt > Date.now() + 30000) {
    return state.accessToken;
  }
  if (!process.env.INDIAPOST_USERNAME || !process.env.INDIAPOST_PASSWORD) {
    throw new Error(
      "INDIAPOST_USERNAME and INDIAPOST_PASSWORD env vars are not set. Add them in Render (the sandbox login India Post gave you), then retry."
    );
  }
  const resp = await fetchFn(`${indiaPostBase()}/beextcustomer/v1/access/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: process.env.INDIAPOST_USERNAME,
      password: process.env.INDIAPOST_PASSWORD,
    }),
  });
  const data = await resp.json();
  if (!data.success || !data.data || !data.data.access_token) {
    throw new Error("India Post login failed: " + JSON.stringify(data));
  }
  const newState = {
    ...state,
    accessToken: data.data.access_token,
    refreshToken: data.data.refresh_token,
    expiresAt: Date.now() + (data.data.expires_in || 300) * 1000,
  };
  writeJson(INDIAPOST_FILE, newState);
  return newState.accessToken;
}

async function indiaPostFetch(pathAndQuery, options = {}) {
  const token = await indiaPostLogin();
  const resp = await fetchFn(`${indiaPostBase()}${pathAndQuery}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  return resp.json();
}

// UPU S10 check-digit algorithm - standard formula used on every India Post
// / international tracking barcode (2 letters + 8 digits + check digit + "IN").
function s10CheckDigit(eightDigits) {
  const weights = [8, 6, 4, 2, 3, 5, 9, 7];
  const sum = eightDigits.split("").reduce((s, d, i) => s + Number(d) * weights[i], 0);
  const rem = sum % 11;
  if (rem === 1) return 0;
  if (rem === 0) return 5;
  return 11 - rem;
}

function nextBarcode() {
  const state = readJson(INDIAPOST_FILE);
  const prefix = process.env.INDIAPOST_BARCODE_PREFIX || INDIAPOST_DEFAULTS.barcodePrefix;
  const start = Number(process.env.INDIAPOST_BARCODE_START || INDIAPOST_DEFAULTS.barcodeRangeStart);
  const end = Number(process.env.INDIAPOST_BARCODE_END || INDIAPOST_DEFAULTS.barcodeRangeEnd);
  let seq = state.barcodeSeq || start;
  if (seq > end) throw new Error("India Post barcode range exhausted - ask India Post for a new range.");
  const eightDigits = String(seq).padStart(8, "0");
  const check = s10CheckDigit(eightDigits);
  const barcode = `${prefix}${eightDigits}${check}IN`;
  writeJson(INDIAPOST_FILE, { ...state, barcodeSeq: seq + 1 });
  return barcode;
}

// Looks up a delivery post office for a PIN code - used to resolve the
// customer's own PIN to a specific office_id where needed.
app.get("/api/indiapost/pincode/:pincode", requireApiKey, async (req, res) => {
  try {
    const data = await indiaPostFetch(
      `/bemasterdata/v1/offices/limited-details?pincode=${req.params.pincode}&limit=50&office-type=post`
    );
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Books one order with India Post - the real thing, no browser typing.
// Body: { orderId } to pull from our own orders.json, OR pass the order
// fields directly: { name, address, city, state, pincode, mobile, product,
// weightGrams, codAmount }.
app.post("/api/indiapost/book", requireApiKey, async (req, res) => {
  try {
    let order = req.body;
    if (req.body.orderId) {
      const orders = readJson(ORDERS_FILE);
      order = orders.find((o) => o.id === req.body.orderId);
      if (!order) return res.status(404).json({ error: "orderId not found in orders.json" });
    }

    const weight = Number(order.weightGrams) || Number(process.env.INDIAPOST_DEFAULT_WEIGHT_GRAMS) || 300;
    const articleType = weight > 500 ? "SP_INLAND_PARCEL" : "SP_INLAND_DOC";
    const barcode = nextBarcode();

    const dropoffOfficeId = process.env.INDIAPOST_DROPOFF_OFFICE_ID;
    if (!dropoffOfficeId) {
      return res.status(500).json({
        error:
          "INDIAPOST_DROPOFF_OFFICE_ID not set. Look it up once via GET /api/indiapost/pincode/<your PIN> and put the office_id (where delivery_office_flag is true) into Render's env vars.",
      });
    }

    const article = {
      bulk_customer_id: process.env.INDIAPOST_BULK_CUSTOMER_ID || INDIAPOST_DEFAULTS.bulkCustomerId,
      contract_id: process.env.INDIAPOST_CONTRACT_ID || INDIAPOST_DEFAULTS.contractId,
      barcode_no: barcode,
      pickup_or_dropoff: "dropoff",
      pickup_dropoff_office_id: Number(dropoffOfficeId),
      article_type: articleType,
      physical_weight: weight,
      shape_of_article: "NROL",
      length: "10",
      breadth_diameter: "10",
      height: "5",
      sender_name: process.env.INDIAPOST_SENDER_NAME || "AIRX Plus Healthcare Pvt Ltd",
      sender_company: process.env.INDIAPOST_SENDER_NAME || "AIRX Plus Healthcare Pvt Ltd",
      sender_add_line_1: process.env.INDIAPOST_SENDER_ADDRESS || "Nimbahera",
      sender_city: process.env.INDIAPOST_SENDER_CITY || "Nimbahera",
      sender_state: process.env.INDIAPOST_SENDER_STATE || "Rajasthan",
      sender_pincode: process.env.INDIAPOST_SENDER_PINCODE || "",
      sender_mobile_no: process.env.INDIAPOST_SENDER_MOBILE || "",
      receiver_name: order.name || "",
      receiver_company: order.name || "",
      receiver_add_line_1: (order.address || order.dest || "").slice(0, 80),
      receiver_city: order.city || "",
      receiver_state: order.state || "",
      receiver_pincode: String(order.pincode || order.pin || "").slice(0, 6),
      receiver_mobile_no: String(order.mobile || "").replace(/\D/g, "").slice(0, 10),
      alt_address_flag: "FALSE",
      pickup_address_flag: "FALSE",
      codr_cod: order.codAmount || order.cod ? "COD" : "",
      value_for_codr_cod: order.codAmount || order.cod || 0,
      ack: "FALSE",
      reg: "FALSE",
      otp: "FALSE",
    };

    const result = await indiaPostFetch(
      `/beextcustomer/process-articles/${process.env.INDIAPOST_BULK_CUSTOMER_ID || INDIAPOST_DEFAULTS.bulkCustomerId}`,
      { method: "POST", body: JSON.stringify({ articles: [article] }) }
    );

    // If this order came from our own orders.json, save the barcode + mark ready-to-advance.
    if (req.body.orderId) {
      const orders = readJson(ORDERS_FILE);
      const idx = orders.findIndex((o) => o.id === req.body.orderId);
      if (idx !== -1) {
        orders[idx].indiaPostBarcode = barcode;
        orders[idx].indiaPostResult = result;
        writeJson(ORDERS_FILE, orders);
      }
    }

    res.json({ barcode, result });
  } catch (err) {
    console.error("India Post booking error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Tracking for up to 500 barcodes at once.
app.post("/api/indiapost/track", requireApiKey, async (req, res) => {
  try {
    const barcodes = req.body.barcodes;
    if (!Array.isArray(barcodes) || !barcodes.length) {
      return res.status(400).json({ error: "body must be { barcodes: [\"EB...IN\", ...] }" });
    }
    const data = await indiaPostFetch("/beextcustomer/v1/tracking/bulk", {
      method: "POST",
      body: JSON.stringify({ bulk: barcodes }),
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Real-time event webhook - India Post pushes tracking updates here once
// they whitelist this server's outbound IP (ask integrations.cept@indiapost.gov.in
// for the whitelisting step once you're in production). No signature scheme
// was specified in the approach doc, so this just logs + stores by barcode.
app.post("/webhook/indiapost/event", (req, res) => {
  try {
    const event = req.body;
    const orders = readJson(ORDERS_FILE);
    const idx = orders.findIndex((o) => o.indiaPostBarcode === event.article_number);
    if (idx !== -1) {
      orders[idx].indiaPostEvents = orders[idx].indiaPostEvents || [];
      orders[idx].indiaPostEvents.push(event);
      if (event.event_code === "ITEM_DELIVERED" || event.event_description === "Item Delivered") {
        orders[idx].status = "delivered";
      }
      writeJson(ORDERS_FILE, orders);
      console.log("India Post event for", event.article_number, ":", event.event_description);
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("India Post webhook error:", err);
    res.sendStatus(200); // still 200 so India Post doesn't keep retrying a bad payload
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
