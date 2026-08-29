import assert from "node:assert/strict";
import { File } from "node:buffer";
import { readFile } from "node:fs/promises";
import { strToU8, zipSync } from "fflate";
import { fallbackMovies } from "../src/data/fallbackMovies.ts";
import { resolveMovieCsvRows } from "../src/services/csvImport.ts";
import { parseMovieImportFile } from "../src/services/movieImport.ts";

const fixtures = [
  "wide-ranging-cinephile.zip",
  "midnight-genre-fan.zip",
  "comfort-blockbuster-fan.zip",
];

for (const filename of fixtures) {
  const bytes = await readFile(new URL(`test-data/letterboxd/${filename}`, `file://${process.cwd()}/`));
  const parsed = await parseMovieImportFile(new File([bytes], filename), []);
  assert.equal(parsed.summary.kind, "letterboxd-zip", `${filename} is recognized as a Letterboxd ZIP`);
  assert.equal(parsed.summary.files.length, 6, `${filename} contains the five core files plus liked films`);
  assert.equal(parsed.summary.rowCount, 240, `${filename} merges to 240 distinct movies`);
  assert.equal(parsed.summary.ratingCount, 160, `${filename} contains 160 usable ratings`);
  assert.ok(parsed.summary.likeCount >= 30, `${filename} contains a substantial liked-film set`);
  assert.equal(parsed.rows.filter((row) => row.review).length, 80, `${filename} contains 80 reviews`);
  assert.equal(parsed.rows.filter((row) => row.watched).length, 195, `${filename} contains 195 watched movies`);
  assert.equal(parsed.rows.filter((row) => row.saved).length, 45, `${filename} contains 45 watchlist movies`);
  assert.ok(parsed.rows.some((row) => row.rating === .5), `${filename} exercises the low end of the rating scale`);
  assert.ok(parsed.rows.some((row) => row.rating === 5), `${filename} exercises the high end of the rating scale`);
  assert.ok(parsed.rows.every((row) => row.letterboxdUri?.startsWith("https://letterboxd.com/film/")), `${filename} preserves Letterboxd URIs for automatic matching`);
}

const largeMovieCount = 5_000;
const largeCatalog = Array.from({ length: largeMovieCount }, (_, index) => ({
  ...fallbackMovies[index % fallbackMovies.length],
  id: 1_000_000 + index,
  title: `Large Profile Movie ${index}`,
  year: String(1980 + (index % 45)),
}));
const largeRatings = [
  "Date,Name,Year,Letterboxd URI,Rating",
  ...largeCatalog.map((movie, index) => `2026-01-01,${movie.title},${movie.year},https://letterboxd.com/film/large-profile-movie-${index}/,${.5 + (index % 10) * .5}`),
].join("\n");
const largeArchive = zipSync({ "ratings.csv": strToU8(largeRatings) });
const largeParsed = await parseMovieImportFile(new File([largeArchive], "large-realistic-profile.zip"), largeCatalog);
assert.equal(largeParsed.rows.length, largeMovieCount, "a 5,000-film profile parses without losing rows");
assert.equal(largeParsed.rows.filter((row) => row.matchedMovie).length, largeMovieCount, "indexed catalog matching handles a 5,000-film profile");

const resolutionCount = 2_500;
const unresolvedRows = largeParsed.rows.slice(0, resolutionCount).map((row) => ({ ...row, matchedMovie: undefined, status: "unmatched" }));
const moviesByTitle = new Map(largeCatalog.map((movie) => [movie.title, movie]));
let activeSearches = 0;
let peakSearches = 0;
let finalProgress;
const resolved = await resolveMovieCsvRows(unresolvedRows, async (query) => {
  activeSearches += 1;
  peakSearches = Math.max(peakSearches, activeSearches);
  await new Promise((resolve) => setImmediate(resolve));
  activeSearches -= 1;
  return moviesByTitle.has(query) ? [moviesByTitle.get(query)] : [];
}, {
  concurrency: 8,
  onProgress: (progress) => { finalProgress = progress; },
});
assert.equal(resolved.filter((row) => row.status === "matched").length, resolutionCount, "large unmatched batches resolve automatically");
assert.ok(resolved.every((row) => !row.candidates), "large imports do not retain candidate arrays for manual review");
assert.ok(peakSearches > 1 && peakSearches <= 8, "automatic matching uses bounded concurrency");
assert.deepEqual(finalProgress, { completed: resolutionCount, total: resolutionCount, matched: resolutionCount }, "large imports report complete progress");

console.log("Letterboxd fixtures and large-profile stress checks passed.");
