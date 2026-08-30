import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import { AccountHub } from "./components/AccountHub";
import { PredictionCanvas } from "./components/PredictionCanvas";
import { fallbackMovies } from "./data/fallbackMovies";
import { genreOptions } from "./data/movieGenres";
import { emptyCloudState, createMergeKey, excludeWatchedFromWatchlist, mergeGuestAndAccountState } from "./services/accountState";
import { resolveMovieCsvRows, type CsvImportRow, type ImportResolutionProgress } from "./services/csvImport";
import { mergeImportedRows, parseMovieImportFile, type MovieImportSummary } from "./services/movieImport";
import { filterAndSortLibraryMovies } from "./services/library";
import { explainCollaborativeCandidates, loadCollaborativeModel, scoreCollaborativeCandidates, type CollaborativeModel } from "./services/collaborative";
import { analyzeReview } from "./services/reviewInsights";
import { linkPickOutcome, recommendationEvent } from "./services/outcomeTracking";
import { createPickSlots, replacePickSlot, type PickSlot } from "./services/pickSession";
import { arrangeWatchlistCandidates, recommendMovies, type RecommendationResult } from "./services/recommendations";
import { buildRatingCalibration, buildTasteStrength, createRatingModelInput, predictCandidateRatings, ratingToPercent, type RatingCalibration } from "./services/ratingCalibration";
import { rankTasteSprintCandidates, type TasteSprintCandidate } from "./services/tasteSprintSelector";
import { buildTasteProfileSample } from "./services/tasteProfileSample";
import { applyMovieIntelligence, enrichMovieIntelligence, loadMovieIntelligence, MOVIE_INTELLIGENCE_VERSION, type MovieIntelligenceProgress, type MovieIntelligenceRecord } from "./services/movieIntelligence";
import { removeWatchedOutcome } from "./services/unwatch";
import {
  getMovieDetails,
  getMovieDisplayDetails,
  getMovieWatchProviders,
  getNowPlayingMovieIds,
  getRecommendationCatalog,
  getTasteSprintMovies,
  getTrendingMovies,
  hasTmdbKey,
  matchesPickFilters,
  discoverPickMovies,
  posterUrl,
  profileUrl,
  askPickAMovie,
  searchMovies,
  searchMoviesForImport,
  searchPeople,
} from "./services/tmdb";
import {
  getCurrentSession,
  hasAuthCallbackParams,
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
  LetterboxdImportMeta,
  LibraryFilter,
  LibrarySort,
  LibraryWatchedFilter,
  LikedMap,
  Movie,
  OnboardingPreferences,
  PersonSearchResult,
  PickFilters,
  PickIntentEvent,
  PromptMovieEvidence,
  RecommendationEvent,
  RatingPrediction,
  RatingMap,
  ReviewInsightMap,
  ReviewMap,
  StreamingAvailability,
  Tab,
  TasteSignal,
  TasteStrength,
  Theme,
  WatchedMap,
  WatchlistMap,
} from "./types";

const storage = {
  ratings: "pickamovie-ratings",
  likes: "pickamovie-likes",
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
  recommendationEvents: "pickamovie-recommendation-events-v1",
  tasteDecisions: "pickamovie-taste-decisions",
  theme: "pickamovie-theme",
  tour: "pickamovie-tour-v2",
  stateMeta: "pickamovie-state-metadata",
  mergeKey: "pickamovie-guest-merge-key",
  cache: "pickamovie-movie-cache",
  letterboxdImport: "pickamovie-letterboxd-import-meta",
  includeWatchlist: "pickamovie-include-watchlist-recommendations",
  ratingModel: "pickamovie-personal-rating-model-v3",
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
  stateMeta: ["betterboxd-state-metadata"],
  mergeKey: ["betterboxd-guest-merge-key"],
};
const legacyMigrationDisabledKey = "pickamovie-legacy-migration-disabled";

const defaultPreferences: OnboardingPreferences = { genres: [], directors: [], actors: [], favoriteMovies: {} };
const defaultFilters = (): PickFilters => ({
  runtimeMin: 30, runtimeMax: 300, genres: [], eras: [], providerIds: [], includeTheaters: false,
  region: "US", includeWatchlist: readJson(storage.includeWatchlist, true),
});
const eraOptions = [["recent", "2020s"], ["2010s", "2010s"], ["2000s", "2000s"], ["1990s", "1990s"], ["1980s", "1980s"], ["1970s", "1970s"], ["1960s", "1960s"], ["pre1960", "Before 1960"]] as const;
const watchProviderOptions = [
  { label: "Apple TV", ids: [350] },
  { label: "Disney Plus", ids: [337] },
  { label: "Netflix", ids: [8, 1796] },
  { label: "Amazon Prime Video", ids: [9, 2100] },
  { label: "Peacock", ids: [386, 387] },
  { label: "Hulu", ids: [15] },
  { label: "HBO Max", ids: [1899] },
  { label: "Paramount+", ids: [2303, 2616] },
] as const;
const starValues = [1, 2, 3, 4, 5] as const;
type PickMode = "idle" | "personal" | "prompt";

function readJson<T>(key: string, fallback: T, oldKeys: string[] = []): T {
  try {
    const legacyMigrationDisabled = localStorage.getItem(legacyMigrationDisabledKey) === "true";
    const raw = [key, ...(legacyMigrationDisabled ? [] : oldKeys)].map((candidate) => localStorage.getItem(candidate)).find((value) => value !== null);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch { return fallback; }
}

function writeJson(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* local persistence is best effort */ }
}

function ratingModelCacheKey(ratings: RatingMap, watched: WatchedMap, representationVersion: string) {
  let hash = 2166136261;
  const update = (value: string) => { for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); } };
  update(representationVersion);
  Object.keys(ratings).sort((left, right) => Number(left) - Number(right)).forEach((id) => {
    const entry = watched[id]; const movie = entry?.movie;
    const embedding = movie?.modelEmbedding || [];
    const embeddingSignature = embedding.length ? `${movie?.modelEmbeddingModel || "embedding"}:${embedding.length}:${embedding.slice(0, 12).map((value) => Number(value).toFixed(4)).join(",")}` : "local";
    update(`${id}:${ratings[id]}:${entry?.watchedAt || 0}:${movie?.genres.join(",") || ""}:${movie?.director || ""}:${movie?.originalLanguage || ""}:${movie?.keywords?.slice(0, 16).join(",") || ""}:${movie?.recommendedMovieIds?.join(",") || ""}:${embeddingSignature}|`);
  });
  return `v3:${Object.keys(ratings).length}:${(hash >>> 0).toString(36)}`;
}

function deferJsonWrite(key: string, value: unknown) {
  let cancelled = false;
  const write = () => { if (!cancelled) writeJson(key, value); };
  const idleApi = window as unknown as { requestIdleCallback?: (callback: () => void, options: { timeout: number }) => number; cancelIdleCallback?: (request: number) => void };
  if (idleApi.requestIdleCallback) {
    const request = idleApi.requestIdleCallback(write, { timeout: 1_200 });
    return () => { cancelled = true; idleApi.cancelIdleCallback?.(request); };
  }
  const timeout = window.setTimeout(write, 0);
  return () => { cancelled = true; window.clearTimeout(timeout); };
}

function mergeMovies(...lists: Movie[][]) {
  const map = new Map<number, Movie>();
  lists.flat().forEach((movie) => map.set(movie.id, { ...(map.get(movie.id) || {}), ...movie }));
  return [...map.values()];
}

function uid(prefix: string) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
function shortRuntime(movie: Movie) { return movie.runtime ? `${movie.runtime} min` : "Runtime unknown"; }
function formatRating(rating: number) { return Number.isInteger(rating) ? `${rating}` : rating.toFixed(1); }
function trapDialogFocus(event: KeyboardEvent, dialog: HTMLElement | null) {
  if (event.key !== "Tab" || !dialog) return;
  const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]')];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

type PosterSize = "w92" | "w185" | "w342" | "w500" | "w780";
const posterDimensions: Record<PosterSize, readonly [number, number]> = {
  w92: [92, 138],
  w185: [185, 278],
  w342: [342, 513],
  w500: [500, 750],
  w780: [780, 1170],
};

function MoviePosterImage({ movie, size = "w342", alt = "", className, priority = false, eager = false, sizes }: {
  movie: Movie;
  size?: PosterSize;
  alt?: string;
  className?: string;
  priority?: boolean;
  eager?: boolean;
  sizes?: string;
}) {
  const [width, height] = posterDimensions[size];
  const source = posterUrl(movie.posterPath, size);
  const responsiveSources = !movie.posterPath ? undefined : size === "w342"
    ? `${posterUrl(movie.posterPath, "w185")} 185w, ${posterUrl(movie.posterPath, "w342")} 342w`
    : size === "w500"
      ? `${posterUrl(movie.posterPath, "w342")} 342w, ${posterUrl(movie.posterPath, "w500")} 500w`
      : size === "w780"
        ? `${posterUrl(movie.posterPath, "w500")} 500w, ${posterUrl(movie.posterPath, "w780")} 780w`
        : undefined;
  const responsiveSizes = sizes || (size === "w342" ? "(max-width: 700px) 42vw, 220px" : size === "w500" ? "(max-width: 700px) 70vw, 320px" : size === "w780" ? "min(70vw, 500px)" : undefined);
  return <img
    className={["movie-poster-image", className].filter(Boolean).join(" ")}
    src={source || undefined}
    srcSet={responsiveSources}
    sizes={responsiveSizes}
    alt={alt}
    width={width}
    height={height}
    loading={priority || eager ? "eager" : "lazy"}
    decoding="async"
    fetchPriority={priority ? "high" : "auto"}
  />;
}

