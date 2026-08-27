// Standalone functional test for the Phase 23 personalized replenishment
// reminder draft logic (generateReplenishmentReminderDraft in server.js).
// Express/OpenAI/Anthropic SDKs aren't installed in this sandbox (same
// reasoning as test_phase3/6/7/8/9/14/15/16/17/19/20/21/22.js), so this
// reimplements the function verbatim with callAI() injected as a parameter
// (same testability pattern as retrieveRelevantKB's embedTextFn in
// test_phase19.js) instead of calling the real network function directly.
// Run with: node test_phase23.js

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("PASS:", msg);
  }
};

// Same logic as generateReplenishmentReminderDraft in server.js, with
// callAIFn injected instead of calling the real callAI() directly.
async function generateReplenishmentReminderDraft({ name, product, mobile, daysOverdue, cycleSource, reorderCycleDays }, callAIFn) {
  const fallback = `Hi ${name || "there"}! Just checking in — based on your last ${product || "AIRX PLUS"} order, you might be running low. Reply here anytime to reorder, we're happy to help. 🙏 Team AIRX PLUS`;
  const system = "system prompt (not tested here - see server.js)";
  const context = `Customer name: ${name || "(unknown, use a friendly generic greeting)"}
Product: ${product || "their AIRX PLUS product"}
Days since their reminder became due: ${daysOverdue ?? "unknown"}
Their reorder cadence: ${cycleSource === "personalized" ? `personalized, based on their own past reorder gap of about ${reorderCycleDays} days` : `estimated at about ${reorderCycleDays || 30} days (not enough order history yet to personalize)`}`;
  try {
    const result = await callAIFn({
      messages: [
        { role: "system", content: system },
        { role: "user", content: context },
      ],
      max_tokens: 200,
    });
    if (!result.configured || !result.text) return { draft: fallback, configured: false };
    return { draft: result.text.trim(), configured: true };
  } catch (err) {
    return { draft: fallback, configured: false };
  }
}

(async () => {
  // ---- 1. AI not configured -> falls back to the plain templated message, not blank ----
  const notConfigured = async () => ({ configured: false, text: "" });
  const r1 = await generateReplenishmentReminderDraft({ name: "Priya", product: "Ashwagandha Churna" }, notConfigured);
  assert(r1.configured === false && r1.draft.includes("Priya") && r1.draft.includes("Ashwagandha Churna"), "with no AI provider configured, falls back to a plain but still personalized templated message (never blank)");

  // ---- 2. AI configured and returns text -> uses the AI draft, trimmed ----
  const configuredGood = async () => ({ configured: true, text: "  Hi Priya! Your Ashwagandha Churna may be running low — reply to reorder. 🙏  " });
  const r2 = await generateReplenishmentReminderDraft({ name: "Priya", product: "Ashwagandha Churna" }, configuredGood);
  assert(r2.configured === true && r2.draft === "Hi Priya! Your Ashwagandha Churna may be running low — reply to reorder. 🙏", "with a configured AI provider, uses its response (trimmed of surrounding whitespace)");

  // ---- 3. AI configured but returns empty text -> still falls back safely ----
  const configuredEmpty = async () => ({ configured: true, text: "" });
  const r3 = await generateReplenishmentReminderDraft({ name: "Priya", product: "Ashwagandha Churna" }, configuredEmpty);
  assert(r3.configured === false && r3.draft.length > 0, "a configured provider returning empty text still falls back to the templated message rather than an empty draft");

  // ---- 4. callAI throwing (network error) -> caught, falls back, doesn't crash the route ----
  const throwingCall = async () => { throw new Error("network down"); };
  const r4 = await generateReplenishmentReminderDraft({ name: "Priya", product: "Ashwagandha Churna" }, throwingCall);
  assert(r4.configured === false && r4.draft.length > 0, "a thrown network error is caught and still returns a usable fallback draft, not an unhandled rejection");

  // ---- 5. Missing name/product still produce a sensible generic fallback ----
  const r5 = await generateReplenishmentReminderDraft({}, notConfigured);
  assert(r5.draft.includes("there") && r5.draft.includes("AIRX PLUS"), "with no name/product given, the fallback still reads naturally with generic placeholders");

  console.log(process.exitCode ? "\nSome tests FAILED." : "\nAll test_phase23 checks passed.");
})();
