import type { Movie } from "../types";

export type BroadPromptContext = {
  referenceTitle?: string;
  yearFrom?: number | null;
  yearTo?: number | null;
  resultMode?: "curated" | "collection";
  namedEntityCount?: number;
};

const nichePattern = /\b(?:cult|deep cuts?|hidden gems?|indie|niche|obscure|underrated|unknown)\b/i;
const specificPattern = /\b(?:about|by|directed by|from|starring|with)\b/i;
const broadPattern = /\b(?:best|top|good|great|funny|scary|cozy|movies?|films?|comed(?:y|ies)|dramas?|thrillers?|horrors?|action|adventure|animation|fantasy|romance|sci[ -]?fi)\b/i;

export function isBroadMoviePrompt(query: string, context: BroadPromptContext = {}) {
  const words = query.trim().split(/\s+/).filter(Boolean);
  return words.length > 0
    && words.length <= 7
    && broadPattern.test(query)
    && !nichePattern.test(query)
    && !specificPattern.test(query)
    && !context.referenceTitle
    && !context.yearFrom
    && !context.yearTo
    && context.resultMode !== "collection"
    && !context.namedEntityCount;
}

function normalizedPopularity(movie: Movie) {
  return Math.min(1, Math.log10(1 + Math.max(0, movie.popularity || 0)) / 2.2);
}

function normalizedVoteCount(movie: Movie) {
  return Math.min(1, Math.log10(1 + Math.max(0, movie.voteCount || 0)) / 4);
}

function normalizedRating(movie: Movie) {
  if (!movie.voteAverage || (movie.voteCount || 0) < 25) return 0;
  return Math.max(0, Math.min(1, (movie.voteAverage - 5) / 3.5));
}

export function hasBroadAudienceEvidence(movie: Movie) {
  const votes = movie.voteCount || 0;
  const popularity = movie.popularity || 0;
  return votes >= 250 || (votes >= 80 && popularity >= 12) || popularity >= 35;
}

export function broadCandidateScore(movie: Movie, promptScore = .35, targetGenre?: string) {
  const genreIndex = targetGenre ? movie.genres.findIndex((genre) => genre.toLowerCase() === targetGenre.toLowerCase()) : -1;
  const genreFit = genreIndex === 0 ? 1 : genreIndex > 0 ? .45 : targetGenre ? 0 : .5;
  return Math.min(1,
    Math.max(0, promptScore) * .55
    + genreFit * .12
    + normalizedPopularity(movie) * .14
    + normalizedVoteCount(movie) * .11
    + normalizedRating(movie) * .08
  );
}

export function rankBroadCandidates(movies: Movie[], promptScores: Record<number, number>, targetGenre?: string) {
  const seen = new Set<number>();
  const unique = movies.filter((movie) => {
    if (seen.has(movie.id)) return false;
    seen.add(movie.id);
    return true;
  });
  const credible = unique.filter(hasBroadAudienceEvidence);
  const pool = credible.length >= 3 ? credible : unique;
  const scores = Object.fromEntries(pool.map((movie) => [movie.id, broadCandidateScore(movie, promptScores[movie.id], targetGenre)])) as Record<number, number>;
  const ranked = [...pool].sort((a, b) => scores[b.id] - scores[a.id]
    || (b.voteCount || 0) - (a.voteCount || 0)
    || (b.popularity || 0) - (a.popularity || 0));
  return { movies: ranked, promptScores: scores };
}

export function personNameRelevance(query: string, name: string) {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const expected = normalize(query);
  const candidate = normalize(name);
  if (!expected || !candidate) return 0;
  if (candidate === expected) return 4;
  if (candidate.split(" ").some((part) => part.startsWith(expected))) return 3;
  return candidate.includes(expected) ? 1 : 0;
}
