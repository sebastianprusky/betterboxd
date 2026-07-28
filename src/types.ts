export type Tab = "discover" | "search" | "profile";

export type Theme = "light" | "dark";

export type ProfileSort = "recentlyWatched" | "highestRated" | "lowestRated" | "recentlyReleased";

export type InterestValue = "interested" | "maybe" | "notInterested";

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
  popularity?: number;
};

export type MovieDebugInfo = {
  status: string;
  mode: string;
  reasonSource: string;
  score?: number;
  strongestSignals: string[];
};

export type MovieDebugMap = Record<number, MovieDebugInfo>;

export type AskFilter = {
  label: string;
  value: string;
};

export type AskBetterBoxdResult = {
  movies: Movie[];
  debug: MovieDebugMap;
  filters: AskFilter[];
  explanation: string;
};

export type RatingMap = Record<string, number>;

export type WatchlistMap = Record<string, Movie>;

export type WatchedMap = Record<string, { movie: Movie; watchedAt: number }>;

export type InterestMap = Record<string, { movie: Movie; value: InterestValue; updatedAt: number }>;

export type ReviewMap = Record<string, string>;
