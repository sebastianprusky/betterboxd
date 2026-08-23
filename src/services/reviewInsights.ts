import type { ReviewAspect } from "../types";

export async function analyzeReview(movieTitle: string, review: string): Promise<ReviewAspect[]> {
  const response = await fetch("/api/review-insights", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ movieTitle, review }),
  });
  if (!response.ok) throw new Error("Review analysis is unavailable");
  const data = await response.json() as { aspects?: Array<Omit<ReviewAspect, "id" | "createdAt">> };
  return (data.aspects || []).slice(0, 8).map((aspect, index) => ({
    ...aspect,
    id: `${Date.now()}-${index}`,
    createdAt: Date.now(),
  }));
}
