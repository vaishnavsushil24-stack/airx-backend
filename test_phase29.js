// Standalone functional test for the Phase 29 tiered model routing logic
// (selectAIModel in server.js). Express isn't installed in this sandbox
// (same reasoning as test_phase3/6/7/8/9/14/.../28.js), so this
// reimplements the pure function verbatim with its own default constants
// (mirroring server.js's env-var-or-default pattern) and exercises it
// directly. The actual fetch() calls inside callAI() aren't tested here,
// same as elsewhere in this repo — only the model-selection decision.
// Run with: node test_phase29.js

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("PASS:", msg);
  }
};

// Mirrors server.js's defaults (no env vars set in this test run).
const OPENAI_MODEL_FAST = process.env.OPENAI_MODEL_FAST || process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_MODEL_SMART = process.env.OPENAI_MODEL_SMART || "gpt-4o";
const ANTHROPIC_MODEL_FAST = process.env.ANTHROPIC_MODEL_FAST || "claude-3-5-haiku-20241022";
const ANTHROPIC_MODEL_SMART = process.env.ANTHROPIC_MODEL_SMART || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";

// Copied verbatim from server.js - keep in sync if that logic ever changes.
function selectAIModel(provider, tier) {
  if (provider === "openai") return tier === "smart" ? OPENAI_MODEL_SMART : OPENAI_MODEL_FAST;
  if (provider === "anthropic") return tier === "smart" ? ANTHROPIC_MODEL_SMART : ANTHROPIC_MODEL_FAST;
  return null;
}

// ---- 1. OpenAI fast tier defaults to gpt-4o-mini (same as this app always used) ----
assert(selectAIModel("openai", "fast") === "gpt-4o-mini", "OpenAI fast tier defaults to gpt-4o-mini - unchanged from pre-Phase-29 behavior");

// ---- 2. OpenAI smart tier steps up to gpt-4o ----
assert(selectAIModel("openai", "smart") === "gpt-4o", "OpenAI smart tier defaults to the stronger gpt-4o");

// ---- 3. Anthropic fast tier defaults to the cheaper Haiku model ----
assert(selectAIModel("anthropic", "fast") === "claude-3-5-haiku-20241022", "Anthropic fast tier defaults to Haiku - a real cost reduction from the old always-Sonnet behavior");

// ---- 4. Anthropic smart tier keeps the original Sonnet default ----
assert(selectAIModel("anthropic", "smart") === "claude-sonnet-4-5-20250929", "Anthropic smart tier keeps the pre-Phase-29 Sonnet default, unchanged for the one call site that needs it");

// ---- 5. No tier specified defaults to fast (callAI's own default parameter, mirrored here) ----
assert(selectAIModel("openai", undefined) === OPENAI_MODEL_FAST, "an unspecified tier resolves to the fast model, matching callAI's tier='fast' default parameter");

// ---- 6. Unknown provider returns null rather than throwing ----
assert(selectAIModel("unknown-provider", "fast") === null, "an unrecognized provider returns null rather than throwing or silently picking a default");

// ---- 7. An unrecognized tier string falls back to fast, not smart (fast is the safe default) ----
assert(selectAIModel("openai", "ultra-mega-tier") === OPENAI_MODEL_FAST, "an unrecognized tier value falls back to the cheaper fast tier rather than accidentally routing to the expensive smart tier");

console.log(process.exitCode ? "\nSome tests FAILED." : "\nAll test_phase29 checks passed.");
