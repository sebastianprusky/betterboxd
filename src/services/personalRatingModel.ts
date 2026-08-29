import type { Movie, RatingPrediction } from "../types";
import type { CollaborativeModel } from "./collaborative";

export type RatingTrainingEntry = { movie: Movie; rating: number; watchedAt: number };
export type PersonalRatingModelKind = "average" | "tmdb" | "factor-ridge" | "content-ridge" | "hybrid-ridge";

type ModelSpec = { kind: PersonalRatingModelKind; lambda: number };
type FittedModel = { spec: ModelSpec; entries: RatingTrainingEntry[]; alpha: number[]; mean: number };
type EvaluatedSpec = { spec: ModelSpec; mae: number; rmse: number; correlation: number; pairwiseAccuracy: number };

export type RatingModelTournament = {
  kind: PersonalRatingModelKind;
  label: string;
  validationMae: number;
  validationCorrelation: number;
  validationPairwiseAccuracy: number;
  predict: (movie: Movie) => RatingPrediction;
};

export type HeldOutRatingPrediction = {
  entry: RatingTrainingEntry;
  prediction: RatingPrediction;
  selectedModel: PersonalRatingModelKind;
};

const RIDGE_LAMBDAS = [.35, 1.25, 4.5];
const contentFeatureCache = new WeakMap<Movie, Map<string, number>>();
const MODEL_LABELS: Record<PersonalRatingModelKind, string> = {
  average: "Your average rating",
  tmdb: "Audience-adjusted baseline",
  "factor-ridge": "Personal taste factors",
  "content-ridge": "Movie-trait model",
  "hybrid-ridge": "Hybrid taste model",
};

export function nestedHeldOutPredictions(entries: RatingTrainingEntry[], model: CollaborativeModel | null): HeldOutRatingPrediction[] {
  if (!entries.length) return [];
  const foldCount = Math.min(5, Math.max(2, Math.floor(entries.length / 2)));
  const ordered = [...entries].sort((a, b) => a.movie.id - b.movie.id);
  const output: HeldOutRatingPrediction[] = [];
  for (let fold = 0; fold < foldCount; fold += 1) {
    const training = ordered.filter((_, index) => index % foldCount !== fold);
    const targets = ordered.filter((_, index) => index % foldCount === fold);
    const selected = selectSpec(training, model);
    const fitted = fitModel(training, selected.spec, model);
    targets.forEach((entry) => output.push({ entry, prediction: predictFromFitted(fitted, entry.movie, model), selectedModel: selected.spec.kind }));
  }
  return output.sort((a, b) => a.entry.movie.id - b.entry.movie.id);
}

export function trainRatingModelTournament(entries: RatingTrainingEntry[], model: CollaborativeModel | null): RatingModelTournament {
  const selected = selectSpec(entries, model);
  const fitted = fitModel(entries, selected.spec, model);
  return {
    kind: selected.spec.kind,
    label: MODEL_LABELS[selected.spec.kind],
    validationMae: selected.mae,
    validationCorrelation: selected.correlation,
    validationPairwiseAccuracy: selected.pairwiseAccuracy,
    predict: (movie) => predictFromFitted(fitted, movie, model),
  };
}

export function baselinePredictions(movie: Movie, training: RatingTrainingEntry[]) {
  return { userMean: bayesianUserMean(training), tmdb: tmdbStars(movie, 3.5) };
}

function selectSpec(entries: RatingTrainingEntry[], model: CollaborativeModel | null): EvaluatedSpec {
  const specs: ModelSpec[] = [
    { kind: "average", lambda: 0 },
    { kind: "tmdb", lambda: 0 },
    ...RIDGE_LAMBDAS.flatMap((lambda): ModelSpec[] => [
      { kind: "factor-ridge", lambda },
      { kind: "content-ridge", lambda },
      { kind: "hybrid-ridge", lambda },
    ]),
  ];
  const evaluated = specs.map((spec) => evaluateSpec(entries, spec, model));
  return evaluated.sort((left, right) => selectionLoss(left) - selectionLoss(right)
    || left.mae - right.mae
    || right.correlation - left.correlation
    || specs.indexOf(left.spec) - specs.indexOf(right.spec))[0];
}

function selectionLoss(result: EvaluatedSpec) {
  const correlationPenalty = Math.max(0, .2 - result.correlation) * .2;
  const orderingPenalty = Math.max(0, .55 - result.pairwiseAccuracy) * .12;
  return result.mae + correlationPenalty + orderingPenalty;
}

