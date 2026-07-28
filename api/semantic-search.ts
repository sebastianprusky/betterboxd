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

type OpenAIEmbedding = {
  embedding: number[];
  index: number;
};

type OpenAIEmbeddingResponse = {
  data?: OpenAIEmbedding[];
};

const embeddingModel = "text-embedding-3-small";
const maxCandidates = 50;
const maxResults = 20;

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

function normalizeCandidates(value: unknown): Movie[] {
  const movies = Array.isArray(value) ? value.filter(isMovie) : [];
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

async function readBody(request: Request): Promise<SemanticSearchBody> {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? (body as SemanticSearchBody) : {};
  } catch {
    return {};
  }
}

async function readNodeBody(request: NodeRequest): Promise<SemanticSearchBody> {
  try {
    if (request.body && typeof request.body === "object") return request.body as SemanticSearchBody;
    if (typeof request.body === "string") return JSON.parse(request.body) as SemanticSearchBody;
    if (!request.on) return {};

    const chunks: string[] = [];
    await new Promise<void>((resolve, reject) => {
      request.on?.("data", (chunk) => {
        if (chunk) chunks.push(chunk.toString("utf8"));
      });
      request.on?.("end", () => resolve());
      request.on?.("error", () => reject(new Error("Failed to read request body")));
    });

    const rawBody = chunks.join("");
    return rawBody ? (JSON.parse(rawBody) as SemanticSearchBody) : {};
  } catch {
    return {};
  }
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

async function searchSemantically(body: SemanticSearchBody): Promise<SearchResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { status: 503, body: { error: "Semantic search is not configured" } };
  }

  try {
    const query = typeof body.query === "string" ? body.query.trim() : "";
    const movies = normalizeCandidates(body.movies);

    if (!query) {
      return { status: 200, body: { movies: [] } };
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

    return { status: 200, body: { movies: rankedMovies } };
  } catch {
    return { status: 502, body: { error: "Semantic search request failed" } };
  }
}

export async function POST(request: Request) {
  const result = await searchSemantically(await readBody(request));
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

  sendNodeJson(response, await searchSemantically(await readNodeBody(request as NodeRequest)));
}
