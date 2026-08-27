// Standalone functional test for the Phase 22 sentiment-aware engagement
// triage logic (classifyEngagementSentiment in server.js, and the updated
// auto-send gate in handleIncomingSocialComment). Express isn't installed in
// this sandbox (same reasoning as test_phase3/6/7/8/9/14/15/16/17/19/20/21.js),
// so this reimplements the pure functions verbatim and exercises them
// directly. Run with: node test_phase22.js

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("PASS:", msg);
  }
};

// Copied verbatim from server.js - keep in sync if that logic ever changes.
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

function classifyEngagementSentiment(message) {
  const text = String(message || "").toLowerCase();
  const urgentHits = URGENT_KEYWORDS.filter((k) => text.includes(k));
  const negativeHits = NEGATIVE_KEYWORDS.filter((k) => text.includes(k));
  const positiveHits = POSITIVE_KEYWORDS.filter((k) => text.includes(k));
  let sentiment = "neutral";
  if (urgentHits.length || negativeHits.length) sentiment = "negative";
  else if (positiveHits.length) sentiment = "positive";
  let priority = "normal";
  if (urgentHits.length) priority = "high";
  else if (negativeHits.length) priority = "medium";
  return { sentiment, priority, flaggedKeywords: [...urgentHits, ...negativeHits] };
}

// Mirrors the real gate in handleIncomingSocialComment: a "high" priority
// item never auto-sends, no matter the env flag.
function shouldAutoSendReply(priority, envFlag, draftReply) {
  return priority !== "high" && envFlag === "true" && !!draftReply;
}

// ---- 1. Plain positive feedback classifies as positive/normal ----
const r1 = classifyEngagementSentiment("Thank you so much, great product! Ordering again.");
assert(r1.sentiment === "positive" && r1.priority === "normal", "positive feedback classifies as sentiment:positive, priority:normal");

// ---- 2. Neutral question classifies as neutral/normal ----
const r2 = classifyEngagementSentiment("What time does your store open?");
assert(r2.sentiment === "neutral" && r2.priority === "normal", "an unrelated neutral question classifies as neutral/normal");

// ---- 3. A negative-but-not-urgent comment classifies as negative/medium ----
const r3 = classifyEngagementSentiment("This is the worst experience, poor quality product.");
assert(r3.sentiment === "negative" && r3.priority === "medium", "negative feedback without an urgent keyword is priority:medium");

// ---- 4. An urgent complaint classifies as negative/high, regardless of what else is said ----
const r4 = classifyEngagementSentiment("Thanks for the great product but my mother had an allergic reaction, I want a refund immediately.");
assert(r4.sentiment === "negative" && r4.priority === "high", "an urgent health/refund keyword forces priority:high even alongside positive language");

// ---- 5. Urgent keywords are named in flaggedKeywords for the admin UI ----
assert(r4.flaggedKeywords.includes("allergic reaction") === false && r4.flaggedKeywords.includes("allergic") && r4.flaggedKeywords.includes("refund"), "the specific urgent keywords found are surfaced in flaggedKeywords");

// ---- 6. Hinglish negative keywords are recognized ----
const r6 = classifyEngagementSentiment("Yeh product bilkul bekaar hai, paisa barbad ho gaya.");
assert(r6.sentiment === "negative" && r6.priority === "medium", "Hinglish negative phrases (bekaar, paisa barbad) are recognized, not just English");

// ---- 7. Case-insensitive matching ----
const r7 = classifyEngagementSentiment("I WANT A REFUND NOW");
assert(r7.priority === "high", "keyword matching is case-insensitive");

// ---- 8. Empty/missing message doesn't crash and classifies as neutral ----
const r8 = classifyEngagementSentiment("");
assert(r8.sentiment === "neutral" && r8.priority === "normal", "an empty message classifies safely as neutral/normal rather than crashing");
const r8b = classifyEngagementSentiment(undefined);
assert(r8b.sentiment === "neutral", "an undefined message is handled the same as empty, not a crash");

// ---- 9. Auto-send gate: urgent items never auto-send, even with the flag on and a good draft ----
assert(shouldAutoSendReply("high", "true", "Sorry to hear that, our team will reach out.") === false, "a high-priority (urgent) item never auto-sends even when AI_AUTO_REPLY_SOCIAL=true and a draft exists");

// ---- 10. Auto-send gate: normal-priority items still respect the original flag/draft logic ----
assert(shouldAutoSendReply("normal", "true", "Thanks for reaching out!") === true, "a normal-priority item still auto-sends when the flag is on and a draft exists");
assert(shouldAutoSendReply("normal", undefined, "Thanks for reaching out!") === false, "a normal-priority item still respects the flag being unset");
assert(shouldAutoSendReply("normal", "true", "") === false, "a normal-priority item still requires a non-empty draft");
assert(shouldAutoSendReply("medium", "true", "We're sorry to hear that.") === true, "a medium-priority (negative but not urgent) item can still auto-send when opted in — only 'high' is hard-blocked");

console.log(process.exitCode ? "\nSome tests FAILED." : "\nAll test_phase22 checks passed.");
