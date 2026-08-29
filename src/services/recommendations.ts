import { buildMovieProfile } from "./movieProfiles";
import { addWeightedEmbedding, cosineSimilarity, embedText, embeddingMagnitude, emptyEmbedding } from "./localEmbeddings";
import { decayingPickWeight, getRatingSignal, isMovieExcluded } from "./recommendationPolicy";
import { blendPromptRelevance } from "./promptIntent";
import type {
  InterestMap,
  LikedMap,
  Movie,
  OnboardingPreferences,
  PickIntentEvent,
  PromptMovieEvidence,
  RatingPrediction,
  RatingMap,
  RecommendationMode,
  ReviewInsightMap,
  WatchedMap,
  WatchlistMap,
} from "../types";

export type RecommendationSignal = { label: string; value: number; detail: string };
export type RecommendationEvidenceItem = { id: string; category: "request" | "personal" | "discovery"; text: string };
export type RecommendationResult = { movie: Movie; score: number; reason: string; evidence: string; evidenceItems: RecommendationEvidenceItem[]; signals: RecommendationSignal[]; predictedRating?: RatingPrediction };

export function arrangeWatchlistCandidates<T extends { movie: Movie }>(results: T[], watchlist: WatchlistMap, includeWatchlist: boolean): T[] {
  const discovery = results.filter((result) => !watchlist[result.movie.id]);
  if (!includeWatchlist) return discovery;
  const saved = results.filter((result) => watchlist[result.movie.id]);
  if (!saved.length) return discovery;
  const insertion = Math.min(2, discovery.length);
  return [...discovery.slice(0, insertion), saved[0], ...discovery.slice(insertion)];
}

const interestWeights = { interested: 0.32, maybe: 0.1, notInterested: -0.8 } as const;
const movieVectorCache = new Map<number, { profile: string; vector: number[] }>();

export { decayingPickWeight, getRatingSignal } from "./recommendationPolicy";

