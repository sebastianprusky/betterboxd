import { fallbackMovies, genreIds } from "../data/fallbackMovies";
import type {
  AskPickAMovieResult,
  Movie,
  MovieDebugInfo,
  MovieDebugMap,
  PersonSearchResult,
  PickFilters,
  StreamingAvailability,
  StreamingProvider,
} from "../types";
import {
  matchesAskConstraints,
  parseAskIntent,
  shouldUseSemanticRanking,
  type AskIntent,
} from "./promptIntent";
import { cosineSimilarity, embedText } from "./localEmbeddings";
import { buildMovieProfile } from "./movieProfiles";
import { localSemanticSearchWithDebug, searchMoviesSemantically, type SearchWithDebugResult } from "./semanticSearch";
import { planMovieSearch, type SearchPlan } from "./searchPlanner";

const configuredApiKey = import.meta.env.VITE_TMDB_API_KEY as string | undefined;
const apiKey = configuredApiKey && configuredApiKey.trim().length >= 20 && !configuredApiKey.includes("REDACTED") ? configuredApiKey.trim() : undefined;
const apiBase = "https://api.themoviedb.org/3";
const providerCacheKey = "pickamovie-provider-cache-v1";
const providerCacheTtl = 6 * 60 * 60 * 1000;
const movieDetailCache = new Map<number, Promise<Movie>>();
const movieDisplayDetailCache = new Map<number, Promise<Movie>>();

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
  original_language?: string;
};

type TmdbMovieDetail = TmdbMovie & {
  runtime?: number;
  genres?: Array<{ id: number; name: string }>;
  credits?: {
    cast?: Array<{ id?: number; name: string; order: number }>;
    crew?: Array<{ id?: number; name: string; job: string }>;
  };
  production_countries?: Array<{ name: string }>;
  keywords?: { keywords?: Array<{ id?: number; name: string }> };
  recommendations?: { results?: TmdbMovie[] };
  similar?: { results?: TmdbMovie[] };
  videos?: {
    results?: Array<{ key?: string; site?: string; type?: string; official?: boolean }>;
  };
};

type SearchCandidate = {
  movie: Movie;
  sourceRank: number;
  personMatch?: boolean;
};

type TmdbPersonCredits = {
  cast?: Array<TmdbMovie & { character?: string }>;
  crew?: Array<TmdbMovie & { job?: string }>;
};

type TmdbPersonSearchResult = {
  id: number;
  name?: string;
  known_for_department?: string;
  profile_path?: string | null;
  popularity?: number;
  known_for?: Array<TmdbMovie & { media_type?: string }>;
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
  originalLanguage: movie.original_language,
});

const genreNameToId = Object.fromEntries(Object.entries(genreIds).map(([id, name]) => [name.toLowerCase(), id]));
const mapMovieDetail = (movie: TmdbMovieDetail): Movie => {
  const youtubeVideos = movie.videos?.results?.filter((video) => video.site === "YouTube" && video.key) || [];
  const trailer = youtubeVideos.find((video) => video.type === "Trailer" && video.official)
    || youtubeVideos.find((video) => video.type === "Trailer")
    || youtubeVideos.find((video) => video.type === "Teaser");
  return {
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
    keywords: movie.keywords?.keywords?.slice(0, 12).map((keyword) => keyword.name),
    originalLanguage: movie.original_language,
    productionCountries: movie.production_countries?.slice(0, 3).map((country) => country.name),
    trailerKey: trailer?.key,
    recommendedMovieIds: movie.recommendations?.results?.slice(0, 12).map((recommendation) => recommendation.id),
    similarMovieIds: movie.similar?.results?.slice(0, 12).map((similar) => similar.id),
  };
};

async function tmdbFetch(path: string) {
  if (!apiKey) return null;
  const separator = path.includes("?") ? "&" : "?";
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${apiBase}${path}${separator}api_key=${apiKey}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`TMDB request failed: ${response.status}`);
    return response.json();
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function readProviderCache() {
  try {
    return JSON.parse(localStorage.getItem(providerCacheKey) || "{}") as Record<string, StreamingAvailability>;
  } catch {
    return {};
  }
}

