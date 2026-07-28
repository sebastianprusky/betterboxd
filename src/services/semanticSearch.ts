import { fallbackMovies } from "../data/fallbackMovies";
import type { Movie } from "../types";

const semanticSearchUrl = "/api/semantic-search";
const maxResults = 20;
const stopWords = new Set(["a", "an", "and", "by", "for", "in", "of", "the", "to", "with"]);

type SemanticSearchResponse = {
  movies?: unknown;
};

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function queryTokens(query: string) {
  return normalize(query)
    .split(" ")
    .filter((token) => token.length > 1 && !stopWords.has(token));
}

function movieText(movie: Movie) {
  return normalize([movie.title, movie.year, movie.overview, ...movie.genres, movie.director || "", ...(movie.cast || [])].join(" "));
}

function isMovie(value: unknown): value is Movie {
  if (!value || typeof value !== "object") return false;
  const movie = value as Partial<Movie>;
  return (
    typeof movie.id === "number" &&
    typeof movie.title === "string" &&
    typeof movie.year === "string" &&
    typeof movie.overview === "string" &&
    Array.isArray(movie.genres)
  );
}

function dedupeMovies(movies: Movie[]) {
  const seen = new Set<number>();
  return movies.filter((movie) => {
    if (seen.has(movie.id)) return false;
    seen.add(movie.id);
    return true;
  });
}

export function localSemanticSearch(query: string, candidates: Movie[] = fallbackMovies): Movie[] {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return [];

  const tokens = queryTokens(query);
  return dedupeMovies(candidates)
    .map((movie, index) => {
      const title = normalize(movie.title);
      const genres = movie.genres.map(normalize);
      const text = movieText(movie);
      let score = 0;

      if (text.includes(normalizedQuery)) score += 12;
      if (title.includes(normalizedQuery)) score += 20;
      if (movie.year === normalizedQuery) score += 8;

      tokens.forEach((token) => {
        if (title.includes(token)) score += 6;
        if (genres.some((genre) => genre.includes(token))) score += 5;
        if (movie.overview.toLowerCase().includes(token)) score += 3;
        if (movie.director?.toLowerCase().includes(token)) score += 3;
        if (movie.cast?.some((name) => name.toLowerCase().includes(token))) score += 2;
      });

      return { movie, score, index };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxResults)
    .map(({ movie }) => movie);
}

export async function searchMoviesSemantically(query: string, candidates: Movie[] = fallbackMovies): Promise<Movie[]> {
  if (!query.trim()) return [];

  try {
    const response = await fetch(semanticSearchUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, movies: dedupeMovies(candidates) }),
    });

    if (!response.ok) throw new Error("Semantic search route unavailable");

    const data = (await response.json()) as SemanticSearchResponse;
    if (!Array.isArray(data.movies)) throw new Error("Invalid semantic search response");

    return data.movies.filter(isMovie);
  } catch {
    return localSemanticSearch(query, candidates);
  }
}
