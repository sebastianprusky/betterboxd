import assert from "node:assert/strict";
import { isBroadMoviePrompt, personNameRelevance, rankBroadCandidates } from "../src/services/candidateQuality.ts";
import { parseAskIntent } from "../src/services/promptIntent.ts";

const movie = (id, title, { popularity, voteCount, voteAverage }) => ({
  id, title, year: "2020", posterPath: null, overview: `${title} overview`, genres: ["Comedy"], popularity, voteCount, voteAverage,
});

const obscureExactTitle = movie(1, "Funny Movies", { popularity: 2, voteCount: 4, voteAverage: 7.9 });
const canonicalA = movie(2, "Bridesmaids", { popularity: 42, voteCount: 4500, voteAverage: 6.8 });
const canonicalB = movie(3, "Superbad", { popularity: 48, voteCount: 7200, voteAverage: 7.3 });
const canonicalC = movie(4, "The Hangover", { popularity: 53, voteCount: 17000, voteAverage: 7.3 });

assert.equal(isBroadMoviePrompt("funny movies"), true);
assert.equal(isBroadMoviePrompt("marvel movies 2020s", { yearFrom: 2020, yearTo: 2029, resultMode: "collection", namedEntityCount: 1 }), false);
assert.equal(isBroadMoviePrompt("underrated comedy movies"), false);
assert.equal(parseAskIntent("funny movies").genre, "Comedy", "objective genre language should constrain retrieval before ranking");

const ranked = rankBroadCandidates(
  [obscureExactTitle, canonicalA, canonicalB, canonicalC],
  { 1: 1, 2: .76, 3: .74, 4: .72 },
  "Comedy",
);
assert.equal(ranked.movies.some((candidate) => candidate.id === obscureExactTitle.id), false, "weak exact-title collisions should not displace credible broad results");
assert.ok(ranked.movies.slice(0, 3).every((candidate) => candidate.voteCount >= 250));

assert.ok(personNameRelevance("Greta Gerwig", "Greta Gerwig") > personNameRelevance("Greta Gerwig", "Greta Gerwig-Smith"));
assert.equal(personNameRelevance("jordan", "Jordan Peele"), personNameRelevance("jordan", "Michael B. Jordan"), "ambiguous token matches should let popularity decide");

console.log("Candidate quality checks passed.");
