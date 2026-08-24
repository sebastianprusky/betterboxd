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

type SearchPlanBody = { query?: unknown };
type SearchResult = { status: number; body: unknown };

const plannerModel = "gpt-5.6-luna";
const maxRequestBytes = 4_000;
const maxQueryLength = 200;
const rateLimitWindowMs = 60_000;
const maxRequestsPerWindow = 30;
const planCacheTtlMs = 6 * 60 * 60 * 1000;

type RateLimitEntry = { count: number; resetAt: number };
type PlanCacheEntry = { value: unknown; expiresAt: number };

class RequestBodyError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const sharedState = globalThis as typeof globalThis & {
  __pickAMoviePlanRateLimits?: Map<string, RateLimitEntry>;
  __pickAMoviePlanCache?: Map<string, PlanCacheEntry>;
};
const rateLimits = sharedState.__pickAMoviePlanRateLimits ?? new Map<string, RateLimitEntry>();
const planCache = sharedState.__pickAMoviePlanCache ?? new Map<string, PlanCacheEntry>();
sharedState.__pickAMoviePlanRateLimits = rateLimits;
sharedState.__pickAMoviePlanCache = planCache;

const searchPlanSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    interpretation: { type: "string", maxLength: 180 },
    resultMode: { type: "string", enum: ["curated", "collection"] },
    semanticQuery: { type: "string", maxLength: 240 },
    searchTerms: { type: "array", maxItems: 5, items: { type: "string", maxLength: 100 } },
    seedTitles: { type: "array", maxItems: 20, items: { type: "string", maxLength: 120 } },
    companyNames: { type: "array", maxItems: 5, items: { type: "string", maxLength: 100 } },
    keywordNames: { type: "array", maxItems: 5, items: { type: "string", maxLength: 100 } },
    personNames: { type: "array", maxItems: 5, items: { type: "string", maxLength: 100 } },
    genres: { type: "array", maxItems: 4, items: { type: "string", maxLength: 40 } },
    yearFrom: { type: ["integer", "null"], minimum: 1880, maximum: 2100 },
    yearTo: { type: ["integer", "null"], minimum: 1880, maximum: 2100 },
    sortBy: { type: "string", enum: ["relevance", "popularity", "rating", "release_date"] },
    includeUnreleased: { type: "boolean" },
  },
  required: ["interpretation", "resultMode", "semanticQuery", "searchTerms", "seedTitles", "companyNames", "keywordNames", "personNames", "genres", "yearFrom", "yearTo", "sortBy", "includeUnreleased"],
} as const;

function sendJson(body: unknown, status = 200) { return Response.json(body, { status }); }
function sendNodeJson(response: NodeResponse, result: SearchResult) {
  response.statusCode = result.status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(result.body));
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

async function readBody(request: Request): Promise<SearchPlanBody> {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > maxRequestBytes) throw new RequestBodyError(413, "Search plan request is too large");
  const rawBody = await request.text();
  if (rawBody.length > maxRequestBytes) throw new RequestBodyError(413, "Search plan request is too large");
  if (!rawBody) return {};
  try { return JSON.parse(rawBody) as SearchPlanBody; }
  catch { throw new RequestBodyError(400, "Search plan request must be valid JSON"); }
}

async function readNodeBody(request: NodeRequest): Promise<SearchPlanBody> {
  if (request.body && typeof request.body === "object") return request.body as SearchPlanBody;
  if (typeof request.body === "string") return JSON.parse(request.body) as SearchPlanBody;
  if (!request.on) return {};
  const chunks: string[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    request.on?.("data", (chunk) => {
      const value = chunk?.toString("utf8") || "";
      size += value.length;
      if (size > maxRequestBytes) reject(new RequestBodyError(413, "Search plan request is too large"));
      else chunks.push(value);
    });
    request.on?.("end", () => resolve());
    request.on?.("error", () => reject(new Error("Failed to read request body")));
  });
  try { return chunks.length ? JSON.parse(chunks.join("")) as SearchPlanBody : {}; }
  catch { throw new RequestBodyError(400, "Search plan request must be valid JSON"); }
}

