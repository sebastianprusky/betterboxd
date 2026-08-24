export type SearchPlan = {
  interpretation: string;
  resultMode: "curated" | "collection";
  semanticQuery: string;
  searchTerms: string[];
  seedTitles: string[];
  companyNames: string[];
  keywordNames: string[];
  personNames: string[];
  genres: string[];
  yearFrom: number | null;
  yearTo: number | null;
  sortBy: "relevance" | "popularity" | "rating" | "release_date";
  includeUnreleased: boolean;
};

function isSearchPlan(value: unknown): value is SearchPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Partial<SearchPlan>;
  return typeof plan.interpretation === "string"
    && (plan.resultMode === "curated" || plan.resultMode === "collection")
    && typeof plan.semanticQuery === "string"
    && Array.isArray(plan.searchTerms)
    && Array.isArray(plan.seedTitles)
    && Array.isArray(plan.companyNames)
    && Array.isArray(plan.keywordNames)
    && Array.isArray(plan.personNames)
    && Array.isArray(plan.genres)
    && typeof plan.includeUnreleased === "boolean";
}

export async function planMovieSearch(query: string): Promise<SearchPlan | null> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 9_000);
  try {
    const response = await fetch("/api/search-plan", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!response.ok) return null;
    const data = await response.json() as { plan?: unknown };
    return isSearchPlan(data.plan) ? data.plan : null;
  } catch { return null; }
  finally { window.clearTimeout(timeout); }
}
