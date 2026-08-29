import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chooseNeutralSwap, createPickSlots, replacePickSlot } from "../src/services/pickSession.ts";
import { recommendMovies } from "../src/services/recommendations.ts";
import { matchesPickFilters } from "../src/services/pickFilters.ts";
import { rankTasteSprintCandidates } from "../src/services/tasteSprintSelector.ts";

const movie = (id, title, genres, extra = {}) => ({
  id, title, year: "2024", posterPath: `/p${id}.jpg`, overview: title, genres,
  voteAverage: 7.8, voteCount: 1200, popularity: 45, runtime: 105, ...extra,
});
const movies = [
  movie(1, "Funny One", ["Comedy"]),
  movie(2, "Funny Two", ["Comedy"]),
  movie(3, "Serious One", ["Drama"]),
  movie(4, "Scary One", ["Horror"]),
  movie(5, "Funny Three", ["Comedy"]),
];
const emptyPreferences = { genres: [], directors: [], actors: [], favoriteMovies: {} };
const baseArgs = { movies, ratings: {}, watchlist: {}, watched: {}, interest: {}, preferences: emptyPreferences, mode: "balanced" };

const cold = recommendMovies({ ...baseArgs, limit: 3 });
assert.equal(cold.length, 3, "no-prompt ranking returns a bounded shortlist");
assert.equal(cold.some((result) => /your (taste|ratings|reactions|selected)/i.test(result.reason)), false, "cold-start reasons do not invent personal evidence");
assert.equal(new Set(cold.map((result) => result.reason.replace(result.movie.title, "movie"))).size, 3, "cold-start cards use distinct factual explanation angles");

const personal = recommendMovies({ ...baseArgs, preferences: { ...emptyPreferences, genres: ["Comedy"] }, limit: 3 });
const personalComedy = personal.find((result) => result.movie.genres.includes("Comedy"));
assert.match(personalComedy?.reason || "", /comedy taste/i, "personal reasons cite the specific preference");
assert.match(personalComedy?.evidenceItems.find((item) => item.category === "personal")?.text || "", /selected Comedy preferences/i, "expanded evidence contains concrete support");

const prompted = recommendMovies({
  ...baseArgs,
  preferences: { ...emptyPreferences, genres: ["Comedy"] },
  promptScores: { 1: .95 },
  promptEvidence: { 1: { reason: "Matches the dry-comedy request", evidence: "Comedy metadata verified", matchedConstraints: ["Comedy"], fitScore: .95, confidence: .9 } },
  limit: 3,
});
const promptedComedy = prompted.find((result) => result.movie.id === 1);
assert.match(promptedComedy?.reason || "", /dry-comedy request/i, "the visible caption stays focused on the request");
assert.match(promptedComedy?.evidenceItems.find((item) => item.category === "personal")?.text || "", /selected Comedy preferences/i, "personal support appears separately without repeating the caption");
assert.doesNotMatch(promptedComedy?.evidence || "", /Matches the dry-comedy request/i, "expanded evidence does not repeat the caption");

const comedyFilters = { runtimeMin: 90, runtimeMax: 120, genres: ["Comedy"], eras: ["recent"], providerIds: [], includeTheaters: false, region: "US" };
assert.deepEqual(movies.filter((item) => matchesPickFilters(item, comedyFilters)).map((item) => item.id), [1, 2, 5], "no-prompt candidates honor shared filters");

const firstSwap = chooseNeutralSwap([1, 2, 3], [1, 2, 3, 4, 5], 2);
assert.deepEqual(firstSwap.visibleIds, [1, 4, 3], "a neutral swap replaces only the selected card");
const secondSwap = chooseNeutralSwap(firstSwap.visibleIds, [1, 2, 3, 4, 5], 4, [2]);
assert.deepEqual(secondSwap.visibleIds, [1, 5, 3], "swapped titles do not cycle back into the set");