export function recommendMovies({
  movies,
  ratings,
  likes = {},
  watchlist,
  watched = {},
  interest,
  preferences,
  pickIntents = [],
  reviewInsights = {},
  promptScores = {},
  promptEvidence = {},
  collaborativeScores,
  collaborativeEvidence,
  candidatePredictions,
  predictionEnabled = false,
  mode,
  excludedIds = [],
  limit = 18,
}: {
  movies: Movie[];
  ratings: RatingMap;
  likes?: LikedMap;
  watchlist: WatchlistMap;
  watched?: WatchedMap;
  interest: InterestMap;
  preferences: OnboardingPreferences;
  pickIntents?: PickIntentEvent[];
  reviewInsights?: ReviewInsightMap;
  promptScores?: Record<number, number>;
  promptEvidence?: Record<number, PromptMovieEvidence>;
  collaborativeScores?: Map<number, number>;
  collaborativeEvidence?: Map<number, string>;
  candidatePredictions?: Map<number, RatingPrediction>;
  predictionEnabled?: boolean;
  mode: RecommendationMode;
  excludedIds?: number[];
  limit?: number;
}): RecommendationResult[] {
  const userVector = buildUserVector({ movies, ratings, likes, watchlist, interest, preferences, pickIntents, reviewInsights });
  const preferredGenres = new Set(preferences.genres.map(normalize));
  const preferredDirectors = new Set(preferences.directors.map(normalize));
  const preferredActors = new Set((preferences.actors || []).map(normalize));
  const likedMovies = movies.filter((movie) => (ratings[movie.id] || 0) >= 4 || Boolean(likes[movie.id]) || Boolean(preferences.favoriteMovies[movie.id]) || interest[movie.id]?.value === "interested");
  const seenMovieIds = new Set<number>();
  const uniqueMovies = movies.filter((movie) => {
    if (seenMovieIds.has(movie.id)) return false;
    seenMovieIds.add(movie.id);
    return true;
  });
  const scored = uniqueMovies
    .filter((movie) => !isMovieExcluded(movie.id, watched, interest, excludedIds))
    .map((movie) => {
      const taste = clamp01((cosineSimilarity(userVector, movieVector(movie)) + 1) / 2);
      const quality = clamp01((movie.voteAverage || 6.5) / 10);
      const popularity = clamp01(Math.log10((movie.popularity || 5) + 1) / 3);
      const novelty = noveltyScore(movie, preferredGenres);
      const explicit = explicitBoost(movie, preferredGenres, preferredDirectors, preferredActors);
      const saved = Boolean(watchlist[movie.id]);
      const modelScore = collaborativeScores?.get(movie.id);
      const hasCollaborativeData = modelScore !== undefined;
      const collaborative = hasCollaborativeData ? clamp01((modelScore + 1) / 2) : relationshipSignal(movie, likedMovies);
      const promptRelevance = promptScores[movie.id];
      const weights = mode === "focused"
        ? { taste: 0.58, quality: 0.12, popularity: 0.05, novelty: 0.05, collaborative: 0.2 }
        : mode === "exploratory"
          ? { taste: 0.36, quality: 0.14, popularity: 0.08, novelty: 0.24, collaborative: 0.18 }
          : { taste: 0.48, quality: 0.14, popularity: 0.07, novelty: 0.12, collaborative: 0.19 };
      const baseScore =
        taste * weights.taste + quality * weights.quality + popularity * weights.popularity +
        novelty * weights.novelty + collaborative * weights.collaborative + explicit + (saved ? 0.025 : 0);
      const prediction = candidatePredictions?.get(movie.id);
      const confidentPrediction = predictionEnabled && prediction && prediction.confidence >= .65 ? prediction : undefined;
      const predictionScore = confidentPrediction ? clamp01((confidentPrediction.predictedRating - .5) / 4.5) : 0;
      const score = blendPromptRelevance(confidentPrediction ? baseScore * .88 + predictionScore * .12 : baseScore, promptRelevance);
      const signals = normalizeSignals([
        ...(promptRelevance === undefined ? [] : [{ label: "Your request", value: clamp01(promptRelevance), detail: "Directly matches the request you entered" }]),
        { label: "Your taste", value: taste, detail: tasteDetail(movie, preferences) },
        { label: hasCollaborativeData ? "Audience patterns" : "Movie fit", value: collaborative, detail: hasCollaborativeData ? collaborativeEvidence?.get(movie.id) || "MovieLens item factors compared with your ratings" : collaborativeDetail(movie, likedMovies) },
        { label: "Quality", value: quality, detail: "TMDB audience rating" },
        { label: "Something new", value: novelty, detail: "Balances familiarity with discovery" },
      ]);
      const explanation = buildRecommendationExplanation({ movie, ratings, likes, watchlist, interest, preferences, promptEvidence: promptEvidence[movie.id], saved, signals, likedMovies });
      return { movie, score, signals, reason: explanation.reason, evidence: explanation.evidence, evidenceItems: explanation.evidenceItems, predictedRating: confidentPrediction };
    })
    .sort((a, b) => b.score - a.score);

  return diversityRerank(scored, mode, limit, Object.keys(promptScores).length > 0);
}

function buildUserVector({ movies, ratings, likes, watchlist, interest, preferences, pickIntents, reviewInsights }: {
  movies: Movie[];
  ratings: RatingMap;
  likes: LikedMap;
  watchlist: WatchlistMap;
  interest: InterestMap;
  preferences: OnboardingPreferences;
  pickIntents: PickIntentEvent[];
  reviewInsights: ReviewInsightMap;
}) {
  const vector = emptyEmbedding();
  movies.forEach((movie) => {
    const rating = ratings[movie.id];
    if (rating) addWeightedEmbedding(vector, movieVector(movie), getRatingSignal(rating));
  });
  Object.values(likes).forEach((movie) => addWeightedEmbedding(vector, movieVector(movie), 0.55));
  Object.values(watchlist).forEach((movie) => addWeightedEmbedding(vector, movieVector(movie), 0.12));
  Object.values(interest).forEach(({ movie, value }) => addWeightedEmbedding(vector, movieVector(movie), interestWeights[value]));
  pickIntents.forEach(({ movie, createdAt }) => addWeightedEmbedding(vector, movieVector(movie), decayingPickWeight(createdAt)));
  Object.values(preferences.favoriteMovies || {}).forEach((movie) => addWeightedEmbedding(vector, movieVector(movie), 0.8));
  preferences.genres.forEach((genre) => addWeightedEmbedding(vector, embedText(`genre ${genre}`), 0.32));
  preferences.directors.forEach((director) => addWeightedEmbedding(vector, embedText(`director ${director}`), 0.42));
  (preferences.actors || []).forEach((actor) => addWeightedEmbedding(vector, embedText(`actor ${actor}`), 0.36));
  Object.values(reviewInsights).flat().forEach((aspect) => {
    addWeightedEmbedding(vector, embedText(aspect.label), aspect.sentiment === "positive" ? 0.2 : -0.2);
  });
  return embeddingMagnitude(vector) > 0 ? vector : embedText("acclaimed character driven drama comedy thriller animation discovery");
}

