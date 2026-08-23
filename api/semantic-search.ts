declare const process: { env: Record<string, string | undefined> };

type Movie = {
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
  keywords?: string[];
  originalLanguage?: string;
  productionCountries?: string[];
  similarMovieIds?: number[];
  recommendedMovieIds?: number[];
};

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

type SemanticSearchBody = {
  query?: unknown;
  movies?: unknown;
};

type SearchResult = {
  status: number;
  body: unknown;
};

type EmbeddingResult = {
  embeddings: number[][];
  remoteCount: number;
  cachedCount: number;
};

type RequestContext = {
  rateLimitKey: string;
};

type OpenAIEmbedding = {
  embedding: number[];
  index: number;
};

type OpenAIEmbeddingResponse = {
  data?: OpenAIEmbedding[];
};

const embeddingModel = "text-embedding-3-small";
const maxRequestBytes = 32_000;
const maxCandidates = 20;
const maxResults = 20;
const maxQueryLength = 160;
const maxTitleLength = 120;
const maxYearLength = 12;
const maxOverviewLength = 600;
const maxGenres = 6;
const maxGenreLength = 40;
const maxDirectorLength = 80;
const maxCastMembers = 5;
const maxCastNameLength = 80;
const maxKeywords = 12;
const maxKeywordLength = 60;
const maxCountries = 3;
const maxCountryLength = 60;
const maxRelationshipIds = 12;
const rateLimitWindowMs = 60_000;
const maxRequestsPerWindow = 30;
const embeddingCacheTtlMs = 24 * 60 * 60 * 1000;
const maxEmbeddingCacheEntries = 600;

type EmbeddingCacheEntry = {
  embedding: number[];
  expiresAt: number;
  lastUsed: number;
};

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

class RequestBodyError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const sharedState = globalThis as typeof globalThis & {
  __pickAMovieEmbeddingCache?: Map<string, EmbeddingCacheEntry>;
  __pickAMovieRateLimits?: Map<string, RateLimitEntry>;
};

const embeddingCache = sharedState.__pickAMovieEmbeddingCache ?? new Map<string, EmbeddingCacheEntry>();
const rateLimits = sharedState.__pickAMovieRateLimits ?? new Map<string, RateLimitEntry>();
sharedState.__pickAMovieEmbeddingCache = embeddingCache;
sharedState.__pickAMovieRateLimits = rateLimits;

