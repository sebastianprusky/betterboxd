declare const process: { env: Record<string, string | undefined> };

type NodeRequest = {
  method?: string;
  body?: unknown;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  on?: (event: "data" | "end" | "error", callback: (chunk?: { toString: (encoding?: string) => string }) => void) => void;
};

type NodeResponse = {
  statusCode: number;
  setHeader: (name: string, value: string) => void;
  end: (body?: string) => void;
};

type SearchFilters = {
  genres: string[];
  eras: string[];
  runtimeMin: number;
  runtimeMax: number;
};

type SearchBody = { query?: unknown; filters?: unknown };
type SearchResult = { status: number; body: unknown };

type ResearchCandidate = {
  title: string;
  year: number | null;
  inclusionReason: string;
  matchedConstraints: string[];
  confidence: number;
};

type HardConstraints = {
  yearMin: number | null;
  yearMax: number | null;
  genres: string[];
  people: string[];
  franchise: string | null;
  runtimeMin: number | null;
  runtimeMax: number | null;
  exclusions: string[];
};

type SoftPreferences = {
  tones: string[];
  themes: string[];
  pacing: string[];
  familiarity: string | null;
  similarityQualities: string[];
};

type ResearchResult = {
  interpretation: string;
  resultMode: "curated" | "collection";
  includeUnreleased: boolean;
  hardConstraints: HardConstraints;
  softPreferences: SoftPreferences;
  referenceMovie: { title: string; year: number | null } | null;
  candidates: ResearchCandidate[];
};

type TmdbMovie = {
  id: number;
  title?: string;
  original_title?: string;
  release_date?: string;
  poster_path: string | null;
  backdrop_path?: string | null;
  overview?: string;
  genre_ids?: number[];
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  original_language?: string;
  adult?: boolean;
};

type TmdbMovieDetail = TmdbMovie & {
  runtime?: number;
  genres?: Array<{ id: number; name: string }>;
  credits?: {
    cast?: Array<{ id?: number; name: string; order: number }>;
    crew?: Array<{ id?: number; name: string; job: string }>;
  };
  production_companies?: Array<{ name: string }>;
  belongs_to_collection?: { name?: string } | null;
  production_countries?: Array<{ name: string }>;
  keywords?: { keywords?: Array<{ name: string }> };
  recommendations?: { results?: TmdbMovie[] };
  similar?: { results?: TmdbMovie[] };
  videos?: { results?: Array<{ key?: string; site?: string; type?: string; official?: boolean }> };
};

type Movie = {
  id: number;
  title: string;
  year: string;
  posterPath: string | null;
  backdropPath?: string | null;
  overview: string;
  genres: string[];
  voteAverage?: number;
  voteCount?: number;
  runtime?: number;
  director?: string;
  cast?: string[];
  popularity?: number;
  keywords?: string[];
  originalLanguage?: string;
  productionCountries?: string[];
  trailerKey?: string;
  similarMovieIds?: number[];
  recommendedMovieIds?: number[];
};

type ResolvedCandidate = {
  movie: Movie;
  research?: ResearchCandidate;
  researchRank: number;
  source: "seed" | "recommendation" | "similar" | "shared-person" | "discover";
  relationship?: string;
  companies: string[];
  collection?: string;
  releaseDate?: string;
};

const searchModel = "gpt-5.6-luna";
const apiBase = "https://api.themoviedb.org/3";
const maxRequestBytes = 8_000;
const maxQueryLength = 240;
const rateLimitWindowMs = 60_000;
const maxRequestsPerWindow = 12;
const stableCacheTtlMs = 24 * 60 * 60 * 1000;
const freshCacheTtlMs = 20 * 60 * 1000;
const maxModelOutputTokens = 2_200;
const lunaInputPricePerMillion = 0.20;
const lunaOutputPricePerMillion = 1.20;

type RateLimitEntry = { count: number; resetAt: number };
type CacheEntry = { value: unknown; expiresAt: number };

class RequestBodyError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const sharedState = globalThis as typeof globalThis & {
  __pickAMovieAiSearchRateLimits?: Map<string, RateLimitEntry>;
  __pickAMovieAiSearchCache?: Map<string, CacheEntry>;
};
const rateLimits = sharedState.__pickAMovieAiSearchRateLimits ?? new Map<string, RateLimitEntry>();
const resultCache = sharedState.__pickAMovieAiSearchCache ?? new Map<string, CacheEntry>();
sharedState.__pickAMovieAiSearchRateLimits = rateLimits;
sharedState.__pickAMovieAiSearchCache = resultCache;

const researchSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    interpretation: { type: "string", maxLength: 240 },
    resultMode: { type: "string", enum: ["curated", "collection"] },
    includeUnreleased: { type: "boolean" },
    hardConstraints: {
      type: "object",
      additionalProperties: false,
      properties: {
        yearMin: { type: ["integer", "null"], minimum: 1880, maximum: 2100 },
        yearMax: { type: ["integer", "null"], minimum: 1880, maximum: 2100 },
        genres: { type: "array", maxItems: 5, items: { type: "string", maxLength: 40 } },
        people: { type: "array", maxItems: 5, items: { type: "string", maxLength: 80 } },
        franchise: { type: ["string", "null"], maxLength: 100 },
        runtimeMin: { type: ["integer", "null"], minimum: 30, maximum: 300 },
        runtimeMax: { type: ["integer", "null"], minimum: 30, maximum: 300 },
        exclusions: { type: "array", maxItems: 6, items: { type: "string", maxLength: 80 } },
      },
      required: ["yearMin", "yearMax", "genres", "people", "franchise", "runtimeMin", "runtimeMax", "exclusions"],
    },
    softPreferences: {
      type: "object",
      additionalProperties: false,
      properties: {
        tones: { type: "array", maxItems: 5, items: { type: "string", maxLength: 60 } },
        themes: { type: "array", maxItems: 5, items: { type: "string", maxLength: 60 } },
        pacing: { type: "array", maxItems: 3, items: { type: "string", maxLength: 40 } },
        familiarity: { type: ["string", "null"], maxLength: 40 },
        similarityQualities: { type: "array", maxItems: 6, items: { type: "string", maxLength: 80 } },
      },
      required: ["tones", "themes", "pacing", "familiarity", "similarityQualities"],
    },
    referenceMovie: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string", maxLength: 120 },
            year: { type: ["integer", "null"], minimum: 1880, maximum: 2100 },
          },
          required: ["title", "year"],
        },
      ],
    },
    candidates: {
      type: "array",
      minItems: 3,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", maxLength: 120 },
          year: { type: ["integer", "null"], minimum: 1880, maximum: 2100 },
          inclusionReason: { type: "string", maxLength: 300 },
          matchedConstraints: { type: "array", maxItems: 8, items: { type: "string", maxLength: 80 } },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["title", "year", "inclusionReason", "matchedConstraints", "confidence"],
      },
    },
  },
  required: ["interpretation", "resultMode", "includeUnreleased", "hardConstraints", "softPreferences", "referenceMovie", "candidates"],
} as const;

function sendJson(body: unknown, status = 200) { return Response.json(body, { status }); }
function sendNodeJson(response: NodeResponse, result: SearchResult) {
  response.statusCode = result.status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(result.body));
}

function configuredKey(name: string) {
  const value = process.env[name]?.trim();
  return value && value.length >= 20 && !value.includes("REDACTED") && !value.includes("SENSITIVE") ? value : undefined;
}

function getRateLimitKey(headers?: Headers | Record<string, string | string[] | undefined>) {
  const forwardedFor = headers instanceof Headers ? headers.get("x-forwarded-for") : headers?.["x-forwarded-for"];
  const ip = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  return ip?.split(",")[0]?.trim() || "unknown";
}

function checkRateLimit(key: string) {
  const now = Date.now();
  const current = rateLimits.get(key);
  if (!current || current.resetAt <= now) {
    rateLimits.set(key, { count: 1, resetAt: now + rateLimitWindowMs });
    return true;
  }
  if (current.count >= maxRequestsPerWindow) return false;
  current.count += 1;
  return true;
}

async function readBody(request: Request): Promise<SearchBody> {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > maxRequestBytes) throw new RequestBodyError(413, "AI movie search request is too large");
  const raw = await request.text();
  if (raw.length > maxRequestBytes) throw new RequestBodyError(413, "AI movie search request is too large");
  if (!raw) return {};
  try { return JSON.parse(raw) as SearchBody; }
  catch { throw new RequestBodyError(400, "AI movie search request must be valid JSON"); }
}

