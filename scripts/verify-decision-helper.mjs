import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { File } from "node:buffer";
import { strToU8, zipSync } from "fflate";
import { mergeImportedRows, parseMovieImportFile } from "../src/services/movieImport.ts";
import { buildRatingCalibration, ratingToPercent } from "../src/services/ratingCalibration.ts";
import { arrangeWatchlistCandidates } from "../src/services/recommendations.ts";
import { filterAndSortLibraryMovies } from "../src/services/library.ts";
import { removeWatchedOutcome } from "../src/services/unwatch.ts";
import { buildTasteProfileSample, REAL_TIME_TASTE_MOVIE_LIMIT } from "../src/services/tasteProfileSample.ts";

const movie = (id, title, year, genres = ["Drama"], extra = {}) => ({ id, title, year: String(year), posterPath: `/p${id}.jpg`, overview: `${title} ${genres.join(" ")}`, genres, voteAverage: 7, voteCount: 1000, popularity: 40, ...extra });

const letterboxdCatalog = [movie(1, "Parasite", 2019), movie(2, "Alien", 1979), movie(3, "Past Lives", 2023)];
const archive = zipSync({
  "export/ratings.csv": strToU8("Date,Name,Year,Letterboxd URI,Rating\n2024-01-01,Parasite,2019,x,4.5\n2024-01-02,Alien,1979,x,4\n"),
  "export/watched.csv": strToU8("Date,Name,Year,Letterboxd URI\n2023-01-01,Parasite,2019,x\n2023-01-02,Past Lives,2023,x\n"),
  "export/reviews.csv": strToU8("Date,Name,Year,Letterboxd URI,Rating,Rewatch,Review\n2024-02-01,Parasite,2019,x,4,false,Excellent class satire\n"),
  "export/watchlist.csv": strToU8("Date,Name,Year,Letterboxd URI\n2024-03-01,Past Lives,2023,x\n"),
  "export/likes/films.csv": strToU8("Date,Name,Year,Letterboxd URI\n2024-03-02,Alien,1979,x\n"),
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
assert.equal(parsed.rows.find((row) => row.title === "Alien").liked, true);
assert.equal(parsed.summary.likeCount, 1);

const previousState = { ratings: { 1: 3, 99: 5 }, likes: { 99: movie(99, "App Movie", 2020) }, reviews: { 99: "Keep this" }, watched: {}, watchlist: { 99: movie(99, "App Movie", 2020) } };
const firstMerge = mergeImportedRows(parsed.rows, previousState, 123);
assert.equal(firstMerge.ratings[1], 4.5, "a changed imported rating updates the existing rating");
assert.equal(firstMerge.ratings[99], 5, "movies omitted from a later import remain untouched");
assert.equal(firstMerge.reviews[99], "Keep this", "existing reviews absent from the import remain untouched");
assert.ok(firstMerge.watchlist[99], "existing watchlist entries absent from the import remain untouched");
assert.equal(firstMerge.watchlist[3], undefined, "a movie imported as watched is removed from the watchlist");
assert.ok(firstMerge.likes[2], "liked films import into the distinct Likes map");
assert.ok(firstMerge.likes[99], "re-import omissions never remove existing local Likes");
assert.ok(firstMerge.touched.includes("like:*"), "Like imports use a compact bulk field-update marker");

const largeHistory = Array.from({ length: 5_000 }, (_, index) => movie(10_000 + index, `History ${index}`, 1950 + index % 75));
const largeRatings = Object.fromEntries(largeHistory.map((item, index) => [item.id, .5 + index % 10 * .5]));
const largeWatched = Object.fromEntries(largeHistory.map((item, index) => [item.id, { movie: item, watchedAt: index }]));
const tasteSample = buildTasteProfileSample({ ratings: largeRatings, likes: {}, watchlist: {}, watched: largeWatched, interest: {}, preferences: { genres: [], directors: [], actors: [], favoriteMovies: {} } });
assert.equal(tasteSample.length, REAL_TIME_TASTE_MOVIE_LIMIT, "real-time taste work stays bounded for profiles with thousands of movies");
assert.equal(new Set(tasteSample.map((item) => largeRatings[item.id])).size, 10, "the bounded sample preserves the user's full rating range");
const largeRows = largeHistory.map((item, index) => ({ row: index + 2, title: item.title, year: item.year, rating: largeRatings[item.id], watched: true, matchedMovie: item, status: "matched" }));
const largeMerge = mergeImportedRows(largeRows, { ratings: {}, likes: {}, reviews: {}, watched: {}, watchlist: {} }, 123);
assert.equal(Object.keys(largeMerge.watched).length, 5_000);
assert.ok(largeMerge.touched.length < 10, "large imports do not create thousands of field-update metadata entries");

const ratedMovies = Array.from({ length: 9 }, (_, index) => movie(100 + index, `Rated ${index}`, 1990 + index, index % 2 ? ["Comedy"] : ["Drama"]));
const ratings = Object.fromEntries(ratedMovies.map((item, index) => [item.id, 2.5 + (index % 5) * .5]));
const watched = Object.fromEntries(ratedMovies.map((item) => [item.id, { movie: item, watchedAt: 1 }]));
const first = buildRatingCalibration(ratedMovies, ratings, watched);
assert.equal(first.points.length, 9);
assert.equal(first.status, "low-confidence");
assert.equal(typeof first.predictionScore, "number", "a sufficiently large profile receives an honest score even when the model is weak");
assert.equal(first.benchmarkPassed, false, "weak synthetic predictions never bypass the accuracy benchmark");
assert.ok(first.userMeanBaselineError >= 0 && first.tmdbBaselineError >= 0);
assert.deepEqual(buildRatingCalibration(ratedMovies, ratings, watched), first, "calibration output is deterministic");
const target = first.points[0];
const changed = buildRatingCalibration(ratedMovies, { ...ratings, [target.movie.id]: 5 }, watched).points.find((point) => point.movie.id === target.movie.id);
assert.equal(changed.predictedRating, target.predictedRating, "a target rating is excluded from its own prediction");
assert.equal(changed.actualRating, 5);
assert.equal(buildRatingCalibration(ratedMovies, ratings, { ...watched, [ratedMovies[0].id]: undefined }).points.length, 8, "unwatched ratings are excluded");
assert.equal(ratingToPercent(.5), 0);
assert.equal(ratingToPercent(1), 100 / 9);
assert.equal(ratingToPercent(3), 500 / 9);
assert.equal(ratingToPercent(5), 100);

const ranked = [movie(201, "First", 2020), movie(202, "Second", 2021), movie(203, "Saved", 2022), movie(204, "Fourth", 2023)].map((item) => ({ movie: item }));
const savedMap = { 203: ranked[2].movie };
assert.deepEqual(arrangeWatchlistCandidates(ranked, savedMap, true).map((item) => item.movie.id), [201, 202, 203, 204], "one saved movie is inserted after two discovery choices");
assert.deepEqual(arrangeWatchlistCandidates(ranked, savedMap, false).map((item) => item.movie.id), [201, 202, 204], "watchlist titles are completely excluded when the switch is off");

const libraryMovies = [movie(401, "Zulu", 1990), movie(402, "Alpha", 2020), movie(403, "Middle", 2010)];
const libraryWatched = {
  401: { movie: libraryMovies[0], watchedAt: 30 },
  402: { movie: libraryMovies[1], watchedAt: 20 },
  403: { movie: libraryMovies[2], watchedAt: 10 },
};
const libraryBase = { movies: libraryMovies, filter: "watched", watchedFilter: "all", query: "", ratings: { 401: 2, 402: 5 }, likes: { 403: libraryMovies[2] }, watched: libraryWatched, watchlist: {} };
assert.deepEqual(filterAndSortLibraryMovies({ ...libraryBase, sort: "recent" }).map((item) => item.id), [401, 402, 403]);
assert.deepEqual(filterAndSortLibraryMovies({ ...libraryBase, sort: "rating-high" }).map((item) => item.id), [402, 401, 403], "unrated movies sort after rated movies");
assert.deepEqual(filterAndSortLibraryMovies({ ...libraryBase, sort: "rating-low" }).map((item) => item.id), [401, 402, 403]);
assert.deepEqual(filterAndSortLibraryMovies({ ...libraryBase, sort: "title" }).map((item) => item.id), [402, 403, 401]);
assert.deepEqual(filterAndSortLibraryMovies({ ...libraryBase, sort: "year-newest" }).map((item) => item.id), [402, 403, 401]);
assert.deepEqual(filterAndSortLibraryMovies({ ...libraryBase, sort: "recent", watchedFilter: "liked" }).map((item) => item.id), [403]);
assert.deepEqual(filterAndSortLibraryMovies({ ...libraryBase, sort: "recent", query: "alp" }).map((item) => item.id), [402]);
assert.deepEqual(filterAndSortLibraryMovies({ ...libraryBase, filter: "watchlist", sort: "recent", watchlist: { 401: libraryMovies[0], 402: libraryMovies[1] } }).map((item) => item.id), [], "watched movies never render in the watchlist tab even during reconciliation");

const outcomeMovie = movie(301, "Outcome", 2024);
const unwatched = removeWatchedOutcome({
  watched: { 301: { movie: outcomeMovie, watchedAt: 10 } },
  ratings: { 301: 4.5 },
  reviews: { 301: "Great" },
  reviewInsights: { 301: [{ id: "aspect", label: "Practical effects", sentiment: "positive" }] },
  learningEvents: [
    { id: "watched", type: "watched", movie: outcomeMovie, label: "Marked watched", createdAt: 1 },
    { id: "interest", type: "interest", movie: outcomeMovie, label: "Interested", createdAt: 2 },
  ],
  recommendationEvents: [
    { id: "watched-event", type: "watched", movieId: 301, movieTitle: "Outcome", mode: "personal", score: 1, createdAt: 1 },
    { id: "pick-event", type: "pick", movieId: 301, movieTitle: "Outcome", mode: "personal", score: 1, createdAt: 2 },
  ],
  pickIntents: [{ id: "pick", movie: outcomeMovie, createdAt: 1, watchedAt: 10, rating: 4.5 }],
}, 301);
assert.deepEqual(unwatched.watched, {});
assert.deepEqual(unwatched.ratings, {});
assert.deepEqual(unwatched.reviews, {});
assert.deepEqual(unwatched.reviewInsights, {});
assert.deepEqual(unwatched.learningEvents.map((event) => event.type), ["interest"], "independent reactions survive Unwatch");
assert.deepEqual(unwatched.recommendationEvents.map((event) => event.type), ["pick"], "the original pick survives Unwatch");
assert.equal(unwatched.pickIntents[0].watchedAt, undefined);
assert.equal(unwatched.pickIntents[0].rating, undefined);

const [appSource, accountHubSource, styles, types, supabaseSource] = await Promise.all([
  readFile(new URL("src/App.tsx", `file://${process.cwd()}/`), "utf8"),
  readFile(new URL("src/components/AccountHub.tsx", `file://${process.cwd()}/`), "utf8"),
  readFile(new URL("src/styles.css", `file://${process.cwd()}/`), "utf8"),
  readFile(new URL("src/types.ts", `file://${process.cwd()}/`), "utf8"),
  readFile(new URL("src/services/supabase.ts", `file://${process.cwd()}/`), "utf8"),
]);
assert.match(styles, /\.movie-poster-image \{[^}]*object-fit: contain[^}]*background: transparent/);
assert.doesNotMatch(appSource, /ExpandedResultCard|expandedResults/);
assert.match(appSource, /LearningHistoryDialog/);
assert.match(appSource, /See more/);
assert.match(types, /LibraryFilter = "watched" \| "watchlist"/);
assert.doesNotMatch(types, /LibraryFilter = [^\n]*rated/);
assert.match(appSource, /\[\["watched", "Watched"\], \["watchlist", "Watchlist"\]\]/);
assert.match(styles, /\.detail-actions \{ display: grid; grid-template-columns: repeat\(3/);
assert.match(supabaseSource, /flowType: "pkce"/);
assert.match(supabaseSource, /cleanAuthCallbackUrl/);
assert.match(supabaseSource, /skipBrowserRedirect: true/);
assert.doesNotMatch(appSource, /Developer options/);
assert.match(appSource, /Update Letterboxd/);
assert.match(appSource, /Prediction Score/);
assert.match(appSource, /new Worker\(new URL\("\.\/workers\/ratingModelWorker\.ts"/, "prediction calibration runs outside the main UI thread");
assert.match(appSource, /Testing hidden ratings…/, "large prediction updates expose a responsive progress state");
assert.match(appSource, /!detailMovie \|\| watched\[detailMovie\.id\]/, "watched movie popups suppress predictions in favor of actual ratings");
assert.match(appSource, /!props\.watched && props\.prediction[^\n]*Predicted for you[^\n]*StarRating[^\n]*readOnly/, "unwatched movie popups render predicted star ratings");
assert.doesNotMatch(appSource, /Usually within/);
assert.doesNotMatch(appSource, /pick-taste-strength/);
assert.doesNotMatch(appSource, />Unwatch</);
assert.doesNotMatch(appSource, /Include my watchlist/);
assert.match(accountHubSource, /Watchlist recommendations/);
assert.match(accountHubSource, /Allow up to one saved movie in each set of three\./);
assert.match(appSource, /Remove watched status/);
assert.match(appSource, /All watched/);
assert.match(appSource, /Rating: high to low/);
assert.match(appSource, /LikedMap/);
assert.match(styles, /\.calibration-x-ticks span \{[^}]*position: absolute/);
assert.match(styles, /\.movie-detail-sheet \{[^}]*width: min\(1180px/);
assert.match(styles, /\.sprint-stage \{[^}]*minmax\(220px, 300px\)/);

console.log("Decision-helper UI, import, and rating calibration checks passed.");
