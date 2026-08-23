import { buildMovieProfile } from "./movieProfiles";
import { addWeightedEmbedding, cosineSimilarity, embedText, embeddingMagnitude, emptyEmbedding } from "./localEmbeddings";
import { decayingPickWeight, getRatingSignal, isMovieExcluded } from "./recommendationPolicy";
import type {
  InterestMap,
  Movie,
  OnboardingPreferences,
  PickIntentEvent,
  RatingMap,
  RecommendationMode,
  ReviewInsightMap,
  WatchedMap,
  WatchlistMap,
} from "../types";

export type RecommendationSignal = { label: string; value: number; detail: string };
export type RecommendationResult = { movie: Movie; score: number; reason: string; signals: RecommendationSignal[] };

const interestWeights = { interested: 0.32, maybe: 0.1, notInterested: -0.8 } as const;

export { decayingPickWeight, getRatingSignal } from "./recommendationPolicy";

export function recommendMovies({
  movies,
  ratings,
  watchlist,
  watched = {},
  interest,
  preferences,
  pickIntents = [],
  reviewInsights = {},
  collaborativeScores,
  mode,
  excludedIds = [],
  limit = 18,
}: {
  movies: Movie[];
  ratings: RatingMap;
  watchlist: WatchlistMap;
  watched?: WatchedMap;
  interest: InterestMap;
  preferences: OnboardingPreferences;
  pickIntents?: PickIntentEvent[];
  reviewInsights?: ReviewInsightMap;
  collaborativeScores?: Map<number, number>;
  mode: RecommendationMode;
  excludedIds?: number[];
  limit?: number;
}): RecommendationResult[] {
  const userVector = buildUserVector({ movies, ratings, watchlist, interest, preferences, pickIntents, reviewInsights });
  const preferredGenres = new Set(preferences.genres.map(normalize));
  const preferredDirectors = new Set(preferences.directors.map(normalize));
  const preferredActors = new Set((preferences.actors || []).map(normalize));
  const scored = movies
    .filter((movie) => !isMovieExcluded(movie.id, watched, interest, excludedIds))
    .map((movie) => {
      const taste = clamp01((cosineSimilarity(userVector, movieVector(movie)) + 1) / 2);
      const quality = clamp01((movie.voteAverage || 6.5) / 10);
      const popularity = clamp01(Math.log10((movie.popularity || 5) + 1) / 3);
      const novelty = noveltyScore(movie, preferredGenres);
      const explicit = explicitBoost(movie, preferredGenres, preferredDirectors, preferredActors);
      const saved = Boolean(watchlist[movie.id]);
      const modelScore = collaborativeScores?.get(movie.id);
      const collaborative = modelScore === undefined ? relationshipSignal(movie, movies, ratings) : clamp01((modelScore + 1) / 2);
      const weights = mode === "focused"
        ? { taste: 0.58, quality: 0.12, popularity: 0.05, novelty: 0.05, collaborative: 0.2 }
        : mode === "exploratory"
          ? { taste: 0.36, quality: 0.14, popularity: 0.08, novelty: 0.24, collaborative: 0.18 }
          : { taste: 0.48, quality: 0.14, popularity: 0.07, novelty: 0.12, collaborative: 0.19 };
      const score =
        taste * weights.taste + quality * weights.quality + popularity * weights.popularity +
        novelty * weights.novelty + collaborative * weights.collaborative + explicit + (saved ? 0.025 : 0);
      const signals = normalizeSignals([
        { label: "Your taste", value: taste, detail: tasteDetail(movie, preferences) },
        { label: "Similar movies", value: collaborative, detail: collaborativeDetail(movie, movies, ratings) },
        { label: "Quality", value: quality, detail: "Audience rating and review support" },
        { label: "Something new", value: novelty, detail: "Balances familiarity with discovery" },
      ]);
      return { movie, score, signals, reason: chooseReason(movie, signals, saved) };
    })
    .sort((a, b) => b.score - a.score);

  return diversityRerank(scored, mode, limit);
}

function buildUserVector({ movies, ratings, watchlist, interest, preferences, pickIntents, reviewInsights }: {
  movies: Movie[];
  ratings: RatingMap;
  watchlist: WatchlistMap;
  interest: InterestMap;
  preferences: OnboardingPreferences;
  pickIntents: PickIntentEvent[];
  reviewInsights: ReviewInsightMap;
}) {
  const vector = emptyEmbedding();
  movies.forEach((movie) => {
    const rating = ratings[movie.id];
    if (rating) addWeightedEmbedding(vector, movieVector(movie), getRatingSignal(rating));
  });
  Object.values(watchlist).forEach((movie) => addWeightedEmbedding(vector, movieVector(movie), 0.12));
  Object.values(interest).forEach(({ movie, value }) => addWeightedEmbedding(vector, movieVector(movie), interestWeights[value]));
  pickIntents.forEach(({ movie, createdAt }) => addWeightedEmbedding(vector, movieVector(movie), decayingPickWeight(createdAt)));
  Object.values(preferences.favoriteMovies || {}).forEach((movie) => addWeightedEmbedding(vector, movieVector(movie), 0.8));
  preferences.genres.forEach((genre) => addWeightedEmbedding(vector, embedText(`genre ${genre}`), 0.32));
  preferences.directors.forEach((director) => addWeightedEmbedding(vector, embedText(`director ${director}`), 0.42));
  (preferences.actors || []).forEach((actor) => addWeightedEmbedding(vector, embedText(`actor ${actor}`), 0.36));
  Object.values(reviewInsights).flat().forEach((aspect) => {
    addWeightedEmbedding(vector, embedText(aspect.label), aspect.sentiment === "positive" ? 0.2 : -0.2);
  });
  return embeddingMagnitude(vector) > 0 ? vector : embedText("acclaimed character driven drama comedy thriller animation discovery");
}

