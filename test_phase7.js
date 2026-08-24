// Standalone functional test for the Phase 7 DB logic (CMS content menus:
// News, Meeting, Gallery, Video, Media/Presentations, Training, Testimonial,
// Slider — all backed by the single cms_content table). Same reasoning as
// test_phase6.js: npm install is blocked in this sandbox (403 from the
// registry) so express itself isn't available here to boot the real server —
// this exercises the exact same SQL the server.js /api/cms/:type routes use,
// directly against db.js. Full HTTP-level verification happens live against
// the deployed Render API after push.
// Run with: node test_phase7.js

const fs = require("fs");
const path = require("path");
const DATA_DIR = path.join(__dirname, "data");
if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });

const { db } = require("./db.js");

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("PASS:", msg);
  }
};

const CMS_CONTENT_TYPES = ["news", "meeting", "gallery", "video", "media", "training", "testimonial", "slider"];

// ---- every content type accepts an insert (mirrors POST /api/cms/:type) ----
for (const type of CMS_CONTENT_TYPES) {
  const result = db
    .prepare(
      `INSERT INTO cms_content (content_type, title, description, image_url, link_url, event_date, display_order, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(type, `Sample ${type}`, "desc", "https://example.com/img.jpg", "https://example.com/link", "2026-08-24", 1, "Active");
  assert(result.lastInsertRowid > 0, `cms_content accepts a "${type}" row`);
}
assert(db.prepare("SELECT COUNT(*) AS n FROM cms_content").get().n === CMS_CONTENT_TYPES.length, "one row per content type created");

// ---- listing is scoped to a single type and ordered by display_order (mirrors GET /api/cms/:type) ----
db.prepare(
  `INSERT INTO cms_content (content_type, title, display_order, status) VALUES ('news', 'Second news item', 0, 'Active')`
).run();
const newsRows = db.prepare("SELECT * FROM cms_content WHERE content_type = ? ORDER BY display_order ASC, created_at DESC").all("news");
assert(newsRows.length === 2, "listing a type only returns that type's rows");
assert(newsRows[0].title === "Second news item", "listing orders by display_order ascending first");

// ---- update (mirrors PATCH /api/cms/:type/:id) ----
const target = db.prepare("SELECT * FROM cms_content WHERE content_type = 'slider'").get();
const merged = { ...target, status: "Inactive", title: "Updated Slider Title" };
db.prepare(
  `UPDATE cms_content SET title=?, description=?, image_url=?, link_url=?, event_date=?, display_order=?, status=?, updated_at=datetime('now')
   WHERE id=?`
).run(merged.title, merged.description, merged.image_url, merged.link_url, merged.event_date, merged.display_order, merged.status, target.id);
const updated = db.prepare("SELECT * FROM cms_content WHERE id = ?").get(target.id);
assert(updated.title === "Updated Slider Title" && updated.status === "Inactive", "patch updates title and status");

// ---- delete is scoped to type+id (mirrors DELETE /api/cms/:type/:id) ----
const wrongTypeDelete = db.prepare("DELETE FROM cms_content WHERE id = ? AND content_type = ?").run(target.id, "video");
assert(wrongTypeDelete.changes === 0, "delete with the wrong content_type is a no-op (route-level type scoping works)");
const rightTypeDelete = db.prepare("DELETE FROM cms_content WHERE id = ? AND content_type = ?").run(target.id, "slider");
assert(rightTypeDelete.changes === 1, "delete with the matching content_type removes the row");
assert(!db.prepare("SELECT 1 FROM cms_content WHERE id = ?").get(target.id), "deleted row is gone");

console.log(process.exitCode === 1 ? "\n=== SOME TESTS FAILED ===" : "\n=== ALL TESTS PASSED ===");
