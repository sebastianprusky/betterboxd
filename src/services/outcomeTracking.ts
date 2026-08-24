import type { Movie, PickIntentEvent, RecommendationEvent, RecommendationMode } from "../types";

export function linkPickOutcome(events: PickIntentEvent[], movieId: number, outcome: { watchedAt?: number; rating?: number }) {
  let linked = false;
  return [...events].reverse().map((event) => {
    if (linked || event.movie.id !== movieId) return event;
    linked = true;
    return { ...event, ...outcome };
  }).reverse();
}

export function recommendationEvent(
  type: RecommendationEvent["type"],
  movie: Movie,
  score: number,
  context: { mode?: RecommendationMode; rank?: number; pickId?: string; rating?: number } = {},
): RecommendationEvent {
  return {
    id: `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    movieId: movie.id,
    movieTitle: movie.title,
    mode: context.mode || "balanced",
    score,
    rank: context.rank,
    pickId: context.pickId,
    rating: context.rating,
    createdAt: Date.now(),
  };
}
