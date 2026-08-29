import type { InterestMap, LikedMap, Movie, OnboardingPreferences, RatingMap, WatchedMap, WatchlistMap } from "../types";

export const REAL_TIME_TASTE_MOVIE_LIMIT = 420;

export function buildTasteProfileSample({
  ratings,
  likes,
  watchlist,
  watched,
  interest,
  preferences,
  limit = REAL_TIME_TASTE_MOVIE_LIMIT,
}: {
  ratings: RatingMap;
  likes: LikedMap;
  watchlist: WatchlistMap;
  watched: WatchedMap;
  interest: InterestMap;
  preferences: OnboardingPreferences;
  limit?: number;
}) {
  const selected = new Map<number, Movie>();
  const add = (movie?: Movie) => {
    if (movie && selected.size < limit && !selected.has(movie.id)) selected.set(movie.id, movie);
  };

  Object.values(preferences.favoriteMovies).forEach(add);
  const buckets = new Map<number, Array<{ movie: Movie; watchedAt: number }>>();
  Object.entries(ratings).forEach(([rawId, rating]) => {
    const entry = watched[Number(rawId)];
    if (!entry?.movie || rating <= 0) return;
    const bucket = Math.round(rating * 2);
    const items = buckets.get(bucket) || [];
    items.push({ movie: entry.movie, watchedAt: entry.watchedAt || 0 });
    buckets.set(bucket, items);
  });
  buckets.forEach((items) => items.sort((left, right) => right.watchedAt - left.watchedAt || left.movie.id - right.movie.id));
  const orderedBuckets = [...buckets.keys()].sort((left, right) => left - right);
  const ratingTarget = Math.min(limit, Math.max(selected.size, Math.floor(limit * .7)));
  for (let row = 0; selected.size < ratingTarget; row += 1) {
    let found = false;
    for (const bucket of orderedBuckets) {
      const item = buckets.get(bucket)?.[row];
      if (!item) continue;
      found = true;
      add(item.movie);
      if (selected.size >= limit) break;
    }
    if (!found) break;
  }

  Object.values(likes).forEach(add);
  Object.values(interest)
    .sort((left, right) => right.updatedAt - left.updatedAt || left.movie.id - right.movie.id)
    .forEach((entry) => add(entry.movie));
  Object.values(watchlist).forEach(add);
  for (let row = 0; selected.size < limit; row += 1) {
    let found = false;
    for (const bucket of orderedBuckets) {
      const item = buckets.get(bucket)?.[row];
      if (!item) continue;
      found = true;
      add(item.movie);
      if (selected.size >= limit) break;
    }
    if (!found) break;
  }

  return [...selected.values()];
}
