import type { Movie } from "../types";

export type CsvImportRow = {
  row: number;
  title: string;
  year?: string;
  rating?: number;
  watched?: boolean;
  review?: string;
  matchedMovie?: Movie;
  status: "matched" | "ambiguous" | "unmatched";
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
