import type { LearningEvent, PickIntentEvent, RatingMap, RecommendationEvent, ReviewInsightMap, ReviewMap, WatchedMap } from "../types";
import { linkPickOutcome } from "./outcomeTracking";

export type UnwatchState = {
  watched: WatchedMap;
  ratings: RatingMap;
  reviews: ReviewMap;
  reviewInsights: ReviewInsightMap;
  learningEvents: LearningEvent[];
  recommendationEvents: RecommendationEvent[];
  pickIntents: PickIntentEvent[];
};

export function removeWatchedOutcome(state: UnwatchState, movieId: number): UnwatchState {
  return {
    watched: withoutKey(state.watched, movieId),
    ratings: withoutKey(state.ratings, movieId),
    reviews: withoutKey(state.reviews, movieId),
    reviewInsights: withoutKey(state.reviewInsights, movieId),
    learningEvents: state.learningEvents.filter((event) => event.movie.id !== movieId || !["watched", "rating", "reviewAspect"].includes(event.type)),
    recommendationEvents: state.recommendationEvents.filter((event) => event.movieId !== movieId || !["watched", "rating", "highRating"].includes(event.type)),
    pickIntents: linkPickOutcome(state.pickIntents, movieId, { watchedAt: undefined, rating: undefined }),
  };
}

function withoutKey<T>(record: Record<string, T>, key: number): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}
