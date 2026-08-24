import type { AskFilter } from "../types";

export type AskIntent = {
  filters: AskFilter[];
  genre?: string;
  yearFrom?: number;
  yearTo?: number;
  sortBy: string;
  semanticQuery: string;
  semanticTerms: string[];
  referenceTitle?: string;
  relationship?: "similar";
};

export const genreAliases: Record<string, string> = {
  action: "Action",
  adventure: "Adventure",
  animated: "Animation",
  animation: "Animation",
  anime: "Animation",
  comedy: "Comedy",
  comedies: "Comedy",
  funny: "Comedy",
  hilarious: "Comedy",
  humorous: "Comedy",
  crime: "Crime",
  documentary: "Documentary",
  documentaries: "Documentary",
  drama: "Drama",
  dramas: "Drama",
  family: "Family",
  fantasy: "Fantasy",
  historical: "History",
  history: "History",
  horror: "Horror",
  scary: "Horror",
  mystery: "Mystery",
  mysteries: "Mystery",
  music: "Music",
  musical: "Music",
  romance: "Romance",
  romantic: "Romance",
  "sci fi": "Sci-Fi",
  scifi: "Sci-Fi",
  "science fiction": "Sci-Fi",
  thriller: "Thriller",
  thrillers: "Thriller",
  "tv movie": "TV Movie",
  western: "Western",
  westerns: "Western",
  war: "War",
};

export const subjectiveTerms = [
  "bleak",
  "cozy",
  "dark",
  "emotional",
  "feel good",
  "funny",
  "gritty",
  "haunting",
  "mind bending",
  "moody",
  "slow burn",
  "tense",
  "thoughtful",
  "weird",
];

function normalizeGenreName(name: string) {
  return name.trim().toLowerCase() === "science fiction" ? "sci-fi" : name.trim().toLowerCase();
}

const referencePatterns = [
  /\b(?:movies?\s+)?similar\s+to\s+(.+)$/,
  /\b(?:something|movies?|films?|comed(?:y|ies)|dramas?|thrillers?|horrors?)\s+like\s+(.+)$/,
  /\b(?:in\s+the\s+vein\s+of|in\s+the\s+style\s+of)\s+(.+)$/,
];

function cleanReferenceTitle(value: string) {
  return value
    .replace(/\b(?:but|and)\s+(?:newer|older|shorter|longer|funnier|darker|lighter|scarier)\b.*$/, "")
    .replace(/\b(?:from|after|before|under|over)\s+(?:the\s+)?(?:19|20)\d{2}s?.*$/, "")
    .replace(/\b(?:that|which)\s+(?:is|are|was|were|has|have)\b.*$/, "")
    .trim();
}

function extractReferenceTitle(normalized: string) {
  for (const pattern of referencePatterns) {
    const match = normalized.match(pattern);
    const title = cleanReferenceTitle(match?.[1] || "");
    if (title) return title;
  }
  return undefined;
}

export function parseAskIntent(query: string): AskIntent {
  const normalized = query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const filters: AskFilter[] = [];
  let genre: string | undefined;
  let yearFrom: number | undefined;
  let yearTo: number | undefined;
  let sortBy = "popularity.desc";
  const semanticTerms: string[] = [];
  const referenceTitle = extractReferenceTitle(normalized);

  Object.entries(genreAliases).some(([alias, name]) => {
    const pattern = new RegExp(`\\b${alias.replace(/\s+/g, "\\s+")}\\b`);
    if (!pattern.test(normalized)) return false;
    genre = name;
    filters.push({ label: "Genre", value: name });
    return true;
  });

  const decade = normalized.match(/\b(19|20)(\d)0s\b/);
  if (decade) {
    yearFrom = Number(`${decade[1]}${decade[2]}0`);
    yearTo = yearFrom + 9;
  }

  const yearRange = normalized.match(/\b((?:19|20)\d{2})\s*(?:to|-|through)\s*((?:19|20)\d{2})\b/);
  if (yearRange) {
    yearFrom = Number(yearRange[1]);
    yearTo = Number(yearRange[2]);
  }

  const afterYear = normalized.match(/\b(?:after|since|from)\s+((?:19|20)\d{2})\b/);
  const beforeYear = normalized.match(/\b(?:before|until|pre)\s+((?:19|20)\d{2})\b/);
  if (afterYear && !yearFrom) yearFrom = Number(afterYear[1]);
  if (beforeYear && !yearTo) yearTo = Number(beforeYear[1]);

  if (/\b(?:new|newer|recent|latest)\b/.test(normalized)) {
    sortBy = "primary_release_date.desc";
    filters.push({ label: "Sort", value: "Newest first" });
  } else if (/\b(?:classic|older|old)\b/.test(normalized)) {
    sortBy = "primary_release_date.asc";
    filters.push({ label: "Sort", value: "Oldest first" });
  } else if (/\b(?:best|top|highest rated|great)\b/.test(normalized)) {
    sortBy = "vote_average.desc";
    filters.push({ label: "Sort", value: "Highest rated" });
  }

  if (yearFrom || yearTo) {
    filters.push({ label: "Years", value: yearFrom && yearTo ? `${yearFrom}-${yearTo}` : yearFrom ? `${yearFrom}+` : `Until ${yearTo}` });
  }

  subjectiveTerms.forEach((term) => {
    const pattern = new RegExp(`\\b${term.replace(/\s+/g, "\\s+")}\\b`);
    if (pattern.test(normalized)) semanticTerms.push(term);
  });

  const semanticQuery = [referenceTitle ? `movies similar to ${referenceTitle}` : "", genre, ...semanticTerms, normalized]
    .filter(Boolean)
    .join(" ")
    .trim();

  return {
    filters,
    genre,
    yearFrom,
    yearTo,
    sortBy,
    semanticQuery,
    semanticTerms,
    referenceTitle,
    relationship: referenceTitle ? "similar" : undefined,
  };
}

export function shouldUseSemanticRanking(intent: AskIntent) {
  return Boolean(intent.referenceTitle || intent.semanticTerms.length || !intent.filters.length);
}

export function matchesAskConstraints(movie: { genres: string[]; year: string }, intent: AskIntent) {
  if (intent.genre && !movie.genres.some((genre) => normalizeGenreName(genre) === normalizeGenreName(intent.genre || ""))) return false;
  const year = Number(movie.year);
  if (!Number.isFinite(year)) return true;
  if (intent.yearFrom && year < intent.yearFrom) return false;
  if (intent.yearTo && year > intent.yearTo) return false;
  return true;
}

export function blendPromptRelevance(baseScore: number, promptRelevance?: number) {
  if (promptRelevance === undefined) return baseScore;
  const boundedPrompt = Math.max(0, Math.min(1, promptRelevance));
  return baseScore * 0.35 + boundedPrompt * 0.65;
}