function Icon({ name }: { name: "search" | "bookmark" | "eye" | "heart" | "x" | "spark" | "plus" | "upload" | "chevron" }) {
  const paths = {
    search: <><circle cx="10.7" cy="10.7" r="6.2"/><path d="m15.2 15.2 4.3 4.3"/></>,
    bookmark: <path d="M7 4.5h10v15l-5-3-5 3z"/>, eye: <><path d="M2.5 12s3.2-5 9.5-5 9.5 5 9.5 5-3.2 5-9.5 5-9.5-5-9.5-5Z"/><circle cx="12" cy="12" r="2.5"/></>, heart: <path d="M20.8 5.8a5 5 0 0 0-7.1 0L12 7.5l-1.7-1.7a5 5 0 1 0-7.1 7.1L12 21l8.8-8.1a5 5 0 0 0 0-7.1Z"/>,
    x: <><path d="m7 7 10 10M17 7 7 17"/></>, spark: <path d="m12 2 1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7L12 2Z"/>,
    plus: <><path d="M12 5v14M5 12h14"/></>, upload: <><path d="M12 15V3m0 0L7.5 7.5M12 3l4.5 4.5"/><path d="M5 14v5h14v-5"/></>, chevron: <path d="m8 10 4 4 4-4"/>,
  };
  return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

export default function App() {
  const [tab, setTab] = useState<Tab>("pick");
  const [theme, setTheme] = useState<Theme>(() => readJson(storage.theme, "light", legacy.theme));
  const [ratings, setRatings] = useState<RatingMap>(() => readJson(storage.ratings, {}, legacy.ratings));
  const [likes, setLikes] = useState<LikedMap>(() => readJson(storage.likes, {}));
  const [watchlist, setWatchlist] = useState<WatchlistMap>(() => readJson(storage.watchlist, {}, legacy.watchlist));
  const [watched, setWatched] = useState<WatchedMap>(() => readJson(storage.watched, {}, legacy.watched));
  const [interest, setInterest] = useState<InterestMap>(() => readJson(storage.interest, {}, legacy.interest));
  const [reviews, setReviews] = useState<ReviewMap>(() => readJson(storage.reviews, {}, legacy.reviews));
  const [reviewInsights, setReviewInsights] = useState<ReviewInsightMap>(() => readJson(storage.reviewInsights, {}));
  const [reviewConsent, setReviewConsent] = useState(() => readJson(storage.reviewConsent, false));
  const [reviewConsentAsked, setReviewConsentAsked] = useState(() => readJson(storage.reviewConsentAsked, false));
  const [preferences, setPreferences] = useState<OnboardingPreferences>(() => {
    const saved = readJson<Partial<OnboardingPreferences>>(storage.preferences, defaultPreferences, legacy.preferences);
    return { ...defaultPreferences, ...saved, actors: saved.actors || [], genres: (saved.genres || []).filter((genre) => genre !== "TV Movie") };
  });
  const [pickIntents, setPickIntents] = useState<PickIntentEvent[]>(() => readJson(storage.pickIntents, []));
  const [learningEvents, setLearningEvents] = useState<LearningEvent[]>(() => readJson(storage.learningEvents, []));
  const [recommendationEvents, setRecommendationEvents] = useState<RecommendationEvent[]>(() => readJson(storage.recommendationEvents, []));
  const [tasteDecisions, setTasteDecisions] = useState(() => readJson(storage.tasteDecisions, 0));
  const [catalog, setCatalog] = useState<Movie[]>(() => readJson(storage.cache, fallbackMovies, legacy.cache));
  const [candidateMovies, setCandidateMovies] = useState<Movie[]>([]);
  const [collaborativeModel, setCollaborativeModel] = useState<CollaborativeModel | null>(null);
  const [ratingCalibration, setRatingCalibration] = useState<RatingCalibration>(() => buildRatingCalibration([], {}, {}));
  const [candidatePredictions, setCandidatePredictions] = useState<Map<number, RatingPrediction>>(() => new Map());
  const [movieIntelligence, setMovieIntelligence] = useState<Map<number, MovieIntelligenceRecord>>(() => new Map());
  const [movieIntelligenceProgress, setMovieIntelligenceProgress] = useState<MovieIntelligenceProgress | null>(null);
  const [ratingModelPending, setRatingModelPending] = useState(false);
  const [ratingModelStage, setRatingModelStage] = useState("");
  const [filters, setFilters] = useState<PickFilters>(defaultFilters);
  const [pickMode, setPickMode] = useState<PickMode>("idle");
  const [promptDraft, setPromptDraft] = useState("");
  const [prompt, setPrompt] = useState("");
  const [promptExplanation, setPromptExplanation] = useState("");
  const [promptScores, setPromptScores] = useState<Record<number, number>>({});
  const [promptEvidence, setPromptEvidence] = useState<Record<number, PromptMovieEvidence>>({});
  const [promptBroadQuery, setPromptBroadQuery] = useState(false);
  const [pickLoading, setPickLoading] = useState(false);
  const [pickLoadingStage, setPickLoadingStage] = useState("");
  const [pickError, setPickError] = useState("");
  const [pickSlots, setPickSlots] = useState<PickSlot<RecommendationResult>[]>(() => createPickSlots());
  const [pickSetInitialized, setPickSetInitialized] = useState(false);
  const [swappedPickIds, setSwappedPickIds] = useState<number[]>([]);
  const [selectedPick, setSelectedPick] = useState<RecommendationResult | null>(null);
  const [committingPickId, setCommittingPickId] = useState<number | null>(null);
  const [expandedReason, setExpandedReason] = useState<number | null>(null);
  const [providerOpen, setProviderOpen] = useState(false);
  const [availability, setAvailability] = useState<Record<number, StreamingAvailability>>({});
  const [theaterMovieIds, setTheaterMovieIds] = useState<Set<number> | null>(null);
  const [ratingPromptMovie, setRatingPromptMovie] = useState<Movie | null>(null);
  const [outcomePrompt, setOutcomePrompt] = useState<PickIntentEvent | null>(null);
  const [sprintCandidates, setSprintCandidates] = useState<Movie[]>([]);
  const [sprintCurrentId, setSprintCurrentId] = useState<number | null>(null);
  const [sprintLoading, setSprintLoading] = useState(false);
  const [sprintError, setSprintError] = useState("");
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>("watchlist");
  const [libraryWatchedFilter, setLibraryWatchedFilter] = useState<LibraryWatchedFilter>("all");
  const [librarySort, setLibrarySort] = useState<LibrarySort>("recent");
  const [libraryQuery, setLibraryQuery] = useState("");
  const [detailMovie, setDetailMovie] = useState<Movie | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [unwatchConfirmation, setUnwatchConfirmation] = useState<Movie | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addQuery, setAddQuery] = useState("");
  const [addResults, setAddResults] = useState<Movie[]>([]);
  const [importRows, setImportRows] = useState<CsvImportRow[]>([]);
  const [importSummary, setImportSummary] = useState<MovieImportSummary | null>(null);
  const [importError, setImportError] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importResolving, setImportResolving] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportResolutionProgress>({ completed: 0, total: 0, matched: 0 });
  const [letterboxdImportMeta, setLetterboxdImportMeta] = useState<LetterboxdImportMeta | null>(() => readJson(storage.letterboxdImport, null));
  const [reviewConsentPrompt, setReviewConsentPrompt] = useState<Movie | null>(null);
  const [reviewAnalysisStatus, setReviewAnalysisStatus] = useState<Record<number, string>>({});
  const [tourOpen, setTourOpen] = useState(() => !readJson(storage.tour, false));
  const [tourSlide, setTourSlide] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const developerMode = import.meta.env.DEV && new URLSearchParams(window.location.search).has("debug");
  const [session, setSession] = useState<AuthSession | null>(null);
  const [syncStatus, setSyncStatus] = useState("Saved on this device");
  const [authFinishing, setAuthFinishing] = useState(() => hasAuthCallbackParams());
  const [fieldUpdatedAt, setFieldUpdatedAt] = useState<Record<string, number>>(() => readJson<{ fieldUpdatedAt?: Record<string, number> }>(storage.stateMeta, {}, legacy.stateMeta).fieldUpdatedAt || {});
  const [stateUpdatedAt, setStateUpdatedAt] = useState(Date.now());
  const cloudLoaded = useRef<string | null>(null);
  const skipCloudSave = useRef(false);
  const sessionRef = useRef<AuthSession | null>(null);
  const activeState = useRef<CloudUserState>(emptyCloudState);
  const guestSnapshot = useRef<CloudUserState | null>(null);
  const mergeKey = useRef(readJson<string>(storage.mergeKey, "", legacy.mergeKey) || createMergeKey());
  const importAbort = useRef<AbortController | null>(null);
  const ratingModelRequest = useRef(0);
  const sprintPage = useRef(1);
  const sprintBusy = useRef(false);
  const sessionStartedAt = useRef(Date.now());
  const promptedOutcomeIds = useRef(new Set<string>());
  const recordedImpressions = useRef(new Set<string>());
  const pickCommitInFlight = useRef(false);

  useEffect(() => { document.documentElement.dataset.theme = theme; writeJson(storage.theme, theme); }, [theme]);
  useEffect(() => { window.scrollTo({ top: 0, behavior: "smooth" }); }, [tab]);
  useEffect(() => deferJsonWrite(storage.ratings, ratings), [ratings]);
  useEffect(() => deferJsonWrite(storage.likes, likes), [likes]);
  useEffect(() => deferJsonWrite(storage.watchlist, watchlist), [watchlist]);
  useEffect(() => deferJsonWrite(storage.watched, watched), [watched]);
  useEffect(() => {
    const overlaps = Object.keys(watchlist).filter((movieId) => movieId in watched);
    if (!overlaps.length) return;
    const now = Date.now();
    setWatchlist((current) => excludeWatchedFromWatchlist(current, watched));
    setFieldUpdatedAt((current) => ({ ...current, ...Object.fromEntries(overlaps.map((movieId) => [`watchlist:${movieId}`, now])) }));
    setStateUpdatedAt(now);
  }, [watched, watchlist]);
  useEffect(() => deferJsonWrite(storage.interest, interest), [interest]);
  useEffect(() => deferJsonWrite(storage.reviews, reviews), [reviews]);
  useEffect(() => deferJsonWrite(storage.reviewInsights, reviewInsights), [reviewInsights]);
  useEffect(() => writeJson(storage.reviewConsent, reviewConsent), [reviewConsent]);
  useEffect(() => writeJson(storage.reviewConsentAsked, reviewConsentAsked), [reviewConsentAsked]);
  useEffect(() => writeJson(storage.preferences, preferences), [preferences]);
  useEffect(() => writeJson(storage.pickIntents, pickIntents.slice(-100)), [pickIntents]);
  useEffect(() => writeJson(storage.learningEvents, learningEvents.slice(-100)), [learningEvents]);
  useEffect(() => writeJson(storage.recommendationEvents, recommendationEvents.slice(-300)), [recommendationEvents]);
  useEffect(() => writeJson(storage.tasteDecisions, tasteDecisions), [tasteDecisions]);
  useEffect(() => writeJson(storage.cache, catalog.slice(-260)), [catalog]);
  useEffect(() => writeJson(storage.letterboxdImport, letterboxdImportMeta), [letterboxdImportMeta]);
  useEffect(() => writeJson(storage.includeWatchlist, filters.includeWatchlist), [filters.includeWatchlist]);
  useEffect(() => deferJsonWrite(storage.stateMeta, { fieldUpdatedAt, stateUpdatedAt }), [fieldUpdatedAt, stateUpdatedAt]);
  useEffect(() => writeJson(storage.mergeKey, mergeKey.current), []);

  const rememberMovies = useCallback((movies: Movie[]) => {
    if (movies.length) setCatalog((current) => mergeMovies(current, movies).slice(-260));
  }, []);

  useEffect(() => {
    Promise.allSettled([getTrendingMovies(), getRecommendationCatalog()]).then((results) => {
      const movies = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
      if (movies.length) rememberMovies(movies);
    });
  }, [rememberMovies]);
  useEffect(() => {
    if (collaborativeModel || Object.keys(ratings).length === 0) return;
    let cancelled = false;
    loadCollaborativeModel().then((model) => { if (!cancelled) setCollaborativeModel(model); });
    return () => { cancelled = true; };
  }, [collaborativeModel, ratings]);

  useEffect(() => {
    const ratedMovies = Object.entries(ratings).flatMap(([id]) => watched[id]?.movie ? [watched[id].movie] : []);
    if (!ratedMovies.length) { setMovieIntelligence(new Map()); setMovieIntelligenceProgress(null); return; }
    const controller = new AbortController();
    const ids = ratedMovies.map((movie) => movie.id);
    loadMovieIntelligence(ids).then((cached) => { if (!controller.signal.aborted && cached.size) setMovieIntelligence(cached); });
    void enrichMovieIntelligence(ratedMovies, { signal: controller.signal, onProgress: (progress) => {
      if (!controller.signal.aborted) setMovieIntelligenceProgress(progress.phase === "complete" ? null : progress);
    }}).then((records) => { if (!controller.signal.aborted) { setMovieIntelligence(records); setMovieIntelligenceProgress(null); } });
    return () => controller.abort();
  }, [ratings, watched]);

  useEffect(() => {
    const missing = candidateMovies.filter((movie) => !movieIntelligence.has(movie.id));
    if (!missing.length) return;
    const controller = new AbortController();
    void enrichMovieIntelligence(missing, { signal: controller.signal }).then((records) => {
      if (controller.signal.aborted || !records.size) return;
      setMovieIntelligence((current) => new Map([...current, ...records]));
    });
    return () => controller.abort();
  }, [candidateMovies, movieIntelligence]);

  useEffect(() => {
    if (!filters.includeTheaters) { setTheaterMovieIds(null); return; }
    let cancelled = false;
    setTheaterMovieIds(null);
    getNowPlayingMovieIds(filters.region)
      .then((ids) => { if (!cancelled) setTheaterMovieIds(ids); })
      .catch(() => { if (!cancelled) setTheaterMovieIds(new Set()); });
    return () => { cancelled = true; };
  }, [filters.includeTheaters, filters.region]);

  useEffect(() => {
    if (pickMode !== "prompt" || prompt.trim().length < 3) return;
    let cancelled = false;
    setPickLoading(true);
    setPickLoadingStage("Understanding your request…");
    setPickError("");
    setPromptExplanation("");
    setPickSlots(createPickSlots());
    setPickSetInitialized(false);
    const timeout = window.setTimeout(async () => {
      try {
        const askResult = await askPickAMovie(prompt.trim(), filters);
        if (cancelled) return;
        const prompted = askResult.movies;
        const movies = prompted.filter((movie) => matchesPickFilters(movie, { ...filters, providerIds: [], includeTheaters: false }));
        if (import.meta.env.DEV) {
          console.debug("[pick-prompt] resolved", JSON.stringify({
            serviceStatus: askResult.serviceStatus,
            promptedCount: prompted.length,
            constrainedCount: movies.length,
            topTitles: movies.slice(0, 5).map((movie) => movie.title),
          }));
        }
        setPromptScores(Object.fromEntries(movies.map((movie) => [movie.id, askResult.promptScores[movie.id] || 0.35])));
        setPromptEvidence(Object.fromEntries(movies.flatMap((movie) => askResult.promptEvidence?.[movie.id] ? [[movie.id, askResult.promptEvidence[movie.id]]] : [])));
        setPromptExplanation(askResult.explanation);
        setPromptBroadQuery(Boolean(askResult.broadQuery));
        if (cancelled) return;
        setCandidateMovies(movies);
        rememberMovies(movies);
      } catch (error) {
        if (import.meta.env.DEV) console.error("[pick-prompt] failed", error);
        if (!cancelled) { setPickError("AI research was unavailable—using saved movie data."); setPromptScores({}); setPromptEvidence({}); setCandidateMovies(catalog.length ? catalog : fallbackMovies); }
      } finally { if (!cancelled) setPickLoading(false); }
    }, 320);
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, [pickMode, filters.runtimeMin, filters.runtimeMax, filters.genres.join(","), filters.eras.join(","), filters.providerIds.join(","), filters.includeTheaters, filters.region, prompt, rememberMovies]);

  useEffect(() => {
    if (pickMode !== "personal") return;
    let cancelled = false;
    setPickLoading(true);
    setPickLoadingStage("Finding three for you…");
    setPickError("");
    setPromptExplanation("");
    setPromptScores({});
    setPromptEvidence({});
    setPromptBroadQuery(false);
    setPickSlots(createPickSlots());
    setPickSetInitialized(false);
    void discoverPickMovies(filters)
      .then((movies) => {
        if (cancelled) return;
        setCandidateMovies(movies);
        rememberMovies(movies);
      })
      .catch(() => {
        if (cancelled) return;
        const local = (catalog.length ? catalog : fallbackMovies)
          .filter((movie) => matchesPickFilters(movie, { ...filters, providerIds: [], includeTheaters: false }));
        setPickError("Live discovery was unavailable—using saved movie data.");
        setCandidateMovies(local);
      })
      .finally(() => { if (!cancelled) setPickLoading(false); });
    return () => { cancelled = true; };
  }, [pickMode, filters.runtimeMin, filters.runtimeMax, filters.genres.join(","), filters.eras.join(","), filters.providerIds.join(","), filters.includeTheaters, filters.region, rememberMovies]);

  useEffect(() => {
    if (!pickLoading || pickMode === "idle") { setPickLoadingStage(""); return; }
    if (pickMode === "personal") { setPickLoadingStage("Finding three for you…"); return; }
    setPickLoadingStage("Understanding your request…");
    const researching = window.setTimeout(() => setPickLoadingStage("Researching matches…"), 800);
    const checking = window.setTimeout(() => setPickLoadingStage("Checking TMDB…"), 4_000);
    const ranking = window.setTimeout(() => setPickLoadingStage("Ranking for you…"), 8_000);
    return () => { window.clearTimeout(researching); window.clearTimeout(checking); window.clearTimeout(ranking); };
  }, [pickLoading, pickMode, prompt]);

  const allMovies = useMemo(() => mergeMovies(
    fallbackMovies, catalog, candidateMovies, Object.values(watchlist), Object.values(watched).map((entry) => entry.movie),
    Object.values(interest).map((entry) => entry.movie), Object.values(likes), Object.values(preferences.favoriteMovies), detailMovie ? [detailMovie] : [],
  ), [catalog, candidateMovies, watchlist, watched, interest, likes, preferences.favoriteMovies, detailMovie]);

  const deferredRatings = useDeferredValue(ratings);
  const deferredLikes = useDeferredValue(likes);
  const deferredWatchlist = useDeferredValue(watchlist);
  const deferredWatched = useDeferredValue(watched);
  const deferredInterest = useDeferredValue(interest);
  const deferredPreferences = useDeferredValue(preferences);
  const deferredPickIntents = useDeferredValue(pickIntents);
  const deferredReviewInsights = useDeferredValue(reviewInsights);
  const modelWatched = useMemo(() => Object.fromEntries(Object.entries(deferredWatched).map(([id, entry]) => [id, { ...entry, movie: applyMovieIntelligence(entry.movie, movieIntelligence.get(Number(id))) }])), [deferredWatched, movieIntelligence]) as WatchedMap;
  const tasteProfileMovies = useMemo(() => buildTasteProfileSample({ ratings: deferredRatings, likes: deferredLikes, watchlist: deferredWatchlist, watched: deferredWatched, interest: deferredInterest, preferences: deferredPreferences }), [deferredRatings, deferredLikes, deferredWatchlist, deferredWatched, deferredInterest, deferredPreferences]);
  const realTimeCandidates = useMemo(() => mergeMovies(candidateMovies, sprintCandidates, catalog, fallbackMovies), [candidateMovies, sprintCandidates, catalog]);

  const collaborativeScores = useMemo(() => scoreCollaborativeCandidates(collaborativeModel, deferredRatings, candidateMovies), [collaborativeModel, deferredRatings, candidateMovies]);
  const collaborativeEvidence = useMemo(() => explainCollaborativeCandidates(collaborativeModel, deferredRatings, realTimeCandidates), [collaborativeModel, deferredRatings, realTimeCandidates]);
  useEffect(() => {
    const requestId = ++ratingModelRequest.current;
    const sample = createRatingModelInput(deferredRatings, modelWatched);
    const cacheKey = ratingModelCacheKey(deferredRatings, modelWatched, `${collaborativeModel?.version || "content-only"}:${MOVIE_INTELLIGENCE_VERSION}`);
    const cached = readJson<{ key: string; calibration?: RatingCalibration } | null>(storage.ratingModel, null);
    if (cached?.key === cacheKey && cached.calibration?.modelSnapshot?.version === "personal-ranking-v3") {
      setRatingCalibration(cached.calibration);
      setRatingModelPending(false);
      setRatingModelStage("");
      return;
    }
    let cancelled = false;
    let fallbackTimeout = 0;
    setRatingModelPending(true);
    setCandidatePredictions(new Map());
    const applyResult = (calibration: RatingCalibration) => {
      if (cancelled || requestId !== ratingModelRequest.current) return;
      setRatingCalibration(calibration);
      writeJson(storage.ratingModel, { key: cacheKey, calibration });
      setRatingModelPending(false);
      setRatingModelStage("");
    };
    const calculateOnMainThread = () => {
      const calibration = buildRatingCalibration(sample.movies, sample.ratings, sample.watched, collaborativeModel);
      applyResult(calibration);
    };
    if (typeof Worker === "undefined") {
      fallbackTimeout = window.setTimeout(calculateOnMainThread, 0);
      return () => { cancelled = true; window.clearTimeout(fallbackTimeout); };
    }
    const worker = new Worker(new URL("./workers/ratingModelWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ requestId: number; calibration?: RatingCalibration; predictions?: Array<[number, RatingPrediction]>; progress?: string }>) => {
      if (event.data.requestId !== requestId) return;
      if (event.data.progress) { setRatingModelStage(event.data.progress); return; }
      if (!event.data.calibration || !event.data.predictions) return;
      applyResult(event.data.calibration);
      worker.terminate();
    };
    worker.onerror = () => {
      worker.terminate();
      if (!cancelled) fallbackTimeout = window.setTimeout(calculateOnMainThread, 0);
    };
    worker.postMessage({ requestId, ...sample, candidates: [] });
    return () => { cancelled = true; worker.terminate(); window.clearTimeout(fallbackTimeout); };
  }, [deferredRatings, modelWatched, collaborativeModel]);
  const predictionModelReady = !ratingModelPending && ratingCalibration.rankingReady;
  const predictionStarsReady = predictionModelReady && ratingCalibration.starReady;
  useEffect(() => {
    const snapshot = ratingCalibration.modelSnapshot;
    if (!predictionModelReady || !snapshot || !candidateMovies.length) { setCandidatePredictions(new Map()); return; }
    const input = createRatingModelInput(deferredRatings, modelWatched);
    const modelCandidates = candidateMovies.map((movie) => applyMovieIntelligence(movie, movieIntelligence.get(movie.id)));
    let cancelled = false;
    let fallbackTimeout = 0;
    const applyPredictions = (predictions: Array<[number, RatingPrediction]>) => { if (!cancelled) setCandidatePredictions(new Map(predictions)); };
    const calculateOnMainThread = () => applyPredictions([...predictCandidateRatings(modelCandidates, input.ratings, input.watched, collaborativeModel, snapshot).entries()]);
    if (typeof Worker === "undefined") {
      fallbackTimeout = window.setTimeout(calculateOnMainThread, 0);
      return () => { cancelled = true; window.clearTimeout(fallbackTimeout); };
    }
    const worker = new Worker(new URL("./workers/ratingModelWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ predictions?: Array<[number, RatingPrediction]>; progress?: string }>) => {
      if (event.data.progress) return;
      applyPredictions(event.data.predictions || []);
      worker.terminate();
    };
    worker.onerror = () => { worker.terminate(); if (!cancelled) fallbackTimeout = window.setTimeout(calculateOnMainThread, 0); };
    worker.postMessage({ requestId: ratingModelRequest.current, ...input, candidates: modelCandidates, snapshot, calibrate: false });
    return () => { cancelled = true; worker.terminate(); window.clearTimeout(fallbackTimeout); };
  }, [candidateMovies, deferredRatings, modelWatched, movieIntelligence, collaborativeModel, predictionModelReady, ratingCalibration.modelSnapshot]);
  useEffect(() => {
    if (!detailMovie || watched[detailMovie.id] || !predictionStarsReady || candidatePredictions.has(detailMovie.id) || !ratingCalibration.modelSnapshot) return;
    const movie = applyMovieIntelligence(detailMovie, movieIntelligence.get(detailMovie.id));
    const sample = createRatingModelInput(deferredRatings, modelWatched);
    let cancelled = false;
    let fallbackTimeout = 0;
    const applyPrediction = (prediction?: RatingPrediction) => {
      if (!cancelled && prediction) setCandidatePredictions((current) => new Map(current).set(movie.id, prediction));
    };
    const calculateOnMainThread = () => applyPrediction(predictCandidateRatings([movie], sample.ratings, sample.watched, collaborativeModel, ratingCalibration.modelSnapshot).get(movie.id));
    if (typeof Worker === "undefined") {
      fallbackTimeout = window.setTimeout(calculateOnMainThread, 0);
      return () => { cancelled = true; window.clearTimeout(fallbackTimeout); };
    }
    const worker = new Worker(new URL("./workers/ratingModelWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ predictions?: Array<[number, RatingPrediction]>; progress?: string }>) => { if (event.data.progress) return; applyPrediction(event.data.predictions?.[0]?.[1]); worker.terminate(); };
    worker.onerror = () => { worker.terminate(); if (!cancelled) fallbackTimeout = window.setTimeout(calculateOnMainThread, 0); };
    worker.postMessage({ requestId: ratingModelRequest.current, ...sample, candidates: [movie], snapshot: ratingCalibration.modelSnapshot, calibrate: false });
    return () => { cancelled = true; worker.terminate(); window.clearTimeout(fallbackTimeout); };
  }, [detailMovie, watched, predictionStarsReady, candidatePredictions, deferredRatings, modelWatched, movieIntelligence, collaborativeModel, ratingCalibration.modelSnapshot]);
  const personalizedRanked = useMemo(() => recommendMovies({
    movies: candidateMovies, tasteMovies: tasteProfileMovies, ratings: deferredRatings, likes: deferredLikes, watchlist: deferredWatchlist, watched: deferredWatched, interest: deferredInterest, preferences: deferredPreferences, pickIntents: deferredPickIntents, reviewInsights: deferredReviewInsights, promptScores, promptEvidence, collaborativeScores, collaborativeEvidence, candidatePredictions, predictionEnabled: predictionModelReady, predictionStarsEnabled: predictionStarsReady, mode: "balanced", limit: 30,
  }), [candidateMovies, tasteProfileMovies, deferredRatings, deferredLikes, deferredWatchlist, deferredWatched, deferredInterest, deferredPreferences, deferredPickIntents, deferredReviewInsights, promptScores, promptEvidence, collaborativeScores, collaborativeEvidence, candidatePredictions, predictionModelReady, predictionStarsReady]);
  const ranked = useMemo(() => {
    const base = Object.keys(promptScores).length
      ? [...personalizedRanked].sort((a, b) => (promptScores[b.movie.id] || 0) - (promptScores[a.movie.id] || 0) || b.score - a.score || (b.movie.popularity || 0) - (a.movie.popularity || 0))
      : personalizedRanked;
    const hasTaste = Object.keys(ratings).length + Object.keys(likes).length + Object.keys(interest).length + Object.keys(preferences.favoriteMovies).length
      + preferences.genres.length + preferences.actors.length + preferences.directors.length >= 3;
    if (!promptBroadQuery || !hasTaste || base.length < 4) return base;
    const thirdPromptScore = promptScores[base[2].movie.id] || 0;
    const discovery = base.slice(2, 10)
      .filter((result) => (promptScores[result.movie.id] || 0) >= thirdPromptScore - .1)
      .sort((a, b) => b.score - a.score)[0];
    if (!discovery || discovery.movie.id === base[2].movie.id) return base;
    return [base[0], base[1], discovery, ...base.slice(2).filter((result) => result.movie.id !== discovery.movie.id)];
  }, [personalizedRanked, promptScores, promptBroadQuery, ratings, interest, preferences]);

  useEffect(() => {
    if (!candidateMovies.length) return;
    const missingDetails = candidateMovies.slice(0, 3).filter((movie) => !movie.runtime);
    if (!missingDetails.length) return;
    let cancelled = false;
    Promise.allSettled(missingDetails.map(getMovieDisplayDetails)).then((settled) => {
      if (cancelled) return;
      const details = new Map<number, Movie>();
      settled.forEach((result) => {
        if (result.status === "fulfilled" && result.value.runtime) details.set(result.value.id, result.value);
      });
      if (!details.size) return;
      setCandidateMovies((current) => current.map((movie) => details.get(movie.id) || movie));
      rememberMovies([...details.values()]);
    });
    return () => { cancelled = true; };
  }, [candidateMovies, rememberMovies]);
  useEffect(() => {
    if (import.meta.env.DEV && prompt.trim().length >= 3 && ranked.length) {
      console.debug("[pick-ranking] top", JSON.stringify(ranked.slice(0, 8).map((result) => ({ title: result.movie.title, promptScore: promptScores[result.movie.id], score: Number(result.score.toFixed(3)) }))));
    }
  }, [prompt, promptScores, ranked]);

  useEffect(() => {
    const targets = ranked.slice(0, filters.providerIds.length ? 20 : 6).map((result) => result.movie);
    if (!targets.length) return;
    let cancelled = false;
    Promise.all(targets.map((movie) => getMovieWatchProviders(movie.id, filters.region).catch(() => ({ movieId: movie.id, region: filters.region, providers: [], checkedAt: Date.now(), status: "unavailable" as const }))))
      .then((items) => { if (!cancelled) setAvailability((current) => ({ ...current, ...Object.fromEntries(items.map((item) => [item.movieId, item])) })); });
    return () => { cancelled = true; };
  }, [ranked.map((result) => result.movie.id).join(","), filters.providerIds.join(","), filters.region]);

  const eligibleRanked = useMemo(() => {
    const hasWhereFilter = filters.providerIds.length > 0 || filters.includeTheaters;
    const filterMatched = (hasWhereFilter ? ranked.filter((result) => {
      const streamsOnSelectedProvider = filters.providerIds.length > 0 && availability[result.movie.id]?.region === filters.region && availability[result.movie.id]?.status !== "unavailable" && availability[result.movie.id]?.providers.some((provider) => filters.providerIds.includes(provider.id));
      const isInTheaters = filters.includeTheaters && theaterMovieIds?.has(result.movie.id);
      return streamsOnSelectedProvider || isInTheaters;
    }) : ranked).filter((result) => !swappedPickIds.includes(result.movie.id));
    return arrangeWatchlistCandidates(filterMatched, watchlist, filters.includeWatchlist);
  }, [ranked, availability, filters.providerIds, filters.includeTheaters, filters.includeWatchlist, filters.region, theaterMovieIds, watchlist, swappedPickIds]);

  useEffect(() => {
    if (pickMode === "idle" || pickLoading || pickSetInitialized || (!candidateMovies.length && !eligibleRanked.length)) return;
    setPickSlots(createPickSlots(eligibleRanked.slice(0, 3)));
    setPickSetInitialized(true);
  }, [candidateMovies.length, eligibleRanked, pickLoading, pickMode, pickSetInitialized]);

  const visibleResults = useMemo(() => pickSlots.flatMap((slot) => slot.value ? [slot.value] : []), [pickSlots]);

  useEffect(() => {
    if (pickMode === "idle" || pickLoading) return;
    const additions = visibleResults.flatMap((result, index) => {
      const key = `${pickMode}|${prompt.toLowerCase()}|${result.movie.id}`;
      if (recordedImpressions.current.has(key)) return [];
      recordedImpressions.current.add(key);
      return [recommendationEvent("impression", result.movie, result.score, { rank: index + 1 })];
    });
    if (additions.length) setRecommendationEvents((current) => [...current, ...additions].slice(-300));
  }, [pickLoading, pickMode, prompt, visibleResults]);
  const streamingChecksPending = (filters.providerIds.length > 0 && ranked.slice(0, 15).some((result) => availability[result.movie.id]?.region !== filters.region)) || (filters.includeTheaters && theaterMovieIds === null);
  const tasteRanked = useMemo(() => recommendMovies({
    movies: realTimeCandidates, tasteMovies: tasteProfileMovies, ratings: deferredRatings, likes: deferredLikes, watchlist: deferredWatchlist, watched: deferredWatched, interest: deferredInterest, preferences: deferredPreferences, pickIntents: deferredPickIntents, reviewInsights: deferredReviewInsights, collaborativeScores, collaborativeEvidence,
    mode: "balanced", limit: 160,
  }), [realTimeCandidates, tasteProfileMovies, deferredRatings, deferredLikes, deferredWatchlist, deferredWatched, deferredInterest, deferredPreferences, deferredPickIntents, deferredReviewInsights, collaborativeScores, collaborativeEvidence]);
  const recentSprintMovies = useMemo(() => learningEvents.filter((event) => event.source === "sprint").slice(-6).reverse().map((event) => event.movie), [learningEvents]);
  const activeLearningCandidates = useMemo(() => {
    const decided = new Set([...Object.keys(interest), ...Object.keys(watched), ...Object.keys(ratings)].map(Number));
    Object.keys(likes).forEach((id) => decided.add(Number(id)));
    return rankTasteSprintCandidates({ results: tasteRanked.filter((result) => !decided.has(result.movie.id)), ratings, likes, interest, preferences, reviewInsights, recentMovies: recentSprintMovies });
  }, [tasteRanked, ratings, likes, interest, watched, preferences, reviewInsights, recentSprintMovies]);
  const activeSprintCandidate = useMemo(() => activeLearningCandidates.find((candidate) => candidate.movie.id === sprintCurrentId) || activeLearningCandidates[0] || null, [activeLearningCandidates, sprintCurrentId]);

  const cloudState = useMemo<CloudUserState>(() => ({
    version: 5, ratings, likes, watchlist, watched, interest, reviews, reviewInsights, reviewAnalysisConsent: reviewConsent,
    preferences, recommendationEvents: [], pickIntents: pickIntents.slice(-100), learningEvents: learningEvents.slice(-100),
    tasteSprintDecisions: tasteDecisions, letterboxdImportMeta: letterboxdImportMeta || undefined, fieldUpdatedAt, stateUpdatedAt,
  }), [ratings, likes, watchlist, watched, interest, reviews, reviewInsights, reviewConsent, preferences, pickIntents, learningEvents, tasteDecisions, letterboxdImportMeta, fieldUpdatedAt, stateUpdatedAt]);
  activeState.current = cloudState;
  if (!guestSnapshot.current) guestSnapshot.current = cloudState;

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    getCurrentSession().then((value) => { sessionRef.current = value; setSession(value); setAuthFinishing(false); }).catch(() => { setSyncStatus("Saved on this device"); setAuthFinishing(false); });
    return subscribeToAuth((next) => {
      if (next && !sessionRef.current) guestSnapshot.current = activeState.current;
      sessionRef.current = next; setSession(next); if (next) setAuthFinishing(false);
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
    const nextWatched = state.watched || {};
    setRatings(state.ratings || {}); setLikes(state.likes || {}); setWatchlist(excludeWatchedFromWatchlist(state.watchlist || {}, nextWatched)); setWatched(nextWatched); setInterest(state.interest || {});
    setReviews(state.reviews || {}); setReviewInsights(state.reviewInsights || {}); setReviewConsent(state.reviewAnalysisConsent || false);
    setPreferences({ ...defaultPreferences, ...(state.preferences || {}) }); setPickIntents(state.pickIntents || []); setLearningEvents(state.learningEvents || []);
    setTasteDecisions(state.tasteSprintDecisions || 0); setLetterboxdImportMeta(state.letterboxdImportMeta || null); setFieldUpdatedAt(state.fieldUpdatedAt || {}); setStateUpdatedAt(state.stateUpdatedAt || Date.now());
  }

  function touch(...keys: string[]) {
    touchMany(keys);
  }

  function touchMany(keys: string[]) {
    const now = Date.now();
    const updates: Record<string, number> = {};
    keys.forEach((key) => { updates[key] = now; });
    setFieldUpdatedAt((current) => ({ ...current, ...updates }));
    setStateUpdatedAt(now);
  }

  function learn(type: LearningEvent["type"], movie: Movie, label: string, undoKey?: string, source?: LearningEvent["source"]) {
    setLearningEvents((current) => [...current, { id: uid("learn"), type, movie, label, createdAt: Date.now(), undoKey, source }].slice(-100));
  }

  function recordRecommendation(event: RecommendationEvent) {
    setRecommendationEvents((current) => [...current, event].slice(-300));
  }

  function updatePickFilters(updater: (current: PickFilters) => PickFilters) {
    setFilters(updater);
    setCandidateMovies([]);
    setPickSlots(createPickSlots());
    setPickSetInitialized(false);
    setSwappedPickIds([]);
    setExpandedReason(null);
  }

  function updateWatchlistRecommendationPreference(includeWatchlist: boolean) {
    setFilters((current) => ({ ...current, includeWatchlist }));
    setPickSlots(createPickSlots());
    setPickSetInitialized(false);
    setSwappedPickIds([]);
    setExpandedReason(null);
  }

  function startPersonalPick() {
    setPrompt("");
    setPromptDraft("");
    setCandidateMovies([]);
    setPickMode("personal");
    setPickSlots(createPickSlots());
    setPickSetInitialized(false);
    setSwappedPickIds([]);
    setExpandedReason(null);
  }

  function submitPrompt() {
    const nextPrompt = promptDraft.trim();
    if (nextPrompt.length < 3) return;
    setPrompt(nextPrompt);
    setCandidateMovies([]);
    setPickMode("prompt");
    setPickSlots(createPickSlots());
    setPickSetInitialized(false);
    setSwappedPickIds([]);
    setExpandedReason(null);
  }

  function swapPick(result: RecommendationResult) {
    const visibleIds = pickSlots.flatMap((slot) => slot.value ? [slot.value.movie.id] : []);
    const replacement = eligibleRanked.find((candidate) => candidate.movie.id !== result.movie.id && !visibleIds.includes(candidate.movie.id) && !swappedPickIds.includes(candidate.movie.id)) || null;
    setPickSlots((current) => replacePickSlot(current, result.movie.id, replacement, (value) => value.movie.id));
    setSwappedPickIds((current) => current.includes(result.movie.id) ? current : [...current, result.movie.id]);
    setExpandedReason(null);
    setPickError(replacement ? "" : "No other matching movie is available for this slot.");
    recordRecommendation(recommendationEvent("swap", result.movie, result.score, {
      rank: Math.max(1, visibleResults.findIndex((item) => item.movie.id === result.movie.id) + 1),
    }));
  }

  function replacePick(movieId: number) {
    const visibleIds = pickSlots.flatMap((slot) => slot.value ? [slot.value.movie.id] : []);
    const replacement = eligibleRanked.find((result) => result.movie.id !== movieId && !visibleIds.includes(result.movie.id)) || null;
    setPickSlots((current) => replacePickSlot(current, movieId, replacement, (value) => value.movie.id));
    if (!replacement) setPickError("No other matching movie is available for this slot.");
  }

  function markWatched(movie: Movie, fromSprint = false) {
    if (watched[movie.id]) return;
    const wasSaved = Boolean(watchlist[movie.id]);
    const watchedAt = Date.now();
    const originatingPick = [...pickIntents].reverse().find((item) => item.movie.id === movie.id);
    touch(`watched:${movie.id}`, `watchlist:${movie.id}`);
    setWatched((current) => ({ ...current, [movie.id]: { movie, watchedAt } }));
    if (originatingPick) {
      setPickIntents((current) => linkPickOutcome(current, movie.id, { watchedAt }));
      recordRecommendation(recommendationEvent("watched", movie, originatingPick.score || 0, { rank: originatingPick.rank, pickId: originatingPick.id }));
    }
    setWatchlist((current) => { const next = { ...current }; delete next[movie.id]; return next; });
    learn("watched", movie, "Marked watched", `watched:${movie.id}:${wasSaved ? "saved" : "unsaved"}`, fromSprint ? "sprint" : "pick");
    setRatingPromptMovie(movie); replacePick(movie.id);
    if (fromSprint) advanceSprint(movie, true);
  }

  function requestUnwatch(movie: Movie) {
    if (ratings[movie.id] || reviews[movie.id]?.trim()) {
      setUnwatchConfirmation(movie);
      return;
    }
    unwatchMovie(movie);
  }

  function unwatchMovie(movie: Movie) {
    const id = movie.id;
    touch(`watched:${id}`, `rating:${id}`, `review:${id}`, `review-insight:${id}`);
    const next = removeWatchedOutcome({ watched, ratings, reviews, reviewInsights, learningEvents, recommendationEvents, pickIntents }, id);
    setWatched(next.watched);
    setRatings(next.ratings);
    setReviews(next.reviews);
    setReviewInsights(next.reviewInsights);
    setReviewAnalysisStatus((current) => { const next = { ...current }; delete next[id]; return next; });
    setLearningEvents(next.learningEvents);
    setRecommendationEvents(next.recommendationEvents);
    setPickIntents(next.pickIntents);
    setRatingPromptMovie((current) => current?.id === id ? null : current);
    setUnwatchConfirmation(null);
  }

  function toggleLike(movie: Movie) {
    const isLiked = Boolean(likes[movie.id]);
    touch(`like:${movie.id}`);
    setLikes((current) => {
      const next = { ...current };
      if (isLiked) delete next[movie.id]; else next[movie.id] = movie;
      return next;
    });
    setLearningEvents((current) => current.filter((event) => !(event.type === "like" && event.movie.id === movie.id)));
    if (!isLiked) learn("like", movie, "Liked", `like:${movie.id}`, "library");
    rememberMovies([movie]);
  }

  function rateMovie(movie: Movie, rating: number | null) {
    touch(`rating:${movie.id}`, `watched:${movie.id}`, `watchlist:${movie.id}`);
    if (rating === null) {
      setRatings((current) => { const next = { ...current }; delete next[movie.id]; return next; });
      setLearningEvents((current) => current.filter((event) => !(event.type === "rating" && event.movie.id === movie.id)));
      setPickIntents((current) => linkPickOutcome(current, movie.id, { rating: undefined }));
      setRecommendationEvents((current) => current.filter((event) => event.movieId !== movie.id || (event.type !== "rating" && event.type !== "highRating")));
      return;
    }
    const originatingPick = [...pickIntents].reverse().find((item) => item.movie.id === movie.id);
    setRatings((current) => ({ ...current, [movie.id]: rating }));
    setWatched((current) => ({ ...current, [movie.id]: current[movie.id] || { movie, watchedAt: Date.now() } }));
    setWatchlist((current) => { const next = { ...current }; delete next[movie.id]; return next; });
    setLearningEvents((current) => current.filter((event) => !(event.type === "rating" && event.movie.id === movie.id)));
    learn("rating", movie, `Rated ${formatRating(rating)} out of 5`, `rating:${movie.id}`);
    if (originatingPick) {
      setPickIntents((current) => linkPickOutcome(current, movie.id, { rating, watchedAt: originatingPick.watchedAt || Date.now() }));
      setRecommendationEvents((current) => current.filter((event) => event.movieId !== movie.id || (event.type !== "rating" && event.type !== "highRating")));
      recordRecommendation(recommendationEvent(rating >= 4 ? "highRating" : "rating", movie, originatingPick.score || 0, { rank: originatingPick.rank, pickId: originatingPick.id, rating }));
    }
  }

  function saveMovie(movie: Movie, replace = true) {
    if (watched[movie.id] || watchlist[movie.id]) return;
    touch(`watchlist:${movie.id}`); setWatchlist((current) => ({ ...current, [movie.id]: movie }));
    learn("watchlist", movie, "Saved to watchlist", `watchlist:${movie.id}`); if (replace) replacePick(movie.id);
  }

  function rejectMovie(movie: Movie, fromSprint = false) {
    touch(`interest:${movie.id}`); setInterest((current) => ({ ...current, [movie.id]: { movie, value: "notInterested", updatedAt: Date.now() } }));
    learn("interest", movie, "Not for me", `interest:${movie.id}`, fromSprint ? "sprint" : "pick"); replacePick(movie.id);
    if (fromSprint) advanceSprint(movie, true);
  }

  function chooseMovie(result: RecommendationResult) {
    if (pickCommitInFlight.current || committingPickId !== null) return;
    pickCommitInFlight.current = true;
    flushSync(() => setCommittingPickId(result.movie.id));
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const sourcePoster = document.querySelector<HTMLElement>(`[data-movie-id='${result.movie.id}'] .pick-poster`);
    const finalize = () => {
      const movie = result.movie;
      const rank = Math.max(1, pickSlots.findIndex((slot) => slot.value?.movie.id === movie.id) + 1);
      const event: PickIntentEvent = { id: uid("pick"), movie, createdAt: Date.now(), rank, score: result.score };
      const learningEvent: LearningEvent = { id: uid("learn"), type: "pick", movie, label: "Picked for tonight", createdAt: Date.now(), undoKey: `pick:${event.id}`, source: "pick" };
      flushSync(() => {
        setPickIntents((current) => [...current.filter((item) => item.movie.id !== movie.id), event].slice(-100));
        setLearningEvents((current) => [...current.filter((item) => !(item.type === "pick" && item.movie.id === movie.id)), learningEvent].slice(-100));
        recordRecommendation(recommendationEvent("pick", movie, result.score, { rank, pickId: event.id }));
        setSelectedPick(result);
      });
    };
    const complete = () => { pickCommitInFlight.current = false; setCommittingPickId(null); };
    if (reduceMotion) { finalize(); complete(); return; }
    window.requestAnimationFrame(() => {
      const transitionDocument = document as Document & { startViewTransition?: (callback: () => void) => { finished: Promise<void> } };
      if (transitionDocument.startViewTransition) {
        const transition = transitionDocument.startViewTransition(finalize);
        void transition.finished.finally(complete);
      } else {
        const sourceRect = sourcePoster?.getBoundingClientRect();
        const clone = sourcePoster?.cloneNode(true) as HTMLElement | undefined;
        if (clone && sourceRect) {
          Object.assign(clone.style, { position: "fixed", left: `${sourceRect.left}px`, top: `${sourceRect.top}px`, width: `${sourceRect.width}px`, height: `${sourceRect.height}px`, margin: "0", zIndex: "70", pointerEvents: "none", objectFit: "contain" });
          clone.className = "pick-transition-clone";
          document.body.appendChild(clone);
        }
        finalize();
        window.requestAnimationFrame(() => {
          const target = document.querySelector<HTMLElement>("[data-picked-poster] img");
          const targetRect = target?.getBoundingClientRect();
          if (!clone || !sourceRect || !target || !targetRect) { clone?.remove(); complete(); return; }
          target.style.visibility = "hidden";
          const animation = clone.animate([{ transform: "translate(0, 0) scale(1)" }, { transform: `translate(${targetRect.left - sourceRect.left}px, ${targetRect.top - sourceRect.top}px) scale(${targetRect.width / sourceRect.width}, ${targetRect.height / sourceRect.height})` }], { duration: 650, easing: "cubic-bezier(.22, 1, .36, 1)", fill: "forwards" });
          void animation.finished.catch(() => undefined).finally(() => { target.style.visibility = ""; clone.remove(); complete(); });
        });
      }
    });
  }

  useEffect(() => {
    if (tourOpen || ratingPromptMovie || outcomePrompt) return;
    const timeout = window.setTimeout(() => {
      const pending = [...pickIntents].reverse().find((item) => item.createdAt < sessionStartedAt.current
        && !item.watchedAt && item.rating === undefined && !watched[item.movie.id]
        && !promptedOutcomeIds.current.has(item.id));
      if (!pending) return;
      promptedOutcomeIds.current.add(pending.id);
      setOutcomePrompt(pending);
    }, 1200);
    return () => window.clearTimeout(timeout);
  }, [outcomePrompt, pickIntents, ratingPromptMovie, tourOpen, watched]);

  useEffect(() => {
    const movie = activeSprintCandidate?.movie;
    if (!movie?.posterPath) return;
    const image = new Image();
    image.src = posterUrl(movie.posterPath, "w500");
  }, [activeSprintCandidate?.movie.posterPath]);

  useEffect(() => {
    if (activeSprintCandidate && activeSprintCandidate.movie.id !== sprintCurrentId) setSprintCurrentId(activeSprintCandidate.movie.id);
  }, [activeSprintCandidate, sprintCurrentId]);

  useEffect(() => { if (activeLearningCandidates.length < 40 && !sprintBusy.current) void refillSprint(); }, [activeLearningCandidates.length]);

  async function refillSprint() {
    if (sprintBusy.current) return;
    if (!hasTmdbKey()) {
      if (!activeSprintCandidate) setSprintError("You have answered every movie available on this device. Add a TMDB connection for more.");
      return;
    }
    sprintBusy.current = true; setSprintLoading(true); setSprintError("");
    try {
      for (let attempts = 0; attempts < 4; attempts += 1) {
        const result = await getTasteSprintMovies(sprintPage.current++); rememberMovies(result.movies);
        if (result.movies.length) {
          setSprintCandidates((current) => mergeMovies(current, result.movies).slice(-120));
          break;
        }
        if (!result.hasMore) break;
      }
    } catch { setSprintError("Could not load more movies."); }
    finally { sprintBusy.current = false; setSprintLoading(false); }
  }

  function advanceSprint(movie: Movie, count = true) {
    setSprintCurrentId(null); if (count) setTasteDecisions((value) => value + 1);
  }

  function answerSprint(movie: Movie, value: InterestValue) {
    touch(`interest:${movie.id}`); setInterest((current) => ({ ...current, [movie.id]: { movie, value, updatedAt: Date.now() } }));
    learn("interest", movie, value === "interested" ? "Interested" : value === "maybe" ? "Maybe" : "Not for me", `interest:${movie.id}`, "sprint");
    advanceSprint(movie);
  }

  function undoLearning(event: LearningEvent) {
    const [kind, id, previous] = (event.undoKey || "").split(":");
    if (["interest", "watchlist", "watched", "rating", "like"].includes(kind) && id) touch(`${kind}:${id}`);
    if (kind === "interest") setInterest((current) => { const next = { ...current }; delete next[id]; return next; });
    if (kind === "like") setLikes((current) => { const next = { ...current }; delete next[id]; return next; });
    if (kind === "watchlist") setWatchlist((current) => { const next = { ...current }; delete next[id]; return next; });
    if (kind === "watched") {
      setWatched((current) => { const next = { ...current }; delete next[id]; return next; });
      if (previous === "saved") setWatchlist((current) => ({ ...current, [id]: event.movie }));
      setPickIntents((current) => linkPickOutcome(current, Number(id), { watchedAt: undefined }));
      setRecommendationEvents((current) => current.filter((item) => item.movieId !== Number(id) || item.type !== "watched"));
    }
    if (kind === "rating") setRatings((current) => { const next = { ...current }; delete next[id]; return next; });
    if (kind === "pick") setPickIntents((current) => current.filter((item) => item.id !== id));
    if (event.source === "sprint" && (kind === "interest" || kind === "watched")) {
      setSprintCurrentId(event.movie.id);
      setTasteDecisions((value) => Math.max(0, value - 1));
    }
    setLearningEvents((current) => current.filter((item) => item.id !== event.id));
  }

  async function openMovie(movie: Movie) {
    const visibleRank = visibleResults.findIndex((result) => result.movie.id === movie.id);
    if (visibleRank >= 0) recordRecommendation(recommendationEvent("open", movie, visibleResults[visibleRank].score, { rank: visibleRank + 1 }));
    setDetailMovie(movie); setDetailLoading(true);
    try { const detail = await getMovieDetails(movie); setDetailMovie(detail); rememberMovies([detail]); }
    catch { setDetailMovie(movie); }
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

  async function handleMovieImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    event.target.value = "";
    importAbort.current?.abort();
    const controller = new AbortController();
    importAbort.current = controller;
    setImportError("");
    try {
      const parsed = await parseMovieImportFile(file, allMovies);
      if (controller.signal.aborted) return;
      setImportSummary(parsed.summary);
      setImportRows([]);
      setImportProgress({ completed: 0, total: parsed.rows.length, matched: 0 });
      setImportOpen(true);
      setImportResolving(true);
      const resolved = await resolveMovieCsvRows(parsed.rows, searchMoviesForImport, { signal: controller.signal, onProgress: setImportProgress });
      if (controller.signal.aborted) return;
      setImportRows(resolved);
      rememberMovies(resolved.flatMap((row) => row.matchedMovie ? [row.matchedMovie] : []));
    } catch (error) {
      if (controller.signal.aborted) return;
      setImportSummary(null);
      setImportRows([]);
      setImportError(error instanceof Error ? error.message : "This import could not be read.");
      setImportOpen(true);
    } finally {
      if (importAbort.current === controller) { setImportResolving(false); importAbort.current = null; }
    }
  }

  function closeImport() {
    importAbort.current?.abort();
    importAbort.current = null;
    setImportOpen(false);
    setImportResolving(false);
    setImportRows([]);
    setImportSummary(null);
    setImportProgress({ completed: 0, total: 0, matched: 0 });
    setImportError("");
  }

  function confirmImport() {
    const matchedRows = importRows.filter((row) => row.matchedMovie);
    const merged = mergeImportedRows(importRows, { ratings, likes, reviews, watched, watchlist });
    setRatings(merged.ratings); setLikes(merged.likes); setReviews(merged.reviews); setWatched(merged.watched); setWatchlist(merged.watchlist);
    if (importSummary?.kind.startsWith("letterboxd")) {
      setLetterboxdImportMeta({ lastImportedAt: Date.now(), movieCount: matchedRows.length, ratingCount: matchedRows.filter((row) => row.rating).length });
    }
    touchMany(merged.touched);
    setImportOpen(false);
    setImportRows([]);
    setImportSummary(null);
    setImportProgress({ completed: 0, total: 0, matched: 0 });
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
  function clearLocalData() {
    Object.values(storage).forEach((key) => localStorage.removeItem(key));
    localStorage.setItem(legacyMigrationDisabledKey, "true");
    window.location.reload();
  }
  function closeTour() { setTourOpen(false); writeJson(storage.tour, true); }

  const libraryMovies = useMemo(() => {
    const items = mergeMovies(Object.values(watchlist), Object.values(watched).map((entry) => entry.movie));
    return filterAndSortLibraryMovies({ movies: items, filter: libraryFilter, watchedFilter: libraryWatchedFilter, sort: librarySort, query: libraryQuery, ratings, likes, watched, watchlist });
  }, [watchlist, watched, ratings, likes, libraryFilter, libraryWatchedFilter, librarySort, libraryQuery]);

  const tasteSignals = useMemo(() => buildTasteSignals(tasteProfileMovies, ratings, likes, interest, preferences, reviewInsights), [tasteProfileMovies, ratings, likes, interest, preferences, reviewInsights]);
  const tasteStrength = useMemo(() => buildTasteStrength({ movies: tasteProfileMovies, ratings, likes, watched, interest, preferences, picks: pickIntents, model: collaborativeModel }), [tasteProfileMovies, ratings, likes, watched, interest, preferences, pickIntents, collaborativeModel]);
  const detailPrediction = useMemo(() => {
    if (!detailMovie || watched[detailMovie.id] || !predictionStarsReady || ratingCalibration.trainingCount < 8) return undefined;
    return candidatePredictions.get(detailMovie.id);
  }, [detailMovie, predictionStarsReady, ratingCalibration.trainingCount, watched, candidatePredictions]);
  const sprintMovie = activeSprintCandidate?.movie;
  return <div className={tab === "pick" && pickMode === "idle" ? "app-shell is-empty-pick" : "app-shell"}>
    <a className="skip-link" href="#main-content">Skip to content</a>
    {authFinishing && <div className="auth-return-status" role="status"><span/><strong>Finishing Google sign-in…</strong><small>Your movie data will load separately.</small></div>}
    <header className="site-header">
      <button className="wordmark" onClick={() => setTab("pick")}>PickAMovie</button>
      <nav className="desktop-nav" aria-label="Primary">{(["pick", "taste", "library"] as Tab[]).map((item) => <button key={item} className={tab === item ? "is-active" : ""} onClick={() => setTab(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</nav>
      <AccountHub configured={isSupabaseConfigured} session={session} open={settingsOpen} theme={theme} syncStatus={syncStatus} reviewConsent={reviewConsent} includeWatchlist={filters.includeWatchlist} letterboxdImportMeta={letterboxdImportMeta} onOpenChange={setSettingsOpen} onThemeChange={setTheme} onReviewConsentChange={(enabled) => { setReviewConsent(enabled); setReviewConsentAsked(true); }} onIncludeWatchlistChange={updateWatchlistRecommendationPreference} onImportLetterboxd={handleMovieImport} onReplayTour={() => { setTourSlide(0); setTourOpen(true); }} onSignOut={handleSignOut} onDeleteCloudData={handleDeleteCloudData} onClearLocalData={clearLocalData} />
    </header>

    <main id="main-content">
      {tab === "pick" && <PickView
        mode={pickMode} prompt={promptDraft} promptExplanation={promptExplanation} setPrompt={setPromptDraft} onSubmitPrompt={submitPrompt} onPersonalPick={startPersonalPick} filters={filters} setFilters={updatePickFilters} providerOpen={providerOpen} setProviderOpen={setProviderOpen} streamingConfigured={hasTmdbKey()}
        slots={pickMode === "idle" ? createPickSlots() : pickSlots} loading={pickMode !== "idle" && (pickLoading || streamingChecksPending)} loadingStage={pickLoadingStage} error={pickError} committingPickId={committingPickId}
        expandedReason={expandedReason} setExpandedReason={setExpandedReason} watched={watched} watchlist={watchlist}
        onWatched={markWatched} onSave={saveMovie} onPick={chooseMovie} onSwap={swapPick} onReject={rejectMovie} onOpen={openMovie} onClearStreaming={() => updatePickFilters((current) => ({ ...current, providerIds: [], includeTheaters: false }))} developerMode={developerMode}
      />}
      {tab === "taste" && <TasteView movie={sprintMovie} candidate={activeSprintCandidate} developerMode={developerMode} loading={sprintLoading} error={sprintError} watchlist={watchlist} ratings={ratings} signals={tasteSignals} events={learningEvents}
        preferences={preferences} ratingCalibration={ratingCalibration} ratingModelPending={ratingModelPending} ratingModelStage={ratingModelStage} movieIntelligenceProgress={movieIntelligenceProgress} tasteStrength={tasteStrength} onAnswer={answerSprint} onWatched={(movie) => markWatched(movie, true)} onSave={(movie) => saveMovie(movie, false)} onRetry={refillSprint} onUndo={undoLearning} onPreference={applyPreference} onFavorite={applyFavorite} onOpen={openMovie} />}
      {tab === "library" && <LibraryView movies={libraryMovies} filter={libraryFilter} setFilter={setLibraryFilter} watchedFilter={libraryWatchedFilter} setWatchedFilter={setLibraryWatchedFilter} sort={librarySort} setSort={setLibrarySort} query={libraryQuery} setQuery={setLibraryQuery} ratings={ratings} likes={likes} watched={watched} watchlist={watchlist}
        onOpen={openMovie} onAdd={() => setAddOpen(true)} onImport={handleMovieImport} onToggleWatched={requestUnwatch} onToggleLike={toggleLike} />}
    </main>

    <nav className="mobile-nav" aria-label="Primary">{(["pick", "taste", "library"] as Tab[]).map((item) => <button key={item} className={tab === item ? "is-active" : ""} onClick={() => setTab(item)}><span className="mobile-nav-dot" />{item[0].toUpperCase() + item.slice(1)}</button>)}</nav>

    {selectedPick && <SelectedPick result={selectedPick} availability={availability[selectedPick.movie.id]} onBack={() => setSelectedPick(null)} onWatched={() => { markWatched(selectedPick.movie); setSelectedPick(null); }} onOpen={() => openMovie(selectedPick.movie)} />}
    {outcomePrompt && <OutcomePrompt movie={outcomePrompt.movie} onWatched={() => { setOutcomePrompt(null); markWatched(outcomePrompt.movie); }} onNotYet={() => setOutcomePrompt(null)} onOpen={() => openMovie(outcomePrompt.movie)} />}
    {ratingPromptMovie && <RatingPrompt movie={ratingPromptMovie} value={ratings[ratingPromptMovie.id]} onRate={(value) => rateMovie(ratingPromptMovie, value)} onDismiss={() => setRatingPromptMovie(null)} onOpen={() => openMovie(ratingPromptMovie)} />}
    {detailMovie && <MovieDetail movie={detailMovie} loading={detailLoading} prediction={detailPrediction} rating={ratings[detailMovie.id]} liked={Boolean(likes[detailMovie.id])} watched={Boolean(watched[detailMovie.id])} saved={Boolean(watchlist[detailMovie.id])} rejected={interest[detailMovie.id]?.value === "notInterested"} review={reviews[detailMovie.id] || ""} aspects={reviewInsights[detailMovie.id] || []} reviewStatus={reviewAnalysisStatus[detailMovie.id] || ""}
      onClose={() => setDetailMovie(null)} onRate={(value) => rateMovie(detailMovie, value)} onToggleLike={() => toggleLike(detailMovie)} onToggleWatched={() => watched[detailMovie.id] ? requestUnwatch(detailMovie) : markWatched(detailMovie)} onSave={() => watchlist[detailMovie.id] ? removeFromWatchlist(detailMovie) : saveMovie(detailMovie, false)} onRestore={() => restoreMovie(detailMovie)} onReview={(value) => updateReview(detailMovie, value)} onUpdateAspect={(id, label, sentiment) => updateAspect(detailMovie.id, id, label, sentiment)} onRemoveAspect={(id) => removeAspect(detailMovie.id, id)} />}
    {unwatchConfirmation && <UnwatchConfirmation movie={unwatchConfirmation} onCancel={() => setUnwatchConfirmation(null)} onConfirm={() => unwatchMovie(unwatchConfirmation)} />}
    {addOpen && <AddMovieDialog query={addQuery} setQuery={setAddQuery} results={addResults} onClose={() => setAddOpen(false)} onWatched={(movie) => { markWatched(movie); setAddOpen(false); }} onSave={(movie) => { saveMovie(movie, false); setAddOpen(false); }} onOpen={openMovie} />}
    {importOpen && <ImportDialog rows={importRows} summary={importSummary} error={importError} resolving={importResolving} progress={importProgress} onClose={closeImport} onConfirm={confirmImport} />}
    {reviewConsentPrompt && <ConsentDialog onDecline={() => { setReviewConsentAsked(true); setReviewAnalysisStatus((current) => ({ ...current, [reviewConsentPrompt.id]: "Review saved without analysis." })); setReviewConsentPrompt(null); }} onAccept={() => { setReviewConsent(true); setReviewConsentAsked(true); void runReviewAnalysis(reviewConsentPrompt); setReviewConsentPrompt(null); }} />}
    {tourOpen && <OnboardingTour slide={tourSlide} setSlide={setTourSlide} onClose={closeTour} preferences={preferences} onPreference={applyPreference} onFavorite={applyFavorite} importSummary={importSummary} importMeta={letterboxdImportMeta} onImport={handleMovieImport} onOpen={openMovie} />}
  </div>;
}

function PickView(props: {
  mode: PickMode; prompt: string; promptExplanation: string; setPrompt: (value: string) => void; onSubmitPrompt: () => void; onPersonalPick: () => void; filters: PickFilters; setFilters: (updater: (current: PickFilters) => PickFilters) => void;
  providerOpen: boolean; setProviderOpen: (value: boolean) => void; slots: PickSlot<RecommendationResult>[]; loading: boolean; loadingStage: string; error: string; committingPickId: number | null;
  expandedReason: number | null; setExpandedReason: (id: number | null) => void; watched: WatchedMap; watchlist: WatchlistMap;
  onWatched: (movie: Movie) => void; onSave: (movie: Movie) => void; onPick: (result: RecommendationResult) => void; onSwap: (result: RecommendationResult) => void; onReject: (movie: Movie) => void; onOpen: (movie: Movie) => void; onClearStreaming: () => void; developerMode: boolean; streamingConfigured: boolean;
}) {
  const filterRowRef = useRef<HTMLDivElement>(null);
  const selectedProviderGroups = watchProviderOptions.filter((provider) => provider.ids.every((id) => props.filters.providerIds.includes(id))).length;
  const selectedWatchLocations = selectedProviderGroups + (props.filters.includeTheaters ? 1 : 0);
  const toggleProviderGroup = (ids: readonly number[]) => props.setFilters((current) => {
    const selected = ids.every((id) => current.providerIds.includes(id));
    const next = new Set(current.providerIds);
    ids.forEach((id) => selected ? next.delete(id) : next.add(id));
    return { ...current, providerIds: [...next] };
  });
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".filter-menu")) {
        filterRowRef.current?.querySelectorAll<HTMLDetailsElement>("details[open]").forEach((details) => details.removeAttribute("open"));
      }
      if (!target?.closest(".provider-filter")) props.setProviderOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [props.setProviderOpen]);
  const promptForm = <form className="prompt-field" autoComplete="off" onSubmit={(event) => { event.preventDefault(); props.onSubmitPrompt(); }}><Icon name="search" /><label className="sr-only" htmlFor="pick-prompt">Describe what you want to watch</label><input id="pick-prompt" name="pickamovie-tonight-prompt" autoComplete="off" aria-autocomplete="none" value={props.prompt} onChange={(event) => props.setPrompt(event.target.value)} placeholder="What sounds good tonight?" /><button className="prompt-submit" type="submit" aria-label="Find three movies">→</button></form>;
  const filterControls = <div className="filter-row" aria-label="Recommendation filters" ref={filterRowRef}>
    <RuntimeFilter filters={props.filters} setFilters={props.setFilters} />
    <MultiSelectFilter label="Genre" values={props.filters.genres} options={genreOptions} onToggle={(genre) => props.setFilters((current) => ({ ...current, genres: current.genres.includes(genre) ? current.genres.filter((item) => item !== genre) : [...current.genres, genre] }))} />
    <MultiSelectFilter label="Era" values={props.filters.eras} options={eraOptions.map(([value, label]) => [value, label])} onToggle={(era) => props.setFilters((current) => ({ ...current, eras: current.eras.includes(era) ? current.eras.filter((item) => item !== era) : [...current.eras, era] }))} />
    <div className="provider-filter"><button className={selectedWatchLocations ? "filter-button is-active" : "filter-button"} disabled={!props.streamingConfigured} title={props.streamingConfigured ? undefined : "Availability is not configured"} aria-expanded={props.providerOpen} onClick={() => props.setProviderOpen(!props.providerOpen)}>Where to watch{selectedWatchLocations ? ` · ${selectedWatchLocations}` : ""}<Icon name="chevron" /></button>
      {props.providerOpen && <div className="provider-popover"><div className="provider-options"><label className="theater-option"><input type="checkbox" checked={props.filters.includeTheaters} onChange={() => props.setFilters((current) => ({ ...current, includeTheaters: !current.includeTheaters }))} />In theaters</label>{watchProviderOptions.map((provider) => <label key={provider.label}><input type="checkbox" checked={provider.ids.every((id) => props.filters.providerIds.includes(id))} onChange={() => toggleProviderGroup(provider.ids)} />{provider.label}</label>)}</div></div>}
    </div>
  </div>;
  return <section className={props.mode === "idle" ? "pick-page is-empty page-enter" : "pick-page page-enter"}>
    <div className="pick-controls">
      {props.mode === "idle" ? <>
        {filterControls}
        <button className="primary-button personal-pick-button" onClick={props.onPersonalPick}><Icon name="spark" />Pick for me</button>
        <div className="decision-divider"><span>or describe what sounds good tonight</span></div>{promptForm}
      </> : <>{promptForm}{filterControls}</>}
      {props.mode === "prompt" && props.promptExplanation && !props.loading && <p className="prompt-explanation">{props.promptExplanation}</p>}
    </div>
    {props.error && <p className="quiet-notice" role="status">{props.error}</p>}
    {props.loading && props.loadingStage && <p className="search-stage" role="status">{props.loadingStage}</p>}
    {props.mode !== "idle" && (props.loading || props.slots.some((slot) => slot.value)) && <div className="pick-stage" aria-live="polite">
      {props.loading ? <>{[1, 2, 3].map((slot) => <div className="pick-card skeleton-card" key={slot}><div className="poster-skeleton"/><div className="line-skeleton"/><div className="button-skeleton"/></div>)}</> : props.slots.map((slot, index) => slot.value ? <RecommendationCard key={slot.id} result={slot.value} rank={index + 1} expanded={props.expandedReason === slot.value.movie.id} onExpand={() => props.setExpandedReason(props.expandedReason === slot.value!.movie.id ? null : slot.value!.movie.id)} onWatched={() => props.onWatched(slot.value!.movie)} onSave={() => props.onSave(slot.value!.movie)} onPick={() => props.onPick(slot.value!)} onSwap={() => props.onSwap(slot.value!)} onReject={() => props.onReject(slot.value!.movie)} onOpen={() => props.onOpen(slot.value!.movie)} saved={Boolean(props.watchlist[slot.value.movie.id])} developerMode={props.developerMode} committingPickId={props.committingPickId} /> : <article className="pick-card empty-pick-slot" key={slot.id}><div><Icon name="spark"/><h2>No other match</h2><p>Try broader filters to fill this spot.</p></div></article>)}
    </div>}
    {props.mode !== "idle" && !props.loading && props.slots.every((slot) => !slot.value) && <div className="empty-state"><h2>{props.filters.providerIds.length || props.filters.includeTheaters ? "No verified matches" : "No matches found"}</h2><p>Try broader filters or describe a different kind of night.</p>{(props.filters.providerIds.length > 0 || props.filters.includeTheaters) && <button className="secondary-button" onClick={props.onClearStreaming}>Clear where-to-watch filter</button>}</div>}
  </section>;
}

function MultiSelectFilter({ label, values, options, onToggle }: { label: string; values: string[]; options: ReadonlyArray<readonly [string, string]>; onToggle: (value: string) => void }) {
  return <details className="filter-menu" name="pick-filter"><summary className={values.length ? "filter-button is-active" : "filter-button"}>{label}{values.length ? ` · ${values.length}` : ""}<Icon name="chevron" /></summary><div className="filter-popover checkbox-options">{options.map(([value, optionLabel]) => <label key={value}><input type="checkbox" checked={values.includes(value)} onChange={() => onToggle(value)} />{optionLabel}</label>)}</div></details>;
}

function RuntimeFilter({ filters, setFilters }: { filters: PickFilters; setFilters: (updater: (current: PickFilters) => PickFilters) => void }) {
  const constrained = filters.runtimeMin > 30 || filters.runtimeMax < 300;
  const label = constrained ? `${filters.runtimeMin}–${filters.runtimeMax === 300 ? "300+" : filters.runtimeMax} min` : "Runtime";
  const lowPosition = ((filters.runtimeMin - 30) / 270) * 100;
  const highPosition = ((filters.runtimeMax - 30) / 270) * 100;
  return <details className="filter-menu runtime-menu" name="pick-filter"><summary className={constrained ? "filter-button is-active" : "filter-button"}>{label}<Icon name="chevron" /></summary><div className="filter-popover runtime-popover"><div className="runtime-values"><span>{filters.runtimeMin} min</span><span>{filters.runtimeMax === 300 ? "300+ min" : `${filters.runtimeMax} min`}</span></div><div className="dual-range" style={{ "--range-start": `${lowPosition}%`, "--range-end": `${highPosition}%` } as CSSProperties}><input aria-label="Minimum runtime" type="range" min="30" max="300" step="5" value={filters.runtimeMin} onChange={(event) => setFilters((current) => ({ ...current, runtimeMin: Math.min(Number(event.target.value), current.runtimeMax - 5) }))} /><input aria-label="Maximum runtime" type="range" min="30" max="300" step="5" value={filters.runtimeMax} onChange={(event) => setFilters((current) => ({ ...current, runtimeMax: Math.max(Number(event.target.value), current.runtimeMin + 5) }))} /></div><button className="text-action" onClick={() => setFilters((current) => ({ ...current, runtimeMin: 30, runtimeMax: 300 }))}>Reset runtime</button></div></details>;
}

function RecommendationCard({ result, rank, expanded, saved, onExpand, onWatched, onSave, onPick, onSwap, onReject, onOpen, developerMode, committingPickId }: { result: RecommendationResult; rank: number; expanded: boolean; saved: boolean; onExpand: () => void; onWatched: () => void; onSave: () => void; onPick: () => void; onSwap: () => void; onReject: () => void; onOpen: () => void; developerMode: boolean; committingPickId: number | null }) {
  const committing = committingPickId === result.movie.id;
  const disabled = committingPickId !== null;
  return <article data-movie-id={result.movie.id} className={`pick-card${committing ? " is-committing" : disabled ? " is-dimmed" : ""}`}>
    <div className="ranked-poster"><button type="button" className="poster-open-button" style={committing ? { viewTransitionName: "picked-poster" } : undefined} onClick={onOpen} aria-label={`View details for ${result.movie.title}`} disabled={disabled}><MoviePosterImage className="pick-poster" movie={result.movie} size="w500" alt={`Poster for ${result.movie.title}`} priority={rank === 1} eager /></button></div>
    <div className="pick-copy"><h2>{result.movie.title}</h2><div className="movie-meta"><span>{result.movie.year}</span><span>{shortRuntime(result.movie)}</span>{result.predictedRating && <span className="predicted-rating">Predicted for you {formatRating(result.predictedRating.predictedRating)}</span>}</div><button className="reason-line" onClick={onExpand}>{result.reason}<Icon name="chevron" /></button>
      {expanded && <div className="reason-evidence"><strong>Why this?</strong>{result.evidenceItems.length ? <ul>{result.evidenceItems.map((item) => <li key={item.id}><span>{item.category}</span>{item.text}</li>)}</ul> : <p>{result.evidence}</p>}{developerMode && <code>score {result.score.toFixed(3)}{result.predictedRating ? ` · prediction confidence ${result.predictedRating.confidence.toFixed(2)}` : ""}</code>}</div>}
    </div>
    <div className="pick-actions"><button className="secondary-button" onClick={onWatched} disabled={disabled}><Icon name="eye"/>Watched</button><button className="secondary-button" onClick={onSave} disabled={saved || disabled}><Icon name="bookmark"/>{saved ? "Saved" : "Save"}</button><button className="primary-button pick-this" onClick={onPick} disabled={disabled}>{committing ? "Making it final…" : "Pick this"}</button><button className="text-action swap-action" onClick={onSwap} disabled={disabled}>Swap this</button><button className="text-action" onClick={onReject} disabled={disabled}>Not for me</button></div>
  </article>;
}

function GenrePreferenceSelect({ values, onToggle }: { values: string[]; onToggle: (genre: string) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("click", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("click", closeOutside); document.removeEventListener("keydown", closeOnEscape); };
  }, [open]);
  return <div className="genre-preference" ref={rootRef}><button type="button" className={values.length ? "preference-picker-trigger is-active" : "preference-picker-trigger"} aria-expanded={open} onClick={() => setOpen((current) => !current)}>Choose genres{values.length ? ` · ${values.length}` : ""}<Icon name="chevron" /></button>{open && <div className="genre-preference-menu"><div>{genreOptions.map(([value, label]) => <label key={value}><input type="checkbox" checked={values.includes(value)} onChange={() => onToggle(value)} />{label}</label>)}</div><button type="button" className="text-action" onClick={() => setOpen(false)}>Done</button></div>}</div>;
}

type PreferenceSearchKind = "actors" | "directors" | "movies";

function PreferenceSearchPicker(props: { kind: "actors" | "directors"; selected: string[]; onToggle: (name: string) => void } | { kind: "movies"; selected: Movie[]; onToggle: (movie: Movie) => void; onOpenMovie: (movie: Movie) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<PersonSearchResult[]>([]);
  const [movies, setMovies] = useState<Movie[]>([]);
  const [loading, setLoading] = useState(false);
  const selectedCount = props.selected.length;
  const singular = props.kind === "actors" ? "actor" : props.kind === "directors" ? "director" : "movie";
  const searchPlaceholder = props.kind === "actors" ? "Search for an actor" : `Search for a ${singular}`;
  const title = props.kind === "actors" ? "Choose actors" : props.kind === "directors" ? "Choose directors" : "Choose favorite movies";
  useEffect(() => {
    if (!open || query.trim().length < 2) { setPeople([]); setMovies([]); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    const timeout = window.setTimeout(() => {
      const request = props.kind === "movies"
        ? searchMovies(query).then((results) => { if (!cancelled) setMovies(results.slice(0, 10)); })
        : searchPeople(query, props.kind).then((results) => { if (!cancelled) setPeople(results); });
      request.catch(() => { if (!cancelled) { setPeople([]); setMovies([]); } }).finally(() => { if (!cancelled) setLoading(false); });
    }, 260);
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, [open, props.kind, query]);
  const close = () => { setOpen(false); setQuery(""); setPeople([]); setMovies([]); };
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open]);
  return <div className="preference-search-picker"><button type="button" className={selectedCount ? "preference-picker-trigger is-active" : "preference-picker-trigger"} onClick={() => setOpen(true)}>Search {props.kind}{selectedCount ? ` · ${selectedCount}` : ""}<Icon name="search" /></button><div className="preference-tags">{props.kind === "movies" ? props.selected.map((movie) => <button type="button" key={movie.id} onClick={() => props.onToggle(movie)}>{movie.title} ×</button>) : props.selected.map((name) => <button type="button" key={name} onClick={() => props.onToggle(name)}>{name} ×</button>)}</div>{open && <div className="preference-picker-backdrop" onMouseDown={close} onTouchStart={(event) => event.stopPropagation()} onTouchEnd={(event) => event.stopPropagation()}><section className="preference-picker-dialog" role="dialog" aria-modal="true" aria-labelledby={`preference-${props.kind}-title`} onMouseDown={(event) => event.stopPropagation()}><div className="sheet-heading"><h2 id={`preference-${props.kind}-title`}>{title}</h2><button type="button" className="icon-button" onClick={close} aria-label={`Close ${singular} search`}>×</button></div><label className="library-search"><Icon name="search"/><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={searchPlaceholder} /></label><div className="preference-search-results">{loading ? <p>Searching…</p> : query.trim().length < 2 ? <p>Type at least two letters to search.</p> : props.kind === "movies" ? movies.length ? movies.map((movie) => { const selected = props.selected.some((item) => item.id === movie.id); return <div className={selected ? "preference-movie-result is-selected" : "preference-movie-result"} key={movie.id}><button type="button" className="preference-result-poster" onClick={() => props.onOpenMovie(movie)} aria-label={`View details for ${movie.title}`}><span className="preference-result-image">{movie.posterPath ? <MoviePosterImage movie={movie} size="w92" /> : <i aria-hidden="true">🎬</i>}</span></button><button type="button" className="preference-result-select" onClick={() => props.onToggle(movie)}><span><strong>{movie.title}</strong><small>{movie.year} · {movie.genres.slice(0, 2).join(" · ")}</small></span><b>{selected ? "Selected" : "Select"}</b></button></div>; }) : <p>No matching movies found.</p> : people.length ? people.map((person) => { const selected = props.selected.includes(person.name); return <button type="button" className={selected ? "is-selected" : ""} key={person.id} onClick={() => props.onToggle(person.name)}><span className="preference-result-image">{person.profilePath ? <img src={profileUrl(person.profilePath)} alt="" loading="lazy" decoding="async" width="185" height="278"/> : <i aria-hidden="true">👤</i>}</span><span><strong>{person.name}</strong><small>{[person.department, person.knownFor.join(", ")].filter(Boolean).join(" · ")}</small></span><b>{selected ? "Selected" : "Select"}</b></button>; }) : <p>No matching people found.</p>}</div><button type="button" className="primary-button preference-picker-done" onClick={close}>Done</button></section></div>}</div>;
}

function PreferenceControls({ preferences, onPreference, onFavorite, onOpenMovie, compact = false }: { preferences: OnboardingPreferences; onPreference: (kind: "genres" | "directors" | "actors", value: string) => void; onFavorite: (movie: Movie) => void; onOpenMovie: (movie: Movie) => void; compact?: boolean }) {
  return <div className={compact ? "preference-controls is-compact" : "preference-controls"}><div className="preference-control-row"><strong>Genres</strong><GenrePreferenceSelect values={preferences.genres} onToggle={(genre) => onPreference("genres", genre)} /></div><div className="preference-control-row"><strong>Directors you like</strong><PreferenceSearchPicker kind="directors" selected={preferences.directors} onToggle={(name) => onPreference("directors", name)} /></div><div className="preference-control-row"><strong>Actors you like</strong><PreferenceSearchPicker kind="actors" selected={preferences.actors} onToggle={(name) => onPreference("actors", name)} /></div><div className="preference-control-row"><strong>Favorite movies</strong><PreferenceSearchPicker kind="movies" selected={Object.values(preferences.favoriteMovies)} onToggle={onFavorite} onOpenMovie={onOpenMovie} /></div></div>;
}

function TasteView(props: { movie?: Movie; candidate: TasteSprintCandidate | null; developerMode: boolean; loading: boolean; error: string; watchlist: WatchlistMap; ratings: RatingMap; signals: TasteSignal[]; events: LearningEvent[]; preferences: OnboardingPreferences; ratingCalibration: RatingCalibration; ratingModelPending: boolean; ratingModelStage: string; movieIntelligenceProgress: MovieIntelligenceProgress | null; tasteStrength: TasteStrength; onAnswer: (movie: Movie, value: InterestValue) => void; onWatched: (movie: Movie) => void; onSave: (movie: Movie) => void; onRetry: () => void; onUndo: (event: LearningEvent) => void; onPreference: (kind: "genres" | "directors" | "actors", value: string) => void; onFavorite: (movie: Movie) => void; onOpen: (movie: Movie) => void }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  return <section className="taste-page page-enter">
    <div className="sprint-section"><div className="section-title-row"><div><h1>Taste Sprint</h1><p>Keep going whenever you want sharper recommendations.</p></div></div>
      {props.movie ? <div className="sprint-stage"><button type="button" className="poster-open-button" onClick={() => props.onOpen(props.movie!)} aria-label={`View details for ${props.movie.title}`}><MoviePosterImage movie={props.movie} size="w500" alt={`Poster for ${props.movie.title}`} priority /></button><div className="sprint-response"><h2>{props.movie.title}</h2><p>{props.movie.year} · {props.movie.genres.slice(0, 2).join(" · ")}</p>{props.developerMode && props.candidate && <code className="sprint-diagnostic">utility {props.candidate.utility.toFixed(3)} · uncertainty {props.candidate.uncertainty.toFixed(2)} · coverage {props.candidate.coverage.toFixed(2)} · answerability {props.candidate.answerability.toFixed(2)} · diversity {props.candidate.diversity.toFixed(2)}</code>}<button onClick={() => props.onAnswer(props.movie!, "interested")}>Interested</button><button onClick={() => props.onAnswer(props.movie!, "maybe")}>Maybe</button><button onClick={() => props.onAnswer(props.movie!, "notInterested")}>Not for me</button><div className="sprint-secondary"><button onClick={() => props.onWatched(props.movie!)}><Icon name="eye"/>Watched</button><button onClick={() => props.onSave(props.movie!)} disabled={Boolean(props.watchlist[props.movie.id])}><Icon name="bookmark"/>{props.watchlist[props.movie.id] ? "Saved" : "Save"}</button></div></div></div> : <div className="empty-state"><h2>{props.loading ? "Finding another movie…" : "You reached the end of this batch"}</h2>{props.error && <p>{props.error}</p>}{!props.loading && <button className="secondary-button" onClick={props.onRetry}>Load more</button>}</div>}
    </div>
    <div className="taste-lab"><div className="taste-summary"><TasteStrengthCard strength={props.tasteStrength}/><h2>Your taste</h2>{props.signals.length ? <div className="taste-signals" aria-label="Current taste signals">{props.signals.slice(0, 6).map((signal) => <div className="taste-signal" key={signal.id}><span><strong>{signal.label}</strong><small>{signal.category} · {signal.evidence} {signal.evidence === 1 ? "signal" : "signals"}</small></span><i><b style={{ width: `${Math.max(8, signal.weight * 100)}%` }}/></i></div>)}</div> : <p className="empty-copy">Ratings, reactions, and preferences will build your taste summary.</p>}
      <details className="preference-editor"><summary>Edit preferences</summary><PreferenceControls preferences={props.preferences} onPreference={props.onPreference} onFavorite={props.onFavorite} onOpenMovie={props.onOpen} /></details>
      <PredictionCheck calibration={props.ratingCalibration} pending={props.ratingModelPending} stage={props.ratingModelStage} intelligenceProgress={props.movieIntelligenceProgress} /></div>
      <div className="learning-log"><h2>Recently learned</h2>{props.events.slice(-6).reverse().map((event) => <LearningRow key={event.id} event={event} rating={props.ratings[event.movie.id]} onOpen={props.onOpen} onUndo={props.onUndo}/>) }{!props.events.length && <p className="empty-copy">Your reactions will appear here.</p>}{props.events.length > 6 && <button className="secondary-button learning-see-more" onClick={() => setHistoryOpen(true)}>See more</button>}</div>
    </div>
    {historyOpen && <LearningHistoryDialog events={props.events} ratings={props.ratings} onClose={() => setHistoryOpen(false)} onOpen={props.onOpen} onUndo={props.onUndo}/>}
  </section>;
}

function TasteStrengthCard({ strength }: { strength: TasteStrength }) {
  return <section className="taste-strength-card" aria-label={`Taste Strength ${strength.score} out of 100`}><div><span>Taste Strength</span><strong>{strength.score}<small>/100</small></strong></div><i><b style={{ width: `${strength.score}%` }}/></i><p>{strength.nextStep}</p></section>;
}

function LearningRow({ event, rating, onOpen, onUndo }: { event: LearningEvent; rating?: number; onOpen: (movie: Movie) => void; onUndo: (event: LearningEvent) => void }) {
  return <div className="learning-row"><button type="button" className="poster-open-button" onClick={() => onOpen(event.movie)} aria-label={`View details for ${event.movie.title}`}><MoviePosterImage movie={event.movie} size="w92" /></button><span><strong>{event.movie.title}</strong><small>{event.type === "rating" && rating ? <StarRating value={rating} readOnly compact /> : event.label}</small></span>{event.undoKey && <button onClick={() => onUndo(event)}>Undo</button>}</div>;
}

function LearningHistoryDialog({ events, ratings, onClose, onOpen, onUndo }: { events: LearningEvent[]; ratings: RatingMap; onClose: () => void; onOpen: (movie: Movie) => void; onUndo: (event: LearningEvent) => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); else trapDialogFocus(event, dialogRef.current); };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); returnFocus.current?.focus(); };
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="learning-history-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="learning-history-title" onMouseDown={(event) => event.stopPropagation()}><div className="sheet-heading"><div><h2 id="learning-history-title">Recently learned</h2><p>{events.length} saved taste signals</p></div><button className="icon-button" onClick={onClose} aria-label="Close learning history">×</button></div><div className="learning-history-list">{events.slice(-100).reverse().map((event) => <LearningRow key={event.id} event={event} rating={ratings[event.movie.id]} onOpen={onOpen} onUndo={onUndo}/>)}</div></section></div>;
}

function PredictionCheck({ calibration, pending, stage, intelligenceProgress }: { calibration: RatingCalibration; pending: boolean; stage: string; intelligenceProgress: MovieIntelligenceProgress | null }) {
  const [infoOpen, setInfoOpen] = useState(false);
  const needed = Math.max(0, 8 - calibration.trainingCount);
  const ticks = [.5, 1, 2, 3, 4, 5];
  const buildingAction = needed
    ? `Rate ${needed} more watched ${needed === 1 ? "movie" : "movies"}.`
    : calibration.actualRatingSpread < .65 ? "Use more of the rating scale when it feels honest." : "Rate a few more movies you felt strongly about.";
  const progressLabel = stage === "features" ? "Preparing your movie history…" : stage === "validation" ? "Testing hidden ratings…" : stage === "calibration" ? "Calibrating predicted stars…" : "Updating your model…";
  return <section className="prediction-check" aria-labelledby="prediction-score-title" aria-busy={pending}>
    <div className="prediction-score-heading"><span id="prediction-score-title">Prediction Score</span><button type="button" className="prediction-info-button" aria-label="How the Prediction Score works" onClick={() => setInfoOpen(true)}>?</button></div>
    <strong className={`prediction-score ${pending || calibration.status === "building" ? "is-building" : ""}`}>{pending ? "Updating" : calibration.predictionScore === undefined ? "Building" : <>{calibration.predictionScore}<small>/100</small></>}</strong>
    {pending ? <p className="prediction-next-step">{progressLabel}</p> : calibration.status === "building" ? <p className="prediction-next-step">{buildingAction}</p> : calibration.status === "low-confidence" ? <p className="prediction-state">Low confidence</p> : null}
    {intelligenceProgress && <p className="prediction-enrichment" role="status">Learning richer movie details… {intelligenceProgress.completed.toLocaleString()} of {intelligenceProgress.total.toLocaleString()}</p>}
    {!pending && calibration.trainingCount >= 8 && <div className="calibration-chart" aria-label="Predicted ratings compared with actual ratings">
      <span className="calibration-y-label">Actual rating</span>
      <div className="calibration-y-ticks" aria-hidden="true">{ticks.map((tick) => <span key={tick} style={{ top: `${100 - ratingToPercent(tick)}%` }}>{tick}</span>)}</div>
      <div className="calibration-field">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {ticks.map((tick) => { const position = ratingToPercent(tick); return <g key={tick}><line className="calibration-grid-line" x1={position} y1="0" x2={position} y2="100"/><line className="calibration-grid-line" x1="0" y1={100 - position} x2="100" y2={100 - position}/></g>; })}
          <line className="calibration-ideal-line" x1="0" y1="100" x2="100" y2="0" />
        </svg>
        <PredictionCanvas points={calibration.points}/>
      </div>
      <div className="calibration-x-ticks" aria-hidden="true">{ticks.map((tick) => <span key={tick} style={{ left: `${ratingToPercent(tick)}%` }}>{tick}</span>)}</div>
      <strong className="calibration-x-label">Predicted rating</strong>
    </div>}
    {infoOpen && <PredictionInfoDialog calibration={calibration} onClose={() => setInfoOpen(false)} />}
  </section>;
}

function PredictionInfoDialog({ calibration, onClose }: { calibration: ReturnType<typeof buildRatingCalibration>; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); else trapDialogFocus(event, dialogRef.current); };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); returnFocus.current?.focus(); };
  }, [onClose]);
  const strongerBaseline = Math.min(calibration.userMeanBaselineError || Infinity, calibration.tmdbBaselineError || Infinity);
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="prediction-info-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="prediction-info-title" onMouseDown={(event) => event.stopPropagation()}><div className="sheet-heading"><h2 id="prediction-info-title">How your score works</h2><button className="icon-button" onClick={onClose} aria-label="Close Prediction Score explanation">×</button></div><p>PickAMovie hides ratings during testing, then asks the model which movie you rated higher. A score of 50 is about chance; 100 means every tested preference was ordered correctly.</p>{calibration.status === "building" ? <p>Your score is building until you have at least eight watched-and-rated movies across more than one rating level.</p> : calibration.status === "ready" ? <p>Your model is ready: it beat the stronger simple baseline and correctly ordered {calibration.predictionScore} out of 100 hidden comparisons.</p> : <p>You have enough data for a score, but the model is currently low confidence and is not influencing recommendations. This is an honest result, not an unfinished calculation.</p>}<p>The graph includes all {calibration.evaluationCount.toLocaleString()} movies tested without revealing their ratings to the model. Dense areas appear darker, and every point remains available by pointer or keyboard.</p><small>All personal training stays on this device. Public movie descriptions may be embedded by OpenAI and cached without ratings or reviews. Baseline ordering: {Math.round(calibration.pairwiseBaseline * 100)}/100 · hidden comparisons: {calibration.comparisonCount.toLocaleString()} · typical star error: {calibration.meanAbsoluteError.toFixed(1)} stars versus {Number.isFinite(strongerBaseline) ? strongerBaseline.toFixed(1) : "an unavailable"} baseline · {calibration.selectedModel} · {calibration.modelVersion}</small></section></div>;
}

