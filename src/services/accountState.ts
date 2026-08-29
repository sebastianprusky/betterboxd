import type { CloudUserState, Movie, RecommendationEvent } from "../types";

export const emptyCloudState: CloudUserState = {
  version: 5,
  ratings: {},
  likes: {},
  watchlist: {},
  watched: {},
  interest: {},
  reviews: {},
  preferences: { genres: [], directors: [], actors: [], favoriteMovies: {} },
  recommendationEvents: [],
  reviewInsights: {},
  reviewAnalysisConsent: false,
  pickIntents: [],
  learningEvents: [],
  tasteSprintDecisions: 0,
  fieldUpdatedAt: {},
  stateUpdatedAt: 0,
};

function updatedAt(state: CloudUserState, key: string, fallback: number) {
  return state.fieldUpdatedAt?.[key] || fallback;
}

function mergeRecord<T>(
  account: Record<string, T>,
  guest: Record<string, T>,
  accountState: CloudUserState,
  guestState: CloudUserState,
  prefix: string,
) {
  const merged: Record<string, T> = {};
  const timestamps: Record<string, number> = {};
  const metadataKeys = [...Object.keys(accountState.fieldUpdatedAt || {}), ...Object.keys(guestState.fieldUpdatedAt || {})]
    .filter((key) => key.startsWith(`${prefix}:`))
    .map((key) => key.slice(prefix.length + 1));
  const keys = new Set([...Object.keys(account), ...Object.keys(guest), ...metadataKeys]);

  keys.forEach((key) => {
    const accountTime = updatedAt(accountState, `${prefix}:${key}`, 0);
    const guestTime = updatedAt(guestState, `${prefix}:${key}`, 0);
    const accountTouched = `${prefix}:${key}` in (accountState.fieldUpdatedAt || {});
    const guestTouched = `${prefix}:${key}` in (guestState.fieldUpdatedAt || {});
    const accountHasValue = key in account;
    const guestHasValue = key in guest;
    const useGuest = guestTouched && (!accountTouched || guestTime > accountTime);
    const useAccount = accountTouched && (!guestTouched || accountTime >= guestTime);
    if (useGuest && guestHasValue) merged[key] = guest[key];
    else if (useAccount && accountHasValue) merged[key] = account[key];
    else if (!accountTouched && !guestTouched) {
      if (accountHasValue) merged[key] = account[key];
      else if (guestHasValue) merged[key] = guest[key];
    }
    timestamps[`${prefix}:${key}`] = Math.max(accountTime, guestTime);
  });

  return { merged, timestamps };
}

function unionMovies(account: Record<string, Movie>, guest: Record<string, Movie>) {
  return { ...account, ...guest };
}

function mergeEvents(account: RecommendationEvent[], guest: RecommendationEvent[]) {
  const events = new Map<string, RecommendationEvent>();
  [...account, ...guest].forEach((event) => events.set(event.id, event));
  return [...events.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-300);
}

export function mergeGuestAndAccountState(
  accountInput: CloudUserState | null,
  guestInput: CloudUserState,
): CloudUserState {
  const account = accountInput || emptyCloudState;
  const guest = guestInput;
  const ratings = mergeRecord(account.ratings || {}, guest.ratings || {}, account, guest, "rating");
  const likes = mergeRecord(account.likes || {}, guest.likes || {}, account, guest, "like");
  const reviews = mergeRecord(account.reviews || {}, guest.reviews || {}, account, guest, "review");
  const reviewInsights = mergeRecord(account.reviewInsights || {}, guest.reviewInsights || {}, account, guest, "review-insight");
  const interest = mergeRecord(account.interest || {}, guest.interest || {}, account, guest, "interest");
  const watched = mergeRecord(account.watched || {}, guest.watched || {}, account, guest, "watched");
  const watchlist = mergeRecord(account.watchlist || {}, guest.watchlist || {}, account, guest, "watchlist");
  const preferenceTimeAccount = updatedAt(account, "preferences", 0);
  const preferenceTimeGuest = updatedAt(guest, "preferences", 0);
  const stateUpdatedAt = Math.max(account.stateUpdatedAt || 0, guest.stateUpdatedAt || 0, Date.now());
  const accountImport = account.letterboxdImportMeta;
  const guestImport = guest.letterboxdImportMeta;
  const letterboxdImportMeta = !accountImport
    ? guestImport
    : !guestImport
      ? accountImport
      : guestImport.lastImportedAt > accountImport.lastImportedAt ? guestImport : accountImport;

  return {
    version: 5,
    ratings: ratings.merged,
    likes: likes.merged,
    reviews: reviews.merged,
    interest: interest.merged,
    watched: watched.merged,
    watchlist: watchlist.merged,
    preferences: {
      genres: [...new Set([...(account.preferences?.genres || []), ...(guest.preferences?.genres || [])])],
      directors: [...new Set([...(account.preferences?.directors || []), ...(guest.preferences?.directors || [])])],
      actors: [...new Set([...(account.preferences?.actors || []), ...(guest.preferences?.actors || [])])],
      favoriteMovies: unionMovies(account.preferences?.favoriteMovies || {}, guest.preferences?.favoriteMovies || {}),
    },
    recommendationEvents: mergeEvents(account.recommendationEvents || [], guest.recommendationEvents || []),
    reviewInsights: reviewInsights.merged,
    reviewAnalysisConsent: guest.reviewAnalysisConsent ?? account.reviewAnalysisConsent ?? false,
    pickIntents: [...(account.pickIntents || []), ...(guest.pickIntents || [])]
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-100),
    learningEvents: [...(account.learningEvents || []), ...(guest.learningEvents || [])]
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-100),
    tasteSprintDecisions: Math.max(account.tasteSprintDecisions || 0, guest.tasteSprintDecisions || 0),
    letterboxdImportMeta,
    fieldUpdatedAt: {
      ...(account.fieldUpdatedAt || {}),
      ...(guest.fieldUpdatedAt || {}),
      ...ratings.timestamps,
      ...likes.timestamps,
      ...reviews.timestamps,
      ...reviewInsights.timestamps,
      ...interest.timestamps,
      ...watched.timestamps,
      ...watchlist.timestamps,
      preferences: Math.max(preferenceTimeAccount, preferenceTimeGuest),
    },
    stateUpdatedAt,
  };
}

export function createMergeKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `guest-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
