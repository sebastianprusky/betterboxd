import { useEffect, useMemo, useState } from "react";
import { fallbackMovies } from "./data/fallbackMovies";
import { getMovieDetails, getTrendingMovies, hasTmdbKey, posterUrl, searchMoviesWithDebug } from "./services/tmdb";
import type { InterestMap, InterestValue, Movie, MovieDebugMap, ProfileSort, RatingMap, ReviewMap, Tab, Theme, WatchedMap, WatchlistMap } from "./types";

type AccountMode = "unset" | "guest" | "signIn" | "create";

const ratingsKey = "betterboxd-ratings";
const watchlistKey = "betterboxd-watchlist";
const reviewsKey = "betterboxd-reviews";
const themeKey = "betterboxd-theme";
const watchedKey = "betterboxd-watched";
const interestKey = "betterboxd-interest";
const accountModeKey = "betterboxd-account-mode";
const accountEmailKey = "betterboxd-account-email";
const developerModeKey = "betterboxd-developer-mode";

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
  const weights = getGenreWeights(ratings, movies);

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

function getGenreWeights(ratings: RatingMap, movies: Movie[]) {
  const weights = new Map<string, number>();
  movies.forEach((movie) => {
    const rating = ratings[movie.id];
    if (!rating) return;
    movie.genres.forEach((genre) => weights.set(genre, (weights.get(genre) || 0) + rating));
  });
  return weights;
}

function getRecommendationDebug(ratings: RatingMap, movies: Movie[]): MovieDebugMap {
  const weights = getGenreWeights(ratings, movies);
  return Object.fromEntries(
    movies.map((movie) => {
      const genreSignals = movie.genres
        .map((genre) => ({ genre, weight: weights.get(genre) || 0 }))
        .filter(({ weight }) => weight > 0)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 3);
      const score = genreSignals.reduce((total, signal) => total + signal.weight, 0) + (movie.voteAverage || 0) / 10;

      return [
        movie.id,
        {
          status: "local",
          mode: "taste-profile",
          score: Number(score.toFixed(2)),
          strongestSignals: genreSignals.length
            ? genreSignals.map(({ genre, weight }) => `${genre}:${weight.toFixed(1)}`)
            : [`vote:${((movie.voteAverage || 0) / 10).toFixed(2)}`],
          reasonSource: "Ratings-weighted genre affinity plus TMDB vote average",
        },
      ];
    })
  );
}