function LibraryView(props: { movies: Movie[]; filter: LibraryFilter; setFilter: (filter: LibraryFilter) => void; watchedFilter: LibraryWatchedFilter; setWatchedFilter: (filter: LibraryWatchedFilter) => void; sort: LibrarySort; setSort: (sort: LibrarySort) => void; query: string; setQuery: (value: string) => void; ratings: RatingMap; likes: LikedMap; watched: WatchedMap; watchlist: WatchlistMap; onOpen: (movie: Movie) => void; onAdd: () => void; onImport: (event: ChangeEvent<HTMLInputElement>) => void; onToggleWatched: (movie: Movie) => void; onToggleLike: (movie: Movie) => void }) {
  const labels: Array<[LibraryFilter, string]> = [["watched", "Watched"], ["watchlist", "Watchlist"]];
  return <section className="library-page page-enter"><div className="library-heading"><div><h1>Library</h1><div className="library-tabs">{labels.map(([value, label]) => <button key={value} className={props.filter === value ? "is-active" : ""} onClick={() => props.setFilter(value)}>{label}</button>)}</div></div><div className="library-tools"><label className="library-search"><Icon name="search"/><input value={props.query} onChange={(event) => props.setQuery(event.target.value)} placeholder="Search your movies"/></label><button className="secondary-button" onClick={props.onAdd}><Icon name="plus"/>Add</button><label className="secondary-button file-button"><Icon name="upload"/>Import<input type="file" accept=".csv,.zip,text/csv,application/zip" onChange={props.onImport}/></label></div></div>
    {props.filter === "watched" && <div className="library-view-options"><label>Filter<select value={props.watchedFilter} onChange={(event) => props.setWatchedFilter(event.target.value as LibraryWatchedFilter)}><option value="all">All watched</option><option value="liked">Liked</option></select></label><label>Order<select value={props.sort} onChange={(event) => props.setSort(event.target.value as LibrarySort)}><option value="recent">Recently watched</option><option value="rating-high">Rating: high to low</option><option value="rating-low">Rating: low to high</option><option value="title">Title A–Z</option><option value="year-newest">Release year: newest</option></select></label></div>}
    {props.movies.length ? <div className="library-grid">{props.movies.map((movie, index) => <article className="library-card" key={movie.id}><button className="library-card-open" onClick={() => props.onOpen(movie)}><MoviePosterImage movie={movie} alt={`Poster for ${movie.title}`} eager={index < 6}/><span><strong>{movie.title}</strong><small>{movie.year}{props.ratings[movie.id] && <><span aria-hidden="true"> · </span><StarRating value={props.ratings[movie.id]} readOnly compact /></>}</small><i>{props.filter === "watched" ? "Watched" : "Watchlist"}</i></span></button>{props.filter === "watched" && <div className="library-card-actions"><button type="button" className="watched-toggle is-active" aria-pressed="true" onClick={() => props.onToggleWatched(movie)}><Icon name="eye"/>Watched</button><LikeButton liked={Boolean(props.likes[movie.id])} onClick={() => props.onToggleLike(movie)} /></div>}</article>)}</div> : <div className="empty-state"><h2>No movies here yet</h2><p>{props.filter === "watched" && props.watchedFilter === "liked" ? "Like a watched movie to find it here." : "Add a movie or use Pick to start your library."}</p><button className="primary-button" onClick={props.onAdd}>Add a movie</button></div>}
  </section>;
}

