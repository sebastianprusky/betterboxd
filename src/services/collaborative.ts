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
    const modelUrl = (import.meta.env.VITE_MOVIELENS_MODEL_URL as string | undefined) || "/models/movielens-small-svd64-v1.json";
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
  return new Map(movies.flatMap((movie): Array<[number, number]> => {
    const item = model.items[movie.id];
    if (!item) return [];
    const dot = item.factors.reduce((sum, factor, index) => sum + factor * user[index], 0);
    return [[movie.id, dot / totalWeight + item.bias * 0.08]];
  }));
}

export function explainCollaborativeCandidates(model: CollaborativeModel | null, ratings: RatingMap, movies: Movie[]) {
  const evidence = new Map<number, string>();
  if (!model) return evidence;
  const titles = new Map(movies.map((movie) => [movie.id, movie.title]));
  const liked = Object.entries(ratings)
    .filter(([, rating]) => rating >= 4)
    .flatMap(([movieId]) => model.items[movieId] ? [{ movieId: Number(movieId), item: model.items[movieId] }] : []);
  movies.forEach((movie) => {
    const match = liked
      .flatMap(({ movieId, item }) => item.neighbors.filter((neighbor) => neighbor.tmdbId === movie.id).map((neighbor) => ({ movieId, neighbor })))
      .sort((a, b) => b.neighbor.score - a.neighbor.score)[0];
    if (!match) return;
    const title = titles.get(match.movieId) || `movie ${match.movieId}`;
    evidence.set(movie.id, `MovieLens viewers often liked this alongside ${title} (${match.neighbor.support} shared likes)`);
  });
  return evidence;
}
