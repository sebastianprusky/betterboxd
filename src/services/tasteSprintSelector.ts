import type { InterestMap, LikedMap, Movie, OnboardingPreferences, RatingMap, ReviewInsightMap } from "../types";
import type { RecommendationResult } from "./recommendations";

export type TasteSprintCandidate = {
  movie: Movie;
  utility: number;
  uncertainty: number;
  coverage: number;
  answerability: number;
  diversity: number;
  diagnostic: string;
};

export function rankTasteSprintCandidates({
  results,
  ratings,
  likes = {},
  interest,
  preferences,
  reviewInsights,
  recentMovies = [],
}: {
  results: RecommendationResult[];
  ratings: RatingMap;
  likes?: LikedMap;
  interest: InterestMap;
  preferences: OnboardingPreferences;
  reviewInsights: ReviewInsightMap;
  recentMovies?: Movie[];
}): TasteSprintCandidate[] {
  const evidence = buildEvidenceCounts(ratings, likes, interest, preferences, reviewInsights);
  const hasTaste = Object.keys(ratings).length + Object.keys(likes).length + Object.keys(interest).length + preferences.genres.length + preferences.directors.length + preferences.actors.length + Object.keys(preferences.favoriteMovies).length > 0;
  return results.map((result) => {
    const taste = result.signals.find((signal) => signal.label === "Your taste")?.value ?? .5;
    const uncertainty = hasTaste ? 1 - Math.min(1, Math.abs(taste - .5) * 2) : .72;
    const traits = movieTraits(result.movie);
    const coverage = traits.length ? traits.reduce((sum, trait) => sum + 1 / (1 + (evidence.get(trait) || 0)), 0) / traits.length : .35;
    const popularity = Math.min(1, Math.log10((result.movie.popularity || 4) + 1) / 2.35);
    const votes = Math.min(1, Math.log10((result.movie.voteCount || 20) + 1) / 4.2);
    const answerability = popularity * .62 + votes * .38;
    const diversity = recentMovies.length ? Math.min(...recentMovies.slice(0, 6).map((movie) => movieDissimilarity(result.movie, movie))) : 1;
    const utility = uncertainty * .4 + coverage * .25 + answerability * .2 + diversity * .15;
    const strongest = [["uncertainty", uncertainty], ["coverage", coverage], ["recognition", answerability], ["diversity", diversity]].sort((a, b) => Number(b[1]) - Number(a[1]))[0][0];
    return { movie: result.movie, utility, uncertainty, coverage, answerability, diversity, diagnostic: `Selected for ${strongest}` };
  }).sort((a, b) => b.utility - a.utility || b.answerability - a.answerability || a.movie.title.localeCompare(b.movie.title));
}

function buildEvidenceCounts(ratings: RatingMap, likes: LikedMap, interest: InterestMap, preferences: OnboardingPreferences, reviewInsights: ReviewInsightMap) {
  const counts = new Map<string, number>();
  const add = (trait: string, amount = 1) => counts.set(normalize(trait), (counts.get(normalize(trait)) || 0) + amount);
  preferences.genres.forEach((value) => add(`genre:${value}`, 2));
  preferences.directors.forEach((value) => add(`director:${value}`, 2));
  preferences.actors.forEach((value) => add(`person:${value}`, 2));
  Object.values(preferences.favoriteMovies).forEach((movie) => movieTraits(movie).forEach((trait) => add(trait, 2)));
  Object.values(likes).forEach((movie) => movieTraits(movie).forEach((trait) => add(trait, 1.5)));
  Object.entries(ratings).forEach(([id]) => add(`movie:${id}`, 2));
  Object.values(interest).forEach(({ movie }) => movieTraits(movie).forEach((trait) => add(trait)));
  Object.values(reviewInsights).flat().forEach((aspect) => add(`keyword:${aspect.label}`));
  return counts;
}

function movieTraits(movie: Movie) {
  const decade = Math.floor((Number(movie.year) || 2000) / 10) * 10;
  return Array.from(new Set([
    ...movie.genres.map((genre) => `genre:${normalize(genre)}`),
    `era:${decade}`,
    ...(movie.director ? [`director:${normalize(movie.director)}`] : []),
    ...(movie.cast || []).slice(0, 3).map((person) => `person:${normalize(person)}`),
    ...(movie.keywords || []).slice(0, 5).map((keyword) => `keyword:${normalize(keyword)}`),
  ]));
}

function movieDissimilarity(a: Movie, b: Movie) {
  const aTraits = new Set(movieTraits(a));
  const bTraits = new Set(movieTraits(b));
  const union = new Set([...aTraits, ...bTraits]);
  if (!union.size) return 1;
  const overlap = [...aTraits].filter((trait) => bTraits.has(trait)).length;
  return 1 - overlap / union.size;
}

function normalize(value: string) { return value.trim().toLowerCase(); }
