export type Tab = "pick" | "taste" | "library";
export type Theme = "light" | "dark";
export type InterestValue = "interested" | "maybe" | "notInterested";
export type RecommendationMode = "focused" | "balanced" | "exploratory";
export type LibraryFilter = "watched" | "watchlist";
export type LibraryWatchedFilter = "all" | "liked";
export type LibrarySort = "recent" | "rating-high" | "rating-low" | "title" | "year-newest";

export type Movie = {
  id: number;
  title: string;
  originalTitle?: string;
  year: string;
  posterPath: string | null;
  backdropPath?: string | null;
  overview: string;
  genres: string[];
  voteAverage?: number;
  voteCount?: number;
  runtime?: number;
  director?: string;
  cast?: string[];
  popularity?: number;
  keywords?: string[];
  originalLanguage?: string;
  productionCountries?: string[];
  trailerKey?: string;
  similarMovieIds?: number[];
  recommendedMovieIds?: number[];
};

export type PersonSearchResult = {
  id: number;
  name: string;
  department?: string;
  profilePath: string | null;
  knownFor: string[];
};

export type StreamingProvider = { id: number; name: string; logoPath?: string | null };
export type StreamingAvailability = {
  movieId: number;
  region: string;
  providers: StreamingProvider[];
  link?: string;
  checkedAt: number;
  status?: "verified" | "unavailable";
};

export type PickFilters = {
  runtimeMin: number;
  runtimeMax: number;
  genres: string[];
  eras: string[];
  region: string;
  providerIds: number[];
  includeTheaters: boolean;
  includeWatchlist: boolean;
};

export type MovieDebugInfo = {
  status: string;
  mode: string;
  reasonSource: string;
  score?: number;
  strongestSignals: string[];
};
export type MovieDebugMap = Record<number, MovieDebugInfo>;
export type AskFilter = { label: string; value: string };
export type PromptMovieEvidence = {
  reason: string;
  evidence: string;
  matchedConstraints: string[];
  fitScore: number;
  confidence: number;
};
export type AskPickAMovieResult = {
  movies: Movie[];
  debug: MovieDebugMap;
  filters: AskFilter[];
  promptScores: Record<number, number>;
  promptEvidence?: Record<number, PromptMovieEvidence>;
  serviceStatus: "full" | "metadata-only" | "local-fallback";
  explanation: string;
  resultMode: "curated" | "collection";
  broadQuery?: boolean;
  verificationStatus?: "verified" | "deterministic" | "fallback";
  usedWebSearch?: boolean;
};

export type RatingMap = Record<string, number>;
export type LikedMap = Record<string, Movie>;
export type WatchlistMap = Record<string, Movie>;
export type WatchedMap = Record<string, { movie: Movie; watchedAt: number }>;
export type InterestMap = Record<string, { movie: Movie; value: InterestValue; updatedAt: number }>;
export type ReviewMap = Record<string, string>;

export type LetterboxdImportMeta = {
  lastImportedAt: number;
  movieCount: number;
  ratingCount: number;
};

export type RatingPredictionPoint = {
  movie: Movie;
  predictedRating: number;
  actualRating: number;
  absoluteError: number;
  x: number;
  y: number;
  confidence: number;
  neighborCount: number;
  source: "movielens" | "content" | "baseline";
  calibrated?: boolean;
};

export type RatingPrediction = {
  predictedRating: number;
  rankingScore?: number;
  rawPredictedRating?: number;
  calibrated?: boolean;
  confidence: number;
  rankingConfidence?: number;
  starConfidence?: number;
  neighborCount: number;
  source: "movielens" | "content" | "baseline";
};

export type TasteSignal = {
  id: string;
  label: string;
  category: "Genre" | "Era" | "Director" | "Actor" | "Theme" | "Language" | "Review";
  weight: number;
  evidence: number;
};

export type TasteStrength = {
  score: number;
  signalScore: number;
  coverageScore: number;
  modelCoverageScore: number;
  outcomeScore: number;
  nextStep: string;
};

export type ReviewAspect = {
  id: string;
  label: string;
  sentiment: "positive" | "negative";
  confidence: number;
  createdAt: number;
};
export type ReviewInsightMap = Record<string, ReviewAspect[]>;

export type OnboardingPreferences = {
  genres: string[];
  directors: string[];
  actors: string[];
  favoriteMovies: Record<string, Movie>;
};

export type PickIntentEvent = {
  id: string;
  movie: Movie;
  createdAt: number;
  rank?: number;
  score?: number;
  watchedAt?: number;
  rating?: number;
};
export type LearningEventType = "interest" | "rating" | "like" | "watchlist" | "watched" | "pick" | "reviewAspect";
export type LearningEvent = {
  id: string;
  type: LearningEventType;
  movie: Movie;
  label: string;
  createdAt: number;
  undoKey?: string;
  source?: "pick" | "sprint" | "library" | "review";
};

export type RecommendationEventType =
  | "impression"
  | "open"
  | "swap"
  | "watchlist"
  | "highRating"
  | "rating"
  | "pick"
  | "watched"
  | "notForMe";
export type RecommendationEvent = {
  id: string;
  type: RecommendationEventType;
  movieId: number;
  movieTitle: string;
  mode: RecommendationMode;
  score: number;
  rank?: number;
  pickId?: string;
  rating?: number;
  createdAt: number;
};

export type CloudUserState = {
  version?: 2 | 3 | 4 | 5;
  ratings: RatingMap;
  likes?: LikedMap;
  watchlist: WatchlistMap;
  watched: WatchedMap;
  interest: InterestMap;
  reviews: ReviewMap;
  reviewInsights?: ReviewInsightMap;
  reviewAnalysisConsent?: boolean;
  preferences: OnboardingPreferences;
  recommendationEvents: RecommendationEvent[];
  pickIntents?: PickIntentEvent[];
  learningEvents?: LearningEvent[];
  tasteSprintDecisions?: number;
  letterboxdImportMeta?: LetterboxdImportMeta;
  fieldUpdatedAt?: Record<string, number>;
  stateUpdatedAt?: number;
};

// Retained for database and archived-social compatibility; the new UI does not expose social profiles.
export type UserProfile = {
  userId: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
};
export type FriendRequestStatus = "pending" | "accepted" | "declined" | "cancelled";
export type FriendRequest = {
  id: string;
  requesterId: string;
  recipientId: string;
  status: FriendRequestStatus;
  createdAt: string;
  updatedAt: string;
  otherProfile?: UserProfile;
  direction: "incoming" | "outgoing";
};
export type Friendship = { friendUserId: string; createdAt: string; profile: UserProfile };
