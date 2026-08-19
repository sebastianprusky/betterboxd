import type { Movie } from "../types";
import { cosineSimilarity, embedText } from "./localEmbeddings";

export function buildMovieProfile(movie: Movie) {
  return [
    field("Title", movie.title),
    field("Year", movie.year),
    field("Genres", movie.genres),
    field("Overview", movie.overview),
    field("Director", movie.director),
    field("Cast", movie.cast),
    field("Keywords", movie.keywords),
    field("Language", movie.originalLanguage),
    field("Countries", movie.productionCountries),
    field("Decade", movieDecade(movie)),
    field("TMDB similar movie IDs", movie.similarMovieIds?.map(String)),
    field("TMDB recommended movie IDs", movie.recommendedMovieIds?.map(String)),
  ]
    .filter(Boolean)
    .join("\n");
}

export function searchMovieProfiles(query: string, movies: Movie[], limit = 20) {
  const queryEmbedding = embedText(query);

  return movies
    .map((movie) => ({
      movie,
      score: cosineSimilarity(queryEmbedding, embedText(buildMovieProfile(movie))),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ movie }) => movie);
}

function field(label: string, value?: string | string[] | null) {
  if (Array.isArray(value)) {
    const cleaned = value.filter(Boolean);
    return cleaned.length ? `${label}: ${cleaned.join(", ")}` : "";
  }

  return value ? `${label}: ${value}` : "";
}

function movieDecade(movie: Movie) {
  const year = Number(movie.year);
  return year ? `${Math.floor(year / 10) * 10}s` : "";
}