function explicitBoost(movie: Movie, genres: Set<string>, directors: Set<string>, actors: Set<string>) {
  const genre = movie.genres.filter((value) => genres.has(normalize(value))).length * 0.035;
  const director = movie.director && directors.has(normalize(movie.director)) ? 0.07 : 0;
  const cast = (movie.cast || []).some((actor) => actors.has(normalize(actor))) ? 0.055 : 0;
  return Math.min(genre + director + cast, 0.14);
}

function relationshipSignal(movie: Movie, likedMovies: Movie[]) {
  if (!likedMovies.length) return 0.45;
  const best = likedMovies.reduce((max, candidate) => Math.max(max, affinityOverlap(movie, candidate)), 0);
  return clamp01(best / 8);
}

function collaborativeDetail(movie: Movie, likedMovies: Movie[]) {
  const match = likedMovies
    .map((candidate) => ({ candidate, overlap: affinityOverlap(movie, candidate) }))
    .sort((a, b) => b.overlap - a.overlap)[0];
  return match?.overlap > 0 ? `Shares movie traits with ${match.candidate.title}` : "Shared genres, people, keywords, and TMDB relationships";
}

function tasteDetail(movie: Movie, preferences: OnboardingPreferences) {
  const genres = movie.genres.filter((genre) => preferences.genres.some((value) => normalize(value) === normalize(genre)));
  if (genres.length) return `Matches your interest in ${genres.slice(0, 2).join(" and ")}`;
  if (movie.director && preferences.directors.some((value) => normalize(value) === normalize(movie.director || ""))) return `A director you follow`;
  return "Fits the patterns in your ratings and reactions";
}

function buildRecommendationExplanation({ movie, ratings, likes, watchlist, interest, preferences, promptEvidence, saved, signals, likedMovies }: {
  movie: Movie;
  ratings: RatingMap;
  likes: LikedMap;
  watchlist: WatchlistMap;
  interest: InterestMap;
  preferences: OnboardingPreferences;
  promptEvidence?: PromptMovieEvidence;
  saved: boolean;
  signals: RecommendationSignal[];
  likedMovies: Movie[];
}) {
  const promptReason = promptEvidence?.reason?.trim();
  const promptDetail = promptEvidence?.evidence?.trim();
  const personal = personalEvidence(movie, ratings, likes, watchlist, interest, preferences, likedMovies);
  const baseReason = promptReason || (saved
    ? "You saved this earlier and it is a strong match tonight."
    : personal ? chooseFallbackReason(movie, signals) : generalDiscoveryReason(movie));
  const reason = sentence(promptReason || (personal ? personalSummary(movie, personal) : saved ? "You saved this for a night like this" : generalDiscoveryReason(movie)));
  const rawItems: RecommendationEvidenceItem[] = [
    ...(promptDetail && normalize(promptDetail) !== normalize(reason) ? [{ id: `request:${normalize(promptDetail)}`, category: "request" as const, text: sentence(promptDetail) }] : []),
    ...(personal && normalize(personal) !== normalize(reason) ? [{ id: `personal:${normalize(personal)}`, category: "personal" as const, text: sentence(personal) }] : []),
    ...(!promptDetail && !personal ? [{ id: `discovery:${movie.id}`, category: "discovery" as const, text: sentence(discoveryEvidence(movie)) }] : []),
  ];
  const evidenceItems = rawItems.filter((item, index, items) => items.findIndex((candidate) => candidate.id === item.id) === index);
  return { reason, evidence: evidenceItems.map((item) => item.text).join(" ") || sentence(baseReason), evidenceItems };
}

function personalSummary(movie: Movie, evidence: string) {
  const relatedMatch = evidence.match(/You (?:rated|marked) ([^,.]+)|([^,.]+) is one of your favorite movies/i);
  if (relatedMatch) return `${movie.title} connects to ${relatedMatch[1] || relatedMatch[2]} in your taste history`;
  if (/director/i.test(evidence) && movie.director) return `A ${movie.director} film that matches a preference you chose`;
  if (/actor/i.test(evidence)) return `A familiar cast match from your saved preferences`;
  const genreMatch = evidence.match(/selected (.+?) preferences/i);
  if (genreMatch) return `A direct match for your ${genreMatch[1]} taste`;
  return `A strong fit for patterns in your ratings and reactions`;
}

