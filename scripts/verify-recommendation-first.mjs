import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decayingPickWeight, getRatingSignal, isMovieExcluded } from "../src/services/recommendationPolicy.ts";
import { canonicalMovieTitle, parseMovieCsv, resolveImportCandidates, resolveMovieCsvRows } from "../src/services/csvImport.ts";
import { fallbackMovies } from "../src/data/fallbackMovies.ts";

assert(getRatingSignal(5) > getRatingSignal(4));
assert(getRatingSignal(1) < 0);
assert(decayingPickWeight(Date.now()) > decayingPickWeight(Date.now() - 60 * 86_400_000));

const watchedMovie = fallbackMovies[0];
const rejectedMovie = fallbackMovies[1];
const watched = { [watchedMovie.id]: { movie: watchedMovie, watchedAt: Date.now() } };
const interest = { [rejectedMovie.id]: { movie: rejectedMovie, value: "notInterested", updatedAt: Date.now() } };
assert(isMovieExcluded(watchedMovie.id, watched, interest), "watched movies must be excluded");
assert(isMovieExcluded(rejectedMovie.id, watched, interest), "lasting rejections must be excluded");
assert(!isMovieExcluded(fallbackMovies[2].id, watched, interest), "unreviewed movies remain eligible");

const csv = `Title,Year,Rating,Watched,Review\nParasite,2019,4.5,yes,Sharp and tense\nUnknown,2020,,yes,`;
const rows = parseMovieCsv(csv, fallbackMovies);
assert.equal(rows[0].status, "matched");
assert.equal(rows[0].rating, 4.5);
assert.equal(rows[0].review, "Sharp and tense");
assert.equal(rows[1].status, "unmatched");
const quotedRows = parseMovieCsv(`Title,Year,Review\n"Parasite",2019,"Sharp, funny,\nand tense"`, fallbackMovies);
assert.equal(quotedRows[0].review, "Sharp, funny,\nand tense");

const resolvedRows = await resolveMovieCsvRows(rows, async (query) => query === "Unknown" ? [{ ...fallbackMovies[0], id: 999, title: "Unknown", year: "2020" }] : []);
assert.equal(resolvedRows[1].status, "matched");
assert.equal(resolvedRows[1].matchedMovie?.id, 999);
assert.equal(canonicalMovieTitle("Matrix, The"), "the matrix");
assert.equal(canonicalMovieTitle("Amélie"), "amelie");
const importRow = { row: 1, title: "Matrix, The", year: "1999", status: "unmatched" };
const confident = resolveImportCandidates(importRow, [
  { ...fallbackMovies[0], id: 603, title: "The Matrix", year: "1999", popularity: 100 },
  { ...fallbackMovies[0], id: 604, title: "Matrix: Generation", year: "2023", popularity: 30 },
]);
assert.equal(confident.status, "matched", "canonical title and year auto-match confidently");
assert.equal(confident.matchedMovie?.id, 603);
const remake = resolveImportCandidates({ row: 2, title: "Suspiria", status: "unmatched" }, [
  { ...fallbackMovies[0], id: 1, title: "Suspiria", year: "1977", popularity: 30 },
  { ...fallbackMovies[0], id: 2, title: "Suspiria", year: "2018", popularity: 35 },
]);
assert.equal(remake.status, "unmatched", "same-title remakes without a year are skipped rather than guessed");
assert.equal(remake.candidates, undefined, "unmatched imports do not retain a manual review queue");
const nearbyRelease = resolveImportCandidates({ row: 3, title: "The Celebration", year: "1998", status: "unmatched" }, [
  { ...fallbackMovies[0], id: 3, title: "The Celebration", year: "1999", popularity: 25 },
  { ...fallbackMovies[0], id: 4, title: "Celebration Day", year: "2012", popularity: 60 },
]);
assert.equal(nearbyRelease.status, "matched", "a unique exact title tolerates a one-year release discrepancy");
const aliasMatch = resolveImportCandidates({ row: 4, title: "seven", year: "1995", status: "unmatched" }, [
  { ...fallbackMovies[0], id: 5, title: "Se7en", year: "1995", popularity: 90 },
  { ...fallbackMovies[0], id: 6, title: "Seven Days", year: "1998", popularity: 25 },
]);
assert.equal(aliasMatch.status, "matched", "curated stylized-title aliases auto-match with the exact year");
const weakMatch = resolveImportCandidates({ row: 5, title: "Completely Different", year: "2001", status: "unmatched" }, [
  { ...fallbackMovies[0], id: 7, title: "Another Movie", year: "2001", popularity: 100 },
]);
assert.equal(weakMatch.status, "unmatched", "weak title similarity is never accepted solely because the year matches");
const closeCandidates = resolveImportCandidates({ row: 6, title: "The Adventures", year: "2005", status: "unmatched" }, [
  { ...fallbackMovies[0], id: 8, title: "The Adventure", year: "2005", popularity: 50 },
  { ...fallbackMovies[0], id: 9, title: "The Adventurer", year: "2005", popularity: 49 },
]);
assert.equal(closeCandidates.status, "unmatched", "close fuzzy candidates are skipped rather than sent to manual review");
const letterboxdDuplicate = resolveImportCandidates({ row: 7, title: "The Movie", year: "2020", letterboxdUri: "https://boxd.it/example", sources: ["ratings.csv"], status: "unmatched" }, [
  { ...fallbackMovies[0], id: 10, title: "The Movie", year: "2020", popularity: 4 },
  { ...fallbackMovies[0], id: 11, title: "The Movie", year: "2020", popularity: 80 },
]);
assert.equal(letterboxdDuplicate.status, "matched", "Letterboxd duplicate title/year results resolve automatically");
assert.equal(letterboxdDuplicate.matchedMovie?.id, 11, "the strongest exact title/year candidate wins deterministically");
const originalTitleMatch = resolveImportCandidates({ row: 8, title: "La vita è bella", year: "1997", letterboxdUri: "https://boxd.it/example-2", sources: ["watched.csv"], status: "unmatched" }, [
  { ...fallbackMovies[0], id: 12, title: "Life Is Beautiful", originalTitle: "La vita è bella", year: "1997", popularity: 70 },
]);
assert.equal(originalTitleMatch.status, "matched", "Letterboxd titles match TMDB original-language titles automatically");
assert.equal(originalTitleMatch.matchedMovie?.id, 12);

const collaborativeModel = JSON.parse(readFileSync(new URL("../public/models/movielens-small-svd64-v1.json", import.meta.url), "utf8"));
assert.equal(collaborativeModel.dimensions, 64);
assert(Object.keys(collaborativeModel.items).length >= 4000);
const collaborativeItem = Object.values(collaborativeModel.items)[0];
assert.equal(collaborativeItem.factors.length, 64);
assert(collaborativeItem.neighbors.length > 0);

console.log("recommendation-first verification passed");