function LikeButton({ liked, onClick }: { liked: boolean; onClick: () => void }) {
  return <button type="button" className={liked ? "like-toggle is-active" : "like-toggle"} aria-pressed={liked} onClick={onClick}><Icon name="heart"/>{liked ? "Liked" : "Like"}</button>;
}

function SelectedPick({ result, availability, onBack, onWatched, onOpen }: { result: RecommendationResult; availability?: StreamingAvailability; onBack: () => void; onWatched: () => void; onOpen: () => void }) {
  const movie = result.movie;
  return <div className="selection-overlay"><button className="selection-back" onClick={onBack}>← Change my pick</button><article className="selection-card"><button type="button" data-picked-poster className="poster-open-button" style={{ viewTransitionName: "picked-poster" }} onClick={onOpen} aria-label={`View details for ${movie.title}`}><MoviePosterImage movie={movie} size="w500" alt={`Poster for ${movie.title}`} priority /></button><div><span className="selection-label">Tonight’s pick</span><h1>{movie.title}</h1><p className="selection-meta">{movie.year} · {shortRuntime(movie)} · {movie.genres.slice(0, 3).join(" · ")}</p>{result.predictedRating && <p className="selection-prediction">Predicted for you: {formatRating(result.predictedRating.predictedRating)}</p>}<p className="selection-overview">{movie.overview}</p><div className="selection-reason"><strong>Why this one</strong>{result.evidenceItems.length ? <ul>{result.evidenceItems.map((item) => <li key={item.id}>{item.text}</li>)}</ul> : <p>{result.evidence}</p>}</div><div className="where-to-watch"><strong>Streaming</strong>{availability?.region && availability.status !== "unavailable" ? availability.providers.length ? <div>{availability.providers.map((provider) => <span key={provider.id}>{provider.name}</span>)}</div> : <p>No subscription providers found in {availability.region}.</p> : <p>Availability could not be verified.</p>}{availability?.link && <a href={availability.link} target="_blank" rel="noreferrer">Check availability ↗</a>}<small>TMDB availability data powered by JustWatch · availability can change</small></div><button className="primary-button" onClick={onWatched}>Mark watched</button></div></article></div>;
}

