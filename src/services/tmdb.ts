import { fallbackMovies, genreIds } from "../data/fallbackMovies";
import type { AskBetterBoxdResult, AskFilter, Movie, MovieDebugInfo, MovieDebugMap } from "../types";
import { localSemanticSearchWithDebug, searchMoviesSemantically, type SearchWithDebugResult } from "./semanticSearch";

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
  popularity?: number;
};

type TmdbMovieDetail = TmdbMovie & {
  runtime?: number;
  genres?: Array<{ id: number; name: string }>;
  credits?: {
    cast?: Array<{ name: string; order: number }>;
    crew?: Array<{ name: string; job: string }>;
  };
};

type AskIntent = {
  filters: AskFilter[];
  genre?: string;
  yearFrom?: number;
  yearTo?: number;
  sortBy: string;
  semanticQuery: string;
};

type SearchCandidate = {
  movie: Movie;
  sourceRank: number;
  personMatch?: boolean;
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
  popularity: movie.popularity,
});

const genreNameToId = Object.fromEntries(Object.entries(genreIds).map(([id, name]) => [name.toLowerCase(), id]));
const genreAliases: Record<string, string> = {
  action: "Action",
  adventure: "Adventure",
  animated: "Animation",
  animation: "Animation",
  anime: "Animation",
  comedy: "Comedy",
  comedies: "Comedy",
  crime: "Crime",
  drama: "Drama",
  dramas: "Drama",
  fantasy: "Fantasy",
  historical: "History",
  history: "History",
  horror: "Horror",
  scary: "Horror",
  mystery: "Mystery",
  mysteries: "Mystery",
  music: "Music",
  musical: "Music",
  romance: "Romance",
  romantic: "Romance",
  "sci fi": "Sci-Fi",
  scifi: "Sci-Fi",
  "science fiction": "Sci-Fi",
  thriller: "Thriller",
  thrillers: "Thriller",
  war: "War",
};

const subjectiveTerms = [
  "bleak",
  "cozy",
  "dark",
  "emotional",
  "feel good",
  "funny",
  "gritty",
  "haunting",
  "mind bending",
  "moody",
  "slow burn",
  "tense",
  "thoughtful",
  "weird",
];

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
  popularity: movie.popularity,
});

async function tmdbFetch(path: string) {
  if (!apiKey) return null;
  const separator = path.includes("?") ? "&" : "?";
  const response = await fetch(`${apiBase}${path}${separator}api_key=${apiKey}`);
  if (!response.ok) throw new Error(`TMDB request failed: ${response.status}`);
  return response.json();
}

function dedupeMovies(movies: Movie[]) {
  const seen = new Set<number>();
  return movies.filter((movie) => {
    if (seen.has(movie.id)) return false;
    seen.add(movie.id);
    return true;
  });
}

function normalizeSearchText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function titleRelevanceScore(query: string, movie: Movie) {
  const normalizedQuery = normalizeSearchText(query);
  const title = normalizeSearchText(movie.title);
  if (!normalizedQuery || !title) return 0;

  const queryWords = normalizedQuery.split(" ").filter(Boolean);
  const titleWords = title.split(" ").filter(Boolean);
  const phraseIsShort = normalizedQuery.length <= 3;

  if (title === normalizedQuery) return 22000;
  if (titleWords.includes(normalizedQuery)) return phraseIsShort ? 9000 : 19000;
  if (title.startsWith(`${normalizedQuery} `) || title.startsWith(normalizedQuery)) return 12500;

  const prefixMatches = queryWords.filter((word) => titleWords.some((titleWord) => titleWord.startsWith(word))).length;
  if (prefixMatches === queryWords.length && prefixMatches > 0) return phraseIsShort ? 9000 : 10800;
  if (prefixMatches > 0) return phraseIsShort ? 5200 : 5800;

  if (!phraseIsShort && title.includes(normalizedQuery)) return 4200;

  const containedWords = queryWords.filter((word) => title.includes(word)).length;
  if (containedWords > 0) return phraseIsShort ? 1600 : 3200;

  return 0;
}

function popularityScore(movie: Movie) {
  return Math.min(Math.log10((movie.popularity || 0) + 1) * 1100, 3200);
}

