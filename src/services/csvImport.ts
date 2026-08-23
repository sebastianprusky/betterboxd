import type { Movie } from "../types";

export type CsvImportRow = {
  row: number;
  title: string;
  year?: string;
  rating?: number;
  watched?: boolean;
  review?: string;
  matchedMovie?: Movie;
  candidates?: Movie[];
  status: "matched" | "ambiguous" | "unmatched" | "searching";
};

function parseCsvRecords(text: string) {
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
  search: (query: string) => Promise<Movie[]>,
): Promise<CsvImportRow[]> {
  const resolved: CsvImportRow[] = [];
  for (const row of rows) {
    if (row.matchedMovie) { resolved.push(row); continue; }
    try {
      const searched = (await search(row.title)).slice(0, 8);
      const exact = searched
        .filter((movie) => normalized(movie.title) === normalized(row.title))
        .filter((movie) => !row.year || movie.year === row.year)
        .slice(0, 6);
      const candidates = exact.length ? exact : searched.slice(0, 6);
      resolved.push({
        ...row,
        candidates,
        matchedMovie: exact.length === 1 ? exact[0] : undefined,
        status: exact.length === 1 ? "matched" : candidates.length ? "ambiguous" : "unmatched",
      });
    } catch {
      resolved.push({ ...row, candidates: [], status: "unmatched" });
    }
  }
  return resolved;
}

export function selectCsvMatch(row: CsvImportRow, movie?: Movie): CsvImportRow {
  return { ...row, matchedMovie: movie, status: movie ? "matched" : row.candidates?.length ? "ambiguous" : "unmatched" };
}

function normalized(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
  if (titleIndex < 0) return [];
  return records.slice(1).map((cells, index) => {
    const title = cells[titleIndex]?.trim() || "";
    const year = yearIndex >= 0 ? cells[yearIndex]?.match(/\d{4}/)?.[0] : undefined;
    const matches = catalog.filter((movie) => {
      const sameTitle = movie.title.trim().toLowerCase() === title.toLowerCase();
      return sameTitle && (!year || movie.year === year);
    });
    const rawRating = ratingIndex >= 0 ? Number(cells[ratingIndex]) : undefined;
    const rating = rawRating && rawRating > 0 ? Math.min(5, rawRating > 5 ? rawRating / 2 : rawRating) : undefined;
    const watchedValue = watchedIndex >= 0 ? cells[watchedIndex]?.toLowerCase() : "";
    return {
      row: index + 2,
      title,
      year,
      rating,
      watched: Boolean(rating || ["yes", "true", "watched", "1"].includes(watchedValue)),
      review: reviewIndex >= 0 ? cells[reviewIndex]?.trim() : undefined,
      matchedMovie: matches.length === 1 ? matches[0] : undefined,
      status: matches.length === 1 ? "matched" : matches.length > 1 ? "ambiguous" : "unmatched",
    } satisfies CsvImportRow;
  }).filter((row) => row.title);
}
