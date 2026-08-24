export type Tab = "pick" | "taste" | "library";
export type Theme = "light" | "dark";
export type InterestValue = "interested" | "maybe" | "notInterested";
export type RecommendationMode = "focused" | "balanced" | "exploratory";
export type LibraryFilter = "all" | "watched" | "watchlist" | "rated" | "rejected";

export type Movie = {
  id: number;
  title: string;
  year: string;
  posterPath: string | null;
  backdropPath?: string | null;
  overview: string;
  genres: string[];
  voteAverage?: number;
  runtime?: number;
  director?: string;
  cast?: string[];
  popularity?: number;
  keywords?: string[];
  originalLanguage?: string;
  productionCountries?: string[];
  similarMovieIds?: number[];
  recommendedMovieIds?: number[];
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
export type AskPickAMovieResult = {
  movies: Movie[];
  debug: MovieDebugMap;
  filters: AskFilter[];
  promptScores: Record<number, number>;
  serviceStatus: "full" | "metadata-only" | "local-fallback";
  explanation: string;
};

export type RatingMap = Record<string, number>;
export type WatchlistMap = Record<string, Movie>;
export type WatchedMap = Record<string, { movie: Movie; watchedAt: number }>;
export type InterestMap = Record<string, { movie: Movie; value: InterestValue; updatedAt: number }>;
export type ReviewMap = Record<string, string>;

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

export type PickIntentEvent = { id: string; movie: Movie; createdAt: number };
export type LearningEventType = "interest" | "rating" | "watchlist" | "watched" | "pick" | "reviewAspect";
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
  | "watchlist"
  | "highRating"
  | "rating"
  | "pick"
  | "notForMe";
export type RecommendationEvent = {
  id: string;
  type: RecommendationEventType;
  movieId: number;
  movieTitle: string;
  mode: RecommendationMode;
  score: number;
  createdAt: number;
};

export type CloudUserState = {
  version?: 2 | 3;
  ratings: RatingMap;
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
