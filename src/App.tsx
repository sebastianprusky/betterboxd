import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { AccountHub } from "./components/AccountHub";
import { fallbackMovies } from "./data/fallbackMovies";
import { emptyCloudState, createMergeKey, mergeGuestAndAccountState } from "./services/accountState";
import { parseMovieCsv, resolveMovieCsvRows, selectCsvMatch, type CsvImportRow } from "./services/csvImport";
import { explainCollaborativeCandidates, loadCollaborativeModel, scoreCollaborativeCandidates, type CollaborativeModel } from "./services/collaborative";
import { analyzeReview } from "./services/reviewInsights";
import { recommendMovies, type RecommendationResult } from "./services/recommendations";
import { buildSimilarityMap } from "./services/similarityMap";
import {
  discoverPickMovies,
  getMovieDetails,
  getMovieWatchProviders,
  getRecommendationCatalog,
  getStreamingProviders,
  getTasteSprintMovies,
  getTrendingMovies,
  hasTmdbKey,
  posterUrl,
  askPickAMovie,
  searchMovies,
} from "./services/tmdb";
import {
  getCurrentSession,
  hasGuestMergeReceipt,
  isSupabaseConfigured,
  loadCloudState,
  deleteCloudState,
  recordGuestMergeReceipt,
  saveCloudState,
  signOut,
  subscribeToAuth,
  type AuthSession,
} from "./services/supabase";
import type {
  CloudUserState,
  InterestMap,
  InterestValue,
  LearningEvent,
  LibraryFilter,
  Movie,
  OnboardingPreferences,
  PickFilters,
  PickIntentEvent,
  RatingMap,
  ReviewInsightMap,
  ReviewMap,
  StreamingAvailability,
  StreamingProvider,
  Tab,
  Theme,
  WatchedMap,
  WatchlistMap,
} from "./types";

const storage = {
  ratings: "pickamovie-ratings",
  preferences: "pickamovie-onboarding-preferences",
  watchlist: "pickamovie-watchlist",
  watched: "pickamovie-watched",
  interest: "pickamovie-interest",
  reviews: "pickamovie-reviews",
  reviewInsights: "pickamovie-review-insights",
  reviewConsent: "pickamovie-review-consent",
  reviewConsentAsked: "pickamovie-review-consent-asked",
  pickIntents: "pickamovie-pick-intents",
  learningEvents: "pickamovie-learning-events",
  tasteDecisions: "pickamovie-taste-decisions",
  theme: "pickamovie-theme",
  tour: "pickamovie-tour-v1",
  stateMeta: "pickamovie-state-metadata",
  mergeKey: "pickamovie-guest-merge-key",
  cache: "pickamovie-movie-cache",
  developer: "pickamovie-developer-mode",
};

const legacy: Partial<Record<keyof typeof storage, string[]>> = {
  ratings: ["betterboxd-ratings", "cinecircle-ratings"],
  preferences: ["betterboxd-onboarding-preferences"],
  watchlist: ["betterboxd-watchlist", "cinecircle-watchlist"],
  watched: ["betterboxd-watched"],
  interest: ["betterboxd-interest"],
  reviews: ["betterboxd-reviews"],
  theme: ["betterboxd-theme", "cinecircle-theme"],
  cache: ["betterboxd-movie-cache"],
  developer: ["betterboxd-developer-mode"],
  stateMeta: ["betterboxd-state-metadata"],
  mergeKey: ["betterboxd-guest-merge-key"],
};

const defaultPreferences: OnboardingPreferences = { genres: [], directors: [], actors: [], favoriteMovies: {} };
const defaultFilters = (): PickFilters => ({
  mood: "", runtime: "", genre: "", era: "", providerIds: [],
  region: (navigator.language.split("-")[1] || "US").toUpperCase(),
});
const filterOptions = {
  mood: [["", "Any mood"], ["cozy", "Cozy"], ["tense", "Tense"], ["thoughtful", "Thoughtful"], ["funny", "Funny"], ["strange", "Strange"]],
  runtime: [["", "Any runtime"], ["short", "Under 100 min"], ["standard", "80–130 min"], ["long", "Over 2 hours"]],
  genre: [["", "Any genre"], ["Comedy", "Comedy"], ["Drama", "Drama"], ["Thriller", "Thriller"], ["Horror", "Horror"], ["Romance", "Romance"], ["Sci-Fi", "Sci-Fi"], ["Animation", "Animation"]],
  era: [["", "Any era"], ["recent", "2020s"], ["2010s", "2010s"], ["2000s", "2000s"], ["classic", "Before 2000"]],
} as const;
const ratingChoices = Array.from({ length: 10 }, (_, index) => (index + 1) / 2);

function readJson<T>(key: string, fallback: T, oldKeys: string[] = []): T {
  try {
    const raw = [key, ...oldKeys].map((candidate) => localStorage.getItem(candidate)).find((value) => value !== null);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch { return fallback; }
}

function writeJson(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* local persistence is best effort */ }
}

function mergeMovies(...lists: Movie[][]) {
  const map = new Map<number, Movie>();
  lists.flat().forEach((movie) => map.set(movie.id, { ...(map.get(movie.id) || {}), ...movie }));
  return [...map.values()];
}

function uid(prefix: string) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
function shortRuntime(movie: Movie) { return movie.runtime ? `${movie.runtime} min` : "Runtime unknown"; }
function formatRating(rating: number) { return Number.isInteger(rating) ? `${rating}` : rating.toFixed(1); }

