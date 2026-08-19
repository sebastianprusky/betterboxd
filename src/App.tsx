import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { fallbackMovies, genreIds } from "./data/fallbackMovies";
import { getTopTasteLabel, recommendMovies, type RecommendationResult } from "./services/recommendations";
import {
  getCurrentSession,
  isSupabaseConfigured,
  loadCloudState,
  saveCloudState,
  signIn,
  signOut,
  signUp,
  subscribeToAuth,
  type AuthSession,
} from "./services/supabase";
import {
  askBetterBoxd,
  getMovieDetails,
  getRecommendationCatalog,
  getTrendingMovies,
  hasTmdbKey,
  posterUrl,
  searchMovies,
  searchMoviesWithDebug,
} from "./services/tmdb";
import type {
  AskBetterBoxdResult,
  AskFilter,
  CloudUserState,
  InterestMap,
  InterestValue,
  Movie,
  MovieDebugMap,
  OnboardingPreferences,
  ProfileSort,
  RatingMap,
  RecommendationEvent,
  RecommendationEventType,
  RecommendationMode,
  ReviewMap,
  Tab,
  Theme,
  WatchedMap,
  WatchlistMap,
} from "./types";

type SearchMode = "movies" | "ask";

const ratingsKey = "betterboxd-ratings";
const watchlistKey = "betterboxd-watchlist";
const reviewsKey = "betterboxd-reviews";
const themeKey = "betterboxd-theme";
const watchedKey = "betterboxd-watched";
const interestKey = "betterboxd-interest";
const preferencesKey = "betterboxd-onboarding-preferences";
const recommendationModeKey = "betterboxd-recommendation-mode";
const recommendationEventsKey = "betterboxd-recommendation-events";
const guestModeKey = "betterboxd-guest-mode";
const movieCacheKey = "betterboxd-movie-cache";
const developerModeKey = "betterboxd-developer-mode";

const initialRatings: RatingMap = {
  "496243": 4.5,
  "244786": 5,
  "38": 4,
};

const defaultPreferences: OnboardingPreferences = {
  genres: [],
  directors: [],
  favoriteMovies: {},
};

const selectableGenres = [...new Set(Object.values(genreIds))].sort();

function readJson<T>(key: string, fallback: T, legacyKey?: string): T {
  const value = localStorage.getItem(key) || (legacyKey ? localStorage.getItem(legacyKey) : null);
  return value ? JSON.parse(value) : fallback;
}

