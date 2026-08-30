# PickAMovie Project Context

Last updated: August 29, 2026

## Product north star

PickAMovie is a bounded decision tool, not a movie search engine. Its core ritual is simple: use the person’s taste and tonight’s constraints to show exactly three movies, then help them commit to one. Preserve that focus before adding adjacent modes, feeds, rankings, or generic discovery surfaces.

The product should feel:

- decisive rather than exhaustive;
- personal when evidence exists and honest when it does not;
- private by default;
- useful within a few interactions, but meaningfully better after a Letterboxd import or ongoing ratings;
- calm and cinematic rather than analytical on the Pick screen.

## Current product shape

- Pick: exactly three persistent recommendation slots, one-card Swap, explicit Not for me, filters, prompt or no-prompt entry, and a final-pick transition.
- Taste: adaptive Taste Sprint, six concise taste signals, learning history, Taste Strength, and Prediction Score.
- Library: Watched and Watchlist, reversible Watched controls, separate Likes, ratings, reviews, filtering, and ordering.
- Onboarding: three slides, repeatable Letterboxd import, manual taste setup, and intentional Skip/Start controls.
- Settings: Google/Supabase account state, Letterboxd re-import, watchlist-recommendation preference, walkthrough replay, review learning, and destructive account/device controls.

## Recommendation principles

1. Keep exactly three visible choices.
2. A swap replaces only its slot and is taste-neutral.
3. Not for me is a persistent negative signal.
4. Do not move the two untouched cards when one is replaced.
5. Explanations must cite concrete request, personal, or factual discovery evidence without repetition or invented personalization.
6. Watched and rejected movies remain excluded. Watchlist titles are included only according to the remembered Settings preference, at most one per shortlist.
7. Predictions may influence ranking only after held-out evaluation proves useful performance.

## Prediction Model 3 architecture

The model is optimized first for ordering movies correctly and second for estimating stars.

- Every eligible rating contributes to a deterministic, capped pairwise training set.
- Public movie representations combine TMDB description, genres, keywords, director, cast, language, year/era, runtime, quality, popularity, similar titles, and recommendations.
- `text-embedding-3-small` embeddings are created server-side from public movie metadata, cached by content hash, projected to a compact on-device vector, and persisted in IndexedDB.
- Ratings, reviews, Likes, favorites, picks, and the personal fitted model are not sent to OpenAI. Personal fitting and prediction run in a dedicated browser worker.
- A content ranker is always available. A collaborative factor model may join the representation only when its source and redistribution rights are cleared.
- Held-out predictions cover every eligible rated movie. The graph draws all points on one Canvas so large profiles do not create thousands of DOM nodes.
- Prediction Score is held-out pairwise ordering accuracy. About 50 is chance. Low-confidence models show their honest score but cannot affect recommendations.
- Predicted stars have a stricter MAE and confidence gate than recommendation ordering.

### Performance expectations

- Imports finish independently of background enrichment and model rebuilding.
- Enrichment is batched and cached; failures fall back to local text features.
- The worker may use roughly one minute for a 2,000–5,000-rating profile, but the main interface must remain responsive.
- Rating changes cancel or supersede stale model requests. Cached results are keyed by taste revision and representation version.

## Privacy and cost boundaries

- Raw tonight prompts are not stored.
- Personal model training remains on-device.
- OpenAI receives public movie metadata only for embedding generation.
- TMDB supplies public catalog metadata. Required attribution must remain visible where applicable.
- Server routes are bounded and rate-limited. The embedding cache should be reused instead of regenerating unchanged movies.
- Do not ship a MovieLens-derived artifact until redistribution and commercial-use permission are confirmed. Content-only behavior must remain a complete fallback.

## Data compatibility

- Preserve existing guest and signed-in state, merge-only Letterboxd behavior, reviews, ratings, Likes, favorites, watched history, watchlist, Taste Sprint reactions, pick outcomes, and recommendation events.
- Letterboxd omissions never delete existing local data.
- Watched and watchlist must be mutually exclusive: marking a movie watched removes it from watchlist.
- Reversing Watched preserves independent Likes, favorites, watchlist choice, Taste Sprint reactions, picks, and Not for me signals; ratings/reviews require confirmation and are removed with watched-derived outcomes.
- Device-only caches and preferences must not require a cloud schema migration.

## Technical map

- App shell and views: `src/App.tsx`
- Core types: `src/types.ts`
- Recommendation ranking: `src/services/recommendations.ts`
- Prediction model: `src/services/personalRatingModel.ts`
- Evaluation and score: `src/services/ratingCalibration.ts`
- Prediction worker: `src/workers/ratingModelWorker.ts`
- Movie intelligence/cache: `src/services/movieIntelligence.ts`
- Canvas graph: `src/components/PredictionCanvas.tsx`
- TMDB integration: `src/services/tmdb.ts`
- Embedding endpoint: `api/movie-embeddings.ts`
- Letterboxd parsing and matching: `src/services/letterboxd.ts` and related import services
- Account sync: `src/services/supabase.ts` and account-state services

## Release workflow

Before reporting a release complete:

1. Confirm the active worktree, branch, remote, and dirty state.
2. Run `npm test`.
3. Run `npx tsc --noEmit`.
4. Run `npm run build`.
5. Run `git diff --check`.
6. Browser-check desktop and approximately 390px mobile, including console errors and the changed interaction.
7. Review the diff, commit only intended work, push to GitHub main, and wait for Vercel production.
8. Verify the live production bundle and behavior. A local build or Git push alone does not prove publication.

Production: <https://usepickamovie.vercel.app/>

Repository: <https://github.com/sebastianprusky/pickamovie>

## Near-term priorities

1. Measure Model 3 on a large real Letterboxd profile after enrichment completes, including score, Spearman correlation, MAE, coverage, time, and memory.
2. Confirm that richer public representations improve held-out ordering over metadata-only content features before increasing their recommendation weight.
3. Audit collaborative-data licensing and replace or remove any unclear artifact.
4. Improve explanations and Taste Sprint selection only when local outcome measures show faster or better movie decisions.
5. Keep new ideas subordinate to the three-movie ritual; prototype them separately before promoting them to primary navigation.

## Known limitations and open decisions

- Movie taste contains irreducible context and noise; a large profile improves the estimate but cannot guarantee high accuracy.
- TMDB relationship data approximates “people who liked this also liked” and is not the same as a licensed, rating-level collaborative dataset.
- Embedding enrichment may take several minutes on the first very large import because TMDB details are fetched in bounded batches. Later loads should use local and persistent caches.
- A server-side personalized model is intentionally out of scope unless privacy, operating cost, and user benefit clearly justify it.
- Any new metric must have one plain-language meaning and must not reward engagement for its own sake.
