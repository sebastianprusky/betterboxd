import type { Movie, RatingPrediction } from "../types";
import type { CollaborativeModel } from "./collaborative";

export type RatingTrainingEntry = { movie: Movie; rating: number; watchedAt: number };
export type PersonalRatingModelKind = "average" | "tmdb" | "content-ranker" | "factor-ranker" | "hybrid-ranker";

export type MovieFeatureVector = { values: number[]; collaborative: boolean; contentCoverage: number };
export type StarCalibration = { anchors: Array<{ utility: number; rating: number; support: number }>; meanRating: number };
export type PersonalModelSnapshot = {
  version: "personal-ranking-v2";
  kind: PersonalRatingModelKind;
  label: string;
  weights: number[];
  calibration: StarCalibration;
  trainingCount: number;
  collaborativeCoverage: number;
  validationPairwiseAccuracy: number;
  validationMae: number;
  validationCorrelation: number;
};
export type HeldOutRatingPrediction = { entry: RatingTrainingEntry; prediction: RatingPrediction; selectedModel: PersonalRatingModelKind; userMeanBaseline?: number; tmdbBaseline?: number };
export type RatingModelTournament = {
  kind: PersonalRatingModelKind;
  label: string;
  validationMae: number;
  validationCorrelation: number;
  validationPairwiseAccuracy: number;
  snapshot: PersonalModelSnapshot;
  predict: (movie: Movie) => RatingPrediction;
};
export type RatingModelTournamentResult = { tournament: RatingModelTournament; heldOut: HeldOutRatingPrediction[] };

type EvaluatedSpec = { kind: PersonalRatingModelKind; heldOut: HeldOutRatingPrediction[]; mae: number; correlation: number; pairwiseAccuracy: number };
const FACTOR_DIMENSIONS = 64;
const CONTENT_DIMENSIONS = 96;
const NUMERIC_DIMENSIONS = 8;
const FEATURE_DIMENSIONS = FACTOR_DIMENSIONS + CONTENT_DIMENSIONS + NUMERIC_DIMENSIONS;
const MAX_TRAINING_PAIRS = 50_000;
const MODEL_LABELS: Record<PersonalRatingModelKind, string> = {
  average: "Your average rating",
  tmdb: "Audience ordering",
  "factor-ranker": "Personal factor ranker",
  "content-ranker": "Movie-trait ranker",
  "hybrid-ranker": "Hybrid preference ranker",
};
const RANKER_KINDS: PersonalRatingModelKind[] = ["content-ranker", "factor-ranker", "hybrid-ranker"];

export function runRatingModelTournament(entries: RatingTrainingEntry[], model: CollaborativeModel | null): RatingModelTournamentResult {
  const eligible = sanitizeEntries(entries);
  const kinds: PersonalRatingModelKind[] = ["average", "tmdb", ...RANKER_KINDS];
  const evaluated = kinds.map((kind) => evaluateKind(eligible, kind, model));
  const selected = [...evaluated].sort(compareEvaluations)[0];
  const snapshot = fitSnapshot(eligible, selected.kind, model, selected);
  const heldOut = nestedTournamentPredictions(eligible, model);
  return {
    tournament: {
      kind: selected.kind, label: MODEL_LABELS[selected.kind], validationMae: selected.mae,
      validationCorrelation: selected.correlation, validationPairwiseAccuracy: selected.pairwiseAccuracy,
      snapshot, predict: (movie) => predictWithSnapshot(snapshot, movie, model, eligible),
    },
    heldOut,
  };
}

export function nestedHeldOutPredictions(entries: RatingTrainingEntry[], model: CollaborativeModel | null) { return runRatingModelTournament(entries, model).heldOut; }
export function trainRatingModelTournament(entries: RatingTrainingEntry[], model: CollaborativeModel | null) { return runRatingModelTournament(entries, model).tournament; }

