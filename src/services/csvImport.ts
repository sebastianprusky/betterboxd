import type { Movie } from "../types";

export type CsvImportRow = {
  row: number;
  title: string;
  year?: string;
  rating?: number;
  watched?: boolean;
  saved?: boolean;
  liked?: boolean;
  review?: string;
  reviewDate?: string;
  letterboxdUri?: string;
  sources?: string[];
  matchedMovie?: Movie;
  candidates?: Movie[];
  matchConfidence?: number;
  matchReason?: string;
  status: "matched" | "unmatched" | "searching";
};

export type ImportResolutionProgress = { completed: number; total: number; matched: number };
export type ImportResolutionOptions = {
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (progress: ImportResolutionProgress) => void;
};

export function parseCsvRecords(text: string) {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) { record.push(cell.trim()); cell = ""; }
    else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      record.push(cell.trim()); cell = "";
      if (record.some(Boolean)) records.push(record);
      record = [];
    }
    else cell += character;
  }
  record.push(cell.trim());
  if (record.some(Boolean)) records.push(record);
  return records;
}

export async function resolveMovieCsvRows(
  rows: CsvImportRow[],
  search: (query: string, year?: string) => Promise<Movie[]>,
  options: ImportResolutionOptions = {},
): Promise<CsvImportRow[]> {
  const resolved = new Array<CsvImportRow>(rows.length);
  let cursor = 0;
  let completed = 0;
  let matched = 0;
  const total = rows.length;
  const concurrency = Math.min(8, Math.max(1, options.concurrency || 6));
  const searchCache = new Map<string, Promise<Movie[]>>();
  const reportProgress = () => options.onProgress?.({ completed, total, matched });
  reportProgress();
  const worker = async () => {
    while (cursor < rows.length && !options.signal?.aborted) {
      const index = cursor++;
      const row = rows[index];
      let next = row;
      if (!row.matchedMovie) {
        try {
          const cacheKey = `${canonicalMovieTitle(row.title)}|${row.year || ""}`;
          let request = searchCache.get(cacheKey);
          if (!request) {
            request = searchWithRetry(search, row.title, row.year, options.signal);
            searchCache.set(cacheKey, request);
          }
          next = resolveImportCandidates(row, await request);
        } catch {
          next = { ...row, candidates: undefined, matchedMovie: undefined, matchReason: "No match found", status: "unmatched" };
        }
      }
      resolved[index] = next;
      completed += 1;
      if (next.matchedMovie) matched += 1;
      if (completed === total || completed % 25 === 0) reportProgress();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, rows.length)) }, worker));
  reportProgress();
  return resolved.filter(Boolean);
}

async function searchWithRetry(search: (query: string, year?: string) => Promise<Movie[]>, title: string, year?: string, signal?: AbortSignal) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (signal?.aborted) return [];
    try { return await search(title, year); }
    catch (error) {
      lastError = error;
      if (attempt < 2) await wait(200 * 2 ** attempt, signal);
    }
  }
  throw lastError;
}

function wait(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timeout = globalThis.setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => { globalThis.clearTimeout(timeout); resolve(); }, { once: true });
  });
}

export function resolveImportCandidates(row: CsvImportRow, searched: Movie[]): CsvImportRow {
  const candidates = [...new Map(searched.map((movie) => [movie.id, movie])).values()]
    .map((movie) => ({ movie, ...importMatchScore(row, movie) }))
    .sort((left, right) => right.score - left.score || (right.movie.popularity || 0) - (left.movie.popularity || 0) || left.movie.title.localeCompare(right.movie.title))
    .slice(0, 6);
  if (!candidates.length) return { ...row, candidates: undefined, matchedMovie: undefined, matchReason: "No match found", status: "unmatched" };
  const exactTitle = candidates.filter((candidate) => candidate.exactTitle);
  const exactYear = exactTitle.filter((candidate) => candidate.yearDifference === 0);
  const nearbyYear = exactTitle.filter((candidate) => candidate.yearDifference !== null && candidate.yearDifference <= 1);
  const best = candidates[0];
  const margin = best.score - (candidates[1]?.score || 0);
  const isLetterboxd = Boolean(row.letterboxdUri || row.sources?.some((source) => source === "likes/films.csv" || /^(ratings|watched|diary|reviews|watchlist)\.csv$/.test(source)));
  let matched: typeof best | undefined;
  let reason = "";
  if (row.year && exactYear.length) { matched = exactYear[0]; reason = "Matched by exact title and year"; }
  else if (row.year && !exactYear.length && nearbyYear.length === 1 && exactTitle.length === 1) { matched = nearbyYear[0]; reason = "Matched by title and nearby release year"; }
  else if (!row.year && exactTitle.length === 1) { matched = exactTitle[0]; reason = "Matched by unique exact title"; }
  else if (row.year && best.titleScore >= .86 && best.yearDifference === 0 && best.score >= .86 && margin >= .12) { matched = best; reason = "Matched by title similarity and year"; }
  else if (isLetterboxd && row.year && best.titleScore >= .86 && best.yearDifference !== null && best.yearDifference <= 1) { matched = best; reason = "Automatically matched by title and release year"; }
  else if (isLetterboxd && !row.year && best.titleScore >= .9) { matched = best; reason = "Automatically matched by title"; }
  return {
    ...row,
    candidates: undefined,
    matchedMovie: matched?.movie,
    matchConfidence: matched?.score || best.score,
    matchReason: matched ? reason : "No confident match found",
    status: matched ? "matched" : "unmatched",
  };
}

