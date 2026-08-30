import type { CollaborativeModel } from "./collaborative";
import type { InterestMap, LikedMap, Movie, OnboardingPreferences, PickIntentEvent, RatingMap, RatingPrediction, RatingPredictionPoint, TasteStrength, WatchedMap } from "../types";
import {
  baselinePredictions,
  pairwiseComparisonCount,
  pairwiseOrderingAccuracy,
  predictWithSnapshot,
  runRatingModelTournament,
  spearmanCorrelation,
  type PersonalModelSnapshot,
  type RatingTrainingEntry,
} from "./personalRatingModel";

type RatedMovie = RatingTrainingEntry;
export const RATING_GRAPH_POINT_LIMIT = 60;
export const RATING_CALIBRATION_SAMPLE_LIMIT = RATING_GRAPH_POINT_LIMIT;

export type PredictionReadiness = "building" | "low-confidence" | "ready";
export type PredictionEvaluation = {
  trainingCount: number;
  evaluationCount: number;
  comparisonCount: number;
  pairwiseBaseline: number;
  pairwiseConfidenceLow: number;
  pairwiseConfidenceHigh: number;
  rankingReady: boolean;
  starReady: boolean;
  modelVersion: string;
};

export type RatingCalibration = PredictionEvaluation & {
  points: RatingPredictionPoint[];
  status: PredictionReadiness;
  predictionScore?: number;
  meanAbsoluteError: number;
  conservativeError: number;
  withinHalfStarRate: number;
  userMeanBaselineError: number;
  tmdbBaselineError: number;
  predictionSpread: number;
  actualRatingSpread: number;
  requiredPredictionSpread: number;
  benchmarkImprovement: number;
  calibrationApplied: boolean;
  benchmarkPassed: boolean;
  predictiveSkill: number;
  rankCorrelation: number;
  pairwiseAccuracy: number;
  selectedModel: string;
  modelSnapshot?: PersonalModelSnapshot;
};

export function ratingToPercent(rating: number) { return clamp((rating - .5) / 4.5 * 100, 0, 100); }