export function predictWithSnapshot(snapshot: PersonalModelSnapshot, movie: Movie, model: CollaborativeModel | null, training: RatingTrainingEntry[] = []): RatingPrediction {
  const feature = movieFeatures(movie, snapshot.kind, model);
  const utility = snapshot.kind === "average"
    ? snapshot.calibration.meanRating
    : snapshot.kind === "tmdb" ? tmdbStars(movie, snapshot.calibration.meanRating) : dot(snapshot.weights, feature.values);
  const predictedRating = snapshot.kind === "average" || snapshot.kind === "tmdb" ? utility : applyStarCalibration(snapshot.calibration, utility);
  const factorCoverage = feature.collaborative ? snapshot.collaborativeCoverage : 0;
  const usefulNeighbors = countUsefulNeighbors(movie, training, snapshot.kind, model);
  const rankingConfidence = snapshot.kind === "average" || snapshot.kind === "tmdb" ? .3
    : clamp01(.28 + Math.min(1, snapshot.trainingCount / 80) * .27 + Math.min(1, usefulNeighbors / 8) * .18 + factorCoverage * .17 + feature.contentCoverage * .1);
  const starReliability = clamp01(1 - snapshot.validationMae / 2);
  const starConfidence = clamp01(rankingConfidence * .75 + starReliability * .25);
  return {
    predictedRating: roundOne(clamp(predictedRating, .5, 5)), rankingScore: roundFive(clamp((predictedRating - .5) / 4.5, 0, 1)), rawPredictedRating: roundTwo(utility),
    calibrated: snapshot.kind !== "average" && snapshot.kind !== "tmdb", confidence: roundTwo(starConfidence),
    rankingConfidence: roundTwo(rankingConfidence), starConfidence: roundTwo(starConfidence), neighborCount: usefulNeighbors,
    source: snapshot.kind === "content-ranker" ? "content" : snapshot.kind === "average" || snapshot.kind === "tmdb" ? "baseline" : "movielens",
  };
}

export function baselinePredictions(movie: Movie, training: RatingTrainingEntry[]) { return { userMean: bayesianUserMean(training), tmdb: tmdbStars(movie, 3.5) }; }

function evaluateKind(entries: RatingTrainingEntry[], kind: PersonalRatingModelKind, model: CollaborativeModel | null): EvaluatedSpec {
  if (entries.length < 3) return { kind, heldOut: [], mae: Infinity, correlation: 0, pairwiseAccuracy: .5 };
  const heldOut: HeldOutRatingPrediction[] = [];
  validationFolds(entries).forEach(({ training, targets }) => {
    const snapshot = fitSnapshot(training, kind, model);
    targets.forEach((entry) => heldOut.push({ entry, prediction: predictWithSnapshot(snapshot, entry.movie, model, training), selectedModel: kind }));
  });
  const predicted = heldOut.map((row) => row.prediction.predictedRating);
  const actual = heldOut.map((row) => row.entry.rating);
  return {
    kind, heldOut: heldOut.sort((left, right) => left.entry.movie.id - right.entry.movie.id),
    mae: mean(predicted.map((value, index) => Math.abs(value - actual[index]))),
    correlation: spearmanCorrelation(predicted, actual), pairwiseAccuracy: pairwiseOrderingAccuracy(predicted, actual),
  };
}

function nestedTournamentPredictions(entries: RatingTrainingEntry[], model: CollaborativeModel | null) {
  const heldOut: HeldOutRatingPrediction[] = [];
  validationFolds(entries).forEach(({ training, targets }) => {
    const kind = selectKindFromTraining(training, model);
    const snapshot = fitSnapshot(training, kind, model);
    targets.forEach((entry) => {
      const baselines = baselinePredictions(entry.movie, training);
      heldOut.push({ entry, prediction: predictWithSnapshot(snapshot, entry.movie, model, training), selectedModel: kind, userMeanBaseline: baselines.userMean, tmdbBaseline: baselines.tmdb });
    });
  });
  return heldOut.sort((left, right) => left.entry.movie.id - right.entry.movie.id);
}

