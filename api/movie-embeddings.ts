declare const process: { env: Record<string, string | undefined> };

type NodeRequest = { method?: string; body?: unknown; headers?: Record<string, string | string[] | undefined> };
type NodeResponse = { statusCode: number; setHeader: (name: string, value: string) => void; end: (body?: string) => void };

type Movie = {
  id: number; title: string; year: string; overview: string; genres: string[];
  voteAverage?: number; voteCount?: number; popularity?: number; runtime?: number;
  director?: string; cast?: string[]; keywords?: string[]; originalLanguage?: string;
  productionCountries?: string[]; similarMovieIds?: number[]; recommendedMovieIds?: number[];
};

type EmbeddingRow = { tmdbId: number; embedding: number[]; model: string; contentHash: string };
type Result = { status: number; body: unknown };

const embeddingModel = "text-embedding-3-small";
const clientEmbeddingDimensions = 256;
const maxMovies = 20;
const maxRequestBytes = 80_000;
const cacheTtl = 7 * 24 * 60 * 60 * 1000;
const rateLimitWindow = 60_000;
const rateLimitRequests = 30;
const shared = globalThis as typeof globalThis & {
  __pickAMovieModelEmbeddings?: Map<string, { embedding: number[]; expiresAt: number }>;
  __pickAMovieEmbeddingRateLimits?: Map<string, { count: number; resetAt: number }>;
};
const cache = shared.__pickAMovieModelEmbeddings ?? new Map<string, { embedding: number[]; expiresAt: number }>();
const rateLimits = shared.__pickAMovieEmbeddingRateLimits ?? new Map<string, { count: number; resetAt: number }>();
shared.__pickAMovieModelEmbeddings = cache;
shared.__pickAMovieEmbeddingRateLimits = rateLimits;

function configured(name: string) {
  const value = process.env[name]?.trim();
  return value && value.length >= 20 && !value.includes("REDACTED") && !value.includes("SENSITIVE") ? value : undefined;
}

function limited(value: unknown, length: number) { return typeof value === "string" ? value.trim().slice(0, length) : ""; }
function stringArray(value: unknown, count: number, length: number) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, count).map((item) => limited(item, length)).filter(Boolean) : [];
}
function numberArray(value: unknown, count: number) {
  return Array.isArray(value) ? value.filter((item): item is number => Number.isFinite(item)).slice(0, count) : [];
}
function sanitize(value: unknown): Movie | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "number" || !Number.isFinite(raw.id) || !limited(raw.title, 120) || !limited(raw.year, 12)) return null;
  return {
    id: Number(raw.id), title: limited(raw.title, 120), year: limited(raw.year, 12), overview: limited(raw.overview, 1_200),
    genres: stringArray(raw.genres, 8, 40), voteAverage: typeof raw.voteAverage === "number" ? raw.voteAverage : undefined,
    voteCount: typeof raw.voteCount === "number" ? raw.voteCount : undefined, popularity: typeof raw.popularity === "number" ? raw.popularity : undefined,
    runtime: typeof raw.runtime === "number" ? raw.runtime : undefined, director: limited(raw.director, 100) || undefined,
    cast: stringArray(raw.cast, 10, 100), keywords: stringArray(raw.keywords, 20, 80), originalLanguage: limited(raw.originalLanguage, 12) || undefined,
    productionCountries: stringArray(raw.productionCountries, 5, 80), similarMovieIds: numberArray(raw.similarMovieIds, 20),
    recommendedMovieIds: numberArray(raw.recommendedMovieIds, 20),
  };
}

function movieText(movie: Movie) {
  return [
    `Title: ${movie.title}`, `Year: ${movie.year}`,
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
  ].filter(Boolean).join("\n");
}

function hash(value: string) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) { result ^= value.charCodeAt(index); result = Math.imul(result, 16777619); }
  return `fnv1a-${(result >>> 0).toString(16)}`;
}
function cacheKey(text: string) { return `${embeddingModel}:${hash(text)}`; }

function compactEmbedding(source: number[], dimensions: number) {
  const output = Array(dimensions).fill(0);
  source.forEach((value, index) => {
    if (!Number.isFinite(value)) return;
    const bucket = index % dimensions;
    const sign = ((index * 2654435761) >>> 0) & 1 ? 1 : -1;
    output[bucket] += value * sign;
  });
  const magnitude = Math.sqrt(output.reduce((sum, value) => sum + value * value, 0));
  return magnitude ? output.map((value) => value / magnitude) : output;
}

async function persistentConfig() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url: url.replace(/\/$/, ""), key } : null;
}

function parseVector(value: unknown) {
  if (Array.isArray(value)) return value.filter((item): item is number => typeof item === "number");
  if (typeof value !== "string") return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((item): item is number => typeof item === "number") : []; }
  catch { return []; }
}

async function readPersistent(movies: Movie[]) {
  const config = await persistentConfig();
  const output = new Map<number, EmbeddingRow>();
  if (!config || !movies.length) return output;
  try {
    const ids = movies.map((movie) => movie.id).join(",");
    const response = await fetch(`${config.url}/rest/v1/movie_embeddings?select=tmdb_id,embedding,embedding_model,content_hash&tmdb_id=in.(${ids})`, {
      headers: { apikey: config.key, authorization: `Bearer ${config.key}` },
    });
    if (!response.ok) return output;
    const rows = await response.json() as Array<{ tmdb_id: number; embedding: unknown; embedding_model: string; content_hash: string }>;
    const movieById = new Map(movies.map((movie) => [movie.id, movie]));
    rows.forEach((row) => {
      const movie = movieById.get(row.tmdb_id); const embedding = parseVector(row.embedding);
      if (movie && row.embedding_model === embeddingModel && row.content_hash === hash(movieText(movie)) && embedding.length) {
        output.set(movie.id, { tmdbId: movie.id, embedding, model: embeddingModel, contentHash: row.content_hash });
      }
    });
  } catch { /* durable cache is optional */ }
  return output;
}