async function readNodeBody(request: NodeRequest): Promise<SearchBody> {
  if (request.body && typeof request.body === "object") return request.body as SearchBody;
  if (typeof request.body === "string") return JSON.parse(request.body) as SearchBody;
  if (!request.on) return {};
  const chunks: string[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    request.on?.("data", (chunk) => {
      const value = chunk?.toString("utf8") || "";
      size += value.length;
      if (size > maxRequestBytes) reject(new RequestBodyError(413, "AI movie search request is too large"));
      else chunks.push(value);
    });
    request.on?.("end", () => resolve());
    request.on?.("error", () => reject(new Error("Failed to read request body")));
  });
  try { return chunks.length ? JSON.parse(chunks.join("")) as SearchBody : {}; }
  catch { throw new RequestBodyError(400, "AI movie search request must be valid JSON"); }
}

function normalizeFilters(value: unknown): SearchFilters {
  const filters = value && typeof value === "object" ? value as Partial<SearchFilters> : {};
  const strings = (items: unknown) => Array.isArray(items) ? items.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 40)).filter(Boolean).slice(0, 8) : [];
  return {
    genres: strings(filters.genres),
    eras: strings(filters.eras),
    runtimeMin: typeof filters.runtimeMin === "number" ? Math.max(30, Math.min(300, filters.runtimeMin)) : 30,
    runtimeMax: typeof filters.runtimeMax === "number" ? Math.max(30, Math.min(300, filters.runtimeMax)) : 300,
  };
}

function outputText(value: unknown) {
  const response = value as { output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
  return (response.output || []).flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text || "";
}

async function callOpenAI({ apiKey, instructions, input, schema, schemaName, maxOutputTokens }: {
  apiKey: string;
  instructions: string;
  input: string;
  schema: unknown;
  schemaName: string;
  maxOutputTokens: number;
}) {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 22_000);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: searchModel,
        instructions,
        input,
        reasoning: { effort: "none" },
        max_output_tokens: maxOutputTokens,
        store: false,
        text: { format: { type: "json_schema", name: schemaName, strict: true, schema } },
      }),
    });
    if (!response.ok) throw new Error(`OpenAI request failed: ${response.status}`);
    const data = await response.json();
    const text = outputText(data);
    if (!text) throw new Error("OpenAI returned no structured output");
    return { value: JSON.parse(text), usage: data.usage };
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function normalizeTitle(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
}

function releasedYear(movie: TmdbMovie) { return Number((movie.release_date || "").slice(0, 4)) || null; }

export function selectTmdbMatch(candidate: ResearchCandidate, results: TmdbMovie[]) {
  const expected = normalizeTitle(candidate.title);
  const released = results.filter((movie) => !movie.adult && movie.id && movie.title);
  const exactTitle = released.filter((movie) => normalizeTitle(movie.title || "") === expected || normalizeTitle(movie.original_title || "") === expected);
  if (candidate.year) return exactTitle.find((movie) => releasedYear(movie) === candidate.year) || null;
  return exactTitle[0] || null;
}

