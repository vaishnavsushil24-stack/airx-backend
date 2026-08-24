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
const net = require("net");
const tls = require("tls");
require("dotenv").config();

let fetchFn = global.fetch;
if (!fetchFn) {
  fetchFn = require("node-fetch");
}

// node-fetch is used explicitly (not the global/undici fetch) for any request
// that needs to go through a proxy, since only node-fetch accepts a plain
// Node http(s).Agent - the global fetch (undici) does not.
const nodeFetch = require("node-fetch");
const { HttpsProxyAgent } = require("https-proxy-agent");

// Phase 0 of the store.airxplus.com / admin.airxplus.com integration —
// see MLM_INTEGRATION_PLAN.md. Products/franchises/members/etc. live in a
// real SQLite database (db.js) rather than flat JSON files.
const { db } = require("./db.js");

const app = express();
const PORT = process.env.PORT || 3000;
const LEADS_FILE = path.join(__dirname, "data", "leads.json");
const ORDERS_FILE = path.join(__dirname, "data", "orders.json");
const SHOP_FILE = path.join(__dirname, "data", "shopify.json");

// CORS — needed so the legacy-data migration (Phase 5) can run fetch()
// calls directly from admin.airxplus.com's own page context straight into
// this API (still guarded by requireApiKey below; CORS only controls which
// browser origins are allowed to READ the response, not who can guess the
// key). No new dependency — plain Express headers, since npm installs
// aren't available in the build environment this was developed in.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, x-api-key, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Keep the raw body around (needed to verify Meta's signature) while still parsing JSON.
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Admin dashboard (public/admin.html) — a small same-origin single-page
// app covering Phases 1-4 (members, commission settings, payout runs,
// products, franchises, rewards). Same-origin means it can call the API
// directly with no CORS involved; the API key the admin enters is stored
// only in that browser's localStorage. Reachable at /admin or /.
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.redirect("/admin.html"));
app.get("/admin", (req, res) => res.redirect("/admin.html"));

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

// ---------- Phase 8: multi-user admin auth (Admin/User/UserGroup/Permissions) ----------
// requireApiKey (above) is untouched and keeps working exactly as before —
// it's now the "system/master" credential. requireAccess(moduleKey) is the
// new guard: it accepts EITHER the same master x-api-key (unrestricted, for
// backward compatibility with anything already using it) OR a per-user
// session token whose role grants that specific module.

const MODULE_KEYS = [
  "dashboard",
  "members",
  "masters",
  "commission",
  "payouts",
  "accounts",
  "reports",
  "products",
  "franchises",
  "rewards",
  "cms",
  "user_management",
];

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const attempt = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(attempt, "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function loadSession(token) {
  if (!token) return null;
  const session = db.prepare("SELECT * FROM admin_sessions WHERE token = ?").get(token);
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    db.prepare("DELETE FROM admin_sessions WHERE id = ?").run(session.id);
    return null;
  }
  const user = db.prepare("SELECT * FROM admin_users WHERE id = ?").get(session.user_id);
  if (!user || user.status !== "Active") return null;
  const role = db.prepare("SELECT * FROM admin_roles WHERE id = ?").get(user.role_id);
  if (!role) return null;
  let permissions = [];
  try {
    permissions = JSON.parse(role.permissions);
  } catch (e) {
    permissions = [];
  }
  db.prepare("UPDATE admin_sessions SET last_seen_at = datetime('now') WHERE id = ?").run(session.id);
  return { session, user, role, permissions };
}

function requireAccess(moduleKey) {
  return (req, res, next) => {
    const apiKey = req.header("x-api-key");
    if (process.env.AIRX_API_KEY && apiKey === process.env.AIRX_API_KEY) {
      req.identity = { type: "system", permissions: ["*"] };
      return next();
    }
    const auth = req.header("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
    const loaded = loadSession(token);
    if (!loaded) {
      return res.status(401).json({ error: "invalid or missing credentials (x-api-key or Authorization: Bearer <token>)" });
    }
    if (!loaded.permissions.includes("*") && !loaded.permissions.includes(moduleKey)) {
      return res.status(403).json({ error: `user "${loaded.user.username}" does not have access to "${moduleKey}"` });
    }
    req.identity = { type: "admin_user", user: loaded.user, role: loaded.role, permissions: loaded.permissions };
    next();
  };
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

// India Post's sandbox only accepts calls from IPs you've whitelisted on
// their Customer Self Service Portal (Settings -> Whitelist my IP Address).
// Render's free tier doesn't have one fixed outbound IP, so all India Post
// calls are routed through a small $4/mo proxy server (a DigitalOcean
// droplet) that DOES have one fixed IP - that's the IP that's whitelisted.
// Set INDIAPOST_PROXY_URL (e.g. http://user:pass@1.2.3.4:8888) in Render to
// enable this. Leave it unset and calls go out directly (will keep failing
// with "fetch failed" until either this proxy or a whitelisted IP exists).
function indiaPostAgent() {
  if (!process.env.INDIAPOST_PROXY_URL) return undefined;
  return new HttpsProxyAgent(process.env.INDIAPOST_PROXY_URL);
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
  const resp = await nodeFetch(`${indiaPostBase()}/beextcustomer/v1/access/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: process.env.INDIAPOST_USERNAME,
      password: process.env.INDIAPOST_PASSWORD,
    }),
    agent: indiaPostAgent(),
    // Without this, a dead/unreachable proxy hangs this request (and the whole
    // /api/indiapost/* call) forever instead of failing with a clear error.
    timeout: 15000,
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
  const resp = await nodeFetch(`${indiaPostBase()}${pathAndQuery}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    agent: options.agent || indiaPostAgent(),
    timeout: options.timeout || 15000,
  });
  return resp.json();
}

// Raw TCP connect probe - tells us whether something is actually listening on
// a given host:port, from Render's own network (which has normal, unrestricted
// outbound access, unlike a sandboxed dev environment). "open" = something
// accepted the connection, "refused-or-error" = the host answered but nothing
// is listening on that port (or actively rejected it), "timeout" = no answer
// at all (host down, or a firewall silently dropping the packets).
function tcpProbe(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ port, ms: Date.now() - start, ...result });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish({ status: "open" }));
    socket.once("timeout", () => finish({ status: "timeout" }));
    socket.once("error", (err) => finish({ status: "refused-or-error", error: err.code || String(err) }));
    socket.connect(port, host);
  });
}

// Where the droplet's cloud-init script "phones home" with tinyproxy's status
// (systemctl is-active, ss -tlnp output, journal tail) so we can see what
// happened at boot without ever needing SSH access to the droplet itself.
const PROXY_STATUS_FILE = path.join(__dirname, "data", "proxy-status-reports.json");
if (!fs.existsSync(PROXY_STATUS_FILE)) {
  fs.writeFileSync(PROXY_STATUS_FILE, "[]");
}

app.post(
  "/api/diag/proxy-status-report",
  express.text({ type: "*/*", limit: "200kb" }),
  (req, res) => {
    if (req.headers["x-diag-key"] !== "airx-diag-check-2026") {
      return res.status(401).json({ error: "unauthorized" });
    }
    let reports = [];
    try {
      reports = readJson(PROXY_STATUS_FILE);
      if (!Array.isArray(reports)) reports = [];
    } catch {
      reports = [];
    }
    reports.push({ receivedAt: new Date().toISOString(), body: String(req.body || "").slice(0, 8000) });
    writeJson(PROXY_STATUS_FILE, reports.slice(-20));
    res.json({ ok: true });
  }
);

app.get("/api/diag/proxy-status-report", (req, res) => {
  if (req.headers["x-diag-key"] !== "airx-diag-check-2026") {
    return res.status(401).json({ error: "unauthorized" });
  }
  let reports = [];
  try {
    reports = readJson(PROXY_STATUS_FILE);
    if (!Array.isArray(reports)) reports = [];
  } catch {
    reports = [];
  }
  res.json(reports);
});

// Diagnostic endpoint to check whether the India Post proxy chain (this server
// -> DigitalOcean tinyproxy -> India Post sandbox) is actually working, without
// needing the AIRX_API_KEY - uses its own fixed, non-secret check header so this
// can be tested independently while debugging connectivity. Doesn't expose any
// credentials - only port-open/closed status and whether login succeeded.
app.get("/api/diag/indiapost-proxy", async (req, res) => {
  if (req.headers["x-diag-key"] !== "airx-diag-check-2026") {
    return res.status(401).json({ error: "unauthorized" });
  }
  const start = Date.now();
  const proxyConfigured = !!process.env.INDIAPOST_PROXY_URL;
  // ?host=1.2.3.4 lets us probe a candidate droplet (e.g. one not wired into
  // INDIAPOST_PROXY_URL yet) before ever pointing production traffic at it.
  const hostOverride = typeof req.query.host === "string" && req.query.host ? req.query.host : null;
  let dropletHost = hostOverride;
  if (!dropletHost) {
    try {
      dropletHost = process.env.INDIAPOST_PROXY_URL
        ? new URL(process.env.INDIAPOST_PROXY_URL).hostname
        : null;
    } catch {
      dropletHost = null;
    }
  }
  const probes = dropletHost
    ? await Promise.all([22, 80, 8888].map((p) => tcpProbe(dropletHost, p)))
    : [];
  let loginResult = null;
  if (!hostOverride) {
    try {
      const token = await indiaPostLogin();
      loginResult = { ok: true, tokenReceived: !!token };
    } catch (err) {
      loginResult = { ok: false, error: String((err && err.message) || err) };
    }
  }
  res.json({ ms: Date.now() - start, proxyConfigured, dropletHost, hostOverride: !!hostOverride, probes, loginResult });
});

// Lower-level diagnostic: sends a raw HTTP CONNECT request straight to the
// tinyproxy port and captures tinyproxy's own response line/headers, WITHOUT
// attempting the TLS handshake afterwards. This tells us exactly what
// tinyproxy says (200 = tunnel opened fine, 407 = auth rejected, 403 =
// ConnectPort not allowed, connection reset = something else) instead of
// just "TLS failed", which could be caused by several different problems.
app.get("/api/diag/proxy-connect-test", async (req, res) => {
  if (req.headers["x-diag-key"] !== "airx-diag-check-2026") {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    if (!process.env.INDIAPOST_PROXY_URL) {
      return res.status(400).json({ error: "INDIAPOST_PROXY_URL not set" });
    }
    const proxyUrl = new URL(process.env.INDIAPOST_PROXY_URL);
    const target = req.query.target || "test.cept.gov.in:443";
    const auth = proxyUrl.username
      ? "Basic " + Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString("base64")
      : null;

    const result = await new Promise((resolve, reject) => {
      const socket = net.connect(Number(proxyUrl.port), proxyUrl.hostname);
      let data = "";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("timed out waiting for CONNECT response"));
      }, 10000);
      socket.on("connect", () => {
        const lines = [
          `CONNECT ${target} HTTP/1.1`,
          `Host: ${target}`,
          ...(auth ? [`Proxy-Authorization: ${auth}`] : []),
          `Connection: close`,
          "",
          "",
        ];
        socket.write(lines.join("\r\n"));
      });
      socket.on("data", (chunk) => {
        data += chunk.toString("utf8");
        // We only need the response head; bail as soon as we see the blank
        // line terminating the headers (or after a short grace period).
        if (data.includes("\r\n\r\n")) {
          clearTimeout(timer);
          socket.destroy();
          resolve(data);
        }
      });
      socket.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.on("close", () => {
        clearTimeout(timer);
        resolve(data || "(connection closed with no data)");
      });
    });
    res.json({ target, authSent: !!auth, rawResponseHead: result.slice(0, 1000) });
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
});

