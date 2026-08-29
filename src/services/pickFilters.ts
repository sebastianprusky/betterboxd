import { normalizeMovieGenre } from "../data/movieGenres";
import type { Movie, PickFilters } from "../types";

export function matchesPickFilters(movie: Movie, filters: PickFilters) {
  if (filters.genres.length && !movie.genres.some((genre) => filters.genres.some((selected) => normalizeMovieGenre(selected).toLowerCase() === normalizeMovieGenre(genre).toLowerCase()))) return false;
  const runtimeConstrained = filters.runtimeMin > 30 || filters.runtimeMax < 300;
  if (runtimeConstrained && (!movie.runtime || movie.runtime < filters.runtimeMin || movie.runtime > filters.runtimeMax)) return false;
  const year = Number(movie.year);
  if (filters.eras.length) {
    const inSelectedEra = filters.eras.some((era) =>
      (era === "recent" && year >= 2020) ||
      (era === "2010s" && year >= 2010 && year <= 2019) ||
      (era === "2000s" && year >= 2000 && year <= 2009) ||
      (era === "1990s" && year >= 1990 && year <= 1999) ||
      (era === "1980s" && year >= 1980 && year <= 1989) ||
      (era === "1970s" && year >= 1970 && year <= 1979) ||
      (era === "1960s" && year >= 1960 && year <= 1969) ||
      (era === "pre1960" && year < 1960)
    );
    if (!inSelectedEra) return false;
  }
  return true;
}
