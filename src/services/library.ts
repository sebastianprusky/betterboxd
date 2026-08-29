import type { LibraryFilter, LibrarySort, LibraryWatchedFilter, LikedMap, Movie, RatingMap, WatchedMap, WatchlistMap } from "../types";

export function filterAndSortLibraryMovies({ movies, filter, watchedFilter, sort, query, ratings, likes, watched, watchlist }: {
  movies: Movie[];
  filter: LibraryFilter;
  watchedFilter: LibraryWatchedFilter;
  sort: LibrarySort;
  query: string;
  ratings: RatingMap;
  likes: LikedMap;
  watched: WatchedMap;
  watchlist: WatchlistMap;
}) {
  const normalizedQuery = query.trim().toLowerCase();
  return movies.filter((movie) => {
    if (filter === "watched" && !watched[movie.id]) return false;
    if (filter === "watchlist" && !watchlist[movie.id]) return false;
    if (filter === "watched" && watchedFilter === "liked" && !likes[movie.id]) return false;
    return !normalizedQuery || `${movie.title} ${movie.year}`.toLowerCase().includes(normalizedQuery);
  }).sort((a, b) => {
    const recent = (watched[b.id]?.watchedAt || 0) - (watched[a.id]?.watchedAt || 0);
    const title = a.title.localeCompare(b.title);
    if (filter !== "watched" || sort === "recent") return recent || title;
    if (sort === "title") return title || recent;
    if (sort === "year-newest") return (Number(b.year) || 0) - (Number(a.year) || 0) || recent || title;
    const aRating = ratings[a.id]; const bRating = ratings[b.id];
    if (aRating === undefined && bRating !== undefined) return 1;
    if (bRating === undefined && aRating !== undefined) return -1;
    const ratingOrder = sort === "rating-high" ? (bRating || 0) - (aRating || 0) : (aRating || 0) - (bRating || 0);
    return ratingOrder || recent || title;
  });
}