async function writePersistent(rows: EmbeddingRow[]) {
  const config = await persistentConfig();
  if (!config || !rows.length) return;
  try {
    await fetch(`${config.url}/rest/v1/movie_embeddings?on_conflict=tmdb_id`, {
      method: "POST",
      headers: { apikey: config.key, authorization: `Bearer ${config.key}`, "content-type": "application/json", prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(rows.map((row) => ({ tmdb_id: row.tmdbId, embedding: row.embedding, embedding_model: row.model, content_hash: row.contentHash, schema_version: 1, updated_at: new Date().toISOString() }))),
    });
  } catch { /* durable cache is optional */ }
}

async function embedMovies(movies: Movie[]): Promise<Result> {
  const apiKey = configured("OPENAI_API_KEY");
  if (!apiKey) return { status: 503, body: { error: "Movie embeddings are not configured" } };
  const persistent = await readPersistent(movies);
  const rows = new Map<number, EmbeddingRow>(persistent);
  const missing: Array<{ movie: Movie; text: string }> = [];
  movies.forEach((movie) => {
    if (rows.has(movie.id)) return;
    const text = movieText(movie); const warm = cache.get(cacheKey(text));
    if (warm && warm.expiresAt > Date.now()) rows.set(movie.id, { tmdbId: movie.id, embedding: warm.embedding, model: embeddingModel, contentHash: hash(text) });
    else missing.push({ movie, text });
  });
  if (missing.length) {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: embeddingModel, input: missing.map((item) => item.text), encoding_format: "float" }),
    });
    if (!response.ok) return { status: 502, body: { error: "Movie embedding request failed" } };
    const data = await response.json() as { data?: Array<{ index: number; embedding: number[] }> };
    const generated = (data.data || []).sort((a, b) => a.index - b.index);
    generated.forEach((item, index) => {
      const target = missing[index]; if (!target || !item.embedding?.length) return;
      const row = { tmdbId: target.movie.id, embedding: item.embedding, model: embeddingModel, contentHash: hash(target.text) };
      rows.set(target.movie.id, row); cache.set(cacheKey(target.text), { embedding: item.embedding, expiresAt: Date.now() + cacheTtl });
    });
    void writePersistent(generated.flatMap((_, index) => { const target = missing[index]; const row = target && rows.get(target.movie.id); return row ? [row] : []; }));
  }
  return { status: 200, body: {
    model: `${embeddingModel}/projected-${clientEmbeddingDimensions}-v1`,
    embeddings: movies.flatMap((movie) => { const row = rows.get(movie.id); return row ? [{ movieId: movie.id, embedding: compactEmbedding(row.embedding, clientEmbeddingDimensions) }] : []; }),
    embeddedCount: missing.length,
    cachedCount: movies.length - missing.length,
  } };
}

async function processBody(body: unknown): Promise<Result> {
  const raw = body && typeof body === "object" ? body as { movies?: unknown } : {};
  const movies = Array.isArray(raw.movies) ? raw.movies.map(sanitize).filter((movie): movie is Movie => Boolean(movie)).slice(0, maxMovies) : [];
  if (!movies.length) return { status: 400, body: { error: "Provide between 1 and 20 movies" } };
  return embedMovies(movies);
}

function requestIdentity(headers: Headers | Record<string, string | string[] | undefined>) {
  const get = (name: string) => headers instanceof Headers ? headers.get(name) : headers[name] || headers[name.toLowerCase()];
  const forwarded = get("x-forwarded-for");
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return value?.split(",")[0]?.trim() || "unknown";
}

function rateLimited(identity: string) {
  const now = Date.now();
  const current = rateLimits.get(identity);
  if (!current || current.resetAt <= now) { rateLimits.set(identity, { count: 1, resetAt: now + rateLimitWindow }); return false; }
  current.count += 1;
  return current.count > rateLimitRequests;
}

export async function POST(request: Request) {
  if (rateLimited(requestIdentity(request.headers))) return Response.json({ error: "Too many embedding requests" }, { status: 429 });
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maxRequestBytes) return Response.json({ error: "Request too large" }, { status: 413 });
  try { const result = await processBody(await request.json()); return Response.json(result.body, { status: result.status }); }
  catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }
}
export function OPTIONS() { return new Response(null, { status: 204 }); }
export function handleMovieEmbeddingsRequest(request: Request) { return request.method === "POST" ? POST(request) : request.method === "OPTIONS" ? OPTIONS() : Response.json({ error: "Method not allowed" }, { status: 405 }); }

export default async function handler(request: NodeRequest, response: NodeResponse) {
  if (request.method !== "POST") { response.statusCode = 405; response.end(); return; }
  if (rateLimited(requestIdentity(request.headers || {}))) { response.statusCode = 429; response.end(JSON.stringify({ error: "Too many embedding requests" })); return; }
  const raw = typeof request.body === "string" ? request.body : JSON.stringify(request.body || {});
  if (raw.length > maxRequestBytes) { response.statusCode = 413; response.end(JSON.stringify({ error: "Request too large" })); return; }
  try {
    const result = await processBody(typeof request.body === "string" ? JSON.parse(request.body) : request.body);
    response.statusCode = result.status; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(result.body));
  } catch { response.statusCode = 400; response.end(JSON.stringify({ error: "Invalid request" })); }
}