// Goes one step further than /api/diag/proxy-connect-test: after tinyproxy
// confirms "200 Connection established", attempts the actual TLS handshake
// over that same raw tunnel (using Node's tls module directly, bypassing
// node-fetch/https-proxy-agent entirely) so we can tell whether the problem
// is generic to any TLS-through-this-tunnel, or specific to the
// node-fetch/https-proxy-agent code path used by the real login call.
app.get("/api/diag/proxy-tls-test", async (req, res) => {
  if (req.headers["x-diag-key"] !== "airx-diag-check-2026") {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    if (!process.env.INDIAPOST_PROXY_URL) {
      return res.status(400).json({ error: "INDIAPOST_PROXY_URL not set" });
    }
    const proxyUrl = new URL(process.env.INDIAPOST_PROXY_URL);
    const targetHost = req.query.target || "test.cept.gov.in";
    const targetPort = 443;
    const auth = proxyUrl.username
      ? "Basic " + Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString("base64")
      : null;

    const result = await new Promise((resolve, reject) => {
      const socket = net.connect(Number(proxyUrl.port), proxyUrl.hostname);
      let head = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error("timed out waiting for CONNECT response"));
      }, 10000);

      socket.on("connect", () => {
        const lines = [
          `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
          `Host: ${targetHost}:${targetPort}`,
          ...(auth ? [`Proxy-Authorization: ${auth}`] : []),
          `Connection: keep-alive`,
          "",
          "",
        ];
        socket.write(lines.join("\r\n"));
      });

      socket.on("data", function onData(chunk) {
        head += chunk.toString("utf8");
        if (head.includes("\r\n\r\n")) {
          socket.removeListener("data", onData);
          if (settled) return;
          if (!/^HTTP\/1\.[01] 200/.test(head)) {
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            return resolve({ stage: "connect", ok: false, head });
          }
          // Tunnel is open - now attempt a real TLS handshake over it.
          const tlsSocket = tls.connect(
            { socket, servername: targetHost, timeout: 10000 },
            () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              const cert = tlsSocket.getPeerCertificate();
              tlsSocket.destroy();
              resolve({
                stage: "tls",
                ok: true,
                protocol: tlsSocket.getProtocol(),
                subject: cert && cert.subject,
              });
            }
          );
          tlsSocket.on("error", (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ stage: "tls", ok: false, error: String((err && err.message) || err) });
          });
        }
      });

      socket.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    });

    res.json({ target: `${targetHost}:${targetPort}`, ...result });
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
});

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
    const barcode = nextBarcode();

    const dropoffOfficeId = process.env.INDIAPOST_DROPOFF_OFFICE_ID;
    if (!dropoffOfficeId) {
      return res.status(500).json({
        error:
          "INDIAPOST_DROPOFF_OFFICE_ID not set. Look it up once via GET /api/indiapost/pincode/<your PIN> and put the office_id (where delivery_office_flag is true) into Render's env vars.",
      });
    }

    // Field names/types/enum values here match the official schema published
    // in the Customer Self Service Portal's API documentation (found Aug 2026,
    // supersedes the older approach-doc guesses this was originally built from).
    const article = {
      bulk_customer_id: Number(process.env.INDIAPOST_BULK_CUSTOMER_ID || INDIAPOST_DEFAULTS.bulkCustomerId),
      contract_id: Number(process.env.INDIAPOST_CONTRACT_ID || INDIAPOST_DEFAULTS.contractId),
      barcode_no: barcode,
      pickup_or_dropoff: "DROPOFF",
      pickup_dropoff_office_id: Number(dropoffOfficeId),
      article_type: "SP", // allowed values are just "SP" (Speed Post) or "BP" (Bulk Parcel)
      physical_weight: weight,
      shape_of_article: "NROL",
      length: 10,
      breadth_diameter: 10,
      height: 5,
      drop_off_pincode: process.env.INDIAPOST_SENDER_PINCODE || "",
      bulk_reference: String(order.id || req.body.orderId || `AIRX-${Date.now()}`),
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
      alt_address_flag: false,
      pickup_address_flag: false,
      codr_cod: "COD", // required field; this business is COD-first, so default to COD
      value_for_codr_cod: Number(order.codAmount || order.cod || 0),
      ack: false,
      reg: false,
      otp: false,
    };

    const result = await indiaPostFetch(
      `/beextcustomer/process-articles-file/${process.env.INDIAPOST_BULK_CUSTOMER_ID || INDIAPOST_DEFAULTS.bulkCustomerId}`,
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

    // Booking = committed shipment, so this is the right moment to draw down stock.
    try {
      decrementInventoryForOrder(order);
    } catch (invErr) {
      console.warn("Inventory decrement skipped (non-fatal):", invErr.message);
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

// =====================================================================
// INVENTORY — stock tracking, auto-decrement on booking
// =====================================================================

const INVENTORY_FILE = path.join(__dirname, "data", "inventory.json");
if (!fs.existsSync(INVENTORY_FILE)) {
  fs.writeFileSync(INVENTORY_FILE, "[]");
}
// Each item: { sku, name, stock, lowStockThreshold }

app.get("/api/inventory", requireApiKey, (req, res) => {
  res.json(readJson(INVENTORY_FILE));
});

app.post("/api/inventory", requireApiKey, (req, res) => {
  const items = readJson(INVENTORY_FILE);
  const item = {
    sku: req.body.sku || "sku" + Date.now(),
    name: req.body.name || "",
    stock: Number(req.body.stock) || 0,
    lowStockThreshold: Number(req.body.lowStockThreshold) || 5,
  };
  items.push(item);
  writeJson(INVENTORY_FILE, items);
  res.json(item);
});

app.patch("/api/inventory/:sku", requireApiKey, (req, res) => {
  const items = readJson(INVENTORY_FILE);
  const idx = items.findIndex((i) => i.sku === req.params.sku);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  items[idx] = { ...items[idx], ...req.body };
  writeJson(INVENTORY_FILE, items);
  res.json(items[idx]);
});

app.delete("/api/inventory/:sku", requireApiKey, (req, res) => {
  const items = readJson(INVENTORY_FILE);
  const filtered = items.filter((i) => i.sku !== req.params.sku);
  writeJson(INVENTORY_FILE, filtered);
  res.json({ deleted: items.length !== filtered.length });
});

// Called automatically when an order is booked (see /api/indiapost/book above).
// Orders store product as free text like "Product A x2, Product B x1" (from
// Shopify line items or WhatsApp paste), so we match by name substring rather
// than a strict SKU - approximate but good enough to catch low-stock early.
function decrementInventoryForOrder(order) {
  const productText = order.product || "";
  if (!productText) return;
  const items = readJson(INVENTORY_FILE);
  if (!items.length) return;
  let changed = false;
  productText.split(",").forEach((segment) => {
    const trimmed = segment.trim();
    const qtyMatch = trimmed.match(/x\s*(\d+)\s*$/i);
    const qty = qtyMatch ? Number(qtyMatch[1]) : 1;
    const nameOnly = trimmed.replace(/x\s*\d+\s*$/i, "").trim().toLowerCase();
    if (!nameOnly) return;
    items.forEach((item) => {
      if (item.name && nameOnly.includes(item.name.toLowerCase())) {
        item.stock = Math.max(0, (Number(item.stock) || 0) - qty);
        changed = true;
      }
    });
  });
  if (changed) writeJson(INVENTORY_FILE, items);
}

// =====================================================================
// STAFF PERFORMANCE — who booked what, so staff stays visible/accountable
// =====================================================================

app.get("/api/staff/summary", requireApiKey, (req, res) => {
  const orders = readJson(ORDERS_FILE);
  const byStaff = {};
  orders.forEach((o) => {
    const name = o.staff && o.staff.trim() ? o.staff.trim() : "Unassigned";
    if (!byStaff[name]) {
      byStaff[name] = { staff: name, orders: 0, totalSales: 0, delivered: 0, pending: 0, booked: 0 };
    }
    const bucket = byStaff[name];
    bucket.orders += 1;
    bucket.totalSales += Number(o.codAmount || o.cod || 0);
    if (o.status === "delivered") bucket.delivered += 1;
    else if (o.status === "booked") bucket.booked += 1;
    else bucket.pending += 1;
  });
  res.json(Object.values(byStaff).sort((a, b) => b.totalSales - a.totalSales));
});

// =====================================================================
// WHATSAPP AUTOMATION — scaffolding, activates once WHATSAPP_TOKEN is set
// =====================================================================
//
// Uses Meta's WhatsApp Cloud API directly (same Meta Business Manager as the
// Lead Ads webhook above - one Meta login covers both). Needs, once you have
// a WhatsApp Business Account (WABA) set up in Meta Business Manager:
//   WHATSAPP_TOKEN       - a permanent access token for the WABA
//   WHATSAPP_PHONE_ID    - the "Phone number ID" of your WhatsApp Business number
// Until these are set, sendWhatsApp() just logs and skips - nothing breaks.
//
// IMPORTANT: WhatsApp only allows free-form messages within 24h of the
// customer messaging you first. Outside that window (e.g. proactively
// telling someone their order shipped) requires a pre-approved "template"
// message - approved once in Meta Business Manager, then reused by name.
// sendWhatsApp() supports both: pass `template` for outside-24h messages,
// omit it for a plain text reply inside an active conversation.

async function sendWhatsApp(toPhone, { text, template, templateParams } = {}) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) {
    console.log(`[WhatsApp not configured yet] Would message ${toPhone}:`, text || template);
    return { skipped: true };
  }
  const cleanPhone = String(toPhone).replace(/\D/g, "");
  const body = template
    ? {
        messaging_product: "whatsapp",
        to: cleanPhone,
        type: "template",
        template: {
          name: template,
          language: { code: "en" },
          components: templateParams
            ? [{ type: "body", parameters: templateParams.map((p) => ({ type: "text", text: String(p) })) }]
            : undefined,
        },
      }
    : {
        messaging_product: "whatsapp",
        to: cleanPhone,
        type: "text",
        text: { body: text },
      };
  const resp = await fetchFn(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return resp.json();
}

// Send a COD confirmation request before booking (reduces RTO / fake orders).
// Template name is a placeholder - create+approve one in Meta Business
// Manager named "cod_confirmation" (or change the name below to match).
app.post("/api/whatsapp/confirm-cod", requireApiKey, async (req, res) => {
  try {
    const { mobile, name, product, codAmount } = req.body;
    if (!mobile) return res.status(400).json({ error: "mobile required" });
    const result = await sendWhatsApp(mobile, {
      template: "cod_confirmation",
      templateParams: [name || "", product || "", codAmount || ""],
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send tracking info once booked - reuses whatever India Post barcode exists.
app.post("/api/whatsapp/tracking-update", requireApiKey, async (req, res) => {
  try {
    const { mobile, name, barcode } = req.body;
    if (!mobile || !barcode) return res.status(400).json({ error: "mobile and barcode required" });
    const result = await sendWhatsApp(mobile, {
      template: "tracking_update",
      templateParams: [name || "", barcode],
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send a post-delivery follow-up (review / reorder nudge).
app.post("/api/whatsapp/delivery-followup", requireApiKey, async (req, res) => {
  try {
    const { mobile, name } = req.body;
    if (!mobile) return res.status(400).json({ error: "mobile required" });
    const result = await sendWhatsApp(mobile, {
      template: "delivery_followup",
      templateParams: [name || ""],
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// PHASE 1 — PRODUCT & FRANCHISE MASTER (mirrors store.airxplus.com)
// See MLM_INTEGRATION_PLAN.md. Backed by SQLite (db.js), not JSON files.
// =====================================================================

// ---------- Products ----------

app.get("/api/products", requireAccess("products"), (req, res) => {
  const rows = db.prepare("SELECT * FROM products ORDER BY name").all();
  res.json(rows);
});

app.get("/api/products/:sku", requireAccess("products"), (req, res) => {
  const row = db.prepare("SELECT * FROM products WHERE sku = ?").get(req.params.sku);
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(row);
});

app.post("/api/products", requireAccess("products"), (req, res) => {
  const { sku, name, category, dp_price, mrp_price, pv, bv, status } = req.body;
  if (!sku || !name) return res.status(400).json({ error: "sku and name are required" });
  try {
    db.prepare(
      `INSERT INTO products (sku, name, category, dp_price, mrp_price, pv, bv, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      sku,
      name,
      category || null,
      Number(dp_price) || 0,
      Number(mrp_price) || 0,
      Number(pv) || 0,
      Number(bv) || 0,
      status || "Active"
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(409).json({ error: `sku "${sku}" already exists` });
    }
    return res.status(500).json({ error: err.message });
  }
  const row = db.prepare("SELECT * FROM products WHERE sku = ?").get(sku);
  res.json(row);
});

app.patch("/api/products/:sku", requireAccess("products"), (req, res) => {
  const existing = db.prepare("SELECT * FROM products WHERE sku = ?").get(req.params.sku);
  if (!existing) return res.status(404).json({ error: "not found" });
  const merged = { ...existing, ...req.body };
  db.prepare(
    `UPDATE products SET name=?, category=?, dp_price=?, mrp_price=?, pv=?, bv=?, status=?,
     updated_at=datetime('now') WHERE sku=?`
  ).run(
    merged.name,
    merged.category,
    Number(merged.dp_price) || 0,
    Number(merged.mrp_price) || 0,
    Number(merged.pv) || 0,
    Number(merged.bv) || 0,
    merged.status,
    req.params.sku
  );
  const row = db.prepare("SELECT * FROM products WHERE sku = ?").get(req.params.sku);
  res.json(row);
});

app.delete("/api/products/:sku", requireAccess("products"), (req, res) => {
  const result = db.prepare("DELETE FROM products WHERE sku = ?").run(req.params.sku);
  res.json({ deleted: result.changes > 0 });
});

// ---------- Franchises ----------

app.get("/api/franchises", requireAccess("franchises"), (req, res) => {
  const rows = db.prepare("SELECT * FROM franchises ORDER BY franchise_name").all();
  res.json(rows);
});

app.get("/api/franchises/:code", requireAccess("franchises"), (req, res) => {
  const row = db
    .prepare("SELECT * FROM franchises WHERE franchise_code = ?")
    .get(req.params.code);
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(row);
});

// Direct children of a franchise (one level) — building block for the
// full "Distributor Tree" / "Franchise Details" view later.
app.get("/api/franchises/:code/children", requireAccess("franchises"), (req, res) => {
  const rows = db
    .prepare("SELECT * FROM franchises WHERE parent_franchise_code = ? ORDER BY franchise_name")
    .all(req.params.code);
  res.json(rows);
});

app.post("/api/franchises", requireAccess("franchises"), (req, res) => {
  const {
    franchise_code,
    franchise_name,
    parent_franchise_code,
    contact_name,
    contact_mobile,
    address,
    state,
    status,
  } = req.body;
  if (!franchise_code || !franchise_name) {
    return res.status(400).json({ error: "franchise_code and franchise_name are required" });
  }
  if (parent_franchise_code) {
    const parent = db
      .prepare("SELECT franchise_code FROM franchises WHERE franchise_code = ?")
      .get(parent_franchise_code);
    if (!parent) {
      return res.status(400).json({ error: `parent_franchise_code "${parent_franchise_code}" does not exist` });
    }
  }
  try {
    db.prepare(
      `INSERT INTO franchises
       (franchise_code, franchise_name, parent_franchise_code, contact_name, contact_mobile, address, state, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      franchise_code,
      franchise_name,
      parent_franchise_code || null,
      contact_name || null,
      contact_mobile || null,
      address || null,
      state || null,
      status || "Active"
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(409).json({ error: `franchise_code "${franchise_code}" already exists` });
    }
    return res.status(500).json({ error: err.message });
  }
  const row = db.prepare("SELECT * FROM franchises WHERE franchise_code = ?").get(franchise_code);
  res.json(row);
});

app.patch("/api/franchises/:code", requireAccess("franchises"), (req, res) => {
  const existing = db
    .prepare("SELECT * FROM franchises WHERE franchise_code = ?")
    .get(req.params.code);
  if (!existing) return res.status(404).json({ error: "not found" });
  const merged = { ...existing, ...req.body };
  db.prepare(
    `UPDATE franchises SET franchise_name=?, parent_franchise_code=?, contact_name=?,
     contact_mobile=?, address=?, state=?, status=?, updated_at=datetime('now')
     WHERE franchise_code=?`
  ).run(
    merged.franchise_name,
    merged.parent_franchise_code,
    merged.contact_name,
    merged.contact_mobile,
    merged.address,
    merged.state,
    merged.status,
    req.params.code
  );
  const row = db
    .prepare("SELECT * FROM franchises WHERE franchise_code = ?")
    .get(req.params.code);
  res.json(row);
});

app.delete("/api/franchises/:code", requireAccess("franchises"), (req, res) => {
  const result = db.prepare("DELETE FROM franchises WHERE franchise_code = ?").run(req.params.code);
  res.json({ deleted: result.changes > 0 });
});

// ---------- Franchise warehouse stock ----------
// (separate from the existing /api/inventory JSON store, which tracks
// sellable stock used by the India Post booking auto-decrement — this
// tracks stock PER FRANCHISE WAREHOUSE, matching store.airxplus.com's
// warehouseView.aspx / warehouse.aspx.)

app.get("/api/franchise-stock", requireApiKey, (req, res) => {
  const { franchise_code } = req.query;
  const rows = franchise_code
    ? db
        .prepare("SELECT * FROM franchise_stock WHERE franchise_code = ? ORDER BY sku")
        .all(franchise_code)
    : db.prepare("SELECT * FROM franchise_stock ORDER BY franchise_code, sku").all();
  res.json(rows);
});

app.post("/api/franchise-stock", requireApiKey, (req, res) => {
  const { franchise_code, sku, quantity } = req.body;
  if (!franchise_code || !sku) {
    return res.status(400).json({ error: "franchise_code and sku are required" });
  }
  const franchise = db
    .prepare("SELECT franchise_code FROM franchises WHERE franchise_code = ?")
    .get(franchise_code);
  if (!franchise) return res.status(400).json({ error: `unknown franchise_code "${franchise_code}"` });
  const product = db.prepare("SELECT sku FROM products WHERE sku = ?").get(sku);
  if (!product) return res.status(400).json({ error: `unknown sku "${sku}"` });

  db.prepare(
    `INSERT INTO franchise_stock (franchise_code, sku, quantity)
     VALUES (?, ?, ?)
     ON CONFLICT(franchise_code, sku) DO UPDATE SET
       quantity = excluded.quantity, updated_at = datetime('now')`
  ).run(franchise_code, sku, Number(quantity) || 0);

  const row = db
    .prepare("SELECT * FROM franchise_stock WHERE franchise_code = ? AND sku = ?")
    .get(franchise_code, sku);
  res.json(row);
});

// Adjust stock by a delta (positive = stock in, negative = stock out) —
// convenient for "dispatch N units to franchise X" style calls later.
app.patch("/api/franchise-stock/:franchise_code/:sku", requireApiKey, (req, res) => {
  const { franchise_code, sku } = req.params;
  const existing = db
    .prepare("SELECT * FROM franchise_stock WHERE franchise_code = ? AND sku = ?")
    .get(franchise_code, sku);
  if (!existing) return res.status(404).json({ error: "not found" });
  const delta = Number(req.body.delta) || 0;
  const newQty = existing.quantity + delta;
  if (newQty < 0) return res.status(400).json({ error: "resulting quantity would be negative" });
  db.prepare(
    "UPDATE franchise_stock SET quantity = ?, updated_at = datetime('now') WHERE franchise_code = ? AND sku = ?"
  ).run(newQty, franchise_code, sku);
  const row = db
    .prepare("SELECT * FROM franchise_stock WHERE franchise_code = ? AND sku = ?")
    .get(franchise_code, sku);
  res.json(row);
});

// =====================================================================
// PHASE 2 — DISTRIBUTOR / MEMBER MASTER (mirrors admin.airxplus.com "Member")
// See MLM_INTEGRATION_PLAN.md.
// =====================================================================

app.get("/api/members", requireAccess("members"), (req, res) => {
  const { status, sponsor_code } = req.query;
  let sql = "SELECT * FROM members";
  const clauses = [];
  const params = [];
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (sponsor_code) {
    clauses.push("sponsor_code = ?");
    params.push(sponsor_code);
  }
  if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
  sql += " ORDER BY name";
  res.json(db.prepare(sql).all(...params));
});

app.get("/api/members/:code", requireAccess("members"), (req, res) => {
  const row = db.prepare("SELECT * FROM members WHERE member_code = ?").get(req.params.code);
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(row);
});

// Direct downline only (one level) — mirrors "Downline Members".
app.get("/api/members/:code/downline", requireAccess("members"), (req, res) => {
  const rows = db
    .prepare("SELECT * FROM members WHERE sponsor_code = ? ORDER BY joined_at")
    .all(req.params.code);
  res.json(rows);
});

// Full recursive downline tree — mirrors "Leg Structure" / "Distributor Tree".
// Walked in JS (not a SQL recursive CTE) with a depth guard, so a bad/cyclic
// sponsor_code in the data can never spin this into an infinite loop.
app.get("/api/members/:code/tree", requireAccess("members"), (req, res) => {
  const root = db.prepare("SELECT * FROM members WHERE member_code = ?").get(req.params.code);
  if (!root) return res.status(404).json({ error: "not found" });

  const MAX_DEPTH = 50;
  function buildNode(member, depth, seen) {
    if (depth > MAX_DEPTH || seen.has(member.member_code)) {
      return { ...member, children: [], truncated: true };
    }
    seen.add(member.member_code);
    const children = db
      .prepare("SELECT * FROM members WHERE sponsor_code = ? ORDER BY joined_at")
      .all(member.member_code)
      .map((child) => buildNode(child, depth + 1, seen));
    return { ...member, children };
  }
  res.json(buildNode(root, 0, new Set()));
});

// Mirrors admin.airxplus.com's own member-ID structure — "AIRX" + 6
// digits (e.g. AIRX849817, seen live on membersearch.aspx). Per the
// business owner's instruction, this just reproduces that same
// structure with no extra validation beyond DB uniqueness.
function generateMemberCode() {
  for (let i = 0; i < 20; i++) {
    const candidate = "AIRX" + String(Math.floor(100000 + Math.random() * 900000));
    const exists = db.prepare("SELECT 1 FROM members WHERE member_code = ?").get(candidate);
    if (!exists) return candidate;
  }
  throw new Error("could not generate a unique member_code — try again");
}

app.post("/api/members", requireAccess("members"), (req, res) => {
  const {
    name,
    sponsor_code,
    placement_leg,
    mobile,
    email,
    pan_number,
    bank_account_number,
    bank_ifsc,
    bank_name,
    kyc_status,
    status,
  } = req.body;
  let { member_code } = req.body;
  if (!name) {
    return res.status(400).json({ error: "name is required" });
  }
  // member_code is optional — if the caller doesn't supply one (e.g. a
  // signup form that doesn't ask), auto-generate one in the same AIRX+6-
  // digit structure admin.airxplus.com uses.
  if (!member_code) {
    member_code = generateMemberCode();
  }
  if (sponsor_code) {
    const sponsor = db.prepare("SELECT member_code FROM members WHERE member_code = ?").get(sponsor_code);
    if (!sponsor) return res.status(400).json({ error: `unknown sponsor_code "${sponsor_code}"` });
  }
  try {
    db.prepare(
      `INSERT INTO members
       (member_code, name, sponsor_code, placement_leg, mobile, email, pan_number,
        bank_account_number, bank_ifsc, bank_name, kyc_status, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      member_code,
      name,
      sponsor_code || null,
      placement_leg || null,
      mobile || null,
      email || null,
      pan_number || null,
      bank_account_number || null,
      bank_ifsc || null,
      bank_name || null,
      kyc_status || "Pending",
      status || "Active"
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(409).json({ error: `member_code "${member_code}" already exists` });
    }
    return res.status(500).json({ error: err.message });
  }
  res.json(db.prepare("SELECT * FROM members WHERE member_code = ?").get(member_code));
});

// =====================================================================
// LEGACY DATA MIGRATION (Phase 5 prep) — bulk-import members straight from
// admin.airxplus.com's membersearch.aspx export, plus a dummy/test-data
// classifier. See MLM_INTEGRATION_PLAN.md and the 2026-08-23 conversation:
// most of the 2,437 legacy member rows are bulk test data (sequential
// "Airx1".."Airx151", "Mahadev N", "Pranvayu N" names sharing one mobile/
// PAN, all "FREE USER"), mixed with genuine distributors throughout —
// there's no clean cutoff, so nothing is dropped on import. Everything
// comes in; likely_dummy + dummy_reason flag what looks fake so it can be
// filtered in reports/UI without permanently losing any legacy record.
// =====================================================================

function parseLegacyDate(s) {
  // "30-Apr-2026" -> "2026-04-30". Falls back to the raw string (never
  // throws) so a single malformed date can't fail the whole batch.
  if (!s) return null;
  const months = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };
  const m = String(s).trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return s;
  const mon = months[m[2].toLowerCase()];
  if (!mon) return s;
  return `${m[3]}-${mon}-${m[1].padStart(2, "0")}`;
}

// Body: { rows: [{ idNo, name, father, confDate, pkg, mobile, pan, refId, uplineId }, ...] }
// Two passes so row order never matters: pass 1 upserts every member with
// sponsor_code left NULL (always satisfies the FK), pass 2 wires up
// sponsor_code now that every member_code in the batch is guaranteed to
// exist — avoids "child imported before parent" failures entirely.
app.post("/api/members/bulk-import", requireAccess("members"), (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!rows) return res.status(400).json({ error: "body must be { rows: [...] }" });

  const upsert = db.prepare(`
    INSERT INTO members
      (member_code, name, mobile, pan_number, kyc_status, status, legacy_package, joined_at, data_source)
    VALUES (?, ?, ?, ?, 'Pending', ?, ?, ?, 'legacy_import')
    ON CONFLICT(member_code) DO UPDATE SET
      name = excluded.name,
      mobile = excluded.mobile,
      pan_number = excluded.pan_number,
      status = excluded.status,
      legacy_package = excluded.legacy_package,
      joined_at = excluded.joined_at,
      data_source = 'legacy_import',
      updated_at = datetime('now')
  `);
  const setSponsor = db.prepare(
    "UPDATE members SET sponsor_code = ? WHERE member_code = ? AND (sponsor_code IS NULL OR data_source = 'legacy_import')"
  );
  const existsStmt = db.prepare("SELECT 1 FROM members WHERE member_code = ?");

  let imported = 0;
  let sponsorLinked = 0;
  let orphanedSponsor = 0;
  const errors = [];

  const batchCodes = new Set(rows.map((r) => String(r.idNo || "").trim()).filter(Boolean));

  // node:sqlite's DatabaseSync has no better-sqlite3-style .transaction()
  // helper, so BEGIN/COMMIT/ROLLBACK are managed by hand here.
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const memberCode = String(r.idNo || "").trim();
      const name = String(r.name || "").trim();
      if (!memberCode || !name) {
        errors.push({ idNo: r.idNo, error: "missing idNo or name" });
        continue;
      }
      const pkg = String(r.pkg || "").trim();
      const status = pkg.toUpperCase() === "ACTIVE" ? "Active" : "Inactive";
      try {
        upsert.run(
          memberCode,
          name,
          String(r.mobile || "").trim() || null,
          String(r.pan || "").trim() || null,
          status,
          pkg || null,
          parseLegacyDate(r.confDate)
        );
        imported++;
      } catch (err) {
        errors.push({ idNo: memberCode, error: err.message });
      }
    }
    // Pass 2: sponsor_code, now that every code in this batch definitely exists.
    for (const r of rows) {
      const memberCode = String(r.idNo || "").trim();
      const uplineId = String(r.uplineId || "").trim();
      if (!memberCode || !uplineId || uplineId === memberCode) continue;
      const target = existsStmt.get(uplineId) || (batchCodes.has(uplineId) ? true : null);
      if (target) {
        setSponsor.run(uplineId, memberCode);
        sponsorLinked++;
      } else {
        orphanedSponsor++;
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    return res.status(500).json({ error: err.message });
  }

  res.json({ imported, sponsor_linked: sponsorLinked, orphaned_sponsor: orphanedSponsor, errors });
});

// Re-scans every member (not just the just-imported batch, so this is
// safe to re-run any time as more data comes in) and flags rows that
// match the bulk-test-data pattern found in admin.airxplus.com's export:
// sequential placeholder names, or a mobile/PAN shared by several
// "different" people. Never deletes anything — only sets likely_dummy +
// dummy_reason so reports/UI can filter.
app.post("/api/members/flag-dummies", requireAccess("members"), (req, res) => {
  const namePattern = /^(mr|mrs|ms)?\.?\s*(airx|mahadev|pranvayu|test|demo|dummy|sample)\s*\d+$/i;

  const mobileDupes = db
    .prepare(
      `SELECT mobile, COUNT(*) AS n FROM members
       WHERE mobile IS NOT NULL AND mobile != '' GROUP BY mobile HAVING n > 2`
    )
    .all();
  const panDupes = db
    .prepare(
      `SELECT pan_number, COUNT(*) AS n FROM members
       WHERE pan_number IS NOT NULL AND pan_number != '' GROUP BY pan_number HAVING n > 2`
    )
    .all();
  const dupeMobiles = new Set(mobileDupes.map((r) => r.mobile));
  const dupePans = new Set(panDupes.map((r) => r.pan_number));

  const all = db.prepare("SELECT member_code, name, mobile, pan_number FROM members").all();
  const clearFlag = db.prepare(
    "UPDATE members SET likely_dummy = 0, dummy_reason = NULL WHERE member_code = ?"
  );
  const setFlag = db.prepare(
    "UPDATE members SET likely_dummy = 1, dummy_reason = ? WHERE member_code = ?"
  );

  let flagged = 0;
  db.exec("BEGIN");
  try {
    for (const m of all) {
      const reasons = [];
      if (namePattern.test((m.name || "").trim())) reasons.push("sequential placeholder name");
      if (m.mobile && dupeMobiles.has(m.mobile)) reasons.push(`mobile shared by ${mobileDupes.find((r) => r.mobile === m.mobile).n} members`);
      if (m.pan_number && dupePans.has(m.pan_number)) reasons.push(`PAN shared by ${panDupes.find((r) => r.pan_number === m.pan_number).n} members`);

      if (reasons.length) {
        setFlag.run(reasons.join("; "), m.member_code);
        flagged++;
      } else {
        clearFlag.run(m.member_code);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    return res.status(500).json({ error: err.message });
  }

  res.json({ total_members: all.length, flagged_dummy: flagged, clean: all.length - flagged });
});

app.get("/api/reports/dummy-summary", requireAccess("dashboard"), (req, res) => {
  const total = db.prepare("SELECT COUNT(*) AS n FROM members").get().n;
  const dummy = db.prepare("SELECT COUNT(*) AS n FROM members WHERE likely_dummy = 1").get().n;
  const bySource = db.prepare("SELECT data_source, COUNT(*) AS n FROM members GROUP BY data_source").all();
  res.json({
    total_members: total,
    likely_dummy: dummy,
    likely_real: total - dummy,
    by_data_source: bySource,
  });
});

app.patch("/api/members/:code", requireAccess("members"), (req, res) => {
  const existing = db.prepare("SELECT * FROM members WHERE member_code = ?").get(req.params.code);
  if (!existing) return res.status(404).json({ error: "not found" });
  const merged = { ...existing, ...req.body };
  db.prepare(
    `UPDATE members SET name=?, sponsor_code=?, placement_leg=?, mobile=?, email=?,
     pan_number=?, bank_account_number=?, bank_ifsc=?, bank_name=?, kyc_status=?, status=?,
     updated_at=datetime('now') WHERE member_code=?`
  ).run(
    merged.name,
    merged.sponsor_code,
    merged.placement_leg,
    merged.mobile,
    merged.email,
    merged.pan_number,
    merged.bank_account_number,
    merged.bank_ifsc,
    merged.bank_name,
    merged.kyc_status,
    merged.status,
    req.params.code
  );
  res.json(db.prepare("SELECT * FROM members WHERE member_code = ?").get(req.params.code));
});

// Convenience endpoints mirroring admin.airxplus.com's "Block Id" / "Unblock Id" /
// "Manual Active" — same PATCH under the hood, just named for what the ops team
// actually does day to day.
app.post("/api/members/:code/block", requireAccess("members"), (req, res) => {
  const existing = db.prepare("SELECT * FROM members WHERE member_code = ?").get(req.params.code);
  if (!existing) return res.status(404).json({ error: "not found" });
  db.prepare("UPDATE members SET status='Blocked', updated_at=datetime('now') WHERE member_code=?").run(req.params.code);
  res.json(db.prepare("SELECT * FROM members WHERE member_code = ?").get(req.params.code));
});

app.post("/api/members/:code/unblock", requireAccess("members"), (req, res) => {
  const existing = db.prepare("SELECT * FROM members WHERE member_code = ?").get(req.params.code);
  if (!existing) return res.status(404).json({ error: "not found" });
  db.prepare("UPDATE members SET status='Active', updated_at=datetime('now') WHERE member_code=?").run(req.params.code);
  res.json(db.prepare("SELECT * FROM members WHERE member_code = ?").get(req.params.code));
});

// Hard-delete a member. Pre-existing bug fixed here (2026-08-24, surfaced
// by Phase 6 testing): members.member_code is referenced by FOREIGN KEY
// from pv_ledger, payouts, wallet_transactions, pv_balance, reward_achievers,
// fund_requests, kyc_documents, member_audit_log, and other members'
// sponsor_code — with PRAGMA foreign_keys = ON a plain DELETE on any member
// that has EVER had money move (a payout, a wallet transaction, a fund
// request) or has downline used to fail with a raw unhandled 500. Real
// financial/relationship history should not silently vanish, so: block
// hard-delete (409, clear message) when any of that exists — Block/Unblock
// is the right tool there — and only actually delete when a member is
// "clean" (no money history, no downline), cascading the safe metadata
// (KYC docs, audit log, empty pv_balance row) that's fine to remove.
app.delete("/api/members/:code", requireAccess("members"), (req, res) => {
  const existing = db.prepare("SELECT member_code FROM members WHERE member_code = ?").get(req.params.code);
  if (!existing) return res.json({ deleted: false });

  const blockers = [
    ["pv_ledger", "has PV/BV ledger history"],
    ["payouts", "has recorded payouts"],
    ["wallet_transactions", "has wallet transactions"],
    ["fund_requests", "has fund requests"],
    ["reward_achievers", "has reward achievements"],
  ];
  for (const [table, reason] of blockers) {
    const row = db.prepare(`SELECT 1 FROM ${table} WHERE member_code = ? LIMIT 1`).get(req.params.code);
    if (row) {
      return res.status(409).json({
        error: `cannot delete "${req.params.code}" — ${reason}. Use Block instead to preserve financial/audit history.`,
      });
    }
  }
  const hasDownline = db.prepare("SELECT 1 FROM members WHERE sponsor_code = ? LIMIT 1").get(req.params.code);
  if (hasDownline) {
    return res.status(409).json({
      error: `cannot delete "${req.params.code}" — other members list it as their sponsor. Reassign their sponsor_code first.`,
    });
  }

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM kyc_documents WHERE member_code = ?").run(req.params.code);
    db.prepare("DELETE FROM member_audit_log WHERE member_code = ?").run(req.params.code);
    db.prepare("DELETE FROM pv_balance WHERE member_code = ?").run(req.params.code);
    const result = db.prepare("DELETE FROM members WHERE member_code = ?").run(req.params.code);
    db.exec("COMMIT");
    res.json({ deleted: result.changes > 0 });
  } catch (err) {
    db.exec("ROLLBACK");
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// PHASE 3 — COMPENSATION ENGINE (binary plan: Left/Right PV matching)
// See MLM_INTEGRATION_PLAN.md and the long comment in db.js next to
// commission_settings for the full story. Short version: admin.airxplus.com
// does not store its real matching-bonus formula anywhere in its UI, and
// the developer who built it wanted extra payment to hand it over. The
// business owner decided: build an ADMIN-CONFIGURABLE engine here instead
// of blocking on that. Only pair_value_pv (500) and admin_charge_percent
// (5) are confirmed from admin.airxplus.com itself — everything else is a
// clearly labeled provisional default, changeable any time via
// PUT /api/settings/commission with no code change or redeploy.
//
// Matching logic: every member sits under a sponsor on either the Left or
// Right leg (members.placement_leg). Each run totals PV purchased inside
// a member's whole Left subtree and whole Right subtree (plus whatever
// carried forward from earlier runs), matches pairs = floor(min(left,
// right) / pair_value_pv), pays payout_per_pair_amount per pair minus
// admin_charge_percent and tds_percent, and carries the PV remainder
// forward — mirroring the "BF / New / Total / Paid / CF" columns seen on
// admin.airxplus.com's weeklypointcf.aspx.
//
// Every run is PREVIEW first (GET /api/payouts/preview — read-only,
// changes nothing), then COMMIT (POST /api/payouts/commit — real money,
// writes payouts + wallet_transactions, updates carry-forward, marks the
// PV consumed). Always preview before committing.
// =====================================================================

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function getCommissionSettings() {
  const rows = db.prepare("SELECT setting_key, setting_value FROM commission_settings").all();
  const s = {};
  for (const r of rows) s[r.setting_key] = r.setting_value;
  return s;
}

// Computes matched-pair totals for every member from whatever pv_ledger
// rows haven't been consumed by an earlier committed run yet. Pure
// calculation, writes nothing — both /preview and /commit call this so
// they can never disagree with each other.
function computeMatching(periodLabel) {
  const settings = getCommissionSettings();
  const pairValue = settings.pair_value_pv || 500;
  const payoutPerPair = settings.payout_per_pair_amount || pairValue;
  const adminChargePct = settings.admin_charge_percent || 0;
  const tdsPct = settings.tds_percent || 0;
  const maxPairs = settings.max_pairs_per_period || 0;

  const members = db.prepare("SELECT member_code, sponsor_code, placement_leg FROM members").all();
  const children = {};
  for (const m of members) {
    if (!m.sponsor_code) continue;
    (children[m.sponsor_code] = children[m.sponsor_code] || []).push(m);
  }

  const ledgerRows = db
    .prepare(
      `SELECT member_code, COALESCE(SUM(pv),0) AS pv, COALESCE(SUM(bv),0) AS bv
       FROM pv_ledger WHERE consumed_in_period IS NULL GROUP BY member_code`
    )
    .all();
  const ownPv = {};
  let totalIncomingBv = 0;
  for (const r of ledgerRows) {
    ownPv[r.member_code] = r.pv;
    totalIncomingBv += r.bv;
  }

  const balances = {};
  for (const b of db.prepare("SELECT * FROM pv_balance").all()) balances[b.member_code] = b;

  // Post-order subtree PV sum, memoised — same MAX_DEPTH + seen-set cycle
  // guard used by /api/members/:code/tree elsewhere in this file, so a
  // corrupt sponsor_code chain can never recurse forever.
  const MAX_DEPTH = 50;
  const subtreePv = {};
  function subtreeSum(code, depth, seen) {
    if (subtreePv[code] !== undefined) return subtreePv[code];
    if (depth > MAX_DEPTH || seen.has(code)) return 0;
    seen.add(code);
    let sum = ownPv[code] || 0;
    for (const child of children[code] || []) sum += subtreeSum(child.member_code, depth + 1, seen);
    subtreePv[code] = sum;
    return sum;
  }
  for (const m of members) subtreeSum(m.member_code, 0, new Set());

  const results = [];
  for (const m of members) {
    const kids = children[m.member_code] || [];
    const bf = balances[m.member_code] || { left_carry_forward: 0, right_carry_forward: 0 };
    if (kids.length === 0 && bf.left_carry_forward === 0 && bf.right_carry_forward === 0) continue;

    let leftNew = 0;
    let rightNew = 0;
    for (const child of kids) {
      const val = subtreePv[child.member_code] || 0;
      if (child.placement_leg === "Left") leftNew += val;
      else if (child.placement_leg === "Right") rightNew += val;
      // No/blank placement_leg on a child doesn't count toward either
      // leg — mirrors admin.airxplus.com requiring an explicit Left/Right
      // choice at join time.
    }

    const leftTotal = bf.left_carry_forward + leftNew;
    const rightTotal = bf.right_carry_forward + rightNew;
    let matchedPairs = Math.floor(Math.min(leftTotal, rightTotal) / pairValue);
    if (maxPairs > 0) matchedPairs = Math.min(matchedPairs, maxPairs);

    const grossAmount = matchedPairs * payoutPerPair;
    const adminCharge = round2((grossAmount * adminChargePct) / 100);
    const tds = round2((grossAmount * tdsPct) / 100);
    const netAmount = round2(grossAmount - adminCharge - tds);
    const usedPv = matchedPairs * pairValue;

    results.push({
      member_code: m.member_code,
      left_total: round2(leftTotal),
      right_total: round2(rightTotal),
      matched_pairs: matchedPairs,
      gross_amount: round2(grossAmount),
      admin_charge: adminCharge,
      tds_amount: tds,
      net_amount: netAmount,
      left_carry_forward: round2(leftTotal - usedPv),
      right_carry_forward: round2(rightTotal - usedPv),
    });
  }

  const totalOutgoingNet = round2(results.reduce((sum, r) => sum + r.net_amount, 0));
  const payoutRatioPercent = totalIncomingBv > 0 ? round2((totalOutgoingNet / totalIncomingBv) * 100) : 0;

  return {
    period_label: periodLabel,
    settings_used: settings,
    total_incoming_bv: round2(totalIncomingBv),
    total_outgoing_net: totalOutgoingNet,
    payout_ratio_percent: payoutRatioPercent,
    ledger_rows_included: ledgerRows.length,
    members: results,
  };
}

// ---------- Commission settings (this IS the "admin manages the plan" screen) ----------

app.get("/api/settings/commission", requireAccess("commission"), (req, res) => {
  res.json(db.prepare("SELECT * FROM commission_settings ORDER BY setting_key").all());
});

app.put("/api/settings/commission", requireAccess("commission"), (req, res) => {
  const updates = req.body || {};
  const stmt = db.prepare(
    `INSERT INTO commission_settings (setting_key, setting_value, label)
     VALUES (?, ?, COALESCE((SELECT label FROM commission_settings WHERE setting_key = ?), ?))
     ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = datetime('now')`
  );
  for (const [key, value] of Object.entries(updates)) {
    if (typeof value !== "number" || Number.isNaN(value)) continue;
    stmt.run(key, value, key, key);
  }
  res.json(db.prepare("SELECT * FROM commission_settings ORDER BY setting_key").all());
});

// ---------- Weekly matching payout run (preview, read-only, then commit) ----------

app.get("/api/payouts/preview", requireAccess("payouts"), (req, res) => {
  const periodLabel = req.query.period || `PREVIEW-${new Date().toISOString().slice(0, 10)}`;
  res.json(computeMatching(periodLabel));
});

app.post("/api/payouts/commit", requireAccess("payouts"), (req, res) => {
  const { period_label } = req.body;
  if (!period_label) return res.status(400).json({ error: "period_label is required" });
  const already = db.prepare("SELECT id FROM payout_runs WHERE period_label = ?").get(period_label);
  if (already) return res.status(409).json({ error: `period_label "${period_label}" was already committed` });

  const result = computeMatching(period_label);

  const insertPayout = db.prepare(
    `INSERT INTO payouts (member_code, period_label, gross_amount, tds_amount, admin_charge, net_amount, status)
     VALUES (?, ?, ?, ?, ?, ?, 'Pending')`
  );
  const insertWallet = db.prepare(
    `INSERT INTO wallet_transactions (member_code, wallet_type, txn_type, amount, reason)
     VALUES (?, 'Weekly', 'credit', ?, ?)`
  );
  const upsertBalance = db.prepare(
    `INSERT INTO pv_balance (member_code, left_carry_forward, right_carry_forward, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(member_code) DO UPDATE SET left_carry_forward = excluded.left_carry_forward,
       right_carry_forward = excluded.right_carry_forward, updated_at = datetime('now')`
  );
  const insertRun = db.prepare(
    `INSERT INTO payout_runs (period_label, status, total_incoming_bv, total_outgoing_net, payout_ratio_percent, committed_at)
     VALUES (?, 'Committed', ?, ?, ?, datetime('now'))`
  );

  for (const m of result.members) {
    if (m.matched_pairs > 0) {
      insertPayout.run(m.member_code, period_label, m.gross_amount, m.tds_amount, m.admin_charge, m.net_amount);
      insertWallet.run(m.member_code, m.net_amount, `Weekly matching payout — ${period_label}`);
    }
    upsertBalance.run(m.member_code, m.left_carry_forward, m.right_carry_forward);
  }
  db.prepare("UPDATE pv_ledger SET consumed_in_period = ? WHERE consumed_in_period IS NULL").run(period_label);
  insertRun.run(period_label, result.total_incoming_bv, result.total_outgoing_net, result.payout_ratio_percent);

  res.json({ committed: true, ...result });
});

app.get("/api/payouts/runs", requireAccess("payouts"), (req, res) => {
  res.json(db.prepare("SELECT * FROM payout_runs ORDER BY id DESC").all());
});

// ---------- Incoming vs outgoing — the business-health check the owner asked for ----------
// "commission mein kitna % distribute ho raha hai, incoming (BV) ke against outgoing (net payout) kitna hai"
app.get("/api/reports/payout-health", requireAccess("dashboard"), (req, res) => {
  const runs = db.prepare("SELECT * FROM payout_runs ORDER BY id").all();
  const totalIncoming = round2(runs.reduce((s, r) => s + r.total_incoming_bv, 0));
  const totalOutgoing = round2(runs.reduce((s, r) => s + r.total_outgoing_net, 0));
  res.json({
    runs,
    total_incoming_bv: totalIncoming,
    total_outgoing_net: totalOutgoing,
    overall_payout_ratio_percent: totalIncoming > 0 ? round2((totalOutgoing / totalIncoming) * 100) : 0,
  });
});

// =====================================================================
// PHASE 4 — REWARDS & REPORTING (mirrors admin.airxplus.com "Reward"/"Reports")
// See MLM_INTEGRATION_PLAN.md.
// =====================================================================

// ---------- Rewards master ----------

app.get("/api/rewards", requireAccess("rewards"), (req, res) => {
  res.json(db.prepare("SELECT * FROM rewards ORDER BY criteria_pv").all());
});

app.post("/api/rewards", requireAccess("rewards"), (req, res) => {
  const { reward_name, criteria_pv, reward_value, session_label } = req.body;
  if (!reward_name) return res.status(400).json({ error: "reward_name is required" });
  const result = db
    .prepare(
      "INSERT INTO rewards (reward_name, criteria_pv, reward_value, session_label) VALUES (?, ?, ?, ?)"
    )
    .run(reward_name, Number(criteria_pv) || 0, reward_value || null, session_label || null);
  res.json(db.prepare("SELECT * FROM rewards WHERE id = ?").get(result.lastInsertRowid));
});

app.patch("/api/rewards/:id", requireAccess("rewards"), (req, res) => {
  const existing = db.prepare("SELECT * FROM rewards WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "not found" });
  const merged = { ...existing, ...req.body };
  db.prepare(
    "UPDATE rewards SET reward_name=?, criteria_pv=?, reward_value=?, session_label=? WHERE id=?"
  ).run(merged.reward_name, Number(merged.criteria_pv) || 0, merged.reward_value, merged.session_label, req.params.id);
  res.json(db.prepare("SELECT * FROM rewards WHERE id = ?").get(req.params.id));
});

app.delete("/api/rewards/:id", requireAccess("rewards"), (req, res) => {
  const result = db.prepare("DELETE FROM rewards WHERE id = ?").run(req.params.id);
  res.json({ deleted: result.changes > 0 });
});

// ---------- Reward achievers (mirrors "Reward Details" / "Rank Achivers List") ----------

app.get("/api/reward-achievers", requireAccess("rewards"), (req, res) => {
  const { member_code, reward_id } = req.query;
  let sql = `SELECT reward_achievers.*, rewards.reward_name, rewards.reward_value, members.name AS member_name
             FROM reward_achievers
             JOIN rewards ON rewards.id = reward_achievers.reward_id
             JOIN members ON members.member_code = reward_achievers.member_code`;
  const clauses = [];
  const params = [];
  if (member_code) {
    clauses.push("reward_achievers.member_code = ?");
    params.push(member_code);
  }
  if (reward_id) {
    clauses.push("reward_achievers.reward_id = ?");
    params.push(reward_id);
  }
  if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
  sql += " ORDER BY reward_achievers.achieved_at DESC";
  res.json(db.prepare(sql).all(...params));
});

app.post("/api/reward-achievers", requireAccess("rewards"), (req, res) => {
  const { member_code, reward_id } = req.body;
  if (!member_code || !reward_id) {
    return res.status(400).json({ error: "member_code and reward_id are required" });
  }
  const member = db.prepare("SELECT member_code FROM members WHERE member_code = ?").get(member_code);
  if (!member) return res.status(400).json({ error: `unknown member_code "${member_code}"` });
  const reward = db.prepare("SELECT id FROM rewards WHERE id = ?").get(reward_id);
  if (!reward) return res.status(400).json({ error: `unknown reward_id "${reward_id}"` });
  const result = db
    .prepare("INSERT INTO reward_achievers (member_code, reward_id) VALUES (?, ?)")
    .run(member_code, reward_id);
  res.json(db.prepare("SELECT * FROM reward_achievers WHERE id = ?").get(result.lastInsertRowid));
});

app.delete("/api/reward-achievers/:id", requireAccess("rewards"), (req, res) => {
  const result = db.prepare("DELETE FROM reward_achievers WHERE id = ?").run(req.params.id);
  res.json({ deleted: result.changes > 0 });
});

// ---------- Reports ----------

// "Member Balance" — nets every wallet_transactions row for one member.
app.get("/api/reports/member-balance/:code", requireAccess("reports"), (req, res) => {
  const member = db.prepare("SELECT * FROM members WHERE member_code = ?").get(req.params.code);
  if (!member) return res.status(404).json({ error: "not found" });
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN txn_type = 'credit' THEN amount ELSE 0 END), 0) AS total_credit,
         COALESCE(SUM(CASE WHEN txn_type = 'debit' THEN amount ELSE 0 END), 0) AS total_debit
       FROM wallet_transactions WHERE member_code = ?`
    )
    .get(req.params.code);
  res.json({
    member_code: req.params.code,
    total_credit: row.total_credit,
    total_debit: row.total_debit,
    balance: row.total_credit - row.total_debit,
  });
});

// "Downline PV Detail" — this member's own PV plus every downline member's PV,
// walked the same cycle-safe way as /api/members/:code/tree.
app.get("/api/reports/downline-pv/:code", requireAccess("reports"), (req, res) => {
  const root = db.prepare("SELECT * FROM members WHERE member_code = ?").get(req.params.code);
  if (!root) return res.status(404).json({ error: "not found" });

  const pvStmt = db.prepare(
    `SELECT COALESCE(SUM(pv), 0) AS pv, COALESCE(SUM(bv), 0) AS bv FROM pv_ledger WHERE member_code = ?`
  );
  const childrenStmt = db.prepare("SELECT member_code FROM members WHERE sponsor_code = ?");

  const MAX_DEPTH = 50;
  const seen = new Set();
  let totalPv = 0;
  let totalBv = 0;
  const perMember = [];

  function walk(code, depth) {
    if (depth > MAX_DEPTH || seen.has(code)) return;
    seen.add(code);
    const { pv, bv } = pvStmt.get(code);
    totalPv += pv;
    totalBv += bv;
    perMember.push({ member_code: code, pv, bv });
    for (const child of childrenStmt.all(code)) walk(child.member_code, depth + 1);
  }
  walk(req.params.code, 0);

  res.json({ member_code: req.params.code, total_pv: totalPv, total_bv: totalBv, members: perMember });
});

// "Rank Achivers List" — every reward achieved, most recent first.
app.get("/api/reports/rank-achievers", requireAccess("rewards"), (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT reward_achievers.*, rewards.reward_name, members.name AS member_name
         FROM reward_achievers
         JOIN rewards ON rewards.id = reward_achievers.reward_id
         JOIN members ON members.member_code = reward_achievers.member_code
         ORDER BY reward_achievers.achieved_at DESC`
      )
      .all()
  );
});

// =====================================================================
// PHASE 6 — REMAINING admin.airxplus.com FEATURES (2026-08-24)
// Covers Master (Bank/State/Package), Member (KYC Documents, Manual
// Active, Reset Member Status, Change User), Payout (Daily Point/Payout
// Detail), Accounts (Fund Requests, Payout Transfer Weekly, Topup
// Detail, TDS Report), Utility (Fund Credit/Debit wallet ledger — the
// wallet_transactions table already existed for the weekly payout
// engine but had no direct API of its own until now), and Reward
// Session. See MLM_INTEGRATION_PLAN.md for the full source menu list.
//
// Deliberately NOT built here: store.airxplus.com's own Admin/User /
// UserGroup / Permissions screens and admin.airxplus.com's content-
// management menus (News, Meeting, Gallery/Video/Media/Presentations,
// Training, Testimonial, Slider). Those are either a full multi-role
// login system (a separate, security-sensitive project on top of the
// current single-shared-API-key model) or public-facing marketing
// content rather than distributor/financial ops — flagged to the owner
// rather than assumed.
// =====================================================================

// ---------- Master: Bank ----------

app.get("/api/masters/banks", requireAccess("masters"), (req, res) => {
  res.json(db.prepare("SELECT * FROM banks ORDER BY bank_name").all());
});

app.post("/api/masters/banks", requireAccess("masters"), (req, res) => {
  const { bank_name, status } = req.body;
  if (!bank_name) return res.status(400).json({ error: "bank_name is required" });
  try {
    const result = db
      .prepare("INSERT INTO banks (bank_name, status) VALUES (?, ?)")
      .run(bank_name, status || "Active");
    res.json(db.prepare("SELECT * FROM banks WHERE id = ?").get(result.lastInsertRowid));
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(409).json({ error: `bank "${bank_name}" already exists` });
    }
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/masters/banks/:id", requireAccess("masters"), (req, res) => {
  const existing = db.prepare("SELECT * FROM banks WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "not found" });
  const merged = { ...existing, ...req.body };
  db.prepare("UPDATE banks SET bank_name=?, status=? WHERE id=?").run(merged.bank_name, merged.status, req.params.id);
  res.json(db.prepare("SELECT * FROM banks WHERE id = ?").get(req.params.id));
});

app.delete("/api/masters/banks/:id", requireAccess("masters"), (req, res) => {
  const result = db.prepare("DELETE FROM banks WHERE id = ?").run(req.params.id);
  res.json({ deleted: result.changes > 0 });
});

// ---------- Master: State ----------

app.get("/api/masters/states", requireAccess("masters"), (req, res) => {
  res.json(db.prepare("SELECT * FROM states ORDER BY state_name").all());
});

app.post("/api/masters/states", requireAccess("masters"), (req, res) => {
  const { state_name, status } = req.body;
  if (!state_name) return res.status(400).json({ error: "state_name is required" });
  try {
    const result = db
      .prepare("INSERT INTO states (state_name, status) VALUES (?, ?)")
      .run(state_name, status || "Active");
    res.json(db.prepare("SELECT * FROM states WHERE id = ?").get(result.lastInsertRowid));
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(409).json({ error: `state "${state_name}" already exists` });
    }
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/masters/states/:id", requireAccess("masters"), (req, res) => {
  const existing = db.prepare("SELECT * FROM states WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "not found" });
  const merged = { ...existing, ...req.body };
  db.prepare("UPDATE states SET state_name=?, status=? WHERE id=?").run(merged.state_name, merged.status, req.params.id);
  res.json(db.prepare("SELECT * FROM states WHERE id = ?").get(req.params.id));
});

app.delete("/api/masters/states/:id", requireAccess("masters"), (req, res) => {
  const result = db.prepare("DELETE FROM states WHERE id = ?").run(req.params.id);
  res.json({ deleted: result.changes > 0 });
});

// ---------- Master: Package (join-kit master, e.g. REGISTRATION / ACTIVE) ----------

app.get("/api/masters/packages", requireAccess("masters"), (req, res) => {
  res.json(db.prepare("SELECT * FROM packages ORDER BY pair_value_pv").all());
});

app.post("/api/masters/packages", requireAccess("masters"), (req, res) => {
  const { package_name, pair_value_pv, price, status } = req.body;
  if (!package_name) return res.status(400).json({ error: "package_name is required" });
  try {
    const result = db
      .prepare("INSERT INTO packages (package_name, pair_value_pv, price, status) VALUES (?, ?, ?, ?)")
      .run(package_name, Number(pair_value_pv) || 0, Number(price) || 0, status || "Active");
    res.json(db.prepare("SELECT * FROM packages WHERE id = ?").get(result.lastInsertRowid));
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(409).json({ error: `package "${package_name}" already exists` });
    }
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/masters/packages/:id", requireAccess("masters"), (req, res) => {
  const existing = db.prepare("SELECT * FROM packages WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "not found" });
  const merged = { ...existing, ...req.body };
  db.prepare(
    "UPDATE packages SET package_name=?, pair_value_pv=?, price=?, status=?, updated_at=datetime('now') WHERE id=?"
  ).run(merged.package_name, Number(merged.pair_value_pv) || 0, Number(merged.price) || 0, merged.status, req.params.id);
  res.json(db.prepare("SELECT * FROM packages WHERE id = ?").get(req.params.id));
});

app.delete("/api/masters/packages/:id", requireAccess("masters"), (req, res) => {
  const result = db.prepare("DELETE FROM packages WHERE id = ?").run(req.params.id);
  res.json({ deleted: result.changes > 0 });
});

// ---------- Member: KYC Documents ----------

app.get("/api/members/:code/kyc-documents", requireAccess("members"), (req, res) => {
  res.json(
    db.prepare("SELECT * FROM kyc_documents WHERE member_code = ? ORDER BY uploaded_at DESC").all(req.params.code)
  );
});

app.post("/api/members/:code/kyc-documents", requireAccess("members"), (req, res) => {
  const member = db.prepare("SELECT member_code FROM members WHERE member_code = ?").get(req.params.code);
  if (!member) return res.status(404).json({ error: "member not found" });
  const { doc_type, doc_number, note } = req.body;
  if (!doc_type) return res.status(400).json({ error: "doc_type is required (e.g. PAN, Aadhaar, Bank Passbook)" });
  const result = db
    .prepare("INSERT INTO kyc_documents (member_code, doc_type, doc_number, note) VALUES (?, ?, ?, ?)")
    .run(req.params.code, doc_type, doc_number || null, note || null);
  res.json(db.prepare("SELECT * FROM kyc_documents WHERE id = ?").get(result.lastInsertRowid));
});

// Approve/reject a KYC document — also nudges the member's own kyc_status
// forward when every document on file is Approved, back to Pending on
// any Rejected, mirroring what "KYC Document" review does in admin.airxplus.com.
app.patch("/api/kyc-documents/:id", requireAccess("members"), (req, res) => {
  const existing = db.prepare("SELECT * FROM kyc_documents WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "not found" });
  const { status, review_note } = req.body;
  if (!["Pending", "Approved", "Rejected"].includes(status)) {
    return res.status(400).json({ error: "status must be Pending, Approved, or Rejected" });
  }
  db.prepare(
    "UPDATE kyc_documents SET status=?, review_note=?, reviewed_at=datetime('now') WHERE id=?"
  ).run(status, review_note || null, req.params.id);

  const docs = db.prepare("SELECT status FROM kyc_documents WHERE member_code = ?").all(existing.member_code);
  let memberKyc = "Pending";
  if (docs.length && docs.every((d) => d.status === "Approved")) memberKyc = "Approved";
  else if (docs.some((d) => d.status === "Rejected")) memberKyc = "Pending";
  db.prepare("UPDATE members SET kyc_status = ?, updated_at = datetime('now') WHERE member_code = ?").run(
    memberKyc,
    existing.member_code
  );

  res.json(db.prepare("SELECT * FROM kyc_documents WHERE id = ?").get(req.params.id));
});

// ---------- Member: Manual Active / Reset Member Status / Change User ----------

// "Manual Active" — admin force-activates a member outside the normal
// matching/activation flow (e.g. an offline cash payment for the kit).
app.post("/api/members/:code/manual-active", requireAccess("members"), (req, res) => {
  const member = db.prepare("SELECT * FROM members WHERE member_code = ?").get(req.params.code);
  if (!member) return res.status(404).json({ error: "not found" });
  const { note } = req.body;
  db.prepare("UPDATE members SET status = 'Active', updated_at = datetime('now') WHERE member_code = ?").run(
    req.params.code
  );
  db.prepare("INSERT INTO member_audit_log (member_code, action, detail) VALUES (?, 'manual_active', ?)").run(
    req.params.code,
    note || null
  );
  res.json(db.prepare("SELECT * FROM members WHERE member_code = ?").get(req.params.code));
});

// "Reset Member Status" — puts a member back to Inactive/Pending, e.g. to
// undo an accidental manual-active or restart their activation flow.
app.post("/api/members/:code/reset-status", requireAccess("members"), (req, res) => {
  const member = db.prepare("SELECT * FROM members WHERE member_code = ?").get(req.params.code);
  if (!member) return res.status(404).json({ error: "not found" });
  const { note } = req.body;
  db.prepare("UPDATE members SET status = 'Inactive', updated_at = datetime('now') WHERE member_code = ?").run(
    req.params.code
  );
  db.prepare("INSERT INTO member_audit_log (member_code, action, detail) VALUES (?, 'reset_status', ?)").run(
    req.params.code,
    note || null
  );
  res.json(db.prepare("SELECT * FROM members WHERE member_code = ?").get(req.params.code));
});

// "Change User" — re-assign an existing member ID to a different person's
// identity details (name/mobile/email/PAN), keeping the ID, downline and
// PV history intact. Every prior value is written to the audit log so
// nothing is silently overwritten.
app.post("/api/members/:code/change-user", requireAccess("members"), (req, res) => {
  const member = db.prepare("SELECT * FROM members WHERE member_code = ?").get(req.params.code);
  if (!member) return res.status(404).json({ error: "not found" });
  const { name, mobile, email, pan_number, note } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  const before = { name: member.name, mobile: member.mobile, email: member.email, pan_number: member.pan_number };
  db.prepare(
    "UPDATE members SET name=?, mobile=?, email=?, pan_number=?, updated_at=datetime('now') WHERE member_code=?"
  ).run(name, mobile || null, email || null, pan_number || null, req.params.code);
  db.prepare("INSERT INTO member_audit_log (member_code, action, detail) VALUES (?, 'change_user', ?)").run(
    req.params.code,
    JSON.stringify({ before, note: note || null })
  );
  res.json(db.prepare("SELECT * FROM members WHERE member_code = ?").get(req.params.code));
});

app.get("/api/members/:code/audit-log", requireAccess("members"), (req, res) => {
  res.json(
    db.prepare("SELECT * FROM member_audit_log WHERE member_code = ? ORDER BY created_at DESC").all(req.params.code)
  );
});

// ---------- Payout: Daily Point Detail / Daily Payout Detail ----------
// Derived from pv_ledger / payouts grouped by calendar day — we run
// payouts weekly (not as separate daily jobs), so "daily" here means
// "this weekly run's activity broken down by the day it was recorded",
// same numbers as the Weekly MIS Report just sliced differently.

app.get("/api/reports/daily-points", requireAccess("reports"), (req, res) => {
  const { from, to } = req.query;
  let sql = `SELECT date(created_at) AS day, member_code, entry_type,
                    SUM(pv) AS total_pv, SUM(bv) AS total_bv, COUNT(*) AS entries
             FROM pv_ledger`;
  const clauses = [];
  const params = [];
  if (from) { clauses.push("date(created_at) >= ?"); params.push(from); }
  if (to) { clauses.push("date(created_at) <= ?"); params.push(to); }
  if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
  sql += " GROUP BY day, member_code, entry_type ORDER BY day DESC";
  res.json(db.prepare(sql).all(...params));
});

app.get("/api/reports/daily-payouts", requireAccess("reports"), (req, res) => {
  const { from, to } = req.query;
  let sql = `SELECT date(created_at) AS day, member_code, period_label,
                    gross_amount, tds_amount, admin_charge, net_amount, status
             FROM payouts`;
  const clauses = [];
  const params = [];
  if (from) { clauses.push("date(created_at) >= ?"); params.push(from); }
  if (to) { clauses.push("date(created_at) <= ?"); params.push(to); }
  if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
  sql += " ORDER BY created_at DESC";
  res.json(db.prepare(sql).all(...params));
});

// ---------- Accounts: Fund Requests (also answers Reports > View Fund Request) ----------

app.get("/api/fund-requests", requireAccess("accounts"), (req, res) => {
  const { status, member_code } = req.query;
  let sql = `SELECT fund_requests.*, members.name AS member_name FROM fund_requests
             JOIN members ON members.member_code = fund_requests.member_code`;
  const clauses = [];
  const params = [];
  if (status) { clauses.push("fund_requests.status = ?"); params.push(status); }
  if (member_code) { clauses.push("fund_requests.member_code = ?"); params.push(member_code); }
  if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
  sql += " ORDER BY fund_requests.requested_at DESC";
  res.json(db.prepare(sql).all(...params));
});

app.post("/api/fund-requests", requireAccess("accounts"), (req, res) => {
  const { member_code, amount, wallet_type, note } = req.body;
  if (!member_code || !amount) return res.status(400).json({ error: "member_code and amount are required" });
  const member = db.prepare("SELECT member_code FROM members WHERE member_code = ?").get(member_code);
  if (!member) return res.status(400).json({ error: `unknown member_code "${member_code}"` });
  const result = db
    .prepare("INSERT INTO fund_requests (member_code, amount, wallet_type, note) VALUES (?, ?, ?, ?)")
    .run(member_code, round2(Number(amount)), wallet_type || "Weekly", note || null);
  res.json(db.prepare("SELECT * FROM fund_requests WHERE id = ?").get(result.lastInsertRowid));
});

// Approve posts a debit to the member's wallet immediately (so Member
// Balance reflects the payout); reject just records the decision.
app.patch("/api/fund-requests/:id", requireAccess("accounts"), (req, res) => {
  const existing = db.prepare("SELECT * FROM fund_requests WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "not found" });
  const { status, process_note } = req.body;
  if (!["Approved", "Rejected"].includes(status)) {
    return res.status(400).json({ error: "status must be Approved or Rejected" });
  }
  if (existing.status !== "Pending") {
    return res.status(409).json({ error: `fund request is already ${existing.status}` });
  }
  db.exec("BEGIN");
  try {
    db.prepare(
      "UPDATE fund_requests SET status=?, process_note=?, processed_at=datetime('now') WHERE id=?"
    ).run(status, process_note || null, req.params.id);
    if (status === "Approved") {
      db.prepare(
        `INSERT INTO wallet_transactions (member_code, wallet_type, txn_type, amount, reason)
         VALUES (?, ?, 'debit', ?, ?)`
      ).run(existing.member_code, existing.wallet_type, existing.amount, `Fund request #${existing.id} approved`);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    return res.status(500).json({ error: err.message });
  }
  res.json(db.prepare("SELECT * FROM fund_requests WHERE id = ?").get(req.params.id));
});

// "Payout Transfer Weekly" — per-member breakdown of one committed
// weekly run (same source as the run's own totals, sliced per member).
app.get("/api/reports/payout-transfer-weekly", requireAccess("reports"), (req, res) => {
  const { period } = req.query;
  if (!period) return res.status(400).json({ error: "period query param is required" });
  const rows = db
    .prepare(
      `SELECT payouts.*, members.name AS member_name FROM payouts
       JOIN members ON members.member_code = payouts.member_code
       WHERE payouts.period_label = ? ORDER BY payouts.net_amount DESC`
    )
    .all(period);
  res.json({ period_label: period, count: rows.length, total_net: round2(rows.reduce((s, r) => s + r.net_amount, 0)), rows });
});

// "Topup Detail" — pv_ledger rows recorded as a package upgrade/topup
// rather than a regular order (entry_type = 'topup').
app.get("/api/reports/topup-detail", requireAccess("reports"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT pv_ledger.*, members.name AS member_name FROM pv_ledger
       JOIN members ON members.member_code = pv_ledger.member_code
       WHERE pv_ledger.entry_type = 'topup' ORDER BY pv_ledger.created_at DESC`
    )
    .all();
  res.json(rows);
});

// "All TDS Report" — TDS withheld per committed period.
app.get("/api/reports/tds", requireAccess("reports"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT period_label, COUNT(*) AS member_count, SUM(gross_amount) AS total_gross,
              SUM(tds_amount) AS total_tds, SUM(net_amount) AS total_net
       FROM payouts GROUP BY period_label ORDER BY period_label DESC`
    )
    .all();
  res.json(rows);
});

// ---------- Utility: Fund Credit / Debit (wallet ledger) ----------
// wallet_transactions already existed (the weekly payout engine writes
// to it) but had no direct API — this is the "Fund Credit", "Fund Credit
// Detail", "Fund Credit/Debit" screen: admin can manually adjust a
// member's wallet (bonus, correction, manual deduction) with a reason,
// and see the full ledger.

app.get("/api/wallet/transactions", requireAccess("accounts"), (req, res) => {
  const { member_code, txn_type } = req.query;
  let sql = `SELECT wallet_transactions.*, members.name AS member_name FROM wallet_transactions
             JOIN members ON members.member_code = wallet_transactions.member_code`;
  const clauses = [];
  const params = [];
  if (member_code) { clauses.push("wallet_transactions.member_code = ?"); params.push(member_code); }
  if (txn_type) { clauses.push("wallet_transactions.txn_type = ?"); params.push(txn_type); }
  if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
  sql += " ORDER BY wallet_transactions.created_at DESC";
  res.json(db.prepare(sql).all(...params));
});

app.get("/api/wallet/:code", requireAccess("accounts"), (req, res) => {
  const member = db.prepare("SELECT member_code FROM members WHERE member_code = ?").get(req.params.code);
  if (!member) return res.status(404).json({ error: "not found" });
  const transactions = db
    .prepare("SELECT * FROM wallet_transactions WHERE member_code = ? ORDER BY created_at DESC")
    .all(req.params.code);
  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN txn_type='credit' THEN amount ELSE 0 END),0) AS total_credit,
              COALESCE(SUM(CASE WHEN txn_type='debit' THEN amount ELSE 0 END),0) AS total_debit
       FROM wallet_transactions WHERE member_code = ?`
    )
    .get(req.params.code);
  res.json({
    member_code: req.params.code,
    total_credit: totals.total_credit,
    total_debit: totals.total_debit,
    balance: round2(totals.total_credit - totals.total_debit),
    transactions,
  });
});

function walletAdjust(txnType) {
  return (req, res) => {
    const { member_code, amount, wallet_type, reason } = req.body;
    if (!member_code || !amount) return res.status(400).json({ error: "member_code and amount are required" });
    if (Number(amount) <= 0) return res.status(400).json({ error: "amount must be positive" });
    const member = db.prepare("SELECT member_code FROM members WHERE member_code = ?").get(member_code);
    if (!member) return res.status(400).json({ error: `unknown member_code "${member_code}"` });
    const result = db
      .prepare(
        "INSERT INTO wallet_transactions (member_code, wallet_type, txn_type, amount, reason) VALUES (?, ?, ?, ?, ?)"
      )
      .run(member_code, wallet_type || "Weekly", txnType, round2(Number(amount)), reason || null);
    res.json(db.prepare("SELECT * FROM wallet_transactions WHERE id = ?").get(result.lastInsertRowid));
  };
}
app.post("/api/wallet/credit", requireAccess("accounts"), walletAdjust("credit"));
app.post("/api/wallet/debit", requireAccess("accounts"), walletAdjust("debit"));

// ---------- Reward Session (Master for the "session_label" already on rewards) ----------

app.get("/api/reward-sessions", requireAccess("rewards"), (req, res) => {
  res.json(db.prepare("SELECT * FROM reward_sessions ORDER BY session_date DESC").all());
});

app.post("/api/reward-sessions", requireAccess("rewards"), (req, res) => {
  const { session_name, session_date, status } = req.body;
  if (!session_name) return res.status(400).json({ error: "session_name is required" });
  try {
    const result = db
      .prepare("INSERT INTO reward_sessions (session_name, session_date, status) VALUES (?, ?, ?)")
      .run(session_name, session_date || null, status || "Active");
    res.json(db.prepare("SELECT * FROM reward_sessions WHERE id = ?").get(result.lastInsertRowid));
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(409).json({ error: `reward session "${session_name}" already exists` });
    }
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/reward-sessions/:id", requireAccess("rewards"), (req, res) => {
  const existing = db.prepare("SELECT * FROM reward_sessions WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "not found" });
  const merged = { ...existing, ...req.body };
  db.prepare("UPDATE reward_sessions SET session_name=?, session_date=?, status=? WHERE id=?").run(
    merged.session_name,
    merged.session_date,
    merged.status,
    req.params.id
  );
  res.json(db.prepare("SELECT * FROM reward_sessions WHERE id = ?").get(req.params.id));
});

app.delete("/api/reward-sessions/:id", requireAccess("rewards"), (req, res) => {
  const result = db.prepare("DELETE FROM reward_sessions WHERE id = ?").run(req.params.id);
  res.json({ deleted: result.changes > 0 });
});

// ==========================================================================
// PHASE 7 — admin.airxplus.com's public-facing content menus (2026-08-24)
// News, Meeting, Gallery, Video, Media/Presentations, Training, Testimonial,
// Slider. One generic table (cms_content, see db.js) + one generic CRUD
// route family keyed by :type, instead of seven near-identical route sets.
// ==========================================================================

const CMS_CONTENT_TYPES = [
  "news",
  "meeting",
  "gallery",
  "video",
  "media",
  "training",
  "testimonial",
  "slider",
];

function requireCmsType(req, res, next) {
  if (!CMS_CONTENT_TYPES.includes(req.params.type)) {
    return res.status(400).json({ error: `unknown content type "${req.params.type}". Valid: ${CMS_CONTENT_TYPES.join(", ")}` });
  }
  next();
}

app.get("/api/cms/:type", requireAccess("cms"), requireCmsType, (req, res) => {
  res.json(
    db
      .prepare("SELECT * FROM cms_content WHERE content_type = ? ORDER BY display_order ASC, created_at DESC")
      .all(req.params.type)
  );
});

app.post("/api/cms/:type", requireAccess("cms"), requireCmsType, (req, res) => {
  const { title, description, image_url, link_url, event_date, display_order, status } = req.body;
  if (!title) return res.status(400).json({ error: "title is required" });
  const result = db
    .prepare(
      `INSERT INTO cms_content (content_type, title, description, image_url, link_url, event_date, display_order, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.params.type,
      title,
      description || null,
      image_url || null,
      link_url || null,
      event_date || null,
      Number.isFinite(Number(display_order)) ? Number(display_order) : 0,
      status || "Active"
    );
  res.json(db.prepare("SELECT * FROM cms_content WHERE id = ?").get(result.lastInsertRowid));
});

app.patch("/api/cms/:type/:id", requireAccess("cms"), requireCmsType, (req, res) => {
  const existing = db
    .prepare("SELECT * FROM cms_content WHERE id = ? AND content_type = ?")
    .get(req.params.id, req.params.type);
  if (!existing) return res.status(404).json({ error: "not found" });
  const merged = { ...existing, ...req.body };
  db.prepare(
    `UPDATE cms_content SET title=?, description=?, image_url=?, link_url=?, event_date=?, display_order=?, status=?, updated_at=datetime('now')
     WHERE id=?`
  ).run(
    merged.title,
    merged.description,
    merged.image_url,
    merged.link_url,
    merged.event_date,
    Number.isFinite(Number(merged.display_order)) ? Number(merged.display_order) : 0,
    merged.status,
    req.params.id
  );
  res.json(db.prepare("SELECT * FROM cms_content WHERE id = ?").get(req.params.id));
});

app.delete("/api/cms/:type/:id", requireAccess("cms"), requireCmsType, (req, res) => {
  const result = db
    .prepare("DELETE FROM cms_content WHERE id = ? AND content_type = ?")
    .run(req.params.id, req.params.type);
  res.json({ deleted: result.changes > 0 });
});

// ==========================================================================
// PHASE 8 — multi-user admin auth: Admin / User / UserGroup / Permissions
// (2026-08-24). Additive on top of the existing single-shared-AIRX_API_KEY
// model (see requireAccess above) — every route below is brand new, nothing
// pre-existing was touched in this pass.
// ==========================================================================

const SESSION_DAYS = 7;

function issueSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO admin_sessions (user_id, token, expires_at) VALUES (?, ?, ?)").run(userId, token, expiresAt);
  return { token, expiresAt };
}

function publicUser(user, role) {
  let permissions = [];
  try {
    permissions = JSON.parse(role.permissions);
  } catch (e) {
    permissions = [];
  }
  return {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    status: user.status,
    role_id: role.id,
    role_name: role.role_name,
    permissions,
  };
}

// GET /api/auth/bootstrap-status — public. The admin.html login screen uses
// this to decide whether to show "create the first Super Admin" instead of
// a normal login form (no staff accounts exist yet).
app.get("/api/auth/bootstrap-status", (req, res) => {
  const count = db.prepare("SELECT COUNT(*) AS n FROM admin_users").get().n;
  res.json({ needsBootstrap: count === 0 });
});

// POST /api/auth/bootstrap — public, but self-disables the moment the first
// admin_users row exists (409 after that). Creates (or reuses) a "Super
// Admin" role with permissions ["*"] and the first user, then logs them in.
app.post("/api/auth/bootstrap", (req, res) => {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM admin_users").get().n;
  if (existing > 0) {
    return res.status(409).json({ error: "an admin user already exists — use /api/auth/login instead" });
  }
  const { username, password, full_name } = req.body;
  if (!username || !password) return res.status(400).json({ error: "username and password are required" });
  if (String(password).length < 8) return res.status(400).json({ error: "password must be at least 8 characters" });
  let role = db.prepare("SELECT * FROM admin_roles WHERE role_name = 'Super Admin'").get();
  if (!role) {
    const roleResult = db
      .prepare("INSERT INTO admin_roles (role_name, permissions) VALUES ('Super Admin', ?)")
      .run(JSON.stringify(["*"]));
    role = db.prepare("SELECT * FROM admin_roles WHERE id = ?").get(roleResult.lastInsertRowid);
  }
  const { salt, hash } = hashPassword(password);
  const userResult = db
    .prepare("INSERT INTO admin_users (username, password_hash, password_salt, full_name, role_id) VALUES (?, ?, ?, ?, ?)")
    .run(username, hash, salt, full_name || null, role.id);
  const user = db.prepare("SELECT * FROM admin_users WHERE id = ?").get(userResult.lastInsertRowid);
  const { token, expiresAt } = issueSession(user.id);
  res.json({ token, expiresAt, user: publicUser(user, role) });
});

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "username and password are required" });
  const user = db.prepare("SELECT * FROM admin_users WHERE username = ?").get(username);
  if (!user || user.status !== "Active" || !verifyPassword(password, user.password_salt, user.password_hash)) {
    return res.status(401).json({ error: "invalid username or password" });
  }
  const role = db.prepare("SELECT * FROM admin_roles WHERE id = ?").get(user.role_id);
  db.prepare("UPDATE admin_users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  const { token, expiresAt } = issueSession(user.id);
  res.json({ token, expiresAt, user: publicUser(user, role) });
});

app.post("/api/auth/logout", (req, res) => {
  const auth = req.header("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (!token) return res.json({ loggedOut: false });
  const result = db.prepare("DELETE FROM admin_sessions WHERE token = ?").run(token);
  res.json({ loggedOut: result.changes > 0 });
});

app.get("/api/auth/me", (req, res) => {
  const apiKey = req.header("x-api-key");
  if (process.env.AIRX_API_KEY && apiKey === process.env.AIRX_API_KEY) {
    return res.json({ type: "system", username: "system (AIRX_API_KEY)", permissions: ["*"] });
  }
  const auth = req.header("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  const loaded = loadSession(token);
  if (!loaded) return res.status(401).json({ error: "invalid or missing credentials" });
  res.json({ type: "admin_user", ...publicUser(loaded.user, loaded.role) });
});

// ---------- UserGroup / Permissions (admin_roles) ----------

app.get("/api/admin/roles", requireAccess("user_management"), (req, res) => {
  res.json(db.prepare("SELECT * FROM admin_roles ORDER BY role_name ASC").all().map((r) => ({ ...r, permissions: JSON.parse(r.permissions) })));
});

app.post("/api/admin/roles", requireAccess("user_management"), (req, res) => {
  const { role_name, permissions } = req.body;
  if (!role_name) return res.status(400).json({ error: "role_name is required" });
  const perms = Array.isArray(permissions) ? permissions : [];
  const invalid = perms.filter((p) => p !== "*" && !MODULE_KEYS.includes(p));
  if (invalid.length) return res.status(400).json({ error: `unknown permission(s): ${invalid.join(", ")}` });
  try {
    const result = db.prepare("INSERT INTO admin_roles (role_name, permissions) VALUES (?, ?)").run(role_name, JSON.stringify(perms));
    const row = db.prepare("SELECT * FROM admin_roles WHERE id = ?").get(result.lastInsertRowid);
    res.json({ ...row, permissions: JSON.parse(row.permissions) });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) return res.status(409).json({ error: `role "${role_name}" already exists` });
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/admin/roles/:id", requireAccess("user_management"), (req, res) => {
  const existing = db.prepare("SELECT * FROM admin_roles WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "not found" });
  const role_name = req.body.role_name || existing.role_name;
  let perms = existing.permissions;
  if (Array.isArray(req.body.permissions)) {
    const invalid = req.body.permissions.filter((p) => p !== "*" && !MODULE_KEYS.includes(p));
    if (invalid.length) return res.status(400).json({ error: `unknown permission(s): ${invalid.join(", ")}` });
    perms = JSON.stringify(req.body.permissions);
  }
  db.prepare("UPDATE admin_roles SET role_name=?, permissions=? WHERE id=?").run(role_name, perms, req.params.id);
  const row = db.prepare("SELECT * FROM admin_roles WHERE id = ?").get(req.params.id);
  res.json({ ...row, permissions: JSON.parse(row.permissions) });
});

app.delete("/api/admin/roles/:id", requireAccess("user_management"), (req, res) => {
  const inUse = db.prepare("SELECT 1 FROM admin_users WHERE role_id = ? LIMIT 1").get(req.params.id);
  if (inUse) return res.status(409).json({ error: "cannot delete a role that is still assigned to a user — reassign them first" });
  const result = db.prepare("DELETE FROM admin_roles WHERE id = ?").run(req.params.id);
  res.json({ deleted: result.changes > 0 });
});

// ---------- Admin Users ----------

app.get("/api/admin/users", requireAccess("user_management"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT admin_users.*, admin_roles.role_name, admin_roles.permissions AS role_permissions
       FROM admin_users JOIN admin_roles ON admin_roles.id = admin_users.role_id
       ORDER BY admin_users.created_at DESC`
    )
    .all();
  res.json(
    rows.map((r) => ({
      id: r.id,
      username: r.username,
      full_name: r.full_name,
      status: r.status,
      role_id: r.role_id,
      role_name: r.role_name,
      permissions: JSON.parse(r.role_permissions),
      created_at: r.created_at,
      last_login_at: r.last_login_at,
    }))
  );
});

app.post("/api/admin/users", requireAccess("user_management"), (req, res) => {
  const { username, password, full_name, role_id } = req.body;
  if (!username || !password || !role_id) return res.status(400).json({ error: "username, password and role_id are required" });
  if (String(password).length < 8) return res.status(400).json({ error: "password must be at least 8 characters" });
  const role = db.prepare("SELECT * FROM admin_roles WHERE id = ?").get(role_id);
  if (!role) return res.status(400).json({ error: "unknown role_id" });
  const { salt, hash } = hashPassword(password);
  try {
    const result = db
      .prepare("INSERT INTO admin_users (username, password_hash, password_salt, full_name, role_id) VALUES (?, ?, ?, ?, ?)")
      .run(username, hash, salt, full_name || null, role_id);
    const user = db.prepare("SELECT * FROM admin_users WHERE id = ?").get(result.lastInsertRowid);
    res.json(publicUser(user, role));
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) return res.status(409).json({ error: `username "${username}" already exists` });
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/admin/users/:id", requireAccess("user_management"), (req, res) => {
  const existing = db.prepare("SELECT * FROM admin_users WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "not found" });
  const merged = {
    full_name: req.body.full_name !== undefined ? req.body.full_name : existing.full_name,
    role_id: req.body.role_id !== undefined ? req.body.role_id : existing.role_id,
    status: req.body.status !== undefined ? req.body.status : existing.status,
  };
  if (merged.role_id !== existing.role_id && !db.prepare("SELECT 1 FROM admin_roles WHERE id = ?").get(merged.role_id)) {
    return res.status(400).json({ error: "unknown role_id" });
  }
  db.prepare("UPDATE admin_users SET full_name=?, role_id=?, status=? WHERE id=?").run(
    merged.full_name,
    merged.role_id,
    merged.status,
    req.params.id
  );
  const role = db.prepare("SELECT * FROM admin_roles WHERE id = ?").get(merged.role_id);
  const user = db.prepare("SELECT * FROM admin_users WHERE id = ?").get(req.params.id);
  res.json(publicUser(user, role));
});

app.post("/api/admin/users/:id/reset-password", requireAccess("user_management"), (req, res) => {
  const existing = db.prepare("SELECT * FROM admin_users WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "not found" });
  const { password } = req.body;
  if (!password || String(password).length < 8) return res.status(400).json({ error: "password must be at least 8 characters" });
  const { salt, hash } = hashPassword(password);
  db.prepare("UPDATE admin_users SET password_hash=?, password_salt=? WHERE id=?").run(hash, salt, req.params.id);
  db.prepare("DELETE FROM admin_sessions WHERE user_id = ?").run(req.params.id); // force re-login everywhere
  res.json({ reset: true });
});

app.delete("/api/admin/users/:id", requireAccess("user_management"), (req, res) => {
  const totalUsers = db.prepare("SELECT COUNT(*) AS n FROM admin_users").get().n;
  if (totalUsers <= 1) {
    return res.status(409).json({ error: "cannot delete the last remaining admin user — create another one first" });
  }
  db.prepare("DELETE FROM admin_sessions WHERE user_id = ?").run(req.params.id);
  const result = db.prepare("DELETE FROM admin_users WHERE id = ?").run(req.params.id);
  res.json({ deleted: result.changes > 0 });
});

app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`AIRX backend listening on port ${PORT}`);
});
