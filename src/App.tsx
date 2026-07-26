import { useEffect, useMemo, useState } from "react";
import { fallbackMovies } from "./data/fallbackMovies";
import { getMovieDetails, getTrendingMovies, hasTmdbKey, posterUrl, searchMovies } from "./services/tmdb";
import type { Movie, ProfileSort, RatingMap, ReviewMap, Tab, Theme, WatchedMap, WatchlistMap } from "./types";

const ratingsKey = "betterboxd-ratings";
const watchlistKey = "betterboxd-watchlist";
const reviewsKey = "betterboxd-reviews";
const themeKey = "betterboxd-theme";
const watchedKey = "betterboxd-watched";

const initialRatings: RatingMap = {
  "496243": 4.5,
  "244786": 5,
  "38": 4,
};

function readJson<T>(key: string, fallback: T, legacyKey?: string): T {
  const value = localStorage.getItem(key) || (legacyKey ? localStorage.getItem(legacyKey) : null);
  return value ? JSON.parse(value) : fallback;
}

function getTopGenre(ratings: RatingMap, movies: Movie[]) {
  const weights = new Map<string, number>();
  movies.forEach((movie) => {
    const rating = ratings[movie.id];
    if (!rating) return;
    movie.genres.forEach((genre) => weights.set(genre, (weights.get(genre) || 0) + rating));
  });
  return [...weights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "Taste forming";
}

function recommendMovies(ratings: RatingMap, movies: Movie[]) {
  const weights = new Map<string, number>();
  movies.forEach((movie) => {
    const rating = ratings[movie.id];
    if (!rating) return;
    movie.genres.forEach((genre) => weights.set(genre, (weights.get(genre) || 0) + rating));
  });

  return movies
    .filter((movie) => !ratings[movie.id])
    .map((movie) => ({
      movie,
      score: movie.genres.reduce((total, genre) => total + (weights.get(genre) || 0), 0) + (movie.voteAverage || 0) / 10,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(({ movie }) => movie);
}

function App() {
  const [tab, setTab] = useState<Tab>("discover");
  const [theme, setTheme] = useState<Theme>(() => readJson(themeKey, "light", "cinecircle-theme"));
  const [ratings, setRatings] = useState<RatingMap>(() => readJson(ratingsKey, initialRatings, "cinecircle-ratings"));
  const [watchlist, setWatchlist] = useState<WatchlistMap>(() => readJson(watchlistKey, {}, "cinecircle-watchlist"));
  const [watched, setWatched] = useState<WatchedMap>(() => readJson(watchedKey, {}));
  const [reviews, setReviews] = useState<ReviewMap>(() => readJson(reviewsKey, {}));
  const [profileSort, setProfileSort] = useState<ProfileSort>("recentlyWatched");
  const [movies, setMovies] = useState<Movie[]>(fallbackMovies);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Movie[]>([]);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [selectedMovie, setSelectedMovie] = useState<Movie | null>(null);
  const [quickQuery, setQuickQuery] = useState("");
  const [quickResults, setQuickResults] = useState<Movie[]>(fallbackMovies.slice(0, 5));
  const [sprintIndex, setSprintIndex] = useState(0);
  const [detailMovie, setDetailMovie] = useState<Movie | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(themeKey, JSON.stringify(theme));
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(ratingsKey, JSON.stringify(ratings));
  }, [ratings]);

  useEffect(() => {
    localStorage.setItem(watchlistKey, JSON.stringify(watchlist));
  }, [watchlist]);

  useEffect(() => {
    localStorage.setItem(watchedKey, JSON.stringify(watched));
  }, [watched]);

  useEffect(() => {
    localStorage.setItem(reviewsKey, JSON.stringify(reviews));
  }, [reviews]);

  useEffect(() => {
    getTrendingMovies().then(setMovies).catch(() => setMovies(fallbackMovies));
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      searchMovies(searchQuery).then(setSearchResults).catch(() => setSearchResults([]));
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [searchQuery]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      searchMovies(quickQuery).then((results) => setQuickResults(results.length ? results : fallbackMovies.slice(0, 5)));
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [quickQuery]);

  const allKnownMovies = useMemo(() => {
    const map = new Map<number, Movie>();
    [
      ...fallbackMovies,
      ...movies,
      ...searchResults,
      ...quickResults,
      ...Object.values(watchlist),
      ...Object.values(watched).map((entry) => entry.movie),
      ...(detailMovie ? [detailMovie] : []),
    ].forEach((movie) => map.set(movie.id, movie));
    return [...map.values()];
  }, [movies, searchResults, quickResults, watchlist, watched, detailMovie]);

  const recommendations = useMemo(() => recommendMovies(ratings, allKnownMovies), [ratings, allKnownMovies]);
  const topGenre = useMemo(() => getTopGenre(ratings, allKnownMovies), [ratings, allKnownMovies]);
  const sprintQueue = recommendations.length ? recommendations : movies.filter((movie) => !ratings[movie.id]);
  const sprintMovie = sprintQueue[sprintIndex % Math.max(sprintQueue.length, 1)];
  const profileMovies = useMemo(() => {
    const map = new Map<number, Movie>();
    Object.values(watched).forEach((entry) => map.set(entry.movie.id, entry.movie));
    allKnownMovies.filter((movie) => ratings[movie.id]).forEach((movie) => map.set(movie.id, movie));

    return [...map.values()].sort((a, b) => {
      if (profileSort === "highestRated") return (ratings[b.id] || -1) - (ratings[a.id] || -1);
      if (profileSort === "lowestRated") return (ratings[a.id] || 6) - (ratings[b.id] || 6);
      if (profileSort === "recentlyReleased") return Number(b.year || 0) - Number(a.year || 0);
      return (watched[b.id]?.watchedAt || 0) - (watched[a.id]?.watchedAt || 0);
    });
  }, [allKnownMovies, profileSort, ratings, watched]);

  function rateMovie(movie: Movie, rating: number) {
    setRatings((current) => ({ ...current, [movie.id]: rating }));
    markWatched(movie);
  }

  function markWatched(movie: Movie) {
    setWatched((current) => ({
      ...current,
      [movie.id]: { movie, watchedAt: Date.now() },
    }));
    setWatchlist((current) => {
      const next = { ...current };
      delete next[movie.id];
      return next;
    });
  }

  function removeRating(movie: Movie) {
    setRatings((current) => {
      const next = { ...current };
      delete next[movie.id];
      return next;
    });
    setReviews((current) => {
      const next = { ...current };
      delete next[movie.id];
      return next;
    });
  }

  function removeWatched(movie: Movie) {
    removeRating(movie);
    setWatched((current) => {
      const next = { ...current };
      delete next[movie.id];
      return next;
    });
  }

  function toggleWatchlist(movie: Movie) {
    setWatchlist((current) => {
      const next = { ...current };
      if (next[movie.id]) delete next[movie.id];
      else next[movie.id] = movie;
      return next;
    });
  }

  function removeFromWatchlist(movie: Movie) {
    setWatchlist((current) => {
      const next = { ...current };
      delete next[movie.id];
      return next;
    });
  }

  function updateReview(movie: Movie, review: string) {
    setReviews((current) => {
      const next = { ...current };
      if (review.trim()) next[movie.id] = review;
      else delete next[movie.id];
      return next;
    });
  }

  async function openMovie(movie: Movie) {
    setDetailMovie(movie);
    setDetailLoading(true);
    try {
      setDetailMovie(await getMovieDetails(movie));
    } catch {
      setDetailMovie(movie);
    } finally {
      setDetailLoading(false);
    }
  }

  function nextSprint() {
    setSprintIndex((index) => index + 1);
  }

  function navButton(value: Tab, label: string) {
    return (
      <button className={tab === value ? "is-active" : ""} onClick={() => setTab(value)}>
        <span>{label}</span>
      </button>
    );
  }

  function sortButton(value: ProfileSort, label: string) {
    return (
      <button className={profileSort === value ? "is-active" : ""} onClick={() => setProfileSort(value)}>
        {label}
      </button>
    );
  }

  return (
    <div className="app">
      <main className="main">
        <header className="topbar">
          <nav className="top-nav" aria-label="Primary navigation">
            {navButton("discover", "Discover")}
            {navButton("search", "Search")}
            {navButton("profile", "Profile")}
          </nav>
          <div className="topbar-actions">
            <button className="theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
              {theme === "light" ? "Dark" : "Light"}
            </button>
          </div>
        </header>

        {tab === "discover" && (
          <section className="screen">
            <div className="discover-focus">
              <section className="sprint focus-sprint">
                <div className="section-title">
                  <div>
                    <p className="kicker">Taste Sprint</p>
                    <h2>Rate movies fast.</h2>
                  </div>
                </div>
                {sprintMovie && (
                  <div className="sprint-layout">
                    <Poster movie={sprintMovie} large onOpen={openMovie} />
                    <div className="sprint-copy">
                      <div>
                        <button className="title-button" onClick={() => openMovie(sprintMovie)}>
                          <h3>{sprintMovie.title}</h3>
                        </button>
                        <p>{sprintMovie.year} · {sprintMovie.genres.slice(0, 2).join(", ") || "Movie"}</p>
                      </div>
                      <div className="genre-row">
                        {sprintMovie.genres.slice(0, 3).map((genre) => (
                          <span key={genre}>{genre}</span>
                        ))}
                      </div>
                      <RatingPicker value={ratings[sprintMovie.id]} onChange={(rating) => rateMovie(sprintMovie, rating)} />
                      <div className="action-grid">
                        <button className="skip-button" onClick={nextSprint} aria-label="Skip movie">
                          <span aria-hidden="true">&gt;</span>
                        </button>
                        <button className="watchlist-button" onClick={() => toggleWatchlist(sprintMovie)}>
                          {watchlist[sprintMovie.id] ? "Saved" : "+ Watchlist"}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </section>

              <MovieSection
                title="Recommended for you"
                subtitle={`Because your taste leans ${topGenre.toLowerCase()}`}
                movies={recommendations}
                ratings={ratings}
                watchlist={watchlist}
                onRate={rateMovie}
                onWatchlist={toggleWatchlist}
                onOpen={openMovie}
              />
            </div>
          </section>
        )}

        {tab === "search" && (
          <section className="screen">
            <label className="field">
              <span>Find movies</span>
              <input
                autoFocus
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search by title"
              />
            </label>
            {!hasTmdbKey() && (
              <p className="notice">Using demo poster data. Add VITE_TMDB_API_KEY to search TMDB.</p>
            )}
            <MovieGrid
              movies={searchQuery ? searchResults : movies}
              ratings={ratings}
              watchlist={watchlist}
              onRate={rateMovie}
              onWatchlist={toggleWatchlist}
              onOpen={openMovie}
            />
          </section>
        )}

        {tab === "profile" && (
          <section className="screen">
            <section className="movie-section profile-list">
              <div className="section-title profile-title">
                <div>
                  <p className="kicker">Profile</p>
                  <h2>All watched</h2>
                  <div className="sort-tabs" aria-label="Sort watched movies">
                    {sortButton("recentlyWatched", "Recent")}
                    {sortButton("highestRated", "Highest")}
                    {sortButton("lowestRated", "Lowest")}
                    {sortButton("recentlyReleased", "Newest")}
                  </div>
                </div>
              </div>
              <MovieGrid
                movies={profileMovies}
                ratings={ratings}
                watchlist={watchlist}
                watched={watched}
                onRate={rateMovie}
                onWatchlist={toggleWatchlist}
                onOpen={openMovie}
              />
              {!profileMovies.length && <p className="empty">Mark a movie watched to start your profile.</p>}
            </section>
          </section>
        )}
      </main>

      <nav className="bottom-nav">
        {navButton("discover", "Discover")}
        {navButton("search", "Search")}
        {navButton("profile", "Profile")}
      </nav>

      <button className="floating-add" onClick={() => setQuickAddOpen(true)}>
        +
      </button>

      {quickAddOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setQuickAddOpen(false)}>
          <section className="modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <div>
                <p className="kicker">Quick add</p>
                <h2>What did you watch?</h2>
              </div>
              <button onClick={() => setQuickAddOpen(false)}>Close</button>
            </div>
            <input value={quickQuery} onChange={(event) => setQuickQuery(event.target.value)} placeholder="Search movie" />
            <div className="quick-results">
              {quickResults.slice(0, 5).map((movie) => (
                <button
                  key={movie.id}
                  className={selectedMovie?.id === movie.id ? "quick-result selected" : "quick-result"}
                  onClick={() => setSelectedMovie(movie)}
                >
                  <Poster movie={movie} />
                  <span>
                    <strong>{movie.title}</strong>
                    <small>{movie.year}</small>
                  </span>
                </button>
              ))}
            </div>
            {selectedMovie && (
              <div className="quick-add-actions">
                <button
                  onClick={() => {
                    markWatched(selectedMovie);
                    setQuickAddOpen(false);
                    setQuickQuery("");
                    setSelectedMovie(null);
                  }}
                >
                  Mark watched
                </button>
                <RatingPicker
                  value={ratings[selectedMovie.id]}
                  onChange={(rating) => {
                    rateMovie(selectedMovie, rating);
                    setQuickAddOpen(false);
                    setQuickQuery("");
                    setSelectedMovie(null);
                  }}
                />
              </div>
            )}
          </section>
        </div>
      )}

      {detailMovie && (
        <MovieDetailModal
          movie={detailMovie}
          loading={detailLoading}
          rating={ratings[detailMovie.id]}
          review={reviews[detailMovie.id] || ""}
          inWatchlist={Boolean(watchlist[detailMovie.id])}
          isWatched={Boolean(watched[detailMovie.id])}
          onClose={() => setDetailMovie(null)}
          onRate={(rating) => rateMovie(detailMovie, rating)}
          onRemoveRating={() => removeRating(detailMovie)}
          onMarkWatched={() => markWatched(detailMovie)}
          onRemoveWatched={() => removeWatched(detailMovie)}
          onReview={(review) => updateReview(detailMovie, review)}
          onToggleWatchlist={() => toggleWatchlist(detailMovie)}
          onRemoveWatchlist={() => removeFromWatchlist(detailMovie)}
        />
      )}
    </div>
  );
}

function MovieSection(props: {
  title: string;
  subtitle: string;
  movies: Movie[];
  ratings: RatingMap;
  watchlist: WatchlistMap;
  watched?: WatchedMap;
  empty?: string;
  onRate: (movie: Movie, rating: number) => void;
  onWatchlist: (movie: Movie) => void;
  onOpen: (movie: Movie) => void;
  onMarkWatched?: (movie: Movie) => void;
}) {
  return (
    <section className="movie-section">
      <div className="section-title">
        <div>
          <p className="kicker">{props.subtitle}</p>
          <h2>{props.title}</h2>
        </div>
      </div>
      {props.movies.length ? (
        <MovieGrid {...props} />
      ) : (
        <p className="empty">{props.empty || "No movies yet."}</p>
      )}
    </section>
  );
}

function MovieGrid(props: {
  movies: Movie[];
  ratings: RatingMap;
  watchlist: WatchlistMap;
  watched?: WatchedMap;
  onRate: (movie: Movie, rating: number) => void;
  onWatchlist: (movie: Movie) => void;
  onOpen: (movie: Movie) => void;
  onMarkWatched?: (movie: Movie) => void;
}) {
  return (
    <div className="movie-grid">
      {props.movies.map((movie) => (
        <article className="movie-card" key={movie.id}>
          <Poster movie={movie} onOpen={props.onOpen} />
          <div className="movie-info">
            <button className="movie-title-button" onClick={() => props.onOpen(movie)}>
              <strong>{movie.title}</strong>
            </button>
            <span>{movie.year}</span>
          </div>
          <div className="card-actions">
            <button onClick={() => props.onWatchlist(movie)}>{props.watchlist[movie.id] ? "Saved" : "Add to list"}</button>
            {props.onMarkWatched && (
              <button onClick={() => props.onMarkWatched?.(movie)}>{props.watched?.[movie.id] ? "Watched" : "Mark watched"}</button>
            )}
          </div>
          <RatingPicker compact value={props.ratings[movie.id]} onChange={(rating) => props.onRate(movie, rating)} />
        </article>
      ))}
    </div>
  );
}

function Poster({ movie, large = false, onOpen }: { movie: Movie; large?: boolean; onOpen?: (movie: Movie) => void }) {
  const url = posterUrl(movie.posterPath, large ? "w780" : "w342");
  const content = (
    <>
      {url ? <img src={url} alt={`${movie.title} poster`} /> : <span>{movie.title}</span>}
    </>
  );

  return onOpen ? (
    <button className={large ? "poster large" : "poster"} onClick={() => onOpen(movie)} aria-label={`Open ${movie.title}`}>
      {content}
    </button>
  ) : (
    <div className={large ? "poster large" : "poster"}>{content}</div>
  );
}

function RatingPicker({
  value,
  onChange,
  compact = false,
}: {
  value?: number;
  onChange: (rating: number) => void;
  compact?: boolean;
}) {
  const stars = [1, 2, 3, 4, 5];

  function chooseRating(star: number) {
    onChange(value === star ? star - 0.5 : star);
  }

  function starState(star: number) {
    if (!value) return "empty";
    if (value >= star) return "full";
    if (value === star - 0.5) return "half";
    return "empty";
  }

  return (
    <div className={compact ? "rating compact-rating" : "rating"} aria-label="Choose rating">
      {stars.map((star) => (
        <button
          key={star}
          className={starState(star)}
          onClick={() => chooseRating(star)}
          aria-label={`${star} stars`}
        >
          ★
        </button>
      ))}
    </div>
  );
}

function MovieDetailModal({
  movie,
  loading,
  rating,
  review,
  inWatchlist,
  isWatched,
  onClose,
  onRate,
  onRemoveRating,
  onMarkWatched,
  onRemoveWatched,
  onReview,
  onToggleWatchlist,
  onRemoveWatchlist,
}: {
  movie: Movie;
  loading: boolean;
  rating?: number;
  review: string;
  inWatchlist: boolean;
  isWatched: boolean;
  onClose: () => void;
  onRate: (rating: number) => void;
  onRemoveRating: () => void;
  onMarkWatched: () => void;
  onRemoveWatched: () => void;
  onReview: (review: string) => void;
  onToggleWatchlist: () => void;
  onRemoveWatchlist: () => void;
}) {
  const runtime = movie.runtime ? `${movie.runtime} min` : "Runtime unavailable";

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="movie-detail" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="detail-head">
          <div>
            <p className="kicker">{loading ? "Loading details" : "Movie details"}</p>
            <h2>{movie.title}</h2>
          </div>
          <button onClick={onClose}>Close</button>
        </div>

        <div className="detail-layout">
          <Poster movie={movie} large />
          <div className="detail-body">
            <div className="detail-meta">
              <span>{movie.year}</span>
              <span>{runtime}</span>
              <span>{movie.genres.slice(0, 3).join(", ") || "Genres unavailable"}</span>
            </div>
            <p>{movie.overview}</p>
            <div className="detail-facts">
              <div>
                <span>Director</span>
                <strong>{movie.director || "Unavailable"}</strong>
              </div>
              <div>
                <span>Cast</span>
                <strong>{movie.cast?.join(", ") || "Unavailable"}</strong>
              </div>
            </div>

            <section className="detail-section">
              <div className="detail-section-head">
                <div>
                  <p className="kicker">Your rating</p>
                  <strong>{rating ? "Rated" : isWatched ? "Watched" : "Not watched"}</strong>
                </div>
                {rating && <button onClick={onRemoveRating}>Remove rating</button>}
              </div>
              <RatingPicker value={rating} onChange={onRate} />
            </section>

            <section className="detail-section">
              <label className="review-field">
                <span>Review note</span>
                <textarea
                  value={review}
                  onChange={(event) => onReview(event.target.value)}
                  placeholder="Write a quick thought. Reviews will become public/social later."
                />
              </label>
            </section>

            <div className="detail-actions">
              <button onClick={onMarkWatched}>{isWatched ? "Watched" : "Mark watched"}</button>
              {isWatched && <button onClick={onRemoveWatched}>Remove watched</button>}
              <button onClick={onToggleWatchlist}>{inWatchlist ? "Saved to watchlist" : "Add to watchlist"}</button>
              {inWatchlist && <button onClick={onRemoveWatchlist}>Remove from watchlist</button>}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

export default App;
