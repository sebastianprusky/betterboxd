const allMovieGenres = [
  { id: 28, name: "Action", label: "Action" },
  { id: 12, name: "Adventure", label: "Adventure" },
  { id: 16, name: "Animation", label: "Animation" },
  { id: 35, name: "Comedy", label: "Comedy" },
  { id: 80, name: "Crime", label: "Crime" },
  { id: 99, name: "Documentary", label: "Documentary" },
  { id: 18, name: "Drama", label: "Drama" },
  { id: 10751, name: "Family", label: "Family" },
  { id: 14, name: "Fantasy", label: "Fantasy" },
  { id: 36, name: "History", label: "History" },
  { id: 27, name: "Horror", label: "Horror" },
  { id: 10402, name: "Music", label: "Music" },
  { id: 9648, name: "Mystery", label: "Mystery" },
  { id: 10749, name: "Romance", label: "Romance" },
  { id: 878, name: "Sci-Fi", label: "Sci-Fi" },
  { id: 10770, name: "TV Movie", label: "TV Movie" },
  { id: 53, name: "Thriller", label: "Thriller" },
  { id: 10752, name: "War", label: "War" },
  { id: 37, name: "Western", label: "Western" },
] as const;

export const movieGenres = allMovieGenres.filter((genre) => genre.name !== "TV Movie");

export const genreOptions: ReadonlyArray<readonly [string, string]> = movieGenres.map((genre) => [genre.name, genre.label] as const);
// Keep the complete TMDB mapping so existing cached movies remain readable even
// when a provider classifies them as TV movies. TV Movie is intentionally not a
// user-facing filter or preference.
export const genreIds: Record<number, string> = Object.fromEntries(allMovieGenres.map((genre) => [genre.id, genre.name]));

export function normalizeMovieGenre(name: string) {
  return name.trim().toLowerCase() === "science fiction" ? "Sci-Fi" : name.trim();
}
