import type { InterestMap, WatchedMap } from "../types.ts";

export function getRatingSignal(rating: number) {
  const anchors = [
    { rating: 0.5, weight: -1 },
    { rating: 1, weight: -0.9 },
    { rating: 2, weight: -0.5 },
    { rating: 3, weight: 0.08 },
    { rating: 4, weight: 0.7 },
    { rating: 5, weight: 1 },
  ];
  const lower = [...anchors].reverse().find((anchor) => anchor.rating <= rating) || anchors[0];
  const upper = anchors.find((anchor) => anchor.rating >= rating) || anchors[anchors.length - 1];
  if (lower.rating === upper.rating) return lower.weight;
  const progress = (rating - lower.rating) / (upper.rating - lower.rating);
  return lower.weight + (upper.weight - lower.weight) * progress;
}

export function decayingPickWeight(createdAt: number, now = Date.now()) {
  const ageDays = Math.max(0, now - createdAt) / 86_400_000;
  return 0.22 * Math.exp(-ageDays / 30);
}

export function isMovieExcluded(movieId: number, watched: WatchedMap, interest: InterestMap, excludedIds: number[] = []) {
  return Boolean(watched[movieId] || interest[movieId]?.value === "notInterested" || excludedIds.includes(movieId));
}