function StarRating({ value, onChange, readOnly = false, compact = false }: { value?: number; onChange?: (rating: number) => void; readOnly?: boolean; compact?: boolean }) {
  const className = `star-rating${compact ? " is-compact" : ""}${readOnly ? " is-readonly" : ""}`;
  const stateFor = (star: number) => value && value >= star ? "is-full" : value === star - .5 ? "is-half" : "is-empty";
  const accessibleRating = value ? `Rated ${formatRating(value)} out of 5` : "Not rated";
  if (readOnly) return <span className={className} role="img" aria-label={accessibleRating}>{starValues.map((star) => <span className={`star-icon ${stateFor(star)}`} aria-hidden="true" key={star}>★</span>)}</span>;
  return <div className={className} role="group" aria-label={`Choose rating, ${accessibleRating.toLowerCase()}`}>{starValues.map((star) => {
    const nextRating = value === star - .5 ? star : star - .5;
    return <button type="button" key={star} onClick={() => onChange?.(nextRating)} aria-label={`Rate ${formatRating(nextRating)} out of 5`}><span className={`star-icon ${stateFor(star)}`} aria-hidden="true">★</span></button>;
  })}</div>;
}

function RatingPrompt({ movie, value, onRate, onDismiss, onOpen }: { movie: Movie; value?: number; onRate: (rating: number) => void; onDismiss: () => void; onOpen: () => void }) {
  return <aside className="rating-toast" aria-live="polite"><button type="button" className="poster-open-button" onClick={onOpen} aria-label={`View details for ${movie.title}`}><MoviePosterImage movie={movie} size="w92" eager /></button><div><strong>How was {movie.title}?</strong><StarRating value={value} onChange={onRate} /></div><button className="toast-close" onClick={onDismiss} aria-label={value ? "Done rating" : "Skip rating"}>×</button></aside>;
}

