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
// Same DATA_DIR the SQLite database (db.js) uses — the Render Persistent
// Disk mount path when one is attached, __dirname/data otherwise. These
// flat JSON files predate the SQLite migration and were left pointed at
// __dirname/data (the container's own ephemeral filesystem), which meant
// every deploy silently wiped orders/leads/inventory AND the Shopify OAuth
// connection — found when a post-deploy smoke test showed 14 synced orders
// had vanished and Shopify reported "not connected" right after a push.
// Fixed by pointing these at DATA_DIR too, exactly like db.js already does.
const JSON_DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const LEADS_FILE = path.join(JSON_DATA_DIR, "leads.json");
const ORDERS_FILE = path.join(JSON_DATA_DIR, "orders.json");
const SHOP_FILE = path.join(JSON_DATA_DIR, "shopify.json");

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
  if (!fs.existsSync(JSON_DATA_DIR)) fs.mkdirSync(JSON_DATA_DIR, { recursive: true });
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
  "franchise_commission",
  "orders",
  "leads",
  "inventory",
  "staff",
  "ai_assistant",
  "social_media",
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
        try {
          if (change.field === "leadgen") {
            const leadgenId = change.value.leadgen_id;
            const formId = change.value.form_id;
            const pageId = change.value.page_id;
            await fetchAndStoreLead(leadgenId, { formId, pageId });
          } else if (change.field === "feed" && change.value && change.value.item === "comment" && change.value.verb === "add") {
            // Facebook Page comment (Phase 16 — Social Media Hub).
            await handleIncomingSocialComment({
              platform: "facebook",
              externalId: change.value.comment_id,
              postId: change.value.post_id,
              fromName: (change.value.from && change.value.from.name) || "",
              message: change.value.message || "",
            });
          } else if (change.field === "comments" && change.value) {
            // Instagram comment (Phase 16 — Social Media Hub).
            await handleIncomingSocialComment({
              platform: "instagram",
              externalId: change.value.id,
              postId: (change.value.media && change.value.media.id) || "",
              fromName: (change.value.from && change.value.from.username) || "",
              message: change.value.text || "",
            });
          }
        } catch (err) {
          console.error("Meta webhook: failed to process one change entry:", err);
        }
      }
      // Messenger DMs arrive as a separate top-level `messaging` array, not
      // inside `changes` (Phase 16 — Social Media Hub).
      const messagingEvents = entry.messaging || [];
      for (const event of messagingEvents) {
        try {
          if (event.message && event.message.text && event.sender && event.sender.id) {
            await handleIncomingSocialComment({
              platform: "facebook",
              type: "dm",
              externalId: event.message.mid || `${event.sender.id}-${event.timestamp}`,
              postId: event.sender.id, // for a DM this is the sender PSID, needed to reply
              fromName: "",
              message: event.message.text,
            });
          }
        } catch (err) {
          console.error("Meta webhook: failed to process one messaging event:", err);
        }
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
// Factored out of the route handler so the auto-sync interval below (and any
// future scheduled job) can call the exact same logic the manual button uses.
async function syncShopifyOrders() {
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
  return { synced: added, total: orders.length };
}

app.post("/api/shopify/sync-orders", requireAccess("orders"), async (req, res) => {
  try {
    const result = await syncShopifyOrders();
    res.json(result);
  } catch (err) {
    console.error("Shopify sync error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Auto-sync: pull new Shopify orders in on a timer instead of waiting for
// someone to click the manual "Sync from Shopify" button. Only runs once
// the OAuth handshake has actually happened (SHOP_FILE has a stored
// accessToken) — until then it silently no-ops so a fresh deploy with
// Shopify not yet connected doesn't spam the logs with errors.
const SHOPIFY_AUTO_SYNC_MS = 5 * 60 * 1000; // every 5 minutes
setInterval(async () => {
  try {
    const { shop, accessToken } = readJson(SHOP_FILE);
    if (!shop || !accessToken) return; // not connected yet — skip quietly
    const result = await syncShopifyOrders();
    if (result.synced > 0) {
      console.log(`[Shopify auto-sync] pulled ${result.synced} new order(s), total ${result.total}`);
    }
  } catch (err) {
    console.error("[Shopify auto-sync] error:", err.message);
  }
}, SHOPIFY_AUTO_SYNC_MS);

// Once an order is booked with India Post, call this so Shopify stops
// showing it as "Unfulfilled" forever - this closes the gap we found where
// all 262 orders sat unfulfilled even though they'd actually shipped.
app.post("/api/shopify/fulfill", requireAccess("orders"), async (req, res) => {
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

const INDIAPOST_FILE = path.join(JSON_DATA_DIR, "indiapost.json");
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
const PROXY_STATUS_FILE = path.join(JSON_DATA_DIR, "proxy-status-reports.json");
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
app.get("/api/indiapost/pincode/:pincode", requireAccess("orders"), async (req, res) => {
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
app.post("/api/indiapost/book", requireAccess("orders"), async (req, res) => {
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
app.post("/api/indiapost/track", requireAccess("orders"), async (req, res) => {
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
        if (orders[idx].status !== "delivered" && !orders[idx].deliveredAt) {
          orders[idx].deliveredAt = new Date().toISOString();
        }
        processReferralOnDelivery(orders[idx], orders); // Phase 17 - referral bridge
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

app.get("/api/leads", requireAccess("leads"), (req, res) => {
  res.json(readJson(LEADS_FILE));
});

app.patch("/api/leads/:id", requireAccess("leads"), (req, res) => {
  const leads = readJson(LEADS_FILE);
  const idx = leads.findIndex((l) => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  leads[idx] = { ...leads[idx], ...req.body };
  writeJson(LEADS_FILE, leads);
  res.json(leads[idx]);
});

app.get("/api/orders", requireAccess("orders"), (req, res) => {
  res.json(readJson(ORDERS_FILE));
});

app.post("/api/orders", requireAccess("orders"), (req, res) => {
  const orders = readJson(ORDERS_FILE);
  const order = { id: "o" + Date.now(), createdAt: new Date().toISOString(), ...req.body };
  orders.unshift(order);
  writeJson(ORDERS_FILE, orders);
  res.json(order);
});

app.patch("/api/orders/:id", requireAccess("orders"), (req, res) => {
  const orders = readJson(ORDERS_FILE);
  const idx = orders.findIndex((o) => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  const wasDelivered = orders[idx].status === "delivered";
  orders[idx] = { ...orders[idx], ...req.body };
  // Stamp deliveredAt the first time an order turns "delivered" - the
  // replenishment-reminder feature (below) uses this to know when a
  // customer's reorder cycle starts. Doesn't overwrite one that's already set.
  if (!wasDelivered && orders[idx].status === "delivered" && !orders[idx].deliveredAt) {
    orders[idx].deliveredAt = new Date().toISOString();
  }
  if (!wasDelivered && orders[idx].status === "delivered") {
    processReferralOnDelivery(orders[idx], orders); // Phase 17 - referral bridge
  }
  writeJson(ORDERS_FILE, orders);
  res.json(orders[idx]);
});

// =====================================================================
// PUBLIC ORDER TRACKING — no login, so customers self-serve "where is my
// order" instead of messaging staff. Serves the "less staff" goal directly.
//
// Deliberately simple threat model for a small COD-first D2C business:
// looked up by the customer's own mobile number, same number their
// delivery already goes to. No password, no order-ID hunting. To raise
// the bar above "guess a random 10-digit number," a small in-memory
// per-IP throttle below caps lookups — not bulletproof (resets on
// restart, doesn't survive multiple server instances), but proportionate
// for this business's actual risk (COD grocery-sized orders, not
// financial data) rather than adding a login system that would just
// push customers back to messaging staff, defeating the point.
// =====================================================================

const trackingAttempts = new Map(); // ip -> [timestamps]
const TRACKING_RATE_LIMIT = 15; // lookups
const TRACKING_RATE_WINDOW_MS = 10 * 60 * 1000; // per 10 minutes
function isRateLimited(ip) {
  const now = Date.now();
  const attempts = (trackingAttempts.get(ip) || []).filter((t) => now - t < TRACKING_RATE_WINDOW_MS);
  attempts.push(now);
  trackingAttempts.set(ip, attempts);
  return attempts.length > TRACKING_RATE_LIMIT;
}

app.get("/api/public/track", (req, res) => {
  // x-forwarded-for can be a multi-hop chain ("client, proxy1, proxy2") and
  // Render's edge may vary the proxy hops per request even for the same
  // client — so key the limiter on just the first (client) IP, not the
  // raw header string, or the limiter never matches the same visitor twice.
  const forwardedFor = req.header("x-forwarded-for");
  const ip = (forwardedFor ? forwardedFor.split(",")[0].trim() : "") || req.socket.remoteAddress || "unknown";
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "Too many lookups — please try again in a few minutes." });
  }
  const mobile = String(req.query.mobile || "").replace(/\D/g, "").slice(-10);
  if (mobile.length !== 10) {
    return res.status(400).json({ error: "Enter a valid 10-digit mobile number." });
  }
  const orders = readJson(ORDERS_FILE);
  const matches = orders
    .filter((o) => String(o.mobile || "").replace(/\D/g, "").slice(-10) === mobile)
    .slice(0, 5)
    .map((o) => ({
      createdAt: o.createdAt,
      product: o.product,
      status: o.status,
      codAmount: o.codAmount,
      trackingBarcode: o.indiaPostBarcode || null,
      latestEvent:
        o.indiaPostEvents && o.indiaPostEvents.length
          ? o.indiaPostEvents[o.indiaPostEvents.length - 1].event_description || null
          : null,
    }));
  res.json({ orders: matches });
});

// =====================================================================
// INVENTORY — stock tracking, auto-decrement on booking
// =====================================================================

const INVENTORY_FILE = path.join(JSON_DATA_DIR, "inventory.json");
if (!fs.existsSync(INVENTORY_FILE)) {
  fs.writeFileSync(INVENTORY_FILE, "[]");
}
// Each item: { sku, name, stock, lowStockThreshold, batchNumber, expiryDate }
// batchNumber/expiryDate are optional (Ayurvedic formulations are batch-
// manufactured with a shelf life; older stock without a recorded batch just
// shows no expiry info rather than breaking anything).

app.get("/api/inventory", requireAccess("inventory"), (req, res) => {
  res.json(readJson(INVENTORY_FILE));
});

app.post("/api/inventory", requireAccess("inventory"), (req, res) => {
  const items = readJson(INVENTORY_FILE);
  const item = {
    sku: req.body.sku || "sku" + Date.now(),
    name: req.body.name || "",
    stock: Number(req.body.stock) || 0,
    lowStockThreshold: Number(req.body.lowStockThreshold) || 5,
    batchNumber: req.body.batchNumber || null,
    expiryDate: req.body.expiryDate || null, // "YYYY-MM-DD"
    reorderCycleDays: Number(req.body.reorderCycleDays) > 0 ? Number(req.body.reorderCycleDays) : null, // null = use DEFAULT_REORDER_CYCLE_DAYS
  };
  items.push(item);
  writeJson(INVENTORY_FILE, items);
  res.json(item);
});

app.patch("/api/inventory/:sku", requireAccess("inventory"), (req, res) => {
  const items = readJson(INVENTORY_FILE);
  const idx = items.findIndex((i) => i.sku === req.params.sku);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  items[idx] = { ...items[idx], ...req.body };
  writeJson(INVENTORY_FILE, items);
  res.json(items[idx]);
});

app.delete("/api/inventory/:sku", requireAccess("inventory"), (req, res) => {
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
// REPLENISHMENT REMINDERS — repeat-purchase nudges for Ayurvedic
// formulations, which run out on a fairly predictable cycle. This is
// entirely code-level (no new Shopify permissions, no WhatsApp account
// needed to build it) - the "Send reminder" button below reuses the same
// sendWhatsApp() used elsewhere, which just logs and skips until
// WHATSAPP_TOKEN/WHATSAPP_PHONE_ID are set, same inert-until-configured
// pattern as the rest of the WhatsApp automation.
// =====================================================================

const REPLENISH_DISMISSED_FILE = path.join(JSON_DATA_DIR, "replenish_dismissed.json");
if (!fs.existsSync(REPLENISH_DISMISSED_FILE)) fs.writeFileSync(REPLENISH_DISMISSED_FILE, "[]");
// [{ orderId, sku, dismissedAt }] - staff can dismiss a reminder (already
// contacted some other way, or not applicable) without it reappearing.

// No real per-product consumption data exists yet, so this default is a
// starting assumption for a typical month's-supply Ayurvedic churna/tablet
// pack - admin-configurable per item via the Inventory tab's
// "Reorder cycle" field, same "confirmed vs provisional, tune without a
// code change" approach used for the Phase 3 commission settings.
const DEFAULT_REORDER_CYCLE_DAYS = 30;

// Orders store product as free text like "Product A x2, Product B x1"
// (from Shopify line items or WhatsApp paste) - same parsing
// decrementInventoryForOrder() above uses, factored out so both share one
// definition of "which inventory item does this order line refer to."
function extractOrderProductSegments(productText) {
  return (productText || "")
    .split(",")
    .map((segment) => {
      const trimmed = segment.trim();
      const qtyMatch = trimmed.match(/x\s*(\d+)\s*$/i);
      const qty = qtyMatch ? Number(qtyMatch[1]) : 1;
      const nameOnly = trimmed.replace(/x\s*\d+\s*$/i, "").trim().toLowerCase();
      return { nameOnly, qty };
    })
    .filter((s) => s.nameOnly);
}

// Phase 21: per-customer replenishment timing. Phase 14's cycle length was
// one fixed number per product (admin-configured, or the 30-day default)
// applied identically to every customer. Real customers don't all consume a
// pack at the same rate - a family sharing one order finishes it faster than
// someone taking it once a day solo. Once a customer has reordered the same
// product before, we use THEIR OWN observed gap between orders instead of
// the one-size-fits-all number - the reminder gets more accurate for a
// customer the more order history they build up, with no manual tuning.
// Pure function - no I/O beyond the orders array already in memory.
function computePersonalizedCycleDays(mobile, itemName, orders) {
  const nameLower = itemName.toLowerCase();
  const deliveries = orders
    .filter((o) => o.mobile === mobile && o.status === "delivered")
    .filter((o) => extractOrderProductSegments(o.product).some((s) => s.nameOnly.includes(nameLower)))
    .map((o) => new Date(o.deliveredAt || o.createdAt).getTime())
    .filter((ms) => !isNaN(ms))
    .sort((a, b) => a - b);
  if (deliveries.length < 2) return null; // not enough history yet - fall back to the item/default cycle
  const intervalsDays = [];
  for (let i = 1; i < deliveries.length; i++) {
    intervalsDays.push((deliveries[i] - deliveries[i - 1]) / (24 * 60 * 60 * 1000));
  }
  const avg = intervalsDays.reduce((s, d) => s + d, 0) / intervalsDays.length;
  // Clamp to a sane range - a data-entry glitch (two orders logged a day
  // apart) shouldn't produce a cycle so short it spams the customer, and a
  // multi-year gap between two one-off orders shouldn't produce a cycle so
  // long it never reminds them again.
  return Math.round(Math.min(180, Math.max(7, avg)));
}

// Pure function (no I/O beyond the three JSON reads) so it's easy to unit
// test - see test_phase14.js and test_phase21.js.
function computeReplenishmentDue(orders, items, dismissed, now) {
  now = now || Date.now();
  const isDismissed = (orderId, sku) => dismissed.some((d) => d.orderId === orderId && d.sku === sku);
  const due = [];

  orders.forEach((order) => {
    if (order.status !== "delivered" || !order.mobile) return;
    const deliveredAt = order.deliveredAt || order.createdAt; // legacy orders predating the deliveredAt stamp
    if (!deliveredAt) return;
    const deliveredMs = new Date(deliveredAt).getTime();
    if (isNaN(deliveredMs)) return;

    extractOrderProductSegments(order.product).forEach(({ nameOnly }) => {
      const item = items.find((i) => i.name && nameOnly.includes(i.name.toLowerCase()));
      if (!item) return;
      if (isDismissed(order.id, item.sku)) return;

      const personalizedCycleDays = computePersonalizedCycleDays(order.mobile, item.name, orders);
      const cycleDays = personalizedCycleDays || (Number(item.reorderCycleDays) > 0 ? Number(item.reorderCycleDays) : DEFAULT_REORDER_CYCLE_DAYS);
      const cycleSource = personalizedCycleDays ? "personalized" : (Number(item.reorderCycleDays) > 0 ? "item-configured" : "default");
      const dueMs = deliveredMs + cycleDays * 24 * 60 * 60 * 1000;
      if (now < dueMs) return; // not due yet

      // Skip if this same customer already has a later order for the same
      // product - they've already reordered, no need to nudge again.
      const alreadyReordered = orders.some((o2) => {
        if (o2.id === order.id || o2.mobile !== order.mobile) return false;
        const createdMs = new Date(o2.createdAt).getTime();
        if (isNaN(createdMs) || createdMs <= deliveredMs) return false;
        return extractOrderProductSegments(o2.product).some((s2) => s2.nameOnly.includes(item.name.toLowerCase()));
      });
      if (alreadyReordered) return;

      due.push({
        orderId: order.id,
        sku: item.sku,
        product: item.name,
        mobile: order.mobile,
        name: order.name || "",
        deliveredAt,
        daysSinceDelivered: Math.floor((now - deliveredMs) / (24 * 60 * 60 * 1000)),
        reorderCycleDays: cycleDays,
        cycleSource,
        daysOverdue: Math.floor((now - dueMs) / (24 * 60 * 60 * 1000)),
      });
    });
  });

  due.sort((a, b) => b.daysOverdue - a.daysOverdue);
  return due;
}

app.get("/api/replenishment/due", requireAccess("orders"), (req, res) => {
  try {
    const due = computeReplenishmentDue(readJson(ORDERS_FILE), readJson(INVENTORY_FILE), readJson(REPLENISH_DISMISSED_FILE));
    res.json(due);
  } catch (err) {
    console.error("Replenishment due error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/replenishment/dismiss", requireAccess("orders"), (req, res) => {
  const { orderId, sku } = req.body;
  if (!orderId || !sku) return res.status(400).json({ error: "orderId and sku required" });
  const dismissed = readJson(REPLENISH_DISMISSED_FILE);
  dismissed.push({ orderId, sku, dismissedAt: new Date().toISOString() });
  writeJson(REPLENISH_DISMISSED_FILE, dismissed);
  res.json({ dismissed: true });
});

// Phase 24: AI demand forecasting for inventory. The existing low-stock
// alert (aiTool_getLowStock / the dashboard banner) is a static threshold -
// it only fires once stock is already at or below a fixed number, with no
// sense of HOW FAST that stock is moving. A slow-selling item sitting just
// under its threshold isn't urgent; a fast-selling item still comfortably
// above its threshold can still sell out before the founder notices. This
// looks at each item's actual sales velocity over a trailing window and
// projects days-of-stock-remaining, so a genuinely soon-to-stock-out item
// surfaces even while it's still "above threshold" by the old static rule.
// Deliberately NOT a per-item AI/LLM call - this is a straightforward
// rate-projection over real order data, cheap and deterministic, always on
// regardless of whether an AI provider is configured. Pure function - no
// I/O beyond the two arrays already read elsewhere.
const DEMAND_FORECAST_LOOKBACK_DAYS = 90;
const DEMAND_FORECAST_LEAD_TIME_DAYS = 14; // flag "stock out soon" inside a typical restock lead time

function computeDemandForecast(orders, items, now) {
  now = now || Date.now();
  const windowStartMs = now - DEMAND_FORECAST_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  return items
    .map((item) => {
      const nameLower = (item.name || "").toLowerCase();
      let unitsSold = 0;
      if (nameLower) {
        orders.forEach((order) => {
          if (order.status === "cancelled") return;
          const createdMs = new Date(order.createdAt).getTime();
          if (isNaN(createdMs) || createdMs < windowStartMs || createdMs > now) return;
          extractOrderProductSegments(order.product).forEach((seg) => {
            if (seg.nameOnly.includes(nameLower)) unitsSold += seg.qty;
          });
        });
      }
      const dailyRate = unitsSold / DEMAND_FORECAST_LOOKBACK_DAYS;
      const stock = Number(item.stock) || 0;
      // No sales at all in the lookback window -> no meaningful rate to
      // project from; daysOfStockLeft stays null (excluded below) rather
      // than reporting a misleading "infinite" runway.
      const daysOfStockLeft = dailyRate > 0 ? Math.floor(stock / dailyRate) : null;
      return {
        sku: item.sku,
        name: item.name,
        stock,
        unitsSoldLast90Days: unitsSold,
        dailyRate: Math.round(dailyRate * 100) / 100,
        daysOfStockLeft,
        willStockOutSoon: daysOfStockLeft !== null && daysOfStockLeft <= DEMAND_FORECAST_LEAD_TIME_DAYS,
      };
    })
    .filter((f) => f.daysOfStockLeft !== null)
    .sort((a, b) => a.daysOfStockLeft - b.daysOfStockLeft);
}

app.get("/api/inventory/forecast", requireAccess("inventory"), (req, res) => {
  try {
    const forecast = computeDemandForecast(readJson(ORDERS_FILE), readJson(INVENTORY_FILE));
    res.json(forecast);
  } catch (err) {
    console.error("Demand forecast error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Reuses sendWhatsApp() - template name is a placeholder, same as the other
// three WhatsApp routes above; create+approve "replenishment_reminder" in
// Meta Business Manager alongside cod_confirmation/tracking_update/
// delivery_followup once WhatsApp is connected.
app.post("/api/whatsapp/replenishment-reminder", requireAccess("orders"), async (req, res) => {
  try {
    const { mobile, name, product } = req.body;
    if (!mobile) return res.status(400).json({ error: "mobile required" });
    const result = await sendWhatsApp(mobile, {
      template: "replenishment_reminder",
      templateParams: [name || "", product || ""],
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Phase 23: personalized reminder/follow-up copy. The "Send reminder" route
// above sends a fixed WhatsApp TEMPLATE (name/product as the only two blanks)
// - that's not a limitation to fix, it's a WhatsApp platform rule: any
// message sent outside a 24h customer-initiated conversation window MUST use
// a pre-approved template, free text is rejected. So instead of trying to
// personalize the template itself, this generates a warm, specific draft
// message (using the customer's name, product, and their own reorder cadence
// from Phase 21) that staff can copy today and send manually via WhatsApp/
// SMS/call - and that becomes usable as real free-text once WhatsApp is
// actually connected and a customer messages in first (sendWhatsApp's `text`
// path, already built, just unused until then). This is genuinely draft-only
// by design, not a placeholder waiting on a permission - see the pending
// items list in the README for what's actually blocked (WhatsApp itself).
async function generateReplenishmentReminderDraft({ name, product, mobile, daysOverdue, cycleSource, reorderCycleDays }) {
  const fallback = `Hi ${name || "there"}! Just checking in — based on your last ${product || "AIRX PLUS"} order, you might be running low. Reply here anytime to reorder, we're happy to help. 🙏 Team AIRX PLUS`;
  const system = `You write short, warm WhatsApp follow-up messages for AIRX PLUS Healthcare, an Ayurvedic D2C brand, reminding
a specific customer that their product may be running low and it's a good time to reorder. Use the customer's name if given.
Mention the product by name. Keep it under 350 characters, friendly and not pushy, no medical claims, no dosage advice,
no discount/offer unless told to include one. End with an invitation to reply to reorder. Output ONLY the message text,
nothing else (no quotes, no preamble).`;
  const context = `Customer name: ${name || "(unknown, use a friendly generic greeting)"}
Product: ${product || "their AIRX PLUS product"}
Days since their reminder became due: ${daysOverdue ?? "unknown"}
Their reorder cadence: ${cycleSource === "personalized" ? `personalized, based on their own past reorder gap of about ${reorderCycleDays} days` : `estimated at about ${reorderCycleDays || 30} days (not enough order history yet to personalize)`}`;
  try {
    const result = await callAI({
      messages: [
        { role: "system", content: system },
        { role: "user", content: context },
      ],
      max_tokens: 200,
    });
    if (!result.configured || !result.text) return { draft: fallback, configured: false };
    return { draft: result.text.trim(), configured: true };
  } catch (err) {
    console.error("Replenishment draft generation failed:", err.message);
    return { draft: fallback, configured: false };
  }
}

app.post("/api/replenishment/draft-message", requireAccess("orders"), async (req, res) => {
  try {
    const { name, product, mobile, daysOverdue, cycleSource, reorderCycleDays } = req.body;
    const result = await generateReplenishmentReminderDraft({ name, product, mobile, daysOverdue, cycleSource, reorderCycleDays });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// STAFF PERFORMANCE — who booked what, so staff stays visible/accountable
// =====================================================================

app.get("/api/staff/summary", requireAccess("staff"), (req, res) => {
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
app.post("/api/whatsapp/confirm-cod", requireAccess("orders"), async (req, res) => {
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
app.post("/api/whatsapp/tracking-update", requireAccess("orders"), async (req, res) => {
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
app.post("/api/whatsapp/delivery-followup", requireAccess("orders"), async (req, res) => {
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
    bank_name,
    bank_account_number,
    bank_ifsc,
    bank_account_holder,
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
       (franchise_code, franchise_name, parent_franchise_code, contact_name, contact_mobile, address, state, status,
        bank_name, bank_account_number, bank_ifsc, bank_account_holder)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      franchise_code,
      franchise_name,
      parent_franchise_code || null,
      contact_name || null,
      contact_mobile || null,
      address || null,
      state || null,
      status || "Active",
      bank_name || null,
      bank_account_number || null,
      bank_ifsc || null,
      bank_account_holder || null
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
  if (merged.parent_franchise_code && merged.parent_franchise_code === req.params.code) {
    return res.status(400).json({ error: "a franchise cannot be its own parent" });
  }
  db.prepare(
    `UPDATE franchises SET franchise_name=?, parent_franchise_code=?, contact_name=?,
     contact_mobile=?, address=?, state=?, status=?, bank_name=?, bank_account_number=?,
     bank_ifsc=?, bank_account_holder=?, updated_at=datetime('now')
     WHERE franchise_code=?`
  ).run(
    merged.franchise_name,
    merged.parent_franchise_code,
    merged.contact_name,
    merged.contact_mobile,
    merged.address,
    merged.state,
    merged.status,
    merged.bank_name,
    merged.bank_account_number,
    merged.bank_ifsc,
    merged.bank_account_holder,
    req.params.code
  );
  const row = db
    .prepare("SELECT * FROM franchises WHERE franchise_code = ?")
    .get(req.params.code);
  res.json(row);
});

// Same guard-and-explain pattern as the Phase 6 member delete fix: with
// PRAGMA foreign_keys = ON, deleting a franchise that anything else still
// points at (child franchises, warehouse stock, payout history) used to be
// a latent raw-500 waiting to happen the first time someone tried it. Block
// with a clear 409 instead.
app.delete("/api/franchises/:code", requireAccess("franchises"), (req, res) => {
  const existing = db.prepare("SELECT franchise_code FROM franchises WHERE franchise_code = ?").get(req.params.code);
  if (!existing) return res.json({ deleted: false });
  const blockers = [
    ["franchises", "parent_franchise_code", "has child franchises under it"],
    ["franchise_stock", "franchise_code", "has warehouse stock recorded"],
    ["franchise_payouts", "franchise_code", "has payout history"],
  ];
  for (const [table, col, reason] of blockers) {
    const row = db.prepare(`SELECT 1 FROM ${table} WHERE ${col} = ? LIMIT 1`).get(req.params.code);
    if (row) {
      return res.status(409).json({
        error: `cannot delete "${req.params.code}" — ${reason}. Reassign/clear those first, or set status to Inactive instead.`,
      });
    }
  }
  const result = db.prepare("DELETE FROM franchises WHERE franchise_code = ?").run(req.params.code);
  res.json({ deleted: result.changes > 0 });
});

// ---------- Franchise warehouse stock ----------
// (separate from the existing /api/inventory JSON store, which tracks
// sellable stock used by the India Post booking auto-decrement — this
// tracks stock PER FRANCHISE WAREHOUSE, matching store.airxplus.com's
// warehouseView.aspx / warehouse.aspx.)

app.get("/api/franchise-stock", requireAccess("franchises"), (req, res) => {
  const { franchise_code } = req.query;
  const rows = franchise_code
    ? db
        .prepare("SELECT * FROM franchise_stock WHERE franchise_code = ? ORDER BY sku")
        .all(franchise_code)
    : db.prepare("SELECT * FROM franchise_stock ORDER BY franchise_code, sku").all();
  res.json(rows);
});

app.post("/api/franchise-stock", requireAccess("franchises"), (req, res) => {
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
app.patch("/api/franchise-stock/:franchise_code/:sku", requireAccess("franchises"), (req, res) => {
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

app.delete("/api/franchise-stock/:franchise_code/:sku", requireAccess("franchises"), (req, res) => {
  const { franchise_code, sku } = req.params;
  const result = db
    .prepare("DELETE FROM franchise_stock WHERE franchise_code = ? AND sku = ?")
    .run(franchise_code, sku);
  res.json({ deleted: result.changes > 0 });
});

// ---------- Franchise-level Commission (store.airxplus.com's "Commission"
// menu: franchise bank details — see franchises.bank_* columns above —
// franchise payout detail, pending payment, payout transfer detail).
// Distinct from the distributor compensation engine (commission_settings /
// /api/payouts/*, keyed by member_code) built in Phase 3. ----------

app.get("/api/franchise-payouts", requireAccess("franchise_commission"), (req, res) => {
  const { franchise_code, status } = req.query;
  const clauses = [];
  const params = [];
  if (franchise_code) {
    clauses.push("franchise_payouts.franchise_code = ?");
    params.push(franchise_code);
  }
  if (status) {
    clauses.push("franchise_payouts.status = ?");
    params.push(status);
  }
  const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
  const rows = db
    .prepare(
      `SELECT franchise_payouts.*, franchises.franchise_name
       FROM franchise_payouts JOIN franchises ON franchises.franchise_code = franchise_payouts.franchise_code
       ${where} ORDER BY franchise_payouts.created_at DESC`
    )
    .all(...params);
  res.json(rows);
});

app.post("/api/franchise-payouts", requireAccess("franchise_commission"), (req, res) => {
  const { franchise_code, period_label, amount, note } = req.body;
  if (!franchise_code || !period_label || amount === undefined) {
    return res.status(400).json({ error: "franchise_code, period_label and amount are required" });
  }
  const franchise = db.prepare("SELECT franchise_code FROM franchises WHERE franchise_code = ?").get(franchise_code);
  if (!franchise) return res.status(400).json({ error: `unknown franchise_code "${franchise_code}"` });
  const result = db
    .prepare("INSERT INTO franchise_payouts (franchise_code, period_label, amount, note) VALUES (?, ?, ?, ?)")
    .run(franchise_code, period_label, Number(amount) || 0, note || null);
  res.json(db.prepare("SELECT * FROM franchise_payouts WHERE id = ?").get(result.lastInsertRowid));
});

// Mark a pending payout as Paid (with a transfer reference) — this same
// data, filtered by status, answers both "Pending Payment" (status=Pending)
// and "Payout Detail" (no filter). Re-processing an already-Paid row is
// blocked, same pattern as the fund-requests approve route.
app.patch("/api/franchise-payouts/:id", requireAccess("franchise_commission"), (req, res) => {
  const existing = db.prepare("SELECT * FROM franchise_payouts WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "not found" });
  if (req.body.status === "Paid") {
    if (existing.status === "Paid") {
      return res.status(409).json({ error: `franchise payout #${req.params.id} is already marked Paid` });
    }
    db.prepare(
      "UPDATE franchise_payouts SET status='Paid', transfer_ref=?, paid_at=datetime('now') WHERE id=?"
    ).run(req.body.transfer_ref || null, req.params.id);
  } else {
    const merged = { ...existing, ...req.body };
    db.prepare("UPDATE franchise_payouts SET period_label=?, amount=?, note=? WHERE id=?").run(
      merged.period_label,
      Number(merged.amount) || 0,
      merged.note,
      req.params.id
    );
  }
  res.json(db.prepare("SELECT * FROM franchise_payouts WHERE id = ?").get(req.params.id));
});

// "Payout Transfer Detail" — Paid franchise payouts for one period, mirrors
// the distributor-level GET /api/reports/payout-transfer-weekly.
app.get("/api/reports/franchise-payout-transfer", requireAccess("franchise_commission"), (req, res) => {
  const { period } = req.query;
  if (!period) return res.status(400).json({ error: "period query param is required" });
  const rows = db
    .prepare(
      `SELECT franchise_payouts.*, franchises.franchise_name
       FROM franchise_payouts JOIN franchises ON franchises.franchise_code = franchise_payouts.franchise_code
       WHERE franchise_payouts.period_label = ? AND franchise_payouts.status = 'Paid'
       ORDER BY franchise_payouts.paid_at DESC`
    )
    .all(period);
  res.json(rows);
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

// =====================================================================
// AI AGENT — sales support, customer education, and a system copilot
// =====================================================================
//
// Provider-agnostic — supports OpenAI (ChatGPT API) or Anthropic (Claude
// API), whichever key is set, via a plain fetch() call (Node 22 has global
// fetch — no SDK/npm install needed, consistent with this project's "npm
// install is blocked in this environment" constraint). OpenAI is checked
// first since that's the key AIRX already had on hand.
//
// Needs ONE of these env vars to activate:
//   OPENAI_API_KEY      - from platform.openai.com (checked first)
//   ANTHROPIC_API_KEY   - from console.anthropic.com (used if no OpenAI key)
// Optional model overrides:
//   OPENAI_MODEL         - defaults to "gpt-4o-mini"
//   ANTHROPIC_MODEL       - defaults to "claude-sonnet-4-5-20250929"
//
// Until one of the API keys is set, every route below returns a clean
// "not configured yet" response instead of crashing — the same
// inert-until-configured pattern used for WhatsApp above.
//
// Three surfaces:
//  1. Public customer assistant (/api/public/assistant) — support +
//     product education. Answers ONLY from a staff-curated Knowledge
//     Base plus the customer's own order status (same safe mobile
//     lookup /api/public/track uses). Deliberately has NO access to
//     any internal tool/data beyond that — a customer can't ask it
//     about other people's orders, leads, inventory, etc.
//  2. Staff system copilot (/api/ai/ask) — can call read-only "tools"
//     to answer natural-language questions about live system data
//     (low stock, near-expiry, leads, orders, staff performance).
//     Gated behind requireAccess("ai_assistant").
//  3. Sales follow-up drafter (/api/ai/draft-followup) — drafts (never
//     sends) a WhatsApp-style follow-up message for one lead, for staff
//     to review and send manually. Actual WhatsApp auto-send stays
//     gated on WHATSAPP_TOKEN/WHATSAPP_PHONE_ID above, unrelated to this.

const KB_FILE = path.join(JSON_DATA_DIR, "kb.json");
if (!fs.existsSync(KB_FILE)) fs.writeFileSync(KB_FILE, "[]");
// Each entry: { id, category: "product_education"|"faq"|"policy", title, content }

const AI_PROVIDER = process.env.OPENAI_API_KEY ? "openai" : process.env.ANTHROPIC_API_KEY ? "anthropic" : null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";

// Normalized message shape every caller below uses, regardless of provider:
//   { role: "system"|"user"|"assistant"|"tool", content: string,
//     tool_calls?: [{ id, name, arguments: object }],   // only on assistant messages
//     tool_call_id?: string }                            // only on tool messages
// Normalized tool shape: { name, description, parameters: <JSON schema> }
// Always returns { configured, text, toolCalls: [{ id, name, input }] } —
// callers never need to know which provider actually answered.
async function callAI({ messages, tools, max_tokens = 1024 }) {
  if (!AI_PROVIDER) {
    return {
      configured: false,
      text: "The AI assistant isn't set up yet — ask the AIRX team to add an OpenAI or Anthropic API key.",
      toolCalls: [],
    };
  }

  if (AI_PROVIDER === "openai") {
    const body = {
      model: OPENAI_MODEL,
      max_tokens,
      messages: messages.map((m) => {
        if (m.role === "assistant" && m.tool_calls) {
          return {
            role: "assistant",
            content: m.content || null,
            tool_calls: m.tool_calls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) },
            })),
          };
        }
        if (m.role === "tool") {
          return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
        }
        return { role: m.role, content: m.content };
      }),
      ...(tools
        ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) }
        : {}),
    };
    const resp = await fetchFn("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message || "OpenAI API error");
    const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
    const toolCalls = (msg.tool_calls || []).map((tc) => {
      let input = {};
      try {
        input = JSON.parse(tc.function.arguments || "{}");
      } catch (e) {
        input = {};
      }
      return { id: tc.id, name: tc.function.name, input };
    });
    return { configured: true, text: msg.content || "", toolCalls };
  }

  // Anthropic path — translates the same normalized messages/tools into
  // Anthropic's shape (separate top-level `system`, content-block messages).
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const anthMessages = [];
  messages
    .filter((m) => m.role !== "system")
    .forEach((m) => {
      if (m.role === "assistant" && m.tool_calls) {
        const content = [];
        if (m.content) content.push({ type: "text", text: m.content });
        m.tool_calls.forEach((tc) => content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments || {} }));
        anthMessages.push({ role: "assistant", content });
      } else if (m.role === "tool") {
        anthMessages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }] });
      } else {
        anthMessages.push({ role: m.role, content: m.content });
      }
    });
  const resp = await fetchFn("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens,
      system,
      messages: anthMessages,
      ...(tools ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
    }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message || "Anthropic API error");
  const textBlocks = (data.content || []).filter((b) => b.type === "text");
  const toolUseBlocks = (data.content || []).filter((b) => b.type === "tool_use");
  return {
    configured: true,
    text: textBlocks.map((b) => b.text).join("\n"),
    toolCalls: toolUseBlocks.map((b) => ({ id: b.id, name: b.name, input: b.input })),
  };
}

// ---------------------------------------------------------------------
// Phase 19 — semantic search over the Knowledge Base (2026-08-27)
// ---------------------------------------------------------------------
// Both AI surfaces that ground themselves in the Knowledge Base (the
// public assistant below, and generateSocialReplyDraft() in Phase 16)
// used to paste the ENTIRE kb.json into every prompt. Fine at a handful of
// articles; it gets slower, pricier, and less accurate as the KB grows,
// since the model has to wade through irrelevant articles to find the
// right one. This embeds each article once (OpenAI's embeddings API - a
// separate, much cheaper endpoint from chat, and the only embeddings
// option here since Anthropic doesn't offer one) and at answer-time
// retrieves only the handful of articles actually relevant to the
// question. No new credential - reuses OPENAI_API_KEY if it's set.
//
// Graceful degradation, same spirit as everywhere else in this app: if
// OPENAI_API_KEY isn't set (e.g. running on Anthropic only), or an
// article has no embedding yet, retrieveRelevantKB() falls back to
// returning the FULL knowledge base - the exact old behavior - rather
// than silently returning nothing.
const EMBEDDING_MODEL = "text-embedding-3-small";

async function embedText(text) {
  if (!process.env.OPENAI_API_KEY || !text) return null;
  try {
    const resp = await fetchFn("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text.slice(0, 8000) }),
    });
    const data = await resp.json();
    if (data.error) {
      console.error("embedText error:", data.error.message);
      return null;
    }
    return (data.data && data.data[0] && data.data[0].embedding) || null;
  } catch (err) {
    console.error("embedText failed:", err.message);
    return null;
  }
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return -1;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// Pure-ish ranking function (network call for the query embedding happens
// in the caller so this stays independently testable) - given the query's
// own embedding and the KB (each item optionally carrying .embedding),
// returns the topN most relevant articles. Falls back to the full KB,
// most-recent-first-preserved, whenever semantic ranking isn't possible.
function rankKBBySimilarity(queryEmbedding, kb, topN) {
  const embedded = kb.filter((k) => Array.isArray(k.embedding) && k.embedding.length);
  if (!queryEmbedding || !embedded.length) return kb; // fall back to everything - old behavior
  return embedded
    .map((k) => ({ ...k, _score: cosineSimilarity(queryEmbedding, k.embedding) }))
    .sort((a, b) => b._score - a._score)
    .slice(0, topN)
    .map(({ _score, ...k }) => k);
}

async function retrieveRelevantKB(query, kb, topN = 5) {
  if (!kb.length) return kb;
  if (kb.length <= topN) return kb; // small KB - no point ranking, just use it all like before
  const queryEmbedding = await embedText(query);
  return rankKBBySimilarity(queryEmbedding, kb, topN);
}

// ---- Knowledge Base CRUD (staff-managed content the agent grounds itself in) ----
app.get("/api/kb", requireAccess("ai_assistant"), (req, res) => {
  res.json(readJson(KB_FILE));
});
app.post("/api/kb", requireAccess("ai_assistant"), async (req, res) => {
  const items = readJson(KB_FILE);
  const item = {
    id: "kb" + Date.now(),
    category: req.body.category || "faq",
    title: req.body.title || "",
    content: req.body.content || "",
    embedding: null,
  };
  item.embedding = await embedText(`${item.title}\n${item.content}`);
  items.push(item);
  writeJson(KB_FILE, items);
  res.json(item);
});
app.patch("/api/kb/:id", requireAccess("ai_assistant"), async (req, res) => {
  const items = readJson(KB_FILE);
  const idx = items.findIndex((i) => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  const titleOrContentChanged = req.body.title !== undefined || req.body.content !== undefined;
  items[idx] = { ...items[idx], ...req.body };
  if (titleOrContentChanged) {
    items[idx].embedding = await embedText(`${items[idx].title}\n${items[idx].content}`);
  }
  writeJson(KB_FILE, items);
  res.json(items[idx]);
});
app.delete("/api/kb/:id", requireAccess("ai_assistant"), (req, res) => {
  const items = readJson(KB_FILE);
  const filtered = items.filter((i) => i.id !== req.params.id);
  writeJson(KB_FILE, filtered);
  res.json({ deleted: items.length !== filtered.length });
});

// ---- Public customer assistant (support + product education) ----
// Separate rate-limit bucket from /api/public/track but the same shape
// (15 messages / 10 min per IP), same first-IP-in-chain fix already
// applied to the tracking route.
const assistantAttempts = new Map();
function isAssistantRateLimited(ip) {
  const now = Date.now();
  const attempts = (assistantAttempts.get(ip) || []).filter((t) => now - t < TRACKING_RATE_WINDOW_MS);
  attempts.push(now);
  assistantAttempts.set(ip, attempts);
  return attempts.length > TRACKING_RATE_LIMIT;
}

app.post("/api/public/assistant", async (req, res) => {
  const forwardedFor = req.header("x-forwarded-for");
  const ip = (forwardedFor ? forwardedFor.split(",")[0].trim() : "") || req.socket.remoteAddress || "unknown";
  if (isAssistantRateLimited(ip)) {
    return res.status(429).json({ error: "Too many messages — please try again in a few minutes." });
  }
  const question = String(req.body.question || "").trim().slice(0, 1000);
  if (!question) return res.status(400).json({ error: "question is required" });
  const mobile = String(req.body.mobile || "").replace(/\D/g, "").slice(-10);

  try {
    const kb = readJson(KB_FILE);
    let orderContext = "";
    if (mobile.length === 10) {
      const orders = readJson(ORDERS_FILE)
        .filter((o) => String(o.mobile || "").replace(/\D/g, "").slice(-10) === mobile)
        .slice(0, 5)
        .map((o) => ({ product: o.product, status: o.status, createdAt: o.createdAt, trackingBarcode: o.indiaPostBarcode || null }));
      if (orders.length) orderContext = `\n\nThis customer's recent orders (only mention what's relevant to their question):\n${JSON.stringify(orders)}`;
    }
    // Phase 19: rank the KB by semantic similarity to this question instead of
    // always stuffing every article in — keeps the prompt small and focused as
    // the KB grows, with a built-in fallback to the full KB when embeddings
    // aren't available (no OpenAI key) or the KB is small enough not to bother.
    const relevantKB = await retrieveRelevantKB(question, kb);
    const kbText = relevantKB.length
      ? relevantKB.map((k) => `[${k.category}] ${k.title}\n${k.content}`).join("\n\n")
      : "(no knowledge base articles added yet — tell the customer the team will get back to them)";

    const system = `You are the AIRX PLUS customer support and product education assistant for an Ayurvedic D2C healthcare brand.
Answer ONLY using the knowledge base content below and, if given, the customer's own order data — never invent product
claims, dosages, or health/medical advice beyond what's written here. For any health condition, medication interaction,
pregnancy, or dosage question not directly answered by the knowledge base, tell the customer to consult a qualified
doctor/Ayurvedic practitioner before use — do not guess. Keep answers short and warm, and reply in whichever language/
style the customer wrote in (Hindi, Hinglish, or English). If you don't know, say so plainly and offer to connect them
to the team.

Knowledge base:
${kbText}${orderContext}`;

    const result = await callAI({
      messages: [
        { role: "system", content: system },
        { role: "user", content: question },
      ],
      max_tokens: 600,
    });
    if (!result.configured) return res.json({ answer: result.text, configured: false });
    res.json({ answer: result.text || "Sorry, I couldn't find an answer to that.", configured: true });
  } catch (err) {
    console.error("AI assistant error:", err);
    res.status(500).json({ error: "assistant temporarily unavailable" });
  }
});

// ---- Phase 20: AI eval harness ----
// Both AI surfaces (public assistant, social replies) rewrite their own system
// prompt/model as the app evolves. Without a fixed set of known-good question
// -> expected-keyword cases to check against, a prompt tweak or a provider
// switch (OpenAI <-> Anthropic) can silently make answers worse with no way
// to notice besides a customer complaint. This harness lets the founder/admin
// build up that fixed case set through the admin UI and re-run it on demand.
// Unlike test_phase*.js, this DOES make a real AI call (it's testing prompt
// quality, not pure logic), so it's intentionally NOT part of the CI suite -
// it's an admin-triggered "Run Evals" action, same trust level as any other
// admin-only route behind requireAccess("ai_assistant").
const AI_EVALS_FILE = path.join(JSON_DATA_DIR, "ai_evals.json");
if (!fs.existsSync(AI_EVALS_FILE)) fs.writeFileSync(AI_EVALS_FILE, "[]");
const AI_EVAL_RESULTS_FILE = path.join(JSON_DATA_DIR, "ai_eval_results.json");
if (!fs.existsSync(AI_EVAL_RESULTS_FILE)) fs.writeFileSync(AI_EVAL_RESULTS_FILE, JSON.stringify({ results: [], summary: null }));

// Pure function - no I/O, no AI call. Given an answer string and an eval
// case, decides pass/fail. All configured expectedKeywords must appear
// (case-insensitive substring match); any configured mustNotContain term
// appearing fails the case (e.g. to catch the assistant inventing a dosage
// number or promising something it shouldn't).
function scoreEvalResult(answerText, evalCase) {
  const answer = String(answerText || "").toLowerCase();
  const expected = Array.isArray(evalCase.expectedKeywords) ? evalCase.expectedKeywords : [];
  const forbidden = Array.isArray(evalCase.mustNotContain) ? evalCase.mustNotContain : [];
  const missingKeywords = expected.filter((k) => k && !answer.includes(String(k).toLowerCase()));
  const foundForbidden = forbidden.filter((k) => k && answer.includes(String(k).toLowerCase()));
  return {
    passed: missingKeywords.length === 0 && foundForbidden.length === 0,
    missingKeywords,
    foundForbidden,
  };
}

// Runs one eval case through the exact same retrieval + prompt shape as
// /api/public/assistant, so this genuinely tests what a real customer would
// get - not a simplified stand-in.
async function runSingleEval(evalCase) {
  const kb = readJson(KB_FILE);
  const relevantKB = await retrieveRelevantKB(evalCase.question, kb);
  const kbText = relevantKB.length
    ? relevantKB.map((k) => `[${k.category}] ${k.title}\n${k.content}`).join("\n\n")
    : "(no knowledge base articles added yet — tell the customer the team will get back to them)";
  const system = `You are the AIRX PLUS customer support and product education assistant for an Ayurvedic D2C healthcare brand.
Answer ONLY using the knowledge base content below and, if given, the customer's own order data — never invent product
claims, dosages, or health/medical advice beyond what's written here. For any health condition, medication interaction,
pregnancy, or dosage question not directly answered by the knowledge base, tell the customer to consult a qualified
doctor/Ayurvedic practitioner before use — do not guess. Keep answers short and warm, and reply in whichever language/
style the customer wrote in (Hindi, Hinglish, or English). If you don't know, say so plainly and offer to connect them
to the team.

Knowledge base:
${kbText}`;
  const result = await callAI({
    messages: [
      { role: "system", content: system },
      { role: "user", content: evalCase.question },
    ],
    max_tokens: 600,
  });
  if (!result.configured) return { id: evalCase.id, question: evalCase.question, answer: null, configured: false, passed: null, missingKeywords: [], foundForbidden: [] };
  const answer = result.text || "";
  const score = scoreEvalResult(answer, evalCase);
  return { id: evalCase.id, question: evalCase.question, answer, configured: true, ...score };
}

app.get("/api/ai/evals", requireAccess("ai_assistant"), (req, res) => {
  res.json(readJson(AI_EVALS_FILE));
});
app.post("/api/ai/evals", requireAccess("ai_assistant"), (req, res) => {
  const items = readJson(AI_EVALS_FILE);
  const item = {
    id: "eval" + Date.now(),
    question: req.body.question || "",
    expectedKeywords: Array.isArray(req.body.expectedKeywords) ? req.body.expectedKeywords : String(req.body.expectedKeywords || "").split(",").map((s) => s.trim()).filter(Boolean),
    mustNotContain: Array.isArray(req.body.mustNotContain) ? req.body.mustNotContain : String(req.body.mustNotContain || "").split(",").map((s) => s.trim()).filter(Boolean),
    notes: req.body.notes || "",
    createdAt: new Date().toISOString(),
  };
  items.push(item);
  writeJson(AI_EVALS_FILE, items);
  res.json(item);
});
app.patch("/api/ai/evals/:id", requireAccess("ai_assistant"), (req, res) => {
  const items = readJson(AI_EVALS_FILE);
  const idx = items.findIndex((i) => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  items[idx] = { ...items[idx], ...req.body };
  writeJson(AI_EVALS_FILE, items);
  res.json(items[idx]);
});
app.delete("/api/ai/evals/:id", requireAccess("ai_assistant"), (req, res) => {
  const items = readJson(AI_EVALS_FILE).filter((i) => i.id !== req.params.id);
  writeJson(AI_EVALS_FILE, items);
  res.json({ ok: true });
});
app.post("/api/ai/evals/run", requireAccess("ai_assistant"), async (req, res) => {
  try {
    const cases = readJson(AI_EVALS_FILE);
    if (!cases.length) return res.json({ results: [], summary: { total: 0, passed: 0, failed: 0 } });
    const results = [];
    for (const c of cases) {
      results.push(await runSingleEval(c));
    }
    const configuredResults = results.filter((r) => r.configured);
    const summary = {
      total: results.length,
      passed: configuredResults.filter((r) => r.passed).length,
      failed: configuredResults.filter((r) => !r.passed).length,
      notConfigured: results.length - configuredResults.length,
      ranAt: new Date().toISOString(),
    };
    writeJson(AI_EVAL_RESULTS_FILE, { results, summary });
    res.json({ results, summary });
  } catch (err) {
    console.error("AI eval run failed:", err);
    res.status(500).json({ error: "eval run failed" });
  }
});
app.get("/api/ai/evals/results", requireAccess("ai_assistant"), (req, res) => {
  res.json(readJsonSafe(AI_EVAL_RESULTS_FILE, { results: [], summary: null }));
});

// ---- Staff system copilot (tool-calling over read-only summaries) ----
function aiTool_getLowStock() {
  const items = readJson(INVENTORY_FILE);
  return items.filter((i) => Number(i.stock) <= Number(i.lowStockThreshold));
}
function aiTool_getNearExpiry() {
  const items = readJson(INVENTORY_FILE);
  const now = Date.now();
  return items
    .map((i) => ({
      ...i,
      daysLeft: i.expiryDate ? Math.ceil((new Date(i.expiryDate + "T00:00:00").getTime() - now) / 86400000) : null,
    }))
    .filter((i) => i.daysLeft !== null && i.daysLeft <= 60);
}
function aiTool_getLeadsSummary() {
  const leads = readJson(LEADS_FILE);
  const byStatus = {};
  leads.forEach((l) => {
    byStatus[l.status || "new"] = (byStatus[l.status || "new"] || 0) + 1;
  });
  return {
    total: leads.length,
    byStatus,
    recent: leads.slice(0, 10).map((l) => ({ name: l.name, phone: l.phone, status: l.status, createdAt: l.createdAt })),
  };
}
function aiTool_getOrdersSummary() {
  const orders = readJson(ORDERS_FILE);
  const byStatus = {};
  orders.forEach((o) => {
    byStatus[o.status || "pending"] = (byStatus[o.status || "pending"] || 0) + 1;
  });
  const totalSales = orders.reduce((s, o) => s + Number(o.codAmount || o.cod || 0), 0);
  return { total: orders.length, byStatus, totalSales };
}
function aiTool_getStaffSummary() {
  const orders = readJson(ORDERS_FILE);
  const byStaff = {};
  orders.forEach((o) => {
    const name = o.staff && o.staff.trim() ? o.staff.trim() : "Unassigned";
    if (!byStaff[name]) byStaff[name] = { staff: name, orders: 0, totalSales: 0, delivered: 0, pending: 0, booked: 0 };
    const bucket = byStaff[name];
    bucket.orders += 1;
    bucket.totalSales += Number(o.codAmount || o.cod || 0);
    if (o.status === "delivered") bucket.delivered += 1;
    else if (o.status === "booked") bucket.booked += 1;
    else bucket.pending += 1;
  });
  return Object.values(byStaff).sort((a, b) => b.totalSales - a.totalSales);
}

const AI_TOOLS = [
  { name: "get_low_stock", description: "Get D2C inventory items at or below their low-stock threshold.", parameters: { type: "object", properties: {} } },
  { name: "get_near_expiry", description: "Get inventory batches expiring within 60 days or already expired.", parameters: { type: "object", properties: {} } },
  { name: "get_leads_summary", description: "Get a summary of Meta lead ads leads by status, plus the 10 most recent.", parameters: { type: "object", properties: {} } },
  { name: "get_orders_summary", description: "Get order counts by status and total sales value.", parameters: { type: "object", properties: {} } },
  { name: "get_staff_summary", description: "Get per-staff order counts, sales, delivered/pending breakdown.", parameters: { type: "object", properties: {} } },
];
const AI_TOOL_IMPL = {
  get_low_stock: aiTool_getLowStock,
  get_near_expiry: aiTool_getNearExpiry,
  get_leads_summary: aiTool_getLeadsSummary,
  get_orders_summary: aiTool_getOrdersSummary,
  get_staff_summary: aiTool_getStaffSummary,
};

app.post("/api/ai/ask", requireAccess("ai_assistant"), async (req, res) => {
  const question = String(req.body.question || "").trim().slice(0, 1000);
  if (!question) return res.status(400).json({ error: "question is required" });
  try {
    const system = `You are the AIRX Ops internal system copilot for staff. You can call tools to look up live data
about inventory, leads, orders, and staff performance. Always call a tool rather than guessing when the question is
about current data. Answer concisely, in plain language, with numbers where relevant.`;
    let messages = [
      { role: "system", content: system },
      { role: "user", content: question },
    ];
    let finalText = "";
    let configured = true;

    for (let round = 0; round < 5; round++) {
      const result = await callAI({ messages, tools: AI_TOOLS, max_tokens: 800 });
      if (!result.configured) {
        finalText = result.text;
        configured = false;
        break;
      }
      if (!result.toolCalls.length) {
        finalText = result.text;
        break;
      }
      messages.push({
        role: "assistant",
        content: result.text || "",
        tool_calls: result.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.input })),
      });
      result.toolCalls.forEach((tc) => {
        const impl = AI_TOOL_IMPL[tc.name];
        let output;
        try {
          output = impl ? impl() : { error: "unknown tool" };
        } catch (e) {
          output = { error: e.message };
        }
        messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(output) });
      });
      if (round === 4) {
        finalText = result.text || "I looked into it but couldn't finish — try rephrasing your question.";
      }
    }
    res.json({ answer: finalText, configured });
  } catch (err) {
    console.error("AI copilot error:", err);
    res.status(500).json({ error: "assistant temporarily unavailable" });
  }
});

// ---- Sales follow-up drafter (drafts only — staff reviews and sends manually) ----
app.post("/api/ai/draft-followup", requireAccess("leads"), async (req, res) => {
  const { name, phone, status, product } = req.body;
  if (!phone) return res.status(400).json({ error: "phone required" });
  try {
    const system = `You write short, warm WhatsApp follow-up messages in Hindi/Hinglish (matching how an Indian D2C
Ayurvedic brand's staff would actually message a customer) for AIRX PLUS Healthcare. Never invent product claims or
prices you aren't given. Keep it under 40 words. Output ONLY the message text, nothing else.`;
    const userMsg = `Draft a follow-up WhatsApp message for this lead:\nName: ${name || "unknown"}\nStatus: ${status || "new"}\n${
      product ? `Interested in: ${product}\n` : ""
    }Goal: move them toward placing an order, politely, no pressure.`;
    const result = await callAI({
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMsg },
      ],
      max_tokens: 300,
    });
    if (!result.configured) return res.json({ draft: result.text, configured: false });
    res.json({ draft: result.text || "", configured: true });
  } catch (err) {
    console.error("AI draft-followup error:", err);
    res.status(500).json({ error: "assistant temporarily unavailable" });
  }
});

// ---------------------------------------------------------------------
// Phase 15 — full data backup / export (2026-08-25)
// ---------------------------------------------------------------------
// The flat JSON files (leads/orders/inventory/etc.) and the SQLite database
// already live on the Render Persistent Disk (/var/data), which Render
// snapshots once a day and keeps for 7 days - that protects against disk
// loss. This is a *different* kind of backup: a human-downloadable single
// JSON file, available on demand from the admin UI, useful for keeping an
// off-Render copy, handing data to an accountant, or opening in Excel.
// Gated behind requireAccess("user_management") - the most privileged
// module key in the app - since a full export includes customer names,
// phone numbers and order history and shouldn't be available to every
// role. Live secrets (Shopify/India Post OAuth tokens) are deliberately
// left out; only their connection status is included.
function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`Backup export: failed to read ${file}:`, err.message);
    return fallback;
  }
}

function dumpAllSqliteTables() {
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((t) => t.name);
    const out = {};
    for (const table of tables) {
      try {
        out[table] = db.prepare(`SELECT * FROM "${table}"`).all();
      } catch (err) {
        out[table] = { error: err.message };
      }
    }
    return out;
  } catch (err) {
    console.error("Backup export: SQLite dump failed:", err.message);
    return { error: err.message };
  }
}

app.get("/api/backup/export", requireAccess("user_management"), (req, res) => {
  try {
    const shop = readJsonSafe(SHOP_FILE, {});
    const indiapost = readJsonSafe(INDIAPOST_FILE, {});
    const backup = {
      exportedAt: new Date().toISOString(),
      source: "AIRX Ops backend",
      leads: readJsonSafe(LEADS_FILE, []),
      orders: readJsonSafe(ORDERS_FILE, []),
      inventory: readJsonSafe(INVENTORY_FILE, []),
      knowledgeBase: readJsonSafe(KB_FILE, []),
      replenishmentDismissed: readJsonSafe(REPLENISH_DISMISSED_FILE, []),
      shopifyConnection: { shop: shop.shop || null, connected: !!shop.accessToken, connectedAt: shop.connectedAt || null },
      indiaPostConnection: { connected: !!indiapost.accessToken, expiresAt: indiapost.expiresAt || null, barcodeSeq: indiapost.barcodeSeq || null },
      mlm: dumpAllSqliteTables(),
    };
    const filename = `airx-backup-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/json");
    res.send(JSON.stringify(backup, null, 2));
  } catch (err) {
    console.error("Backup export error:", err);
    res.status(500).json({ error: "backup export failed" });
  }
});

// ---------------------------------------------------------------------
// Phase 16 — Social Media Hub: post scheduler, AI-answered engagement,
// Meta Ads manager (2026-08-25)
// ---------------------------------------------------------------------
// "One-stop A-to-Z social media solution" per the founder's request: daily
// post scheduling, an AI agent that answers comments/DMs, and Meta Ads
// campaign management, all from this admin. Same inert-until-configured
// pattern as WhatsApp/Shopify/India Post/OpenAI — every piece here works
// today for drafting/planning, and starts actually talking to Meta's live
// APIs the moment the right env vars + token scopes exist, with no code
// changes needed then either.
//
// IMPORTANT - what this needs that it doesn't have yet (see README "Pending
// items"): the current META_PAGE_ACCESS_TOKEN was issued for Lead Ads only
// (leads_retrieval, pages_manage_metadata). Posting, replying to comments/
// DMs, and running ads each need their own scopes - pages_manage_posts,
// pages_read_engagement, pages_manage_engagement, pages_messaging,
// instagram_basic, instagram_content_publish, instagram_manage_comments,
// ads_management, ads_read, business_management - which means the founder
// re-authorizing the Meta app through its OAuth consent screen (same
// reasoning as the Shopify read_checkouts situation - an OAuth grant is
// never something this server does on its own). Until then every route
// below responds honestly with `{configured:false}` instead of pretending
// to have worked.
const SOCIAL_POSTS_FILE = path.join(JSON_DATA_DIR, "social_posts.json");
const SOCIAL_ENGAGEMENT_FILE = path.join(JSON_DATA_DIR, "social_engagement.json");
const AD_CAMPAIGNS_FILE = path.join(JSON_DATA_DIR, "ad_campaigns.json");
if (!fs.existsSync(SOCIAL_POSTS_FILE)) fs.writeFileSync(SOCIAL_POSTS_FILE, "[]");
if (!fs.existsSync(SOCIAL_ENGAGEMENT_FILE)) fs.writeFileSync(SOCIAL_ENGAGEMENT_FILE, "[]");
if (!fs.existsSync(AD_CAMPAIGNS_FILE)) fs.writeFileSync(AD_CAMPAIGNS_FILE, "[]");

// Generic Graph API caller shared by posting, comment replies, DMs and ads
// (ads calls just pass an act_<id>/... path). Never throws on a missing
// token - returns {configured:false} the same way sendWhatsApp() does, so
// every caller below can handle "not set up yet" without its own try/catch.
async function callMetaGraphAPI(pathSuffix, { method = "GET", body, accessTokenOverride } = {}) {
  const token = accessTokenOverride || process.env.META_PAGE_ACCESS_TOKEN;
  if (!token) return { configured: false };
  try {
    const sep = pathSuffix.includes("?") ? "&" : "?";
    const url = `https://graph.facebook.com/v21.0/${pathSuffix}${sep}access_token=${token}`;
    const resp = await fetchFn(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await resp.json();
    return { configured: true, ok: resp.ok && !data.error, data };
  } catch (err) {
    return { configured: true, ok: false, data: { error: { message: err.message } } };
  }
}

// ---- Post composer & scheduler ----

async function publishSocialPost(post) {
  if (post.platform === "facebook") {
    const pageId = process.env.META_PAGE_ID;
    if (!pageId) return { configured: false };
    const endpoint = post.mediaUrl ? `${pageId}/photos` : `${pageId}/feed`;
    const body = post.mediaUrl ? { caption: post.caption, url: post.mediaUrl } : { message: post.caption };
    const result = await callMetaGraphAPI(endpoint, { method: "POST", body });
    if (!result.configured) return { configured: false };
    if (!result.ok) return { ok: false, error: (result.data.error && result.data.error.message) || "unknown error" };
    return { ok: true, externalPostId: result.data.post_id || result.data.id };
  }
  if (post.platform === "instagram") {
    const igId = process.env.META_IG_BUSINESS_ID;
    if (!igId || !post.mediaUrl) return { configured: false }; // Instagram posts require an image/video - no text-only posts.
    const container = await callMetaGraphAPI(`${igId}/media`, { method: "POST", body: { caption: post.caption, image_url: post.mediaUrl } });
    if (!container.configured) return { configured: false };
    if (!container.ok) return { ok: false, error: (container.data.error && container.data.error.message) || "unknown error creating media container" };
    const publish = await callMetaGraphAPI(`${igId}/media_publish`, { method: "POST", body: { creation_id: container.data.id } });
    if (!publish.ok) return { ok: false, error: (publish.data.error && publish.data.error.message) || "unknown error publishing" };
    return { ok: true, externalPostId: publish.data.id };
  }
  return { ok: false, error: `unknown platform "${post.platform}"` };
}

app.get("/api/social/posts", requireAccess("social_media"), (req, res) => {
  res.json(readJson(SOCIAL_POSTS_FILE).sort((a, b) => (b.scheduledAt || b.createdAt || "").localeCompare(a.scheduledAt || a.createdAt || "")));
});

app.post("/api/social/posts", requireAccess("social_media"), (req, res) => {
  const { platform, caption, mediaUrl, scheduledAt } = req.body;
  if (!platform || !caption) return res.status(400).json({ error: "platform and caption required" });
  const posts = readJson(SOCIAL_POSTS_FILE);
  const post = {
    id: "post_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
    platform,
    caption,
    mediaUrl: mediaUrl || "",
    scheduledAt: scheduledAt || null,
    status: scheduledAt ? "scheduled" : "draft",
    publishedAt: null,
    externalPostId: null,
    error: null,
    createdAt: new Date().toISOString(),
  };
  posts.unshift(post);
  writeJson(SOCIAL_POSTS_FILE, posts);
  res.json(post);
});

app.patch("/api/social/posts/:id", requireAccess("social_media"), (req, res) => {
  const posts = readJson(SOCIAL_POSTS_FILE);
  const idx = posts.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  if (posts[idx].status === "published") return res.status(400).json({ error: "already published - can't edit" });
  const { caption, mediaUrl, scheduledAt } = req.body;
  if (caption !== undefined) posts[idx].caption = caption;
  if (mediaUrl !== undefined) posts[idx].mediaUrl = mediaUrl;
  if (scheduledAt !== undefined) {
    posts[idx].scheduledAt = scheduledAt;
    posts[idx].status = scheduledAt ? "scheduled" : "draft";
  }
  writeJson(SOCIAL_POSTS_FILE, posts);
  res.json(posts[idx]);
});

app.delete("/api/social/posts/:id", requireAccess("social_media"), (req, res) => {
  const posts = readJson(SOCIAL_POSTS_FILE);
  const filtered = posts.filter((p) => p.id !== req.params.id);
  writeJson(SOCIAL_POSTS_FILE, filtered);
  res.json({ deleted: filtered.length !== posts.length });
});

app.post("/api/social/posts/:id/publish", requireAccess("social_media"), async (req, res) => {
  const posts = readJson(SOCIAL_POSTS_FILE);
  const idx = posts.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  try {
    const result = await publishSocialPost(posts[idx]);
    if (result.configured === false) {
      return res.json({ configured: false, message: "Meta posting isn't connected yet - see README Phase 16 for the scopes needed." });
    }
    if (result.ok) {
      posts[idx].status = "published";
      posts[idx].publishedAt = new Date().toISOString();
      posts[idx].externalPostId = result.externalPostId;
      posts[idx].error = null;
    } else {
      posts[idx].status = "failed";
      posts[idx].error = result.error;
    }
    writeJson(SOCIAL_POSTS_FILE, posts);
    res.json(posts[idx]);
  } catch (err) {
    console.error("Social post publish error:", err);
    res.status(500).json({ error: err.message });
  }
});

// AI-drafts a caption suggestion - never saved/posted on its own, staff
// reviews and edits it into an actual post via POST /api/social/posts.
app.post("/api/social/posts/suggest-caption", requireAccess("social_media"), async (req, res) => {
  try {
    const { platform, topic, productName } = req.body;
    const inventory = readJson(INVENTORY_FILE);
    const product = productName ? inventory.find((i) => i.name && i.name.toLowerCase().includes(String(productName).toLowerCase())) : null;
    const system = `You write short, warm ${platform === "instagram" ? "Instagram" : "Facebook"} captions in Hindi/Hinglish for
AIRX PLUS Healthcare, an Ayurvedic D2C brand. Never invent product claims, dosages, or health/medical benefits you aren't
given. Include 3-5 relevant hashtags at the end. Keep it under 60 words. Output ONLY the caption text, nothing else.`;
    const userMsg = `Write a social caption.${topic ? `\nTopic/occasion: ${topic}` : ""}${
      product ? `\nFeatured product: ${product.name}${product.description ? " - " + product.description : ""}` : ""
    }`;
    const result = await callAI({ messages: [{ role: "system", content: system }, { role: "user", content: userMsg }], max_tokens: 300 });
    res.json({ configured: result.configured, caption: result.text || "" });
  } catch (err) {
    console.error("Suggest-caption error:", err);
    res.status(500).json({ error: "assistant temporarily unavailable" });
  }
});

// Scheduler - checks once a minute for scheduled posts whose time has come
// and attempts to publish them, exactly like a staff member clicking
// "Publish now" would. Silently does nothing per-post if Meta posting isn't
// configured yet (stays "scheduled" until it is - nothing is lost).
setInterval(async () => {
  try {
    const posts = readJson(SOCIAL_POSTS_FILE);
    const now = Date.now();
    const due = posts.filter((p) => p.status === "scheduled" && p.scheduledAt && new Date(p.scheduledAt).getTime() <= now);
    for (const post of due) {
      try {
        const result = await publishSocialPost(post);
        if (result.configured === false) continue; // leave it scheduled - nothing to retry differently yet
        const idx = posts.findIndex((p) => p.id === post.id);
        if (result.ok) {
          posts[idx].status = "published";
          posts[idx].publishedAt = new Date().toISOString();
          posts[idx].externalPostId = result.externalPostId;
        } else {
          posts[idx].status = "failed";
          posts[idx].error = result.error;
        }
      } catch (err) {
        console.error("Scheduled social post publish failed:", post.id, err.message);
      }
    }
    if (due.length) writeJson(SOCIAL_POSTS_FILE, posts);
  } catch (err) {
    console.error("Social post scheduler tick failed:", err.message);
  }
}, 60 * 1000);

// ---- Engagement inbox: AI drafts replies to comments/DMs ----

async function generateSocialReplyDraft(item) {
  try {
    const kb = readJson(KB_FILE);
    // Phase 19: same semantic-retrieval narrowing as the public assistant,
    // keyed off the customer's actual comment/DM text.
    const relevantKB = await retrieveRelevantKB(item.message || "", kb);
    const kbText = relevantKB.length
      ? relevantKB.map((k) => `[${k.category}] ${k.title}\n${k.content}`).join("\n\n")
      : "(no knowledge base articles added yet)";
    const system = `You reply to public ${item.type === "dm" ? "Instagram/Facebook DMs" : "Facebook/Instagram comments"} for AIRX PLUS
Healthcare, an Ayurvedic D2C brand. Use ONLY the knowledge base below - never invent product claims, dosages, or medical
advice. For any health/medication/pregnancy/dosage question, tell them to consult a doctor/Ayurvedic practitioner - don't
guess. Keep it short, warm, and public-appropriate (this may be visible to everyone). Reply in the same language/script
the customer used. Output ONLY the reply text.\n\nKnowledge base:\n${kbText}`;
    const result = await callAI({
      messages: [
        { role: "system", content: system },
        { role: "user", content: `${item.fromName ? item.fromName + " wrote: " : ""}"${item.message}"` },
      ],
      max_tokens: 300,
    });
    return result.configured ? result.text || "" : "";
  } catch (err) {
    console.error("generateSocialReplyDraft failed:", err.message);
    return "";
  }
}

async function sendSocialReply(item, message) {
  if (item.type === "dm") {
    // Messenger Send API - item.postId holds the sender PSID for DMs (see
    // handleIncomingSocialComment below).
    const result = await callMetaGraphAPI(`me/messages`, {
      method: "POST",
      body: { recipient: { id: item.postId }, message: { text: message }, messaging_type: "RESPONSE" },
    });
    return result;
  }
  // Facebook and Instagram both expose the same shape for replying to a
  // comment: POST /{comment_id}/comments with a message body.
  return callMetaGraphAPI(`${item.externalId}/comments`, { method: "POST", body: { message } });
}

// Phase 22: sentiment-aware engagement triage. Every inbound comment/DM used
// to land in the inbox with equal weight - a "love this, ordered again!"
// and a "this gave my mother an allergic reaction, I want a refund" sat side
// by side in arrival order. A public brand account needs the second one
// found and handled fast, not scrolled past. This is a deliberately
// rule-based (keyword) classifier, not an extra AI API call per comment -
// same reasoning as the rest of this app's "cheap, deterministic, always-on"
// pieces: it needs no OpenAI/Anthropic key to work at all, costs nothing,
// runs instantly, and never depends on a third-party AI being configured or
// available. It's intentionally biased toward over-flagging (a false
// positive just means a normal comment gets a priority tag it didn't need;
// a false negative means a real complaint gets missed) - pure function, unit
// tested in test_phase22.js.
const URGENT_KEYWORDS = [
  "refund", "fraud", "scam", "cheated", "lawyer", "legal action", "consumer court",
  "side effect", "allergic", "allergy", "reaction", "hospital", "hospitalized",
  "fake product", "duplicate product", "expired product", "damaged", "poison",
  "sick", "worse", "harmful", "unsafe", "police", "complaint filed",
];
const NEGATIVE_KEYWORDS = [
  "worst", "terrible", "horrible", "disappointed", "disappointing", "waste of money",
  "not working", "doesn't work", "didn't work", "no result", "no effect", "useless",
  "cancel my order", "cancel order", "never again", "regret", "bad experience",
  "poor quality", "late delivery", "not delivered", "missing item", "wrong product",
  "bekaar", "faltu", "ghatiya", "dhoka", "paisa barbad",
];
const POSITIVE_KEYWORDS = [
  "thank you", "thanks", "great product", "love this", "loved it", "amazing",
  "excellent", "works great", "worked well", "highly recommend", "best product",
  "very happy", "satisfied", "good quality", "ordering again", "repeat order",
  "shukriya", "badhiya", "zabardast",
];

// Pure function - no I/O, no AI call.
function classifyEngagementSentiment(message) {
  const text = String(message || "").toLowerCase();
  const urgentHits = URGENT_KEYWORDS.filter((k) => text.includes(k));
  const negativeHits = NEGATIVE_KEYWORDS.filter((k) => text.includes(k));
  const positiveHits = POSITIVE_KEYWORDS.filter((k) => text.includes(k));

  let sentiment = "neutral";
  if (urgentHits.length || negativeHits.length) sentiment = "negative";
  else if (positiveHits.length) sentiment = "positive";

  // Urgent always wins the priority call regardless of what else is in the
  // message - "thanks for the great product but I had an allergic reaction"
  // still needs to be triaged as urgent, not averaged into "mixed/neutral".
  let priority = "normal";
  if (urgentHits.length) priority = "high";
  else if (negativeHits.length) priority = "medium";

  return { sentiment, priority, flaggedKeywords: [...urgentHits, ...negativeHits] };
}

async function handleIncomingSocialComment({ platform, type = "comment", externalId, postId, fromName, message }) {
  if (!message) return;
  const engagement = readJson(SOCIAL_ENGAGEMENT_FILE);
  if (engagement.some((e) => e.externalId === externalId)) return; // Meta can redeliver webhooks - de-dupe.
  const { sentiment, priority, flaggedKeywords } = classifyEngagementSentiment(message);
  const item = {
    id: "eng_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
    platform,
    type,
    externalId,
    postId,
    fromName: fromName || "",
    message,
    sentiment,
    priority,
    flaggedKeywords,
    aiDraftReply: "",
    status: "pending", // pending -> approved_sent | auto_sent | dismissed
    receivedAt: new Date().toISOString(),
    respondedAt: null,
  };
  item.aiDraftReply = await generateSocialReplyDraft(item);

  // A high-priority (urgent) item never auto-sends, even if the founder has
  // opted into AI_AUTO_REPLY_SOCIAL for routine comments - a possible
  // allergic-reaction/refund/legal-threat message getting an auto-reply
  // instead of a human's eyes is exactly the reputational risk that setting
  // was never meant to cover. Auto-send stays OFF for everything else unless
  // the founder explicitly opts in via env var (same reasoning as the
  // WhatsApp follow-up drafter) - flip AI_AUTO_REPLY_SOCIAL=true only once
  // you trust the KB coverage and tone.
  if (priority !== "high" && process.env.AI_AUTO_REPLY_SOCIAL === "true" && item.aiDraftReply) {
    const sendResult = await sendSocialReply(item, item.aiDraftReply);
    if (sendResult.configured && sendResult.ok) {
      item.status = "auto_sent";
      item.respondedAt = new Date().toISOString();
    }
  }

  engagement.unshift(item);
  writeJson(SOCIAL_ENGAGEMENT_FILE, engagement);
}

const ENGAGEMENT_PRIORITY_RANK = { high: 0, medium: 1, normal: 2 };
app.get("/api/social/engagement", requireAccess("social_media"), (req, res) => {
  const { status, priority } = req.query;
  let rows = readJson(SOCIAL_ENGAGEMENT_FILE);
  if (status) rows = rows.filter((r) => r.status === status);
  if (priority) rows = rows.filter((r) => r.priority === priority);
  // Urgent items surface first regardless of arrival order, then negative,
  // then everything else newest-first within each bucket.
  rows = rows.slice().sort((a, b) => {
    const rankDiff = (ENGAGEMENT_PRIORITY_RANK[a.priority] ?? 2) - (ENGAGEMENT_PRIORITY_RANK[b.priority] ?? 2);
    if (rankDiff !== 0) return rankDiff;
    return new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime();
  });
  res.json(rows);
});

app.post("/api/social/engagement/:id/draft", requireAccess("social_media"), async (req, res) => {
  const rows = readJson(SOCIAL_ENGAGEMENT_FILE);
  const idx = rows.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  rows[idx].aiDraftReply = await generateSocialReplyDraft(rows[idx]);
  writeJson(SOCIAL_ENGAGEMENT_FILE, rows);
  res.json(rows[idx]);
});

app.post("/api/social/engagement/:id/send", requireAccess("social_media"), async (req, res) => {
  const rows = readJson(SOCIAL_ENGAGEMENT_FILE);
  const idx = rows.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  const message = String(req.body.message || rows[idx].aiDraftReply || "").trim();
  if (!message) return res.status(400).json({ error: "message required" });
  try {
    const result = await sendSocialReply(rows[idx], message);
    if (result.configured === false) {
      return res.json({ configured: false, message: "Meta reply-sending isn't connected yet - see README Phase 16 for the scopes needed." });
    }
    if (result.ok) {
      rows[idx].status = "approved_sent";
      rows[idx].respondedAt = new Date().toISOString();
      rows[idx].aiDraftReply = message;
      writeJson(SOCIAL_ENGAGEMENT_FILE, rows);
      res.json(rows[idx]);
    } else {
      res.status(502).json({ error: (result.data.error && result.data.error.message) || "send failed" });
    }
  } catch (err) {
    console.error("Social reply send error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/social/engagement/:id/dismiss", requireAccess("social_media"), (req, res) => {
  const rows = readJson(SOCIAL_ENGAGEMENT_FILE);
  const idx = rows.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  rows[idx].status = "dismissed";
  writeJson(SOCIAL_ENGAGEMENT_FILE, rows);
  res.json(rows[idx]);
});

// ---- Meta Ads manager ----
// Deliberately two-step: "Launch" only ever CREATES the campaign/adset/ad
// in Meta with status PAUSED (zero spend), so the founder can review it in
// Meta's own Ads Manager before anything goes live. A separate "Activate"
// step (which actually starts spending) requires an explicit
// {confirm:true} body, on top of the button click itself, as a deliberate
// extra guard against spending real money by accident. This module hasn't
// been exercised against a real Meta Ads account (no ad account has been
// connected yet) - test with a small daily budget first once it is.

app.get("/api/ads/campaigns", requireAccess("social_media"), (req, res) => {
  res.json(readJson(AD_CAMPAIGNS_FILE).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")));
});

app.post("/api/ads/campaigns", requireAccess("social_media"), (req, res) => {
  const { name, objective, dailyBudget, caption, mediaUrl, ageMin, ageMax, genders, locations, variantGroupId, variantLabel } = req.body;
  if (!name || !objective || !dailyBudget) return res.status(400).json({ error: "name, objective and dailyBudget required" });
  const campaigns = readJson(AD_CAMPAIGNS_FILE);
  const campaign = {
    id: "camp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
    name,
    objective, // e.g. "OUTCOME_TRAFFIC" | "OUTCOME_ENGAGEMENT" | "OUTCOME_SALES"
    dailyBudget: Number(dailyBudget),
    creative: { caption: caption || "", mediaUrl: mediaUrl || "" },
    targeting: {
      ageMin: Number(ageMin) || 18,
      ageMax: Number(ageMax) || 65,
      genders: genders || "all",
      locations: locations || "India",
    },
    // Phase 25: two or more campaigns sharing the same variantGroupId (e.g.
    // different captions/images testing the same offer) can be compared
    // side by side via /api/ads/campaigns/compare - see rankAdVariants below.
    variantGroupId: variantGroupId || null,
    variantLabel: variantLabel || null,
    status: "draft", // draft -> created_paused -> active -> paused (or failed)
    metaCampaignId: null,
    metaAdSetId: null,
    metaAdId: null,
    error: null,
    createdAt: new Date().toISOString(),
    launchedAt: null,
    activatedAt: null,
  };
  campaigns.unshift(campaign);
  writeJson(AD_CAMPAIGNS_FILE, campaigns);
  res.json(campaign);
});

app.patch("/api/ads/campaigns/:id", requireAccess("social_media"), (req, res) => {
  const campaigns = readJson(AD_CAMPAIGNS_FILE);
  const idx = campaigns.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  if (campaigns[idx].status !== "draft") return res.status(400).json({ error: "only draft campaigns can be edited - pause it in Meta Ads Manager directly for live changes" });
  const { name, objective, dailyBudget, caption, mediaUrl, ageMin, ageMax, genders, locations } = req.body;
  if (name !== undefined) campaigns[idx].name = name;
  if (objective !== undefined) campaigns[idx].objective = objective;
  if (dailyBudget !== undefined) campaigns[idx].dailyBudget = Number(dailyBudget);
  if (caption !== undefined) campaigns[idx].creative.caption = caption;
  if (mediaUrl !== undefined) campaigns[idx].creative.mediaUrl = mediaUrl;
  if (ageMin !== undefined) campaigns[idx].targeting.ageMin = Number(ageMin);
  if (ageMax !== undefined) campaigns[idx].targeting.ageMax = Number(ageMax);
  if (genders !== undefined) campaigns[idx].targeting.genders = genders;
  if (locations !== undefined) campaigns[idx].targeting.locations = locations;
  if (req.body.variantGroupId !== undefined) campaigns[idx].variantGroupId = req.body.variantGroupId || null;
  if (req.body.variantLabel !== undefined) campaigns[idx].variantLabel = req.body.variantLabel || null;
  writeJson(AD_CAMPAIGNS_FILE, campaigns);
  res.json(campaigns[idx]);
});

app.delete("/api/ads/campaigns/:id", requireAccess("social_media"), (req, res) => {
  const campaigns = readJson(AD_CAMPAIGNS_FILE);
  const target = campaigns.find((c) => c.id === req.params.id);
  if (target && target.status !== "draft") return res.status(400).json({ error: "can't delete a campaign already created in Meta - pause/delete it in Meta Ads Manager" });
  const filtered = campaigns.filter((c) => c.id !== req.params.id);
  writeJson(AD_CAMPAIGNS_FILE, filtered);
  res.json({ deleted: filtered.length !== campaigns.length });
});

function metaGenders(genders) {
  if (genders === "male") return [1];
  if (genders === "female") return [2];
  return undefined; // omitted = all genders
}

app.post("/api/ads/campaigns/:id/launch", requireAccess("social_media"), async (req, res) => {
  const campaigns = readJson(AD_CAMPAIGNS_FILE);
  const idx = campaigns.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  const campaign = campaigns[idx];
  if (campaign.status !== "draft") return res.status(400).json({ error: `campaign is already "${campaign.status}"` });
  const adAccount = process.env.META_ADS_ACCOUNT_ID;
  if (!adAccount) return res.json({ configured: false, message: "Meta Ads isn't connected yet - see README Phase 16 for the scopes/account ID needed." });

  try {
    const campResult = await callMetaGraphAPI(`act_${adAccount}/campaigns`, {
      method: "POST",
      body: { name: campaign.name, objective: campaign.objective, status: "PAUSED", special_ad_categories: [] },
    });
    if (!campResult.ok) throw new Error((campResult.data.error && campResult.data.error.message) || "campaign creation failed");
    const metaCampaignId = campResult.data.id;

    const adsetResult = await callMetaGraphAPI(`act_${adAccount}/adsets`, {
      method: "POST",
      body: {
        name: campaign.name + " - Ad Set",
        campaign_id: metaCampaignId,
        daily_budget: Math.round(campaign.dailyBudget * 100), // smallest currency unit
        billing_event: "IMPRESSIONS",
        optimization_goal: "REACH",
        bid_strategy: "LOWEST_COST_WITHOUT_CAP",
        targeting: {
          geo_locations: { countries: ["IN"] },
          age_min: campaign.targeting.ageMin,
          age_max: campaign.targeting.ageMax,
          genders: metaGenders(campaign.targeting.genders),
        },
        status: "PAUSED",
      },
    });
    if (!adsetResult.ok) throw new Error((adsetResult.data.error && adsetResult.data.error.message) || "ad set creation failed");
    const metaAdSetId = adsetResult.data.id;

    const pageId = process.env.META_PAGE_ID;
    const creativeResult = await callMetaGraphAPI(`act_${adAccount}/adcreatives`, {
      method: "POST",
      body: {
        name: campaign.name + " - Creative",
        object_story_spec: {
          page_id: pageId,
          link_data: { message: campaign.creative.caption, link: process.env.PUBLIC_URL || "https://airxplus.com", picture: campaign.creative.mediaUrl || undefined },
        },
      },
    });
    if (!creativeResult.ok) throw new Error((creativeResult.data.error && creativeResult.data.error.message) || "ad creative creation failed");

    const adResult = await callMetaGraphAPI(`act_${adAccount}/ads`, {
      method: "POST",
      body: { name: campaign.name + " - Ad", adset_id: metaAdSetId, creative: { creative_id: creativeResult.data.id }, status: "PAUSED" },
    });
    if (!adResult.ok) throw new Error((adResult.data.error && adResult.data.error.message) || "ad creation failed");

    campaign.metaCampaignId = metaCampaignId;
    campaign.metaAdSetId = metaAdSetId;
    campaign.metaAdId = adResult.data.id;
    campaign.status = "created_paused";
    campaign.launchedAt = new Date().toISOString();
    campaign.error = null;
    writeJson(AD_CAMPAIGNS_FILE, campaigns);
    res.json(campaign);
  } catch (err) {
    campaign.status = "failed";
    campaign.error = err.message;
    writeJson(AD_CAMPAIGNS_FILE, campaigns);
    console.error("Ad campaign launch error:", err);
    res.status(502).json({ error: err.message, campaign });
  }
});

app.post("/api/ads/campaigns/:id/activate", requireAccess("social_media"), async (req, res) => {
  if (req.body.confirm !== true) return res.status(400).json({ error: "resend with {confirm:true} - this starts real ad spend" });
  const campaigns = readJson(AD_CAMPAIGNS_FILE);
  const idx = campaigns.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  const campaign = campaigns[idx];
  if (campaign.status !== "created_paused" && campaign.status !== "paused") return res.status(400).json({ error: `campaign must be created first (currently "${campaign.status}")` });
  try {
    const result = await callMetaGraphAPI(campaign.metaCampaignId, { method: "POST", body: { status: "ACTIVE" } });
    if (result.configured === false) return res.json({ configured: false });
    if (!result.ok) throw new Error((result.data.error && result.data.error.message) || "activate failed");
    campaign.status = "active";
    campaign.activatedAt = new Date().toISOString();
    writeJson(AD_CAMPAIGNS_FILE, campaigns);
    res.json(campaign);
  } catch (err) {
    console.error("Ad campaign activate error:", err);
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/ads/campaigns/:id/pause", requireAccess("social_media"), async (req, res) => {
  const campaigns = readJson(AD_CAMPAIGNS_FILE);
  const idx = campaigns.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  const campaign = campaigns[idx];
  if (!campaign.metaCampaignId) return res.status(400).json({ error: "campaign was never created in Meta" });
  try {
    const result = await callMetaGraphAPI(campaign.metaCampaignId, { method: "POST", body: { status: "PAUSED" } });
    if (result.configured === false) return res.json({ configured: false });
    if (!result.ok) throw new Error((result.data.error && result.data.error.message) || "pause failed");
    campaign.status = "paused";
    writeJson(AD_CAMPAIGNS_FILE, campaigns);
    res.json(campaign);
  } catch (err) {
    console.error("Ad campaign pause error:", err);
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/ads/campaigns/:id/insights", requireAccess("social_media"), async (req, res) => {
  const campaigns = readJson(AD_CAMPAIGNS_FILE);
  const campaign = campaigns.find((c) => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: "not found" });
  if (!campaign.metaCampaignId) return res.json({ configured: false, message: "not launched yet" });
  const result = await callMetaGraphAPI(`${campaign.metaCampaignId}/insights?fields=spend,impressions,clicks,reach`);
  if (result.configured === false) return res.json({ configured: false });
  res.json(result.ok ? result.data : { error: result.data.error });
});

// Phase 25: ad-creative variant testing. Two or more campaigns sharing a
// variantGroupId (e.g. the same offer with two different captions/images)
// can be compared here by click-through rate, with a minimum-impressions
// gate so a "winner" isn't declared off a handful of early impressions that
// could easily flip. This is local comparison LOGIC only - it works purely
// off whatever insights are passed in, so it's fully testable without a
// live ad account. The actual live spend/launch path this reads insights
// from is unchanged and stays behind the Phase 16 Meta Ads permission flow
// (create paused, explicit confirm:true to activate) - nothing about that
// safety gate changes here.
const AD_VARIANT_MIN_IMPRESSIONS = 500;

// Pure function - no I/O. variants: [{id, name, variantLabel, insights: {impressions, clicks, spend}|null}]
function rankAdVariants(variants) {
  const ranked = variants.map((v) => {
    const impressions = Number((v.insights && v.insights.impressions) || 0);
    const clicks = Number((v.insights && v.insights.clicks) || 0);
    const spend = Number((v.insights && v.insights.spend) || 0);
    const ctr = impressions > 0 ? clicks / impressions : null;
    const cpc = clicks > 0 ? spend / clicks : null;
    return { id: v.id, name: v.name, variantLabel: v.variantLabel, impressions, clicks, spend, ctr, cpc };
  });

  // Rank by CTR descending (nulls/no-data last), tie-break by lower CPC.
  ranked.sort((a, b) => {
    if (a.ctr === null && b.ctr === null) return 0;
    if (a.ctr === null) return 1;
    if (b.ctr === null) return -1;
    if (b.ctr !== a.ctr) return b.ctr - a.ctr;
    if (a.cpc === null) return 1;
    if (b.cpc === null) return -1;
    return a.cpc - b.cpc;
  });

  if (ranked.length < 2) {
    return { ranked, winner: null, reason: "need at least 2 variants in the group to compare" };
  }
  const top = ranked[0];
  if (top.ctr === null || top.impressions < AD_VARIANT_MIN_IMPRESSIONS) {
    return { ranked, winner: null, reason: `not enough data yet — each variant needs at least ${AD_VARIANT_MIN_IMPRESSIONS} impressions before a winner is called` };
  }
  return { ranked, winner: top.id, reason: `${top.variantLabel || top.name} leads by click-through rate with sufficient impressions` };
}

app.get("/api/ads/campaigns/compare", requireAccess("social_media"), async (req, res) => {
  const { groupId } = req.query;
  if (!groupId) return res.status(400).json({ error: "groupId is required" });
  const campaigns = readJson(AD_CAMPAIGNS_FILE).filter((c) => c.variantGroupId === groupId);
  if (!campaigns.length) return res.status(404).json({ error: "no campaigns found for that variant group" });
  try {
    const variants = [];
    for (const c of campaigns) {
      let insights = null;
      if (c.metaCampaignId) {
        const result = await callMetaGraphAPI(`${c.metaCampaignId}/insights?fields=spend,impressions,clicks,reach`);
        if (result.configured && result.ok && result.data.data && result.data.data[0]) insights = result.data.data[0];
      }
      variants.push({ id: c.id, name: c.name, variantLabel: c.variantLabel, insights });
    }
    res.json(rankAdVariants(variants));
  } catch (err) {
    console.error("Ad variant comparison error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------
// Phase 17 — retail-customer-to-distributor referral bridge (2026-08-25)
// ---------------------------------------------------------------------
// Flagged since Phase 14/15/16 as needing the founder's own input on the
// actual referral/commission rule before it could be built correctly - the
// same situation Phase 3 ran into with the MLM compensation plan itself.
// Rather than leave it fully unbuilt while waiting, this follows the exact
// same pattern Phase 3 used there: build the tracking + admin-configurable
// reward settings now, default the reward to "none" (so nothing happens
// until the founder actually sets a rule), and let the real number be
// tuned later with zero code changes.
//
// Deliberately a flat JSON ledger, NOT the MLM SQLite wallet_transactions
// table - a retail D2C customer who refers a friend isn't automatically a
// distributor, and folding them into the distributor wallet schema would
// quietly make that business-model decision on the founder's behalf. This
// stays a separate, simple record until the founder decides whether/how
// referred customers should ever cross into the MLM side.
const REFERRAL_SETTINGS_FILE = path.join(JSON_DATA_DIR, "referral_settings.json");
const REFERRALS_FILE = path.join(JSON_DATA_DIR, "referrals.json");
if (!fs.existsSync(REFERRAL_SETTINGS_FILE)) fs.writeFileSync(REFERRAL_SETTINGS_FILE, JSON.stringify({ rewardType: "none", rewardValue: 0, minOrderAmount: 0, updatedAt: null }));
if (!fs.existsSync(REFERRALS_FILE)) fs.writeFileSync(REFERRALS_FILE, "[]");

function computeReferralEligibility(order, allOrders, settings) {
  if (!settings || settings.rewardType === "none" || !settings.rewardValue) return { eligible: false, reason: "no reward configured yet" };
  if (!order.referredByMobile) return { eligible: false, reason: "no referrer tagged on this order" };
  const referrer = String(order.referredByMobile).replace(/\D/g, "");
  const referred = String(order.mobile || "").replace(/\D/g, "");
  if (!referred) return { eligible: false, reason: "order has no customer mobile" };
  if (!referrer) return { eligible: false, reason: "referrer mobile is invalid" };
  if (referrer === referred) return { eligible: false, reason: "self-referral not allowed" };
  const amount = Number(order.codAmount || order.cod || 0);
  if (settings.minOrderAmount && amount < settings.minOrderAmount) return { eligible: false, reason: "order below the configured minimum amount" };
  const orderDeliveredMs = new Date(order.deliveredAt || order.createdAt).getTime();
  const isFirstDelivered = !allOrders.some((o) => {
    if (o.id === order.id || String(o.mobile || "").replace(/\D/g, "") !== referred || o.status !== "delivered") return false;
    const otherMs = new Date(o.deliveredAt || o.createdAt).getTime();
    return !isNaN(otherMs) && otherMs < orderDeliveredMs;
  });
  if (!isFirstDelivered) return { eligible: false, reason: "not the referred customer's first delivered order" };
  const rewardValue = settings.rewardType === "percent_discount" ? round2(amount * (Number(settings.rewardValue) / 100)) : Number(settings.rewardValue);
  return { eligible: true, rewardType: settings.rewardType, rewardValue };
}

function processReferralOnDelivery(order, allOrders) {
  try {
    const referrals = readJson(REFERRALS_FILE);
    if (referrals.some((r) => r.orderId === order.id)) return; // already processed - don't double-credit on a re-save
    const settings = readJson(REFERRAL_SETTINGS_FILE);
    const result = computeReferralEligibility(order, allOrders, settings);
    if (!result.eligible) return;
    referrals.unshift({
      id: "ref_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
      orderId: order.id,
      referrerMobile: String(order.referredByMobile).replace(/\D/g, ""),
      referredMobile: String(order.mobile).replace(/\D/g, ""),
      referredName: order.name || "",
      rewardType: result.rewardType,
      rewardValue: result.rewardValue,
      status: "eligible", // eligible -> paid | void
      createdAt: new Date().toISOString(),
      paidAt: null,
      note: null,
    });
    writeJson(REFERRALS_FILE, referrals);
  } catch (err) {
    console.error("processReferralOnDelivery failed for order", order.id, ":", err.message);
  }
}

app.get("/api/referrals/settings", requireAccess("orders"), (req, res) => {
  res.json(readJson(REFERRAL_SETTINGS_FILE));
});

app.patch("/api/referrals/settings", requireAccess("orders"), (req, res) => {
  const { rewardType, rewardValue, minOrderAmount } = req.body;
  if (rewardType && !["none", "flat_credit", "percent_discount"].includes(rewardType)) {
    return res.status(400).json({ error: 'rewardType must be "none", "flat_credit", or "percent_discount"' });
  }
  const settings = readJson(REFERRAL_SETTINGS_FILE);
  if (rewardType !== undefined) settings.rewardType = rewardType;
  if (rewardValue !== undefined) settings.rewardValue = Number(rewardValue) || 0;
  if (minOrderAmount !== undefined) settings.minOrderAmount = Number(minOrderAmount) || 0;
  settings.updatedAt = new Date().toISOString();
  writeJson(REFERRAL_SETTINGS_FILE, settings);
  res.json(settings);
});

app.get("/api/referrals", requireAccess("orders"), (req, res) => {
  res.json(readJson(REFERRALS_FILE).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")));
});

app.post("/api/referrals/:id/mark-paid", requireAccess("orders"), (req, res) => {
  const referrals = readJson(REFERRALS_FILE);
  const idx = referrals.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  if (referrals[idx].status !== "eligible") return res.status(400).json({ error: `referral is already "${referrals[idx].status}"` });
  referrals[idx].status = "paid";
  referrals[idx].paidAt = new Date().toISOString();
  referrals[idx].note = req.body.note || referrals[idx].note;
  writeJson(REFERRALS_FILE, referrals);
  res.json(referrals[idx]);
});

app.post("/api/referrals/:id/void", requireAccess("orders"), (req, res) => {
  const referrals = readJson(REFERRALS_FILE);
  const idx = referrals.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  referrals[idx].status = "void";
  referrals[idx].note = req.body.note || referrals[idx].note;
  writeJson(REFERRALS_FILE, referrals);
  res.json(referrals[idx]);
});

app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`AIRX backend listening on port ${PORT}`);
});
