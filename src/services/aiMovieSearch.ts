import type { AskPickAMovieResult, Movie, PickFilters, PromptMovieEvidence } from "../types";

function isMovie(value: unknown): value is Movie {
  if (!value || typeof value !== "object") return false;
  const movie = value as Partial<Movie>;
  return typeof movie.id === "number" && typeof movie.title === "string" && typeof movie.year === "string"
    && typeof movie.overview === "string" && Array.isArray(movie.genres);
}

function isPromptEvidence(value: unknown): value is PromptMovieEvidence {
  if (!value || typeof value !== "object") return false;
  const evidence = value as Partial<PromptMovieEvidence>;
  return typeof evidence.reason === "string" && typeof evidence.evidence === "string"
    && Array.isArray(evidence.matchedConstraints) && typeof evidence.fitScore === "number" && typeof evidence.confidence === "number";
}

export async function searchMoviesWithAi(query: string, filters?: PickFilters): Promise<AskPickAMovieResult> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 35_000);
  try {
    const response = await fetch("/api/ai-movie-search", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        filters: filters ? {
          genres: filters.genres,
          eras: filters.eras,
          runtimeMin: filters.runtimeMin,
          runtimeMax: filters.runtimeMax,
        } : undefined,
      }),
    });
    if (!response.ok) throw new Error(`AI movie search failed: ${response.status}`);
    const data = await response.json() as Partial<AskPickAMovieResult>;
    if (!Array.isArray(data.movies) || !data.movies.every(isMovie) || !data.movies.length) throw new Error("AI movie search returned no verified movies");
    if (!data.promptScores || !data.promptEvidence || !Object.values(data.promptEvidence).every(isPromptEvidence)) throw new Error("AI movie search returned incomplete evidence");
    return {
      movies: data.movies,
      debug: data.debug || {},
      filters: data.filters || [],
      promptScores: data.promptScores,
      promptEvidence: data.promptEvidence,
      serviceStatus: "full",
      explanation: data.explanation || "AI research matched these titles and TMDB verified their metadata.",
      resultMode: data.resultMode === "collection" ? "collection" : "curated",
      broadQuery: Boolean(data.broadQuery),
      verificationStatus: data.verificationStatus || "verified",
      usedWebSearch: Boolean(data.usedWebSearch),
    };
  } finally {
    window.clearTimeout(timeout);
  }
}
