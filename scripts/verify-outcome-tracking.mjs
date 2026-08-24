import assert from "node:assert/strict";
import { linkPickOutcome, recommendationEvent } from "../src/services/outcomeTracking.ts";

const movie = { id: 10, title: "Test Movie", year: "2024", posterPath: null, overview: "Test", genres: ["Drama"] };
const older = { id: "pick-old", movie, createdAt: 1, rank: 3, score: .7 };
const latest = { id: "pick-new", movie, createdAt: 2, rank: 1, score: .9 };
const watched = linkPickOutcome([older, latest], movie.id, { watchedAt: 100 });
assert.equal(watched[0].watchedAt, undefined);
assert.equal(watched[1].watchedAt, 100, "only the latest matching choice should receive the outcome");
const rated = linkPickOutcome(watched, movie.id, { rating: 4.5 });
assert.equal(rated[1].rating, 4.5);

const event = recommendationEvent("highRating", movie, .9, { rank: 1, pickId: "pick-new", rating: 4.5 });
assert.equal(event.movieId, movie.id);
assert.equal(event.rank, 1);
assert.equal(event.rating, 4.5);
assert.equal("prompt" in event, false, "free-form prompts must not be persisted in outcome telemetry");

console.log("Outcome tracking checks passed.");
