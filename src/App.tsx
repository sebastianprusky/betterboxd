import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccountHub, SocialProfile } from "./components/AccountHub";
import { fallbackMovies, genreIds } from "./data/fallbackMovies";
import { getTopTasteLabel, recommendMovies, type RecommendationResult } from "./services/recommendations";
import {
  getCurrentSession,
  hasGuestMergeReceipt,
  isSupabaseConfigured,
  loadCloudState,
  recordGuestMergeReceipt,
  saveCloudState,
  signOut,
  subscribeToAuth,
  type AuthSession,
} from "./services/supabase";
import { createMergeKey, mergeGuestAndAccountState } from "./services/accountState";
import {
  askBetterBoxd,
  getMovieDetails,
  getRecommendationCatalog,
  getTasteSprintMovies,
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
  UserProfile,
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
const movieCacheKey = "betterboxd-movie-cache";
const developerModeKey = "betterboxd-developer-mode";
const stateMetadataKey = "betterboxd-state-metadata";
const guestMergeKeyKey = "betterboxd-guest-merge-key";
const sprintRefillThreshold = 6;

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
  const [accountProfile, setAccountProfile] = useState<UserProfile | null | undefined>(undefined);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [mergeNotice, setMergeNotice] = useState("");
  const [syncStatus, setSyncStatus] = useState("Saved on this device");
  const [fieldUpdatedAt, setFieldUpdatedAt] = useState<Record<string, number>>(() =>
    readJson<{ fieldUpdatedAt?: Record<string, number> }>(stateMetadataKey, {}).fieldUpdatedAt || {}
  );
  const [stateUpdatedAt, setStateUpdatedAt] = useState(() =>
    readJson<{ stateUpdatedAt?: number }>(stateMetadataKey, {}).stateUpdatedAt || Date.now()
  );
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
  const [sprintQueue, setSprintQueue] = useState<Movie[]>([]);
  const [sprintIndex, setSprintIndex] = useState(0);
  const [sprintLoading, setSprintLoading] = useState(false);
  const [sprintCatalogExhausted, setSprintCatalogExhausted] = useState(false);
  const [sprintRefillError, setSprintRefillError] = useState("");
  const [detailMovie, setDetailMovie] = useState<Movie | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [favoriteMovieQuery, setFavoriteMovieQuery] = useState("");
  const [favoriteMovieResults, setFavoriteMovieResults] = useState<Movie[]>(fallbackMovies.slice(0, 5));
  const [directorInput, setDirectorInput] = useState("");
  const loggedImpressionGroups = useRef(new Set<string>());
  const cloudLoadedForUser = useRef<string | null>(null);
  const skipNextCloudSave = useRef(false);
  const activeStateRef = useRef<CloudUserState | null>(null);
  const guestSnapshotRef = useRef<CloudUserState | null>(null);
  const sessionRef = useRef<AuthSession | null>(null);
  const mergeKeyRef = useRef(readJson<string>(guestMergeKeyKey, "") || createMergeKey());
  const handleProfileChange = useCallback((profile: UserProfile | null) => setAccountProfile(profile), []);
  const sprintPageRef = useRef(1);
  const sprintLoadingRef = useRef(false);
  const sprintQueueRef = useRef<Movie[]>([]);
  const decidedSprintIdsRef = useRef(new Set(Object.keys(interest).map(Number)));

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
    localStorage.setItem(movieCacheKey, JSON.stringify(trimMovieCache(catalogMovies)));
  }, [catalogMovies]);

  useEffect(() => {
    localStorage.setItem(developerModeKey, JSON.stringify(developerMode));
  }, [developerMode]);

  useEffect(() => {
    localStorage.setItem(stateMetadataKey, JSON.stringify({ fieldUpdatedAt, stateUpdatedAt }));
  }, [fieldUpdatedAt, stateUpdatedAt]);

  useEffect(() => {
    localStorage.setItem(guestMergeKeyKey, JSON.stringify(mergeKeyRef.current));
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setSyncStatus("Saved on this device");
      return;
    }

    getCurrentSession()
      .then((currentSession) => {
        sessionRef.current = currentSession;
        setSession(currentSession);
      })
      .catch((error) => setSyncStatus(error.message));

    return subscribeToAuth((nextSession) => {
      if (nextSession && !sessionRef.current && activeStateRef.current) {
        guestSnapshotRef.current = activeStateRef.current;
      }
      if (nextSession && nextSession.user.id !== sessionRef.current?.user.id) setAccountProfile(undefined);
      sessionRef.current = nextSession;
      setSession(nextSession);
      if (!nextSession) {
        cloudLoadedForUser.current = null;
        setAccountProfile(null);
        setSyncStatus("Saved on this device");
      }
    });
  }, []);

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
  const sprintMovie = sprintQueue[sprintIndex % Math.max(sprintQueue.length, 1)];
  const sprintSeedMovies = useMemo(
    () => (recommendations.length ? recommendations : movies).filter((movie) => !interest[movie.id] && !ratings[movie.id]),
    [recommendations, movies, interest, ratings]
  );
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
      version: 2,
      ratings,
      watchlist,
      watched,
      interest,
      reviews,
      preferences,
      recommendationEvents: recommendationEvents.slice(-300),
      fieldUpdatedAt,
      stateUpdatedAt,
    }),
    [ratings, watchlist, watched, interest, reviews, preferences, recommendationEvents, fieldUpdatedAt, stateUpdatedAt]
  );

  activeStateRef.current = cloudState;
  if (!guestSnapshotRef.current) guestSnapshotRef.current = cloudState;

  useEffect(() => {
    const userId = session?.user.id;
    if (!userId || !accountProfile || cloudLoadedForUser.current === userId) return;
    let cancelled = false;

    async function loadAndMergeAccount() {
      setSyncStatus("Loading account data");
      try {
        const accountState = await loadCloudState(userId as string);
        const mergeKey = mergeKeyRef.current;
        const alreadyMerged = await hasGuestMergeReceipt(userId as string, mergeKey);
        const guestState = guestSnapshotRef.current || cloudState;
        const nextState = alreadyMerged
          ? accountState || guestState
          : mergeGuestAndAccountState(accountState, guestState);

        if (!alreadyMerged || !accountState) {
          await saveCloudState(userId as string, nextState);
        }
        if (!alreadyMerged) {
          await recordGuestMergeReceipt(userId as string, mergeKey);
        }
        if (cancelled) return;
        skipNextCloudSave.current = true;
        applyCloudState(nextState);
        cloudLoadedForUser.current = userId as string;
        setSyncStatus("Synced to account");
        if (!alreadyMerged) {
          setMergeNotice("Your activity was merged and synced.");
          window.setTimeout(() => setMergeNotice(""), 5000);
        }
      } catch (error) {
        if (!cancelled) setSyncStatus(error instanceof Error ? error.message : "Could not load account data");
      }
    }

    loadAndMergeAccount();
    return () => { cancelled = true; };
  }, [session, accountProfile]);

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

  function applyCloudState(state: CloudUserState) {
    setRatings(state.ratings || {});
    setWatchlist(state.watchlist || {});
    setWatched(state.watched || {});
    setInterest(state.interest || {});
    setReviews(state.reviews || {});
    setPreferences(state.preferences || defaultPreferences);
    setRecommendationEvents(state.recommendationEvents || []);
    setFieldUpdatedAt(state.fieldUpdatedAt || {});
    setStateUpdatedAt(state.stateUpdatedAt || Date.now());
  }

  function touchFields(...keys: string[]) {
    const now = Date.now();
    setFieldUpdatedAt((current) => ({ ...current, ...Object.fromEntries(keys.map((key) => [key, now])) }));
    setStateUpdatedAt(now);
  }

  useEffect(() => {
    decidedSprintIdsRef.current = new Set(Object.keys(interest).map(Number));
    setSprintQueue((current) => {
      const seen = new Set<number>();
      const next = [...current, ...sprintSeedMovies].filter((movie) => {
        if (seen.has(movie.id) || decidedSprintIdsRef.current.has(movie.id) || ratings[movie.id]) return false;
        seen.add(movie.id);
        return true;
      });
      sprintQueueRef.current = next;
      return next;
    });
  }, [interest, ratings, sprintSeedMovies]);

  useEffect(() => {
    setSprintIndex((index) => (sprintQueue.length ? index % sprintQueue.length : 0));
    if (sprintQueue.length <= sprintRefillThreshold && !sprintCatalogExhausted && !sprintRefillError) {
      void refillTasteSprint();
    }
  }, [sprintQueue.length, sprintCatalogExhausted, sprintRefillError]);

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
    logRecommendationOutcome(movie, rating >= 4 ? "highRating" : "rating");
    touchFields(`rating:${movie.id}`, `watched:${movie.id}`, `watchlist:${movie.id}`);
    setRatings((current) => ({ ...current, [movie.id]: rating }));
    markWatchedState(movie);
  }

  function markWatched(movie: Movie) {
    touchFields(`watched:${movie.id}`, `watchlist:${movie.id}`);
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
    touchFields(`rating:${movie.id}`, `review:${movie.id}`);
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
    touchFields(`watched:${movie.id}`);
    removeRating(movie);
    setWatched((current) => {
      const next = { ...current };
      delete next[movie.id];
      return next;
    });
  }

  function toggleWatchlist(movie: Movie) {
    touchFields(`watchlist:${movie.id}`);
    if (!watchlist[movie.id]) logRecommendationOutcome(movie, "watchlist");
    setWatchlist((current) => {
      const next = { ...current };
      if (next[movie.id]) delete next[movie.id];
      else next[movie.id] = movie;
      return next;
    });
  }

  function setMovieInterest(movie: Movie, value: InterestValue) {
    decidedSprintIdsRef.current.add(movie.id);
    touchFields(`interest:${movie.id}`);
    setInterest((current) => ({
      ...current,
      [movie.id]: { movie, value, updatedAt: Date.now() },
    }));
    setSprintQueue((current) => {
      const next = current.filter((candidate) => candidate.id !== movie.id);
      sprintQueueRef.current = next;
      setSprintIndex((index) => (next.length ? index % next.length : 0));
      return next;
    });
  }

  function removeFromWatchlist(movie: Movie) {
    touchFields(`watchlist:${movie.id}`);
    setWatchlist((current) => {
      const next = { ...current };
      delete next[movie.id];
      return next;
    });
  }

  function togglePreferenceGenre(genre: string) {
    touchFields("preferences");
    setPreferences((current) => ({
      ...current,
      genres: current.genres.includes(genre)
        ? current.genres.filter((currentGenre) => currentGenre !== genre)
        : [...current.genres, genre],
    }));
  }

  function addFavoriteMovie(movie: Movie) {
    touchFields("preferences");
    setPreferences((current) => ({
      ...current,
      favoriteMovies: { ...current.favoriteMovies, [movie.id]: movie },
    }));
    setFavoriteMovieQuery("");
  }

  function removeFavoriteMovie(movie: Movie) {
    touchFields("preferences");
    setPreferences((current) => {
      const next = { ...current.favoriteMovies };
      delete next[movie.id];
      return { ...current, favoriteMovies: next };
    });
  }

  function addDirector() {
    const director = directorInput.trim();
    if (!director) return;
    touchFields("preferences");
    setPreferences((current) => ({
      ...current,
      directors: current.directors.some((currentDirector) => currentDirector.toLowerCase() === director.toLowerCase())
        ? current.directors
        : [...current.directors, director],
    }));
    setDirectorInput("");
  }

  function removeDirector(director: string) {
    touchFields("preferences");
    setPreferences((current) => ({
      ...current,
      directors: current.directors.filter((currentDirector) => currentDirector !== director),
    }));
  }

  function updateReview(movie: Movie, review: string) {
    touchFields(`review:${movie.id}`);
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

  function rankSprintCandidates(candidates: Movie[]) {
    const candidateIds = new Set(candidates.map((movie) => movie.id));
    const ranked = recommendMovies({
      movies: mergeMovieLists(allKnownMovies, candidates),
      ratings,
      watchlist,
      interest,
      preferences,
      mode: recommendationMode,
    })
      .map((result) => result.movie)
      .filter((movie) => candidateIds.has(movie.id));

    return mergeMovieLists(ranked, candidates);
  }

  async function refillTasteSprint() {
    if (sprintLoadingRef.current || sprintCatalogExhausted) return;
    if (!hasTmdbKey()) {
      setSprintCatalogExhausted(true);
      return;
    }

    sprintLoadingRef.current = true;
    setSprintLoading(true);

    try {
      let addedFreshMovies = false;
      let hasMore = true;
      let attempts = 0;

      while (!addedFreshMovies && hasMore && attempts < 5) {
        const page = sprintPageRef.current;
        const result = await getTasteSprintMovies(page);
        sprintPageRef.current = page + 1;
        hasMore = result.hasMore;
        attempts += 1;
        rememberMovies(result.movies);

        const activeIds = new Set(sprintQueueRef.current.map((movie) => movie.id));
        const additions = rankSprintCandidates(result.movies).filter(
          (movie) => !activeIds.has(movie.id) && !decidedSprintIdsRef.current.has(movie.id) && !ratings[movie.id]
        );

        if (additions.length) {
          const next = [...sprintQueueRef.current, ...additions];
          sprintQueueRef.current = next;
          setSprintQueue(next);
          addedFreshMovies = true;
        }
      }

      setSprintCatalogExhausted(!hasMore);
      setSprintRefillError(!addedFreshMovies && hasMore ? "Fresh titles were not available in this batch." : "");
    } catch {
      setSprintRefillError("Could not load more movies.");
    } finally {
      sprintLoadingRef.current = false;
      setSprintLoading(false);
    }
  }

  function retryTasteSprintRefill() {
    setSprintRefillError("");
    void refillTasteSprint();
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

  async function handleSignOut() {
    setSyncStatus("Signing out");
    try {
      await signOut();
      sessionRef.current = null;
      setSession(null);
      setAccountProfile(null);
      cloudLoadedForUser.current = null;
      guestSnapshotRef.current = activeStateRef.current;
      mergeKeyRef.current = createMergeKey();
      localStorage.setItem(guestMergeKeyKey, JSON.stringify(mergeKeyRef.current));
      setSyncStatus("Saved on this device");
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
            {navButton("profile", "Friends")}
          </nav>
          <div className="topbar-actions">
            <button className="theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
              {theme === "light" ? "Dark" : "Light"}
            </button>
            <AccountHub
              configured={isSupabaseConfigured}
              session={session}
              profile={accountProfile}
              syncStatus={syncStatus}
              mergeNotice={mergeNotice}
              developerMode={developerMode}
              settingsOpen={accountSettingsOpen}
              onSettingsOpenChange={setAccountSettingsOpen}
              onProfileChange={handleProfileChange}
              onOpenProfile={() => setTab("profile")}
              onSignOut={handleSignOut}
              onToggleDeveloperMode={setDeveloperMode}
            />
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
                {sprintMovie ? (
                  <div className="sprint-layout" data-testid="taste-sprint-active">
                    <div className="poster-stage">
                      <button className="poster-arrow left" onClick={previousSprint} aria-label="Previous movie" disabled={sprintQueue.length <= 1}>
                        <span aria-hidden="true">&lt;</span>
                      </button>
                      <Poster movie={sprintMovie} large overlayTitle onOpen={openMovie} />
                      <button className="poster-arrow right" onClick={nextSprint} aria-label="Next movie" disabled={sprintQueue.length <= 1}>
                        <span aria-hidden="true">&gt;</span>
                      </button>
                    </div>
                    <div className="sprint-copy">
                      <p data-testid="taste-sprint-metadata">{sprintMovie.year} · {sprintMovie.genres.slice(0, 2).join(", ") || "Movie"}</p>
                      <div className="interest-actions" aria-label="Taste Sprint response">
                        <button
                          data-testid="taste-not-interested"
                          className={interest[sprintMovie.id]?.value === "notInterested" ? "is-active" : ""}
                          onClick={() => setMovieInterest(sprintMovie, "notInterested")}
                        >
                          Not interested
                        </button>
                        <button
                          data-testid="taste-maybe"
                          className={interest[sprintMovie.id]?.value === "maybe" ? "is-active" : ""}
                          onClick={() => setMovieInterest(sprintMovie, "maybe")}
                        >
                          Maybe
                        </button>
                        <button
                          data-testid="taste-interested"
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
                      {sprintLoading && <p className="sprint-refill-status" aria-live="polite">Finding more movies…</p>}
                      {sprintRefillError && (
                        <div className="sprint-refill-status" role="status">
                          <span>{sprintRefillError}</span>
                          <button onClick={retryTasteSprintRefill}>Try again</button>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="sprint-empty" data-testid="taste-sprint-empty" role="status">
                    {sprintLoading ? (
                      <p>Finding another movie…</p>
                    ) : sprintRefillError ? (
                      <>
                        <p>{sprintRefillError}</p>
                        <button onClick={retryTasteSprintRefill}>Try again</button>
                      </>
                    ) : (
                      <p>You’re all caught up. More movies will appear when the catalog has fresh titles.</p>
                    )}
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
            <SocialProfile
              session={session}
              profile={accountProfile || null}
              onOpenSettings={() => setAccountSettingsOpen(true)}
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
                  <p className="kicker">Taste profile</p>
                  <h2>Taste preferences</h2>
                </div>
              </div>

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
        {navButton("profile", "Friends")}
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