function evaluateSpec(entries: RatingTrainingEntry[], spec: ModelSpec, model: CollaborativeModel | null): EvaluatedSpec {
  if (entries.length < 3) return { spec, mae: Infinity, rmse: Infinity, correlation: 0, pairwiseAccuracy: .5 };
  const foldCount = Math.min(5, Math.max(2, Math.floor(entries.length / 2)));
  const ordered = [...entries].sort((a, b) => a.movie.id - b.movie.id);
  const predicted: number[] = [];
  const actual: number[] = [];
  for (let fold = 0; fold < foldCount; fold += 1) {
    const training = ordered.filter((_, index) => index % foldCount !== fold);
    const targets = ordered.filter((_, index) => index % foldCount === fold);
    const fitted = fitModel(training, spec, model);
    targets.forEach((target) => {
      predicted.push(predictValue(fitted, target.movie, model));
      actual.push(target.rating);
    });
  }
  const errors = predicted.map((value, index) => value - actual[index]);
  return {
    spec,
    mae: mean(errors.map(Math.abs)),
    rmse: Math.sqrt(mean(errors.map((error) => error ** 2))),
    correlation: spearmanCorrelation(predicted, actual),
    pairwiseAccuracy: pairwiseOrderingAccuracy(predicted, actual),
  };
}

function fitModel(entries: RatingTrainingEntry[], spec: ModelSpec, model: CollaborativeModel | null): FittedModel {
  const meanRating = bayesianUserMean(entries);
  if (spec.kind === "average" || spec.kind === "tmdb" || !entries.length) return { spec, entries, alpha: [], mean: meanRating };
  const matrix = entries.map((left) => entries.map((right) => kernel(left.movie, right.movie, spec.kind, model)));
  matrix.forEach((row, index) => { row[index] += spec.lambda; });
  const residuals = entries.map((entry) => entry.rating - ratingPrior(entry.movie, meanRating, model));
  const alpha = solveLinearSystem(matrix, residuals) || [];
  return { spec, entries, alpha, mean: meanRating };
}

function predictFromFitted(fitted: FittedModel, movie: Movie, model: CollaborativeModel | null): RatingPrediction {
  const value = roundOne(predictValue(fitted, movie, model));
  const similarities = fitted.entries.map((entry) => Math.abs(kernel(entry.movie, movie, fitted.spec.kind, model)));
  const usefulNeighbors = similarities.filter((similarity) => similarity >= .08).length;
  const factorCoverage = model?.items[movie.id] ? fitted.entries.filter((entry) => model.items[entry.movie.id]).length / Math.max(1, fitted.entries.length) : 0;
  const contentCoverage = contentFeatures(movie).size ? 1 : 0;
  const modelCoverage = fitted.spec.kind === "factor-ridge" ? factorCoverage : fitted.spec.kind === "content-ridge" ? contentCoverage : Math.max(factorCoverage, contentCoverage);
  const confidence = fitted.spec.kind === "average" || fitted.spec.kind === "tmdb"
    ? .3
    : clamp01(.28 + Math.min(1, fitted.entries.length / 35) * .32 + Math.min(1, usefulNeighbors / 8) * .22 + modelCoverage * .18);
  return {
    predictedRating: value,
    confidence: roundTwo(confidence),
    neighborCount: usefulNeighbors,
    source: fitted.spec.kind === "content-ridge" ? "content" : fitted.spec.kind === "average" || fitted.spec.kind === "tmdb" ? "baseline" : "movielens",
  };
}

function predictValue(fitted: FittedModel, movie: Movie, model: CollaborativeModel | null) {
  if (fitted.spec.kind === "average") return fitted.mean;
  if (fitted.spec.kind === "tmdb") return tmdbStars(movie, fitted.mean);
  if (!fitted.alpha.length) return ratingPrior(movie, fitted.mean, model);
  const adjustment = fitted.entries.reduce((sum, entry, index) => sum + fitted.alpha[index] * kernel(entry.movie, movie, fitted.spec.kind, model), 0);
  return clamp(ratingPrior(movie, fitted.mean, model) + adjustment, .5, 5);
}

function ratingPrior(movie: Movie, userMean: number, model: CollaborativeModel | null) {
  const item = model?.items[movie.id];
  if (item) {
    const supportWeight = item.support / (item.support + 25);
    return clamp(userMean + item.bias * 1.5 * supportWeight * .45, .5, 5);
  }
  const audience = tmdbStars(movie, 3.5) - 3.5;
  const audienceWeight = Math.min(1, Math.log10(1 + (movie.voteCount || 0)) / 4);
  return clamp(userMean + audience * audienceWeight * .3, .5, 5);
}

function kernel(left: Movie, right: Movie, kind: PersonalRatingModelKind, model: CollaborativeModel | null) {
  if (kind === "average" || kind === "tmdb") return 0;
  const factor = factorKernel(left, right, model);
  const content = sparseDot(contentFeatures(left), contentFeatures(right));
  if (kind === "factor-ridge") return factor;
  if (kind === "content-ridge") return content;
  if (!factor) return content * .65;
  return factor * .72 + content * .28;
}