function explicitBoost(movie: Movie, genres: Set<string>, directors: Set<string>, actors: Set<string>) {
  const genre = movie.genres.filter((value) => genres.has(normalize(value))).length * 0.035;
  const director = movie.director && directors.has(normalize(movie.director)) ? 0.07 : 0;
  const cast = (movie.cast || []).some((actor) => actors.has(normalize(actor))) ? 0.055 : 0;
  return Math.min(genre + director + cast, 0.14);
}

function relationshipSignal(movie: Movie, movies: Movie[], ratings: RatingMap) {
  const liked = movies.filter((candidate) => (ratings[candidate.id] || 0) >= 4);
  if (!liked.length) return 0.45;
  const best = liked.reduce((max, candidate) => Math.max(max, affinityOverlap(movie, candidate)), 0);
  return clamp01(best / 8);
}

function collaborativeDetail(movie: Movie, movies: Movie[], ratings: RatingMap) {
  const match = movies
    .filter((candidate) => (ratings[candidate.id] || 0) >= 4)
    .map((candidate) => ({ candidate, overlap: affinityOverlap(movie, candidate) }))
    .sort((a, b) => b.overlap - a.overlap)[0];
  return match?.overlap > 0 ? `Closest to ${match.candidate.title}` : "Based on nearby audience and movie patterns";
}

function tasteDetail(movie: Movie, preferences: OnboardingPreferences) {
  const genres = movie.genres.filter((genre) => preferences.genres.some((value) => normalize(value) === normalize(genre)));
  if (genres.length) return `Matches your interest in ${genres.slice(0, 2).join(" and ")}`;
  if (movie.director && preferences.directors.some((value) => normalize(value) === normalize(movie.director || ""))) return `A director you follow`;
  return "Fits the patterns in your ratings and reactions";
}

function chooseReason(movie: Movie, signals: RecommendationSignal[], saved: boolean) {
  if (saved) return "Saved earlier and especially relevant tonight.";
  const strongest = [...signals].sort((a, b) => b.value - a.value)[0];
  if (strongest.label === "Similar movies") return strongest.detail + ".";
  if (strongest.label === "Quality" && (movie.voteAverage || 0) >= 8) return "Highly rated and close to your taste.";
  return strongest.detail + ".";
}

function normalizeSignals(signals: RecommendationSignal[]) {
  const max = Math.max(...signals.map((signal) => signal.value), 0.001);
  return signals.map((signal) => ({ ...signal, value: Math.round((signal.value / max) * 100) / 100 }));
}

function noveltyScore(movie: Movie, preferredGenres: Set<string>) {
  if (!preferredGenres.size) return 0.55;
  const overlap = movie.genres.filter((genre) => preferredGenres.has(normalize(genre))).length;
  return overlap ? 0.42 : 0.72;
}

function movieVector(movie: Movie) { return embedText(buildMovieProfile(movie)); }

function diversityRerank(results: RecommendationResult[], mode: RecommendationMode, limit: number) {
  const selected: RecommendationResult[] = [];
  const remaining = [...results];
  const penalty = mode === "focused" ? 0.05 : mode === "exploratory" ? 0.17 : 0.11;
  while (selected.length < limit && remaining.length) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    remaining.forEach((result, index) => {
      const duplicate = selected.reduce((max, item) => Math.max(max, clamp01((cosineSimilarity(movieVector(result.movie), movieVector(item.movie)) + 1) / 2)), 0);
      const adjusted = result.score - duplicate * penalty;
      if (adjusted > bestScore) { bestScore = adjusted; bestIndex = index; }
    });
    selected.push(remaining.splice(bestIndex, 1)[0]);
  }
  return selected;
}

function affinityOverlap(movie: Movie, candidate: Movie) {
  const genre = overlapCount(movie.genres, candidate.genres) * 1.2;
  const keyword = overlapCount(movie.keywords || [], candidate.keywords || []) * 1.4;
  const cast = overlapCount(movie.cast || [], candidate.cast || []) * 0.8;
  const director = movie.director && candidate.director && normalize(movie.director) === normalize(candidate.director) ? 2 : 0;
  const related = candidate.recommendedMovieIds?.includes(movie.id) || candidate.similarMovieIds?.includes(movie.id) ? 2.4 : 0;
  return genre + keyword + cast + director + related;
}

function overlapCount(a: string[], b: string[]) { const values = new Set(b.map(normalize)); return a.filter((value) => values.has(normalize(value))).length; }
function normalize(value: string) { return value.trim().toLowerCase(); }
function clamp01(value: number) { return Math.max(0, Math.min(value, 1)); }

export function getTopTasteLabel(ratings: RatingMap, movies: Movie[], preferences: OnboardingPreferences) {
  const weights = new Map<string, number>();
  preferences.genres.forEach((genre) => weights.set(genre, (weights.get(genre) || 0) + 2));
  movies.forEach((movie) => {
    const rating = ratings[movie.id];
    if (!rating) return;
    const signal = Math.max(getRatingSignal(rating), 0);
    movie.genres.forEach((genre) => weights.set(genre, (weights.get(genre) || 0) + signal));
  });
  return [...weights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "taste forming";
}