function OutcomePrompt({ movie, onWatched, onNotYet, onOpen }: { movie: Movie; onWatched: () => void; onNotYet: () => void; onOpen: () => void }) {
  return <aside className="rating-toast outcome-toast" aria-live="polite"><button type="button" className="poster-open-button" onClick={onOpen} aria-label={`View details for ${movie.title}`}><MoviePosterImage movie={movie} size="w92" eager /></button><div><strong>Did you watch {movie.title}?</strong><div className="outcome-actions"><button className="primary-button" onClick={onWatched}>Yes</button><button className="secondary-button" onClick={onNotYet}>Not yet</button></div></div><button className="toast-close" onClick={onNotYet} aria-label="Dismiss follow-up">×</button></aside>;
}

function MovieDetail(props: { movie: Movie; loading: boolean; prediction?: RatingPrediction; rating?: number; liked: boolean; watched: boolean; saved: boolean; rejected: boolean; review: string; reviewStatus: string; aspects: ReviewInsightMap[string]; onClose: () => void; onRate: (value: number | null) => void; onToggleLike: () => void; onToggleWatched: () => void; onSave: () => void; onRestore: () => void; onReview: (value: string) => void; onUpdateAspect: (id: string, label: string, sentiment: "positive" | "negative") => void; onRemoveAspect: (id: string) => void }) {
  const [reviewDraft, setReviewDraft] = useState(props.review);
  const [trailerOpen, setTrailerOpen] = useState(false);
  useEffect(() => { setReviewDraft(props.review); setTrailerOpen(false); }, [props.movie.id, props.review]);
  const trailerUrl = props.movie.trailerKey ? `https://www.youtube.com/watch?v=${props.movie.trailerKey}` : undefined;
  return <div className="modal-backdrop movie-detail-backdrop" onMouseDown={props.onClose}><article className="movie-detail-sheet" role="dialog" aria-modal="true" aria-labelledby="movie-detail-title" onMouseDown={(event) => event.stopPropagation()}><button className="icon-button detail-close" onClick={props.onClose} aria-label="Close movie details">×</button><MoviePosterImage className="detail-poster" movie={props.movie} size="w500" alt={`Poster for ${props.movie.title}`} priority/><div className="detail-copy"><div className="detail-title-row"><h1 id="movie-detail-title">{props.movie.title}</h1><LikeButton liked={props.liked} onClick={props.onToggleLike}/></div><p className="movie-meta detail-meta">{props.movie.year} · {shortRuntime(props.movie)} · {props.movie.genres.slice(0, 3).join(" · ")}</p>{!props.watched && props.prediction && <div className="detail-prediction" aria-label={`Predicted for you: ${formatRating(props.prediction.predictedRating)} out of 5 stars`}><span>Predicted for you</span><StarRating value={props.prediction.predictedRating} readOnly compact/><strong>{formatRating(props.prediction.predictedRating)}</strong></div>}<p className="detail-overview">{props.loading ? "Loading details…" : props.movie.overview}</p>{!props.loading && <dl className="detail-facts">{props.movie.director && <div><dt>Director</dt><dd>{props.movie.director}</dd></div>}{props.movie.cast?.length ? <div><dt>Cast</dt><dd>{props.movie.cast.join(", ")}</dd></div> : null}{props.movie.productionCountries?.length ? <div><dt>Production</dt><dd>{props.movie.productionCountries.join(", ")}</dd></div> : null}{props.movie.voteAverage ? <div><dt>TMDB score</dt><dd>{props.movie.voteAverage.toFixed(1)} / 10</dd></div> : null}</dl>}<div className="detail-actions"><button type="button" className="secondary-button" onClick={() => setTrailerOpen((open) => !open)} disabled={!props.movie.trailerKey}>{trailerOpen ? "Hide trailer" : "Watch trailer"}</button><button className={props.watched ? "secondary-button watched-toggle is-active" : "secondary-button watched-toggle"} aria-pressed={props.watched} onClick={props.onToggleWatched}>Watched</button><button className="secondary-button" onClick={props.onSave}>{props.saved ? "Unsave" : "Save"}</button></div>{trailerOpen && props.movie.trailerKey && <div className="trailer-expanded"><div className="trailer-frame"><iframe src={`https://www.youtube-nocookie.com/embed/${props.movie.trailerKey}`} title={`${props.movie.title} trailer`} loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen /></div><a href={trailerUrl} target="_blank" rel="noreferrer">Open on YouTube ↗</a></div>}{props.rejected && <button className="text-action detail-restore" onClick={props.onRestore}>Restore to recommendations</button>}<div className="rating-field"><strong>Your rating</strong><div className="rating-field-row"><StarRating value={props.rating} onChange={(rating) => props.onRate(rating)} />{props.rating && <button className="text-action" onClick={() => props.onRate(null)}>Remove rating</button>}</div></div><label className="review-field">Private review<textarea value={reviewDraft} onChange={(event) => setReviewDraft(event.target.value)} placeholder="What worked for you?"/><button className="primary-button" onClick={() => props.onReview(reviewDraft)}>Save review</button></label>{props.reviewStatus && <p className="review-status" aria-live="polite">{props.reviewStatus}</p>}{props.aspects.length > 0 && <div className="review-aspects"><strong>What this taught your recommendations</strong>{props.aspects.map((aspect) => <div className="review-aspect" key={aspect.id}><input aria-label="Taste signal" value={aspect.label} onChange={(event) => props.onUpdateAspect(aspect.id, event.target.value, aspect.sentiment)} /><select aria-label="Signal direction" value={aspect.sentiment} onChange={(event) => props.onUpdateAspect(aspect.id, aspect.label, event.target.value as "positive" | "negative")}><option value="positive">More like this</option><option value="negative">Less like this</option></select><button aria-label={`Remove ${aspect.label}`} onClick={() => props.onRemoveAspect(aspect.id)}>×</button></div>)}</div>}</div></article></div>;
}