function factorKernel(left: Movie, right: Movie, model: CollaborativeModel | null) {
  const a = model?.items[left.id]?.factors;
  const b = model?.items[right.id]?.factors;
  if (!a || !b) return 0;
  return a.reduce((sum, value, index) => sum + value * (b[index] || 0), 0);
}

function contentFeatures(movie: Movie) {
  const cached = contentFeatureCache.get(movie);
  if (cached) return cached;
  const features = new Map<string, number>();
  addGroup(features, "genre", movie.genres.filter((genre) => genre !== "TV Movie"), .34);
  addGroup(features, "keyword", movie.keywords || [], .24);
  addGroup(features, "cast", (movie.cast || []).slice(0, 8), .1);
  addGroup(features, "director", movie.director ? [movie.director] : [], .14);
  addGroup(features, "language", movie.originalLanguage ? [movie.originalLanguage] : [], .06);
  const year = Number(movie.year);
  addGroup(features, "era", Number.isFinite(year) ? [`${Math.floor(year / 10) * 10}s`] : [], .08);
  addGroup(features, "runtime", movie.runtime ? [movie.runtime < 95 ? "short" : movie.runtime > 145 ? "long" : "standard"] : [], .04);
  contentFeatureCache.set(movie, features);
  return features;
}

function addGroup(features: Map<string, number>, prefix: string, values: string[], weight: number) {
  const normalized = [...new Set(values.map(normalize).filter(Boolean))];
  if (!normalized.length) return;
  const valueWeight = Math.sqrt(weight / normalized.length);
  normalized.forEach((value) => features.set(`${prefix}:${value}`, valueWeight));
}

function sparseDot(left: Map<string, number>, right: Map<string, number>) {
  let sum = 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  small.forEach((value, key) => { sum += value * (large.get(key) || 0); });
  return sum;
}

function solveLinearSystem(matrix: number[][], values: number[]) {
  const size = values.length;
  const augmented = matrix.map((row, index) => [...row, values[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    if (Math.abs(augmented[pivot][column]) < 1e-8) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let index = column; index <= size; index += 1) augmented[column][index] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const multiplier = augmented[row][column];
      if (!multiplier) continue;
      for (let index = column; index <= size; index += 1) augmented[row][index] -= multiplier * augmented[column][index];
    }
  }
  return augmented.map((row) => row[size]);
}

export function spearmanCorrelation(predicted: number[], actual: number[]) {
  if (predicted.length < 2 || predicted.length !== actual.length) return 0;
  const left = ranks(predicted);
  const right = ranks(actual);
  const leftMean = mean(left);
  const rightMean = mean(right);
  const numerator = left.reduce((sum, value, index) => sum + (value - leftMean) * (right[index] - rightMean), 0);
  const denominator = Math.sqrt(left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0) * right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0));
  return denominator ? numerator / denominator : 0;
}

export function pairwiseOrderingAccuracy(predicted: number[], actual: number[]) {
  let correct = 0;
  let total = 0;
  for (let left = 0; left < actual.length; left += 1) {
    for (let right = left + 1; right < actual.length; right += 1) {
      if (Math.abs(actual[left] - actual[right]) < .5) continue;
      total += 1;
      const predictedDifference = predicted[left] - predicted[right];
      const actualDifference = actual[left] - actual[right];
      correct += predictedDifference === 0 ? .5 : Math.sign(predictedDifference) === Math.sign(actualDifference) ? 1 : 0;
    }
  }
  return total ? correct / total : .5;
}

function ranks(values: number[]) {
  const ordered = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value || a.index - b.index);
  const output = Array(values.length).fill(0);
  for (let start = 0; start < ordered.length;) {
    let end = start + 1;
    while (end < ordered.length && ordered[end].value === ordered[start].value) end += 1;
    const rank = (start + end - 1) / 2 + 1;
    for (let index = start; index < end; index += 1) output[ordered[index].index] = rank;
    start = end;
  }
  return output;
}

function bayesianUserMean(entries: RatingTrainingEntry[]) { return (entries.reduce((sum, entry) => sum + entry.rating, 0) + 14) / (entries.length + 4); }
function tmdbStars(movie: Movie, fallback: number) { return movie.voteAverage && (movie.voteCount || 0) >= 20 ? clamp(movie.voteAverage / 2, .5, 5) : fallback; }
function normalize(value: string) { return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }
function mean(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function clamp(value: number, minimum: number, maximum: number) { return Math.max(minimum, Math.min(maximum, value)); }
function clamp01(value: number) { return clamp(value, 0, 1); }
function roundOne(value: number) { return Math.round(value * 10) / 10; }
function roundTwo(value: number) { return Math.round(value * 100) / 100; }
