import assert from "node:assert/strict";
import { mergeGuestAndAccountState } from "../src/services/accountState.ts";

const movie = (id, title) => ({ id, title, year: "2020", posterPath: null, overview: "", genres: [] });
const event = (id, movieId, createdAt) => ({ id, type: "open", movieId, movieTitle: `Movie ${movieId}`, mode: "balanced", score: 1, createdAt });

const account = {
  version: 2,
  ratings: { "1": 2, "3": 4 },
  watchlist: { "1": movie(1, "One") },
  watched: {},
  interest: {},
  reviews: { "1": "older account review", "3": "remove me" },
  preferences: { genres: ["Drama"], directors: ["Account Director"], favoriteMovies: {} },
  recommendationEvents: [event("same", 1, 1)],
  letterboxdImportMeta: { lastImportedAt: 10, movieCount: 4, ratingCount: 3 },
  fieldUpdatedAt: { "rating:1": 10, "rating:3": 30, "review:1": 10, "review:3": 10 },
  stateUpdatedAt: 30,
};

const guest = {
  version: 2,
  ratings: { "1": 5, "2": 4, "3": 1 },
  watchlist: { "2": movie(2, "Two") },
  watched: { "2": { movie: movie(2, "Two"), watchedAt: 20 } },
  interest: { "2": { movie: movie(2, "Two"), value: "interested", updatedAt: 20 } },
  reviews: { "1": "newer guest review" },
  preferences: { genres: ["Comedy"], directors: ["Guest Director"], favoriteMovies: { "2": movie(2, "Two") } },
  recommendationEvents: [event("same", 1, 1), event("new", 2, 2)],
  letterboxdImportMeta: { lastImportedAt: 20, movieCount: 8, ratingCount: 7 },
  fieldUpdatedAt: { "rating:1": 20, "rating:2": 20, "rating:3": 20, "review:1": 20, "review:3": 40, preferences: 20 },
  stateUpdatedAt: 40,
};

const merged = mergeGuestAndAccountState(account, guest);
assert.equal(merged.ratings["1"], 5, "newer guest rating wins");
assert.equal(merged.ratings["3"], 4, "newer account rating wins");
assert.equal(merged.reviews["1"], "newer guest review", "newer review wins");
assert.equal("3" in merged.reviews, false, "newer deletion wins");
assert.deepEqual(Object.keys(merged.watchlist).sort(), ["1", "2"], "collection items are unioned");
assert.equal(merged.recommendationEvents.length, 2, "event IDs are deduplicated");
assert.deepEqual(new Set(merged.preferences.genres), new Set(["Drama", "Comedy"]));
assert.deepEqual(new Set(merged.preferences.directors), new Set(["Account Director", "Guest Director"]));
assert.equal(merged.preferences.favoriteMovies["2"].title, "Two");
assert.equal(merged.version, 4, "merged state advances to the current version");
assert.deepEqual(merged.letterboxdImportMeta, guest.letterboxdImportMeta, "newest import metadata wins");

const retried = mergeGuestAndAccountState(merged, guest);
assert.deepEqual(retried.ratings, merged.ratings, "retry does not duplicate or regress ratings");
assert.deepEqual(retried.recommendationEvents, merged.recommendationEvents, "retry remains event-idempotent");

const legacyAccount = { ...account, ratings: { "1": 4 }, fieldUpdatedAt: {}, stateUpdatedAt: 10 };
const legacyGuest = { ...guest, ratings: { "1": 2 }, fieldUpdatedAt: {}, stateUpdatedAt: 20 };
assert.equal(mergeGuestAndAccountState(legacyAccount, legacyGuest).ratings["1"], 4, "legacy conflicts preserve account data without invented timestamps");

const accountDeletion = { ...account, ratings: {}, fieldUpdatedAt: { "rating:3": 50 }, stateUpdatedAt: 50 };
const staleGuestValue = { ...guest, ratings: { "3": 1 }, fieldUpdatedAt: {}, stateUpdatedAt: 20 };
assert.equal("3" in mergeGuestAndAccountState(accountDeletion, staleGuestValue).ratings, false, "a newer account deletion is not revived by a legacy guest value");

console.log("account merge verification passed");
