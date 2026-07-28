import { fallbackMovies } from "../data/fallbackMovies";
import type { Movie, MovieDebugInfo, MovieDebugMap } from "../types";

const semanticSearchUrl = "/api/semantic-search";
const maxResults = 20;
const stopWords = new Set(["a", "an", "and", "by", "for", "in", "of", "the", "to", "with"]);

type SemanticSearchResponse = {
  movies?: unknown;
  debug?: {
    status?: string;
    mode?: string;
    model?: string;
    candidateCount?: number;
    remoteEmbeddingCount?: number;
    cachedEmbeddingCount?: number;
    reasonSource?: string;
    scores?: Record<string, number>;
  };
};

export type SearchWithDebugResult = {
  movies: Movie[];
  debug: MovieDebugMap;
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
  return localSemanticSearchWithDebug(query, candidates).movies;
}

export function localSemanticSearchWithDebug(query: string, candidates: Movie[] = fallbackMovies): SearchWithDebugResult {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return { movies: [], debug: {} };

  const tokens = queryTokens(query);
  const ranked = dedupeMovies(candidates)
    .map((movie, index) => {
      const title = normalize(movie.title);
      const genres = movie.genres.map(normalize);
      const text = movieText(movie);
      let score = 0;
      const strongestSignals: string[] = [];

      if (text.includes(normalizedQuery)) {
        score += 12;
        strongestSignals.push("phrase match");
      }
      if (title.includes(normalizedQuery)) {
        score += 20;
        strongestSignals.push("title match");
      }
      if (movie.year === normalizedQuery) {
        score += 8;
        strongestSignals.push("year match");
      }

      tokens.forEach((token) => {
        if (title.includes(token)) {
          score += 6;
          strongestSignals.push(`title:${token}`);
        }
        if (genres.some((genre) => genre.includes(token))) {
          score += 5;
          strongestSignals.push(`genre:${token}`);
        }
        if (movie.overview.toLowerCase().includes(token)) {
          score += 3;
          strongestSignals.push(`overview:${token}`);
        }
        if (movie.director?.toLowerCase().includes(token)) {
          score += 3;
          strongestSignals.push(`director:${token}`);
        }
        if (movie.cast?.some((name) => name.toLowerCase().includes(token))) {
          score += 2;
          strongestSignals.push(`cast:${token}`);
        }
      });

      return { movie, score, index, strongestSignals: [...new Set(strongestSignals)].slice(0, 3) };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxResults);

  return {
    movies: ranked.map(({ movie }) => movie),
    debug: Object.fromEntries(
      ranked.map(({ movie, score, strongestSignals }) => [
        movie.id,
        {
          status: "local",
          mode: "local-text",
          score,
          strongestSignals: strongestSignals.length ? strongestSignals : ["metadata text"],
          reasonSource: "Local title, genre, overview, director, and cast text matching",
        } satisfies MovieDebugInfo,
      ])
    ),
  };
}

export async function searchMoviesSemantically(query: string, candidates: Movie[] = fallbackMovies): Promise<SearchWithDebugResult> {
  if (!query.trim()) return { movies: [], debug: {} };

  try {
    const response = await fetch(semanticSearchUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, movies: dedupeMovies(candidates) }),
    });

    if (!response.ok) throw new Error("Semantic search route unavailable");

    const data = (await response.json()) as SemanticSearchResponse;
    if (!Array.isArray(data.movies)) throw new Error("Invalid semantic search response");

    const movies = data.movies.filter(isMovie);
    const scores = data.debug?.scores || {};
    return {
      movies,
      debug: Object.fromEntries(
        movies.map((movie) => {
          const score = scores[String(movie.id)];
          const signals = [
            data.debug?.model ? `model:${data.debug.model}` : "semantic vectors",
            data.debug?.candidateCount ? `${data.debug.candidateCount} candidates` : "",
            data.debug?.cachedEmbeddingCount ? `${data.debug.cachedEmbeddingCount} cached` : "",
          ].filter(Boolean);
          return [
            movie.id,
            {
              status: data.debug?.status || "openai",
              mode: data.debug?.mode || "semantic-embedding",
              score: typeof score === "number" ? score : undefined,
              strongestSignals: signals.length ? signals : ["semantic similarity"],
              reasonSource: data.debug?.reasonSource || "Server-side semantic search",
            } satisfies MovieDebugInfo,
          ];
        })
      ),
    };
  } catch {
    const result = localSemanticSearchWithDebug(query, candidates);
    return {
      movies: result.movies,
      debug: Object.fromEntries(
        Object.entries(result.debug).map(([movieId, debug]) => [
          movieId,
          {
            ...debug,
            status: "fallback",
            reasonSource: "Semantic route unavailable; using local text fallback",
          },
        ])
      ),
    };
  }
}
