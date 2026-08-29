import type { Movie, RatingMap, ReviewMap, WatchedMap, WatchlistMap } from "../types";
import { parseCsvRecords, parseMovieCsv, type CsvImportRow } from "./csvImport";

const MAX_COMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_SELECTED_CSV_BYTES = 25 * 1024 * 1024;
const LETTERBOXD_FILES = new Set(["ratings.csv", "watched.csv", "diary.csv", "reviews.csv", "watchlist.csv"]);

export type MovieImportSummary = {
  kind: "letterboxd-zip" | "letterboxd-csv" | "generic-csv";
  files: string[];
  rowCount: number;
  ratingCount: number;
};

export function mergeImportedRows(rows: CsvImportRow[], current: { ratings: RatingMap; reviews: ReviewMap; watched: WatchedMap; watchlist: WatchlistMap }, now = Date.now()) {
  const ratings = { ...current.ratings };
  const reviews = { ...current.reviews };
  const watched = { ...current.watched };
  const watchlist = { ...current.watchlist };
  const touched: string[] = ["csv-import"];
  rows.forEach((row) => {
    const movie = row.matchedMovie;
    if (!movie) return;
    if (row.watched || row.rating) { watched[movie.id] ||= { movie, watchedAt: now }; touched.push(`watched:${movie.id}`); }
    if (row.rating !== undefined) { ratings[movie.id] = row.rating; touched.push(`rating:${movie.id}`); }
    if (row.review) { reviews[movie.id] = row.review; touched.push(`review:${movie.id}`); }
    if (row.saved) { watchlist[movie.id] = movie; touched.push(`watchlist:${movie.id}`); }
  });
  return { ratings, reviews, watched, watchlist, touched };
}

export async function parseMovieImportFile(file: File, catalog: Movie[]): Promise<{ rows: CsvImportRow[]; summary: MovieImportSummary }> {
  if (file.size > MAX_COMPRESSED_BYTES) throw new Error("Choose a file smaller than 50 MB.");
  if (file.name.toLowerCase().endsWith(".zip")) return parseLetterboxdZip(file, catalog);
  if (!file.name.toLowerCase().endsWith(".csv")) throw new Error("Choose a Letterboxd ZIP or CSV file.");
  if (file.size > MAX_SELECTED_CSV_BYTES) throw new Error("CSV imports are limited to 25 MB.");
  const text = await file.text();
  const basename = file.name.split(/[\\/]/).pop()?.toLowerCase() || "import.csv";
  const letterboxd = LETTERBOXD_FILES.has(basename);
  const rows = letterboxd ? mergeLetterboxdFiles([{ name: basename, text }], catalog) : parseMovieCsv(text, catalog);
  return { rows, summary: summarize(rows, letterboxd ? "letterboxd-csv" : "generic-csv", [basename]) };
}

async function parseLetterboxdZip(file: File, catalog: Movie[]) {
  const { unzipSync, strFromU8 } = await import("fflate");
  const archive = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const selected: Array<{ name: string; text: string }> = [];
  let selectedBytes = 0;
  for (const [path, bytes] of Object.entries(archive)) {
    const basename = path.split("/").pop()?.toLowerCase() || "";
    if (!LETTERBOXD_FILES.has(basename)) continue;
    selectedBytes += bytes.byteLength;
    if (selectedBytes > MAX_SELECTED_CSV_BYTES) throw new Error("The recognized Letterboxd CSV data exceeds 25 MB.");
    selected.push({ name: basename, text: strFromU8(bytes) });
  }
  if (!selected.length) throw new Error("This ZIP does not contain recognized Letterboxd export files.");
  const rows = mergeLetterboxdFiles(selected, catalog);
  return { rows, summary: summarize(rows, "letterboxd-zip" as const, selected.map((item) => item.name)) };
}

function mergeLetterboxdFiles(files: Array<{ name: string; text: string }>, catalog: Movie[]) {
  const merged = new Map<string, CsvImportRow & { ratingPriority?: number }>();
  let nextRow = 2;
  for (const file of files) {
    const records = parseCsvRecords(file.text.replace(/^\uFEFF/, ""));
    if (records.length < 2) continue;
    const headers = records[0].map(normalizeHeader);
    const titleIndex = column(headers, "name", "title");
    const yearIndex = column(headers, "year");
    const ratingIndex = column(headers, "rating");
    const reviewIndex = column(headers, "review");
    const dateIndex = column(headers, "date", "watcheddate");
    if (titleIndex < 0) continue;
    for (const cells of records.slice(1)) {
      const title = cells[titleIndex]?.trim();
      if (!title) continue;
      const year = yearIndex >= 0 ? cells[yearIndex]?.match(/\d{4}/)?.[0] : undefined;
      const key = `${normalize(title)}|${year || ""}`;
      const existing = merged.get(key);
      const matches = catalog.filter((movie) => normalize(movie.title) === normalize(title) && (!year || movie.year === year));
      const rawRating = ratingIndex >= 0 ? Number(cells[ratingIndex]) : 0;
      const rating = rawRating > 0 ? Math.min(5, rawRating > 5 ? rawRating / 2 : rawRating) : undefined;
      const ratingPriority = file.name === "ratings.csv" ? 2 : rating ? 1 : 0;
      const review = reviewIndex >= 0 ? cells[reviewIndex]?.trim() : undefined;
      const reviewDate = dateIndex >= 0 ? cells[dateIndex]?.trim() : undefined;
      const sourceWatched = ["ratings.csv", "watched.csv", "diary.csv", "reviews.csv"].includes(file.name);
      const next: CsvImportRow & { ratingPriority?: number } = existing ? { ...existing } : {
        row: nextRow++, title, year, matchedMovie: matches.length === 1 ? matches[0] : undefined,
        status: matches.length === 1 ? "matched" : matches.length > 1 ? "ambiguous" : "unmatched",
      };
      next.sources = Array.from(new Set([...(next.sources || []), file.name]));
      next.watched = Boolean(next.watched || sourceWatched || rating);
      next.saved = Boolean(next.saved || file.name === "watchlist.csv");
      if (rating && ratingPriority >= (next.ratingPriority || 0)) { next.rating = rating; next.ratingPriority = ratingPriority; }
      if (review && (!next.review || (reviewDate || "") >= (next.reviewDate || ""))) { next.review = review; next.reviewDate = reviewDate; }
      merged.set(key, next);
    }
  }
  return [...merged.values()].map(({ ratingPriority: _ratingPriority, ...row }) => row);
}

function summarize(rows: CsvImportRow[], kind: MovieImportSummary["kind"], files: string[]): MovieImportSummary {
  return { kind, files: Array.from(new Set(files)).sort(), rowCount: rows.length, ratingCount: rows.filter((row) => row.rating).length };
}

function normalize(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function normalizeHeader(value: string) { return value.toLowerCase().replace(/[^a-z]/g, ""); }
function column(headers: string[], ...names: string[]) { return headers.findIndex((header) => names.includes(header)); }