function sendJson(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function sendNodeJson(response: NodeResponse, result: SearchResult) {
  response.statusCode = result.status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(result.body));
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

function limitText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function sanitizeMovie(value: unknown): Movie | null {
  if (!isMovie(value)) return null;

  const title = limitText(value.title, maxTitleLength);
  const year = limitText(value.year, maxYearLength);
  const overview = limitText(value.overview, maxOverviewLength);
  if (!title || !year || !overview) return null;

  return {
    id: value.id,
    title,
    year,
    posterPath: typeof value.posterPath === "string" ? value.posterPath.slice(0, 160) : null,
    backdropPath: typeof value.backdropPath === "string" ? value.backdropPath.slice(0, 160) : null,
    overview,
    genres: value.genres
      .filter((genre): genre is string => typeof genre === "string")
      .slice(0, maxGenres)
      .map((genre) => limitText(genre, maxGenreLength))
      .filter(Boolean),
    voteAverage: typeof value.voteAverage === "number" ? value.voteAverage : undefined,
    runtime: typeof value.runtime === "number" ? value.runtime : undefined,
    director: limitText(value.director, maxDirectorLength) || undefined,
    cast: Array.isArray(value.cast)
      ? value.cast
          .filter((name): name is string => typeof name === "string")
          .slice(0, maxCastMembers)
          .map((name) => limitText(name, maxCastNameLength))
          .filter(Boolean)
      : undefined,
    keywords: Array.isArray(value.keywords)
      ? value.keywords
          .filter((keyword): keyword is string => typeof keyword === "string")
          .slice(0, maxKeywords)
          .map((keyword) => limitText(keyword, maxKeywordLength))
          .filter(Boolean)
      : undefined,
    originalLanguage: limitText(value.originalLanguage, 12) || undefined,
    productionCountries: Array.isArray(value.productionCountries)
      ? value.productionCountries
          .filter((country): country is string => typeof country === "string")
          .slice(0, maxCountries)
          .map((country) => limitText(country, maxCountryLength))
          .filter(Boolean)
      : undefined,
    similarMovieIds: Array.isArray(value.similarMovieIds)
      ? value.similarMovieIds.filter((id): id is number => typeof id === "number").slice(0, maxRelationshipIds)
      : undefined,
    recommendedMovieIds: Array.isArray(value.recommendedMovieIds)
      ? value.recommendedMovieIds.filter((id): id is number => typeof id === "number").slice(0, maxRelationshipIds)
      : undefined,
  };
}

function normalizeCandidates(value: unknown): Movie[] {
  const movies = Array.isArray(value) ? value.map(sanitizeMovie).filter((movie): movie is Movie => Boolean(movie)) : [];
  const seen = new Set<number>();
  return movies
    .filter((movie) => {
      if (seen.has(movie.id)) return false;
      seen.add(movie.id);
      return true;
    })
    .slice(0, maxCandidates);
}

function movieEmbeddingText(movie: Movie) {
  return [
    `Title: ${movie.title}`,
    `Year: ${movie.year}`,
    movie.genres.length ? `Genres: ${movie.genres.join(", ")}` : "",
    movie.overview ? `Overview: ${movie.overview}` : "",
    movie.director ? `Director: ${movie.director}` : "",
    movie.cast?.length ? `Cast: ${movie.cast.join(", ")}` : "",
    movie.keywords?.length ? `Keywords: ${movie.keywords.join(", ")}` : "",
    movie.originalLanguage ? `Language: ${movie.originalLanguage}` : "",
    movie.productionCountries?.length ? `Countries: ${movie.productionCountries.join(", ")}` : "",
    /^\d{4}$/.test(movie.year) ? `Decade: ${movie.year.slice(0, 3)}0s` : "",
    movie.similarMovieIds?.length ? `TMDB similar movie IDs: ${movie.similarMovieIds.join(", ")}` : "",
    movie.recommendedMovieIds?.length ? `TMDB recommended movie IDs: ${movie.recommendedMovieIds.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function cosineSimilarity(a: number[], b: number[]) {
  let dot = 0;
  let aMagnitude = 0;
  let bMagnitude = 0;

  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    dot += a[index] * b[index];
    aMagnitude += a[index] * a[index];
    bMagnitude += b[index] * b[index];
  }

  if (!aMagnitude || !bMagnitude) return 0;
  return dot / (Math.sqrt(aMagnitude) * Math.sqrt(bMagnitude));
}

function getRateLimitKey(headers?: Headers | Record<string, string | string[] | undefined>) {
  const forwardedFor = headers instanceof Headers ? headers.get("x-forwarded-for") : headers?.["x-forwarded-for"];
  const ip = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  return ip?.split(",")[0]?.trim() || "unknown";
}

async function readBody(request: Request): Promise<SemanticSearchBody> {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > maxRequestBytes) throw new RequestBodyError(413, "Semantic search request is too large");

  const rawBody = await request.text();
  if (rawBody.length > maxRequestBytes) throw new RequestBodyError(413, "Semantic search request is too large");
  if (!rawBody) return {};

  try {
    const body = JSON.parse(rawBody);
    return body && typeof body === "object" ? (body as SemanticSearchBody) : {};
  } catch {
    throw new RequestBodyError(400, "Semantic search request must be valid JSON");
  }
}

async function readNodeBody(request: NodeRequest): Promise<SemanticSearchBody> {
  const contentLength = Number(request.headers?.["content-length"] || 0);
  if (contentLength > maxRequestBytes) throw new RequestBodyError(413, "Semantic search request is too large");

  try {
    if (request.body && typeof request.body === "object") return request.body as SemanticSearchBody;
    if (typeof request.body === "string") {
      if (request.body.length > maxRequestBytes) throw new RequestBodyError(413, "Semantic search request is too large");
      return JSON.parse(request.body) as SemanticSearchBody;
    }
    if (!request.on) return {};

    const chunks: string[] = [];
    let size = 0;
    await new Promise<void>((resolve, reject) => {
      request.on?.("data", (chunk) => {
        if (!chunk) return;
        const value = chunk.toString("utf8");
        size += value.length;
        if (size > maxRequestBytes) {
          reject(new RequestBodyError(413, "Semantic search request is too large"));
          return;
        }
        chunks.push(value);
      });
      request.on?.("end", () => resolve());
      request.on?.("error", () => reject(new Error("Failed to read request body")));
    });

    const rawBody = chunks.join("");
    return rawBody ? (JSON.parse(rawBody) as SemanticSearchBody) : {};
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError(400, "Semantic search request must be valid JSON");
  }
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

function getCacheKey(input: string) {
  return `${embeddingModel}:${input}`;
}

function readEmbeddingCache(input: string) {
  const now = Date.now();
  const entry = embeddingCache.get(getCacheKey(input));
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    embeddingCache.delete(getCacheKey(input));
    return null;
  }
  entry.lastUsed = now;
  return entry.embedding;
}

function writeEmbeddingCache(input: string, embedding: number[]) {
  const now = Date.now();
  embeddingCache.set(getCacheKey(input), {
    embedding,
    expiresAt: now + embeddingCacheTtlMs,
    lastUsed: now,
  });

  if (embeddingCache.size <= maxEmbeddingCacheEntries) return;

  const entriesToRemove = [...embeddingCache.entries()]
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    .slice(0, embeddingCache.size - maxEmbeddingCacheEntries);
  entriesToRemove.forEach(([key]) => embeddingCache.delete(key));
}

async function createEmbeddings(input: string[], apiKey: string): Promise<EmbeddingResult> {
  const embeddings = new Array<number[] | null>(input.length).fill(null);
  const missingInputs: string[] = [];
  const missingIndexes: number[] = [];
  let cachedCount = 0;

  input.forEach((value, index) => {
    const cachedEmbedding = readEmbeddingCache(value);
    if (cachedEmbedding) {
      embeddings[index] = cachedEmbedding;
      cachedCount += 1;
      return;
    }
    missingInputs.push(value);
    missingIndexes.push(index);
  });

  if (!missingInputs.length) {
    return { embeddings: embeddings as number[][], cachedCount, remoteCount: 0 };
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: embeddingModel,
      input: missingInputs,
      encoding_format: "float",
    }),
  });

  if (!response.ok) throw new Error("OpenAI embedding request failed");

  const data = (await response.json()) as OpenAIEmbeddingResponse;
  const remoteEmbeddings = (data.data || []).sort((a, b) => a.index - b.index).map((item) => item.embedding);

  remoteEmbeddings.forEach((embedding, index) => {
    const inputIndex = missingIndexes[index];
    const inputValue = missingInputs[index];
    if (inputIndex === undefined || !inputValue) return;
    embeddings[inputIndex] = embedding;
    writeEmbeddingCache(inputValue, embedding);
  });

  return { embeddings: embeddings as number[][], cachedCount, remoteCount: missingInputs.length };
}

async function searchSemantically(body: SemanticSearchBody, context: RequestContext): Promise<SearchResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { status: 503, body: { error: "Semantic search is not configured" } };
  }

  try {
    if (!checkRateLimit(context.rateLimitKey)) {
      return { status: 429, body: { error: "Semantic search rate limit exceeded" } };
    }

    const query = limitText(body.query, maxQueryLength);
    const movies = normalizeCandidates(body.movies);

    if (!query) {
      return { status: 200, body: { movies: [] } };
    }

    const embeddingResult = await createEmbeddings([query, ...movies.map(movieEmbeddingText)], apiKey);
    const embeddings = embeddingResult.embeddings;
    const queryEmbedding = embeddings[0];
    const movieEmbeddings = embeddings.slice(1);

    if (!queryEmbedding || movieEmbeddings.length !== movies.length) {
      throw new Error("OpenAI embedding response was incomplete");
    }

    const ranked = movies
      .map((movie, index) => ({
        movie,
        score: cosineSimilarity(queryEmbedding, movieEmbeddings[index] || []),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);

    return {
      status: 200,
      body: {
        movies: ranked.map(({ movie }) => movie),
        debug: {
          status: "openai",
          mode: "semantic-embedding",
          model: embeddingModel,
          candidateCount: movies.length,
          remoteEmbeddingCount: embeddingResult.remoteCount,
          cachedEmbeddingCount: embeddingResult.cachedCount,
          reasonSource: "OpenAI embeddings ranked by cosine similarity",
          scores: Object.fromEntries(ranked.map(({ movie, score }) => [movie.id, Number(score.toFixed(4))])),
        },
      },
    };
  } catch {
    return { status: 502, body: { error: "Semantic search request failed", debug: { status: "openai-error", mode: "local-fallback" } } };
  }
}

export async function POST(request: Request) {
  let body: SemanticSearchBody;
  try {
    body = await readBody(request);
  } catch (error) {
    const status = error instanceof RequestBodyError ? error.status : 400;
    return sendJson({ error: error instanceof Error ? error.message : "Invalid semantic search request" }, status);
  }

  const result = await searchSemantically(body, { rateLimitKey: getRateLimitKey(request.headers) });
  return sendJson(result.body, result.status);
}

export function OPTIONS() {
  return new Response(null, { status: 204 });
}

export function GET() {
  return sendJson({ error: "Method not allowed" }, 405);
}

export function handleSemanticSearchRequest(request: Request) {
  if (request.method === "OPTIONS") return OPTIONS();
  if (request.method === "POST") return POST(request);
  return GET();
}

export default async function handler(request: Request | NodeRequest, response?: NodeResponse) {
  if (!response) return handleSemanticSearchRequest(request as Request);

  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }

  if (request.method !== "POST") {
    sendNodeJson(response, { status: 405, body: { error: "Method not allowed" } });
    return;
  }

  try {
    sendNodeJson(
      response,
      await searchSemantically(await readNodeBody(request as NodeRequest), { rateLimitKey: getRateLimitKey((request as NodeRequest).headers) })
    );
  } catch (error) {
    sendNodeJson(response, {
      status: error instanceof RequestBodyError ? error.status : 400,
      body: { error: error instanceof Error ? error.message : "Invalid semantic search request" },
    });
  }
}