export function buildRatingCalibration(movies: Movie[], ratings: RatingMap, watched: WatchedMap, model: CollaborativeModel | null = null): RatingCalibration {
  const eligible = ratedMovies(movies, ratings, watched);
  const distinctRatings = new Set(eligible.map((entry) => entry.rating)).size;
  const enoughData = eligible.length >= 8 && distinctRatings >= 2;
  const result = runRatingModelTournament(eligible, model);
  const heldOut = result.heldOut;
  const allPoints = heldOut.map(({ entry, prediction }) => toPredictionPoint(entry, prediction));
  const points = allPoints;
  const predicted = heldOut.map((row) => row.prediction.predictedRating);
  const actual = heldOut.map((row) => row.entry.rating);
  const errors = predicted.map((value, index) => Math.abs(value - actual[index]));
  const squaredErrors = predicted.map((value, index) => (value - actual[index]) ** 2);
  const meanAbsoluteError = mean(errors);
  const errorStandardError = errors.length > 1 ? standardDeviation(errors) / Math.sqrt(errors.length) : 0;
  const conservativeError = meanAbsoluteError + 1.28 * errorStandardError;

  const baselineRows = heldOut.map((row) => {
    const fallback = row.userMeanBaseline === undefined || row.tmdbBaseline === undefined
      ? baselinePredictions(row.entry.movie, eligible.filter((candidate) => candidate.movie.id !== row.entry.movie.id))
      : undefined;
    return { entry: row.entry, userMean: row.userMeanBaseline ?? fallback?.userMean ?? 3.5, tmdb: row.tmdbBaseline ?? fallback?.tmdb ?? 3.5 };
  });
  const userMeanPredictions = baselineRows.map((row) => row.userMean);
  const tmdbPredictions = baselineRows.map((row) => row.tmdb);
  const userMeanBaselineError = mean(baselineRows.map(({ entry, userMean }) => Math.abs(userMean - entry.rating)));
  const tmdbBaselineError = mean(baselineRows.map(({ entry, tmdb }) => Math.abs(tmdb - entry.rating)));
  const strongerStarBaseline = Math.min(userMeanBaselineError || Infinity, tmdbBaselineError || Infinity);
  const benchmarkImprovement = Number.isFinite(strongerStarBaseline) && strongerStarBaseline > 0 ? 1 - meanAbsoluteError / strongerStarBaseline : 0;

  const pairwiseAccuracy = pairwiseOrderingAccuracy(predicted, actual);
  const pairwiseBaseline = Math.max(pairwiseOrderingAccuracy(userMeanPredictions, actual), pairwiseOrderingAccuracy(tmdbPredictions, actual));
  const comparisonCount = pairwiseComparisonCount(actual);
  const effectiveComparisons = Math.max(1, Math.min(comparisonCount, heldOut.length * 5));
  const pairwiseStandardError = Math.sqrt(Math.max(.0001, pairwiseAccuracy * (1 - pairwiseAccuracy)) / effectiveComparisons);
  const pairwiseConfidenceLow = clamp(pairwiseAccuracy - 1.96 * pairwiseStandardError, 0, 1);
  const pairwiseConfidenceHigh = clamp(pairwiseAccuracy + 1.96 * pairwiseStandardError, 0, 1);
  const rankingReady = enoughData && pairwiseAccuracy >= .55 && pairwiseConfidenceLow > .5 && pairwiseAccuracy >= pairwiseBaseline + .03;
  const starReady = rankingReady && Number.isFinite(strongerStarBaseline) && strongerStarBaseline > 0 && meanAbsoluteError <= strongerStarBaseline * .95;
  const status: PredictionReadiness = !enoughData ? "building" : rankingReady ? "ready" : "low-confidence";
  const strongerBaselineMse = Math.min(
    mean(baselineRows.map(({ entry, userMean }) => (userMean - entry.rating) ** 2)) || Infinity,
    mean(baselineRows.map(({ entry, tmdb }) => (tmdb - entry.rating) ** 2)) || Infinity,
  );
  const predictiveSkill = Number.isFinite(strongerBaselineMse) && strongerBaselineMse > 0 ? 1 - mean(squaredErrors) / strongerBaselineMse : 0;
  const predictionSpread = standardDeviation(predicted);
  const actualRatingSpread = standardDeviation(actual);

  return {
    points,
    status,
    predictionScore: enoughData ? Math.round(pairwiseAccuracy * 100) : undefined,
    meanAbsoluteError: roundTwo(meanAbsoluteError),
    conservativeError: roundTwo(conservativeError),
    withinHalfStarRate: errors.length ? Math.round(errors.filter((error) => error <= .5).length / errors.length * 100) : 0,
    userMeanBaselineError: roundTwo(userMeanBaselineError),
    tmdbBaselineError: roundTwo(tmdbBaselineError),
    predictionSpread: roundTwo(predictionSpread),
    actualRatingSpread: roundTwo(actualRatingSpread),
    requiredPredictionSpread: roundTwo(actualRatingSpread * .35),
    benchmarkImprovement: roundTwo(benchmarkImprovement),
    calibrationApplied: result.tournament.kind.endsWith("ranker"),
    benchmarkPassed: rankingReady,
    predictiveSkill: roundTwo(predictiveSkill),
    rankCorrelation: roundTwo(spearmanCorrelation(predicted, actual)),
    pairwiseAccuracy: roundTwo(pairwiseAccuracy),
    selectedModel: result.tournament.label,
    modelSnapshot: result.tournament.snapshot,
    trainingCount: eligible.length,
    evaluationCount: heldOut.length,
    comparisonCount,
    pairwiseBaseline: roundTwo(pairwiseBaseline),
    pairwiseConfidenceLow: roundTwo(pairwiseConfidenceLow),
    pairwiseConfidenceHigh: roundTwo(pairwiseConfidenceHigh),
    rankingReady,
    starReady,
    modelVersion: result.tournament.snapshot.version,
  };
}

export function createRatingModelInput(ratings: RatingMap, watched: WatchedMap) {
  const entries = ratedMovies([], ratings, watched);
  return {
    movies: entries.map((entry) => entry.movie),
    ratings: Object.fromEntries(entries.map((entry) => [entry.movie.id, entry.rating])) as RatingMap,
    watched: Object.fromEntries(entries.map((entry) => [entry.movie.id, { movie: entry.movie, watchedAt: entry.watchedAt }])) as WatchedMap,
  };
}

/** Retained for compatibility; sampling is now graph-only, never model training. */
export function createRatingCalibrationSample(ratings: RatingMap, watched: WatchedMap, limit = RATING_GRAPH_POINT_LIMIT) {
  const input = createRatingModelInput(ratings, watched);
  const entries = sampleRatedEntries(ratedMovies(input.movies, input.ratings, input.watched), limit);
  return {
    movies: entries.map((entry) => entry.movie),
    ratings: Object.fromEntries(entries.map((entry) => [entry.movie.id, entry.rating])) as RatingMap,
    watched: Object.fromEntries(entries.map((entry) => [entry.movie.id, { movie: entry.movie, watchedAt: entry.watchedAt }])) as WatchedMap,
  };
}

export function predictCandidateRatings(movies: Movie[], ratings: RatingMap, watched: WatchedMap, model: CollaborativeModel | null, snapshot?: PersonalModelSnapshot) {
  const training = ratedMovies([], ratings, watched);
  const activeSnapshot = snapshot || runRatingModelTournament(training, model).tournament.snapshot;
  return new Map(movies.map((movie) => [movie.id, predictWithSnapshot(activeSnapshot, movie, model, training)]));
}

