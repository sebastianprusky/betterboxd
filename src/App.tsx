import { useEffect, useMemo, useState } from "react";
import { fallbackMovies } from "./data/fallbackMovies";
import { getTrendingMovies, hasTmdbKey, posterUrl, searchMovies } from "./services/tmdb";
import type { Movie, Palette, RatingMap, Tab, Theme, WatchlistMap } from "./types";

const ratingsKey = "betterboxd-ratings";
const watchlistKey = "betterboxd-watchlist";
const themeKey = "betterboxd-theme";
const paletteKey = "betterboxd-palette";

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
  const [palette, setPalette] = useState<Palette>(() => readJson(paletteKey, "mint"));
  const [ratings, setRatings] = useState<RatingMap>(() => readJson(ratingsKey, initialRatings, "cinecircle-ratings"));
  const [watchlist, setWatchlist] = useState<WatchlistMap>(() => readJson(watchlistKey, {}, "cinecircle-watchlist"));
  const [movies, setMovies] = useState<Movie[]>(fallbackMovies);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Movie[]>([]);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [selectedMovie, setSelectedMovie] = useState<Movie | null>(null);
  const [quickQuery, setQuickQuery] = useState("");
  const [quickResults, setQuickResults] = useState<Movie[]>(fallbackMovies.slice(0, 5));
  const [sprintIndex, setSprintIndex] = useState(0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(themeKey, JSON.stringify(theme));
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.palette = palette;
    localStorage.setItem(paletteKey, JSON.stringify(palette));
  }, [palette]);

  useEffect(() => {
    localStorage.setItem(ratingsKey, JSON.stringify(ratings));
  }, [ratings]);

  useEffect(() => {
    localStorage.setItem(watchlistKey, JSON.stringify(watchlist));
  }, [watchlist]);

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
    [...fallbackMovies, ...movies, ...searchResults, ...quickResults, ...Object.values(watchlist)].forEach((movie) =>
      map.set(movie.id, movie)
    );
    return [...map.values()];
  }, [movies, searchResults, quickResults, watchlist]);

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

  function toggleWatchlist(movie: Movie) {
    setWatchlist((current) => {
      const next = { ...current };
      if (next[movie.id]) delete next[movie.id];
      else next[movie.id] = movie;
      return next;
    });
  }

  function nextSprint() {
    setSprintIndex((index) => index + 1);
  }

  function navButton(value: Tab, label: string, meta: string) {
    return (
      <button className={tab === value ? "is-active" : ""} onClick={() => setTab(value)}>
        <span>{label}</span>
        <small>{meta}</small>
      </button>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">C</span>
          <div>
            <strong>BetterBoxd</strong>
            <span>Rate better. Find faster.</span>
          </div>
        </div>
        <nav className="side-nav">
          {navButton("discover", "Discover", "Taste + recs")}
          {navButton("search", "Search", "TMDB catalog")}
          {navButton("profile", "Profile", "Stats + watchlist")}
        </nav>
        <PalettePicker palette={palette} onChange={setPalette} />
        <div className="sidebar-footer">
          <button className="theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
            {theme === "light" ? "Dark mode" : "Light mode"}
          </button>
          <button className="sidebar-add" onClick={() => setQuickAddOpen(true)}>
            + Watched
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <p className="kicker">BetterBoxd</p>
            <h1>{tab === "discover" ? "Discover" : tab === "search" ? "Search" : "Profile"}</h1>
          </div>
          <div className="topbar-actions">
            <button className="theme-toggle compact" onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
              {theme === "light" ? "Dark" : "Light"}
            </button>
            <button className="topbar-add" onClick={() => setQuickAddOpen(true)}>
              + Watched
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
              <button className="command-action" onClick={() => setQuickAddOpen(true)}>
                Add watched
              </button>
            </section>

            <div className="desktop-dashboard">
              <div className="primary-column">
                <section className="sprint">
                  <div className="section-title">
                    <div>
                      <p className="kicker">Taste Sprint</p>
                      <h2>Rate a few, improve every recommendation.</h2>
                    </div>
                    <span>{Object.keys(ratings).length} rated</span>
                  </div>
                  {sprintMovie && (
                    <div className="sprint-layout">
                      <Poster movie={sprintMovie} large />
                      <div className="sprint-copy">
                        <div>
                          <h3>{sprintMovie.title}</h3>
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
                />
              </div>
              <aside className="insight-panel">
                <p className="kicker">Taste profile</p>
                <h2>{topGenre}</h2>
                <div className="insight-list">
                  <div>
                    <span>Rated</span>
                    <strong>{Object.keys(ratings).length}</strong>
                  </div>
                  <div>
                    <span>Watchlist</span>
                    <strong>{Object.keys(watchlist).length}</strong>
                  </div>
                  <div>
                    <span>Best next action</span>
                    <strong>Rate 5 more</strong>
                  </div>
                </div>
              </aside>
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
              empty="Rate a movie to start your profile."
            />
          </section>
        )}
      </main>

      <nav className="bottom-nav">
        {navButton("discover", "Discover", "")}
        {navButton("search", "Search", "")}
        <button className="plus-button" onClick={() => setQuickAddOpen(true)} aria-label="Add watched movie">
          +
        </button>
        {navButton("profile", "Profile", "")}
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
    </div>
  );
}

function PalettePicker({ palette, onChange }: { palette: Palette; onChange: (palette: Palette) => void }) {
  const palettes: Array<{ value: Palette; label: string }> = [
    { value: "mint", label: "Mint" },
    { value: "slate", label: "Slate" },
    { value: "rose", label: "Rose" },
    { value: "mono", label: "Mono" },
  ];

  return (
    <section className="palette-picker" aria-label="Color palette">
      <p className="kicker">Palette</p>
      <div>
        {palettes.map((item) => (
          <button
            key={item.value}
            className={palette === item.value ? "selected" : ""}
            onClick={() => onChange(item.value)}
            aria-pressed={palette === item.value}
          >
            <span className={`swatch ${item.value}`} />
            {item.label}
          </button>
        ))}
      </div>
    </section>
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
}) {
  return (
    <div className="movie-grid">
      {props.movies.map((movie) => (
        <article className="movie-card" key={movie.id}>
          <Poster movie={movie} />
          <div className="movie-info">
            <strong>{movie.title}</strong>
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

function Poster({ movie, large = false }: { movie: Movie; large?: boolean }) {
  const url = posterUrl(movie.posterPath, large ? "w780" : "w342");
  return (
    <div className={large ? "poster large" : "poster"}>
      {url ? <img src={url} alt={`${movie.title} poster`} /> : <span>{movie.title}</span>}
    </div>
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
  const ratings = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];
  return (
    <div className={compact ? "rating compact-rating" : "rating"} aria-label="Choose rating">
      {ratings.map((rating) => (
        <button
          key={rating}
          className={value === rating ? "selected" : ""}
          onClick={() => onChange(rating)}
          aria-label={`${rating} stars`}
        >
          {rating}
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

export default App;
