import type { CollaborativeModel } from "./collaborative";
import type { InterestMap, LikedMap, Movie, OnboardingPreferences, PickIntentEvent, RatingMap, RatingPrediction, RatingPredictionPoint, TasteStrength, WatchedMap } from "../types";
import { baselinePredictions, nestedHeldOutPredictions, pairwiseOrderingAccuracy, spearmanCorrelation, trainRatingModelTournament, type RatingTrainingEntry } from "./personalRatingModel";

type RatedMovie = RatingTrainingEntry;

export type RatingCalibration = {
  points: RatingPredictionPoint[];
  status: "building" | "ready";
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
};

export function ratingToPercent(rating: number) {
  return clamp((rating - .5) / 4.5 * 100, 0, 100);
}

export function buildRatingCalibration(movies: Movie[], ratings: RatingMap, watched: WatchedMap, model: CollaborativeModel | null = null): RatingCalibration {
  const eligible = calibrationSample(ratedMovies(movies, ratings, watched));
  const heldOut = nestedHeldOutPredictions(eligible, model);
  const points = heldOut.map(({ entry, prediction }) => toPredictionPoint(entry, prediction));
  const errors = points.map((point) => point.absoluteError);
  const meanAbsoluteError = mean(errors);
  const errorStandardError = errors.length > 1 ? standardDeviation(errors) / Math.sqrt(errors.length) : 0;
  const conservativeError = meanAbsoluteError + 1.28 * errorStandardError;
  const baselineRows = eligible.map((target) => ({ target, ...baselinePredictions(target.movie, eligible.filter((entry) => entry.movie.id !== target.movie.id)) }));
  const userMeanBaselineErrors = baselineRows.map(({ target, userMean }) => Math.abs(userMean - target.rating));
  const tmdbBaselineErrors = baselineRows.map(({ target, tmdb }) => Math.abs(tmdb - target.rating));
  const userMeanBaselineError = mean(userMeanBaselineErrors);
  const tmdbBaselineError = mean(tmdbBaselineErrors);
  const predictionSpread = standardDeviation(points.map((point) => point.predictedRating));
  const actualRatingSpread = standardDeviation(points.map((point) => point.actualRating));
  const requiredPredictionSpread = actualRatingSpread * .35;
  const strongerBaseline = Math.min(userMeanBaselineError || Infinity, tmdbBaselineError || Infinity);
  const benchmarkImprovement = Number.isFinite(strongerBaseline) && strongerBaseline > 0 ? 1 - meanAbsoluteError / strongerBaseline : 0;
  const squaredErrors = points.map((point) => (point.predictedRating - point.actualRating) ** 2);
  const userMeanBaselineMse = mean(baselineRows.map(({ target, userMean }) => (userMean - target.rating) ** 2));
  const tmdbBaselineMse = mean(baselineRows.map(({ target, tmdb }) => (tmdb - target.rating) ** 2));
  const strongerBaselineMse = Math.min(userMeanBaselineMse || Infinity, tmdbBaselineMse || Infinity);
  const predictiveSkill = Number.isFinite(strongerBaselineMse) && strongerBaselineMse > 0 ? 1 - mean(squaredErrors) / strongerBaselineMse : 0;
  const rankCorrelation = spearmanCorrelation(points.map((point) => point.predictedRating), points.map((point) => point.actualRating));
  const pairwiseAccuracy = pairwiseOrderingAccuracy(points.map((point) => point.predictedRating), points.map((point) => point.actualRating));
  const conservativeRmse = Math.sqrt(mean(squaredErrors)) + 1.28 * errorStandardError;
  const conservativeSkill = Number.isFinite(strongerBaselineMse) && strongerBaselineMse > 0 ? 1 - conservativeRmse ** 2 / strongerBaselineMse : 0;
  const benchmarkPassed = points.length >= 8 && Number.isFinite(strongerBaseline) && benchmarkImprovement >= .05
    && predictiveSkill >= .05 && conservativeSkill > 0 && rankCorrelation >= .2 && pairwiseAccuracy >= .55
    && predictionSpread + .001 >= requiredPredictionSpread;
  const selected = trainRatingModelTournament(eligible, model);
  return {
    points,
    status: benchmarkPassed ? "ready" : "building",
    predictionScore: benchmarkPassed ? Math.round(100 * clamp(conservativeSkill, 0, 1)) : undefined,
    meanAbsoluteError: roundTwo(meanAbsoluteError),
    conservativeError: roundTwo(conservativeError),
    withinHalfStarRate: points.length ? Math.round(points.filter((point) => point.absoluteError <= .5).length / points.length * 100) : 0,
    userMeanBaselineError: roundTwo(userMeanBaselineError),
    tmdbBaselineError: roundTwo(tmdbBaselineError),
    predictionSpread: roundTwo(predictionSpread),
    actualRatingSpread: roundTwo(actualRatingSpread),
    requiredPredictionSpread: roundTwo(requiredPredictionSpread),
    benchmarkImprovement: roundTwo(benchmarkImprovement),
    calibrationApplied: false,
    benchmarkPassed,
    predictiveSkill: roundTwo(predictiveSkill),
    rankCorrelation: roundTwo(rankCorrelation),
    pairwiseAccuracy: roundTwo(pairwiseAccuracy),
    selectedModel: selected.label,
  };
}

export function predictCandidateRatings(movies: Movie[], ratings: RatingMap, watched: WatchedMap, model: CollaborativeModel | null) {
  const training = ratedMovies(movies, ratings, watched);
  const tournament = trainRatingModelTournament(calibrationSample(training), model);
  return new Map(movies.map((movie) => [movie.id, tournament.predict(movie)]));
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
    movie: target.movie,
    predictedRating: prediction.predictedRating,
    actualRating,
    absoluteError: roundOne(Math.abs(prediction.predictedRating - actualRating)),
    x: ratingToPercent(prediction.predictedRating),
    y: 100 - ratingToPercent(actualRating),
    confidence: prediction.confidence,
    neighborCount: prediction.neighborCount,
    source: prediction.source,
    calibrated: prediction.calibrated,
  };
}

function ratedMovies(movies: Movie[], ratings: RatingMap, watched: WatchedMap) {
  const byId = new Map(movies.map((movie) => [movie.id, movie]));
  return Object.entries(ratings).flatMap(([rawId, rating]) => { const id = Number(rawId); const watchedEntry = watched[id]; const movie = watchedEntry?.movie || byId.get(id); return movie && watchedEntry && rating > 0 ? [{ movie, rating, watchedAt: watchedEntry.watchedAt || 0 }] : []; });
}
function calibrationSample(entries: RatedMovie[], limit = 60) { return [...entries].sort((a, b) => b.watchedAt - a.watchedAt || a.movie.id - b.movie.id).slice(0, limit); }
function decade(year: string) { const parsed = Number(year); return Number.isFinite(parsed) && parsed > 1800 ? `${Math.floor(parsed / 10) * 10}s` : ""; }
function normalize(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function mean(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function standardDeviation(values: number[]) { const average = mean(values); return values.length ? Math.sqrt(mean(values.map((value) => (value - average) ** 2))) : 0; }
function clamp(value: number, minimum: number, maximum: number) { return Math.max(minimum, Math.min(maximum, value)); }
function clamp01(value: number) { return clamp(value, 0, 1); }
function roundOne(value: number) { return Math.round(value * 10) / 10; }
function roundTwo(value: number) { return Math.round(value * 100) / 100; }