function writeProviderCache(cache: Record<string, StreamingAvailability>) {
  try { localStorage.setItem(providerCacheKey, JSON.stringify(cache)); } catch { /* cache is optional */ }
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

export function profileUrl(path: string | null, size = "w185") {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : "";
}

export async function getTrendingMovies(): Promise<Movie[]> {
  const data = await tmdbFetch("/trending/movie/week");
  if (!data) return fallbackMovies;
  const movies = data.results.map(mapMovie).filter((movie: Movie) => movie.posterPath).slice(0, 18);
  return enrichMovies(movies, 10);
}

export async function getRecommendationCatalog(): Promise<Movie[]> {
  const pages = await Promise.allSettled([
    tmdbFetch("/movie/popular?page=1"),
    tmdbFetch("/movie/top_rated?page=1"),
    tmdbFetch("/movie/upcoming?page=1"),
  ]);
  const movies = new Map<number, Movie>();

  pages.forEach((result) => {
    if (result.status !== "fulfilled" || !result.value) return;
    result.value.results
      .map(mapMovie)
      .filter((movie: Movie) => movie.posterPath)
      .forEach((movie: Movie) => movies.set(movie.id, movie));
  });

  if (!movies.size) return fallbackMovies;
  return enrichMovies([...movies.values()].slice(0, 45), 14);
}

export async function getMovieWatchProviders(movieId: number, region: string): Promise<StreamingAvailability> {
  const normalizedRegion = region.toUpperCase();
  if (!apiKey) return { movieId, region: normalizedRegion, providers: [], checkedAt: Date.now(), status: "unavailable" };
  const cache = readProviderCache();
  const key = `${movieId}:${normalizedRegion}`;
  const cached = cache[key];
  if (cached && Date.now() - cached.checkedAt < providerCacheTtl) return cached;
  const data = await tmdbFetch(`/movie/${movieId}/watch/providers`);
  const country = data?.results?.[normalizedRegion];
  const availability: StreamingAvailability = {
    movieId,
    region: normalizedRegion,
    providers: (country?.flatrate || []).map((provider: { provider_id: number; provider_name: string; logo_path?: string }) => ({
      id: provider.provider_id,
      name: provider.provider_name,
      logoPath: provider.logo_path,
    })),
    link: country?.link,
    checkedAt: Date.now(),
    status: "verified",
  };
  cache[key] = availability;
  writeProviderCache(cache);
  return availability;
}

export async function getStreamingProviders(region: string): Promise<StreamingProvider[]> {
  const data = await tmdbFetch(`/watch/providers/movie?watch_region=${encodeURIComponent(region.toUpperCase())}&language=en-US`);
  if (!data?.results) return [];
  return data.results
    .map((provider: { provider_id: number; provider_name: string; logo_path?: string; display_priority?: number }) => ({
      id: provider.provider_id,
      name: provider.provider_name,
      logoPath: provider.logo_path,
      priority: provider.display_priority || 999,
    }))
    .sort((a: StreamingProvider & { priority: number }, b: StreamingProvider & { priority: number }) => a.priority - b.priority)
    .slice(0, 24)
    .map(({ id, name, logoPath }: StreamingProvider & { priority: number }) => ({ id, name, logoPath }));
}

async function getNowPlayingMovies(region: string): Promise<Movie[]> {
  if (!apiKey) return [];
  const pages = await Promise.all([1, 2, 3].map((page) =>
    tmdbFetch(`/movie/now_playing?region=${encodeURIComponent(region.toUpperCase())}&page=${page}`)
  ));
  return dedupeMovies(pages.flatMap((page) => page?.results || []).map(mapMovie))
    .filter((movie) => movie.posterPath);
}

export async function getNowPlayingMovieIds(region: string): Promise<Set<number>> {
  return new Set((await getNowPlayingMovies(region)).map((movie) => movie.id));
}

export async function discoverPickMovies(filters: PickFilters): Promise<Movie[]> {
  if (!apiKey) {
    return fallbackMovies.filter((movie) => matchesPickFilters(movie, filters));
  }
  const params = new URLSearchParams({
    include_adult: "false",
    include_video: "false",
    sort_by: "popularity.desc",
    "vote_count.gte": "40",
    page: "1",
  });
  if (filters.genres.length) {
    const genreValues = filters.genres.map((genre) => genreNameToId[genre.toLowerCase()]).filter(Boolean);
    if (genreValues.length) params.set("with_genres", genreValues.join("|"));
  }
  if (filters.runtimeMin > 30) params.set("with_runtime.gte", String(filters.runtimeMin));
  if (filters.runtimeMax < 300) params.set("with_runtime.lte", String(filters.runtimeMax));
  const eraMap: Record<string, [string, string]> = {
    recent: ["2020-01-01", "2099-12-31"], "2010s": ["2010-01-01", "2019-12-31"],
    "2000s": ["2000-01-01", "2009-12-31"], "1990s": ["1990-01-01", "1999-12-31"],
    "1980s": ["1980-01-01", "1989-12-31"], "1970s": ["1970-01-01", "1979-12-31"],
    "1960s": ["1960-01-01", "1969-12-31"], pre1960: ["1900-01-01", "1959-12-31"],
  };
  if (filters.eras.length === 1 && eraMap[filters.eras[0]]) {
    params.set("primary_release_date.gte", eraMap[filters.eras[0]][0]);
    params.set("primary_release_date.lte", eraMap[filters.eras[0]][1]);
  }
  if (filters.providerIds.length) {
    params.set("watch_region", filters.region);
    params.set("with_watch_monetization_types", "flatrate");
    params.set("with_watch_providers", filters.providerIds.join("|"));
  }
  const shouldDiscover = !filters.includeTheaters || filters.providerIds.length > 0;
  const [pages, theaterMovies] = await Promise.all([
    shouldDiscover ? Promise.all([1, 2, 3].map((page) => {
      const pageParams = new URLSearchParams(params);
      pageParams.set("page", String(page));
      return tmdbFetch(`/discover/movie?${pageParams.toString()}`);
    })) : Promise.resolve([]),
    filters.includeTheaters ? getNowPlayingMovies(filters.region) : Promise.resolve([]),
  ]);
  const movies = dedupeMovies([
    ...theaterMovies,
    ...pages.flatMap((page) => page?.results || []).map(mapMovie),
  ]).filter((movie) => movie.posterPath);
  const enriched = await enrichMovies(movies.slice(0, 60), 24);
  return enriched.filter((movie) => matchesPickFilters(movie, filters));
}

export function matchesPickFilters(movie: Movie, filters: PickFilters) {
  if (filters.genres.length && !movie.genres.some((genre) => filters.genres.some((selected) => selected.toLowerCase() === genre.toLowerCase()))) return false;
  const runtimeConstrained = filters.runtimeMin > 30 || filters.runtimeMax < 300;
  if (runtimeConstrained && (!movie.runtime || movie.runtime < filters.runtimeMin || movie.runtime > filters.runtimeMax)) return false;
  const year = Number(movie.year);
  if (filters.eras.length) {
    const inSelectedEra = filters.eras.some((era) =>
      (era === "recent" && year >= 2020) ||
      (era === "2010s" && year >= 2010 && year <= 2019) ||
      (era === "2000s" && year >= 2000 && year <= 2009) ||
      (era === "1990s" && year >= 1990 && year <= 1999) ||
      (era === "1980s" && year >= 1980 && year <= 1989) ||
      (era === "1970s" && year >= 1970 && year <= 1979) ||
      (era === "1960s" && year >= 1960 && year <= 1969) ||
      (era === "pre1960" && year < 1960)
    );
    if (!inSelectedEra) return false;
  }
  return true;
}

export async function getTasteSprintMovies(page: number): Promise<{ movies: Movie[]; hasMore: boolean }> {
  if (!apiKey) return { movies: [], hasMore: false };

  const safePage = Math.min(Math.max(Math.floor(page), 1), 500);
  const data = await tmdbFetch(
    `/discover/movie?sort_by=popularity.desc&include_adult=false&include_video=false&vote_count.gte=50&page=${safePage}`
  );
  const movies = dedupeMovies((data?.results || []).map(mapMovie))
    .filter((movie) => movie.posterPath);
  const lastPage = Math.min(Number(data?.total_pages) || safePage, 500);

  return { movies, hasMore: safePage < lastPage };
}

export async function searchMovies(query: string): Promise<Movie[]> {
  return (await searchMoviesWithDebug(query)).movies;
}

export async function searchPeople(query: string, kind: "actors" | "directors"): Promise<PersonSearchResult[]> {
  if (!apiKey || query.trim().length < 2) return [];
  const data = await tmdbFetch(`/search/person?query=${encodeURIComponent(query.trim())}&include_adult=false&page=1`);
  const preferredDepartment = kind === "actors" ? "Acting" : "Directing";
  const people = (data?.results || [])
    .map((person: TmdbPersonSearchResult) => ({
      id: person.id,
      name: person.name || "Unknown person",
      department: person.known_for_department,
      profilePath: person.profile_path || null,
      knownFor: (person.known_for || [])
        .filter((credit) => credit.media_type === "movie" || credit.title)
        .slice(0, 3)
        .map((credit) => credit.title || credit.name || "")
        .filter(Boolean),
      popularity: person.popularity || 0,
    }))
    .sort((a: PersonSearchResult & { popularity: number }, b: PersonSearchResult & { popularity: number }) => Number(b.department === preferredDepartment) - Number(a.department === preferredDepartment) || b.popularity - a.popularity)
    .slice(0, 10);
  if (kind === "actors") {
    return people
      .filter((person: PersonSearchResult & { popularity: number }) => person.department === "Acting")
      .map(({ popularity: _popularity, ...person }: PersonSearchResult & { popularity: number }) => person);
  }
  const verified = await Promise.allSettled(people.slice(0, 6).map(async (person: PersonSearchResult & { popularity: number }) => {
    const credits = await tmdbFetch(`/person/${person.id}/movie_credits?language=en-US`) as TmdbPersonCredits | null;
    const directed = (credits?.crew || [])
      .filter((credit) => credit.job === "Director")
      .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
      .map((credit) => credit.title || credit.name || "")
      .filter(Boolean)
      .filter((title, index, titles) => titles.indexOf(title) === index)
      .slice(0, 3);
    if (!directed.length) return null;
    return { id: person.id, name: person.name, department: "Directing", profilePath: person.profilePath, knownFor: directed } satisfies PersonSearchResult;
  }));
  return verified.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
}

export async function searchMoviesWithDebug(query: string): Promise<SearchWithDebugResult> {
  if (!query.trim()) return { movies: [], debug: {} };

  if (!apiKey) {
    const result = pruneLocalTitleSearch(localSemanticSearchWithDebug(query, fallbackMovies));
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
    const enrichedResults = await enrichMovies(results, 6);

    return {
      movies: enrichedResults,
      debug: fastSearchDebug(enrichedResults, "tmdb", "tmdb-keyword", "Fast TMDB title and person search without semantic ranking"),
    };
  } catch {
    return searchMoviesWithDebugFromFallback(query);
  }
}

function searchMoviesWithDebugFromFallback(query: string): SearchWithDebugResult {
  const result = pruneLocalTitleSearch(localSemanticSearchWithDebug(query, fallbackMovies));
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

function pruneLocalTitleSearch(result: SearchWithDebugResult): SearchWithDebugResult {
  const movies = result.movies.filter((movie) => (result.debug[movie.id]?.score || 0) >= 2.5).slice(0, 10);
  return { movies, debug: Object.fromEntries(movies.map((movie) => [movie.id, result.debug[movie.id]])) };
}

function filterFallbackMovies(intent: AskIntent) {
  return fallbackMovies.filter((movie) => matchesAskConstraints(movie, intent));
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

type AnchoredCandidates = {
  movies: Movie[];
  promptScores: Record<number, number>;
  resolvedReferenceTitle?: string;
  referenceMovieId?: number;
};

type PlannedCandidates = {
  movies: Movie[];
  promptScores: Record<number, number>;
};

function intentWithPlan(intent: AskIntent, plan: SearchPlan | null): AskIntent {
  if (!plan) return intent;
  const plannedGenre = plan.genres.map((genre) => genreNameToId[genre.toLowerCase()] ? genre : undefined).find(Boolean);
  return {
    ...intent,
    genre: plannedGenre || intent.genre,
    yearFrom: plan.yearFrom || intent.yearFrom,
    yearTo: plan.yearTo || intent.yearTo,
    sortBy: plan.sortBy === "rating" ? "vote_average.desc"
      : plan.sortBy === "release_date" ? "primary_release_date.desc"
      : intent.sortBy,
    semanticQuery: plan.semanticQuery || intent.semanticQuery,
  };
}

async function resolveTmdbEntityIds(kind: "company" | "keyword" | "person", names: string[]) {
  const resolved = await Promise.all(names.slice(0, 5).map(async (name) => {
    const data = await tmdbFetch(`/search/${kind}?query=${encodeURIComponent(name)}&page=1`);
    return Number(data?.results?.[0]?.id) || null;
  }));
  return resolved.filter((id): id is number => Boolean(id));
}

async function discoverPlannedCandidates(plan: SearchPlan | null, intent: AskIntent): Promise<PlannedCandidates> {
  if (!apiKey || !plan) return { movies: [], promptScores: {} };
  const genericKeywords = new Set(["action", "adventure", "animation", "comedy", "drama", "fantasy", "horror", "romance", "science fiction", "superhero", "thriller"]);
  const sourceKeywords = plan.keywordNames.filter((keyword) => !genericKeywords.has(normalizeSearchText(keyword)));

  const [titleResponses, termResponses, companyIds, keywordIds, personIds] = await Promise.all([
    Promise.all(plan.seedTitles.slice(0, 20).map((title) => tmdbFetch(`/search/movie?query=${encodeURIComponent(title)}&include_adult=false&page=1`))),
    Promise.all((plan.resultMode === "curated" ? plan.searchTerms.slice(0, 4) : []).map((term) => tmdbFetch(`/search/movie?query=${encodeURIComponent(term)}&include_adult=false&page=1`))),
    resolveTmdbEntityIds("company", plan.companyNames),
    resolveTmdbEntityIds("keyword", sourceKeywords),
    resolveTmdbEntityIds("person", plan.personNames),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const isReleased = (movie: TmdbMovie) => plan.includeUnreleased || !movie.release_date || movie.release_date <= today;
  const seedMovies = titleResponses.flatMap((response, index) => {
    const expected = normalizeSearchText(plan.seedTitles[index] || "");
    const results = ((response?.results || []) as TmdbMovie[]).filter(isReleased);
    const exact = results.find((movie) => normalizeSearchText(movie.title || movie.name || "") === expected) || results[0];
    return exact ? [mapMovie(exact)] : [];
  });
  const textMovies = plan.resultMode === "curated"
    ? termResponses.flatMap((response) => ((response?.results || []) as TmdbMovie[]).filter(isReleased).slice(0, 8).map(mapMovie))
    : [];

  const baseParams = new URLSearchParams({
    include_adult: "false",
    include_video: "false",
    language: "en-US",
    sort_by: intent.sortBy,
    "vote_count.gte": "10",
  });
  if (intent.genre) {
    const genreId = genreNameToId[intent.genre.toLowerCase()];
    if (genreId) baseParams.set("with_genres", String(genreId));
  }
  if (intent.yearFrom) baseParams.set("primary_release_date.gte", `${intent.yearFrom}-01-01`);
  if (intent.yearTo) baseParams.set("primary_release_date.lte", `${intent.yearTo}-12-31`);
  if (!plan.includeUnreleased) {
    const currentUpperBound = baseParams.get("primary_release_date.lte");
    if (!currentUpperBound || currentUpperBound > today) baseParams.set("primary_release_date.lte", today);
  }

  const entityFilters: Array<[string, number[]]> = [
    ["with_companies", companyIds],
    ["with_keywords", keywordIds],
    ["with_people", personIds],
  ];
  const discoverRequests = entityFilters.flatMap(([key, ids]) => ids.length ? [1, 2].map((page) => {
    const params = new URLSearchParams(baseParams);
    params.set(key, ids.join("|"));
    params.set("page", String(page));
    return tmdbFetch(`/discover/movie?${params.toString()}`);
  }) : []);
  const discoveredResponses = await Promise.all(discoverRequests);
  const discoveredMovies = discoveredResponses.flatMap((response) => ((response?.results || []) as TmdbMovie[]).filter(isReleased).map(mapMovie));

  const ordered = dedupeMovies([...seedMovies, ...discoveredMovies, ...textMovies])
    .filter((movie) => movie.posterPath
      && matchesAskConstraints(movie, intent)
      && (!intent.referenceTitle || normalizeSearchText(movie.title) !== normalizeSearchText(intent.referenceTitle)))
    .slice(0, 40);
  const seedRank = new Map(seedMovies.map((movie, index) => [movie.id, index]));
  const promptScores = Object.fromEntries(ordered.map((movie, index) => {
    const seedIndex = seedRank.get(movie.id);
    return [movie.id, seedIndex === undefined ? Math.max(.56, .80 - index * .01) : Math.max(.82, 1 - seedIndex * .02)];
  }));
  return { movies: ordered, promptScores };
}

async function discoverAnchoredCandidates(intent: AskIntent): Promise<AnchoredCandidates> {
  if (!apiKey || !intent.referenceTitle) return { movies: [], promptScores: {} };
  const timingStartedAt = globalThis.performance?.now?.() || Date.now();
  const logTiming = (stage: string) => {
    if (import.meta.env.DEV) console.debug("[prompt-timing]", stage, Math.round((globalThis.performance?.now?.() || Date.now()) - timingStartedAt));
  };

  const search = await tmdbFetch(`/search/movie?query=${encodeURIComponent(intent.referenceTitle)}&include_adult=false&page=1`);
  logTiming("reference-resolved");
  const searchResults = (search?.results || []) as TmdbMovie[];
  const normalizedReference = normalizeSearchText(intent.referenceTitle);
  const reference = searchResults.find((movie) => normalizeSearchText(movie.title || movie.name || "") === normalizedReference)
    || searchResults.find((movie) => normalizeSearchText(movie.title || movie.name || "").startsWith(normalizedReference))
    || searchResults[0];
  if (!reference) return { movies: [], promptScores: {} };

  const detail = await tmdbFetch(`/movie/${reference.id}?append_to_response=credits,keywords,recommendations,similar`) as TmdbMovieDetail | null;
  logTiming("relationships-loaded");
  if (!detail) return { movies: [], promptScores: {}, resolvedReferenceTitle: reference.title || reference.name, referenceMovieId: reference.id };

  const leadActorId = [...(detail.credits?.cast || [])].sort((a, b) => a.order - b.order)[0]?.id;
  const directorId = detail.credits?.crew?.find((person) => person.job === "Director")?.id;
  const [leadCredits, directorCredits] = await Promise.all([
    leadActorId ? tmdbFetch(`/person/${leadActorId}/movie_credits?language=en-US`) as Promise<TmdbPersonCredits | null> : Promise.resolve(null),
    directorId ? tmdbFetch(`/person/${directorId}/movie_credits?language=en-US`) as Promise<TmdbPersonCredits | null> : Promise.resolve(null),
  ]);
  logTiming("people-credits-loaded");

  const recommendationScored = ((detail.recommendations?.results || []) as TmdbMovie[]).slice(0, 12).map((movie, index) => ({ movie: mapMovie(movie), score: Math.max(0.78, 0.98 - index * 0.016) }));
  const similarScored = ((detail.similar?.results || []) as TmdbMovie[]).slice(0, 10).map((movie, index) => ({ movie: mapMovie(movie), score: Math.max(0.74, 0.93 - index * 0.016) }));
  const leadScored = ((leadCredits?.cast || []) as TmdbMovie[])
      .sort((a, b) => (b.popularity || 0) - (a.popularity || 0) || (b.vote_average || 0) - (a.vote_average || 0))
      .slice(0, 10)
      .map((movie) => ({ movie: mapMovie(movie), score: 0.72 }));
  const directorScored = ((directorCredits?.crew || []).filter((movie) => movie.job === "Director") as TmdbMovie[])
      .sort((a, b) => (b.popularity || 0) - (a.popularity || 0) || (b.vote_average || 0) - (a.vote_average || 0))
      .slice(0, 6)
      .map((movie) => ({ movie: mapMovie(movie), score: 0.68 }));
  const scored = [...recommendationScored, ...similarScored, ...leadScored, ...directorScored];
  const leadMovieIds = new Set(leadScored.map(({ movie }) => movie.id));
  const directorMovieIds = new Set(directorScored.map(({ movie }) => movie.id));
  const scoredById = new Map<number, { movie: Movie; score: number }>();
  scored.forEach((candidate) => {
    const existing = scoredById.get(candidate.movie.id);
    if (!existing || candidate.score > existing.score) scoredById.set(candidate.movie.id, candidate);
  });
  const related = [...scoredById.values()]
    .filter(({ movie }) => movie.id !== reference.id && movie.posterPath && matchesAskConstraints(movie, intent))
    .sort((a, b) => b.score - a.score || (b.movie.popularity || 0) - (a.movie.popularity || 0))
    .slice(0, 32);
  const enriched = related.map(({ movie }) => movie);
  const scoreById = new Map(related.map(({ movie, score }) => [movie.id, score]));
  const referenceMovie = mapMovieDetail(detail);
  const referenceKeywords = new Set((referenceMovie.keywords || []).map(normalizeSearchText));
  const referenceGenres = new Set(referenceMovie.genres.map(normalizeSearchText));
  enriched.forEach((movie) => {
    const base = scoreById.get(movie.id) || 0.55;
    const sharedKeywords = (movie.keywords || []).filter((keyword) => referenceKeywords.has(normalizeSearchText(keyword))).length;
    const sharedGenres = movie.genres.filter((genre) => referenceGenres.has(normalizeSearchText(genre))).length;
    const sameLead = leadMovieIds.has(movie.id);
    const sameDirector = directorMovieIds.has(movie.id);
    const profileSimilarity = Math.max(0, cosineSimilarity(embedText(buildMovieProfile(referenceMovie)), embedText(buildMovieProfile(movie))));
    const evidenceBoost = (sameLead ? 0.14 : 0) + (sameDirector ? 0.12 : 0) + Math.min(0.14, sharedKeywords * 0.045) + Math.min(0.06, sharedGenres * 0.03) + profileSimilarity * 0.08;
    scoreById.set(movie.id, Math.min(1, base + evidenceBoost));
  });

  const rankedEnriched = [...enriched].sort((a, b) => (scoreById.get(b.id) || 0) - (scoreById.get(a.id) || 0));
  return {
    movies: rankedEnriched,
    promptScores: Object.fromEntries(rankedEnriched.map((movie) => [movie.id, scoreById.get(movie.id) || 0.65])),
    resolvedReferenceTitle: reference.title || reference.name,
    referenceMovieId: reference.id,
  };
}

function explainAskIntent(intent: AskIntent, semanticMode: "remote" | "local" | "none", resolvedReferenceTitle?: string) {
  if (intent.referenceTitle && !apiKey) {
    return `I recognized “similar to ${intent.referenceTitle},” but reference-title search needs TMDB. These are limited local-catalog matches.`;
  }
  if (intent.referenceTitle && resolvedReferenceTitle) {
    const constraint = intent.filters.length ? ` that also match ${intent.filters.map((filter) => `${filter.label.toLowerCase()} ${filter.value}`).join(", ")}` : "";
    return `I matched “${resolvedReferenceTitle}” and ranked related movies${constraint}.`;
  }
  if (intent.referenceTitle) {
    return `I could not resolve “${intent.referenceTitle},” so these are broader metadata matches.`;
  }
  if (!intent.filters.length && semanticMode === "none") {
    return "I treated this as a broad movie request and used available movie metadata.";
  }
  const understood = intent.filters.length ? intent.filters.map((filter) => `${filter.label.toLowerCase()} ${filter.value}`).join(", ") : "broad movie metadata";
  if (semanticMode === "remote") return `I understood: ${understood}. Semantic similarity reordered the matches.`;
  if (semanticMode === "local") return `I understood: ${understood}. Local text matching reordered the available catalog.`;
  return `I understood: ${understood}. Results use metadata filtering.`;
}

export async function askPickAMovie(query: string): Promise<AskPickAMovieResult> {
  const trimmed = query.trim();
  if (!trimmed) return { movies: [], debug: {}, filters: [], promptScores: {}, serviceStatus: "metadata-only", explanation: "Ask for a genre, era, franchise, or other movie request.", resultMode: "curated" };

  const parsedIntent = parseAskIntent(trimmed);
  const plan = await planMovieSearch(trimmed);
  const intent = intentWithPlan(parsedIntent, plan);

  try {
    const [anchored, planned] = await Promise.all([
      discoverAnchoredCandidates(intent),
      discoverPlannedCandidates(plan, intent),
    ]);
    const discovered = anchored.movies.length || planned.movies.length ? [] : await discoverAskCandidates(intent);
    const candidates = dedupeMovies([...planned.movies, ...anchored.movies, ...discovered])
      .filter((movie) => movie.id !== anchored.referenceMovieId)
      .slice(0, 40);
    let semanticMode: "remote" | "local" | "none" = "none";
    const promptScores: Record<number, number> = Object.fromEntries(Object.entries(anchored.promptScores).map(([movieId, score]) => [movieId, planned.movies.length ? Math.min(.79, score) : score]));
    Object.assign(promptScores, planned.promptScores);
    let ranked = { movies: candidates, debug: fastSearchDebug(candidates, apiKey ? "tmdb" : "local", "metadata-filter", "Structured metadata filter match") };
    if (plan?.resultMode !== "collection" && shouldUseSemanticRanking(intent) && candidates.length) {
      try {
        const semantic = await searchMoviesSemantically(intent.semanticQuery || trimmed, candidates);
        if (semantic.movies.length) {
          ranked = semantic;
          semanticMode = Object.values(semantic.debug).some((debug) => debug.status === "openai") ? "remote" : "local";
        }
      } catch {
        const local = localSemanticSearchWithDebug(intent.semanticQuery || trimmed, candidates);
        if (local.movies.length) {
          ranked = local;
          semanticMode = "local";
        }
      }
    }
    const movies = ranked.movies.length
      ? dedupeMovies([...ranked.movies, ...anchored.movies]).filter((movie) => movie.id !== anchored.referenceMovieId).slice(0, 32)
      : candidates;
    const debug = ranked.movies.length ? ranked.debug : fastSearchDebug(candidates, apiKey ? "tmdb" : "local", "metadata-filter", "Structured metadata filter match");
    movies.forEach((movie, index) => {
      const semanticScore = debug[movie.id]?.score;
      const normalizedSemanticScore = typeof semanticScore === "number" && semanticMode === "remote" ? Math.max(0, Math.min(1, (semanticScore + 1) / 2)) : 0;
      const rankScore = Math.max(0.35, 0.78 - index * 0.018);
      if (promptScores[movie.id] === undefined) {
        const inferredScore = Math.max(normalizedSemanticScore, rankScore);
        promptScores[movie.id] = planned.movies.length ? Math.min(.79, inferredScore) : inferredScore;
      }
    });

    const displayReadyMovies = await enrichMovieDisplayDetails(movies, 6);
    return {
      movies: displayReadyMovies,
      debug,
      filters: intent.filters,
      promptScores,
      serviceStatus: !apiKey ? "local-fallback" : semanticMode === "remote" ? "full" : "metadata-only",
      explanation: plan?.interpretation || explainAskIntent(intent, semanticMode, anchored.resolvedReferenceTitle),
      resultMode: plan?.resultMode || "curated",
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
      promptScores: Object.fromEntries(ranked.movies.map((movie, index) => [movie.id, Math.max(0.35, 0.75 - index * 0.025)])),
      serviceStatus: "local-fallback",
      explanation: intent.referenceTitle
        ? `I recognized “similar to ${intent.referenceTitle},” but richer reference search was unavailable. These are limited local-catalog matches.`
        : "I used local movie data because the richer search path was unavailable.",
      resultMode: plan?.resultMode || "curated",
    };
  }
}

export async function getMovieDetails(movie: Movie): Promise<Movie> {
  const cached = movieDetailCache.get(movie.id);
  if (cached) return cached;
  const request = tmdbFetch(`/movie/${movie.id}?append_to_response=credits,keywords,recommendations,similar,videos`)
    .then((data) => data ? mapMovieDetail(data) : fallbackMovies.find((fallback) => fallback.id === movie.id) || movie)
    .catch((error) => {
      movieDetailCache.delete(movie.id);
      throw error;
    });
  movieDetailCache.set(movie.id, request);
  return request;
}

export async function getMovieDisplayDetails(movie: Movie): Promise<Movie> {
  if (movie.runtime) return movie;
  const cached = movieDisplayDetailCache.get(movie.id);
  if (cached) return cached;
  const request = tmdbFetch(`/movie/${movie.id}?language=en-US`)
    .then((data) => data?.runtime ? { ...movie, runtime: data.runtime } : movie)
    .catch((error) => {
      movieDisplayDetailCache.delete(movie.id);
      throw error;
    });
  movieDisplayDetailCache.set(movie.id, request);
  return request;
}

async function enrichMovieDisplayDetails(movies: Movie[], limit: number) {
  if (!apiKey) return movies;
  const enriched = await Promise.allSettled(movies.slice(0, limit).map(getMovieDisplayDetails));
  const enrichedById = new Map<number, Movie>();
  enriched.forEach((result) => {
    if (result.status === "fulfilled") enrichedById.set(result.value.id, result.value);
  });
  return movies.map((movie) => enrichedById.get(movie.id) || movie);
}

async function enrichMovies(movies: Movie[], limit: number) {
  if (!apiKey) return movies;
  const enriched = await Promise.allSettled(movies.slice(0, limit).map(getMovieDetails));
  const enrichedById = new Map<number, Movie>();

  enriched.forEach((result) => {
    if (result.status === "fulfilled") enrichedById.set(result.value.id, result.value);
  });

  return movies.map((movie) => enrichedById.get(movie.id) || movie);
}

export function hasTmdbKey() {
  return Boolean(apiKey);
}
