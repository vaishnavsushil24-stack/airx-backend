// Standalone functional test for the Phase 28 daily AI briefing logic
// (summarizeBriefingSignals, and generateDailyBriefing's fallback/caching
// shape, in server.js). Express isn't installed in this sandbox (same
// reasoning as test_phase3/6/7/8/9/14/.../27.js), so this reimplements the
// pure function verbatim. gatherBriefingSignals() itself (all I/O) isn't
// tested here, same as every other thin DB/file-touching wrapper in this
// repo — only the summarization logic that turns signals into text.
// Run with: node test_phase28.js

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("PASS:", msg);
  }
};

// Copied verbatim from server.js - keep in sync if that logic ever changes.
function summarizeBriefingSignals(signals) {
  const lines = [];
  if (signals.lowStock.length) lines.push(`${signals.lowStock.length} item(s) at/below their low-stock threshold: ${signals.lowStock.map((i) => i.name).slice(0, 5).join(", ")}`);
  if (signals.nearExpiry.length) lines.push(`${signals.nearExpiry.length} batch(es) expiring within 60 days`);
  if (signals.stockingOutSoon.length) lines.push(`${signals.stockingOutSoon.length} item(s) projected to stock out within 14 days based on recent sales velocity: ${signals.stockingOutSoon.map((i) => i.name).slice(0, 5).join(", ")}`);
  if (signals.replenishmentDue.length) lines.push(`${signals.replenishmentDue.length} customer(s) likely ready to reorder`);
  if (signals.urgentEngagement.length) lines.push(`${signals.urgentEngagement.length} urgent social comment(s)/DM(s) awaiting a reply`);
  if (signals.topReferralCandidates.length) lines.push(`Best referral-ask candidates today: ${signals.topReferralCandidates.map((c) => `${c.mobile} (score ${c.score})`).join(", ")}`);
  if (signals.leads.total) lines.push(`${signals.leads.total} total leads on file (${Object.entries(signals.leads.byStatus).map(([k, v]) => `${v} ${k}`).join(", ")})`);
  if (signals.orderStats.total) lines.push(`${signals.orderStats.total} total orders, ₹${signals.orderStats.totalSales.toLocaleString("en-IN")} total sales`);
  if (!lines.length) lines.push("Nothing urgent to flag today — all clear across inventory, engagement, and reorders.");
  return lines;
}

// Mirrors generateDailyBriefing's fallback/AI shape, with callAI injected.
async function generateDailyBriefing(signals, callAIFn) {
  const bulletLines = summarizeBriefingSignals(signals);
  const fallbackText = bulletLines.map((l) => `• ${l}`).join("\n");
  try {
    const result = await callAIFn({ messages: [{ role: "user", content: bulletLines.join("\n") }], max_tokens: 300 });
    if (!result.configured || !result.text) return { text: fallbackText, configured: false };
    return { text: result.text.trim(), configured: true };
  } catch (err) {
    return { text: fallbackText, configured: false };
  }
}

const EMPTY_SIGNALS = {
  lowStock: [], nearExpiry: [], stockingOutSoon: [], replenishmentDue: [], urgentEngagement: [],
  topReferralCandidates: [], leads: { total: 0, byStatus: {} }, orderStats: { total: 0, totalSales: 0 },
};

// ---- 1. All-clear day produces a clear "nothing urgent" message, not an empty list ----
const lines1 = summarizeBriefingSignals(EMPTY_SIGNALS);
assert(lines1.length === 1 && lines1[0].includes("Nothing urgent"), "with no signals at all, the briefing says so explicitly instead of returning nothing");

// ---- 2. Each present signal produces its own line, with real numbers ----
const busySignals = {
  ...EMPTY_SIGNALS,
  lowStock: [{ name: "Ashwagandha Churna" }, { name: "Triphala" }],
  urgentEngagement: [{}, {}],
  replenishmentDue: [{}],
};
const lines2 = summarizeBriefingSignals(busySignals);
assert(lines2.some((l) => l.includes("2 item(s)") && l.includes("Ashwagandha Churna")), "low-stock items are named, not just counted");
assert(lines2.some((l) => l.includes("2 urgent")), "urgent engagement count appears in its own line");
assert(lines2.some((l) => l.includes("1 customer(s) likely ready to reorder")), "replenishment-due count appears in its own line");
assert(lines2.length === 3, "only signals that actually have data produce a line - no empty/zero lines");

// ---- 3. Referral candidates are named with their scores ----
const lines3 = summarizeBriefingSignals({ ...EMPTY_SIGNALS, topReferralCandidates: [{ mobile: "9000000001", score: 80 }] });
assert(lines3[0].includes("9000000001") && lines3[0].includes("80"), "top referral candidates are named with their score, not just a count");

// ---- 4. Leads and order stats format their sub-breakdowns ----
const lines4 = summarizeBriefingSignals({ ...EMPTY_SIGNALS, leads: { total: 5, byStatus: { new: 3, contacted: 2 } }, orderStats: { total: 10, totalSales: 25000 } });
assert(lines4.some((l) => l.includes("5 total leads") && l.includes("3 new")), "lead status breakdown is included in the leads line");
assert(lines4.some((l) => l.includes("10 total orders") && l.includes("25,000")), "order stats line includes formatted total sales");

(async () => {
  // ---- 5. AI not configured -> falls back to the bulleted plain-text summary ----
  const notConfigured = async () => ({ configured: false, text: "" });
  const r5 = await generateDailyBriefing(busySignals, notConfigured);
  assert(r5.configured === false && r5.text.startsWith("•"), "with no AI provider configured, falls back to a plain bulleted summary");

  // ---- 6. AI configured -> uses its natural-language version instead ----
  const configuredGood = async () => ({ configured: true, text: "  Heads up: 2 items are low on stock and 2 urgent messages need a reply.  " });
  const r6 = await generateDailyBriefing(busySignals, configuredGood);
  assert(r6.configured === true && r6.text === "Heads up: 2 items are low on stock and 2 urgent messages need a reply.", "with a configured AI provider, its written version is used (trimmed)");

  // ---- 7. A thrown network error is caught and still returns a usable fallback ----
  const throwingCall = async () => { throw new Error("network down"); };
  const r7 = await generateDailyBriefing(busySignals, throwingCall);
  assert(r7.configured === false && r7.text.length > 0, "a thrown network error is caught and still returns the plain-text fallback, not an unhandled rejection");

  console.log(process.exitCode ? "\nSome tests FAILED." : "\nAll test_phase28 checks passed.");
})();