function selectKindFromTraining(entries: RatingTrainingEntry[], model: CollaborativeModel | null) {
  if (entries.length < 6) return "average" as PersonalRatingModelKind;
  const sample = balancedEntrySample(entries, Math.min(80, entries.length));
  const ordered = [...sample].sort((left, right) => left.rating - right.rating || left.movie.id - right.movie.id);
  const targets = ordered.filter((_, index) => index % 5 === 0);
  const training = ordered.filter((_, index) => index % 5 !== 0);
  const coverage = entries.filter((entry) => Boolean(model?.items[entry.movie.id])).length / entries.length;
  const kinds: PersonalRatingModelKind[] = coverage >= .08
    ? ["average", "tmdb", "content-ranker", "factor-ranker", "hybrid-ranker"]
    : ["average", "tmdb", "content-ranker"];
  return kinds.map((kind) => {
    const snapshot = fitSnapshot(training, kind, model);
    const predicted = targets.map((entry) => predictWithSnapshot(snapshot, entry.movie, model, training).predictedRating);
    const actual = targets.map((entry) => entry.rating);
    return { kind, heldOut: [], mae: mean(predicted.map((value, index) => Math.abs(value - actual[index]))), correlation: spearmanCorrelation(predicted, actual), pairwiseAccuracy: pairwiseOrderingAccuracy(predicted, actual) };
  }).sort(compareEvaluations)[0].kind;
}

function balancedEntrySample(entries: RatingTrainingEntry[], limit: number) {
  if (entries.length <= limit) return [...entries];
  const buckets = new Map<number, RatingTrainingEntry[]>();
  entries.forEach((entry) => { const key = Math.round(entry.rating * 2); buckets.set(key, [...(buckets.get(key) || []), entry]); });
  buckets.forEach((bucket) => bucket.sort((left, right) => left.movie.id - right.movie.id));
  const keys = [...buckets.keys()].sort((left, right) => left - right); const output: RatingTrainingEntry[] = [];
  for (let row = 0; output.length < limit; row += 1) { let found = false; for (const key of keys) { const entry = buckets.get(key)?.[row]; if (!entry) continue; found = true; output.push(entry); if (output.length >= limit) break; } if (!found) break; }
  return output;
}

function compareEvaluations(left: EvaluatedSpec, right: EvaluatedSpec) {
  return right.pairwiseAccuracy - left.pairwiseAccuracy || left.mae - right.mae
    || right.correlation - left.correlation || modelPriority(left.kind) - modelPriority(right.kind);
}
function modelPriority(kind: PersonalRatingModelKind) { return (["hybrid-ranker", "factor-ranker", "content-ranker", "tmdb", "average"] as PersonalRatingModelKind[]).indexOf(kind); }

function fitSnapshot(entries: RatingTrainingEntry[], kind: PersonalRatingModelKind, model: CollaborativeModel | null, evaluation?: EvaluatedSpec): PersonalModelSnapshot {
  const meanRating = bayesianUserMean(entries);
  const collaborativeCoverage = entries.length ? entries.filter((entry) => Boolean(model?.items[entry.movie.id])).length / entries.length : 0;
  if (kind === "average" || kind === "tmdb" || entries.length < 2) return {
    version: "personal-ranking-v2", kind, label: MODEL_LABELS[kind], weights: [], calibration: { anchors: [], meanRating },
    trainingCount: entries.length, collaborativeCoverage, validationPairwiseAccuracy: evaluation?.pairwiseAccuracy ?? .5,
    validationMae: evaluation?.mae ?? 0, validationCorrelation: evaluation?.correlation ?? 0,
  };
  const features = entries.map((entry) => movieFeatures(entry.movie, kind, model).values);
  const weights = trainPairwiseRanker(entries, features);
  const calibration = fitStarCalibration(features.map((feature) => dot(weights, feature)), entries.map((entry) => entry.rating), meanRating);
  return {
    version: "personal-ranking-v2", kind, label: MODEL_LABELS[kind], weights, calibration, trainingCount: entries.length,
    collaborativeCoverage, validationPairwiseAccuracy: evaluation?.pairwiseAccuracy ?? .5,
    validationMae: evaluation?.mae ?? 0, validationCorrelation: evaluation?.correlation ?? 0,
  };
}

