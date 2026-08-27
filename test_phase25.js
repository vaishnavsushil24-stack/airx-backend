// Standalone functional test for the Phase 25 ad-creative variant testing
// logic (rankAdVariants in server.js). Express isn't installed in this
// sandbox (same reasoning as test_phase3/6/7/8/9/14/15/16/17/19/20/21/22/23/24.js),
// so this reimplements the pure function verbatim and exercises it
// directly. The live-insights-fetching route itself isn't tested here, same
// as embedText()/callAI() elsewhere in this repo — only the comparison math.
// Run with: node test_phase25.js

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("PASS:", msg);
  }
};

// Copied verbatim from server.js - keep in sync if that logic ever changes.
const AD_VARIANT_MIN_IMPRESSIONS = 500;

function rankAdVariants(variants) {
  const ranked = variants.map((v) => {
    const impressions = Number((v.insights && v.insights.impressions) || 0);
    const clicks = Number((v.insights && v.insights.clicks) || 0);
    const spend = Number((v.insights && v.insights.spend) || 0);
    const ctr = impressions > 0 ? clicks / impressions : null;
    const cpc = clicks > 0 ? spend / clicks : null;
    return { id: v.id, name: v.name, variantLabel: v.variantLabel, impressions, clicks, spend, ctr, cpc };
  });
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

// ---- 1. Fewer than 2 variants -> no comparison possible ----
const r1 = rankAdVariants([{ id: "a", name: "A", variantLabel: "A", insights: { impressions: 1000, clicks: 50, spend: 100 } }]);
assert(r1.winner === null && r1.reason.includes("at least 2"), "a single variant can't be compared — no winner, clear reason");

// ---- 2. Not enough impressions yet -> no winner declared even with a clear CTR leader ----
const r2 = rankAdVariants([
  { id: "a", name: "A", variantLabel: "A", insights: { impressions: 50, clicks: 10, spend: 20 } }, // 20% CTR but tiny sample
  { id: "b", name: "B", variantLabel: "B", insights: { impressions: 40, clicks: 2, spend: 10 } },
]);
assert(r2.winner === null && r2.reason.includes("not enough data"), "a variant leading by CTR but below the impressions threshold doesn't get declared a winner yet");

// ---- 3. Enough impressions -> higher-CTR variant wins ----
const r3 = rankAdVariants([
  { id: "a", name: "A", variantLabel: "A", insights: { impressions: 1000, clicks: 80, spend: 200 } }, // 8% CTR
  { id: "b", name: "B", variantLabel: "B", insights: { impressions: 1000, clicks: 40, spend: 150 } }, // 4% CTR
]);
assert(r3.winner === "a" && r3.ranked[0].id === "a", "with sufficient impressions, the higher-CTR variant is declared the winner and ranked first");

// ---- 4. Equal CTR -> tie-break by lower CPC ----
const r4 = rankAdVariants([
  { id: "a", name: "A", variantLabel: "A", insights: { impressions: 1000, clicks: 50, spend: 250 } }, // CTR 5%, CPC ₹5
  { id: "b", name: "B", variantLabel: "B", insights: { impressions: 1000, clicks: 50, spend: 100 } }, // CTR 5%, CPC ₹2
]);
assert(r4.winner === "b" && r4.ranked[0].id === "b", "with equal CTR, the variant with the lower cost-per-click wins the tie-break");

// ---- 5. A variant with no insights yet (not launched) sorts last, not crashed on ----
const r5 = rankAdVariants([
  { id: "a", name: "A", variantLabel: "A", insights: { impressions: 1000, clicks: 60, spend: 150 } },
  { id: "b", name: "B", variantLabel: "B", insights: null },
]);
assert(r5.ranked[0].id === "a" && r5.ranked[1].id === "b" && r5.ranked[1].ctr === null, "a variant with no insights yet (e.g. not launched) sorts last rather than crashing the comparison");

// ---- 6. Zero impressions produces a null CTR, not a divide-by-zero NaN/Infinity ----
const r6 = rankAdVariants([{ id: "a", name: "A", variantLabel: "A", insights: { impressions: 0, clicks: 0, spend: 0 } }, { id: "b", name: "B", variantLabel: "B", insights: { impressions: 500, clicks: 25, spend: 50 } }]);
assert(r6.ranked.find((v) => v.id === "a").ctr === null, "zero impressions produces a null CTR rather than NaN or Infinity");

console.log(process.exitCode ? "\nSome tests FAILED." : "\nAll test_phase25 checks passed.");