const slots = createPickSlots(movies.slice(0, 3));
const replacedSlots = replacePickSlot(slots, 2, movies[4], (item) => item.id);
assert.deepEqual(replacedSlots.map((slot) => slot.value?.id), [1, 5, 3], "slot replacement never moves untouched movies");
const exhaustedSlots = replacePickSlot(replacedSlots, 5, null, (item) => item.id);
assert.deepEqual(exhaustedSlots.map((slot) => slot.value?.id || null), [1, null, 3], "an exhausted slot stays in place");

const sprintResults = [
  { movie: movie(20, "Certain Popular", ["Comedy"], { popularity: 90, voteCount: 8000 }), score: .9, reason: "", evidence: "", signals: [{ label: "Your taste", value: .91, detail: "" }] },
  { movie: movie(21, "Useful Boundary", ["Documentary"], { popularity: 55, voteCount: 2500 }), score: .55, reason: "", evidence: "", signals: [{ label: "Your taste", value: .51, detail: "" }] },
  { movie: movie(22, "Random Obscure", ["Comedy"], { popularity: 2, voteCount: 12 }), score: .5, reason: "", evidence: "", signals: [{ label: "Your taste", value: .5, detail: "" }] },
];
const sprintRanked = rankTasteSprintCandidates({ results: sprintResults, ratings: { 1: 5 }, interest: {}, preferences: { ...emptyPreferences, genres: ["Comedy"] }, reviewInsights: {} });
assert.equal(sprintRanked[0].movie.id, 21, "active learning balances uncertainty with useful coverage and answerability");
const popularityBaseline = [...sprintRanked].sort((a, b) => (b.movie.popularity || 0) - (a.movie.popularity || 0))[0];
const deterministicRandomBaseline = sprintRanked[sprintRanked.length - 1];
assert.ok(sprintRanked[0].utility > popularityBaseline.utility, "selector beats a popularity-only baseline on information utility");
assert.ok(sprintRanked[0].utility > deterministicRandomBaseline.utility, "selector beats a deterministic random baseline on information utility");

const [appSource, styles, types] = await Promise.all([
  readFile(new URL("src/App.tsx", `file://${process.cwd()}/`), "utf8"),
  readFile(new URL("src/styles.css", `file://${process.cwd()}/`), "utf8"),
  readFile(new URL("src/types.ts", `file://${process.cwd()}/`), "utf8"),
]);
assert.doesNotMatch(appSource, /Tonight’s shortlist|Three movies\. One decision\.|Start with your taste, add optional filters/);
assert.match(appSource, /Pick for me/);
assert.doesNotMatch(appSource, /Choose between two|Find my next movie/);
assert.match(appSource, /preferences, recommendationEvents: \[\], pickIntents:/, "cloud state still omits local recommendation events");
assert.doesNotMatch(appSource, /rank-label|className={`pick-card rank-/);
assert.match(appSource, /discoverPickMovies\(filters\)/);
assert.doesNotMatch(appSource, /tab === "taste" \? recommendMovies/);
assert.match(appSource, /new Image\(\)[\s\S]*posterUrl\(movie\.posterPath, "w500"\)/);
assert.match(appSource, /autoComplete="off"/);
assert.match(appSource, /startViewTransition/);
const onboardingSource = appSource.slice(appSource.indexOf("function OnboardingTour"), appSource.indexOf("function MiniHeader"));
assert.doesNotMatch(onboardingSource, /event\.key === "Escape"/);
assert.match(onboardingSource, /Skip for now/);
assert.match(onboardingSource, /Start picking/);
assert.doesNotMatch(appSource, /of 10 choices|choices left|onboarding-sprint-progress|sprint-progress/);
assert.match(styles, /\.movie-poster-image \{[^}]*object-fit: contain[^}]*background: transparent/);
assert.doesNotMatch(styles, /object-fit:\s*cover/);
assert.match(types, /\| "swap"/);

console.log("Decision ritual checks passed.");