async function tmdbFetch(apiKey: string, path: string) {
  const separator = path.includes("?") ? "&" : "?";
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`${apiBase}${path}${separator}api_key=${apiKey}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`TMDB request failed: ${response.status}`);
    return response.json();
  } finally { globalThis.clearTimeout(timeout); }
}

function mapMovieDetail(movie: TmdbMovieDetail): Movie {
  const youtube = movie.videos?.results?.filter((video) => video.site === "YouTube" && video.key) || [];
  const trailer = youtube.find((video) => video.type === "Trailer" && video.official)
    || youtube.find((video) => video.type === "Trailer")
    || youtube.find((video) => video.type === "Teaser");
  return {
    id: movie.id,
    title: movie.title || "Untitled",
    year: (movie.release_date || "").slice(0, 4) || "Unknown",
    posterPath: movie.poster_path,
    backdropPath: movie.backdrop_path,
    overview: movie.overview || "No overview available yet.",
    genres: movie.genres?.map((genre) => genre.name) || [],
    voteAverage: movie.vote_average,
    voteCount: movie.vote_count,
    runtime: movie.runtime,
    director: movie.credits?.crew?.find((person) => person.job === "Director")?.name,
    cast: [...(movie.credits?.cast || [])].sort((a, b) => a.order - b.order).slice(0, 5).map((person) => person.name),
    popularity: movie.popularity,
    keywords: movie.keywords?.keywords?.slice(0, 12).map((keyword) => keyword.name),
    originalLanguage: movie.original_language,
    productionCountries: movie.production_countries?.slice(0, 3).map((country) => country.name),
    trailerKey: trailer?.key,
    recommendedMovieIds: movie.recommendations?.results?.slice(0, 12).map((item) => item.id),
    similarMovieIds: movie.similar?.results?.slice(0, 12).map((item) => item.id),
  };
}

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<R | null>) {
  const results: Array<R | null> = new Array(items.length).fill(null);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try { results[index] = await mapper(items[index], index); }
      catch { results[index] = null; }
    }
  }));
  return results.filter((value): value is R => value !== null);
}

async function resolveCandidates(apiKey: string, research: ResearchResult) {
  const today = new Date().toISOString().slice(0, 10);
  const seedResults = await mapLimit(research.candidates, 6, async (candidate, researchRank): Promise<ResolvedCandidate | null> => {
    const params = new URLSearchParams({ query: candidate.title, include_adult: "false", language: "en-US", page: "1" });
    if (candidate.year) params.set("year", String(candidate.year));
    const search = await tmdbFetch(apiKey, `/search/movie?${params.toString()}`);
    const match = selectTmdbMatch(candidate, (search?.results || []) as TmdbMovie[]);
    if (!match || (!research.includeUnreleased && match.release_date && match.release_date > today)) return null;
    const detail = await tmdbFetch(apiKey, `/movie/${match.id}?append_to_response=credits,keywords,recommendations,similar,videos`);
    if (!detail?.id || !detail.poster_path) return null;
    return resolvedFromDetail(detail, "seed", researchRank, candidate);
  });

  const relatedResults = research.referenceMovie
    ? await resolveReferenceRoutes(apiKey, research.referenceMovie, research.includeUnreleased)
    : [];
  const needsDiscovery = research.resultMode === "curated" && !research.referenceMovie;
  const discoveryResults = needsDiscovery ? await resolveDiscoveryRoute(apiKey, research) : [];
  const byId = new Map<number, ResolvedCandidate>();
  [...seedResults, ...relatedResults, ...discoveryResults].forEach((item) => {
    const existing = byId.get(item.movie.id);
    if (!existing || sourcePriority(item.source) > sourcePriority(existing.source)) byId.set(item.movie.id, item);
  });
  return [...byId.values()];
}

function resolvedFromDetail(detail: TmdbMovieDetail, source: ResolvedCandidate["source"], researchRank: number, research?: ResearchCandidate, relationship?: string): ResolvedCandidate {
  return {
    movie: mapMovieDetail(detail),
    research,
    researchRank,
    source,
    relationship,
    companies: detail.production_companies?.map((company) => company.name) || [],
    collection: detail.belongs_to_collection?.name,
    releaseDate: detail.release_date,
  };
}

function sourcePriority(source: ResolvedCandidate["source"]) {
  return ({ seed: 5, recommendation: 4, similar: 3, "shared-person": 2, discover: 1 })[source];
}

async function fetchDetailCandidate(apiKey: string, raw: TmdbMovie, source: ResolvedCandidate["source"], rank: number, relationship?: string) {
  if (!raw?.id || !raw.poster_path || raw.adult) return null;
  const detail = await tmdbFetch(apiKey, `/movie/${raw.id}?append_to_response=credits,keywords,recommendations,similar,videos`);
  return detail?.id && detail.poster_path ? resolvedFromDetail(detail, source, rank, undefined, relationship) : null;
}

async function resolveReferenceRoutes(apiKey: string, reference: NonNullable<ResearchResult["referenceMovie"]>, includeUnreleased: boolean) {
  const params = new URLSearchParams({ query: reference.title, include_adult: "false", language: "en-US", page: "1" });
  if (reference.year) params.set("year", String(reference.year));
  const search = await tmdbFetch(apiKey, `/search/movie?${params.toString()}`);
  const match = selectTmdbMatch({ title: reference.title, year: reference.year, inclusionReason: "reference", matchedConstraints: [], confidence: 1 }, search?.results || []);
  if (!match) return [];
  const referenceDetail = await tmdbFetch(apiKey, `/movie/${match.id}?append_to_response=credits,keywords,recommendations,similar`);
  if (!referenceDetail?.id) return [];
  const today = new Date().toISOString().slice(0, 10);
  const raw: Array<{ movie: TmdbMovie; source: ResolvedCandidate["source"]; relationship: string }> = [];
  (referenceDetail.recommendations?.results || []).slice(0, 16).forEach((movie: TmdbMovie) => raw.push({ movie, source: "recommendation", relationship: `recommended by TMDB from ${referenceDetail.title}` }));
  (referenceDetail.similar?.results || []).slice(0, 16).forEach((movie: TmdbMovie) => raw.push({ movie, source: "similar", relationship: `listed by TMDB as similar to ${referenceDetail.title}` }));

  const lead = [...(referenceDetail.credits?.cast || [])].sort((a, b) => a.order - b.order).slice(0, 2);
  const director = referenceDetail.credits?.crew?.find((person: { job: string }) => person.job === "Director");
  const people = [...lead.map((person) => ({ id: person.id, name: person.name })), ...(director?.id ? [{ id: director.id, name: director.name }] : [])]
    .filter((person): person is { id: number; name: string } => Boolean(person.id));
  const credits = await Promise.all(people.map(async (person) => ({ person, data: await tmdbFetch(apiKey, `/person/${person.id}/movie_credits`) })));
  credits.forEach(({ person, data }) => {
    [...(data?.cast || []), ...(data?.crew || []).filter((movie: { job?: string }) => movie.job === "Director")]
      .slice(0, 18)
      .forEach((movie: TmdbMovie) => raw.push({ movie, source: "shared-person", relationship: `shares ${person.name} with ${referenceDetail.title}` }));
  });

  const seen = new Set<number>([referenceDetail.id]);
  const filtered = raw.filter(({ movie }) => {
    if (!movie.id || seen.has(movie.id) || movie.adult || !movie.poster_path) return false;
    if (!includeUnreleased && movie.release_date && movie.release_date > today) return false;
    seen.add(movie.id);
    return true;
  }).slice(0, 28);
  return mapLimit(filtered, 6, ({ movie, source, relationship }, rank) => fetchDetailCandidate(apiKey, movie, source, rank, relationship));
}

const tmdbGenreIds: Record<string, number> = {
  action: 28, adventure: 12, animation: 16, comedy: 35, crime: 80, documentary: 99,
  drama: 18, family: 10751, fantasy: 14, history: 36, horror: 27, music: 10402,
  mystery: 9648, romance: 10749, "science fiction": 878, "sci fi": 878, thriller: 53,
  war: 10752, western: 37,
};

async function resolveDiscoveryRoute(apiKey: string, research: ResearchResult) {
  const hard = research.hardConstraints;
  const params = new URLSearchParams({ include_adult: "false", include_video: "false", sort_by: "popularity.desc", "vote_count.gte": "40" });
  const genreIds = hard.genres.map((genre) => tmdbGenreIds[normalizeTitle(genre)]).filter(Boolean);
  if (genreIds.length) params.set("with_genres", genreIds.join(","));
  if (hard.yearMin) params.set("primary_release_date.gte", `${hard.yearMin}-01-01`);
  if (hard.yearMax) params.set("primary_release_date.lte", `${hard.yearMax}-12-31`);
  if (hard.runtimeMin) params.set("with_runtime.gte", String(hard.runtimeMin));
  if (hard.runtimeMax) params.set("with_runtime.lte", String(hard.runtimeMax));
  if (hard.people.length) {
    const people = await Promise.all(hard.people.slice(0, 2).map((name) => tmdbFetch(apiKey, `/search/person?query=${encodeURIComponent(name)}&include_adult=false&page=1`)));
    const ids = people.map((result) => result?.results?.[0]?.id).filter(Boolean);
    if (ids.length) params.set("with_people", ids.join(","));
  }
  const pages = await Promise.all([1, 2].map(async (page) => {
    const pageParams = new URLSearchParams(params);
    pageParams.set("page", String(page));
    return tmdbFetch(apiKey, `/discover/movie?${pageParams.toString()}`);
  }));
  const seen = new Set<number>();
  const raw = pages.flatMap((page) => page?.results || []).filter((movie: TmdbMovie) => movie.id && movie.poster_path && !movie.adult && !seen.has(movie.id) && seen.add(movie.id)).slice(0, 24);
  return mapLimit(raw, 6, (movie, rank) => fetchDetailCandidate(apiKey, movie, "discover", rank));
}

function filterDescription(filters: SearchFilters) {
  const parts = [
    filters.genres.length ? `genres: ${filters.genres.join(", ")}` : "",
    filters.eras.length ? `eras: ${filters.eras.join(", ")}` : "",
    filters.runtimeMin > 30 || filters.runtimeMax < 300 ? `runtime: ${filters.runtimeMin}-${filters.runtimeMax} minutes` : "",
  ].filter(Boolean);
  return parts.length ? `\nActive interface filters: ${parts.join("; ")}` : "";
}

function words(value: string) { return normalizeTitle(value).split(" ").filter((word) => word.length > 2 && !["movie", "movies", "film", "films", "something", "with", "from", "that", "like"].includes(word)); }

function metadataText(item: ResolvedCandidate) {
  const movie = item.movie;
  return normalizeTitle([movie.title, movie.overview, ...movie.genres, ...(movie.keywords || []), ...(movie.cast || []), movie.director || "", ...item.companies, item.collection || ""].join(" "));
}

function matchesHardConstraints(item: ResolvedCandidate, research: ResearchResult, filters: SearchFilters) {
  const movie = item.movie;
  const hard = research.hardConstraints;
  const year = Number(movie.year);
  if (hard.yearMin && (!year || year < hard.yearMin)) return false;
  if (hard.yearMax && (!year || year > hard.yearMax)) return false;
  if (hard.runtimeMin && (!movie.runtime || movie.runtime < hard.runtimeMin)) return false;
  if (hard.runtimeMax && (!movie.runtime || movie.runtime > hard.runtimeMax)) return false;
  if (hard.genres.length && !hard.genres.every((genre) => movie.genres.some((actual) => normalizeTitle(actual) === normalizeTitle(genre)))) return false;
  if (hard.people.length && !hard.people.every((person) => [movie.director, ...(movie.cast || [])].some((actual) => actual && normalizeTitle(actual) === normalizeTitle(person)))) return false;
  const blob = metadataText(item);
  if (hard.franchise && !words(hard.franchise).some((word) => blob.includes(word))) return false;
  if (hard.exclusions.some((exclusion) => words(exclusion).length && words(exclusion).every((word) => blob.includes(word)))) return false;
  if (filters.genres.length && !filters.genres.every((genre) => movie.genres.some((actual) => normalizeTitle(actual) === normalizeTitle(genre)))) return false;
  if ((filters.runtimeMin > 30 || filters.runtimeMax < 300) && (!movie.runtime || movie.runtime < filters.runtimeMin || movie.runtime > filters.runtimeMax)) return false;
  return true;
}

function semanticFit(query: string, research: ResearchResult, item: ResolvedCandidate) {
  const blob = metadataText(item);
  const concepts = [query, ...research.softPreferences.tones, ...research.softPreferences.themes, ...research.softPreferences.pacing, ...research.softPreferences.similarityQualities];
  const tokens = [...new Set(concepts.flatMap(words))];
  return tokens.length ? tokens.filter((word) => blob.includes(word)).length / tokens.length : 0;
}

function scoreCandidate(query: string, research: ResearchResult, item: ResolvedCandidate) {
  const sourceBase = item.source === "seed"
    ? Math.max(.7, Math.min(.99, (item.research?.confidence || .82) - item.researchRank * .008))
    : item.source === "recommendation" ? .76
      : item.source === "similar" ? .73
        : item.source === "shared-person" ? .68 : .54;
  const semantic = semanticFit(query, research, item);
  const quality = Math.min(.045, Math.max(0, ((item.movie.voteAverage || 5.5) - 5.5) / 70));
  const credibility = Math.min(.025, Math.log10((item.movie.voteCount || 0) + 1) / 160);
  const popularity = Math.min(.02, Math.log10((item.movie.popularity || 0) + 1) / 120);
  const negativeDegreeConflict = /\bless\s+(gross|graphic|crude|raunchy|explicit)\b/i.test(query)
    && /\b(boundary[- ]pushing|gross[- ]out|graphic|crude|raunchy|explicit|provocative)\b/i.test(item.research?.inclusionReason || "")
    && !/\b(less|gentler|without|toned down|avoids?)\b/i.test(item.research?.inclusionReason || "");
  return Math.max(.4, Math.min(1, sourceBase + semantic * .16 + quality + credibility + popularity - (negativeDegreeConflict ? .2 : 0)));
}

function verifiedReason(item: ResolvedCandidate, research: ResearchResult) {
  if (item.research?.inclusionReason) return item.research.inclusionReason;
  if (item.relationship) return `${item.movie.title} ${item.relationship} and fits ${research.interpretation.toLowerCase()}`;
  const preference = [...research.softPreferences.tones, ...research.softPreferences.themes, ...research.softPreferences.similarityQualities][0];
  return `${item.movie.title} matches the request through its ${item.movie.genres.slice(0, 2).join(" and ") || "movie"} profile${preference ? ` and ${preference} fit` : ""}`;
}

function verifiedEvidence(item: ResolvedCandidate, matchedConstraints: string[]) {
  const movie = item.movie;
  const facts = [`TMDB verifies it as a ${movie.year} ${movie.genres.slice(0, 2).join("/") || "movie"}`];
  if (movie.runtime) facts.push(`with a ${movie.runtime}-minute runtime`);
  if (movie.director) facts.push(`directed by ${movie.director}`);
  if (item.relationship) facts.push(item.relationship);
  const constraints = matchedConstraints.length ? ` It matches: ${matchedConstraints.slice(0, 5).join(", ")}.` : "";
  return `${facts.join(", ")}.${constraints}`;
}

function deterministicVerification(query: string, research: ResearchResult, resolved: ResolvedCandidate[], filters: SearchFilters) {
  const referenceTitle = research.referenceMovie ? normalizeTitle(research.referenceMovie.title) : "";
  return resolved
    .filter((item) => normalizeTitle(item.movie.title) !== referenceTitle)
    .filter((item) => research.includeUnreleased || !item.releaseDate || item.releaseDate <= new Date().toISOString().slice(0, 10))
    .filter((item) => matchesHardConstraints(item, research, filters))
    .filter((item) => research.resultMode === "collection" || research.referenceMovie || (item.movie.voteCount || 0) >= 40)
    .map((item) => {
      const matchedConstraints = item.research?.matchedConstraints || [
        ...research.hardConstraints.genres,
        ...(research.hardConstraints.yearMin || research.hardConstraints.yearMax ? [`${research.hardConstraints.yearMin || ""}-${research.hardConstraints.yearMax || ""}`] : []),
        ...research.softPreferences.tones.slice(0, 2),
      ];
      const fitScore = scoreCandidate(query, research, item);
      return {
        item,
        fitScore,
        confidence: item.research?.confidence || Math.max(.55, fitScore - .08),
        reason: verifiedReason(item, research),
        evidence: verifiedEvidence(item, matchedConstraints),
        matchedConstraints,
      };
    })
    .sort((a, b) => research.resultMode === "collection"
      ? a.item.researchRank - b.item.researchRank || b.fitScore - a.fitScore
      : b.fitScore - a.fitScore || a.item.researchRank - b.item.researchRank)
    .slice(0, research.resultMode === "collection" ? 20 : 30);
}

async function cacheKey(query: string, filters: SearchFilters) {
  const input = new TextEncoder().encode(`luna-v1|${query.toLowerCase().replace(/\s+/g, " ")}|${JSON.stringify(filters)}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join("");
}

