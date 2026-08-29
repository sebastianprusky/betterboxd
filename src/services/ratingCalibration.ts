import type { CollaborativeModel } from "./collaborative";
import type { InterestMap, Movie, OnboardingPreferences, PickIntentEvent, RatingMap, RatingPrediction, RatingPredictionPoint, TasteStrength, WatchedMap } from "../types";

type RatedMovie = { movie: Movie; rating: number };

export type RatingCalibration = {
  points: RatingPredictionPoint[];
  meanAbsoluteError: number;
  withinHalfStarRate: number;
  userMeanBaselineError: number;
  tmdbBaselineError: number;
  predictionSpread: number;
  benchmarkPassed: boolean;
};

export function buildRatingCalibration(movies: Movie[], ratings: RatingMap, watched: WatchedMap, model: CollaborativeModel | null = null): RatingCalibration {
  const eligible = ratedMovies(movies, ratings, watched);
  const points = eligible.map(({ movie, rating }) => {
    const prediction = predictRating(movie, eligible.filter((entry) => entry.movie.id !== movie.id), model);
    const actualRating = clamp(rating, .5, 5);
    return { movie, predictedRating: prediction.predictedRating, actualRating, absoluteError: roundOne(Math.abs(prediction.predictedRating - actualRating)), x: 7 + ((prediction.predictedRating - .5) / 4.5) * 86, y: 93 - ((actualRating - .5) / 4.5) * 86, confidence: prediction.confidence, neighborCount: prediction.neighborCount, source: prediction.source } satisfies RatingPredictionPoint;
  });
  const meanAbsoluteError = mean(points.map((point) => point.absoluteError));
  const userMeanBaselineError = mean(eligible.map((target) => Math.abs(bayesianUserMean(eligible.filter((entry) => entry.movie.id !== target.movie.id)) - target.rating)));
  const tmdbBaselineError = mean(eligible.map(({ movie, rating }) => Math.abs(tmdbStars(movie, 3.5) - rating)));
  const predictionSpread = standardDeviation(points.map((point) => point.predictedRating));
  const strongerBaseline = Math.min(userMeanBaselineError || Infinity, tmdbBaselineError || Infinity);
  return {
    points,
    meanAbsoluteError: roundTwo(meanAbsoluteError),
    withinHalfStarRate: points.length ? Math.round(points.filter((point) => point.absoluteError <= .5).length / points.length * 100) : 0,
    userMeanBaselineError: roundTwo(userMeanBaselineError),
    tmdbBaselineError: roundTwo(tmdbBaselineError),
    predictionSpread: roundTwo(predictionSpread),
    benchmarkPassed: points.length >= 8 && Number.isFinite(strongerBaseline) && meanAbsoluteError <= strongerBaseline * .95 && predictionSpread >= .25,
  };
}

export function predictCandidateRatings(movies: Movie[], ratings: RatingMap, watched: WatchedMap, model: CollaborativeModel | null) {
  const training = ratedMovies(movies, ratings, watched);
  return new Map(movies.map((movie) => [movie.id, predictRating(movie, training, model)]));
}

