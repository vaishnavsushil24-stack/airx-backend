// One-off migration script: import the full Shopify product catalog into
// the AIRX Ops `products` table.
//
// Why this exists: before this, the storefront (`public/shop.html`,
// `/api/public/products`) had no real catalog behind it. The business's
// actual product list lived on Shopify (27 products), reachable without
// authentication via Shopify's public storefront JSON endpoint
// (`https://<shop>.myshopify.com/products.json`). This script pulls that
// JSON, maps each Shopify product onto this app's `products` schema, and
// downloads each product's primary image locally (into
// `public/uploads/products/`) instead of hot-linking Shopify's CDN, so the
// storefront keeps working after Shopify is eventually switched off.
//
// Usage (run on the server, from the app root):
//   1. Fetch the catalog once, e.g.:
//        curl -s 'https://<shop>.myshopify.com/products.json' > shopify_products.json
//   2. node scripts/import-shopify.js
//
// Idempotent: matches existing rows by `sku` and UPDATEs them (refreshing
// name/category/price/description/status, keeping the existing image if
// the new one fails to download) instead of creating duplicates, so it's
// safe to re-run if Shopify's catalog changes later.
//
// Field mapping:
//   - price   -> both `dp_price` and `mrp_price` (this app doesn't have a
//                separate "distributor price" concept for Shopify-sourced
//                products; the storefront only ever reads `mrp_price`, per
//                the public products/order routes in server.js)
//   - sku     -> variant SKU if present, else a slug-derived fallback
//                (`SHOP-<HANDLE>`) so every row still has a usable SKU
//   - category-> Shopify's `product_type`, falling back to its first tag
//   - description -> `body_html` stripped of HTML tags/entities and capped
//                at 2000 chars (Shopify's marketing copy can be very long;
//                the storefront UI clamps/expands this via a detail modal)
//   - image   -> first `images[].src`, downloaded to
//                `public/uploads/products/<slug>.<ext>`
//
// Result of the run that populated production (2026-09-19):
//   {"created":25,"updated":2,"imgOk":27,"imgFail":0,"total":27}

const fs = require('fs');
const path = require('path');
const https = require('https');
const { db, slugify } = require('../db.js');

function uniqueSlug(desired) {
  let base = slugify(desired) || 'product';
  const taken = new Set(
    db
      .prepare("SELECT slug FROM products WHERE slug IS NOT NULL AND slug != ''")
      .all()
      .map((r) => r.slug)
  );
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = base + '-' + n;
    n++;
  }
  return candidate;
}

function stripHtml(html) {
  let text = String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 2000);
}

function downloadImage(url, destPath) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return downloadImage(res.headers.location, destPath).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      })
      .on('error', reject);
  });
}

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'products');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

async function main() {
  const inputPath = path.join(__dirname, '..', 'shopify_products.json');
  const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  let created = 0;
  let updated = 0;
  let imgOk = 0;
  let imgFail = 0;

  for (const p of data.products) {
    const v = (p.variants && p.variants[0]) || {};
    const price = parseFloat(v.price || '0') || 0;
    const sku = (v.sku && String(v.sku).trim()) || ('SHOP-' + p.handle).toUpperCase().slice(0, 40);
    const existing = db.prepare('SELECT sku, slug FROM products WHERE sku = ?').get(sku);
    const slug = existing ? existing.slug : uniqueSlug(p.title);
    const category = p.product_type || (p.tags && p.tags[0]) || 'General';
    const description = stripHtml(p.body_html);

    let imageUrl = null;
    const srcImg = (p.images && p.images[0] && p.images[0].src) || null;
    if (srcImg) {
      try {
        const ext = (srcImg.split('?')[0].split('.').pop() || 'jpg').toLowerCase().slice(0, 4);
        const fname = slug + '.' + ext;
        const dest = path.join(UPLOAD_DIR, fname);
        await downloadImage(srcImg, dest);
        imageUrl = '/uploads/products/' + fname;
        imgOk++;
      } catch (e) {
        console.log('image failed for', p.title, e.message);
        imgFail++;
      }
    }

    if (existing) {
      db.prepare(
        "UPDATE products SET name=?, category=?, dp_price=?, mrp_price=?, status=?, description=?, image_url=COALESCE(?, image_url), show_in_store=1, updated_at=datetime('now') WHERE sku=?"
      ).run(p.title, category, price, price, 'Active', description, imageUrl, sku);
      updated++;
    } else {
      db.prepare(
        'INSERT INTO products (sku, name, category, dp_price, mrp_price, pv, bv, status, description, image_url, slug, show_in_store) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)'
      ).run(sku, p.title, category, price, price, 0, 0, 'Active', description, imageUrl, slug);
      created++;
    }
  }

  console.log(JSON.stringify({ created, updated, imgOk, imgFail, total: data.products.length }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