function needsFreshCache(query: string) {
  return /\b(current|currently|latest|today|tonight|now playing|in theaters|upcoming|future|new releases?|award|nominee|winner|2026)\b/i.test(query);
}

async function createAiMovieSearch(body: SearchBody, rateLimitKey: string): Promise<SearchResult> {
  const openAiKey = configuredKey("OPENAI_API_KEY");
  const tmdbKey = configuredKey("TMDB_API_KEY") || configuredKey("VITE_TMDB_API_KEY");
  if (!openAiKey || !tmdbKey) return { status: 503, body: { error: "AI-first movie search is not configured" } };
  if (!checkRateLimit(rateLimitKey)) return { status: 429, body: { error: "AI-first movie search rate limit exceeded" } };
  const query = typeof body.query === "string" ? body.query.trim().slice(0, maxQueryLength) : "";
  if (query.length < 3) return { status: 400, body: { error: "Enter a longer movie request" } };
  const filters = normalizeFilters(body.filters);
  const key = await cacheKey(query, filters);
  const cached = resultCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return { status: 200, body: cached.value };

  let researchResponse: { value: ResearchResult; usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } };
  try {
    researchResponse = await callOpenAI({
      apiKey: openAiKey,
      schema: researchSchema,
      schemaName: "low_cost_movie_intent",
      maxOutputTokens: maxModelOutputTokens,
      instructions: `Interpret a movie-discovery request for a TMDB-grounded decision engine. Today is ${new Date().toISOString().slice(0, 10)}. This is the only model call, so be compact and precise. Use collection for objective sets, franchises, filmographies, studios, decades, or requests for all/list/every; use curated for subjective recommendations and similarity. Separate explicit objective requirements into hardConstraints. Put tone, themes, pacing, familiarity, and negative degree preferences such as "less gross" into softPreferences unless the user explicitly excludes a concrete genre, person, title, or property. Negative degree preferences must materially affect seed selection: do not seed a movie known to be equally or more graphic, crude, gross, or explicit when the user asks for less of that quality. Identify a referenceMovie for "like" and "similar to" prompts. Return 3-20 canonical theatrical movie seeds with exact release years and one short, title-specific inclusion reason. For collections, include the central released members in canonical relevance order. For vague prompts, choose credible, recognizable examples that genuinely express the requested qualities rather than titles that merely repeat prompt words. Set includeUnreleased only when explicitly requested. Do not invent titles or include television. Do not claim current web facts; TMDB will handle current release and availability data. Return only the schema.`,
      input: `${query}${filterDescription(filters)}`,
    });
  } catch {
    return { status: 502, body: { error: "AI research was unavailable" } };
  }

  const research = researchResponse.value;
  const resolved = await resolveCandidates(tmdbKey, research);
  if (!resolved.length) return { status: 422, body: { error: "AI research did not resolve to verified TMDB movies" } };

  const accepted = deterministicVerification(query, research, resolved, filters);
  if (!accepted.length) return { status: 422, body: { error: "AI candidates failed deterministic TMDB constraints" } };
  const movies = accepted.map((entry) => entry.item.movie);
  const promptScores = Object.fromEntries(accepted.map((entry) => [entry.item.movie.id, entry.fitScore]));
  const promptEvidence = Object.fromEntries(accepted.map((entry) => [entry.item.movie.id, {
    reason: entry.reason,
    evidence: entry.evidence,
    matchedConstraints: entry.matchedConstraints,
    fitScore: entry.fitScore,
    confidence: entry.confidence,
  }]));
  const debug = Object.fromEntries(accepted.map((entry) => [entry.item.movie.id, {
    status: "tmdb",
    mode: "luna-intent-tmdb-verified",
    reasonSource: `One Luna interpretation followed by deterministic TMDB verification via ${entry.item.source}`,
    score: entry.fitScore,
    strongestSignals: entry.matchedConstraints,
  }]));
  const inputTokens = researchResponse.usage?.input_tokens || 0;
  const outputTokens = researchResponse.usage?.output_tokens || 0;
  const estimatedCostUsd = (inputTokens * lunaInputPricePerMillion + outputTokens * lunaOutputPricePerMillion) / 1_000_000;
  const result = {
    movies,
    debug,
    filters: [],
    promptScores,
    promptEvidence,
    serviceStatus: "full",
    explanation: research.interpretation,
    resultMode: research.resultMode,
    broadQuery: research.resultMode === "collection",
    verificationStatus: "deterministic" as const,
    usedWebSearch: false,
    ...(process.env.NODE_ENV !== "production" ? { usage: {
      model: searchModel,
      modelCalls: 1,
      inputTokens,
      outputTokens,
      totalTokens: researchResponse.usage?.total_tokens || inputTokens + outputTokens,
      estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)),
    } } : {}),
  };
  resultCache.set(key, { value: result, expiresAt: Date.now() + (needsFreshCache(query) ? freshCacheTtlMs : stableCacheTtlMs) });
  return { status: 200, body: result };
}

