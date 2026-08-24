import type { Movie } from "../types";

export type RecommendationMapPoint = {
  movie: Movie;
  x: number;
  y: number;
  fitPercent: number;
};

export type RecommendationMap = {
  points: RecommendationMapPoint[];
  oldestYear: number;
  newestYear: number;
};

export function buildSimilarityMap(results: Array<{ movie: Movie; score: number }>, limit = 24): RecommendationMap {
  const sample = results.filter((result) => Number.isFinite(Number(result.movie.year))).slice(0, limit);
  if (!sample.length) return { points: [], oldestYear: 0, newestYear: 0 };
  const years = sample.map((result) => Number(result.movie.year));
  const oldestYear = Math.min(...years);
  const newestYear = Math.max(...years);
  const scores = sample.map((result) => result.score);
  const minimumScore = Math.min(...scores);
  const maximumScore = Math.max(...scores);
  return {
    oldestYear,
    newestYear,
    points: sample.map((result) => ({
      movie: result.movie,
      x: 7 + normalize(Number(result.movie.year), oldestYear, newestYear) * 86,
      y: 92 - normalize(result.score, minimumScore, maximumScore) * 84,
      fitPercent: Math.round(Math.max(0, Math.min(1, result.score)) * 100),
    })),
  };
}

function normalize(value: number, minimum: number, maximum: number) {
  if (maximum - minimum < 0.0001) return 0.5;
  return (value - minimum) / (maximum - minimum);
}