export function buildTasteStrength({ movies, ratings, likes, watched, interest, preferences, picks, model }: { movies: Movie[]; ratings: RatingMap; likes: LikedMap; watched: WatchedMap; interest: InterestMap; preferences: OnboardingPreferences; picks: PickIntentEvent[]; model: CollaborativeModel | null }): TasteStrength {
  const durableSignals = Object.keys(ratings).length * 2 + Object.keys(likes).length * 1.5 + Object.keys(interest).length + Object.keys(preferences.favoriteMovies).length * 2 + preferences.genres.length + preferences.directors.length + preferences.actors.length;
  const signalScore = clamp01(durableSignals / 30) * 100;
  const positiveMovies = movies.filter((movie) => (ratings[movie.id] || 0) >= 3.5 || likes[movie.id] || interest[movie.id]?.value === "interested" || preferences.favoriteMovies[movie.id]);
  const genres = new Set(positiveMovies.flatMap((movie) => movie.genres.filter((genre) => genre !== "TV Movie")));
  const eras = new Set(positiveMovies.map((movie) => decade(movie.year)).filter(Boolean));
  const coverageScore = clamp01((genres.size / 8) * .7 + (eras.size / 4) * .3) * 100;
  const rated = ratedMovies(movies, ratings, watched);
  const modelCoverageScore = rated.length ? rated.filter(({ movie }) => Boolean(model?.items[movie.id])).length / rated.length * 100 : 0;
  const outcomeScore = clamp01(picks.filter((pick) => pick.watchedAt || pick.rating !== undefined).length / 5) * 100;
  const score = Math.round(signalScore * .35 + coverageScore * .35 + modelCoverageScore * .2 + outcomeScore * .1);
  const nextStep = [{ value: signalScore, text: "Rate or react to a few more movies." }, { value: coverageScore, text: "Add ratings across another genre or decade." }, { value: modelCoverageScore, text: "Rate a few recognizable movies to strengthen predictions." }, { value: outcomeScore, text: "Tell us what you watched after making a pick." }].sort((a, b) => a.value - b.value)[0].text;
  return { score, signalScore: Math.round(signalScore), coverageScore: Math.round(coverageScore), modelCoverageScore: Math.round(modelCoverageScore), outcomeScore: Math.round(outcomeScore), nextStep };
}

function toPredictionPoint(target: RatedMovie, prediction: RatingPrediction): RatingPredictionPoint {
  const actualRating = clamp(target.rating, .5, 5);
  return {
    movie: target.movie, predictedRating: prediction.predictedRating, actualRating,
    absoluteError: roundOne(Math.abs(prediction.predictedRating - actualRating)),
    x: ratingToPercent(prediction.predictedRating), y: 100 - ratingToPercent(actualRating),
    confidence: prediction.starConfidence ?? prediction.confidence, neighborCount: prediction.neighborCount,
    source: prediction.source, calibrated: prediction.calibrated,
  };
}

function ratedMovies(movies: Movie[], ratings: RatingMap, watched: WatchedMap) {
  const byId = new Map(movies.map((movie) => [movie.id, movie]));
  return Object.entries(ratings).flatMap(([rawId, rating]) => {
    const id = Number(rawId); const watchedEntry = watched[id]; const movie = watchedEntry?.movie || byId.get(id);
    return movie && watchedEntry && rating > 0 ? [{ movie, rating, watchedAt: watchedEntry.watchedAt || 0 }] : [];
  });
}

function sampleRatedEntries(entries: RatedMovie[], limit: number) {
  if (entries.length <= limit) return [...entries].sort((a, b) => b.watchedAt - a.watchedAt || a.movie.id - b.movie.id);
  const buckets = new Map<number, RatedMovie[]>();
  entries.forEach((entry) => { const key = Math.round(entry.rating * 2); buckets.set(key, [...(buckets.get(key) || []), entry]); });
  buckets.forEach((bucket) => bucket.sort((left, right) => right.watchedAt - left.watchedAt || left.movie.id - right.movie.id));
  const keys = [...buckets.keys()].sort((left, right) => left - right); const sampled: RatedMovie[] = [];
  for (let row = 0; sampled.length < limit; row += 1) { let found = false; for (const key of keys) { const entry = buckets.get(key)?.[row]; if (!entry) continue; found = true; sampled.push(entry); if (sampled.length >= limit) break; } if (!found) break; }
  return sampled;
}

function decade(year: string) { const parsed = Number(year); return Number.isFinite(parsed) && parsed > 1800 ? `${Math.floor(parsed / 10) * 10}s` : ""; }
function mean(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function standardDeviation(values: number[]) { const average = mean(values); return values.length ? Math.sqrt(mean(values.map((value) => (value - average) ** 2))) : 0; }
function clamp(value: number, minimum: number, maximum: number) { return Math.max(minimum, Math.min(maximum, value)); }
function clamp01(value: number) { return clamp(value, 0, 1); }
function roundOne(value: number) { return Math.round(value * 10) / 10; }
function roundTwo(value: number) { return Math.round(value * 100) / 100; }