function Icon({ name }: { name: "search" | "bookmark" | "eye" | "x" | "spark" | "plus" | "upload" | "chevron" }) {
  const paths = {
    search: <><circle cx="10.7" cy="10.7" r="6.2"/><path d="m15.2 15.2 4.3 4.3"/></>,
    bookmark: <path d="M7 4.5h10v15l-5-3-5 3z"/>, eye: <><path d="M2.5 12s3.2-5 9.5-5 9.5 5 9.5 5-3.2 5-9.5 5-9.5-5-9.5-5Z"/><circle cx="12" cy="12" r="2.5"/></>,
    x: <><path d="m7 7 10 10M17 7 7 17"/></>, spark: <path d="m12 2 1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7L12 2Z"/>,
    plus: <><path d="M12 5v14M5 12h14"/></>, upload: <><path d="M12 15V3m0 0L7.5 7.5M12 3l4.5 4.5"/><path d="M5 14v5h14v-5"/></>, chevron: <path d="m8 10 4 4 4-4"/>,
  };
  return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

export default function App() {
  const [tab, setTab] = useState<Tab>("pick");
  const [theme, setTheme] = useState<Theme>(() => readJson(storage.theme, "light", legacy.theme));
  const [ratings, setRatings] = useState<RatingMap>(() => readJson(storage.ratings, {}, legacy.ratings));
  const [watchlist, setWatchlist] = useState<WatchlistMap>(() => readJson(storage.watchlist, {}, legacy.watchlist));
  const [watched, setWatched] = useState<WatchedMap>(() => readJson(storage.watched, {}, legacy.watched));
  const [interest, setInterest] = useState<InterestMap>(() => readJson(storage.interest, {}, legacy.interest));
  const [reviews, setReviews] = useState<ReviewMap>(() => readJson(storage.reviews, {}, legacy.reviews));
  const [reviewInsights, setReviewInsights] = useState<ReviewInsightMap>(() => readJson(storage.reviewInsights, {}));
  const [reviewConsent, setReviewConsent] = useState(() => readJson(storage.reviewConsent, false));
  const [reviewConsentAsked, setReviewConsentAsked] = useState(() => readJson(storage.reviewConsentAsked, false));
  const [preferences, setPreferences] = useState<OnboardingPreferences>(() => {
    const saved = readJson<Partial<OnboardingPreferences>>(storage.preferences, defaultPreferences, legacy.preferences);
    return { ...defaultPreferences, ...saved, actors: saved.actors || [] };
  });
  const [pickIntents, setPickIntents] = useState<PickIntentEvent[]>(() => readJson(storage.pickIntents, []));
  const [learningEvents, setLearningEvents] = useState<LearningEvent[]>(() => readJson(storage.learningEvents, []));
  const [tasteDecisions, setTasteDecisions] = useState(() => readJson(storage.tasteDecisions, 0));
  const [catalog, setCatalog] = useState<Movie[]>(() => readJson(storage.cache, fallbackMovies, legacy.cache));
  const [candidateMovies, setCandidateMovies] = useState<Movie[]>(fallbackMovies);
  const [collaborativeModel, setCollaborativeModel] = useState<CollaborativeModel | null>(null);
  const [filters, setFilters] = useState<PickFilters>(defaultFilters);
  const [prompt, setPrompt] = useState("");
  const [promptExplanation, setPromptExplanation] = useState("");
  const [pickLoading, setPickLoading] = useState(true);
  const [pickError, setPickError] = useState("");
  const [visiblePickIds, setVisiblePickIds] = useState<number[]>([]);
  const [selectedPick, setSelectedPick] = useState<RecommendationResult | null>(null);
  const [expandedReason, setExpandedReason] = useState<number | null>(null);
  const [providers, setProviders] = useState<StreamingProvider[]>([]);
  const [providerOpen, setProviderOpen] = useState(false);
  const [availability, setAvailability] = useState<Record<number, StreamingAvailability>>({});
  const [ratingPromptMovie, setRatingPromptMovie] = useState<Movie | null>(null);
  const [sprintQueue, setSprintQueue] = useState<Movie[]>([]);
  const [sprintLoading, setSprintLoading] = useState(false);
  const [sprintError, setSprintError] = useState("");
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>("all");
  const [libraryQuery, setLibraryQuery] = useState("");
  const [detailMovie, setDetailMovie] = useState<Movie | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addQuery, setAddQuery] = useState("");
  const [addResults, setAddResults] = useState<Movie[]>([]);
  const [importRows, setImportRows] = useState<CsvImportRow[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importResolving, setImportResolving] = useState(false);
  const [reviewConsentPrompt, setReviewConsentPrompt] = useState<Movie | null>(null);
  const [reviewAnalysisStatus, setReviewAnalysisStatus] = useState<Record<number, string>>({});
  const [tourOpen, setTourOpen] = useState(() => !readJson(storage.tour, false));
  const [tourSlide, setTourSlide] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [developerMode, setDeveloperMode] = useState(() => readJson(storage.developer, false, legacy.developer));
  const [session, setSession] = useState<AuthSession | null>(null);
  const [syncStatus, setSyncStatus] = useState("Saved on this device");
  const [fieldUpdatedAt, setFieldUpdatedAt] = useState<Record<string, number>>(() => readJson<{ fieldUpdatedAt?: Record<string, number> }>(storage.stateMeta, {}, legacy.stateMeta).fieldUpdatedAt || {});
  const [stateUpdatedAt, setStateUpdatedAt] = useState(Date.now());
  const cloudLoaded = useRef<string | null>(null);
  const skipCloudSave = useRef(false);
  const sessionRef = useRef<AuthSession | null>(null);
  const activeState = useRef<CloudUserState>(emptyCloudState);
  const guestSnapshot = useRef<CloudUserState | null>(null);
  const mergeKey = useRef(readJson<string>(storage.mergeKey, "", legacy.mergeKey) || createMergeKey());
  const sprintPage = useRef(1);
  const sprintBusy = useRef(false);

  useEffect(() => { document.documentElement.dataset.theme = theme; writeJson(storage.theme, theme); }, [theme]);
  useEffect(() => { window.scrollTo({ top: 0, behavior: "smooth" }); }, [tab]);
  useEffect(() => writeJson(storage.ratings, ratings), [ratings]);
  useEffect(() => writeJson(storage.watchlist, watchlist), [watchlist]);
  useEffect(() => writeJson(storage.watched, watched), [watched]);
  useEffect(() => writeJson(storage.interest, interest), [interest]);
  useEffect(() => writeJson(storage.reviews, reviews), [reviews]);
  useEffect(() => writeJson(storage.reviewInsights, reviewInsights), [reviewInsights]);
  useEffect(() => writeJson(storage.reviewConsent, reviewConsent), [reviewConsent]);
  useEffect(() => writeJson(storage.reviewConsentAsked, reviewConsentAsked), [reviewConsentAsked]);
  useEffect(() => writeJson(storage.preferences, preferences), [preferences]);
  useEffect(() => writeJson(storage.pickIntents, pickIntents.slice(-100)), [pickIntents]);
  useEffect(() => writeJson(storage.learningEvents, learningEvents.slice(-100)), [learningEvents]);
  useEffect(() => writeJson(storage.tasteDecisions, tasteDecisions), [tasteDecisions]);
  useEffect(() => writeJson(storage.cache, catalog.slice(-260)), [catalog]);
  useEffect(() => writeJson(storage.developer, developerMode), [developerMode]);
  useEffect(() => writeJson(storage.stateMeta, { fieldUpdatedAt, stateUpdatedAt }), [fieldUpdatedAt, stateUpdatedAt]);
  useEffect(() => writeJson(storage.mergeKey, mergeKey.current), []);

  const rememberMovies = useCallback((movies: Movie[]) => {
    if (movies.length) setCatalog((current) => mergeMovies(current, movies).slice(-260));
  }, []);

  useEffect(() => {
    Promise.allSettled([getTrendingMovies(), getRecommendationCatalog()]).then((results) => {
      const movies = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
      if (movies.length) { rememberMovies(movies); setCandidateMovies(movies); }
      setPickLoading(false);
    });
  }, [rememberMovies]);
  useEffect(() => {
    if (collaborativeModel || Object.keys(ratings).length === 0) return;
    let cancelled = false;
    loadCollaborativeModel().then((model) => { if (!cancelled) setCollaborativeModel(model); });
    return () => { cancelled = true; };
  }, [collaborativeModel, ratings]);

  useEffect(() => {
    getStreamingProviders(filters.region).then(setProviders).catch(() => setProviders([]));
  }, [filters.region]);

  useEffect(() => {
    let cancelled = false;
    setPickLoading(true);
    setPickError("");
    setPromptExplanation("");
    setVisiblePickIds([]);
    const timeout = window.setTimeout(async () => {
      try {
        const discovered = await discoverPickMovies(filters);
        let movies = discovered;
        if (prompt.trim().length >= 3) {
          const askResult = await askPickAMovie(prompt.trim());
          const prompted = askResult.movies;
          const allowed = new Set(discovered.map((movie) => movie.id));
          const constrained = prompted.filter((movie) => !hasActiveStructuredFilters(filters) || allowed.has(movie.id));
          movies = constrained;
          setPromptExplanation(askResult.explanation);
        }
        if (cancelled) return;
        setCandidateMovies(movies);
        rememberMovies(movies);
      } catch {
        if (!cancelled) { setPickError("Recommendations are using saved movie data."); setCandidateMovies(catalog.length ? catalog : fallbackMovies); }
      } finally { if (!cancelled) setPickLoading(false); }
    }, 320);
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, [filters, prompt, rememberMovies]);

  const allMovies = useMemo(() => mergeMovies(
    fallbackMovies, catalog, candidateMovies, Object.values(watchlist), Object.values(watched).map((entry) => entry.movie),
    Object.values(interest).map((entry) => entry.movie), Object.values(preferences.favoriteMovies), detailMovie ? [detailMovie] : [],
  ), [catalog, candidateMovies, watchlist, watched, interest, preferences.favoriteMovies, detailMovie]);

  const collaborativeScores = useMemo(() => scoreCollaborativeCandidates(collaborativeModel, ratings, candidateMovies), [collaborativeModel, ratings, candidateMovies]);
  const collaborativeEvidence = useMemo(() => explainCollaborativeCandidates(collaborativeModel, ratings, allMovies), [collaborativeModel, ratings, allMovies]);
  const ranked = useMemo(() => recommendMovies({
    movies: candidateMovies,
    ratings, watchlist, watched, interest, preferences, pickIntents, reviewInsights, collaborativeScores, collaborativeEvidence, mode: "balanced", limit: 30,
  }), [candidateMovies, allMovies, ratings, watchlist, watched, interest, preferences, pickIntents, reviewInsights, collaborativeScores, collaborativeEvidence]);

  useEffect(() => {
    const targets = ranked.slice(0, filters.providerIds.length ? 15 : 6).map((result) => result.movie);
    if (!targets.length) return;
    let cancelled = false;
    Promise.all(targets.map((movie) => getMovieWatchProviders(movie.id, filters.region).catch(() => ({ movieId: movie.id, region: filters.region, providers: [], checkedAt: Date.now(), status: "unavailable" as const }))))
      .then((items) => { if (!cancelled) setAvailability((current) => ({ ...current, ...Object.fromEntries(items.map((item) => [item.movieId, item])) })); });
    return () => { cancelled = true; };
  }, [ranked.map((result) => result.movie.id).join(","), filters.providerIds.join(","), filters.region]);

  const eligibleRanked = useMemo(() => {
    const filtered = filters.providerIds.length
      ? ranked.filter((result) => availability[result.movie.id]?.region === filters.region && availability[result.movie.id]?.status !== "unavailable" && availability[result.movie.id]?.providers.some((provider) => filters.providerIds.includes(provider.id)))
      : ranked;
    const saved = filtered.filter((result) => watchlist[result.movie.id]);
    const discovery = filtered.filter((result) => !watchlist[result.movie.id]);
    if (!saved.length) return discovery;
    const insertion = Math.min(2, discovery.length);
    return [...discovery.slice(0, insertion), saved[0], ...discovery.slice(insertion)];
  }, [ranked, availability, filters.providerIds, watchlist]);

  useEffect(() => {
    const eligible = new Set(eligibleRanked.map((result) => result.movie.id));
    setVisiblePickIds((current) => {
      const retained = current.filter((id) => eligible.has(id));
      const next = eligibleRanked.map((result) => result.movie.id).filter((id) => !retained.includes(id)).slice(0, 3 - retained.length);
      return [...retained, ...next];
    });
  }, [eligibleRanked.map((result) => result.movie.id).join(",")]);

  const visibleResults = useMemo(() => visiblePickIds.map((id) => eligibleRanked.find((result) => result.movie.id === id)).filter(Boolean) as RecommendationResult[], [visiblePickIds, eligibleRanked]);
  const streamingChecksPending = filters.providerIds.length > 0 && ranked.slice(0, 15).some((result) => availability[result.movie.id]?.region !== filters.region);
  const tasteRanked = useMemo(() => recommendMovies({
    movies: allMovies, ratings, watchlist, watched, interest, preferences, pickIntents, reviewInsights, collaborativeScores, collaborativeEvidence,
    mode: "balanced", limit: 60,
  }), [allMovies, ratings, watchlist, watched, interest, preferences, pickIntents, reviewInsights, collaborativeScores, collaborativeEvidence]);
  const activeLearningSeeds = useMemo(() => rankForActiveLearning(tasteRanked, preferences), [tasteRanked, preferences]);

  const cloudState = useMemo<CloudUserState>(() => ({
    version: 3, ratings, watchlist, watched, interest, reviews, reviewInsights, reviewAnalysisConsent: reviewConsent,
    preferences, recommendationEvents: [], pickIntents: pickIntents.slice(-100), learningEvents: learningEvents.slice(-100),
    tasteSprintDecisions: tasteDecisions, fieldUpdatedAt, stateUpdatedAt,
  }), [ratings, watchlist, watched, interest, reviews, reviewInsights, reviewConsent, preferences, pickIntents, learningEvents, tasteDecisions, fieldUpdatedAt, stateUpdatedAt]);
  activeState.current = cloudState;
  if (!guestSnapshot.current) guestSnapshot.current = cloudState;

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    getCurrentSession().then((value) => { sessionRef.current = value; setSession(value); }).catch(() => setSyncStatus("Saved on this device"));
    return subscribeToAuth((next) => {
      if (next && !sessionRef.current) guestSnapshot.current = activeState.current;
      sessionRef.current = next; setSession(next);
      if (!next) { cloudLoaded.current = null; setSyncStatus("Saved on this device"); }
    });
  }, []);

  useEffect(() => {
    const userId = session?.user.id;
    if (!userId || cloudLoaded.current === userId) return;
    let cancelled = false;
    setSyncStatus("Loading private data");
    (async () => {
      try {
        const account = await loadCloudState(userId);
        const mergedBefore = await hasGuestMergeReceipt(userId, mergeKey.current);
        const next = mergedBefore ? account || activeState.current : mergeGuestAndAccountState(account, guestSnapshot.current || activeState.current);
        if (!mergedBefore || !account) await saveCloudState(userId, next);
        if (!mergedBefore) await recordGuestMergeReceipt(userId, mergeKey.current);
        if (cancelled) return;
        skipCloudSave.current = true; applyState(next); cloudLoaded.current = userId; setSyncStatus("Synced privately");
      } catch { if (!cancelled) setSyncStatus("Could not sync; saved on this device"); }
    })();
    return () => { cancelled = true; };
  }, [session?.user.id]);

  useEffect(() => {
    const userId = session?.user.id;
    if (!userId || cloudLoaded.current !== userId) return;
    if (skipCloudSave.current) { skipCloudSave.current = false; return; }
    setSyncStatus("Saving");
    const timeout = window.setTimeout(() => saveCloudState(userId, cloudState).then(() => setSyncStatus("Synced privately")).catch(() => setSyncStatus("Could not sync; saved on this device")), 700);
    return () => window.clearTimeout(timeout);
  }, [cloudState, session?.user.id]);

  function applyState(state: CloudUserState) {
    setRatings(state.ratings || {}); setWatchlist(state.watchlist || {}); setWatched(state.watched || {}); setInterest(state.interest || {});
    setReviews(state.reviews || {}); setReviewInsights(state.reviewInsights || {}); setReviewConsent(state.reviewAnalysisConsent || false);
    setPreferences({ ...defaultPreferences, ...(state.preferences || {}) }); setPickIntents(state.pickIntents || []); setLearningEvents(state.learningEvents || []);
    setTasteDecisions(state.tasteSprintDecisions || 0); setFieldUpdatedAt(state.fieldUpdatedAt || {}); setStateUpdatedAt(state.stateUpdatedAt || Date.now());
  }

  function touch(...keys: string[]) {
    const now = Date.now(); setFieldUpdatedAt((current) => ({ ...current, ...Object.fromEntries(keys.map((key) => [key, now])) })); setStateUpdatedAt(now);
  }

  function learn(type: LearningEvent["type"], movie: Movie, label: string, undoKey?: string, source?: LearningEvent["source"]) {
    setLearningEvents((current) => [...current, { id: uid("learn"), type, movie, label, createdAt: Date.now(), undoKey, source }].slice(-100));
  }

  function replacePick(movieId: number) {
    setVisiblePickIds((current) => {
      const index = current.indexOf(movieId);
      if (index < 0) return current;
      const used = new Set(current);
      const replacement = eligibleRanked.find((result) => result.movie.id !== movieId && !used.has(result.movie.id));
      if (!replacement) return current.filter((id) => id !== movieId);
      const next = [...current];
      next[index] = replacement.movie.id;
      return next;
    });
  }

  function markWatched(movie: Movie, fromSprint = false) {
    if (watched[movie.id]) return;
    const wasSaved = Boolean(watchlist[movie.id]);
    touch(`watched:${movie.id}`, `watchlist:${movie.id}`);
    setWatched((current) => ({ ...current, [movie.id]: { movie, watchedAt: Date.now() } }));
    setWatchlist((current) => { const next = { ...current }; delete next[movie.id]; return next; });
    learn("watched", movie, "Marked watched", `watched:${movie.id}:${wasSaved ? "saved" : "unsaved"}`, fromSprint ? "sprint" : "pick");
    setRatingPromptMovie(movie); replacePick(movie.id);
    if (fromSprint) advanceSprint(movie, true);
  }

  function rateMovie(movie: Movie, rating: number | null) {
    touch(`rating:${movie.id}`, `watched:${movie.id}`);
    if (rating === null) {
      setRatings((current) => { const next = { ...current }; delete next[movie.id]; return next; });
      setLearningEvents((current) => current.filter((event) => !(event.type === "rating" && event.movie.id === movie.id)));
      return;
    }
    setRatings((current) => ({ ...current, [movie.id]: rating }));
    setWatched((current) => ({ ...current, [movie.id]: current[movie.id] || { movie, watchedAt: Date.now() } }));
    learn("rating", movie, `Rated ${formatRating(rating)} out of 5`, `rating:${movie.id}`); setRatingPromptMovie(null);
  }

  function saveMovie(movie: Movie, replace = true) {
    if (watchlist[movie.id]) return;
    touch(`watchlist:${movie.id}`); setWatchlist((current) => ({ ...current, [movie.id]: movie }));
    learn("watchlist", movie, "Saved to watchlist", `watchlist:${movie.id}`); if (replace) replacePick(movie.id);
  }

  function rejectMovie(movie: Movie, fromSprint = false) {
    touch(`interest:${movie.id}`); setInterest((current) => ({ ...current, [movie.id]: { movie, value: "notInterested", updatedAt: Date.now() } }));
    learn("interest", movie, "Not for me", `interest:${movie.id}`, fromSprint ? "sprint" : "pick"); replacePick(movie.id);
    if (fromSprint) advanceSprint(movie, true);
  }

  function chooseMovie(result: RecommendationResult) {
    const movie = result.movie;
    const event = { id: uid("pick"), movie, createdAt: Date.now() };
    const learningEvent: LearningEvent = { id: uid("learn"), type: "pick", movie, label: "Picked for tonight", createdAt: Date.now(), undoKey: `pick:${event.id}`, source: "pick" };
    setPickIntents((current) => [...current.filter((item) => item.movie.id !== movie.id), event].slice(-100));
    setLearningEvents((current) => [...current.filter((item) => !(item.type === "pick" && item.movie.id === movie.id)), learningEvent].slice(-100));
    setSelectedPick(result);
  }

  function showMore() {
    const current = new Set(visiblePickIds); const lastVisibleId = visiblePickIds[visiblePickIds.length - 1];
    const start = Math.max(0, eligibleRanked.findIndex((result) => result.movie.id === lastVisibleId) + 1);
    const next = [...eligibleRanked.slice(start), ...eligibleRanked.slice(0, start)].map((result) => result.movie.id).filter((id) => !current.has(id)).slice(0, 3);
    setVisiblePickIds(next);
  }

  useEffect(() => {
    const decided = new Set([...Object.keys(interest), ...Object.keys(watched), ...Object.keys(ratings)].map(Number));
    setSprintQueue((current) => mergeMovies(current, activeLearningSeeds).filter((movie) => !decided.has(movie.id)));
  }, [interest, watched, ratings, activeLearningSeeds]);

  useEffect(() => { if (sprintQueue.length < 7 && !sprintBusy.current) void refillSprint(); }, [sprintQueue.length]);

  async function refillSprint() {
    if (sprintBusy.current) return;
    if (!hasTmdbKey()) { setSprintError("More movies need a TMDB connection."); return; }
    sprintBusy.current = true; setSprintLoading(true); setSprintError("");
    try {
      const decided = new Set([...Object.keys(interest), ...Object.keys(watched), ...Object.keys(ratings)].map(Number));
      for (let attempts = 0; attempts < 4; attempts += 1) {
        const result = await getTasteSprintMovies(sprintPage.current++); rememberMovies(result.movies);
        const rankedBatch = rankForActiveLearning(recommendMovies({
          movies: mergeMovies(allMovies, result.movies), ratings, watchlist, watched, interest, preferences, pickIntents, reviewInsights,
          mode: "balanced", limit: result.movies.length,
        }), preferences);
        const batchIds = new Set(result.movies.map((movie) => movie.id));
        const additions = rankedBatch.filter((movie) => batchIds.has(movie.id) && !decided.has(movie.id) && !sprintQueue.some((item) => item.id === movie.id));
        if (additions.length) { setSprintQueue((current) => mergeMovies(current, additions)); break; }
        if (!result.hasMore) break;
      }
    } catch { setSprintError("Could not load more movies."); }
    finally { sprintBusy.current = false; setSprintLoading(false); }
  }

  function advanceSprint(movie: Movie, count = true) {
    setSprintQueue((current) => current.filter((item) => item.id !== movie.id)); if (count) setTasteDecisions((value) => value + 1);
  }

  function answerSprint(movie: Movie, value: InterestValue) {
    touch(`interest:${movie.id}`); setInterest((current) => ({ ...current, [movie.id]: { movie, value, updatedAt: Date.now() } }));
    learn("interest", movie, value === "interested" ? "Interested" : value === "maybe" ? "Maybe" : "Not for me", `interest:${movie.id}`, "sprint");
    advanceSprint(movie);
  }

  function undoLearning(event: LearningEvent) {
    const [kind, id, previous] = (event.undoKey || "").split(":");
    if (kind === "interest") setInterest((current) => { const next = { ...current }; delete next[id]; return next; });
    if (kind === "watchlist") setWatchlist((current) => { const next = { ...current }; delete next[id]; return next; });
    if (kind === "watched") {
      setWatched((current) => { const next = { ...current }; delete next[id]; return next; });
      if (previous === "saved") setWatchlist((current) => ({ ...current, [id]: event.movie }));
    }
    if (kind === "rating") setRatings((current) => { const next = { ...current }; delete next[id]; return next; });
    if (kind === "pick") setPickIntents((current) => current.filter((item) => item.id !== id));
    if (event.source === "sprint" && (kind === "interest" || kind === "watched")) {
      setSprintQueue((current) => mergeMovies([event.movie], current));
      setTasteDecisions((value) => Math.max(0, value - 1));
    }
    setLearningEvents((current) => current.filter((item) => item.id !== event.id));
  }

  async function openMovie(movie: Movie) {
    setDetailMovie(movie); setDetailLoading(true);
    try { const detail = await getMovieDetails(movie); setDetailMovie(detail); rememberMovies([detail]); }
    finally { setDetailLoading(false); }
  }

  function updateReview(movie: Movie, review: string) {
    touch(`review:${movie.id}`); setReviews((current) => ({ ...current, [movie.id]: review }));
    if (review.trim().length >= 8) {
      if (reviewConsent) void runReviewAnalysis(movie, review);
      else if (!reviewConsentAsked) setReviewConsentPrompt(movie);
      else setReviewAnalysisStatus((current) => ({ ...current, [movie.id]: "Review saved without analysis." }));
    }
  }

  async function runReviewAnalysis(movie: Movie, review = reviews[movie.id] || "") {
    setReviewAnalysisStatus((current) => ({ ...current, [movie.id]: "Analyzing review…" }));
    try {
      const aspects = await analyzeReview(movie.title, review);
      setReviewInsights((current) => ({ ...current, [movie.id]: aspects }));
      setReviewAnalysisStatus((current) => ({ ...current, [movie.id]: aspects.length ? `Added ${aspects.length} editable taste signals.` : "Review saved; no clear taste signals found." }));
      if (aspects.length) learn("reviewAspect", movie, `Learned ${aspects.length} review signals`, undefined, "review");
    } catch { setReviewAnalysisStatus((current) => ({ ...current, [movie.id]: "Review saved. Taste analysis is unavailable right now." })); }
  }

  function removeAspect(movieId: number, aspectId: string) {
    setReviewInsights((current) => ({ ...current, [movieId]: (current[movieId] || []).filter((aspect) => aspect.id !== aspectId) }));
  }

  function removeFromWatchlist(movie: Movie) {
    touch(`watchlist:${movie.id}`);
    setWatchlist((current) => { const next = { ...current }; delete next[movie.id]; return next; });
    setLearningEvents((current) => current.filter((event) => !(event.type === "watchlist" && event.movie.id === movie.id)));
  }

  function restoreMovie(movie: Movie) {
    touch(`interest:${movie.id}`);
    setInterest((current) => { const next = { ...current }; delete next[movie.id]; return next; });
    setLearningEvents((current) => current.filter((event) => !(event.type === "interest" && event.movie.id === movie.id)));
  }

  function updateAspect(movieId: number, aspectId: string, label: string, sentiment: "positive" | "negative") {
    setReviewInsights((current) => ({ ...current, [movieId]: (current[movieId] || []).map((aspect) => aspect.id === aspectId ? { ...aspect, label: label.slice(0, 60), sentiment } : aspect) }));
    touch(`review-insight:${movieId}`);
  }

  useEffect(() => {
    if (!addOpen || addQuery.trim().length < 2) { setAddResults([]); return; }
    const timeout = window.setTimeout(() => searchMovies(addQuery).then((movies) => { setAddResults(movies); rememberMovies(movies); }), 240);
    return () => window.clearTimeout(timeout);
  }, [addOpen, addQuery, rememberMovies]);

  async function handleCsv(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    event.target.value = "";
    const parsed = parseMovieCsv(await file.text(), allMovies);
    setImportRows(parsed.map((row) => row.matchedMovie ? row : { ...row, status: "searching" }));
    setImportOpen(true);
    setImportResolving(true);
    const resolved = await resolveMovieCsvRows(parsed, searchMovies);
    setImportRows(resolved);
    rememberMovies(resolved.flatMap((row) => row.candidates || []));
    setImportResolving(false);
  }

  function resolveImportRow(rowNumber: number, movieId: number) {
    setImportRows((current) => current.map((row) => row.row === rowNumber ? selectCsvMatch(row, row.candidates?.find((movie) => movie.id === movieId)) : row));
  }

  function confirmImport() {
    const touched = ["csv-import"];
    importRows.forEach((row) => {
      if (!row.matchedMovie) return;
      if (row.watched || row.rating) { setWatched((current) => ({ ...current, [row.matchedMovie!.id]: current[row.matchedMovie!.id] || { movie: row.matchedMovie!, watchedAt: Date.now() } })); touched.push(`watched:${row.matchedMovie.id}`); }
      if (row.rating) { setRatings((current) => ({ ...current, [row.matchedMovie!.id]: row.rating! })); touched.push(`rating:${row.matchedMovie.id}`); }
      if (row.review) { setReviews((current) => ({ ...current, [row.matchedMovie!.id]: row.review! })); touched.push(`review:${row.matchedMovie.id}`); }
    });
    touch(...touched); setImportOpen(false);
  }

  function applyPreference(kind: "genres" | "directors" | "actors", value: string) {
    const clean = value.trim(); if (!clean) return;
    setPreferences((current) => ({ ...current, [kind]: current[kind].includes(clean) ? current[kind].filter((item) => item !== clean) : [...current[kind], clean] }));
    touch("preferences");
  }

  function applyFavorite(movie: Movie) {
    setPreferences((current) => {
      const next = { ...current.favoriteMovies };
      if (next[movie.id]) delete next[movie.id]; else next[movie.id] = movie;
      return { ...current, favoriteMovies: next };
    });
    rememberMovies([movie]);
    touch("preferences");
  }

  async function handleSignOut() { await signOut(); setSession(null); cloudLoaded.current = null; setSyncStatus("Saved on this device"); }
  async function handleDeleteCloudData() {
    if (!session) return;
    await deleteCloudState(session.user.id);
    cloudLoaded.current = null;
    clearLocalData();
  }
  function clearLocalData() { Object.values(storage).forEach((key) => localStorage.removeItem(key)); window.location.reload(); }
  function closeTour() { setTourOpen(false); writeJson(storage.tour, true); }

  const libraryMovies = useMemo(() => {
    const items = mergeMovies(Object.values(watchlist), Object.values(watched).map((entry) => entry.movie), allMovies.filter((movie) => ratings[movie.id] || interest[movie.id]?.value === "notInterested"));
    return items.filter((movie) => {
      if (libraryFilter === "watched" && !watched[movie.id]) return false;
      if (libraryFilter === "watchlist" && !watchlist[movie.id]) return false;
      if (libraryFilter === "rated" && !ratings[movie.id]) return false;
      if (libraryFilter === "rejected" && interest[movie.id]?.value !== "notInterested") return false;
      return !libraryQuery.trim() || `${movie.title} ${movie.year}`.toLowerCase().includes(libraryQuery.toLowerCase());
    }).sort((a, b) => (watched[b.id]?.watchedAt || 0) - (watched[a.id]?.watchedAt || 0));
  }, [allMovies, watchlist, watched, ratings, interest, libraryFilter, libraryQuery]);

  const tasteSignals = useMemo(() => buildTasteSignals(allMovies, ratings, interest, preferences, reviewInsights), [allMovies, ratings, interest, preferences, reviewInsights]);
  const similarityPoints = useMemo(() => buildSimilarityMap(tasteRanked.map((result) => result.movie), 24), [tasteRanked]);
  const sprintMovie = sprintQueue[0];

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="site-header">
      <button className="wordmark" onClick={() => setTab("pick")}>PickAMovie</button>
      <nav className="desktop-nav" aria-label="Primary">{(["pick", "taste", "library"] as Tab[]).map((item) => <button key={item} className={tab === item ? "is-active" : ""} onClick={() => setTab(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</nav>
      <AccountHub configured={isSupabaseConfigured} session={session} open={settingsOpen} theme={theme} syncStatus={syncStatus} developerMode={developerMode} reviewConsent={reviewConsent} state={cloudState} onOpenChange={setSettingsOpen} onThemeChange={setTheme} onDeveloperModeChange={setDeveloperMode} onReviewConsentChange={(enabled) => { setReviewConsent(enabled); setReviewConsentAsked(true); }} onReplayTour={() => { setTourSlide(0); setTourOpen(true); }} onSignOut={handleSignOut} onDeleteCloudData={handleDeleteCloudData} onClearLocalData={clearLocalData} />
    </header>

    <main id="main-content">
      {tab === "pick" && <PickView
        prompt={prompt} promptExplanation={promptExplanation} setPrompt={setPrompt} filters={filters} setFilters={setFilters} providers={providers} providerOpen={providerOpen} setProviderOpen={setProviderOpen} streamingConfigured={hasTmdbKey()}
        results={visibleResults} loading={pickLoading || streamingChecksPending} error={pickError}
        availability={availability} expandedReason={expandedReason} setExpandedReason={setExpandedReason} watched={watched} watchlist={watchlist}
        onWatched={markWatched} onSave={saveMovie} onPick={chooseMovie} onReject={rejectMovie} onShowMore={showMore} onClearStreaming={() => setFilters((current) => ({ ...current, providerIds: [] }))} developerMode={developerMode}
      />}
      {tab === "taste" && <TasteView movie={sprintMovie} loading={sprintLoading} error={sprintError} decisions={tasteDecisions} watchlist={watchlist} signals={tasteSignals} events={learningEvents}
        preferences={preferences} similarityPoints={similarityPoints} onAnswer={answerSprint} onWatched={(movie) => markWatched(movie, true)} onSave={(movie) => saveMovie(movie, false)} onRetry={refillSprint} onUndo={undoLearning} onPreference={applyPreference} onFavorite={applyFavorite} />}
      {tab === "library" && <LibraryView movies={libraryMovies} filter={libraryFilter} setFilter={setLibraryFilter} query={libraryQuery} setQuery={setLibraryQuery} ratings={ratings} watched={watched} watchlist={watchlist} interest={interest}
        onOpen={openMovie} onAdd={() => setAddOpen(true)} onCsv={handleCsv} />}
    </main>

    <nav className="mobile-nav" aria-label="Primary">{(["pick", "taste", "library"] as Tab[]).map((item) => <button key={item} className={tab === item ? "is-active" : ""} onClick={() => setTab(item)}><span className="mobile-nav-dot" />{item[0].toUpperCase() + item.slice(1)}</button>)}</nav>

    {selectedPick && <SelectedPick result={selectedPick} availability={availability[selectedPick.movie.id]} onBack={() => setSelectedPick(null)} onWatched={() => { markWatched(selectedPick.movie); setSelectedPick(null); }} />}
    {ratingPromptMovie && <RatingPrompt movie={ratingPromptMovie} onRate={(value) => rateMovie(ratingPromptMovie, value)} onDismiss={() => setRatingPromptMovie(null)} />}
    {detailMovie && <MovieDetail movie={detailMovie} loading={detailLoading} rating={ratings[detailMovie.id]} watched={Boolean(watched[detailMovie.id])} saved={Boolean(watchlist[detailMovie.id])} rejected={interest[detailMovie.id]?.value === "notInterested"} review={reviews[detailMovie.id] || ""} aspects={reviewInsights[detailMovie.id] || []} reviewStatus={reviewAnalysisStatus[detailMovie.id] || ""}
      onClose={() => setDetailMovie(null)} onRate={(value) => rateMovie(detailMovie, value)} onWatched={() => markWatched(detailMovie)} onSave={() => watchlist[detailMovie.id] ? removeFromWatchlist(detailMovie) : saveMovie(detailMovie, false)} onRestore={() => restoreMovie(detailMovie)} onReview={(value) => updateReview(detailMovie, value)} onUpdateAspect={(id, label, sentiment) => updateAspect(detailMovie.id, id, label, sentiment)} onRemoveAspect={(id) => removeAspect(detailMovie.id, id)} />}
    {addOpen && <AddMovieDialog query={addQuery} setQuery={setAddQuery} results={addResults} onClose={() => setAddOpen(false)} onWatched={(movie) => { markWatched(movie); setAddOpen(false); }} onSave={(movie) => { saveMovie(movie, false); setAddOpen(false); }} />}
    {importOpen && <ImportDialog rows={importRows} resolving={importResolving} onResolve={resolveImportRow} onClose={() => setImportOpen(false)} onConfirm={confirmImport} />}
    {reviewConsentPrompt && <ConsentDialog onDecline={() => { setReviewConsentAsked(true); setReviewAnalysisStatus((current) => ({ ...current, [reviewConsentPrompt.id]: "Review saved without analysis." })); setReviewConsentPrompt(null); }} onAccept={() => { setReviewConsent(true); setReviewConsentAsked(true); void runReviewAnalysis(reviewConsentPrompt); setReviewConsentPrompt(null); }} />}
    {tourOpen && <OnboardingTour slide={tourSlide} setSlide={setTourSlide} onClose={closeTour} />}
  </div>;
}

function hasActiveStructuredFilters(filters: PickFilters) { return Boolean(filters.mood || filters.runtime || filters.genre || filters.era || filters.providerIds.length); }

function PickView(props: {
  prompt: string; promptExplanation: string; setPrompt: (value: string) => void; filters: PickFilters; setFilters: (updater: (current: PickFilters) => PickFilters) => void;
  providers: StreamingProvider[]; providerOpen: boolean; setProviderOpen: (value: boolean) => void; results: RecommendationResult[]; loading: boolean; error: string;
  availability: Record<number, StreamingAvailability>; expandedReason: number | null; setExpandedReason: (id: number | null) => void; watched: WatchedMap; watchlist: WatchlistMap;
  onWatched: (movie: Movie) => void; onSave: (movie: Movie) => void; onPick: (result: RecommendationResult) => void; onReject: (movie: Movie) => void; onShowMore: () => void; onClearStreaming: () => void; developerMode: boolean; streamingConfigured: boolean;
}) {
  const update = (key: keyof PickFilters, value: string) => props.setFilters((current) => ({ ...current, [key]: value }));
  return <section className="pick-page page-enter">
    <div className="pick-controls">
      <label className="prompt-field"><Icon name="search" /><span className="sr-only">Describe what you want to watch</span><input value={props.prompt} onChange={(event) => props.setPrompt(event.target.value)} placeholder="What sounds good tonight?" /></label>
      <div className="filter-row" aria-label="Recommendation filters">
        {(["mood", "runtime", "genre", "era"] as const).map((key) => <label className="select-filter" key={key}><span>{key[0].toUpperCase() + key.slice(1)}</span><select value={props.filters[key]} onChange={(event) => update(key, event.target.value)}>{filterOptions[key].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><Icon name="chevron" /></label>)}
        <div className="provider-filter"><button className={props.filters.providerIds.length ? "filter-button is-active" : "filter-button"} disabled={!props.streamingConfigured} title={props.streamingConfigured ? undefined : "Streaming availability is not configured"} aria-expanded={props.providerOpen} onClick={() => props.setProviderOpen(!props.providerOpen)}>Streaming{props.filters.providerIds.length ? ` · ${props.filters.providerIds.length}` : ""}<Icon name="chevron" /></button>
          {props.providerOpen && <div className="provider-popover"><label>Country<select value={props.filters.region} onChange={(event) => props.setFilters((current) => ({ ...current, region: event.target.value, providerIds: [] }))}><option value="US">United States</option><option value="CA">Canada</option><option value="GB">United Kingdom</option><option value="AU">Australia</option></select></label>{props.providers.length ? <div className="provider-options">{props.providers.slice(0, 12).map((provider) => <label key={provider.id}><input type="checkbox" checked={props.filters.providerIds.includes(provider.id)} onChange={() => props.setFilters((current) => ({ ...current, providerIds: current.providerIds.includes(provider.id) ? current.providerIds.filter((id) => id !== provider.id) : [...current.providerIds, provider.id] }))} />{provider.name}</label>)}</div> : <p className="provider-empty">Providers are unavailable for this country right now.</p>}<small>Subscription catalogs · TMDB availability data powered by JustWatch</small></div>}
        </div>
      </div>
      {props.prompt.trim().length >= 3 && props.promptExplanation && !props.loading && <p className="prompt-explanation">{props.promptExplanation}</p>}
    </div>
    {props.error && <p className="quiet-notice">{props.error}</p>}
    <div className="pick-stage" aria-live="polite">
      {props.loading ? <>{[1, 2, 3].map((rank) => <div className={`pick-card skeleton-card rank-${rank}`} key={rank}><div className="poster-skeleton"/><div className="line-skeleton"/><div className="button-skeleton"/></div>)}</> : props.results.map((result, index) => <RecommendationCard key={result.movie.id} result={result} rank={index + 1} availability={props.availability[result.movie.id]} expanded={props.expandedReason === result.movie.id} onExpand={() => props.setExpandedReason(props.expandedReason === result.movie.id ? null : result.movie.id)} onWatched={() => props.onWatched(result.movie)} onSave={() => props.onSave(result.movie)} onPick={() => props.onPick(result)} onReject={() => props.onReject(result.movie)} saved={Boolean(props.watchlist[result.movie.id])} developerMode={props.developerMode} />)}
    </div>
    {!props.loading && props.results.length === 0 && <div className="empty-state"><h2>{props.filters.providerIds.length ? "No verified matches" : "No matches found"}</h2><p>{props.prompt.trim() ? "Try a broader request or clear a filter." : "Try clearing a filter to widen the choices."}</p>{props.filters.providerIds.length > 0 && <button className="secondary-button" onClick={props.onClearStreaming}>Clear streaming filter</button>}</div>}
    {props.results.length > 0 && <button className="show-more" onClick={props.onShowMore}>Show 3 more</button>}
  </section>;
}

function RecommendationCard({ result, rank, availability, expanded, saved, onExpand, onWatched, onSave, onPick, onReject, developerMode }: { result: RecommendationResult; rank: number; availability?: StreamingAvailability; expanded: boolean; saved: boolean; onExpand: () => void; onWatched: () => void; onSave: () => void; onPick: () => void; onReject: () => void; developerMode: boolean }) {
  const provider = availability?.providers[0];
  return <article className={`pick-card rank-${rank}`}>
    <div className="rank-label"><span>{rank}</span></div>
    <img className="pick-poster" src={posterUrl(result.movie.posterPath, rank === 1 ? "w500" : "w342")} alt={`Poster for ${result.movie.title}`} />
    <div className="pick-copy"><h2>{result.movie.title}</h2><div className="movie-meta"><span>{result.movie.year}</span><span>{shortRuntime(result.movie)}</span>{provider && <span className="provider-badge">{provider.name}</span>}</div><button className="reason-line" onClick={onExpand}>{result.reason}<Icon name="chevron" /></button>
      {expanded && <div className="signal-panel">{result.signals.map((signal) => <div className="signal-row" key={signal.label}><div><strong>{signal.label}</strong><span>{signal.detail}</span></div><div className="signal-track"><i style={{ width: `${Math.max(8, signal.value * 100)}%` }} /></div></div>)}<small className="signal-note">Relative contributors, not probabilities.</small>{developerMode && <code>score {result.score.toFixed(3)}</code>}</div>}
    </div>
    <div className="pick-actions"><button className="secondary-button" onClick={onWatched}><Icon name="eye"/>Watched</button><button className="secondary-button" onClick={onSave} disabled={saved}><Icon name="bookmark"/>{saved ? "Saved" : "Save"}</button><button className="primary-button pick-this" onClick={onPick}>Pick this</button><button className="text-action" onClick={onReject}>Not for me</button></div>
  </article>;
}

function TasteView(props: { movie?: Movie; loading: boolean; error: string; decisions: number; watchlist: WatchlistMap; signals: Array<{ label: string; weight: number; evidence: number }>; events: LearningEvent[]; preferences: OnboardingPreferences; similarityPoints: ReturnType<typeof buildSimilarityMap>; onAnswer: (movie: Movie, value: InterestValue) => void; onWatched: (movie: Movie) => void; onSave: (movie: Movie) => void; onRetry: () => void; onUndo: (event: LearningEvent) => void; onPreference: (kind: "genres" | "directors" | "actors", value: string) => void; onFavorite: (movie: Movie) => void }) {
  const [preferenceDraft, setPreferenceDraft] = useState({ genres: "", directors: "", actors: "" });
  const [favoriteQuery, setFavoriteQuery] = useState("");
  const [favoriteResults, setFavoriteResults] = useState<Movie[]>([]);
  useEffect(() => {
    if (favoriteQuery.trim().length < 2) { setFavoriteResults([]); return; }
    let cancelled = false;
    const timeout = window.setTimeout(() => searchMovies(favoriteQuery).then((movies) => { if (!cancelled) setFavoriteResults(movies.slice(0, 5)); }).catch(() => { if (!cancelled) setFavoriteResults([]); }), 260);
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, [favoriteQuery]);
  return <section className="taste-page page-enter">
    <div className="sprint-section"><div className="section-title-row"><h1>Taste Sprint</h1>{props.decisions < 10 && <div className="sprint-progress" aria-label={`${props.decisions} of 10 onboarding choices`}>{Array.from({ length: 10 }, (_, index) => <i key={index} className={index < props.decisions ? "is-filled" : ""} />)}</div>}</div>
      {props.movie ? <div className="sprint-stage"><img src={posterUrl(props.movie.posterPath, "w500")} alt={`Poster for ${props.movie.title}`} /><div className="sprint-response"><h2>{props.movie.title}</h2><p>{props.movie.year} · {props.movie.genres.slice(0, 2).join(" · ")}</p><button onClick={() => props.onAnswer(props.movie!, "interested")}>Interested</button><button onClick={() => props.onAnswer(props.movie!, "maybe")}>Maybe</button><button onClick={() => props.onAnswer(props.movie!, "notInterested")}>Not for me</button><div className="sprint-secondary"><button onClick={() => props.onWatched(props.movie!)}><Icon name="eye"/>Watched</button><button onClick={() => props.onSave(props.movie!)} disabled={Boolean(props.watchlist[props.movie.id])}><Icon name="bookmark"/>{props.watchlist[props.movie.id] ? "Saved" : "Save"}</button></div></div></div> : <div className="empty-state"><h2>{props.loading ? "Finding another movie…" : "You reached the end of this batch"}</h2>{props.error && <p>{props.error}</p>}{!props.loading && <button className="secondary-button" onClick={props.onRetry}>Load more</button>}</div>}
    </div>
    <div className="taste-lab"><div className="taste-summary"><h2>Your taste</h2>{props.signals.length ? <div className="taste-signals" aria-label="Current taste signals">{props.signals.slice(0, 6).map((signal) => <div className="taste-signal" key={signal.label}><span><strong>{signal.label}</strong><small>{signal.evidence} {signal.evidence === 1 ? "signal" : "signals"}</small></span><i><b style={{ width: `${Math.max(8, signal.weight * 100)}%` }}/></i></div>)}</div> : <p className="empty-copy">Ratings, reactions, and preferences will build your taste summary.</p>}
      <details className="preference-editor"><summary>Edit preferences</summary>{(["genres", "directors", "actors"] as const).map((kind) => <div className="preference-row" key={kind}><label>{kind[0].toUpperCase() + kind.slice(1)}<span><input value={preferenceDraft[kind]} onChange={(event) => setPreferenceDraft((current) => ({ ...current, [kind]: event.target.value }))} /><button onClick={() => { props.onPreference(kind, preferenceDraft[kind]); setPreferenceDraft((current) => ({ ...current, [kind]: "" })); }}>Add</button></span></label><div className="preference-tags">{props.preferences[kind].map((value) => <button key={value} onClick={() => props.onPreference(kind, value)}>{value} ×</button>)}</div></div>)}<div className="preference-row favorite-preference"><label>Favorite movies<span><input value={favoriteQuery} onChange={(event) => setFavoriteQuery(event.target.value)} placeholder="Search titles" /></span></label>{favoriteResults.length > 0 && <div className="favorite-results">{favoriteResults.map((movie) => <button key={movie.id} onClick={() => { props.onFavorite(movie); setFavoriteQuery(""); }}>{movie.title} <small>{movie.year}</small></button>)}</div>}<div className="preference-tags">{Object.values(props.preferences.favoriteMovies).map((movie) => <button key={movie.id} onClick={() => props.onFavorite(movie)}>{movie.title} ×</button>)}</div></div></details>
      <details className="movie-map"><summary>See movie map</summary><p>Nearby movies share genres, people, keywords, and descriptions.</p><div className="map-field">{props.similarityPoints.map((point) => <button key={point.movie.id} title={point.movie.title} style={{ left: `${point.x}%`, top: `${point.y}%` }} className="map-dot"><span>{point.movie.title}</span></button>)}</div><small>Local metadata similarity · not audience behavior</small></details></div>
      <div className="learning-log"><h2>Recently learned</h2>{props.events.slice(-6).reverse().map((event) => <div className="learning-row" key={event.id}><img src={posterUrl(event.movie.posterPath, "w92")} alt=""/><span><strong>{event.movie.title}</strong><small>{event.label}</small></span>{event.undoKey && <button onClick={() => props.onUndo(event)}>Undo</button>}</div>)}{!props.events.length && <p className="empty-copy">Your reactions will appear here.</p>}</div>
    </div>
  </section>;
}

function LibraryView(props: { movies: Movie[]; filter: LibraryFilter; setFilter: (filter: LibraryFilter) => void; query: string; setQuery: (value: string) => void; ratings: RatingMap; watched: WatchedMap; watchlist: WatchlistMap; interest: InterestMap; onOpen: (movie: Movie) => void; onAdd: () => void; onCsv: (event: ChangeEvent<HTMLInputElement>) => void }) {
  const labels: Array<[LibraryFilter, string]> = [["all", "All"], ["watched", "Watched"], ["watchlist", "Watchlist"], ["rated", "Rated"], ["rejected", "Rejected"]];
  return <section className="library-page page-enter"><div className="library-heading"><div><h1>Library</h1><div className="library-tabs">{labels.map(([value, label]) => <button key={value} className={props.filter === value ? "is-active" : ""} onClick={() => props.setFilter(value)}>{label}</button>)}</div></div><div className="library-tools"><label className="library-search"><Icon name="search"/><input value={props.query} onChange={(event) => props.setQuery(event.target.value)} placeholder="Search your movies"/></label><button className="secondary-button" onClick={props.onAdd}><Icon name="plus"/>Add</button><label className="secondary-button file-button"><Icon name="upload"/>Import<input type="file" accept=".csv,text/csv" onChange={props.onCsv}/></label></div></div>
    {props.movies.length ? <div className="library-grid">{props.movies.map((movie) => <button className="library-card" key={movie.id} onClick={() => props.onOpen(movie)}><img src={posterUrl(movie.posterPath, "w342")} alt={`Poster for ${movie.title}`}/><span><strong>{movie.title}</strong><small>{movie.year}{props.ratings[movie.id] ? ` · ${formatRating(props.ratings[movie.id])} / 5` : ""}</small><i>{props.watched[movie.id] ? "Watched" : props.watchlist[movie.id] ? "Watchlist" : props.interest[movie.id]?.value === "notInterested" ? "Not for me" : "Saved"}</i></span></button>)}</div> : <div className="empty-state"><h2>No movies here yet</h2><p>Add a movie or use Pick to start your library.</p><button className="primary-button" onClick={props.onAdd}>Add a movie</button></div>}
  </section>;
}

function SelectedPick({ result, availability, onBack, onWatched }: { result: RecommendationResult; availability?: StreamingAvailability; onBack: () => void; onWatched: () => void }) {
  const movie = result.movie;
  return <div className="selection-overlay page-enter"><button className="selection-back" onClick={onBack}>← Change my pick</button><article className="selection-card"><img src={posterUrl(movie.posterPath, "w500")} alt={`Poster for ${movie.title}`}/><div><span className="selection-label">Tonight’s pick</span><h1>{movie.title}</h1><p className="selection-meta">{movie.year} · {shortRuntime(movie)} · {movie.genres.slice(0, 3).join(" · ")}</p><p className="selection-overview">{movie.overview}</p><div className="selection-reason"><strong>Why this one</strong><p>{result.reason}</p><div>{result.signals.slice(0, 3).map((signal) => <span key={signal.label}>{signal.label}: {signal.detail}</span>)}</div><small>Relative recommendation signals, not probabilities.</small></div><div className="where-to-watch"><strong>Streaming</strong>{availability?.region && availability.status !== "unavailable" ? availability.providers.length ? <div>{availability.providers.map((provider) => <span key={provider.id}>{provider.name}</span>)}</div> : <p>No subscription providers found in {availability.region}.</p> : <p>Availability could not be verified.</p>}{availability?.link && <a href={availability.link} target="_blank" rel="noreferrer">Check availability ↗</a>}<small>TMDB availability data powered by JustWatch · availability can change</small></div><button className="primary-button" onClick={onWatched}>Mark watched</button></div></article></div>;
}

function RatingPrompt({ movie, onRate, onDismiss }: { movie: Movie; onRate: (rating: number) => void; onDismiss: () => void }) {
  return <aside className="rating-toast" aria-live="polite"><img src={posterUrl(movie.posterPath, "w92")} alt=""/><div><strong>How was {movie.title}?</strong><div className="rating-choices">{ratingChoices.map((rating) => <button key={rating} onClick={() => onRate(rating)} aria-label={`Rate ${formatRating(rating)} out of 5`}>{formatRating(rating)}</button>)}</div></div><button className="toast-close" onClick={onDismiss} aria-label="Skip rating">×</button></aside>;
}

function MovieDetail(props: { movie: Movie; loading: boolean; rating?: number; watched: boolean; saved: boolean; rejected: boolean; review: string; reviewStatus: string; aspects: ReviewInsightMap[string]; onClose: () => void; onRate: (value: number | null) => void; onWatched: () => void; onSave: () => void; onRestore: () => void; onReview: (value: string) => void; onUpdateAspect: (id: string, label: string, sentiment: "positive" | "negative") => void; onRemoveAspect: (id: string) => void }) {
  const [reviewDraft, setReviewDraft] = useState(props.review);
  return <div className="modal-backdrop" onMouseDown={props.onClose}><article className="movie-detail-sheet" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}><button className="icon-button detail-close" onClick={props.onClose}>×</button><img className="detail-poster" src={posterUrl(props.movie.posterPath, "w500")} alt={`Poster for ${props.movie.title}`}/><div className="detail-copy"><h1>{props.movie.title}</h1><p className="movie-meta">{props.movie.year} · {shortRuntime(props.movie)} · {props.movie.genres.slice(0, 3).join(" · ")}</p><p>{props.loading ? "Loading details…" : props.movie.overview}</p><div className="detail-actions"><button className="secondary-button" onClick={props.onWatched} disabled={props.watched}>{props.watched ? "Watched" : "Mark watched"}</button><button className="secondary-button" onClick={props.onSave}>{props.saved ? "Remove from watchlist" : "Save"}</button>{props.rejected && <button className="text-action" onClick={props.onRestore}>Restore to recommendations</button>}</div><label className="rating-field">Your rating<select value={props.rating || ""} onChange={(event) => props.onRate(event.target.value ? Number(event.target.value) : null)}><option value="">Not rated</option>{ratingChoices.map((value) => <option key={value} value={value}>{formatRating(value)} / 5</option>)}</select></label><label className="review-field">Private review<textarea value={reviewDraft} onChange={(event) => setReviewDraft(event.target.value)} placeholder="What worked for you?"/><button className="primary-button" onClick={() => props.onReview(reviewDraft)}>Save review</button></label>{props.reviewStatus && <p className="review-status" aria-live="polite">{props.reviewStatus}</p>}{props.aspects.length > 0 && <div className="review-aspects"><strong>What this taught your recommendations</strong>{props.aspects.map((aspect) => <div className="review-aspect" key={aspect.id}><input aria-label="Taste signal" value={aspect.label} onChange={(event) => props.onUpdateAspect(aspect.id, event.target.value, aspect.sentiment)} /><select aria-label="Signal direction" value={aspect.sentiment} onChange={(event) => props.onUpdateAspect(aspect.id, aspect.label, event.target.value as "positive" | "negative")}><option value="positive">More like this</option><option value="negative">Less like this</option></select><button aria-label={`Remove ${aspect.label}`} onClick={() => props.onRemoveAspect(aspect.id)}>×</button></div>)}</div>}</div></article></div>;
}

function AddMovieDialog({ query, setQuery, results, onClose, onWatched, onSave }: { query: string; setQuery: (value: string) => void; results: Movie[]; onClose: () => void; onWatched: (movie: Movie) => void; onSave: (movie: Movie) => void }) {
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="compact-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}><div className="sheet-heading"><h2>Add a movie</h2><button className="icon-button" onClick={onClose}>×</button></div><label className="library-search"><Icon name="search"/><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by title or person"/></label><div className="add-results">{results.map((movie) => <div key={movie.id}><img src={posterUrl(movie.posterPath, "w92")} alt=""/><span><strong>{movie.title}</strong><small>{movie.year}</small></span><button onClick={() => onWatched(movie)}>Watched</button><button onClick={() => onSave(movie)}>Save</button></div>)}</div></section></div>;
}

function ImportDialog({ rows, resolving, onResolve, onClose, onConfirm }: { rows: CsvImportRow[]; resolving: boolean; onResolve: (row: number, movieId: number) => void; onClose: () => void; onConfirm: () => void }) {
  const matched = rows.filter((row) => row.status === "matched");
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="compact-dialog import-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}><div className="sheet-heading"><h2>Review import</h2><button className="icon-button" onClick={onClose}>×</button></div><p>{resolving ? "Checking titles against TMDB…" : `${matched.length} of ${rows.length} rows are ready.`}</p>{!rows.length && <p className="inline-error">No recognizable Title column or movie rows were found.</p>}<div className="import-list">{rows.slice(0, 80).map((row) => <div key={row.row}><span><strong>{row.title}{row.year ? ` (${row.year})` : ""}</strong>{row.candidates && row.candidates.length > 1 && <select value={row.matchedMovie?.id || ""} onChange={(event) => onResolve(row.row, Number(event.target.value))}><option value="">Choose a match</option>{row.candidates.map((movie) => <option key={movie.id} value={movie.id}>{movie.title} ({movie.year})</option>)}</select>}</span><i className={`status-${row.status}`}>{row.status}</i></div>)}</div><button className="primary-button" disabled={!matched.length || resolving} onClick={onConfirm}>Import {matched.length} movies</button></section></div>;
}

function ConsentDialog({ onDecline, onAccept }: { onDecline: () => void; onAccept: () => void }) {
  return <div className="modal-backdrop"><section className="compact-dialog consent-dialog" role="dialog" aria-modal="true"><h2>Use reviews to improve your picks?</h2><p>PickAMovie can privately analyze review text into editable taste signals. Your reviews are not shared with other users or used for cross-user learning.</p><div><button className="secondary-button" onClick={onDecline}>Not now</button><button className="primary-button" onClick={onAccept}>Use my reviews</button></div></section></div>;
}

function OnboardingTour({ slide, setSlide, onClose }: { slide: number; setSlide: (slide: number) => void; onClose: () => void }) {
  const touchStart = useRef<number | null>(null);
  const slides = [
    { title: "Pick something great", caption: "Three recommendations for tonight. Add filters when you need them.", preview: <MiniPick/> },
    { title: "Shape your taste", caption: "Interested, Maybe, or Not for me. Every choice sharpens the next picks.", preview: <MiniTaste/> },
    { title: "Keep track", caption: "Save ideas, rate what you’ve watched, and keep everything together.", preview: <MiniLibrary/> },
  ];
  const current = slides[slide];
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === "ArrowRight") setSlide(Math.min(slide + 1, 2)); if (event.key === "ArrowLeft") setSlide(Math.max(slide - 1, 0)); if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener);
  }, [slide, setSlide, onClose]);
  return <div className="tour-backdrop"><section className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title" onTouchStart={(event) => { touchStart.current = event.changedTouches[0]?.clientX ?? null; }} onTouchEnd={(event) => { const start = touchStart.current; const end = event.changedTouches[0]?.clientX; touchStart.current = null; if (start === null || end === undefined || Math.abs(start - end) < 45) return; setSlide(start > end ? Math.min(2, slide + 1) : Math.max(0, slide - 1)); }}><button className="tour-skip" onClick={onClose}>Skip</button><div className="tour-preview">{current.preview}</div><div className="tour-copy"><h1 id="tour-title">{current.title}</h1><p>{current.caption}</p></div><div className="tour-controls"><button className="secondary-button" onClick={() => setSlide(Math.max(0, slide - 1))} disabled={slide === 0}>Back</button><div className="tour-dots" aria-label="Onboarding progress">{slides.map((item, index) => <button key={item.title} className={index === slide ? "is-active" : ""} onClick={() => setSlide(index)} aria-label={`Go to slide ${index + 1}`} />)}</div><button className="primary-button" onClick={() => slide === 2 ? onClose() : setSlide(slide + 1)}>{slide === 2 ? "Start picking" : "Next"}</button></div></section></div>;
}