function App() {
  const [tab, setTab] = useState<Tab>("discover");
  const [theme, setTheme] = useState<Theme>(() => readJson(themeKey, "light", "cinecircle-theme"));
  const [ratings, setRatings] = useState<RatingMap>(() => readJson(ratingsKey, initialRatings, "cinecircle-ratings"));
  const [watchlist, setWatchlist] = useState<WatchlistMap>(() => readJson(watchlistKey, {}, "cinecircle-watchlist"));
  const [watched, setWatched] = useState<WatchedMap>(() => readJson(watchedKey, {}));
  const [interest, setInterest] = useState<InterestMap>(() => readJson(interestKey, {}));
  const [reviews, setReviews] = useState<ReviewMap>(() => readJson(reviewsKey, {}));
  const [accountMode, setAccountMode] = useState<AccountMode>(() => readJson(accountModeKey, "unset"));
  const [accountFormMode, setAccountFormMode] = useState<Exclude<AccountMode, "unset" | "guest">>("create");
  const [accountEmail, setAccountEmail] = useState(() => readJson(accountEmailKey, ""));
  const [accountEmailDraft, setAccountEmailDraft] = useState(accountEmail);
  const [developerMode, setDeveloperMode] = useState(() => readJson(developerModeKey, false));
  const [saveStatus, setSaveStatus] = useState("Saved on this device");
  const [profileSort, setProfileSort] = useState<ProfileSort>("recentlyWatched");
  const [movies, setMovies] = useState<Movie[]>(fallbackMovies);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Movie[]>([]);
  const [searchDebug, setSearchDebug] = useState<MovieDebugMap>({});
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
    localStorage.setItem(interestKey, JSON.stringify(interest));
  }, [interest]);

  useEffect(() => {
    localStorage.setItem(reviewsKey, JSON.stringify(reviews));
  }, [reviews]);

  useEffect(() => {
    localStorage.setItem(accountModeKey, JSON.stringify(accountMode));
  }, [accountMode]);

  useEffect(() => {
    localStorage.setItem(accountEmailKey, JSON.stringify(accountEmail));
  }, [accountEmail]);

  useEffect(() => {
    localStorage.setItem(developerModeKey, JSON.stringify(developerMode));
  }, [developerMode]);

  useEffect(() => {
    if (saveStatus === "Saved on this device") return;
    const timeout = window.setTimeout(() => setSaveStatus("Saved on this device"), 3200);
    return () => window.clearTimeout(timeout);
  }, [saveStatus]);

  useEffect(() => {
    getTrendingMovies().then(setMovies).catch(() => setMovies(fallbackMovies));
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      searchMoviesWithDebug(searchQuery)
        .then((result) => {
          setSearchResults(result.movies);
          setSearchDebug(result.debug);
        })
        .catch(() => {
          setSearchResults([]);
          setSearchDebug({});
        });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [searchQuery]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      searchMoviesWithDebug(quickQuery).then((result) => setQuickResults(result.movies.length ? result.movies : fallbackMovies.slice(0, 5)));
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
      ...Object.values(interest).map((entry) => entry.movie),
      ...(detailMovie ? [detailMovie] : []),
    ].forEach((movie) => map.set(movie.id, movie));
    return [...map.values()];
  }, [movies, searchResults, quickResults, watchlist, watched, interest, detailMovie]);

  const recommendations = useMemo(() => recommendMovies(ratings, allKnownMovies), [ratings, allKnownMovies]);
  const recommendationDebug = useMemo(() => getRecommendationDebug(ratings, recommendations), [ratings, recommendations]);
  const topGenre = useMemo(() => getTopGenre(ratings, allKnownMovies), [ratings, allKnownMovies]);
  const sprintQueue = recommendations.length ? recommendations : movies.filter((movie) => !ratings[movie.id]);
  const sprintMovie = sprintQueue[sprintIndex % Math.max(sprintQueue.length, 1)];
  const interestMovies = useMemo(
    () => Object.values(interest).sort((a, b) => b.updatedAt - a.updatedAt),
    [interest]
  );
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

  function announceSave(message: string) {
    setSaveStatus(`${message} locally`);
  }

  function toggleTheme() {
    setTheme((currentTheme) => (currentTheme === "light" ? "dark" : "light"));
    announceSave("Theme saved");
  }

  function chooseGuestMode() {
    setAccountMode("guest");
    setAccountEmail("");
    setAccountEmailDraft("");
    announceSave("Guest mode selected");
  }

  function prepareAccountMode(mode: Exclude<AccountMode, "unset" | "guest">) {
    setAccountMode(mode);
    setAccountFormMode(mode);
    setAccountEmailDraft(accountEmail);
  }

  function submitAccountEmail(email: string) {
    const normalizedEmail = email.trim();
    if (!normalizedEmail) return;
    setAccountEmail(normalizedEmail);
    setAccountMode(accountFormMode);
    announceSave("Account email saved");
  }

  function toggleDeveloperMode(enabled: boolean) {
    setDeveloperMode(enabled);
    announceSave(`Developer mode ${enabled ? "enabled" : "disabled"}`);
  }

  function rateMovie(movie: Movie, rating: number) {
    setRatings((current) => ({ ...current, [movie.id]: rating }));
    markWatched(movie, false);
    announceSave(`${movie.title} rating saved`);
  }

  function markWatched(movie: Movie, notify = true) {
    setWatched((current) => ({
      ...current,
      [movie.id]: { movie, watchedAt: Date.now() },
    }));
    setWatchlist((current) => {
      const next = { ...current };
      delete next[movie.id];
      return next;
    });
    if (notify) announceSave(`${movie.title} marked watched`);
  }

  function removeRating(movie: Movie, notify = true) {
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
    if (notify) announceSave(`${movie.title} rating removed`);
  }

  function removeWatched(movie: Movie) {
    removeRating(movie, false);
    setWatched((current) => {
      const next = { ...current };
      delete next[movie.id];
      return next;
    });
    announceSave(`${movie.title} removed from watched`);
  }

  function toggleWatchlist(movie: Movie) {
    const wasSaved = Boolean(watchlist[movie.id]);
    setWatchlist((current) => {
      const next = { ...current };
      if (next[movie.id]) delete next[movie.id];
      else next[movie.id] = movie;
      return next;
    });
    announceSave(`${movie.title} ${wasSaved ? "removed from watchlist" : "saved to watchlist"}`);
  }

  function setMovieInterest(movie: Movie, value: InterestValue) {
    setInterest((current) => ({
      ...current,
      [movie.id]: { movie, value, updatedAt: Date.now() },
    }));
    announceSave(`${movie.title} marked ${interestLabel(value).toLowerCase()}`);
    nextSprint();
  }

  function removeFromWatchlist(movie: Movie) {
    setWatchlist((current) => {
      const next = { ...current };
      delete next[movie.id];
      return next;
    });
    announceSave(`${movie.title} removed from watchlist`);
  }

  function updateReview(movie: Movie, review: string) {
    setReviews((current) => {
      const next = { ...current };
      if (review.trim()) next[movie.id] = review;
      else delete next[movie.id];
      return next;
    });
    announceSave(`${movie.title} review note saved`);
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

  function previousSprint() {
    setSprintIndex((index) => (index <= 0 ? Math.max(sprintQueue.length - 1, 0) : index - 1));
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

  function interestLabel(value: InterestValue) {
    if (value === "notInterested") return "Not interested";
    return value === "maybe" ? "Maybe" : "Interested";
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
            <span className="save-status" aria-live="polite">{saveStatus}</span>
            <button className="theme-toggle" onClick={toggleTheme}>
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
                    <div className="poster-stage">
                      <button className="poster-arrow left" onClick={previousSprint} aria-label="Previous movie">
                        <span aria-hidden="true">&lt;</span>
                      </button>
                      <Poster movie={sprintMovie} large overlayTitle onOpen={openMovie} />
                      <button className="poster-arrow right" onClick={nextSprint} aria-label="Next movie">
                        <span aria-hidden="true">&gt;</span>
                      </button>
                    </div>
                    <div className="sprint-copy">
                      <p>{sprintMovie.year} · {sprintMovie.genres.slice(0, 2).join(", ") || "Movie"}</p>
                      <div className="interest-actions" aria-label="Taste Sprint response">
                        <button
                          className={interest[sprintMovie.id]?.value === "notInterested" ? "is-active" : ""}
                          onClick={() => setMovieInterest(sprintMovie, "notInterested")}
                        >
                          Not interested
                        </button>
                        <button
                          className={interest[sprintMovie.id]?.value === "maybe" ? "is-active" : ""}
                          onClick={() => setMovieInterest(sprintMovie, "maybe")}
                        >
                          Maybe
                        </button>
                        <button
                          className={interest[sprintMovie.id]?.value === "interested" ? "is-active" : ""}
                          onClick={() => setMovieInterest(sprintMovie, "interested")}
                        >
                          Interested
                        </button>
                      </div>
                      <div className="action-grid">
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
                debug={developerMode ? recommendationDebug : undefined}
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
              debug={developerMode ? searchDebug : undefined}
            />
          </section>
        )}

        {tab === "profile" && (
          <section className="screen">
            <AccountSettings
              mode={accountMode}
              formMode={accountFormMode}
              email={accountEmail}
              emailDraft={accountEmailDraft}
              saveStatus={saveStatus}
              developerMode={developerMode}
              onEmailDraftChange={setAccountEmailDraft}
              onChooseGuest={chooseGuestMode}
              onPrepareAccount={prepareAccountMode}
              onSubmitEmail={submitAccountEmail}
              onToggleDeveloperMode={toggleDeveloperMode}
            />

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
                debug={developerMode ? getRecommendationDebug(ratings, profileMovies) : undefined}
              />
              {!profileMovies.length && <p className="empty">Mark a movie watched to start your profile.</p>}
            </section>

            <section className="movie-section profile-list">
              <div className="section-title profile-title">
                <div>
                  <p className="kicker">Movies you want to come back to</p>
                  <h2>Watchlist</h2>
                </div>
              </div>
              {Object.values(watchlist).length ? (
                <MovieGrid
                  movies={Object.values(watchlist)}
                  ratings={ratings}
                  watchlist={watchlist}
                  onRate={rateMovie}
                  onWatchlist={toggleWatchlist}
                  onOpen={openMovie}
                  debug={developerMode ? getRecommendationDebug(ratings, Object.values(watchlist)) : undefined}
                />
              ) : (
                <p className="empty">Your watchlist is empty.</p>
              )}
            </section>

            <section className="movie-section profile-list">
              <div className="section-title profile-title">
                <div>
                  <p className="kicker">Taste Sprint</p>
                  <h2>Saved signals</h2>
                </div>
              </div>
              {interestMovies.length ? (
                <div className="signal-list">
                  {interestMovies.map(({ movie, value }) => (
                    <button key={movie.id} className="signal-item" onClick={() => openMovie(movie)}>
                      <Poster movie={movie} />
                      <span>
                        <strong>{movie.title}</strong>
                        <small>{movie.year}</small>
                      </span>
                      <em>{interestLabel(value)}</em>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="empty">Use Taste Sprint to save what looks interesting.</p>
              )}
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
        <span className="plus-icon" aria-hidden="true" />
        <span className="sr-only">Quick add watched movie</span>
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

function AccountSettings({
  mode,
  formMode,
  email,
  emailDraft,
  saveStatus,
  developerMode,
  onEmailDraftChange,
  onChooseGuest,
  onPrepareAccount,
  onSubmitEmail,
  onToggleDeveloperMode,
}: {
  mode: AccountMode;
  formMode: Exclude<AccountMode, "unset" | "guest">;
  email: string;
  emailDraft: string;
  saveStatus: string;
  developerMode: boolean;
  onEmailDraftChange: (email: string) => void;
  onChooseGuest: () => void;
  onPrepareAccount: (mode: Exclude<AccountMode, "unset" | "guest">) => void;
  onSubmitEmail: (email: string) => void;
  onToggleDeveloperMode: (enabled: boolean) => void;
}) {
  const accountActionLabel = formMode === "create" ? "Create account" : "Sign in";
  const accountStatus =
    mode === "guest"
      ? "Guest mode"
      : email
        ? "Account email saved"
        : mode === "unset"
          ? "Choose how to save"
          : accountActionLabel;

  return (
    <section className="account-panel" aria-labelledby="account-settings-title">
      <div className="account-summary">
        <div>
          <p className="kicker">Profile settings</p>
          <h2 id="account-settings-title">Account and saves</h2>
        </div>
        <span>{saveStatus}</span>
      </div>

      <div className="account-grid">
        <div className="account-choice">
          <strong>{accountStatus}</strong>
          <p>Create an account to sync ratings, reviews, and watchlist across devices. Continue as guest to keep everything on this device.</p>
          {email && <small>{email}</small>}
          <div className="account-actions" aria-label="Account options">
            <button className={formMode === "create" && mode !== "guest" ? "is-active" : ""} onClick={() => onPrepareAccount("create")}>
              Create account
            </button>
            <button className={formMode === "signIn" && mode !== "guest" ? "is-active" : ""} onClick={() => onPrepareAccount("signIn")}>
              Sign in
            </button>
            <button className={mode === "guest" ? "is-active" : ""} onClick={onChooseGuest}>
              Continue as guest
            </button>
          </div>
        </div>

        <form
          className="account-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmitEmail(emailDraft);
          }}
        >
          <label>
            <span>Email</span>
            <input
              type="email"
              value={emailDraft}
              onChange={(event) => onEmailDraftChange(event.target.value)}
              placeholder={formMode === "create" ? "you@example.com" : "email used for your account"}
            />
          </label>
          <button type="submit">{accountActionLabel}</button>
          <p>Account sync is ready for the future Supabase flow. Until auth is connected, changes are saved locally.</p>
        </form>
      </div>

      <label className="developer-toggle">
        <span>
          <strong>Developer mode</strong>
          <small>Show recommender and semantic-search diagnostics on movie cards.</small>
        </span>
        <input type="checkbox" checked={developerMode} onChange={(event) => onToggleDeveloperMode(event.target.checked)} />
      </label>
    </section>
  );
}

function MovieSection(props: {
  title: string;
  subtitle: string;
  movies: Movie[];
  ratings: RatingMap;
  watchlist: WatchlistMap;
  watched?: WatchedMap;
  debug?: MovieDebugMap;
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
  debug?: MovieDebugMap;
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
          {props.debug?.[movie.id] && <DebugPanel debug={props.debug[movie.id]} />}
          <RatingPicker compact value={props.ratings[movie.id]} onChange={(rating) => props.onRate(movie, rating)} />
        </article>
      ))}
    </div>
  );
}

function DebugPanel({ debug }: { debug: NonNullable<MovieDebugMap[number]> }) {
  return (
    <div className="debug-panel" aria-label="Developer recommender details">
      <div>
        <span>{debug.status}</span>
        <span>{debug.mode}</span>
        {typeof debug.score === "number" && <span>score {debug.score}</span>}
      </div>
      <p>{debug.reasonSource}</p>
      <small>{debug.strongestSignals.join(" · ")}</small>
    </div>
  );
}

function Poster({
  movie,
  large = false,
  overlayTitle = false,
  onOpen,
}: {
  movie: Movie;
  large?: boolean;
  overlayTitle?: boolean;
  onOpen?: (movie: Movie) => void;
}) {
  const url = posterUrl(movie.posterPath, large ? "w780" : "w342");
  const content = (
    <>
      {url ? <img src={url} alt={`${movie.title} poster`} /> : <span className="poster-fallback">{movie.title}</span>}
      {overlayTitle && <span className="poster-title">{movie.title}</span>}
    </>
  );

  return onOpen ? (
    <button className={`${large ? "poster large" : "poster"}${overlayTitle ? " has-title-overlay" : ""}`} onClick={() => onOpen(movie)} aria-label={`Open ${movie.title}`}>
      {content}
    </button>
  ) : (
    <div className={`${large ? "poster large" : "poster"}${overlayTitle ? " has-title-overlay" : ""}`}>{content}</div>
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