function UnwatchConfirmation({ movie, onCancel, onConfirm }: { movie: Movie; onCancel: () => void; onConfirm: () => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); else trapDialogFocus(event, dialogRef.current); };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); returnFocus.current?.focus(); };
  }, [onCancel]);
  return <div className="modal-backdrop unwatch-backdrop" onMouseDown={onCancel}><section className="compact-dialog unwatch-dialog" ref={dialogRef} role="alertdialog" aria-modal="true" aria-labelledby="unwatch-title" aria-describedby="unwatch-description" onMouseDown={(event) => event.stopPropagation()}><h2 id="unwatch-title">Remove {movie.title} from watched?</h2><p id="unwatch-description">This will also delete your rating and private review. Other taste signals will stay.</p><div><button className="secondary-button" onClick={onCancel}>Keep watched</button><button className="danger-button" onClick={onConfirm}>Remove watched status</button></div></section></div>;
}

function AddMovieDialog({ query, setQuery, results, onClose, onWatched, onSave, onOpen }: { query: string; setQuery: (value: string) => void; results: Movie[]; onClose: () => void; onWatched: (movie: Movie) => void; onSave: (movie: Movie) => void; onOpen: (movie: Movie) => void }) {
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="compact-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}><div className="sheet-heading"><h2>Add a movie</h2><button className="icon-button" onClick={onClose}>×</button></div><label className="library-search"><Icon name="search"/><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by title or person"/></label><div className="add-results">{results.map((movie, index) => <div key={movie.id}><button type="button" className="poster-open-button" onClick={() => onOpen(movie)} aria-label={`View details for ${movie.title}`}><MoviePosterImage movie={movie} size="w92" eager={index < 4}/></button><span><strong>{movie.title}</strong><small>{movie.year}</small></span><button onClick={() => onWatched(movie)}>Watched</button><button onClick={() => onSave(movie)}>Save</button></div>)}</div></section></div>;
}

