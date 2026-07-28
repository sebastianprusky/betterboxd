import { fallbackMovies } from "../src/data/fallbackMovies";
import type { Movie } from "../src/types";

declare const process: { env: Record<string, string | undefined> };

type RequestLike = {
  method?: string;
  body?: unknown;
  on?: (event: "data" | "end" | "error", callback: (chunk?: Buffer) => void) => void;
};

type ResponseLike = {
  statusCode: number;
  setHeader: (name: string, value: string) => void;
  end: (body?: string) => void;
};

type SemanticSearchBody = {
  query?: unknown;
  movies?: unknown;
};

type OpenAIEmbedding = {
  embedding: number[];
  index: number;
};

type OpenAIEmbeddingResponse = {
  data?: OpenAIEmbedding[];
};

type Buffer = {
  toString: (encoding?: string) => string;
};

const embeddingModel = "text-embedding-3-small";
const maxCandidates = 50;
const maxResults = 20;

function sendJson(response: ResponseLike, statusCode: number, body: unknown) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
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

function normalizeCandidates(value: unknown): Movie[] {
  const movies = Array.isArray(value) ? value.filter(isMovie) : fallbackMovies;
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
    movie.title,
    movie.year,
    movie.genres.join(", "),
    movie.director ? `Directed by ${movie.director}` : "",
    movie.cast?.length ? `Cast: ${movie.cast.join(", ")}` : "",
    movie.overview,
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

async function readBody(request: RequestLike): Promise<SemanticSearchBody> {
  if (request.body && typeof request.body === "object") return request.body as SemanticSearchBody;
  if (typeof request.body === "string") return JSON.parse(request.body) as SemanticSearchBody;
  if (!request.on) return {};

  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    request.on?.("data", (chunk?: Buffer) => {
      if (chunk) chunks.push(chunk);
    });
    request.on?.("end", () => resolve());
    request.on?.("error", () => reject(new Error("Failed to read request body")));
  });

  const rawBody = chunks.map((chunk) => chunk.toString("utf8")).join("");
  return rawBody ? (JSON.parse(rawBody) as SemanticSearchBody) : {};
}

async function createEmbeddings(input: string[], apiKey: string) {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: embeddingModel,
      input,
      encoding_format: "float",
    }),
  });

  if (!response.ok) throw new Error("OpenAI embedding request failed");

  const data = (await response.json()) as OpenAIEmbeddingResponse;
  return (data.data || []).sort((a, b) => a.index - b.index).map((item) => item.embedding);
}

export default async function handler(request: RequestLike, response: ResponseLike) {
  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    sendJson(response, 503, { error: "Semantic search is not configured" });
    return;
  }

  try {
    const body = await readBody(request);
    const query = typeof body.query === "string" ? body.query.trim() : "";
    const movies = normalizeCandidates(body.movies);

    if (!query) {
      sendJson(response, 200, { movies: [] });
      return;
    }

    const embeddings = await createEmbeddings([query, ...movies.map(movieEmbeddingText)], apiKey);
    const queryEmbedding = embeddings[0];
    const movieEmbeddings = embeddings.slice(1);

    if (!queryEmbedding || movieEmbeddings.length !== movies.length) {
      throw new Error("OpenAI embedding response was incomplete");
    }

    const rankedMovies = movies
      .map((movie, index) => ({
        movie,
        score: cosineSimilarity(queryEmbedding, movieEmbeddings[index] || []),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(({ movie }) => movie);

    sendJson(response, 200, { movies: rankedMovies });
  } catch {
    sendJson(response, 502, { error: "Semantic search request failed" });
  }
}