export async function POST(request: Request) {
  try {
    const result = await createAiMovieSearch(await readBody(request), getRateLimitKey(request.headers));
    return sendJson(result.body, result.status);
  } catch (error) {
    const status = error instanceof RequestBodyError ? error.status : 400;
    return sendJson({ error: error instanceof Error ? error.message : "Invalid AI movie search request" }, status);
  }
}

export function OPTIONS() { return new Response(null, { status: 204 }); }
export function GET() { return sendJson({ error: "Method not allowed" }, 405); }
export function handleAiMovieSearchRequest(request: Request) {
  if (request.method === "OPTIONS") return OPTIONS();
  if (request.method === "POST") return POST(request);
  return GET();
}

export default async function handler(request: Request | NodeRequest, response?: NodeResponse) {
  if (!response) return handleAiMovieSearchRequest(request as Request);
  const nodeRequest = request as NodeRequest;
  if (request.method === "OPTIONS") { response.statusCode = 204; response.end(); return; }
  if (request.method !== "POST") return sendNodeJson(response, { status: 405, body: { error: "Method not allowed" } });
  try {
    const result = await createAiMovieSearch(await readNodeBody(nodeRequest), getRateLimitKey(nodeRequest.headers));
    return sendNodeJson(response, result);
  } catch (error) {
    const status = error instanceof RequestBodyError ? error.status : 400;
    return sendNodeJson(response, { status, body: { error: error instanceof Error ? error.message : "Invalid AI movie search request" } });
  }
}
