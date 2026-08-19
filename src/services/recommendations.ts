import { buildMovieProfile } from "./movieProfiles";
import {
  addWeightedEmbedding,
  cosineSimilarity,
  embedText,
  embeddingMagnitude,
  emptyEmbedding,
} from "./localEmbeddings";
import type {
  InterestMap,
  Movie,
  OnboardingPreferences,
  RatingMap,
  RecommendationMode,
  WatchlistMap,
} from "../types";

type RecommendationWeights = {
  similarity: number;
  popularity: number;
  rating: number;
  novelty: number;
};

export type RecommendationResult = {
  movie: Movie;
  score: number;
  reason: string;
};

const modeWeights: Record<RecommendationMode, RecommendationWeights> = {
  focused: { similarity: 0.8, popularity: 0.1, rating: 0.05, novelty: 0.05 },
  balanced: { similarity: 0.6, popularity: 0.15, rating: 0.1, novelty: 0.15 },
  exploratory: { similarity: 0.4, popularity: 0.15, rating: 0.1, novelty: 0.35 },
};

const interestWeights = {
  interested: 0.45,
  maybe: 0.15,
  notInterested: -0.45,
};

export function getRatingSignal(rating: number) {
  const anchors = [
    { rating: 1, weight: -0.9 },
    { rating: 2, weight: -0.5 },
    { rating: 3, weight: 0.1 },
    { rating: 4, weight: 0.7 },
    { rating: 5, weight: 1 },
  ];

  const lower = [...anchors].reverse().find((anchor) => anchor.rating <= rating) || anchors[0];
  const upper = anchors.find((anchor) => anchor.rating >= rating) || anchors[anchors.length - 1];
  if (lower.rating === upper.rating) return lower.weight;

  const progress = (rating - lower.rating) / (upper.rating - lower.rating);
  return lower.weight + (upper.weight - lower.weight) * progress;
}

export function recommendMovies({
  movies,
  ratings,
  watchlist,
  interest,
  preferences,
  mode,
  limit = 6,
}: {
  movies: Movie[];
  ratings: RatingMap;
  watchlist: WatchlistMap;
  interest: InterestMap;
  preferences: OnboardingPreferences;
  mode: RecommendationMode;
  limit?: number;
}): RecommendationResult[] {
  const userVector = buildUserVector({ movies, ratings, watchlist, interest, preferences });
  const weights = modeWeights[mode];
  const preferredGenres = new Set(preferences.genres.map(normalize));
  const preferredDirectors = new Set(preferences.directors.map(normalize));
  const ratedMovieIds = new Set(Object.keys(ratings).map(Number));
  const watchlistMovieIds = new Set(Object.keys(watchlist).map(Number));

  const scored = movies
    .filter((movie) => !ratedMovieIds.has(movie.id) && !watchlistMovieIds.has(movie.id))
    .map((movie) => {
      const similarity = normalizeSimilarity(cosineSimilarity(userVector, movieVector(movie)));
      const popularity = normalizePopularity(movie.voteAverage);
      const rating = normalizePopularity(movie.voteAverage);
      const novelty = noveltyScore(movie, preferredGenres);
      const preferenceBoost = candidatePreferenceBoost(movie, movies, ratings, watchlist, preferredGenres, preferredDirectors);

      return {
        movie,
        reason: explainRecommendation(movie, movies, ratings, watchlist, preferences),
        score:
          similarity * weights.similarity +
          popularity * weights.popularity +
          rating * weights.rating +
          novelty * weights.novelty +
          preferenceBoost,
      };
    })
    .sort((a, b) => b.score - a.score);

  return diversityRerank(scored, mode, limit);
}

function explainRecommendation(
  movie: Movie,
  movies: Movie[],
  ratings: RatingMap,
  watchlist: WatchlistMap,
  preferences: OnboardingPreferences,
) {
  const preferredGenres = preferences.genres.filter((genre) => movie.genres.includes(genre));
  if (preferredGenres.length) return `Matches your ${preferredGenres.slice(0, 2).join(" and ")} taste.`;

  if (movie.director && preferences.directors.some((director) => normalize(director) === normalize(movie.director || ""))) {
    return `From a director you picked.`;
  }

  const favoriteKeyword = mostRelevantKeyword(movie, movies, ratings);
  if (favoriteKeyword) return `Matches your interest in ${favoriteKeyword}.`;

  const likedMovies = movies
    .filter((candidate) => (ratings[candidate.id] || 0) >= 4)
    .map((candidate) => ({
      movie: candidate,
      overlap: affinityOverlap(movie, candidate),
    }))
    .filter(({ overlap }) => overlap > 0)
    .sort((a, b) => b.overlap - a.overlap);

  if (likedMovies[0]) return `Similar to ${likedMovies[0].movie.title}.`;

  const savedMovies = Object.values(watchlist)
    .map((candidate) => ({
      movie: candidate,
      overlap: affinityOverlap(movie, candidate),
    }))
    .filter(({ overlap }) => overlap > 0)
    .sort((a, b) => b.overlap - a.overlap);

  if (savedMovies[0]) return `Fits movies in your watchlist.`;

  if ((movie.voteAverage || 0) >= 8) return `Highly rated and close to your profile.`;
  return `Close to your current taste profile.`;
}

