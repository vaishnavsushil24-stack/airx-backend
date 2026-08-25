// Standalone functional test for the Phase 15 backup-export redaction logic
// (the shopifyConnection / indiaPostConnection shaping inside the
// GET /api/backup/export handler in server.js). Express and node:sqlite
// setup aren't exercised here (same reasoning as test_phase3/6/7/8/9/14.js
// - Express isn't installed in this sandbox) - this test isolates the pure
// redaction logic, which is the part most worth protecting against a
// future accidental regression (leaking a live OAuth token into a backup
// file someone might hand to an accountant or keep off-Render).
// Run with: node test_phase15.js

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("PASS:", msg);
  }
};

// Copied verbatim from the shaping logic inside the /api/backup/export
// handler in server.js - keep in sync if that logic ever changes.
function buildShopifyConnection(shop) {
  return { shop: shop.shop || null, connected: !!shop.accessToken, connectedAt: shop.connectedAt || null };
}
function buildIndiaPostConnection(indiapost) {
  return { connected: !!indiapost.accessToken, expiresAt: indiapost.expiresAt || null, barcodeSeq: indiapost.barcodeSeq || null };
}

// ---- 1. Connected Shopify shop: accessToken itself must never appear ----
const shop1 = { shop: "airxplus.myshopify.com", accessToken: "shpat_live_secret_value_12345", connectedAt: "2026-08-01T00:00:00.000Z" };
const conn1 = buildShopifyConnection(shop1);
assert(conn1.connected === true, "connected Shopify shop reports connected:true");
assert(conn1.shop === "airxplus.myshopify.com", "connected Shopify shop's domain is included");
assert(JSON.stringify(conn1).indexOf("shpat_live_secret_value_12345") === -1, "Shopify accessToken never appears anywhere in the redacted output");

// ---- 2. Not-yet-connected Shopify (shopify.json is just {}) ----
const conn2 = buildShopifyConnection({});
assert(conn2.connected === false && conn2.shop === null, "unconnected Shopify shows connected:false, shop:null, no crash");

// ---- 3. Connected India Post: accessToken/refreshToken must never appear ----
const ip1 = { accessToken: "indiapost_secret_access_abc", refreshToken: "indiapost_secret_refresh_xyz", expiresAt: 1234567890, barcodeSeq: 42 };
const connIp1 = buildIndiaPostConnection(ip1);
assert(connIp1.connected === true && connIp1.barcodeSeq === 42, "connected India Post reports connected:true and preserves the (non-secret) barcodeSeq");
assert(JSON.stringify(connIp1).indexOf("indiapost_secret_access_abc") === -1 && JSON.stringify(connIp1).indexOf("indiapost_secret_refresh_xyz") === -1, "India Post access/refresh tokens never appear anywhere in the redacted output");

// ---- 4. Not-yet-connected India Post (indiapost.json's documented default shape) ----
const connIp2 = buildIndiaPostConnection({ accessToken: null, refreshToken: null, expiresAt: 0, barcodeSeq: null });
assert(connIp2.connected === false, "unconnected India Post (null accessToken) reports connected:false");

console.log(process.exitCode ? "\nSome tests FAILED." : "\nAll test_phase15 checks passed.");
