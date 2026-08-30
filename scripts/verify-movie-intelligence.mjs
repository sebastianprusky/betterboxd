import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { movieFeatures } from "../src/services/personalRatingModel.ts";

const movie = {
  id: 91,
  title: "A Movie",
  year: "2024",
  posterPath: "/poster.jpg",
  overview: "A public movie description.",
  genres: ["Drama"],
  voteAverage: 7.2,
  voteCount: 500,
  popularity: 40,
  modelEmbedding: [1, 0, 0, 0],
  modelEmbeddingModel: "test-embedding",
};
const changed = { ...movie, id: 92, modelEmbedding: [0, 1, 0, 0] };
const left = movieFeatures(movie, "content-ranker", null).values;
const right = movieFeatures(changed, "content-ranker", null).values;
assert.notDeepEqual(left.slice(64, 192), right.slice(64, 192), "semantic embeddings contribute to the on-device representation");

const endpoint = await readFile(resolve(process.cwd(), "api/movie-embeddings.ts"), "utf8");
assert.match(endpoint, /overview.*genres/s, "the embedding endpoint accepts public movie metadata");
assert.doesNotMatch(endpoint, /privateReview|RatingMap|WatchedMap|taste profile/i, "the embedding boundary contains no personal taste fields");
assert.match(endpoint, /maxMovies = 20/, "embedding requests remain bounded");
assert.match(endpoint, /rateLimitRequests/, "embedding spend is rate limited");

const canvas = await readFile(resolve(process.cwd(), "src/components/PredictionCanvas.tsx"), "utf8");
assert.match(canvas, /points\.forEach/, "the Canvas graph draws every held-out movie");
assert.doesNotMatch(canvas, /slice\(0,\s*60\)/, "the Canvas graph does not silently truncate large profiles");

console.log("Movie intelligence privacy, representation, and full-graph checks passed.");
