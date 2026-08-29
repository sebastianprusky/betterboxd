import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { File } from "node:buffer";
import { strToU8, zipSync } from "fflate";
import { mergeImportedRows, parseMovieImportFile } from "../src/services/movieImport.ts";
import { buildRatingCalibration } from "../src/services/ratingCalibration.ts";

const movie = (id, title, year, genres = ["Drama"], extra = {}) => ({ id, title, year: String(year), posterPath: `/p${id}.jpg`, overview: `${title} ${genres.join(" ")}`, genres, voteAverage: 7, voteCount: 1000, popularity: 40, ...extra });

const letterboxdCatalog = [movie(1, "Parasite", 2019), movie(2, "Alien", 1979), movie(3, "Past Lives", 2023)];
const archive = zipSync({
  "export/ratings.csv": strToU8("Date,Name,Year,Letterboxd URI,Rating\n2024-01-01,Parasite,2019,x,4.5\n2024-01-02,Alien,1979,x,4\n"),
  "export/watched.csv": strToU8("Date,Name,Year,Letterboxd URI\n2023-01-01,Parasite,2019,x\n2023-01-02,Past Lives,2023,x\n"),
  "export/reviews.csv": strToU8("Date,Name,Year,Letterboxd URI,Rating,Rewatch,Review\n2024-02-01,Parasite,2019,x,4,false,Excellent class satire\n"),
  "export/watchlist.csv": strToU8("Date,Name,Year,Letterboxd URI\n2024-03-01,Past Lives,2023,x\n"),
  "export/ignored.txt": strToU8("ignored"),
});
const parsed = await parseMovieImportFile(new File([archive], "letterboxd-export.zip"), letterboxdCatalog);
assert.equal(parsed.summary.kind, "letterboxd-zip");
assert.equal(parsed.rows.length, 3, "duplicate Letterboxd rows merge by title and year");
const parasite = parsed.rows.find((row) => row.title === "Parasite");
assert.equal(parasite.rating, 4.5, "ratings.csv wins over a review-file rating");
assert.equal(parasite.review, "Excellent class satire");
assert.equal(parasite.watched, true);
assert.equal(parsed.rows.find((row) => row.title === "Past Lives").saved, true);

const previousState = { ratings: { 1: 3, 99: 5 }, reviews: { 99: "Keep this" }, watched: {}, watchlist: { 99: movie(99, "App Movie", 2020) } };
const firstMerge = mergeImportedRows(parsed.rows, previousState, 123);
assert.equal(firstMerge.ratings[1], 4.5, "a changed imported rating updates the existing rating");
assert.equal(firstMerge.ratings[99], 5, "movies omitted from a later import remain untouched");
assert.equal(firstMerge.reviews[99], "Keep this", "existing reviews absent from the import remain untouched");
assert.ok(firstMerge.watchlist[99], "existing watchlist entries absent from the import remain untouched");

const ratedMovies = Array.from({ length: 9 }, (_, index) => movie(100 + index, `Rated ${index}`, 1990 + index, index % 2 ? ["Comedy"] : ["Drama"]));
const ratings = Object.fromEntries(ratedMovies.map((item, index) => [item.id, 2.5 + (index % 5) * .5]));
const watched = Object.fromEntries(ratedMovies.map((item) => [item.id, { movie: item, watchedAt: 1 }]));
const first = buildRatingCalibration(ratedMovies, ratings, watched);
assert.equal(first.points.length, 9);
assert.equal(first.benchmarkPassed, false, "weak synthetic predictions never bypass the accuracy benchmark");
assert.ok(first.userMeanBaselineError >= 0 && first.tmdbBaselineError >= 0);
assert.deepEqual(buildRatingCalibration(ratedMovies, ratings, watched), first, "calibration output is deterministic");
const target = first.points[0];
const changed = buildRatingCalibration(ratedMovies, { ...ratings, [target.movie.id]: 5 }, watched).points.find((point) => point.movie.id === target.movie.id);
assert.equal(changed.predictedRating, target.predictedRating, "a target rating is excluded from its own prediction");
assert.equal(changed.actualRating, 5);
assert.equal(buildRatingCalibration(ratedMovies, ratings, { ...watched, [ratedMovies[0].id]: undefined }).points.length, 8, "unwatched ratings are excluded");

const [appSource, styles, types, supabaseSource] = await Promise.all([
  readFile(new URL("src/App.tsx", `file://${process.cwd()}/`), "utf8"),
  readFile(new URL("src/styles.css", `file://${process.cwd()}/`), "utf8"),
  readFile(new URL("src/types.ts", `file://${process.cwd()}/`), "utf8"),
  readFile(new URL("src/services/supabase.ts", `file://${process.cwd()}/`), "utf8"),
]);
assert.match(styles, /\.movie-poster-image \{[^}]*object-fit: contain[^}]*background: transparent/);
assert.doesNotMatch(appSource, /ExpandedResultCard|expandedResults/);
assert.match(appSource, /LearningHistoryDialog/);
assert.match(appSource, /See more/);
assert.match(types, /LibraryFilter = "watched" \| "watchlist" \| "rated"/);
assert.deepEqual([...appSource.matchAll(/\[\["(watched|watchlist|rated)"/g)].map((match) => match[1]), ["watched"]);
assert.match(appSource, /\[\["watched", "Watched"\], \["watchlist", "Watchlist"\], \["rated", "Rated"\]\]/);
assert.match(styles, /\.detail-actions \{ display: grid; grid-template-columns: repeat\(3/);
assert.match(supabaseSource, /flowType: "pkce"/);
assert.match(supabaseSource, /cleanAuthCallbackUrl/);
assert.match(supabaseSource, /skipBrowserRedirect: true/);
assert.doesNotMatch(appSource, /Developer options/);
assert.match(appSource, /Update Letterboxd/);

console.log("Decision-helper UI, import, and rating calibration checks passed.");
