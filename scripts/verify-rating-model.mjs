import assert from "node:assert/strict";
import { buildRatingCalibration, createRatingCalibrationSample, predictCandidateRatings, RATING_CALIBRATION_SAMPLE_LIMIT } from "../src/services/ratingCalibration.ts";
import { pairwiseOrderingAccuracy, spearmanCorrelation, trainRatingModelTournament } from "../src/services/personalRatingModel.ts";

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const factor = (x) => {
  const y = Math.sqrt(Math.max(0, 1 - x * x));
  return [x, y, ...Array(62).fill(0)];
};
const movie = (id, x, extra = {}) => ({
  id,
  title: `Movie ${id}`,
  year: String(1980 + id),
  posterPath: `/poster-${id}.jpg`,
  overview: "A deliberately varied benchmark movie.",
  genres: x >= 0 ? ["Drama"] : ["Comedy"],
  voteAverage: 7,
  voteCount: 2_000,
  popularity: 50,
  originalLanguage: "en",
  ...extra,
});

const entries = Array.from({ length: 30 }, (_, index) => {
  const x = -1 + index * (2 / 29);
  const item = movie(1_000 + index, x);
  return { movie: item, rating: Math.round(clamp(3.1 + x * 1.5, .5, 5) * 2) / 2, watchedAt: index + 1, x };
});
const model = {
  version: "synthetic-factor-benchmark",
  dimensions: 64,
  items: Object.fromEntries(entries.map(({ movie: item, x }) => [item.id, { tmdbId: item.id, factors: factor(x), bias: 0, support: 100, neighbors: [] }])),
};
const movies = entries.map((entry) => entry.movie);
const ratings = Object.fromEntries(entries.map((entry) => [entry.movie.id, entry.rating]));
const watched = Object.fromEntries(entries.map((entry) => [entry.movie.id, { movie: entry.movie, watchedAt: entry.watchedAt }]));

const calibration = buildRatingCalibration(movies, ratings, watched, model);
assert.equal(calibration.status, "ready", "a learnable polarized profile passes the held-out usefulness gate");
assert.ok(calibration.predictiveSkill > .35, "the score measures improvement over a simple average");
assert.ok(calibration.rankCorrelation > .8, "the model orders held-out ratings rather than clustering around the mean");
assert.ok(calibration.pairwiseAccuracy > .8);
assert.ok((calibration.predictionScore || 0) >= 35);
assert.match(calibration.selectedModel, /taste|factor|hybrid/i);
assert.deepEqual(buildRatingCalibration(movies, ratings, watched, model), calibration, "the tournament is deterministic");

const high = movie(9_001, .9);
const low = movie(9_002, -.9);
model.items[high.id] = { tmdbId: high.id, factors: factor(.9), bias: 0, support: 100, neighbors: [] };
model.items[low.id] = { tmdbId: low.id, factors: factor(-.9), bias: 0, support: 100, neighbors: [] };
const candidatePredictions = predictCandidateRatings([high, low], ratings, watched, model);
assert.ok(candidatePredictions.get(high.id).predictedRating - candidatePredictions.get(low.id).predictedRating >= 1.5, "the fitted taste vector meaningfully separates candidates");
assert.ok(candidatePredictions.get(high.id).confidence >= .65);

const target = calibration.points[0];
const changedTarget = buildRatingCalibration(movies, { ...ratings, [target.movie.id]: target.actualRating === 5 ? .5 : 5 }, watched, model).points.find((point) => point.movie.id === target.movie.id);
assert.equal(changedTarget.predictedRating, target.predictedRating, "the target rating cannot leak into its own held-out prediction");

const flatModel = {
  ...model,
  items: Object.fromEntries(entries.map(({ movie: item }) => [item.id, { tmdbId: item.id, factors: factor(0), bias: 0, support: 100, neighbors: [] }])),
};
const unstructuredRatings = Object.fromEntries(entries.map((entry, index) => [entry.movie.id, [1.5, 4.5, 2.5, 4, 3][index % 5]]));
const unstructured = buildRatingCalibration(movies, unstructuredRatings, watched, flatModel);
assert.equal(unstructured.status, "building", "an average-like model cannot appear ready without held-out ranking signal");
assert.equal(unstructured.predictionScore, undefined);
assert.ok(unstructured.rankCorrelation < .2);

const sparseRatings = Object.fromEntries(entries.slice(0, 5).map((entry) => [entry.movie.id, entry.rating]));
const sparseWatched = Object.fromEntries(entries.slice(0, 5).map((entry) => [entry.movie.id, { movie: entry.movie, watchedAt: entry.watchedAt }]));
assert.equal(buildRatingCalibration(movies, sparseRatings, sparseWatched, model).status, "building", "sparse profiles remain explicitly unfinished");

const narrowRatings = Object.fromEntries(entries.map((entry) => [entry.movie.id, 3.7 + entry.x * .18]));
const narrow = buildRatingCalibration(movies, narrowRatings, watched, model);
assert.ok(narrow.predictionSpread <= narrow.actualRatingSpread + .15, "naturally narrow profiles are not stretched for visual variety");

assert.equal(spearmanCorrelation([1, 2, 3], [1, 2, 3]), 1);
assert.equal(spearmanCorrelation([1, 2, 3], [3, 2, 1]), -1);
assert.equal(pairwiseOrderingAccuracy([1, 2, 3], [1, 2, 3]), 1);
assert.equal(trainRatingModelTournament(entries, model).label, trainRatingModelTournament(entries, model).label);

const largeEntries = Array.from({ length: 5_000 }, (_, index) => {
  const item = movie(20_000 + index, index % 2 ? .8 : -.8);
  return { movie: item, rating: .5 + index % 10 * .5, watchedAt: index + 1 };
});
const largeRatings = Object.fromEntries(largeEntries.map((entry) => [entry.movie.id, entry.rating]));
const largeWatched = Object.fromEntries(largeEntries.map((entry) => [entry.movie.id, { movie: entry.movie, watchedAt: entry.watchedAt }]));
const largeSample = createRatingCalibrationSample(largeRatings, largeWatched);
assert.equal(largeSample.movies.length, RATING_CALIBRATION_SAMPLE_LIMIT, "large profiles send only a bounded sample to the prediction worker");
assert.equal(new Set(Object.values(largeSample.ratings)).size, 10, "the graph sample preserves every used half-star rating level");
assert.equal(buildRatingCalibration(largeSample.movies, largeSample.ratings, largeSample.watched).points.length, RATING_CALIBRATION_SAMPLE_LIMIT, "large-profile graphs never render thousands of points");

console.log("Personal rating model tournament and honest score checks passed.");