function importMatchScore(row: CsvImportRow, movie: Movie) {
  const expected = canonicalMovieTitle(row.title);
  const candidate = canonicalMovieTitle(movie.title);
  const originalCandidate = movie.originalTitle ? canonicalMovieTitle(movie.originalTitle) : "";
  const exactTitle = expected === candidate || Boolean(originalCandidate && expected === originalCandidate);
  const titleScore = exactTitle ? 1 : Math.max(importTitleRelevance(expected, candidate), originalCandidate ? importTitleRelevance(expected, originalCandidate) : 0);
  const importedYear = Number(row.year);
  const movieYear = Number(movie.year);
  const yearDifference = Number.isFinite(importedYear) && Number.isFinite(movieYear) ? Math.abs(importedYear - movieYear) : null;
  const yearScore = yearDifference === 0 ? 1 : yearDifference === 1 ? .75 : yearDifference === null ? .55 : 0;
  const popularityScore = Math.min(1, Math.log10(1 + Math.max(0, movie.popularity || 0)) / 2.5);
  return { exactTitle, titleScore, yearDifference, score: titleScore * .75 + yearScore * .2 + popularityScore * .05 };
}

export function canonicalMovieTitle(value: string) {
  const decomposed = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  const article = decomposed.match(/^(.*),\s*(the|an|a)$/);
  const reordered = article ? `${article[2]} ${article[1]}` : decomposed;
  return reordered.replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

const importAliases: Record<string, string[]> = {
  "se7en": ["seven"],
  "seven": ["se7en"],
  "et": ["e t", "e t the extra terrestrial", "et the extra terrestrial"],
  "e t": ["et", "e t the extra terrestrial", "et the extra terrestrial"],
  "e t the extra terrestrial": ["et", "e t"],
  "et the extra terrestrial": ["et", "e t"],
  "wall e": ["walle"],
  "walle": ["wall e"],
};

function importTitleRelevance(expected: string, candidate: string) {
  const expectedForms = new Set([expected, ...(importAliases[expected] || [])]);
  const candidateForms = new Set([candidate, ...(importAliases[candidate] || [])]);
  if ([...expectedForms].some((value) => candidateForms.has(value))) return 1;
  const distance = Math.min(...[...expectedForms].flatMap((left) => [...candidateForms].map((right) => editDistance(left, right))));
  const length = Math.max(expected.length, candidate.length);
  if (length >= 4 && distance <= 1) return .9;
  if (length >= 7 && distance <= 2) return .86;
  if ([...expectedForms].some((value) => [...candidateForms].some((other) => other.startsWith(value) || value.startsWith(other)))) return .72;
  return 0;
}

function editDistance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0]; previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const old = previous[column];
      previous[column] = Math.min(previous[column] + 1, previous[column - 1] + 1, diagonal + (left[row - 1] === right[column - 1] ? 0 : 1));
      diagonal = old;
    }
  }
  return previous[right.length];
}

function findColumn(headers: string[], candidates: string[]) {
  return headers.findIndex((header) => candidates.includes(header.toLowerCase().replace(/[^a-z]/g, "")));
}

export function parseMovieCsv(text: string, catalog: Movie[]): CsvImportRow[] {
  const records = parseCsvRecords(text.replace(/^\uFEFF/, ""));
  if (records.length < 2) return [];
  const headers = records[0];
  const titleIndex = findColumn(headers, ["title", "name", "movietitle"]);
  const yearIndex = findColumn(headers, ["year", "releaseyear"]);
  const ratingIndex = findColumn(headers, ["rating", "stars", "score"]);
  const watchedIndex = findColumn(headers, ["watched", "watchedstatus", "seen"]);
  const reviewIndex = findColumn(headers, ["review", "notes", "comment"]);
  const savedIndex = findColumn(headers, ["saved", "watchlist", "watchlisted"]);
  if (titleIndex < 0) return [];
  const catalogByTitle = new Map<string, Movie[]>();
  catalog.forEach((movie) => {
    const title = canonicalMovieTitle(movie.title);
    const matches = catalogByTitle.get(title);
    if (matches) matches.push(movie);
    else catalogByTitle.set(title, [movie]);
  });
  return records.slice(1).map((cells, index) => {
    const title = cells[titleIndex]?.trim() || "";
    const year = yearIndex >= 0 ? cells[yearIndex]?.match(/\d{4}/)?.[0] : undefined;
    const matches = (catalogByTitle.get(canonicalMovieTitle(title)) || []).filter((movie) => !year || movie.year === year);
    const rawRating = ratingIndex >= 0 ? Number(cells[ratingIndex]) : undefined;
    const rating = rawRating && rawRating > 0 ? Math.min(5, rawRating > 5 ? rawRating / 2 : rawRating) : undefined;
    const watchedValue = watchedIndex >= 0 ? cells[watchedIndex]?.toLowerCase() : "";
    const savedValue = savedIndex >= 0 ? cells[savedIndex]?.toLowerCase() : "";
    return {
      row: index + 2,
      title,
      year,
      rating,
      watched: Boolean(rating || ["yes", "true", "watched", "1"].includes(watchedValue)),
      saved: ["yes", "true", "saved", "watchlist", "1"].includes(savedValue),
      review: reviewIndex >= 0 ? cells[reviewIndex]?.trim() : undefined,
      sources: ["CSV"],
      matchedMovie: matches.length === 1 ? matches[0] : undefined,
      status: matches.length === 1 ? "matched" : "unmatched",
    } satisfies CsvImportRow;
  }).filter((row) => row.title);
}