function trainPairwiseRanker(entries: RatingTrainingEntry[], features: number[][]) {
  const weights = Array(FEATURE_DIMENSIONS).fill(0);
  const pairs = deterministicPairs(entries, MAX_TRAINING_PAIRS);
  if (!pairs.length) return weights;
  let step = 0;
  for (let epoch = 0; epoch < 5; epoch += 1) {
    const forward = epoch % 2 === 0;
    for (let offset = 0; offset < pairs.length; offset += 1) {
      const pair = pairs[forward ? offset : pairs.length - 1 - offset];
      const high = features[pair.high]; const low = features[pair.low];
      let score = 0;
      for (let index = 0; index < weights.length; index += 1) score += weights[index] * (high[index] - low[index]);
      const learningRate = .065 / Math.sqrt(1 + step / 8_000);
      const gradient = (1 - sigmoid(score)) * pair.weight;
      const shrinkage = 1 - learningRate * .00035;
      for (let index = 0; index < weights.length; index += 1) weights[index] = weights[index] * shrinkage + learningRate * gradient * (high[index] - low[index]);
      step += 1;
    }
  }
  const norm = Math.sqrt(dot(weights, weights));
  if (norm > 8) for (let index = 0; index < weights.length; index += 1) weights[index] *= 8 / norm;
  return weights.map(roundFive);
}

function deterministicPairs(entries: RatingTrainingEntry[], limit: number) {
  const pairs: Array<{ high: number; low: number; weight: number }> = [];
  if (entries.length < 2) return pairs;
  const perMovie = Math.max(4, Math.min(25, Math.floor(limit / entries.length)));
  const ordered = entries.map((entry, index) => ({ entry, index })).sort((a, b) => a.entry.movie.id - b.entry.movie.id);
  for (let position = 0; position < ordered.length && pairs.length < limit; position += 1) {
    const left = ordered[position]; let added = 0;
    for (let offset = 1; offset < ordered.length && added < perMovie && pairs.length < limit; offset += 1) {
      const right = ordered[(position + offset * 37) % ordered.length];
      const difference = left.entry.rating - right.entry.rating;
      if (Math.abs(difference) < .5) continue;
      pairs.push({ high: difference > 0 ? left.index : right.index, low: difference > 0 ? right.index : left.index, weight: Math.min(2, .75 + Math.abs(difference) * .35) });
      added += 1;
    }
  }
  return pairs;
}

function fitStarCalibration(utilities: number[], ratings: number[], meanRating: number): StarCalibration {
  if (!utilities.length) return { anchors: [], meanRating };
  const ordered = utilities.map((utility, index) => ({ utility, rating: ratings[index], support: 1 })).sort((left, right) => left.utility - right.utility || left.rating - right.rating);
  const targetBins = Math.max(4, Math.min(18, Math.round(Math.sqrt(ordered.length))));
  const binSize = Math.max(1, Math.ceil(ordered.length / targetBins));
  const blocks: Array<{ utility: number; rating: number; support: number }> = [];
  for (let start = 0; start < ordered.length; start += binSize) {
    const rows = ordered.slice(start, start + binSize);
    blocks.push({ utility: mean(rows.map((row) => row.utility)), rating: mean(rows.map((row) => row.rating)), support: rows.length });
  }
  for (let index = 0; index < blocks.length - 1;) {
    if (blocks[index].rating <= blocks[index + 1].rating) { index += 1; continue; }
    const left = blocks[index]; const right = blocks[index + 1]; const support = left.support + right.support;
    blocks.splice(index, 2, { utility: (left.utility * left.support + right.utility * right.support) / support, rating: (left.rating * left.support + right.rating * right.support) / support, support });
    if (index > 0) index -= 1;
  }
  const shrinkage = Math.min(.92, ordered.length / (ordered.length + 18));
  return { anchors: blocks.map((block) => ({ utility: roundFive(block.utility), rating: roundFive(meanRating + (block.rating - meanRating) * shrinkage), support: block.support })), meanRating };
}

function applyStarCalibration(calibration: StarCalibration, utility: number) {
  const anchors = calibration.anchors;
  if (!anchors.length) return calibration.meanRating;
  if (utility <= anchors[0].utility) return anchors[0].rating;
  if (utility >= anchors[anchors.length - 1].utility) return anchors[anchors.length - 1].rating;
  for (let index = 1; index < anchors.length; index += 1) {
    const right = anchors[index]; if (utility > right.utility) continue;
    const left = anchors[index - 1]; const range = right.utility - left.utility;
    return left.rating + (right.rating - left.rating) * (range ? (utility - left.utility) / range : 0);
  }
  return calibration.meanRating;
}