function rankSearchCandidates(query: string, candidates: SearchCandidate[]) {
  const seen = new Set<number>();
  return candidates
    .map((candidate) => {
      const relevance = titleRelevanceScore(query, candidate.movie);
      const personBoost = candidate.personMatch ? 5600 : 0;
      const sourceRankBoost = Math.max(0, 900 - candidate.sourceRank * 35);
      return {
        ...candidate,
        score: relevance + personBoost + popularityScore(candidate.movie) + sourceRankBoost,
      };
    })
    .filter(({ movie, score }) => {
      if (seen.has(movie.id)) return false;
      seen.add(movie.id);
      return score > 0;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map(({ movie }) => movie);
}

function fastSearchDebug(movies: Movie[], status: string, mode: string, reasonSource: string): MovieDebugMap {
  return Object.fromEntries(
    movies.map((movie, index) => [
      movie.id,
      {
        status,
        mode,
        score: Number((1 / (index + 1)).toFixed(3)),
        strongestSignals: [index === 0 ? "top result" : `rank ${index + 1}`],
        reasonSource,
      } satisfies MovieDebugInfo,
    ])
  );
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
  return (await searchMoviesWithDebug(query)).movies;
}

export async function searchMoviesWithDebug(query: string): Promise<SearchWithDebugResult> {
  if (!query.trim()) return { movies: [], debug: {} };

  if (!apiKey) {
    const result = localSemanticSearchWithDebug(query, fallbackMovies);
    return {
      ...result,
      debug: Object.fromEntries(
        Object.entries(result.debug).map(([movieId, debug]) => [
          movieId,
          { ...debug, status: "local", mode: "local-keyword", reasonSource: "Local keyword, title, genre, and person matching" },
        ])
      ),
    };
  }

  try {
    const pageCount = query.trim().length <= 3 ? 5 : 2;
    const pages = await Promise.all(
      Array.from({ length: pageCount }, (_, index) => tmdbFetch(`/search/multi?query=${encodeURIComponent(query)}&include_adult=false&page=${index + 1}`))
    );
    const rawResults = pages.flatMap((data) => data?.results || []);
    if (!rawResults.length) return searchMoviesWithDebugFromFallback(query);

    const candidates = rawResults.flatMap((item: TmdbMovie & { media_type?: string; known_for?: TmdbMovie[] }, sourceRank: number) => {
      if (item.media_type === "movie") return [{ movie: mapMovie(item), sourceRank }];
      if (item.media_type === "person") {
        return (item.known_for || []).map((movie) => ({ movie: mapMovie(movie), sourceRank, personMatch: true }));
      }
      return [];
    });
    const results = rankSearchCandidates(query, candidates).filter((movie) => movie.posterPath);

    return {
      movies: results,
      debug: fastSearchDebug(results, "tmdb", "tmdb-keyword", "Fast TMDB title and person search without semantic ranking"),
    };
  } catch {
    return searchMoviesWithDebugFromFallback(query);
  }
}

function searchMoviesWithDebugFromFallback(query: string): SearchWithDebugResult {
  const result = localSemanticSearchWithDebug(query, fallbackMovies);
  return {
    ...result,
    debug: Object.fromEntries(
      Object.entries(result.debug).map(([movieId, debug]) => [
        movieId,
        { ...debug, status: "local", mode: "local-keyword", reasonSource: "Local keyword, title, genre, and person matching" },
      ])
    ),
  };
}

function parseAskIntent(query: string): AskIntent {
  const normalized = query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const filters: AskFilter[] = [];
  let genre: string | undefined;
  let yearFrom: number | undefined;
  let yearTo: number | undefined;
  let sortBy = "popularity.desc";
  const semanticTerms: string[] = [];

  Object.entries(genreAliases).some(([alias, name]) => {
    const pattern = new RegExp(`\\b${alias.replace(/\s+/g, "\\s+")}\\b`);
    if (!pattern.test(normalized)) return false;
    genre = name;
    filters.push({ label: "Genre", value: name });
    return true;
  });

  const decade = normalized.match(/\b(19|20)(\d)0s\b/);
  if (decade) {
    yearFrom = Number(`${decade[1]}${decade[2]}0`);
    yearTo = yearFrom + 9;
  }

  const yearRange = normalized.match(/\b((?:19|20)\d{2})\s*(?:to|-|through)\s*((?:19|20)\d{2})\b/);
  if (yearRange) {
    yearFrom = Number(yearRange[1]);
    yearTo = Number(yearRange[2]);
  }

  const afterYear = normalized.match(/\b(?:after|since|from)\s+((?:19|20)\d{2})\b/);
  const beforeYear = normalized.match(/\b(?:before|until|pre)\s+((?:19|20)\d{2})\b/);
  if (afterYear && !yearFrom) yearFrom = Number(afterYear[1]);
  if (beforeYear && !yearTo) yearTo = Number(beforeYear[1]);

  if (/\bnew|newer|recent|latest\b/.test(normalized)) {
    sortBy = "primary_release_date.desc";
    filters.push({ label: "Sort", value: "Newest first" });
  } else if (/\bclassic|older|old\b/.test(normalized)) {
    sortBy = "primary_release_date.asc";
    filters.push({ label: "Sort", value: "Oldest first" });
  } else if (/\bbest|top|highest rated|great\b/.test(normalized)) {
    sortBy = "vote_average.desc";
    filters.push({ label: "Sort", value: "Highest rated" });
  }

  if (yearFrom || yearTo) {
    filters.push({ label: "Years", value: yearFrom && yearTo ? `${yearFrom}-${yearTo}` : yearFrom ? `${yearFrom}+` : `Until ${yearTo}` });
  }

  subjectiveTerms.forEach((term) => {
    const pattern = new RegExp(`\\b${term.replace(/\s+/g, "\\s+")}\\b`);
    if (pattern.test(normalized)) semanticTerms.push(term);
  });

  const semanticQuery = [genre, ...semanticTerms, normalized]
    .filter(Boolean)
    .join(" ")
    .trim();

  return { filters, genre, yearFrom, yearTo, sortBy, semanticQuery };
}

function filterFallbackMovies(intent: AskIntent) {
  return fallbackMovies
    .filter((movie) => !intent.genre || movie.genres.some((genre) => genre.toLowerCase() === intent.genre?.toLowerCase()))
    .filter((movie) => {
      const year = Number(movie.year);
      if (!Number.isFinite(year)) return true;
      if (intent.yearFrom && year < intent.yearFrom) return false;
      if (intent.yearTo && year > intent.yearTo) return false;
      return true;
    });
}

async function discoverAskCandidates(intent: AskIntent): Promise<Movie[]> {
  if (!apiKey) return filterFallbackMovies(intent);

  const params = new URLSearchParams({
    include_adult: "false",
    include_video: "false",
    language: "en-US",
    page: "1",
    sort_by: intent.sortBy,
    "vote_count.gte": intent.sortBy === "vote_average.desc" ? "80" : "20",
  });

  if (intent.genre) {
    const genreId = genreNameToId[intent.genre.toLowerCase()];
    if (genreId) params.set("with_genres", genreId);
  }
  if (intent.yearFrom) params.set("primary_release_date.gte", `${intent.yearFrom}-01-01`);
  if (intent.yearTo) params.set("primary_release_date.lte", `${intent.yearTo}-12-31`);

  const pages = await Promise.all([1, 2].map((page) => {
    params.set("page", String(page));
    return tmdbFetch(`/discover/movie?${params.toString()}`);
  }));
  const results = pages.flatMap((data) => data?.results || []);
  if (!results.length) return filterFallbackMovies(intent);
  return dedupeMovies(results.map(mapMovie).filter((movie: Movie) => movie.posterPath)).slice(0, 32);
}

function explainAskIntent(intent: AskIntent, usedSemanticRanking: boolean) {
  if (!intent.filters.length && !usedSemanticRanking) {
    return "I treated this as a broad movie request and used available movie metadata.";
  }
  const understood = intent.filters.length ? intent.filters.map((filter) => `${filter.label.toLowerCase()} ${filter.value}`).join(", ") : "broad movie metadata";
  return `I understood: ${understood}. ${usedSemanticRanking ? "Fuzzy wording was used to reorder the filtered matches." : "Results use metadata filtering."}`;
}

export async function askBetterBoxd(query: string): Promise<AskBetterBoxdResult> {
  const trimmed = query.trim();
  if (!trimmed) return { movies: [], debug: {}, filters: [], explanation: "Ask for a genre, mood, era, or other movie request." };

  const intent = parseAskIntent(trimmed);

  try {
    const candidates = await discoverAskCandidates(intent);
    const hasFuzzyIntent = subjectiveTerms.some((term) => intent.semanticQuery.toLowerCase().includes(term)) || !intent.filters.length;
    const ranked = hasFuzzyIntent ? await searchMoviesSemantically(intent.semanticQuery || trimmed, candidates) : { movies: candidates, debug: fastSearchDebug(candidates, apiKey ? "tmdb" : "local", "metadata-filter", "Structured metadata filter match") };
    const movies = ranked.movies.length ? ranked.movies : candidates;
    const debug = ranked.movies.length ? ranked.debug : fastSearchDebug(candidates, apiKey ? "tmdb" : "local", "metadata-filter", "Structured metadata filter match");

    return {
      movies,
      debug,
      filters: intent.filters.length ? intent.filters : [{ label: "Intent", value: "Natural language" }],
      explanation: explainAskIntent(intent, hasFuzzyIntent),
    };
  } catch {
    const candidates = filterFallbackMovies(intent);
    const ranked = localSemanticSearchWithDebug(intent.semanticQuery || trimmed, candidates.length ? candidates : fallbackMovies);
    return {
      movies: ranked.movies,
      debug: Object.fromEntries(
        Object.entries(ranked.debug).map(([movieId, debug]) => [
          movieId,
          { ...debug, status: "fallback", reasonSource: "TMDB or semantic search was unavailable; using local movie matching" },
        ])
      ),
      filters: intent.filters.length ? intent.filters : [{ label: "Fallback", value: "Local matching" }],
      explanation: "I used local movie data because the richer search path was unavailable.",
    };
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