function createRecommendationEvent(
  type: RecommendationEventType,
  movie: Movie,
  mode: RecommendationMode,
  score: number,
): RecommendationEvent {
  return {
    id: `${type}-${movie.id}-${mode}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type,
    movieId: movie.id,
    movieTitle: movie.title,
    mode,
    score,
    createdAt: Date.now(),
  };
}

function trimRecommendationEvents(events: RecommendationEvent[]) {
  return events.slice(-300);
}

function mergeMovieLists(...lists: Movie[][]) {
  const map = new Map<number, Movie>();
  lists.flat().forEach((movie) => {
    const existing = map.get(movie.id);
    map.set(movie.id, { ...existing, ...movie });
  });
  return [...map.values()];
}

function trimMovieCache(movies: Movie[]) {
  return mergeMovieLists(movies).slice(-250);
}

function summarizeRecommendationFeedback(events: RecommendationEvent[]) {
  const impressions = events.filter((event) => event.type === "impression");
  const opens = events.filter((event) => event.type === "open");
  const strongActions = events.filter((event) => event.type === "watchlist" || event.type === "highRating");
  const strongMovieIds = new Set(strongActions.map((event) => event.movieId));
  const modeStats = new Map<RecommendationMode, { impressions: number; strongActions: number }>();

  events.forEach((event) => {
    const stats = modeStats.get(event.mode) || { impressions: 0, strongActions: 0 };
    if (event.type === "impression") stats.impressions += 1;
    if (event.type === "watchlist" || event.type === "highRating") stats.strongActions += 1;
    modeStats.set(event.mode, stats);
  });

  const bestMode = [...modeStats.entries()]
    .filter(([, stats]) => stats.impressions >= 3 && stats.strongActions > 0)
    .sort((a, b) => b[1].strongActions / b[1].impressions - a[1].strongActions / a[1].impressions)[0]?.[0];

  return {
    hasData: impressions.length > 0 || opens.length > 0 || strongActions.length > 0,
    exploredCount: new Set(opens.map((event) => event.movieId)).size,
    strongCount: strongMovieIds.size,
    bestMode,
  };
}

function getRecommendationDebug(results: RecommendationResult[]): MovieDebugMap {
  return Object.fromEntries(
    results.map((result) => [
      result.movie.id,
      {
        status: "local",
        mode: "taste-profile",
        score: Number(result.score.toFixed(3)),
        strongestSignals: [result.reason],
        reasonSource: "Local profile embedding, preference signals, and diversity reranking",
      },
    ])
  );
}

function App() {
  const askCache = useRef<Record<string, AskBetterBoxdResult>>({});
  const [tab, setTab] = useState<Tab>("discover");
  const [theme, setTheme] = useState<Theme>(() => readJson(themeKey, "light", "cinecircle-theme"));
  const [recommendationMode, setRecommendationMode] = useState<RecommendationMode>(() =>
    readJson<RecommendationMode>(recommendationModeKey, "balanced")
  );
  const [preferences, setPreferences] = useState<OnboardingPreferences>(() =>
    readJson(preferencesKey, defaultPreferences)
  );
  const [ratings, setRatings] = useState<RatingMap>(() => readJson(ratingsKey, initialRatings, "cinecircle-ratings"));
  const [watchlist, setWatchlist] = useState<WatchlistMap>(() => readJson(watchlistKey, {}, "cinecircle-watchlist"));
  const [watched, setWatched] = useState<WatchedMap>(() => readJson(watchedKey, {}));
  const [interest, setInterest] = useState<InterestMap>(() => readJson(interestKey, {}));
  const [reviews, setReviews] = useState<ReviewMap>(() => readJson(reviewsKey, {}));
  const [recommendationEvents, setRecommendationEvents] = useState<RecommendationEvent[]>(() =>
    readJson(recommendationEventsKey, [])
  );
  const [session, setSession] = useState<AuthSession | null>(null);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authMode, setAuthMode] = useState<"signIn" | "signUp">("signIn");
  const [authPromptOpen, setAuthPromptOpen] = useState(false);
  const [guestMode, setGuestMode] = useState(() => readJson(guestModeKey, false));
  const [syncStatus, setSyncStatus] = useState("Saved on this device");
  const [developerMode, setDeveloperMode] = useState(() => readJson(developerModeKey, false));
  const [profileSort, setProfileSort] = useState<ProfileSort>("recentlyWatched");
  const [movies, setMovies] = useState<Movie[]>(fallbackMovies);
  const [catalogMovies, setCatalogMovies] = useState<Movie[]>(() => readJson(movieCacheKey, fallbackMovies));
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<SearchMode>("movies");
  const [searchResults, setSearchResults] = useState<Movie[]>([]);
  const [searchDebug, setSearchDebug] = useState<MovieDebugMap>({});
  const [askFilters, setAskFilters] = useState<AskFilter[]>([]);
  const [askExplanation, setAskExplanation] = useState("");
  const [askLoading, setAskLoading] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [selectedMovie, setSelectedMovie] = useState<Movie | null>(null);
  const [quickQuery, setQuickQuery] = useState("");
  const [quickResults, setQuickResults] = useState<Movie[]>(fallbackMovies.slice(0, 5));
  const [sprintIndex, setSprintIndex] = useState(0);
  const [detailMovie, setDetailMovie] = useState<Movie | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [favoriteMovieQuery, setFavoriteMovieQuery] = useState("");
  const [favoriteMovieResults, setFavoriteMovieResults] = useState<Movie[]>(fallbackMovies.slice(0, 5));
  const [directorInput, setDirectorInput] = useState("");
  const loggedImpressionGroups = useRef(new Set<string>());
  const cloudLoadedForUser = useRef<string | null>(null);
  const skipNextCloudSave = useRef(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(themeKey, JSON.stringify(theme));
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(ratingsKey, JSON.stringify(ratings));
  }, [ratings]);

  useEffect(() => {
    localStorage.setItem(recommendationModeKey, JSON.stringify(recommendationMode));
  }, [recommendationMode]);

  useEffect(() => {
    localStorage.setItem(preferencesKey, JSON.stringify(preferences));
  }, [preferences]);

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
    localStorage.setItem(recommendationEventsKey, JSON.stringify(recommendationEvents.slice(-300)));
  }, [recommendationEvents]);

  useEffect(() => {
    localStorage.setItem(guestModeKey, JSON.stringify(guestMode));
  }, [guestMode]);

  useEffect(() => {
    localStorage.setItem(movieCacheKey, JSON.stringify(trimMovieCache(catalogMovies)));
  }, [catalogMovies]);

  useEffect(() => {
    localStorage.setItem(developerModeKey, JSON.stringify(developerMode));
  }, [developerMode]);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setSyncStatus("Saved on this device");
      return;
    }

    getCurrentSession()
      .then(setSession)
      .catch((error) => setSyncStatus(error.message));

    return subscribeToAuth((nextSession) => {
      setSession(nextSession);
      if (!nextSession) {
        cloudLoadedForUser.current = null;
        setSyncStatus("Signed out");
      }
    });
  }, []);

  useEffect(() => {
    const userId = session?.user.id;
    if (!userId || cloudLoadedForUser.current === userId) return;

    setSyncStatus("Loading account data");
    loadCloudState(userId)
      .then((cloudState) => {
        if (cloudState) {
          skipNextCloudSave.current = true;
          setRatings(cloudState.ratings || {});
          setWatchlist(cloudState.watchlist || {});
          setWatched(cloudState.watched || {});
          setInterest(cloudState.interest || {});
          setReviews(cloudState.reviews || {});
          setPreferences(cloudState.preferences || defaultPreferences);
          setRecommendationEvents(cloudState.recommendationEvents || []);
        }
        cloudLoadedForUser.current = userId;
        setSyncStatus(cloudState ? "Synced to account" : "Account ready");
      })
      .catch((error) => setSyncStatus(error.message));
  }, [session]);

  useEffect(() => {
    getTrendingMovies()
      .then((trending) => {
        setMovies(trending);
        rememberMovies(trending);
      })
      .catch(() => setMovies(fallbackMovies));
    getRecommendationCatalog()
      .then(rememberMovies)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      const query = searchQuery.trim();
      if (!query || query.length < 2) {
        setSearchResults([]);
        setSearchDebug({});
        setAskFilters([]);
        setAskExplanation("");
        setAskLoading(false);
        return;
      }

      if (searchMode === "ask") {
        if (query.length < 4) {
          setSearchResults([]);
          setSearchDebug({});
          setAskFilters([{ label: "Mode", value: "Natural language" }]);
          setAskExplanation("Ask for a genre, year range, mood, or theme.");
          setAskLoading(false);
          return;
        }

        const cacheKey = query.toLowerCase();
        const cached = askCache.current[cacheKey];
        if (cached) {
          setSearchResults(cached.movies);
          setSearchDebug(cached.debug);
          setAskFilters(cached.filters);
          setAskExplanation(cached.explanation);
          setAskLoading(false);
          rememberMovies(cached.movies);
          return;
        }

        setAskLoading(true);
        askBetterBoxd(query)
          .then((result) => {
            if (cancelled) return;
            askCache.current[cacheKey] = result;
            setSearchResults(result.movies);
            setSearchDebug(result.debug);
            setAskFilters(result.filters);
            setAskExplanation(result.explanation);
            rememberMovies(result.movies);
          })
          .catch(() => {
            if (cancelled) return;
            setSearchResults([]);
            setSearchDebug({});
            setAskFilters([{ label: "Fallback", value: "Unavailable" }]);
            setAskExplanation("I could not understand that request yet. Try a genre, year range, mood, or title.");
          })
          .finally(() => {
            if (!cancelled) setAskLoading(false);
          });
        return;
      }

      setAskFilters([]);
      setAskExplanation("");
      setAskLoading(false);
      searchMoviesWithDebug(query)
        .then((result) => {
          if (cancelled) return;
          setSearchResults(result.movies);
          setSearchDebug(result.debug);
          rememberMovies(result.movies);
        })
        .catch(() => {
          if (cancelled) return;
          setSearchResults([]);
          setSearchDebug({});
        });
    }, searchMode === "ask" ? 650 : 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [searchMode, searchQuery]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      searchMovies(quickQuery).then((results) => {
        const nextResults = results.length ? results : fallbackMovies.slice(0, 5);
        setQuickResults(nextResults);
        rememberMovies(nextResults);
      });
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [quickQuery]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      searchMovies(favoriteMovieQuery).then((results) => {
        const nextResults = results.length ? results : fallbackMovies.slice(0, 5);
        setFavoriteMovieResults(nextResults);
        rememberMovies(nextResults);
      });
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [favoriteMovieQuery]);

  const allKnownMovies = useMemo(() => {
    const map = new Map<number, Movie>();
    [
      ...fallbackMovies,
      ...catalogMovies,
      ...movies,
      ...searchResults,
      ...quickResults,
      ...favoriteMovieResults,
      ...Object.values(watchlist),
      ...Object.values(watched).map((entry) => entry.movie),
      ...Object.values(interest).map((entry) => entry.movie),
      ...Object.values(preferences.favoriteMovies),
      ...(detailMovie ? [detailMovie] : []),
    ].forEach((movie) => map.set(movie.id, movie));
    return [...map.values()];
  }, [catalogMovies, movies, searchResults, quickResults, favoriteMovieResults, watchlist, watched, interest, preferences, detailMovie]);

  const recommendationResults = useMemo(
    () =>
      recommendMovies({
        movies: allKnownMovies,
        ratings,
        watchlist,
        interest,
        preferences,
        mode: recommendationMode,
      }),
    [allKnownMovies, ratings, watchlist, interest, preferences, recommendationMode]
  );
  const recommendations = recommendationResults.map(({ movie }) => movie);
  const recommendationByMovieId = useMemo(
    () => new Map(recommendationResults.map((result) => [result.movie.id, result])),
    [recommendationResults]
  );
  const recommendationDebug = useMemo(
    () => getRecommendationDebug(recommendationResults),
    [recommendationResults]
  );
  const topGenre = useMemo(
    () => getTopTasteLabel(ratings, allKnownMovies, preferences),
    [ratings, allKnownMovies, preferences]
  );
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
  const recommendationFeedback = useMemo(
    () => summarizeRecommendationFeedback(recommendationEvents),
    [recommendationEvents]
  );
  const cloudState = useMemo<CloudUserState>(
    () => ({
      ratings,
      watchlist,
      watched,
      interest,
      reviews,
      preferences,
      recommendationEvents: recommendationEvents.slice(-300),
    }),
    [ratings, watchlist, watched, interest, reviews, preferences, recommendationEvents]
  );

  useEffect(() => {
    const userId = session?.user.id;
    if (!userId || cloudLoadedForUser.current !== userId) return;

    if (skipNextCloudSave.current) {
      skipNextCloudSave.current = false;
      return;
    }

    setSyncStatus("Saving");
    const timeout = window.setTimeout(() => {
      saveCloudState(userId, cloudState)
        .then(() => setSyncStatus("Synced to account"))
        .catch((error) => setSyncStatus(error.message));
    }, 650);

    return () => window.clearTimeout(timeout);
  }, [cloudState, session]);

  useEffect(() => {
    const signature = `${recommendationMode}:${recommendationResults.map(({ movie }) => movie.id).join(",")}`;
    if (!recommendationResults.length || loggedImpressionGroups.current.has(signature)) return;

    loggedImpressionGroups.current.add(signature);
    setRecommendationEvents((current) =>
      trimRecommendationEvents([
        ...current,
        ...recommendationResults.map(({ movie, score }) =>
          createRecommendationEvent("impression", movie, recommendationMode, score)
        ),
      ])
    );
  }, [recommendationMode, recommendationResults]);

  function rateMovie(movie: Movie, rating: number) {
    if (!requireAccountAction()) return;
    logRecommendationOutcome(movie, rating >= 4 ? "highRating" : "rating");
    setRatings((current) => ({ ...current, [movie.id]: rating }));
    markWatchedState(movie);
  }

  function markWatched(movie: Movie) {
    if (!requireAccountAction()) return;
    markWatchedState(movie);
  }

  function markWatchedState(movie: Movie) {
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
    if (!requireAccountAction()) return;
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
    if (!requireAccountAction()) return;
    removeRating(movie);
    setWatched((current) => {
      const next = { ...current };
      delete next[movie.id];
      return next;
    });
  }

  function toggleWatchlist(movie: Movie) {
    if (!requireAccountAction()) return;
    if (!watchlist[movie.id]) logRecommendationOutcome(movie, "watchlist");
    setWatchlist((current) => {
      const next = { ...current };
      if (next[movie.id]) delete next[movie.id];
      else next[movie.id] = movie;
      return next;
    });
  }

  function setMovieInterest(movie: Movie, value: InterestValue) {
    if (!requireAccountAction()) return;
    setInterest((current) => ({
      ...current,
      [movie.id]: { movie, value, updatedAt: Date.now() },
    }));
    nextSprint();
  }

  function removeFromWatchlist(movie: Movie) {
    if (!requireAccountAction()) return;
    setWatchlist((current) => {
      const next = { ...current };
      delete next[movie.id];
      return next;
    });
  }

  function togglePreferenceGenre(genre: string) {
    if (!requireAccountAction()) return;
    setPreferences((current) => ({
      ...current,
      genres: current.genres.includes(genre)
        ? current.genres.filter((currentGenre) => currentGenre !== genre)
        : [...current.genres, genre],
    }));
  }

  function addFavoriteMovie(movie: Movie) {
    if (!requireAccountAction()) return;
    setPreferences((current) => ({
      ...current,
      favoriteMovies: { ...current.favoriteMovies, [movie.id]: movie },
    }));
    setFavoriteMovieQuery("");
  }

  function removeFavoriteMovie(movie: Movie) {
    if (!requireAccountAction()) return;
    setPreferences((current) => {
      const next = { ...current.favoriteMovies };
      delete next[movie.id];
      return { ...current, favoriteMovies: next };
    });
  }

  function addDirector() {
    if (!requireAccountAction()) return;
    const director = directorInput.trim();
    if (!director) return;
    setPreferences((current) => ({
      ...current,
      directors: current.directors.some((currentDirector) => currentDirector.toLowerCase() === director.toLowerCase())
        ? current.directors
        : [...current.directors, director],
    }));
    setDirectorInput("");
  }

  function removeDirector(director: string) {
    if (!requireAccountAction()) return;
    setPreferences((current) => ({
      ...current,
      directors: current.directors.filter((currentDirector) => currentDirector !== director),
    }));
  }

  function updateReview(movie: Movie, review: string) {
    if (!requireAccountAction()) return;
    setReviews((current) => {
      const next = { ...current };
      if (review.trim()) next[movie.id] = review;
      else delete next[movie.id];
      return next;
    });
  }

  async function openMovie(movie: Movie) {
    logRecommendationOutcome(movie, "open");
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

  function rememberMovies(nextMovies: Movie[]) {
    if (!nextMovies.length) return;
    setCatalogMovies((current) => trimMovieCache(mergeMovieLists(current, nextMovies)));
  }

  function logRecommendationOutcome(movie: Movie, type: RecommendationEventType) {
    if (type === "impression") return;
    const recommendation = recommendationByMovieId.get(movie.id);
    if (!recommendation) return;

    setRecommendationEvents((current) =>
      trimRecommendationEvents([
        ...current,
        createRecommendationEvent(type, movie, recommendationMode, recommendation.score),
      ])
    );
  }

  function requireAccountAction() {
    if (!isSupabaseConfigured || session || guestMode) return true;
    setAuthPromptOpen(true);
    setSyncStatus("Sign in to sync across devices, or continue as guest");
    return false;
  }

  function continueAsGuest() {
    setGuestMode(true);
    setAuthPromptOpen(false);
    setSyncStatus("Saving locally as guest");
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!authEmail.trim() || !authPassword) return;

    setSyncStatus(authMode === "signIn" ? "Signing in" : "Creating account");
    try {
      const nextSession =
        authMode === "signIn"
          ? await signIn(authEmail.trim(), authPassword)
          : await signUp(authEmail.trim(), authPassword);
      setSession(nextSession);
      if (nextSession) setGuestMode(false);
      setAuthPassword("");
      if (nextSession) setAuthPromptOpen(false);
      setSyncStatus(
        nextSession
          ? "Account ready"
          : "Check your email for a Supabase confirmation message for BetterBoxd"
      );
    } catch (error) {
      setSyncStatus(error instanceof Error ? error.message : "Authentication failed");
    }
  }

  async function handleSignOut() {
    setSyncStatus("Signing out");
    try {
      await signOut();
      setSession(null);
      setGuestMode(false);
      setAuthPromptOpen(false);
      setSyncStatus("Signed out");
    } catch (error) {
      setSyncStatus(error instanceof Error ? error.message : "Could not sign out");
    }
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
                subtitle={`${recommendationMode} mode · taste leans ${topGenre.toLowerCase()}`}
                movies={recommendations}
                recommendationResults={recommendationResults}
                debug={developerMode ? recommendationDebug : undefined}
                ratings={ratings}
                watchlist={watchlist}
                onRate={rateMovie}
                onWatchlist={toggleWatchlist}
                onOpen={openMovie}
              />

              <section className="movie-section recommendation-controls">
                <div className="mode-tabs" aria-label="Recommendation mode">
                  <ModeButton mode="focused" active={recommendationMode} onChange={setRecommendationMode} />
                  <ModeButton mode="balanced" active={recommendationMode} onChange={setRecommendationMode} />
                  <ModeButton mode="exploratory" active={recommendationMode} onChange={setRecommendationMode} />
                </div>
              </section>
            </div>
          </section>
        )}

        {tab === "search" && (
          <section className="screen">
            <div className={`search-shell ${searchMode === "ask" ? "is-ask-mode" : ""}`}>
              <label className="field">
                <span>{searchMode === "ask" ? "Ask BetterBoxd" : "Find movies"}</span>
                <input
                  autoFocus
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={searchMode === "ask" ? "Try horror movies released in the 2010s" : "Search by title, keyword, or person"}
                />
              </label>
              <SearchModeControl mode={searchMode} onChange={setSearchMode} />
              {searchMode === "ask" && (
                <div className="ask-summary" aria-live="polite">
                  <div className="filter-chips">
                    {(askFilters.length ? askFilters : [{ label: "Mode", value: "Natural language" }]).map((filter) => (
                      <span key={`${filter.label}-${filter.value}`}>
                        {filter.label}: {filter.value}
                      </span>
                    ))}
                  </div>
                  <p>{askLoading ? "Reading your request..." : askExplanation || "Ask for a genre, year range, mood, or theme."}</p>
                </div>
              )}
            </div>
            {!hasTmdbKey() && (
              <p className="notice">Using demo poster data. Add VITE_TMDB_API_KEY to search TMDB.</p>
            )}
            <MovieGrid
              movies={searchQuery ? searchResults : movies}
              ratings={ratings}
              watchlist={watchlist}
              debug={developerMode ? searchDebug : undefined}
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

            <section className="movie-section profile-list">
              <div className="section-title profile-title">
                <div>
                  <p className="kicker">Recommendations</p>
                  <h2>Feedback loop</h2>
                </div>
              </div>
              <RecommendationFeedbackPanel feedback={recommendationFeedback} />
            </section>

            <section className="movie-section profile-list taste-setup">
              <div className="section-title profile-title">
                <div>
                  <p className="kicker">Settings</p>
                  <h2>Taste preferences</h2>
                </div>
              </div>

              <AccountSettings
                configured={isSupabaseConfigured}
                email={authEmail}
                password={authPassword}
                mode={authMode}
                sessionEmail={session?.user.email || ""}
                syncStatus={syncStatus}
                guestMode={guestMode}
                developerMode={developerMode}
                onEmail={setAuthEmail}
                onPassword={setAuthPassword}
                onMode={setAuthMode}
                onSubmit={submitAuth}
                onSignOut={handleSignOut}
                onGuest={continueAsGuest}
                onToggleDeveloperMode={setDeveloperMode}
              />

              <div className="setup-grid">
                <section>
                  <p className="setup-label">Genres</p>
                  <div className="chip-grid">
                    {selectableGenres.map((genre) => (
                      <button
                        key={genre}
                        className={preferences.genres.includes(genre) ? "chip is-active" : "chip"}
                        onClick={() => togglePreferenceGenre(genre)}
                      >
                        {genre}
                      </button>
                    ))}
                  </div>
                </section>

                <section>
                  <p className="setup-label">Favorite movies</p>
                  <input
                    className="compact-input"
                    value={favoriteMovieQuery}
                    onChange={(event) => setFavoriteMovieQuery(event.target.value)}
                    placeholder="Search favorites"
                  />
                  <div className="mini-results">
                    {favoriteMovieResults.slice(0, 4).map((movie) => (
                      <button key={movie.id} onClick={() => addFavoriteMovie(movie)}>
                        <span>{movie.title}</span>
                        <small>{movie.year}</small>
                      </button>
                    ))}
                  </div>
                  <PillList movies={Object.values(preferences.favoriteMovies)} onRemove={removeFavoriteMovie} />
                </section>

                <section>
                  <p className="setup-label">Directors</p>
                  <form
                    className="director-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      addDirector();
                    }}
                  >
                    <input
                      className="compact-input"
                      value={directorInput}
                      onChange={(event) => setDirectorInput(event.target.value)}
                      placeholder="Type a director"
                    />
                    <button>Add</button>
                  </form>
                  <div className="pill-row">
                    {preferences.directors.map((director) => (
                      <button key={director} onClick={() => removeDirector(director)}>
                        {director}
                      </button>
                    ))}
                  </div>
                </section>
              </div>
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

      <button className="floating-add" onClick={() => (requireAccountAction() ? setQuickAddOpen(true) : undefined)}>
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

      {authPromptOpen && !session && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setAuthPromptOpen(false)}>
          <section className="modal auth-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <div>
                <p className="kicker">Account required</p>
                <h2>Sign in to save movies.</h2>
              </div>
              <button onClick={() => setAuthPromptOpen(false)}>Close</button>
            </div>
            <AccountSettings
              configured={isSupabaseConfigured}
              email={authEmail}
              password={authPassword}
              mode={authMode}
              sessionEmail=""
              syncStatus={syncStatus}
              guestMode={guestMode}
              developerMode={developerMode}
              onEmail={setAuthEmail}
              onPassword={setAuthPassword}
              onMode={setAuthMode}
              onSubmit={submitAuth}
              onSignOut={handleSignOut}
              onGuest={continueAsGuest}
              onToggleDeveloperMode={setDeveloperMode}
            />
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

function SearchModeControl({ mode, onChange }: { mode: SearchMode; onChange: (mode: SearchMode) => void }) {
  return (
    <div className="search-mode-control" aria-label="Search mode">
      <button className={mode === "movies" ? "is-active" : ""} onClick={() => onChange("movies")}>
        Search movies
      </button>
      <button className={mode === "ask" ? "is-active" : ""} onClick={() => onChange("ask")}>
        Ask BetterBoxd
      </button>
    </div>
  );
}

function MovieSection(props: {
  title: string;
  subtitle: string;
  movies: Movie[];
  recommendationResults?: RecommendationResult[];
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
        <MovieGrid {...props} recommendationReasons={getRecommendationReasons(props.recommendationResults)} />
      ) : (
        <p className="empty">{props.empty || "No movies yet."}</p>
      )}
    </section>
  );
}

function MovieGrid(props: {
  movies: Movie[];
  recommendationReasons?: Map<number, string>;
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
            {props.recommendationReasons?.get(movie.id) && (
              <small className="recommendation-reason">{props.recommendationReasons.get(movie.id)}</small>
            )}
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

function getRecommendationReasons(results?: RecommendationResult[]) {
  if (!results) return undefined;
  return new Map(results.map((result) => [result.movie.id, result.reason]));
}

function ModeButton({
  mode,
  active,
  onChange,
}: {
  mode: RecommendationMode;
  active: RecommendationMode;
  onChange: (mode: RecommendationMode) => void;
}) {
  return (
    <button className={active === mode ? "is-active" : ""} onClick={() => onChange(mode)}>
      {mode[0].toUpperCase() + mode.slice(1)}
    </button>
  );
}

function PillList({ movies, onRemove }: { movies: Movie[]; onRemove: (movie: Movie) => void }) {
  if (!movies.length) return null;

  return (
    <div className="pill-row">
      {movies.map((movie) => (
        <button key={movie.id} onClick={() => onRemove(movie)}>
          {movie.title}
        </button>
      ))}
    </div>
  );
}

function RecommendationFeedbackPanel({
  feedback,
}: {
  feedback: ReturnType<typeof summarizeRecommendationFeedback>;
}) {
  if (!feedback.hasData) {
    return (
      <p className="empty">
        Your recommendations will adapt as you open, save, and rate movies from Discover.
      </p>
    );
  }

  return (
    <div className="feedback-panel">
      <div>
        <span>Worth checking out</span>
        <strong>{feedback.exploredCount}</strong>
      </div>
      <div>
        <span>Saved or loved</span>
        <strong>{feedback.strongCount}</strong>
      </div>
      <div>
        <span>Best fit</span>
        <strong>{feedback.bestMode ? titleCase(feedback.bestMode) : "Learning"}</strong>
      </div>
    </div>
  );
}

function AccountSettings({
  configured,
  email,
  password,
  mode,
  sessionEmail,
  syncStatus,
  guestMode,
  developerMode,
  onEmail,
  onPassword,
  onMode,
  onSubmit,
  onSignOut,
  onGuest,
  onToggleDeveloperMode,
}: {
  configured: boolean;
  email: string;
  password: string;
  mode: "signIn" | "signUp";
  sessionEmail: string;
  syncStatus: string;
  guestMode: boolean;
  developerMode: boolean;
  onEmail: (email: string) => void;
  onPassword: (password: string) => void;
  onMode: (mode: "signIn" | "signUp") => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSignOut: () => void;
  onGuest: () => void;
  onToggleDeveloperMode: (enabled: boolean) => void;
}) {
  return (
    <section className="account-settings">
      <div>
        <p className="setup-label">Account sync</p>
        <strong>{sessionEmail || (guestMode ? "Guest profile" : "Local profile")}</strong>
        <span>{configured ? syncStatus : "Add Supabase env vars to enable account sync"}</span>
      </div>

      {configured && sessionEmail ? (
        <button onClick={onSignOut}>Sign out</button>
      ) : configured ? (
        <div className="auth-stack">
          <form onSubmit={onSubmit}>
            <input
              value={email}
              onChange={(event) => onEmail(event.target.value)}
              placeholder="Email"
              type="email"
              autoComplete="email"
            />
            <input
              value={password}
              onChange={(event) => onPassword(event.target.value)}
              placeholder="Password"
              type="password"
              autoComplete={mode === "signIn" ? "current-password" : "new-password"}
            />
            <div className="auth-actions">
              <button type="submit">{mode === "signIn" ? "Sign in" : "Create account"}</button>
              <button type="button" onClick={() => onMode(mode === "signIn" ? "signUp" : "signIn")}>
                {mode === "signIn" ? "New account" : "Use existing"}
              </button>
            </div>
          </form>
          {!guestMode && (
            <button className="guest-button" onClick={onGuest}>
              Continue as guest
            </button>
          )}
        </div>
      ) : null}

      <label className="developer-toggle">
        <span>
          <strong>Developer mode</strong>
          <small>Show recommender and semantic-search diagnostics on movie cards.</small>
        </span>
        <input
          type="checkbox"
          checked={developerMode}
          onChange={(event) => onToggleDeveloperMode(event.target.checked)}
        />
      </label>
    </section>
  );
}

function titleCase(value: string) {
  return value[0].toUpperCase() + value.slice(1);
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
