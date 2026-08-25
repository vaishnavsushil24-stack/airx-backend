// Standalone functional test for the Phase 16 Social Media Hub's pure
// logic (metaGenders targeting mapping, the scheduler's "due posts" filter,
// engagement webhook de-duplication, and the two safety gates that matter
// most here: AI auto-reply defaulting to OFF, and ad-campaign activation
// requiring an explicit confirm flag - real money is on the other side of
// that one). Express/node:sqlite aren't exercised (same reasoning as
// test_phase3/6/7/8/9/14/15.js - Express isn't installed in this sandbox).
// Functions below are copied verbatim from server.js; keep them in sync if
// that logic ever changes.
// Run with: node test_phase16.js

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("PASS:", msg);
  }
};

// ---- copied verbatim from server.js ----
function metaGenders(genders) {
  if (genders === "male") return [1];
  if (genders === "female") return [2];
  return undefined; // omitted = all genders
}

function dueScheduledPosts(posts, now) {
  return posts.filter((p) => p.status === "scheduled" && p.scheduledAt && new Date(p.scheduledAt).getTime() <= now);
}

function isDuplicateEngagement(existing, externalId) {
  return existing.some((e) => e.externalId === externalId);
}

function shouldAutoSendReply(envFlag, draftReply) {
  return envFlag === "true" && !!draftReply;
}

function isActivateConfirmed(body) {
  return body.confirm === true;
}

// ---- 1. metaGenders targeting mapping ----
assert(JSON.stringify(metaGenders("male")) === "[1]", 'metaGenders("male") maps to Meta code [1]');
assert(JSON.stringify(metaGenders("female")) === "[2]", 'metaGenders("female") maps to Meta code [2]');
assert(metaGenders("all") === undefined, 'metaGenders("all") omits the field (targets everyone)');
assert(metaGenders(undefined) === undefined, "metaGenders with no value omits the field rather than crashing");

// ---- 2. Scheduler due-posts filter ----
const NOW = new Date("2026-08-25T12:00:00Z").getTime();
const posts = [
  { id: "p1", status: "scheduled", scheduledAt: "2026-08-25T10:00:00Z" }, // in the past -> due
  { id: "p2", status: "scheduled", scheduledAt: "2026-08-26T10:00:00Z" }, // in the future -> not due
  { id: "p3", status: "draft", scheduledAt: null }, // no schedule -> never due
  { id: "p4", status: "published", scheduledAt: "2026-08-24T10:00:00Z" }, // already published -> excluded
  { id: "p5", status: "scheduled", scheduledAt: "2026-08-25T12:00:00Z" }, // exactly now -> due (<=)
];
const due = dueScheduledPosts(posts, NOW);
assert(due.length === 2 && due.some((p) => p.id === "p1") && due.some((p) => p.id === "p5"), "only past-or-exactly-now scheduled posts are due");
assert(!due.some((p) => p.id === "p2"), "future-scheduled post is not due yet");
assert(!due.some((p) => p.id === "p3"), "draft post with no schedule is never picked up by the scheduler");
assert(!due.some((p) => p.id === "p4"), "already-published post is excluded even if its old scheduledAt is in the past");

// ---- 3. Engagement webhook de-duplication (Meta can redeliver webhooks) ----
const existing = [{ externalId: "comment_123" }, { externalId: "comment_456" }];
assert(isDuplicateEngagement(existing, "comment_123") === true, "a comment_id already stored is recognized as a duplicate redelivery");
assert(isDuplicateEngagement(existing, "comment_999") === false, "a genuinely new comment_id is not flagged as duplicate");

// ---- 4. AI auto-reply defaults OFF (the reputational-risk guard) ----
assert(shouldAutoSendReply(undefined, "Thanks for reaching out!") === false, "with AI_AUTO_REPLY_SOCIAL unset, auto-send stays off even with a good draft");
assert(shouldAutoSendReply("false", "Thanks for reaching out!") === false, 'AI_AUTO_REPLY_SOCIAL="false" keeps auto-send off');
assert(shouldAutoSendReply("true", "") === false, "auto-send never fires on an empty/failed AI draft, even if the flag is on");
assert(shouldAutoSendReply("true", "Thanks for reaching out!") === true, "auto-send only fires when the founder explicitly opted in AND a real draft exists");

// ---- 5. Ad campaign activation requires an explicit confirm flag (real spend) ----
assert(isActivateConfirmed({}) === false, "activating with no confirm field is rejected");
assert(isActivateConfirmed({ confirm: false }) === false, "activating with confirm:false is rejected");
assert(isActivateConfirmed({ confirm: "true" }) === false, "activating with the string \"true\" (not boolean) is rejected - no accidental truthy bypass");
assert(isActivateConfirmed({ confirm: true }) === true, "activating with confirm:true (boolean) is accepted");

console.log(process.exitCode ? "\nSome tests FAILED." : "\nAll test_phase16 checks passed.");
