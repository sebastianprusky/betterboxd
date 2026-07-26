export type Tab = "discover" | "search" | "profile";

export type Theme = "light" | "dark";

export type ProfileSort = "recentlyWatched" | "highestRated" | "lowestRated" | "recentlyReleased";

export type Movie = {
  id: number;
  title: string;
  year: string;
  posterPath: string | null;
  backdropPath?: string | null;
  overview: string;
  genres: string[];
  voteAverage?: number;
  runtime?: number;
  director?: string;
  cast?: string[];
};

export type RatingMap = Record<string, number>;

export type WatchlistMap = Record<string, Movie>;

export type WatchedMap = Record<string, { movie: Movie; watchedAt: number }>;

export type ReviewMap = Record<string, string>;