function MiniHeader({ active }: { active: Tab }) { return <div className="mini-header"><b>PickAMovie</b>{(["pick", "taste", "library"] as Tab[]).map((item) => <i key={item} className={item === active ? "is-active" : ""}>{item}</i>)}</div>; }
function MiniPick() { const movies = [fallbackMovies[1], fallbackMovies[0], fallbackMovies[4]]; return <div className="mini-ui mini-pick"><MiniHeader active="pick"/><div className="mini-search">What sounds good tonight?</div><div className="mini-filters"><i>Mood</i><i>Runtime</i><i>Genre</i><i>Streaming</i></div><div className="mini-posters">{movies.map((movie, index) => <span className={index === 1 ? "is-main" : ""} key={movie.id}><img src={posterUrl(movie.posterPath, "w342")} alt=""/><b>{index + 1}</b><small>{movie.title}</small></span>)}</div><em className="callout callout-one">Add filters</em><em className="callout callout-two">Choose your movie</em></div>; }
function MiniTaste() { const movie = fallbackMovies[2]; return <div className="mini-ui mini-taste"><MiniHeader active="taste"/><h3>Taste Sprint</h3><div className="mini-taste-content"><img src={posterUrl(movie.posterPath, "w342")} alt=""/><div><strong>{movie.title}</strong><i>Interested</i><i>Maybe</i><i>Not for me</i></div></div><em className="callout callout-two">Every reaction shapes your taste</em></div>; }
function MiniLibrary() { return <div className="mini-ui mini-library"><MiniHeader active="library"/><h3>Library</h3><div className="mini-library-filters"><i>All</i><i>Watched</i><i>Watchlist</i><i>Rated</i></div><div className="mini-library-grid">{fallbackMovies.slice(0, 8).map((movie) => <span key={movie.id}><img src={posterUrl(movie.posterPath, "w342")} alt=""/></span>)}</div><em className="callout callout-one">Everything stays private</em></div>; }

