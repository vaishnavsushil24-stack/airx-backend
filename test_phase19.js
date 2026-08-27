// Standalone functional test for the Phase 19 semantic-search / RAG logic
// (cosineSimilarity, rankKBBySimilarity in server.js). Express and the OpenAI
// SDK aren't installed in this sandbox (same reasoning as
// test_phase3/6/7/8/9/14/15/16/17.js), so this reimplements the pure
// functions verbatim and exercises them directly — embedText() itself (the
// only part that makes a network call) is intentionally NOT tested here,
// the same way callAI()'s HTTP call isn't unit-tested elsewhere in this repo.
// Run with: node test_phase19.js

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("PASS:", msg);
  }
};

// Copied verbatim from server.js - keep in sync if that logic ever changes.
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return -1;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function rankKBBySimilarity(queryEmbedding, kb, topN) {
  const embedded = kb.filter((k) => Array.isArray(k.embedding) && k.embedding.length);
  if (!queryEmbedding || !embedded.length) return kb; // fall back to everything - old behavior
  return embedded
    .map((k) => ({ ...k, _score: cosineSimilarity(queryEmbedding, k.embedding) }))
    .sort((a, b) => b._score - a._score)
    .slice(0, topN)
    .map(({ _score, ...k }) => k);
}

// Same logic as retrieveRelevantKB in server.js, but with embedText() injected
// as a parameter (embedTextFn) instead of called directly, so this test can
// swap in a fake and assert on call counts without hitting the network.
async function retrieveRelevantKB(query, kb, topN, embedTextFn) {
  if (!kb.length) return kb;
  if (kb.length <= topN) return kb; // small KB - no point ranking, just use it all like before
  const queryEmbedding = await embedTextFn(query);
  return rankKBBySimilarity(queryEmbedding, kb, topN);
}

// ---- 1. Identical vectors -> similarity 1 ----
assert(Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-9, "identical vectors have cosine similarity 1");

// ---- 2. Orthogonal vectors -> similarity 0 ----
assert(Math.abs(cosineSimilarity([1, 0], [0, 1]) - 0) < 1e-9, "orthogonal vectors have cosine similarity 0");

// ---- 3. Opposite vectors -> similarity -1 ----
assert(Math.abs(cosineSimilarity([1, 2], [-1, -2]) - -1) < 1e-9, "exactly opposite vectors have cosine similarity -1");

// ---- 4. Mismatched lengths / missing vectors are handled safely ----
assert(cosineSimilarity([1, 2], [1, 2, 3]) === -1, "mismatched-length vectors return -1 rather than throwing");
assert(cosineSimilarity(null, [1, 2]) === -1, "a missing vector returns -1 rather than throwing");
assert(cosineSimilarity([0, 0], [1, 2]) === -1, "a zero-magnitude vector returns -1 rather than dividing by zero");

// ---- 5. rankKBBySimilarity: top-N selection correctness ----
const kb = [
  { id: "a", title: "close match", embedding: [1, 0, 0] },
  { id: "b", title: "far match", embedding: [0, 0, 1] },
  { id: "c", title: "mid match", embedding: [0.7, 0.7, 0] },
];
const ranked = rankKBBySimilarity([1, 0, 0], kb, 2);
assert(ranked.length === 2, "rankKBBySimilarity respects topN and returns only 2 of 3 articles");
assert(ranked[0].id === "a", "the exact-match article ranks first");
assert(ranked[1].id === "c", "the partial-match article ranks second, ahead of the orthogonal one");
assert(ranked.every((k) => !("_score" in k)), "the internal _score field is stripped before returning");

// ---- 6. rankKBBySimilarity: graceful fallback when no query embedding ----
const fallbackNoQuery = rankKBBySimilarity(null, kb, 2);
assert(fallbackNoQuery.length === 3, "with no query embedding (e.g. OPENAI_API_KEY not set), the full KB is returned untouched");

// ---- 7. rankKBBySimilarity: graceful fallback when no articles have embeddings ----
const unembeddedKB = [
  { id: "x", title: "no embedding yet" },
  { id: "y", title: "also no embedding" },
];
const fallbackNoEmbeddings = rankKBBySimilarity([1, 0, 0], unembeddedKB, 1);
assert(fallbackNoEmbeddings.length === 2, "when no KB articles have embeddings yet, the full KB is returned untouched");

// ---- 8. rankKBBySimilarity: articles missing an embedding are simply excluded from ranking, not crashed on ----
const mixedKB = [
  { id: "a", title: "has embedding", embedding: [1, 0, 0] },
  { id: "b", title: "missing embedding" },
];
const mixedRanked = rankKBBySimilarity([1, 0, 0], mixedKB, 5);
assert(mixedRanked.length === 1 && mixedRanked[0].id === "a", "an article with no embedding is skipped, not treated as a crash or a zero-score match");

// ---- 9. retrieveRelevantKB: small KB skips embedding entirely (no network call needed) ----
let embedCalls = 0;
const fakeEmbed = async () => { embedCalls++; return [1, 0, 0]; };
(async () => {
  const smallKB = [{ id: "a", embedding: [1, 0, 0] }, { id: "b", embedding: [0, 1, 0] }];
  const result9 = await retrieveRelevantKB("anything", smallKB, 5, fakeEmbed);
  assert(result9.length === 2 && embedCalls === 0, "a KB no larger than topN is returned as-is without calling embedText at all");

  // ---- 10. retrieveRelevantKB: empty KB short-circuits too ----
  const result10 = await retrieveRelevantKB("anything", [], 5, fakeEmbed);
  assert(Array.isArray(result10) && result10.length === 0 && embedCalls === 0, "an empty KB short-circuits without calling embedText");

  // ---- 11. retrieveRelevantKB: large KB does call embedText and ranks the result ----
  const bigKB = [
    { id: "a", embedding: [1, 0, 0] },
    { id: "b", embedding: [0, 1, 0] },
    { id: "c", embedding: [0, 0, 1] },
  ];
  const result11 = await retrieveRelevantKB("anything", bigKB, 2, fakeEmbed);
  assert(embedCalls === 1, "a KB larger than topN triggers exactly one embedText call for the query");
  assert(result11.length === 2 && result11[0].id === "a", "the ranked result honors topN and puts the best match first");

  console.log(process.exitCode ? "\nSome tests FAILED." : "\nAll test_phase19 checks passed.");
})();
