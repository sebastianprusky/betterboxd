import type { Movie } from "../types";
import { embedText } from "./localEmbeddings";
import { buildMovieProfile } from "./movieProfiles";
import { getMovieDetails } from "./tmdb";

export const MOVIE_INTELLIGENCE_VERSION = "movie-intelligence-v1";
const databaseName = "pickamovie-intelligence";
const storeName = "representations";
const batchSize = 20;
const detailConcurrency = 4;
const storedEmbeddingDimensions = 256;

export type MovieIntelligenceRecord = {
  id: number;
  version: string;
  movie: Movie;
  embedding: number[];
  embeddingModel: string;
  updatedAt: number;
};

export type MovieIntelligenceProgress = {
  completed: number;
  total: number;
  cached: number;
  phase: "cache" | "details" | "embeddings" | "complete";
};

type Options = {
  signal?: AbortSignal;
  onProgress?: (progress: MovieIntelligenceProgress) => void;
};

const memoryCache = new Map<number, MovieIntelligenceRecord>();

function openDatabase() {
  if (typeof indexedDB === "undefined") return Promise.resolve<IDBDatabase | null>(null);
  return new Promise<IDBDatabase | null>((resolve) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

export async function loadMovieIntelligence(ids: number[]) {
  const unique = [...new Set(ids.filter(Number.isFinite))];
  const output = new Map<number, MovieIntelligenceRecord>();
  unique.forEach((id) => { const record = memoryCache.get(id); if (record?.version === MOVIE_INTELLIGENCE_VERSION) output.set(id, record); });
  const missing = unique.filter((id) => !output.has(id));
  if (!missing.length) return output;
  const database = await openDatabase();
  if (!database) return output;
  await Promise.all(missing.map((id) => new Promise<void>((resolve) => {
    const request = database.transaction(storeName, "readonly").objectStore(storeName).get(id);
    request.onsuccess = () => {
      const record = request.result as MovieIntelligenceRecord | undefined;
      if (record?.version === MOVIE_INTELLIGENCE_VERSION) { memoryCache.set(id, record); output.set(id, record); }
      resolve();
    };
    request.onerror = () => resolve();
  })));
  database.close();
  return output;
}

async function saveRecords(records: MovieIntelligenceRecord[]) {
  records.forEach((record) => memoryCache.set(record.id, record));
  const database = await openDatabase();
  if (!database || !records.length) return;
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    records.forEach((record) => store.put(record));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
  database.close();
}

function mergeMovie(base: Movie, enriched: Movie) {
  return {
    ...base,
    ...enriched,
    genres: enriched.genres.length ? enriched.genres : base.genres,
    overview: enriched.overview || base.overview,
    posterPath: enriched.posterPath || base.posterPath,
  } satisfies Movie;
}

async function enrichDetails(movies: Movie[], signal?: AbortSignal) {
  const output = new Array<Movie>(movies.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < movies.length && !signal?.aborted) {
      const index = cursor++;
      const movie = movies[index];
      try { output[index] = mergeMovie(movie, await getMovieDetails(movie)); }
      catch { output[index] = movie; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(detailConcurrency, movies.length) }, worker));
  return output.filter(Boolean);
}

async function requestEmbeddings(movies: Movie[], signal?: AbortSignal) {
  try {
    const response = await fetch("/api/movie-embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ movies }),
      signal,
    });
    if (!response.ok) throw new Error("Embedding service unavailable");
    const data = await response.json() as { model?: string; embeddings?: Array<{ movieId: number; embedding: number[] }> };
    const model = data.model || "text-embedding-3-small";
    return new Map((data.embeddings || []).filter((row) => row.embedding?.length).map((row) => [row.movieId, {
      embedding: row.embedding.length <= storedEmbeddingDimensions ? row.embedding : compactEmbedding(row.embedding, storedEmbeddingDimensions),
      model: model.includes("/projected-") ? model : `${model}/projected-${storedEmbeddingDimensions}-v1`,
    }]));
  } catch {
    return new Map(movies.map((movie) => [movie.id, { embedding: embedText(buildMovieProfile(movie)), model: "local-profile-v1" }]));
  }
}

export async function enrichMovieIntelligence(movies: Movie[], options: Options = {}) {
  const unique = [...new Map(movies.map((movie) => [movie.id, movie])).values()];
  const cached = await loadMovieIntelligence(unique.map((movie) => movie.id));
  const missing = unique
    .filter((movie) => !cached.has(movie.id) || cached.get(movie.id)?.embeddingModel === "local-profile-v1")
    .map((movie) => cached.get(movie.id)?.movie || movie);
  options.onProgress?.({ completed: cached.size, total: unique.length, cached: cached.size, phase: "cache" });
  if (!missing.length || options.signal?.aborted) {
    options.onProgress?.({ completed: cached.size, total: unique.length, cached: cached.size, phase: "complete" });
    return cached;
  }

  for (let start = 0; start < missing.length && !options.signal?.aborted; start += batchSize) {
    const batch = missing.slice(start, start + batchSize);
    options.onProgress?.({ completed: cached.size, total: unique.length, cached: cached.size, phase: "details" });
    const detailed = await enrichDetails(batch, options.signal);
    if (options.signal?.aborted) break;
    options.onProgress?.({ completed: cached.size, total: unique.length, cached: cached.size, phase: "embeddings" });
    const embeddings = await requestEmbeddings(detailed, options.signal);
    if (options.signal?.aborted) break;
    const records = detailed.map((movie): MovieIntelligenceRecord => {
      const embedding = embeddings.get(movie.id) || { embedding: embedText(buildMovieProfile(movie)), model: "local-profile-v1" };
      return { id: movie.id, version: MOVIE_INTELLIGENCE_VERSION, movie, embedding: embedding.embedding, embeddingModel: embedding.model, updatedAt: Date.now() };
    });
    await saveRecords(records);
    records.forEach((record) => cached.set(record.id, record));
    options.onProgress?.({ completed: cached.size, total: unique.length, cached: Math.min(unique.length, cached.size), phase: "embeddings" });
  }
  options.onProgress?.({ completed: cached.size, total: unique.length, cached: cached.size, phase: "complete" });
  return cached;
}

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

export function applyMovieIntelligence(movie: Movie, record?: MovieIntelligenceRecord) {
  if (!record) return movie;
  return {
    ...movie,
    ...record.movie,
    genres: record.movie.genres.length ? record.movie.genres : movie.genres,
    overview: record.movie.overview || movie.overview,
    posterPath: record.movie.posterPath || movie.posterPath,
    modelEmbedding: record.embedding,
    modelEmbeddingModel: record.embeddingModel,
  } satisfies Movie;
}