function buildTasteSignals(movies: Movie[], ratings: RatingMap, interest: InterestMap, preferences: OnboardingPreferences, insights: ReviewInsightMap) {
  const scores = new Map<string, number>();
  const evidence = new Map<string, number>();
  const add = (label: string, weight: number) => {
    if (weight <= 0) return;
    scores.set(label, (scores.get(label) || 0) + weight);
    evidence.set(label, (evidence.get(label) || 0) + 1);
  };
  preferences.genres.forEach((value) => add(value, 2));
  preferences.directors.forEach((value) => add(value, 1.5));
  preferences.actors.forEach((value) => add(value, 1.2));
  movies.forEach((movie) => {
    const rating = ratings[movie.id]; const reaction = interest[movie.id]?.value;
    const weight = rating ? Math.max(0, rating - 2.5) : reaction === "interested" ? .8 : reaction === "maybe" ? .25 : 0;
    movie.genres.forEach((genre) => add(genre, weight));
  });
  Object.values(insights).flat().filter((aspect) => aspect.sentiment === "positive").forEach((aspect) => add(aspect.label, aspect.confidence));
  const top = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = top[0]?.[1] || 1;
  return top.map(([label, weight]) => ({ label, weight: weight / max, evidence: evidence.get(label) || 1 }));
}

function rankForActiveLearning(results: RecommendationResult[], preferences: OnboardingPreferences) {
  const knownGenres = new Set(preferences.genres.map((genre) => genre.toLowerCase()));
  return [...results].sort((a, b) => activeLearningScore(b) - activeLearningScore(a)).map((result) => result.movie);
  function activeLearningScore(result: RecommendationResult) {
    const tasteSignal = result.signals.find((signal) => signal.label === "Your taste")?.value ?? .5;
    const uncertainty = 1 - Math.min(1, Math.abs(tasteSignal - .5) * 2);
    const recognition = Math.min(1, Math.log10((result.movie.popularity || 8) + 1) / 2.4);
    const information = result.movie.genres.some((genre) => !knownGenres.has(genre.toLowerCase())) ? .8 : .35;
    return recognition * .38 + uncertainty * .4 + information * .22;
  }
}
