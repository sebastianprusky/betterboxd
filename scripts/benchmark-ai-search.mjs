import assert from "node:assert/strict";

const baseUrl = process.env.PICKAMOVIE_BASE_URL || "http://127.0.0.1:4173";
const cases = [
  { query: "marvel movies 2020s", expected: ["Black Widow", "Spider-Man: No Way Home"], mode: "collection" },
  { query: "comedy similar to borat", expectedTop: ["The Dictator"], mode: "curated" },
  { query: "Tom Cruise movies from the 1990s", expected: [], mode: "collection", every: (movie) => Number(movie.year) >= 1990 && Number(movie.year) <= 1999 },
  { query: "something funny but not dumb", expectedGenre: "Comedy", mode: "curated" },
  { query: "like Borat but less gross", excluded: ["Borat"], excludedTop: ["Brüno"], mode: "curated" },
  { query: "a tense thriller around 90 minutes", expectedGenre: "Thriller", mode: "curated", everyTop: (movie) => movie.runtime >= 75 && movie.runtime <= 105 },
];

for (const item of cases) {
  const response = await fetch(`${baseUrl}/api/ai-movie-search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: item.query }),
  });
  assert.equal(response.status, 200, `${item.query} should complete through AI-first search`);
  const data = await response.json();
  assert.equal(data.resultMode, item.mode, `${item.query} should use ${item.mode} mode`);
  assert(data.movies.length >= 3, `${item.query} should return at least three verified movies`);
  assert(data.movies.every((movie) => Number.isInteger(movie.id) && movie.posterPath), "every displayed movie must resolve to TMDB");
  (item.expected || []).forEach((title) => assert(data.movies.some((movie) => movie.title === title), `${item.query} should include ${title}`));
  (item.expectedTop || []).forEach((title) => assert(data.movies.slice(0, 5).some((movie) => movie.title === title), `${item.query} should place ${title} in the top results`));
  (item.excluded || []).forEach((title) => assert(!data.movies.some((movie) => movie.title === title), `${item.query} should exclude the reference movie ${title}`));
  (item.excludedTop || []).forEach((title) => assert(!data.movies.slice(0, 3).some((movie) => movie.title === title), `${item.query} should demote ${title} for the negative preference`));
  if (item.every) assert(data.movies.every(item.every), `${item.query} must respect its hard year constraint`);
  if (item.everyTop) assert(data.movies.slice(0, 3).every(item.everyTop), `${item.query} must respect runtime in the top three`);
  if (item.expectedGenre) assert(data.movies.slice(0, 3).every((movie) => movie.genres.includes(item.expectedGenre)), `${item.query} must return ${item.expectedGenre} movies`);
  assert(data.movies.every((movie) => data.promptEvidence[movie.id]?.reason && data.promptEvidence[movie.id]?.evidence), "every movie needs specific evidence");
  assert.equal(data.usedWebSearch, false, "low-cost search must never invoke web search");
  assert.equal(data.usage?.modelCalls, 1, "uncached search must use exactly one model call");
  assert(data.usage?.estimatedCostUsd <= .003, `${item.query} must remain below $0.003`);
  console.log(JSON.stringify({ query: item.query, mode: data.resultMode, verification: data.verificationStatus, web: data.usedWebSearch, usage: data.usage, titles: data.movies.slice(0, 8).map((movie) => movie.title) }));
}

console.log("AI-first live benchmark passed");