function discoveryEvidence(movie: Movie) {
  if (movie.director) return `Directed by ${movie.director}, with ${movie.genres.slice(0, 2).join(" and ").toLowerCase() || "a distinctive"} focus`;
  if ((movie.voteAverage || 0) >= 8 && movie.voteCount) return `Rated ${movie.voteAverage!.toFixed(1)} by TMDB audiences across ${movie.voteCount.toLocaleString()} votes`;
  if (movie.genres.length) return `Adds ${movie.genres.slice(0, 2).join(" and ").toLowerCase()} range to this three-movie shortlist`;
  return `Chosen as a distinct alternative to the other two movies`;
}

function personalEvidence(movie: Movie, ratings: RatingMap, likes: LikedMap, watchlist: WatchlistMap, interest: InterestMap, preferences: OnboardingPreferences, likedMovies: Movie[]) {
  const rating = ratings[movie.id];
  if (rating) return `You rated ${movie.title} ${formatRating(rating)}, which is a direct signal from your history`;
  if (preferences.favoriteMovies[movie.id]) return `${movie.title} is one of your selected favorite movies`;
  if (likes[movie.id]) return `You liked ${movie.title}, which is a direct signal from your history`;
  if (watchlist[movie.id]) return `You previously saved ${movie.title}`;
  if (interest[movie.id]?.value === "interested") return `You marked ${movie.title} as interested during Taste Sprint`;
  const director = movie.director && preferences.directors.find((value) => normalize(value) === normalize(movie.director || ""));
  if (director) return `${movie.director} is one of your selected directors`;
  const actor = (movie.cast || []).find((name) => preferences.actors.some((value) => normalize(value) === normalize(name)));
  if (actor) return `${actor} is one of your selected actors`;
  const genres = movie.genres.filter((genre) => preferences.genres.some((value) => normalize(value) === normalize(genre)));
  if (genres.length) return `It matches your selected ${genres.slice(0, 2).join(" and ")} preferences`;
  const related = likedMovies
    .filter((candidate) => candidate.id !== movie.id)
    .map((candidate) => ({ candidate, overlap: affinityOverlap(movie, candidate) }))
    .sort((a, b) => b.overlap - a.overlap)[0];
  if (related && related.overlap >= 2.4) {
    const shared = sharedTraits(movie, related.candidate);
    const source = ratings[related.candidate.id]
      ? `You rated ${related.candidate.title} ${formatRating(ratings[related.candidate.id])}`
      : preferences.favoriteMovies[related.candidate.id]
        ? `${related.candidate.title} is one of your favorite movies`
        : likes[related.candidate.id]
          ? `You liked ${related.candidate.title}`
        : `You marked ${related.candidate.title} as Interested in Taste Sprint`;
    return `${source}, and the two movies share ${shared}`;
  }
  return "";
}

function sharedTraits(movie: Movie, candidate: Movie) {
  if (movie.director && candidate.director && normalize(movie.director) === normalize(candidate.director)) return `director ${movie.director}`;
  const genres = movie.genres.filter((genre) => candidate.genres.some((value) => normalize(value) === normalize(genre)));
  const keywords = (movie.keywords || []).filter((keyword) => (candidate.keywords || []).some((value) => normalize(value) === normalize(keyword)));
  const cast = (movie.cast || []).filter((actor) => (candidate.cast || []).some((value) => normalize(value) === normalize(actor)));
  if (keywords.length) return `${keywords.slice(0, 2).join(" and ")} themes`;
  if (cast.length) return `${cast[0]} and ${genres.slice(0, 1).join("") || "related movie traits"}`;
  return genres.slice(0, 2).join(" and ") || "related movie traits";
}

function chooseFallbackReason(movie: Movie, signals: RecommendationSignal[]) {
  const strongest = [...signals].sort((a, b) => b.value - a.value)[0];
  if (strongest.label === "Audience patterns" || strongest.label === "Movie fit") return strongest.detail;
  if (strongest.label === "Quality" && (movie.voteAverage || 0) >= 8) return "Highly rated and close to your taste";
  return strongest.detail;
}