function validationFolds(entries: RatingTrainingEntry[]) {
  const orderedByTime = [...entries].sort((left, right) => left.watchedAt - right.watchedAt || left.movie.id - right.movie.id);
  const uniqueTimes = new Set(orderedByTime.map((entry) => entry.watchedAt).filter(Boolean));
  const timeRange = (orderedByTime[orderedByTime.length - 1]?.watchedAt || 0) - (orderedByTime[0]?.watchedAt || 0);
  if (entries.length >= 20 && uniqueTimes.size >= Math.max(8, entries.length * .35) && timeRange >= 30 * 24 * 60 * 60 * 1_000) {
    const targetCount = Math.max(4, Math.ceil(entries.length * .2));
    return [{ training: orderedByTime.slice(0, -targetCount), targets: orderedByTime.slice(-targetCount) }];
  }
  const foldCount = Math.min(5, Math.max(2, Math.floor(entries.length / 4)));
  const byIdentity = [...entries].sort((left, right) => left.movie.id - right.movie.id);
  return Array.from({ length: foldCount }, (_, fold) => ({ training: byIdentity.filter((_, index) => index % foldCount !== fold), targets: byIdentity.filter((_, index) => index % foldCount === fold) })).filter((part) => part.training.length && part.targets.length);
}

export function movieFeatures(movie: Movie, kind: PersonalRatingModelKind, model: CollaborativeModel | null): MovieFeatureVector {
  const values = Array(FEATURE_DIMENSIONS).fill(0); const item = model?.items[movie.id];
  const useFactors = kind === "factor-ranker" || kind === "hybrid-ranker"; const useContent = kind === "content-ranker" || kind === "hybrid-ranker";
  if (useFactors && item) item.factors.slice(0, FACTOR_DIMENSIONS).forEach((value, index) => { values[index] = value; });
  let contentSignals = 0;
  if (useContent) {
    const add = (prefix: string, raw: string, weight: number) => {
      const normalized = normalize(raw); if (!normalized) return;
      const hash = stableHash(`${prefix}:${normalized}`); const index = FACTOR_DIMENSIONS + hash % CONTENT_DIMENSIONS;
      values[index] += (hash & 1 ? 1 : -1) * weight; contentSignals += 1;
    };
    movie.genres.filter((genre) => genre !== "TV Movie").forEach((value) => add("genre", value, .52));
    (movie.keywords || []).slice(0, 16).forEach((value) => add("keyword", value, .22));
    (movie.cast || []).slice(0, 8).forEach((value) => add("cast", value, .13));
    if (movie.director) add("director", movie.director, .3);
    if (movie.originalLanguage) add("language", movie.originalLanguage, .14);
    const year = Number(movie.year); if (Number.isFinite(year)) add("era", `${Math.floor(year / 10) * 10}s`, .2);
  }
  const numeric = FACTOR_DIMENSIONS + CONTENT_DIMENSIONS;
  values[numeric] = clamp(((movie.voteAverage || 7) / 2 - 3.5) / 1.5, -1.5, 1.5);
  values[numeric + 1] = clamp(Math.log10(1 + (movie.voteCount || 0)) / 5, 0, 1);
  values[numeric + 2] = clamp(Math.log10(1 + (movie.popularity || 0)) / 4, 0, 1);
  values[numeric + 3] = clamp((Number(movie.year) - 2000) / 60 || 0, -1.5, 1.5);
  values[numeric + 4] = clamp(((movie.runtime || 120) - 120) / 100, -1, 1);
  values[numeric + 5] = item?.bias || 0; values[numeric + 6] = item ? 1 : 0; values[numeric + 7] = clamp(contentSignals / 20, 0, 1);
  return { values, collaborative: Boolean(item), contentCoverage: clamp(contentSignals / 12, 0, 1) };
}

function countUsefulNeighbors(movie: Movie, entries: RatingTrainingEntry[], kind: PersonalRatingModelKind, model: CollaborativeModel | null) {
  if (!entries.length || kind === "average" || kind === "tmdb") return 0;
  const target = movieFeatures(movie, kind, model).values; let count = 0;
  for (const entry of entries) { if (cosine(target, movieFeatures(entry.movie, kind, model).values) >= .18) count += 1; if (count >= 12) break; }
  return count;
}

