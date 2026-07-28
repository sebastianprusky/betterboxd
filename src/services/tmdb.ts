import { fallbackMovies, genreIds } from "../data/fallbackMovies";
import type { Movie } from "../types";
import { localSemanticSearch, searchMoviesSemantically } from "./semanticSearch";

const apiKey = import.meta.env.VITE_TMDB_API_KEY as string | undefined;
const apiBase = "https://api.themoviedb.org/3";

type TmdbMovie = {
  id: number;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path: string | null;
  backdrop_path?: string | null;
  overview: string;
  genre_ids?: number[];
  vote_average?: number;
};

type TmdbMovieDetail = TmdbMovie & {
  runtime?: number;
  genres?: Array<{ id: number; name: string }>;
  credits?: {
    cast?: Array<{ name: string; order: number }>;
    crew?: Array<{ name: string; job: string }>;
  };
};

const mapMovie = (movie: TmdbMovie): Movie => ({
  id: movie.id,
  title: movie.title || movie.name || "Untitled",
  year: (movie.release_date || movie.first_air_date || "").slice(0, 4) || "Unknown",
  posterPath: movie.poster_path,
  backdropPath: movie.backdrop_path,
  overview: movie.overview || "No overview available yet.",
  genres: (movie.genre_ids || []).map((id) => genreIds[id]).filter(Boolean),
  voteAverage: movie.vote_average,
});

const mapMovieDetail = (movie: TmdbMovieDetail): Movie => ({
  id: movie.id,
  title: movie.title || movie.name || "Untitled",
  year: (movie.release_date || movie.first_air_date || "").slice(0, 4) || "Unknown",
  posterPath: movie.poster_path,
  backdropPath: movie.backdrop_path,
  overview: movie.overview || "No overview available yet.",
  genres: movie.genres?.map((genre) => genre.name) || (movie.genre_ids || []).map((id) => genreIds[id]).filter(Boolean),
  voteAverage: movie.vote_average,
  runtime: movie.runtime,
  director: movie.credits?.crew?.find((person) => person.job === "Director")?.name,
  cast: movie.credits?.cast
    ?.sort((a, b) => a.order - b.order)
    .slice(0, 5)
    .map((person) => person.name),
});

async function tmdbFetch(path: string) {
  if (!apiKey) return null;
  const separator = path.includes("?") ? "&" : "?";
  const response = await fetch(`${apiBase}${path}${separator}api_key=${apiKey}`);
  if (!response.ok) throw new Error(`TMDB request failed: ${response.status}`);
  return response.json();
}

export function posterUrl(path: string | null, size = "w500") {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : "";
}

export async function getTrendingMovies(): Promise<Movie[]> {
  const data = await tmdbFetch("/trending/movie/week");
  if (!data) return fallbackMovies;
  return data.results.map(mapMovie).filter((movie: Movie) => movie.posterPath).slice(0, 18);
}

export async function searchMovies(query: string): Promise<Movie[]> {
  if (!query.trim()) return [];

  if (!apiKey) {
    return searchMoviesSemantically(query, fallbackMovies);
  }

  try {
    const data = await tmdbFetch(`/search/movie?query=${encodeURIComponent(query)}&include_adult=false`);
    if (!data) return searchMoviesSemantically(query, fallbackMovies);

    const results = data.results.map(mapMovie).filter((movie: Movie) => movie.posterPath).slice(0, 20);
    const semanticResults = await searchMoviesSemantically(query, results);
    return semanticResults.length ? semanticResults : results;
  } catch {
    return localSemanticSearch(query, fallbackMovies);
  }
}

export async function getMovieDetails(movie: Movie): Promise<Movie> {
  const data = await tmdbFetch(`/movie/${movie.id}?append_to_response=credits`);
  if (!data) return fallbackMovies.find((fallback) => fallback.id === movie.id) || movie;
  return mapMovieDetail(data);
}

export function hasTmdbKey() {
  return Boolean(apiKey);
}
