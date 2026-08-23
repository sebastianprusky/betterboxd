declare const process: { env: Record<string, string | undefined> };

type NodeRequest = { method?: string; body?: unknown; headers?: Record<string, string | string[] | undefined> };
type NodeResponse = { statusCode: number; setHeader: (name: string, value: string) => void; end: (body?: string) => void };

function json(body: unknown, status = 200) { return Response.json(body, { status }); }

const attempts = new Map<string, number[]>();
function isRateLimited(key: string) {
  const cutoff = Date.now() - 60_000;
  const recent = (attempts.get(key) || []).filter((time) => time > cutoff);
  if (recent.length >= 8) return true;
  attempts.set(key, [...recent, Date.now()]);
  return false;
}

function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

async function analyze(body: unknown) {
  const input = body && typeof body === "object" ? body as { movieTitle?: unknown; review?: unknown } : {};
  const movieTitle = typeof input.movieTitle === "string" ? input.movieTitle.trim().slice(0, 160) : "";
  const review = typeof input.review === "string" ? input.review.trim().slice(0, 4000) : "";
  if (!movieTitle || review.length < 8) return { status: 400, body: { error: "A movie and review are required" } };
  const configuredApiKey = process.env.OPENAI_API_KEY;
  const apiKey = configuredApiKey && configuredApiKey.trim().length >= 20 && !configuredApiKey.includes("REDACTED") ? configuredApiKey.trim() : undefined;
  if (!apiKey) return { status: 503, body: { error: "Review analysis is not configured" } };
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Extract up to 6 concise movie-taste aspects from a private review. Return JSON {aspects:[{label,sentiment,confidence}]}. sentiment is positive or negative; confidence is 0 to 1. Do not infer demographics or sensitive traits." },
        { role: "user", content: `Movie: ${movieTitle}\nReview: ${review}` },
      ],
    }),
  });
  if (!response.ok) return { status: 502, body: { error: "Review analysis failed" } };
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  try {
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}") as { aspects?: unknown[] };
    const aspects = (parsed.aspects || []).filter((value): value is { label: string; sentiment: string; confidence: number } => {
      if (!value || typeof value !== "object") return false;
      const item = value as { label?: unknown; sentiment?: unknown; confidence?: unknown };
      return typeof item.label === "string" && ["positive", "negative"].includes(String(item.sentiment)) && typeof item.confidence === "number";
    }).slice(0, 6).map((aspect) => ({
      label: aspect.label.trim().slice(0, 60),
      sentiment: aspect.sentiment,
      confidence: Math.max(0, Math.min(aspect.confidence, 1)),
    }));
    return { status: 200, body: { aspects } };
  } catch {
    return { status: 502, body: { error: "Review analysis returned an invalid response" } };
  }
}

export async function POST(request: Request) {
  try {
    const client = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    if (isRateLimited(client)) return json({ error: "Too many review requests" }, 429);
    const result = await analyze(await request.json());
    return json(result.body, result.status);
  } catch { return json({ error: "Invalid request" }, 400); }
}

export async function handleReviewInsightsRequest(request: Request) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  return POST(request);
}

export default async function handler(request: NodeRequest, response: NodeResponse) {
  if (request.method !== "POST") { response.statusCode = 405; response.end(); return; }
  const client = firstHeader(request.headers?.["x-forwarded-for"])?.split(",")[0]?.trim() || "local";
  if (isRateLimited(client)) { response.statusCode = 429; response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ error: "Too many review requests" })); return; }
  const result = await analyze(request.body);
  response.statusCode = result.status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(result.body));
}
