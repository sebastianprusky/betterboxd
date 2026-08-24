import { genreIds, genreOptions, movieGenres, normalizeMovieGenre } from "../src/data/movieGenres.ts";
import { genreAliases } from "../src/services/promptIntent.ts";

const expected = ["Action", "Adventure", "Animation", "Comedy", "Crime", "Documentary", "Drama", "Family", "Fantasy", "History", "Horror", "Music", "Mystery", "Romance", "Sci-Fi", "TV Movie", "Thriller", "War", "Western"];
const optionNames = genreOptions.map(([name]) => name);
const mappedNames = movieGenres.map((genre) => genreIds[genre.id]);

if (JSON.stringify(optionNames) !== JSON.stringify(expected)) throw new Error("Genre selector is incomplete or out of order");
if (JSON.stringify(mappedNames) !== JSON.stringify(expected)) throw new Error("TMDB genre map differs from the selector");
if (genreAliases.documentary !== "Documentary" || genreAliases.family !== "Family" || genreAliases.western !== "Western") throw new Error("Prompt genre aliases are incomplete");
if (normalizeMovieGenre("Science Fiction") !== "Sci-Fi") throw new Error("TMDB science-fiction naming is not normalized");

console.log("genre catalog verification passed");