function ImportDialog({ rows, summary, error, resolving, progress, onClose, onConfirm }: { rows: CsvImportRow[]; summary: MovieImportSummary | null; error: string; resolving: boolean; progress: ImportResolutionProgress; onClose: () => void; onConfirm: () => void }) {
  const matched = rows.filter((row) => row.status === "matched");
  const unresolved = rows.filter((row) => row.status !== "matched");
  const checked = resolving ? progress.completed : rows.length;
  const matchedCount = resolving ? progress.matched : matched.length;
  return <div className="modal-backdrop import-dialog-backdrop" onMouseDown={onClose}><section className="compact-dialog import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title" onMouseDown={(event) => event.stopPropagation()}><div className="sheet-heading"><h2 id="import-title">Import movies</h2><button className="icon-button" onClick={onClose} aria-label="Close import">×</button></div>{summary && <p className="import-summary">{summary.kind.startsWith("letterboxd") ? "Letterboxd import" : "Movie import"} · {summary.files.length} {summary.files.length === 1 ? "file" : "files"} · {summary.ratingCount} ratings{summary.likeCount ? ` · ${summary.likeCount} likes` : ""}</p>}{resolving ? <div className="import-progress" role="status" aria-live="polite"><span><i style={{ width: `${progress.total ? Math.round(checked / progress.total * 100) : 0}%` }}/></span><p>Matching movies automatically… {checked.toLocaleString()} of {progress.total.toLocaleString()}</p></div> : <p>{matchedCount.toLocaleString()} movies matched automatically.</p>}{!resolving && unresolved.length > 0 && <p className="quiet-notice">{unresolved.length.toLocaleString()} {unresolved.length === 1 ? "movie could not" : "movies could not"} be matched and will be skipped.</p>}{error && <p className="inline-error">{error}</p>}{!resolving && !error && rows.length === 0 && <p className="inline-error">No recognizable movies were found.</p>}<button className="primary-button" disabled={!matched.length || resolving} onClick={onConfirm}>Import {matched.length.toLocaleString()} movies</button></section></div>;
}

function ConsentDialog({ onDecline, onAccept }: { onDecline: () => void; onAccept: () => void }) {
  return <div className="modal-backdrop"><section className="compact-dialog consent-dialog" role="dialog" aria-modal="true"><h2>Use reviews to improve your picks?</h2><p>PickAMovie can privately analyze review text into editable taste signals. Your reviews are not shared with other users or used for cross-user learning.</p><div><button className="secondary-button" onClick={onDecline}>Not now</button><button className="primary-button" onClick={onAccept}>Use my reviews</button></div></section></div>;
}

function OnboardingTour({ slide, setSlide, onClose, preferences, onPreference, onFavorite, importSummary, importMeta, onImport, onOpen }: { slide: number; setSlide: (slide: number) => void; onClose: () => void; preferences: OnboardingPreferences; onPreference: (kind: "genres" | "directors" | "actors", value: string) => void; onFavorite: (movie: Movie) => void; importSummary: MovieImportSummary | null; importMeta: LetterboxdImportMeta | null; onImport: (event: ChangeEvent<HTMLInputElement>) => void; onOpen: (movie: Movie) => void }) {
  const touchStart = useRef<number | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const slides = [
    { title: "Pick from three", caption: "Start with your taste or describe tonight. Swap one if it misses, then commit to a pick.", preview: <MiniPick/> },
    { title: "Bring your taste", caption: "Letterboxd gives PickAMovie the strongest start. If you do not use it, add a few preferences manually.", preview: <div className="onboarding-import"><label className="primary-button onboarding-import-primary"><Icon name="upload"/>{importMeta ? "Update Letterboxd" : "Import Letterboxd — recommended"}<input type="file" accept=".csv,.zip,text/csv,application/zip" onChange={onImport}/></label><small>Choose the ZIP from Letterboxd’s export page or one of its CSV files. Re-imports merge changes without deleting missing entries.</small>{importSummary && <span>{importSummary.ratingCount} ratings found in the latest import.</span>}<div className="manual-setup-divider"><span>No Letterboxd?</span></div><button className="secondary-button" onClick={() => setManualOpen((open) => !open)}>{manualOpen ? "Hide manual preferences" : "Add preferences manually"}</button>{manualOpen && <div className="onboarding-preferences"><PreferenceControls compact preferences={preferences} onPreference={onPreference} onFavorite={onFavorite} onOpenMovie={onOpen} /></div>}</div> },
    { title: "It learns with you", caption: "Picks, ratings, Taste Sprint reactions, and your private Library make the next three more personal.", preview: <MiniLearning/> },
  ];
  const current = slides[slide];
  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)")?.focus();
    return () => {
      const previous = returnFocusRef.current;
      if (previous?.isConnected) previous.focus();
      else document.querySelector<HTMLElement>(".settings-trigger, .personal-pick-button, #pick-prompt")?.focus();
    };
  }, []);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") setSlide(Math.min(slide + 1, 2));
      if (event.key === "ArrowLeft") setSlide(Math.max(slide - 1, 0));
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex='-1'])") || [])];
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener);
  }, [slide, setSlide]);
  return <div className="tour-backdrop"><section className="tour" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="tour-title" onTouchStart={(event) => { touchStart.current = event.changedTouches[0]?.clientX ?? null; }} onTouchEnd={(event) => { const start = touchStart.current; const end = event.changedTouches[0]?.clientX; touchStart.current = null; if (start === null || end === undefined || Math.abs(start - end) < 45) return; setSlide(start > end ? Math.min(2, slide + 1) : Math.max(0, slide - 1)); }}><button className="tour-skip" onClick={onClose}>Skip for now</button><div className="tour-preview">{current.preview}</div><div className="tour-copy"><span className="tour-step">Step {slide + 1} of 3</span><h1 id="tour-title">{current.title}</h1><p>{current.caption}</p></div><div className="tour-controls"><button className="secondary-button" onClick={() => setSlide(Math.max(0, slide - 1))} disabled={slide === 0}>Back</button><div className="tour-dots" aria-label="Onboarding progress">{slides.map((item, index) => <button key={item.title} className={index === slide ? "is-active" : index < slide ? "is-complete" : ""} onClick={() => setSlide(index)} aria-label={`Go to step ${index + 1}`} />)}</div><button className="primary-button" onClick={() => slide === 2 ? onClose() : setSlide(slide + 1)}>{slide === 2 ? "Start picking" : "Next"}</button></div></section></div>;
}

function MiniHeader({ active }: { active: Tab }) { return <div className="mini-header"><b>PickAMovie</b>{(["pick", "taste", "library"] as Tab[]).map((item) => <i key={item} className={item === active ? "is-active" : ""}>{item}</i>)}</div>; }
function MiniPick() { const movies = [fallbackMovies[1], fallbackMovies[0], fallbackMovies[4]]; return <div className="mini-ui mini-pick"><MiniHeader active="pick"/><h3>Three picks for tonight</h3><div className="mini-mode-row"><i>Pick for me</i><span>or describe tonight</span></div><div className="mini-posters">{movies.map((movie, index) => <span key={movie.id}><MoviePosterImage movie={movie} size="w185" eager/><small>{movie.title}</small><em>{index === 0 ? "Swap this" : index === 1 ? "Pick this" : "Why this?"}</em></span>)}</div></div>; }
function MiniLearning() { const movie = fallbackMovies[2]; return <div className="mini-ui mini-learning"><MiniHeader active="taste"/><div className="mini-learning-grid"><section><span>Taste Sprint</span><MoviePosterImage movie={movie} size="w185" eager/><strong>{movie.title}</strong><small>Interested · Maybe · Not for me</small></section><section><span>Your taste</span><div className="mini-signal"><b>Dark comedy</b><i><em style={{ width: "82%" }}/></i></div><div className="mini-signal"><b>Character-driven</b><i><em style={{ width: "66%" }}/></i></div><div className="mini-signal"><b>International</b><i><em style={{ width: "48%" }}/></i></div><small>Every reaction sharpens the next three.</small></section></div></div>; }

function buildTasteSignals(movies: Movie[], ratings: RatingMap, likes: LikedMap, interest: InterestMap, preferences: OnboardingPreferences, insights: ReviewInsightMap): TasteSignal[] {
  const scores = new Map<string, { id: string; label: string; category: TasteSignal["category"]; weight: number; evidence: number; explicit: boolean }>();
  const vagueThemes = new Set(["movie", "film", "based on novel", "woman director", "independent film", "duringcreditsstinger", "aftercreditsstinger"]);
  const languageNames: Record<string, string> = { en: "English-language", es: "Spanish-language", fr: "French-language", ja: "Japanese-language", ko: "Korean-language", de: "German-language", it: "Italian-language", zh: "Chinese-language", hi: "Hindi-language" };
  const add = (category: TasteSignal["category"], label: string, weight: number, explicit = false) => {
    if (weight <= 0) return;
    const normalized = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const id = `${category.toLowerCase()}:${normalized}`;
    const current = scores.get(id);
    scores.set(id, { id, label, category, weight: (current?.weight || 0) + weight, evidence: (current?.evidence || 0) + 1, explicit: explicit || Boolean(current?.explicit) });
  };
  preferences.genres.filter((value) => value !== "TV Movie").forEach((value) => add("Genre", value, 2, true));
  preferences.directors.forEach((value) => add("Director", value, 1.5, true));
  preferences.actors.forEach((value) => add("Actor", value, 1.2, true));
  movies.forEach((movie) => {
    const rating = ratings[movie.id]; const reaction = interest[movie.id]?.value;
    const weight = rating ? Math.max(0, rating - 2.5) : likes[movie.id] ? 1.1 : reaction === "interested" ? .8 : reaction === "maybe" ? .25 : 0;
    movie.genres.filter((genre) => genre !== "TV Movie").forEach((genre) => add("Genre", genre, weight));
    if (movie.director) add("Director", movie.director, weight * .7);
    (movie.cast || []).slice(0, 3).forEach((actor) => add("Actor", actor, weight * .35));
    (movie.keywords || []).filter((keyword) => !vagueThemes.has(keyword.toLowerCase())).slice(0, 8).forEach((keyword) => add("Theme", keyword, weight * .45));
    const year = Number(movie.year); if (weight > 0 && Number.isFinite(year)) add("Era", `${Math.floor(year / 10) * 10}s`, weight * .45);
    if (movie.originalLanguage && languageNames[movie.originalLanguage]) add("Language", languageNames[movie.originalLanguage], weight * .35);
  });
  Object.values(insights).flat().filter((aspect) => aspect.sentiment === "positive").forEach((aspect) => add("Review", aspect.label, aspect.confidence, true));
  const eligible = [...scores.values()].filter((signal) => signal.explicit || signal.category === "Genre" || signal.category === "Era" || signal.evidence >= 2);
  const selected: typeof eligible = [];
  for (const signal of eligible.sort((a, b) => b.weight - a.weight || b.evidence - a.evidence || a.label.localeCompare(b.label))) {
    if (selected.length >= 8) break;
    if (selected.filter((item) => item.category === signal.category).length >= 2) continue;
    selected.push(signal);
  }
  const max = selected[0]?.weight || 1;
  return selected.map(({ id, label, category, weight, evidence }) => ({ id, label, category, weight: weight / max, evidence }));
}