export function getTopTasteLabel(
  ratings: RatingMap,
  movies: Movie[],
  preferences: OnboardingPreferences,
) {
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

function buildUserVector({
  movies,
  ratings,
  watchlist,
  interest,
  preferences,
}: {
  movies: Movie[];
  ratings: RatingMap;
  watchlist: WatchlistMap;
  interest: InterestMap;
  preferences: OnboardingPreferences;
}) {
  const vector = emptyEmbedding();

  movies.forEach((movie) => {
    const rating = ratings[movie.id];
    if (rating) addWeightedEmbedding(vector, movieVector(movie), getRatingSignal(rating));
  });

  Object.values(watchlist).forEach((movie) => addWeightedEmbedding(vector, movieVector(movie), 0.45));
  Object.values(interest).forEach(({ movie, value }) => addWeightedEmbedding(vector, movieVector(movie), interestWeights[value]));
  Object.values(preferences.favoriteMovies).forEach((movie) => addWeightedEmbedding(vector, movieVector(movie), 0.85));
  preferences.genres.forEach((genre) => addWeightedEmbedding(vector, embedText(`genre ${genre}`), 0.35));
  preferences.directors.forEach((director) => addWeightedEmbedding(vector, embedText(`director ${director}`), 0.45));

  return embeddingMagnitude(vector) > 0 ? vector : embedText("popular acclaimed drama thriller comedy animation science fiction");
}

function candidatePreferenceBoost(
  movie: Movie,
  movies: Movie[],
  ratings: RatingMap,
  watchlist: WatchlistMap,
  preferredGenres: Set<string>,
  preferredDirectors: Set<string>,
) {
  const genreBoost = movie.genres.filter((genre) => preferredGenres.has(normalize(genre))).length * 0.045;
  const directorBoost = movie.director && preferredDirectors.has(normalize(movie.director)) ? 0.08 : 0;
  const ratedAffinityBoost = movies
    .filter((candidate) => (ratings[candidate.id] || 0) >= 4)
    .reduce((boost, candidate) => boost + affinityOverlap(movie, candidate) * 0.018, 0);
  const watchlistAffinityBoost = Object.values(watchlist).reduce(
    (boost, candidate) => boost + affinityOverlap(movie, candidate) * 0.012,
    0,
  );

  return genreBoost + directorBoost + Math.min(ratedAffinityBoost + watchlistAffinityBoost, 0.16);
}

function noveltyScore(movie: Movie, preferredGenres: Set<string>) {
  if (!preferredGenres.size) return 0.5;
  const overlap = movie.genres.filter((genre) => preferredGenres.has(normalize(genre))).length;
  const adjacent = overlap > 0 ? 0.35 : 0.75;
  const age = Number(movie.year) ? Math.min(Math.abs(new Date().getFullYear() - Number(movie.year)) / 60, 1) : 0.4;
  return Math.min(adjacent + age * 0.25, 1);
}

function movieVector(movie: Movie) {
  return embedText(buildMovieProfile(movie));
}

function diversityRerank(results: RecommendationResult[], mode: RecommendationMode, limit: number) {
  const selected: RecommendationResult[] = [];
  const remaining = [...results];
  const penalty = mode === "focused" ? 0.05 : mode === "balanced" ? 0.1 : 0.16;

  while (selected.length < limit && remaining.length) {
    let bestIndex = 0;
    let bestAdjustedScore = Number.NEGATIVE_INFINITY;

    remaining.forEach((result, index) => {
      const similarityToSelected = selected.reduce(
        (maxSimilarity, selectedResult) =>
          Math.max(maxSimilarity, normalizeSimilarity(cosineSimilarity(movieVector(result.movie), movieVector(selectedResult.movie)))),
        0,
      );
      const adjustedScore = result.score - similarityToSelected * penalty;
      if (adjustedScore > bestAdjustedScore) {
        bestAdjustedScore = adjustedScore;
        bestIndex = index;
      }
    });

    selected.push(remaining.splice(bestIndex, 1)[0]);
  }

  return selected;
}

function affinityOverlap(movie: Movie, candidate: Movie) {
  const genreOverlap = overlapCount(movie.genres, candidate.genres) * 1.2;
  const keywordOverlap = overlapCount(movie.keywords || [], candidate.keywords || []) * 1.4;
  const castOverlap = overlapCount(movie.cast || [], candidate.cast || []) * 0.8;
  const countryOverlap = overlapCount(movie.productionCountries || [], candidate.productionCountries || []) * 0.35;
  const directorOverlap =
    movie.director && candidate.director && normalize(movie.director) === normalize(candidate.director) ? 2 : 0;
  const tmdbRelationship =
    candidate.recommendedMovieIds?.includes(movie.id) || candidate.similarMovieIds?.includes(movie.id) ? 2.4 : 0;

  return genreOverlap + keywordOverlap + castOverlap + countryOverlap + directorOverlap + tmdbRelationship;
}

function mostRelevantKeyword(movie: Movie, movies: Movie[], ratings: RatingMap) {
  const movieKeywords = movie.keywords || [];
  if (!movieKeywords.length) return null;

  const likedKeywordWeights = new Map<string, number>();
  movies.forEach((candidate) => {
    const signal = getRatingSignal(ratings[candidate.id] || 0);
    if (signal <= 0) return;
    candidate.keywords?.forEach((keyword) => {
      likedKeywordWeights.set(normalize(keyword), (likedKeywordWeights.get(normalize(keyword)) || 0) + signal);
    });
  });

  return movieKeywords
    .map((keyword) => ({ keyword, weight: likedKeywordWeights.get(normalize(keyword)) || 0 }))
    .filter(({ weight }) => weight > 0)
    .sort((a, b) => b.weight - a.weight)[0]?.keyword || null;
}

function overlapCount(a: string[], b: string[]) {
  const bValues = new Set(b.map(normalize));
  return a.filter((value) => bValues.has(normalize(value))).length;
}

function normalizeSimilarity(value: number) {
  return (value + 1) / 2;
}

function normalizePopularity(value = 0) {
  return Math.max(0, Math.min(value / 10, 1));
}

function normalize(value: string) {
  return value.trim().toLowerCase();
}
