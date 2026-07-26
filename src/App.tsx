import { useEffect, useMemo, useState } from "react";
import { fallbackMovies } from "./data/fallbackMovies";
import { getMovieDetails, getTrendingMovies, hasTmdbKey, posterUrl, searchMovies } from "./services/tmdb";
import type { Movie, RatingMap, ReviewMap, Tab, Theme, WatchlistMap } from "./types";

const ratingsKey = "betterboxd-ratings";
const watchlistKey = "betterboxd-watchlist";
const reviewsKey = "betterboxd-reviews";
const themeKey = "betterboxd-theme";

const initialRatings: RatingMap = {
  "496243": 4.5,
  "244786": 5,
  "38": 4,
};

function readJson<T>(key: string, fallback: T, legacyKey?: string): T {
  const value = localStorage.getItem(key) || (legacyKey ? localStorage.getItem(legacyKey) : null);
  return value ? JSON.parse(value) : fallback;
}

function ratingLabel(rating?: number) {
  return rating ? `${rating.toFixed(rating % 1 ? 1 : 0)}★` : "Rate";
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
  const [reviews, setReviews] = useState<ReviewMap>(() => readJson(reviewsKey, {}));
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
    [...fallbackMovies, ...movies, ...searchResults, ...quickResults, ...Object.values(watchlist), ...(detailMovie ? [detailMovie] : [])].forEach((movie) =>
      map.set(movie.id, movie)
    );
    return [...map.values()];
  }, [movies, searchResults, quickResults, watchlist, detailMovie]);

  const recommendations = useMemo(() => recommendMovies(ratings, allKnownMovies), [ratings, allKnownMovies]);
  const topGenre = useMemo(() => getTopGenre(ratings, allKnownMovies), [ratings, allKnownMovies]);
  const sprintQueue = recommendations.length ? recommendations : movies.filter((movie) => !ratings[movie.id]);
  const sprintMovie = sprintQueue[sprintIndex % Math.max(sprintQueue.length, 1)];
  const ratedMovies = allKnownMovies.filter((movie) => ratings[movie.id]).sort((a, b) => ratings[b.id] - ratings[a.id]);

  function rateMovie(movie: Movie, rating: number) {
    setRatings((current) => ({ ...current, [movie.id]: rating }));
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
            <section className="command-bar" aria-label="Quick actions">
              <button className="command-search" onClick={() => setTab("search")}>
                <span>Search any movie</span>
                <kbd>⌘K</kbd>
              </button>
            </section>

            <div className="discover-focus">
                <section className="sprint focus-sprint">
                  <div className="section-title">
                    <div>
                      <p className="kicker">Taste Sprint</p>
                      <h2>Rate a few, improve every recommendation.</h2>
                    </div>
                    <span>{Object.keys(ratings).length} rated</span>
                  </div>
                  {sprintMovie && (
                    <div className="sprint-layout">
                      <Poster movie={sprintMovie} large onOpen={openMovie} />
                      <div className="sprint-copy">
                        <div>
                          <button className="title-button" onClick={() => openMovie(sprintMovie)}>
                            <h3>{sprintMovie.title}</h3>
                          </button>
                          <p>{sprintMovie.overview}</p>
                        </div>
                        <div className="genre-row">
                          {sprintMovie.genres.slice(0, 3).map((genre) => (
                            <span key={genre}>{genre}</span>
                          ))}
                        </div>
                        <RatingPicker value={ratings[sprintMovie.id]} onChange={(rating) => rateMovie(sprintMovie, rating)} />
                        <div className="action-grid">
                          <button onClick={nextSprint}>Skip</button>
                          <button onClick={() => toggleWatchlist(sprintMovie)}>
                            {watchlist[sprintMovie.id] ? "Saved" : "Watchlist"}
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
            <section className="profile-head">
              <div>
                <p className="kicker">Your taste</p>
                <h2>{topGenre}</h2>
              </div>
              <div className="stat-row">
                <Stat label="Rated" value={String(Object.keys(ratings).length)} />
                <Stat label="Watchlist" value={String(Object.keys(watchlist).length)} />
                <Stat
                  label="Average"
                  value={
                    Object.values(ratings).length
                      ? (Object.values(ratings).reduce((sum, rating) => sum + rating, 0) / Object.values(ratings).length).toFixed(1)
                      : "0"
                  }
                />
              </div>
            </section>

            <MovieSection
              title="Watchlist"
              subtitle="Rate a movie to mark it watched"
              movies={Object.values(watchlist)}
              ratings={ratings}
              watchlist={watchlist}
              onRate={rateMovie}
              onWatchlist={toggleWatchlist}
              onOpen={openMovie}
              empty="Your watchlist is empty."
            />

            <MovieSection
              title="Recent ratings"
              subtitle="Reviews and follows will attach here later"
              movies={ratedMovies.slice(0, 8)}
              ratings={ratings}
              watchlist={watchlist}
              onRate={rateMovie}
              onWatchlist={toggleWatchlist}
              onOpen={openMovie}
              empty="Rate a movie to start your profile."
            />
          </section>
        )}
      </main>

      <nav className="bottom-nav">
        {navButton("discover", "Discover")}
        {navButton("search", "Search")}
        {navButton("profile", "Profile")}
      </nav>

      <button className="floating-add" onClick={() => setQuickAddOpen(true)}>
        + Watched
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
              <RatingPicker
                value={ratings[selectedMovie.id]}
                onChange={(rating) => {
                  rateMovie(selectedMovie, rating);
                  setQuickAddOpen(false);
                  setQuickQuery("");
                  setSelectedMovie(null);
                }}
              />
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
          onClose={() => setDetailMovie(null)}
          onRate={(rating) => rateMovie(detailMovie, rating)}
          onRemoveRating={() => removeRating(detailMovie)}
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
  empty?: string;
  onRate: (movie: Movie, rating: number) => void;
  onWatchlist: (movie: Movie) => void;
  onOpen: (movie: Movie) => void;
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
  onRate: (movie: Movie, rating: number) => void;
  onWatchlist: (movie: Movie) => void;
  onOpen: (movie: Movie) => void;
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
            <button onClick={() => props.onWatchlist(movie)}>{props.watchlist[movie.id] ? "Saved" : "+ List"}</button>
            <button className="rate-chip">{ratingLabel(props.ratings[movie.id])}</button>
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function MovieDetailModal({
  movie,
  loading,
  rating,
  review,
  inWatchlist,
  onClose,
  onRate,
  onRemoveRating,
  onReview,
  onToggleWatchlist,
  onRemoveWatchlist,
}: {
  movie: Movie;
  loading: boolean;
  rating?: number;
  review: string;
  inWatchlist: boolean;
  onClose: () => void;
  onRate: (rating: number) => void;
  onRemoveRating: () => void;
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
                  <strong>{ratingLabel(rating)}</strong>
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