function generalDiscoveryReason(movie: Movie) {
  if (movie.director) return `${movie.director}'s ${movie.genres[0]?.toLowerCase() || "film"} is the distinctive choice here`;
  if ((movie.voteAverage || 0) >= 8) {
    const score = movie.voteAverage!.toFixed(1);
    const support = movie.voteCount ? ` from ${movie.voteCount.toLocaleString()} TMDB votes` : "";
    if (movie.id % 3 === 0) return `Strong audience confidence: ${score} on TMDB${support}`;
    if (movie.id % 3 === 1) return `${movie.year ? `A ${movie.year} release` : "A proven favorite"} that still holds a ${score} audience rating`;
    return `${movie.genres[0] ? `A high-confidence ${movie.genres[0].toLowerCase()} choice` : "One of the strongest audience choices here"} at ${score} on TMDB`;
  }
  if (movie.genres[0]) {
    const genre = movie.genres[0].toLowerCase();
    if (movie.id % 3 === 0) return `A clear ${genre} direction for tonight`;
    if (movie.id % 3 === 1) return `${movie.title} gives the shortlist a ${genre} counterpoint`;
    return `Chosen to keep tonight's options grounded in ${genre}`;
  }
  return `${movie.title} gives this shortlist a different direction`;
}

function sentence(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function formatRating(value: number) { return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} stars`; }

function normalizeSignals(signals: RecommendationSignal[]) {
  const max = Math.max(...signals.map((signal) => signal.value), 0.001);
  return signals.map((signal) => ({ ...signal, value: Math.round((signal.value / max) * 100) / 100 }));
}

function noveltyScore(movie: Movie, preferredGenres: Set<string>) {
  if (!preferredGenres.size) return 0.55;
  const overlap = movie.genres.filter((genre) => preferredGenres.has(normalize(genre))).length;
  return overlap ? 0.42 : 0.72;
}

function movieVector(movie: Movie) {
  const profile = buildMovieProfile(movie);
  const cached = movieVectorCache.get(movie.id);
  if (cached?.profile === profile) return cached.vector;
  const vector = embedText(profile);
  movieVectorCache.set(movie.id, { profile, vector });
  return vector;
}

function diversityRerank(results: RecommendationResult[], mode: RecommendationMode, limit: number, promptActive = false) {
  const selected: RecommendationResult[] = [];
  const remaining = [...results];
  const basePenalty = mode === "focused" ? 0.05 : mode === "exploratory" ? 0.17 : 0.11;
  const penalty = promptActive ? basePenalty * 0.25 : basePenalty;
  while (selected.length < limit && remaining.length) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    remaining.forEach((result, index) => {
      const duplicate = selected.reduce((max, item) => Math.max(max, clamp01((cosineSimilarity(movieVector(result.movie), movieVector(item.movie)) + 1) / 2)), 0);
      const adjusted = result.score - duplicate * penalty;
      if (adjusted > bestScore) { bestScore = adjusted; bestIndex = index; }
    });
    selected.push(remaining.splice(bestIndex, 1)[0]);
  }
  return selected;
}

function affinityOverlap(movie: Movie, candidate: Movie) {
  const genre = overlapCount(movie.genres, candidate.genres) * 1.2;
  const keyword = overlapCount(movie.keywords || [], candidate.keywords || []) * 1.4;
  const cast = overlapCount(movie.cast || [], candidate.cast || []) * 0.8;
  const director = movie.director && candidate.director && normalize(movie.director) === normalize(candidate.director) ? 2 : 0;
  const related = candidate.recommendedMovieIds?.includes(movie.id) || candidate.similarMovieIds?.includes(movie.id) ? 2.4 : 0;
  return genre + keyword + cast + director + related;
}

function overlapCount(a: string[], b: string[]) { const values = new Set(b.map(normalize)); return a.filter((value) => values.has(normalize(value))).length; }
function normalize(value: string) { return value.trim().toLowerCase(); }
function clamp01(value: number) { return Math.max(0, Math.min(value, 1)); }

export function getTopTasteLabel(ratings: RatingMap, movies: Movie[], preferences: OnboardingPreferences) {
  const weights = new Map<string, number>();
  preferences.genres.forEach((genre) => weights.set(genre, (weights.get(genre) || 0) + 2));
  movies.forEach((movie) => {
    const rating = ratings[movie.id];
    if (!rating) return;
    const signal = Math.max(getRatingSignal(rating), 0);
    movie.genres.forEach((genre) => weights.set(genre, (weights.get(genre) || 0) + signal));
  });
  return [...weights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "taste forming";
}
