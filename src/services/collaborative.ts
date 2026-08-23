import type { Movie, RatingMap } from "../types";

export type CollaborativeNeighbor = { tmdbId: number; score: number; support: number };
export type CollaborativeItem = {
  tmdbId: number;
  factors: number[];
  bias: number;
  support: number;
  neighbors: CollaborativeNeighbor[];
};
export type CollaborativeModel = { version: string; dimensions: 64; items: Record<string, CollaborativeItem> };

let modelPromise: Promise<CollaborativeModel | null> | null = null;

export function loadCollaborativeModel() {
  if (!modelPromise) {
    const modelUrl = import.meta.env.VITE_MOVIELENS_MODEL_URL as string | undefined;
    if (!modelUrl) return Promise.resolve(null);
    modelPromise = fetch(modelUrl)
      .then((response) => response.ok ? response.json() : null)
      .catch(() => null);
  }
  return modelPromise;
}

export function scoreCollaborativeCandidates(model: CollaborativeModel | null, ratings: RatingMap, movies: Movie[]) {
  if (!model) return new Map<number, number>();
  const user = Array.from({ length: model.dimensions }, () => 0);
  let totalWeight = 0;
  Object.entries(ratings).forEach(([movieId, rating]) => {
    const item = model.items[movieId];
    if (!item) return;
    const weight = Math.max(-1, Math.min(1, (rating - 2.75) / 2.25));
    item.factors.forEach((factor, index) => { user[index] += factor * weight; });
    totalWeight += Math.abs(weight);
  });
  if (!totalWeight) return new Map();
  return new Map(movies.map((movie) => {
    const item = model.items[movie.id];
    if (!item) return [movie.id, 0];
    const dot = item.factors.reduce((sum, factor, index) => sum + factor * user[index], 0);
    return [movie.id, dot / totalWeight + item.bias * 0.08];
  }));
}