function outputText(value: unknown) {
  const response = value as { output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
  return (response.output || []).flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text || "";
}

async function createSearchPlan(body: SearchPlanBody, rateLimitKey: string): Promise<SearchResult> {
  const configuredApiKey = process.env.OPENAI_API_KEY;
  const apiKey = configuredApiKey && configuredApiKey.trim().length >= 20 && !configuredApiKey.includes("REDACTED") ? configuredApiKey.trim() : undefined;
  if (!apiKey) return { status: 503, body: { error: "AI search planning is not configured" } };
  if (!checkRateLimit(rateLimitKey)) return { status: 429, body: { error: "AI search planning rate limit exceeded" } };

  const query = typeof body.query === "string" ? body.query.trim().slice(0, maxQueryLength) : "";
  if (query.length < 3) return { status: 400, body: { error: "Enter a longer movie request" } };
  const cacheKey = `v2:${query.toLowerCase().replace(/\s+/g, " ")}`;
  const cached = planCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return { status: 200, body: { plan: cached.value, debug: { status: "cache", model: plannerModel } } };

  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: plannerModel,
        instructions: `Interpret a movie-discovery request into a retrieval plan for TMDB. Today is ${new Date().toISOString().slice(0, 10)}. Infer the general concept, including franchises, studios, source properties, people, time periods, and subjective qualities. For any objective franchise, studio, cinematic-universe, source-property, decade, or filmography set, use resultMode collection and list up to 20 canonical matching released films in seedTitles, ordered by how central and recognizable they are. Seed titles are essential for named sets; do not leave them empty when well-known matching films exist. Set includeUnreleased true only when the user explicitly asks for upcoming, future, or unreleased films. Otherwise exclude films releasing after today. Use relevance for broad named sets unless the user explicitly asks for newest, highest-rated, or most popular. For a request asking for a few personalized options or movies similar to one title, use curated. Do not invent titles. searchTerms should be concise TMDB text searches. companyNames and keywordNames must be concepts likely to exist in TMDB. Return only the schema.`,
        input: query,
        reasoning: { effort: "none" },
        max_output_tokens: 700,
        store: false,
        text: { format: { type: "json_schema", name: "movie_search_plan", strict: true, schema: searchPlanSchema } },
      }),
    });
    if (!response.ok) return { status: 502, body: { error: "AI search planning failed" } };
    const data = await response.json();
    const text = outputText(data);
    if (!text) return { status: 502, body: { error: "AI search planning returned no plan" } };
    const plan = JSON.parse(text);
    planCache.set(cacheKey, { value: plan, expiresAt: Date.now() + planCacheTtlMs });
    return { status: 200, body: { plan, debug: { status: "openai", model: plannerModel, usage: data.usage } } };
  } catch {
    return { status: 502, body: { error: "AI search planning failed" } };
  } finally { globalThis.clearTimeout(timeout); }
}

export async function POST(request: Request) {
  try {
    const result = await createSearchPlan(await readBody(request), getRateLimitKey(request.headers));
    return sendJson(result.body, result.status);
  } catch (error) {
    const status = error instanceof RequestBodyError ? error.status : 400;
    return sendJson({ error: error instanceof Error ? error.message : "Invalid search plan request" }, status);
  }
}
export function OPTIONS() { return new Response(null, { status: 204 }); }
export function GET() { return sendJson({ error: "Method not allowed" }, 405); }
export function handleSearchPlanRequest(request: Request) {
  if (request.method === "OPTIONS") return OPTIONS();
  if (request.method === "POST") return POST(request);
  return GET();
}

export default async function handler(request: Request | NodeRequest, response?: NodeResponse) {
  if (!response) return handleSearchPlanRequest(request as Request);
  const nodeRequest = request as NodeRequest;
  if (request.method === "OPTIONS") { response.statusCode = 204; response.end(); return; }
  if (request.method !== "POST") return sendNodeJson(response, { status: 405, body: { error: "Method not allowed" } });
  try {
    const result = await createSearchPlan(await readNodeBody(nodeRequest), getRateLimitKey(nodeRequest.headers));
    return sendNodeJson(response, result);
  } catch (error) {
    const status = error instanceof RequestBodyError ? error.status : 400;
    return sendNodeJson(response, { status, body: { error: error instanceof Error ? error.message : "Invalid search plan request" } });
  }
}