export function buildTasteStrength({ movies, ratings, watched, interest, preferences, picks, model }: { movies: Movie[]; ratings: RatingMap; watched: WatchedMap; interest: InterestMap; preferences: OnboardingPreferences; picks: PickIntentEvent[]; model: CollaborativeModel | null }): TasteStrength {
  const durableSignals = Object.keys(ratings).length * 2 + Object.keys(interest).length + Object.keys(preferences.favoriteMovies).length * 2 + preferences.genres.length + preferences.directors.length + preferences.actors.length;
  const signalScore = clamp01(durableSignals / 30) * 100;
  const positiveMovies = movies.filter((movie) => (ratings[movie.id] || 0) >= 3.5 || interest[movie.id]?.value === "interested" || preferences.favoriteMovies[movie.id]);
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

function predictRating(movie: Movie, training: RatedMovie[], model: CollaborativeModel | null): RatingPrediction {
  const userMean = bayesianUserMean(training);
  const targetItem = model?.items[movie.id];
  const itemMean = targetItem ? clamp(3.5 + targetItem.bias * 1.5, .5, 5) : tmdbStars(movie, userMean);
  const prior = userMean * .72 + itemMean * .28;
  const neighbors = training.map((peer) => {
    const peerItem = model?.items[peer.movie.id];
    const factorSimilarity = targetItem && peerItem ? positiveCosine(targetItem.factors, peerItem.factors) : 0;
    const content = contentSimilarity(movie, peer.movie);
    const similarity = factorSimilarity > .05 ? factorSimilarity * .78 + content * .22 : content * .82;
    const peerItemMean = peerItem ? clamp(3.5 + peerItem.bias * 1.5, .5, 5) : tmdbStars(peer.movie, userMean);
    return { similarity, residual: peer.rating - (userMean * .72 + peerItemMean * .28), hasFactor: Boolean(targetItem && peerItem) };
  }).filter((neighbor) => neighbor.similarity >= .12).sort((a, b) => b.similarity - a.similarity).slice(0, 10);
  const weightSum = neighbors.reduce((sum, neighbor) => sum + neighbor.similarity, 0);
  const residual = weightSum ? neighbors.reduce((sum, neighbor) => sum + neighbor.residual * neighbor.similarity, 0) / weightSum : 0;
  const factorNeighbors = neighbors.filter((neighbor) => neighbor.hasFactor).length;
  const coverage = training.length ? Math.min(1, neighbors.length / Math.min(8, training.length)) : 0;
  return { predictedRating: roundOne(clamp(prior + residual * (weightSum / (weightSum + 1.8)), .5, 5)), confidence: roundTwo(clamp01(coverage * .45 + Math.min(1, weightSum / 4) * .35 + (factorNeighbors ? .2 : targetItem ? .1 : 0))), neighborCount: neighbors.length, source: factorNeighbors ? "movielens" : neighbors.length ? "content" : "baseline" };
}

function ratedMovies(movies: Movie[], ratings: RatingMap, watched: WatchedMap) {
  const byId = new Map(movies.map((movie) => [movie.id, movie]));
  return Object.entries(ratings).flatMap(([rawId, rating]) => { const id = Number(rawId); const movie = watched[id]?.movie || byId.get(id); return movie && watched[id] && rating > 0 ? [{ movie, rating }] : []; });
}
function bayesianUserMean(entries: RatedMovie[]) { return (entries.reduce((sum, entry) => sum + entry.rating, 0) + 14) / (entries.length + 4); }
function contentSimilarity(a: Movie, b: Movie) { const genre = jaccard(a.genres.filter((value) => value !== "TV Movie"), b.genres.filter((value) => value !== "TV Movie")); const keywords = jaccard(a.keywords || [], b.keywords || []); const cast = jaccard(a.cast || [], b.cast || []); const director = a.director && b.director && normalize(a.director) === normalize(b.director) ? 1 : 0; const language = a.originalLanguage && a.originalLanguage === b.originalLanguage ? 1 : 0; const era = decade(a.year) && decade(a.year) === decade(b.year) ? 1 : 0; return clamp01(genre * .38 + keywords * .24 + director * .16 + cast * .1 + language * .05 + era * .07); }
function positiveCosine(a: number[], b: number[]) { const dot = a.reduce((sum, value, index) => sum + value * (b[index] || 0), 0); const magnitudeA = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0)); const magnitudeB = Math.sqrt(b.reduce((sum, value) => sum + value * value, 0)); return magnitudeA && magnitudeB ? Math.max(0, dot / (magnitudeA * magnitudeB)) : 0; }
function jaccard(a: string[], b: string[]) { const first = new Set(a.map(normalize)); const second = new Set(b.map(normalize)); if (!first.size || !second.size) return 0; const intersection = [...first].filter((value) => second.has(value)).length; return intersection / new Set([...first, ...second]).size; }
function tmdbStars(movie: Movie, fallback: number) { return movie.voteAverage && (movie.voteCount || 0) >= 20 ? clamp(movie.voteAverage / 2, .5, 5) : fallback; }
function decade(year: string) { const parsed = Number(year); return Number.isFinite(parsed) && parsed > 1800 ? `${Math.floor(parsed / 10) * 10}s` : ""; }
function normalize(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function mean(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function standardDeviation(values: number[]) { const average = mean(values); return values.length ? Math.sqrt(mean(values.map((value) => (value - average) ** 2))) : 0; }
function clamp(value: number, minimum: number, maximum: number) { return Math.max(minimum, Math.min(maximum, value)); }
function clamp01(value: number) { return clamp(value, 0, 1); }
function roundOne(value: number) { return Math.round(value * 10) / 10; }
function roundTwo(value: number) { return Math.round(value * 100) / 100; }
