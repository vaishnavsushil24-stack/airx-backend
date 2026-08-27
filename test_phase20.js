// Standalone functional test for the Phase 20 AI eval harness scoring logic
// (scoreEvalResult in server.js). Express/OpenAI/Anthropic SDKs aren't
// installed in this sandbox (same reasoning as test_phase3/6/7/8/9/14/15/
// 16/17/19.js), so this reimplements the pure scoring function verbatim and
// exercises it directly. runSingleEval() itself (the part that makes a real
// AI call) is intentionally NOT tested here, same as embedText() in
// test_phase19.js and callAI() elsewhere in this repo.
// Run with: node test_phase20.js

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("PASS:", msg);
  }
};

// Copied verbatim from server.js - keep in sync if that logic ever changes.
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

// ---- 1. All expected keywords present -> pass ----
const r1 = scoreEvalResult("Take 2 tablets after breakfast and dinner, with warm water.", { expectedKeywords: ["breakfast", "dinner"] });
assert(r1.passed === true && r1.missingKeywords.length === 0, "an answer containing every expected keyword passes");

// ---- 2. A missing expected keyword -> fail, and is named ----
const r2 = scoreEvalResult("Take 2 tablets after breakfast.", { expectedKeywords: ["breakfast", "dinner"] });
assert(r2.passed === false && r2.missingKeywords.length === 1 && r2.missingKeywords[0] === "dinner", "a missing expected keyword fails and is reported by name");

// ---- 3. Case-insensitive matching ----
const r3 = scoreEvalResult("Consult your DOCTOR before use.", { expectedKeywords: ["doctor"] });
assert(r3.passed === true, "keyword matching is case-insensitive");

// ---- 4. A forbidden term present -> fail ----
const r4 = scoreEvalResult("Take 500mg twice a day.", { expectedKeywords: [], mustNotContain: ["500mg"] });
assert(r4.passed === false && r4.foundForbidden.includes("500mg"), "a forbidden term appearing in the answer fails the case and is reported");

// ---- 5. No forbidden term present -> passes that half of the check ----
const r5 = scoreEvalResult("Please consult a doctor for exact dosage.", { expectedKeywords: [], mustNotContain: ["500mg"] });
assert(r5.passed === true, "an answer with no forbidden terms passes");

// ---- 6. Both expected and forbidden checks combine correctly ----
const r6 = scoreEvalResult("Consult a doctor. Do not exceed 500mg.", { expectedKeywords: ["doctor"], mustNotContain: ["500mg"] });
assert(r6.passed === false, "an answer that satisfies expectedKeywords but also contains a forbidden term still fails overall");

// ---- 7. Empty/undefined expectedKeywords and mustNotContain trivially pass ----
const r7 = scoreEvalResult("Anything at all.", {});
assert(r7.passed === true, "a case with no configured keywords at all trivially passes (nothing to check)");

// ---- 8. Empty answer against real expectations fails cleanly, no crash ----
const r8 = scoreEvalResult("", { expectedKeywords: ["refund"] });
assert(r8.passed === false && r8.missingKeywords.length === 1, "an empty/null answer against a real expectation fails without throwing");
const r8b = scoreEvalResult(null, { expectedKeywords: ["refund"] });
assert(r8b.passed === false, "a null answer is handled the same as an empty string, not a crash");

// ---- 9. Multiple missing keywords are all reported, not just the first ----
const r9 = scoreEvalResult("This mentions nothing relevant.", { expectedKeywords: ["refund", "returns", "7 days"] });
assert(r9.missingKeywords.length === 3, "every missing keyword is reported, not just the first");

console.log(process.exitCode ? "\nSome tests FAILED." : "\nAll test_phase20 checks passed.");
