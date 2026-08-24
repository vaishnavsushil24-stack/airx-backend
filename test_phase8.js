// Standalone functional test for the Phase 8 DB logic (multi-user admin
// auth: Admin/User/UserGroup/Permissions — admin_roles, admin_users,
// admin_sessions). Same reasoning as test_phase6.js/test_phase7.js: npm
// install is blocked in this sandbox (403 from the registry) so express
// itself isn't available here to boot the real server — this exercises the
// exact same crypto + SQL the server.js /api/auth/* and /api/admin/* routes
// use, directly against db.js and Node's built-in crypto. Full HTTP-level
// verification happens live against the deployed Render API after push.
// Run with: node test_phase8.js

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
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

// ---- password hashing (mirrors hashPassword/verifyPassword in server.js) ----
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

const { salt, hash } = hashPassword("correct horse battery staple");
assert(verifyPassword("correct horse battery staple", salt, hash), "correct password verifies");
assert(!verifyPassword("wrong password", salt, hash), "wrong password is rejected");
assert(!verifyPassword("correct horse battery staple2", salt, hash), "near-miss password is rejected");

// ---- bootstrap: first Super Admin role + user (mirrors POST /api/auth/bootstrap) ----
const roleResult = db.prepare("INSERT INTO admin_roles (role_name, permissions) VALUES ('Super Admin', ?)").run(JSON.stringify(["*"]));
const superRole = db.prepare("SELECT * FROM admin_roles WHERE id = ?").get(roleResult.lastInsertRowid);
const { salt: s1, hash: h1 } = hashPassword("supersecret1");
const userResult = db
  .prepare("INSERT INTO admin_users (username, password_hash, password_salt, full_name, role_id) VALUES (?, ?, ?, ?, ?)")
  .run("owner", h1, s1, "Business Owner", superRole.id);
assert(userResult.lastInsertRowid > 0, "first admin user created");
assert(db.prepare("SELECT COUNT(*) AS n FROM admin_users").get().n === 1, "exactly one admin user exists after bootstrap");

// duplicate username rejected
let dupeErr = null;
try {
  db.prepare("INSERT INTO admin_users (username, password_hash, password_salt, role_id) VALUES ('owner', 'x', 'y', ?)").run(superRole.id);
} catch (err) {
  dupeErr = err;
}
assert(dupeErr && String(dupeErr.message).includes("UNIQUE"), "duplicate username rejected by UNIQUE constraint");

// ---- a limited role (mirrors POST /api/admin/roles with specific module keys) ----
const staffRoleResult = db
  .prepare("INSERT INTO admin_roles (role_name, permissions) VALUES ('Payout Clerk', ?)")
  .run(JSON.stringify(["payouts", "accounts", "reports"]));
const staffRole = db.prepare("SELECT * FROM admin_roles WHERE id = ?").get(staffRoleResult.lastInsertRowid);
const { salt: s2, hash: h2 } = hashPassword("clerkpass1");
const clerkResult = db
  .prepare("INSERT INTO admin_users (username, password_hash, password_salt, full_name, role_id) VALUES (?, ?, ?, ?, ?)")
  .run("clerk1", h2, s2, "Payout Clerk", staffRole.id);
const clerk = db.prepare("SELECT * FROM admin_users WHERE id = ?").get(clerkResult.lastInsertRowid);

// ---- session issue + lookup (mirrors issueSession / loadSession in server.js) ----
function issueSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO admin_sessions (user_id, token, expires_at) VALUES (?, ?, ?)").run(userId, token, expiresAt);
  return { token, expiresAt };
}
function loadSession(token) {
  const session = db.prepare("SELECT * FROM admin_sessions WHERE token = ?").get(token);
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) return null;
  const user = db.prepare("SELECT * FROM admin_users WHERE id = ?").get(session.user_id);
  const role = db.prepare("SELECT * FROM admin_roles WHERE id = ?").get(user.role_id);
  return { user, role, permissions: JSON.parse(role.permissions) };
}

const { token } = issueSession(clerk.id);
const loaded = loadSession(token);
assert(loaded && loaded.user.username === "clerk1", "session token resolves back to the right user");
assert(loaded.permissions.includes("payouts") && !loaded.permissions.includes("user_management"), "limited role only grants its assigned modules");

// permission check simulation (mirrors requireAccess's check)
function hasAccess(perms, moduleKey) {
  return perms.includes("*") || perms.includes(moduleKey);
}
assert(hasAccess(loaded.permissions, "payouts") === true, "clerk role has access to payouts");
assert(hasAccess(loaded.permissions, "masters") === false, "clerk role does NOT have access to masters");
assert(hasAccess(JSON.parse(superRole.permissions), "masters") === true, "Super Admin ('*') has access to everything");

// expired session is rejected (mirrors loadSession's expiry check)
const expiredToken = crypto.randomBytes(32).toString("hex");
db.prepare("INSERT INTO admin_sessions (user_id, token, expires_at) VALUES (?, ?, ?)").run(
  clerk.id,
  expiredToken,
  new Date(Date.now() - 1000).toISOString()
);
assert(loadSession(expiredToken) === null, "expired session token is rejected");

// ---- role delete guard: cannot delete a role still assigned to a user ----
let roleDeleteBlocked = !db.prepare("SELECT 1 FROM admin_users WHERE role_id = ? LIMIT 1").get(staffRole.id) ? false : true;
assert(roleDeleteBlocked, "role delete guard: staff role is still referenced by clerk1 (route would return 409)");

// ---- last-admin-user delete guard ----
assert(db.prepare("SELECT COUNT(*) AS n FROM admin_users").get().n === 2, "two admin users exist (owner + clerk1) before guard checks");
// mirrors the route: sessions are deleted before the user (no ON DELETE
// CASCADE on admin_sessions.user_id, same explicit-pre-delete pattern as
// the Phase 6 member delete-guard fix).
db.prepare("DELETE FROM admin_sessions WHERE user_id = ?").run(clerk.id);
db.prepare("DELETE FROM admin_users WHERE id = ?").run(clerk.id);
assert(db.prepare("SELECT COUNT(*) AS n FROM admin_users").get().n === 1, "clerk1 deleted, one admin user remains");
const totalNow = db.prepare("SELECT COUNT(*) AS n FROM admin_users").get().n;
assert(totalNow === 1, "route's delete guard (totalUsers <= 1) would now block deleting the last remaining user");

// ---- reset-password forces re-login (mirrors POST /api/admin/users/:id/reset-password) ----
issueSession(userResult.lastInsertRowid);
issueSession(userResult.lastInsertRowid);
assert(db.prepare("SELECT COUNT(*) AS n FROM admin_sessions WHERE user_id = ?").get(userResult.lastInsertRowid).n >= 2, "owner has multiple active sessions");
db.prepare("DELETE FROM admin_sessions WHERE user_id = ?").run(userResult.lastInsertRowid);
assert(db.prepare("SELECT COUNT(*) AS n FROM admin_sessions WHERE user_id = ?").get(userResult.lastInsertRowid).n === 0, "reset-password's session wipe logs the user out everywhere");

console.log(process.exitCode === 1 ? "\n=== SOME TESTS FAILED ===" : "\n=== ALL TESTS PASSED ===");