function sanitizeEntries(entries: RatingTrainingEntry[]) {
  const seen = new Set<number>();
  return entries.filter((entry) => { if (seen.has(entry.movie.id) || !Number.isFinite(entry.rating) || entry.rating < .5 || entry.rating > 5) return false; seen.add(entry.movie.id); return true; });
}

export function spearmanCorrelation(predicted: number[], actual: number[]) {
  if (predicted.length < 2 || predicted.length !== actual.length) return 0;
  const left = ranks(predicted); const right = ranks(actual); const leftMean = mean(left); const rightMean = mean(right);
  const numerator = left.reduce((sum, value, index) => sum + (value - leftMean) * (right[index] - rightMean), 0);
  const denominator = Math.sqrt(left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0) * right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0));
  return denominator ? numerator / denominator : 0;
}

export function pairwiseOrderingAccuracy(predicted: number[], actual: number[], limit = 100_000) {
  if (predicted.length < 2 || predicted.length !== actual.length) return .5;
  let correct = 0; let total = 0; const perMovie = Math.max(4, Math.min(50, Math.floor(limit / predicted.length)));
  for (let left = 0; left < actual.length && total < limit; left += 1) {
    let compared = 0;
    for (let offset = 1; offset < actual.length && compared < perMovie && total < limit; offset += 1) {
      const right = (left + offset * 37) % actual.length; const actualDifference = actual[left] - actual[right];
      if (Math.abs(actualDifference) < .5) continue;
      const predictedDifference = predicted[left] - predicted[right];
      correct += Math.abs(predictedDifference) < 1e-8 ? .5 : Math.sign(predictedDifference) === Math.sign(actualDifference) ? 1 : 0;
      total += 1; compared += 1;
    }
  }
  return total ? correct / total : .5;
}

export function pairwiseComparisonCount(actual: number[], limit = 100_000) {
  if (actual.length < 2) return 0;
  let total = 0; const perMovie = Math.max(4, Math.min(50, Math.floor(limit / actual.length)));
  for (let left = 0; left < actual.length && total < limit; left += 1) {
    let compared = 0;
    for (let offset = 1; offset < actual.length && compared < perMovie && total < limit; offset += 1) {
      const right = (left + offset * 37) % actual.length; if (Math.abs(actual[left] - actual[right]) < .5) continue;
      total += 1; compared += 1;
    }
  }
  return total;
}

function ranks(values: number[]) {
  const ordered = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value || a.index - b.index); const output = Array(values.length).fill(0);
  for (let start = 0; start < ordered.length;) { let end = start + 1; while (end < ordered.length && ordered[end].value === ordered[start].value) end += 1; const rank = (start + end - 1) / 2 + 1; for (let index = start; index < end; index += 1) output[ordered[index].index] = rank; start = end; }
  return output;
}

function bayesianUserMean(entries: RatingTrainingEntry[]) { return (entries.reduce((sum, entry) => sum + entry.rating, 0) + 14) / (entries.length + 4); }
function tmdbStars(movie: Movie, fallback: number) { return movie.voteAverage && (movie.voteCount || 0) >= 20 ? clamp(movie.voteAverage / 2, .5, 5) : fallback; }
function dot(left: number[], right: number[]) { let sum = 0; const length = Math.min(left.length, right.length); for (let index = 0; index < length; index += 1) sum += left[index] * right[index]; return sum; }
function cosine(left: number[], right: number[]) { const product = dot(left, right); const denominator = Math.sqrt(dot(left, left) * dot(right, right)); return denominator ? product / denominator : 0; }
function sigmoid(value: number) { if (value > 20) return 1; if (value < -20) return 0; return 1 / (1 + Math.exp(-value)); }
function stableHash(value: string) { let hash = 2166136261; for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); } return hash >>> 0; }
function normalize(value: string) { return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }
function mean(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function clamp(value: number, minimum: number, maximum: number) { return Math.max(minimum, Math.min(maximum, value)); }
function clamp01(value: number) { return clamp(value, 0, 1); }
function roundOne(value: number) { return Math.round(value * 10) / 10; }
function roundTwo(value: number) { return Math.round(value * 100) / 100; }
function roundFive(value: number) { return Math.round(value * 100_000) / 100_000; }
