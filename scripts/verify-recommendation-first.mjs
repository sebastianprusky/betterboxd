import assert from "node:assert/strict";
import { decayingPickWeight, getRatingSignal, isMovieExcluded } from "../src/services/recommendationPolicy.ts";
import { parseMovieCsv } from "../src/services/csvImport.ts";
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

console.log("recommendation-first verification passed");
