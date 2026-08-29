import assert from "node:assert/strict";
import { File } from "node:buffer";
import { readFile } from "node:fs/promises";
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

console.log("Synthetic Letterboxd fixtures passed parser and coverage checks.");
