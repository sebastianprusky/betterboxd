# BetterBoxd Product Spec

## 1. Product Goal

BetterBoxd is a portfolio-first movie discovery web app that could grow into a real social product. It should feel like a cleaner, more useful alternative to Letterboxd: less clutter, better everyday UX, and recommendations based on a user’s ratings.

The first version should be impressive enough for a portfolio viewer to understand the product vision quickly, while keeping the architecture realistic for future accounts, saved data, and public hosting.

## 2. Target Users

- Movie fans who want a cleaner way to rate and track films
- People who want useful recommendations based on their own taste
- Social users who want to follow friends and compare taste without a noisy interface
- Portfolio reviewers evaluating product thinking, UI quality, and implementation skill

## 3. Core Differentiators

- Cleaner UI than Letterboxd, with fewer competing panels and less visual noise
- Ratings-first recommendation system
- Taste matching features that explain why a movie is suggested
- Modern social app structure based on following, not mutual friend requests
- Mobile-friendly from the start, with a polished desktop layout

## 4. V1 Scope

V1 should focus on three core workflows:

1. Search movies
2. Rate movies
3. Add movies to a watchlist

Everything else should support those workflows, not distract from them.

## 5. V1 Pages

### Home / Discover

Purpose: Give users a fast path into search, recommendations, and watchlist activity.

Core elements:

- Search bar
- Recommended movies
- Recently popular or featured movies
- Quick rating controls
- Quick watchlist controls

### Search

Purpose: Let users find any movie, similar to Letterboxd.

Core elements:

- Movie search powered by a real movie API
- Results with poster, title, year, rating state, and watchlist action
- Filters can come later; search quality matters more for v1

### Movie Detail

Purpose: Provide enough movie context to rate or save a movie.

Core elements:

- Poster
- Title, year, runtime, genres
- Overview
- Rating control
- Watchlist button
- Recommendation explanation if applicable

### Watchlist

Purpose: Let users save movies they want to watch.

Core elements:

- Saved movie list
- Search within watchlist
- Remove from watchlist
- Rating action once watched

### Profile

Purpose: Show the user’s taste and activity.

Core elements:

- Rated movie count
- Average rating
- Favorite genres based on ratings
- Highest-rated movies
- Watchlist count

## 6. Later Social Scope

Social features should be designed into the data model but not overbuilt in the first demo.

Later features:

- User accounts
- Follow/unfollow users
- Public profiles
- Compare taste with another user
- Friend/following activity feed
- Reviews and comments
- Shared recommendation explanations such as “people you follow rated this highly”

Following should work like Letterboxd/Twitter, not mutual friend requests.

## 7. Movie Data

BetterBoxd should eventually support all movies, not a small fixed catalog.

Recommended API:

- TMDB for movie search, posters, metadata, genres, and trending/popular lists

Why:

- Large movie database
- Good search coverage
- Free developer tier
- Common choice for portfolio projects

Important implementation note:

- The API key should not be committed to GitHub.
- For a static portfolio demo, the app can use a public client-side key only if acceptable for the API’s rules.
- For a production-style version, API calls should go through a small backend or serverless function.

## 8. Recommendation Logic

V1 recommendations should be based on ratings.

Implemented portfolio algorithm:

- Collect ratings as the strongest signal, including negative weight for low ratings
- Use watchlist adds as weaker positive signals
- Use Taste Sprint responses as lightweight interest signals
- Let Profile settings seed favorite genres, favorite movies, and directors, with every field optional
- Build deterministic local text vectors from title, overview, genres, keywords, director, cast, country/language, and release decade
- Use a shared canonical movie profile builder as the source text for recommendation vectors, fallback search, and server-side embeddings
- Use a shared local embedding adapter for the recommender and no-key/server-unavailable semantic fallback
- Enrich TMDB-backed movie profiles with keywords, credits, country/language, and similar/recommended relationships
- Recommend unrated and unwatched candidates with mode-specific ranking weights
- Maintain a bounded local movie catalog cache so recommendations have a larger candidate pool
- Apply diversity reranking to avoid overly similar recommendation lists
- Show short deterministic reasons for recommended movies
- Log recommendation impressions and outcomes locally
- Show only a compact user-facing feedback summary in Profile

Portfolio demo version:

- Use TMDB metadata plus local rating data
- Use the local vector recommender so the app stays free to run
- Keep the model shape compatible with a later OpenAI embedding + pgvector backend

Recommendation modes:

- Focused: prioritize similarity to the user taste vector
- Balanced: blend similarity, popularity, rating quality, and novelty
- Exploratory: increase novelty/diversity while keeping some taste match

## 9. Visual Direction

Style: modern social app, clean and simple.

Reference direction:

- Arc Search for mobile simplicity, search-first behavior, and calm spacing
- Linear for desktop structure, sidebar navigation, compact hierarchy, and polished utility feel
- Raycast for fast command-like actions and keyboard-friendly interaction
- Beli for quick addictive taste-building interactions

The goal is not to copy any one app. BetterBoxd should feel like a clean social movie app with Arc's simplicity, Linear's polish, and Beli's quick taste loop.

Principles:

- No busy cinematic hero art
- No decorative poster walls or noisy backgrounds
- Use movie posters as the primary visual assets
- Neutral app shell with restrained accent colors
- Strong spacing, clear typography, and readable controls
- Mobile-first flows with a desktop layout that uses space well

Preferred palette:

- Background: soft off-white in light mode, deep charcoal in dark mode
- Text: high-contrast neutral
- Accent: pale green
- Ratings: warm star color
- Surfaces: subtle neutral panels with soft borders

Avoid:

- Heavy gradients
- Large decorative images
- Overly dark one-color theme
- Cluttered cards
- Marketing-style landing page

## 10. Responsive Requirements

The app must work well on phone and desktop.

Phone:

- Bottom navigation or compact top navigation
- Search should be reachable immediately
- Movie cards should be easy to scan one-handed
- Rating and watchlist controls must be large enough to tap

Desktop:

- Use a wider layout with navigation, search, and content areas
- Avoid stretching cards too wide
- Keep movie detail pages readable with poster and metadata side by side

## 11. Testing From Phone

The user prefers not to rely on same-Wi-Fi local testing.

Best options:

- Deploy preview with Vercel, Netlify, Cloudflare Pages, or GitHub Pages
- Use a temporary tunnel such as ngrok or Cloudflare Tunnel for local development

Recommendation:

- Use Vercel for portfolio-visible demos and phone testing
- Vercel has a free Hobby plan for personal/non-commercial projects
- Use Vercel preview deployments once the app becomes React/Next-based

## 12. Suggested Tech Stack

For the current portfolio version:

- React + Vite
- TypeScript
- CSS modules or regular CSS with a small design token system
- TMDB API
- Local storage for demo ratings and watchlist
- Light/dark theme toggle

For later real users:

- Supabase for auth and database
- User table, ratings table, watchlist table, follows table
- Serverless API route or edge function for protected API calls
- PostgreSQL `pgvector` for cached movie embeddings
- OpenAI `text-embedding-3-small` for public movie metadata embeddings
- Hosted on Vercel or Netlify

Current persistence implementation:

- Supabase Auth is supported when `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are configured
- `localStorage` remains the default fallback
- Account sync stores the user's current app state in one RLS-protected `user_app_state` row
- When Supabase is configured, saving profile data requires sign-in or an explicit guest choice
- Guest saves use local browser storage and do not sync across devices
- Browsing/search/movie detail can remain public, but rating, watchlist, review, Taste Sprint, and preference edits are gated
- The normalized ratings/watchlist schema can replace the JSON snapshot once the product workflow stabilizes

## 13. Data Model Draft

### User

- id
- username
- displayName
- avatarUrl
- createdAt

### Movie

- tmdbId
- title
- year
- posterPath
- overview
- genres
- runtime
- director
- cast
- embedding
- embeddingModel
- embeddingUpdatedAt

### OnboardingPreferences

- userId
- genres
- directors
- favoriteTmdbIds
- updatedAt

### Rating

- id
- userId
- tmdbId
- rating
- createdAt
- updatedAt

### WatchlistItem

- id
- userId
- tmdbId
- createdAt

### Follow

- id
- followerUserId
- followingUserId
- createdAt

## 14. Build Status and Next Steps

### Current Local Baseline

- TMDB search plus a fallback demo catalog
- Ask BetterBoxd natural-language search with server-side semantic ranking and local fallback
- Local ratings, watchlist, watched state, reviews, Taste Sprint signals, and recommendation feedback
- Weighted, diversity-reranked local recommendations built from canonical movie profiles
- Responsive phone and desktop UI
- Optional Supabase email/password account sync through an RLS-protected `user_app_state` row
- Unique username onboarding, public/private discovery, mutual friendship, and blocking

### Deployment Verification

- Configure TMDB, server-only OpenAI, and optional Supabase environment variables
- Apply and verify `supabase/schema.sql` against the intended Supabase project before claiming account sync is live
- Verify the hosted search, auth, sync, and mobile flows after deployment

### Later Product Foundation

- Replace JSON snapshot persistence with normalized interaction tables when workflows stabilize
- Move movie embeddings and candidate search to durable PostgreSQL + `pgvector`
- Add public profiles
- Add following
- Add taste comparison

## 15. Open Decisions

- Final app icon / logo mark
- Whether Google login is needed in addition to email/password
- When private review notes should become public/social reviews

## 16. Decisions Made

- App name: BetterBoxd for now
- Theme: light and dark mode, with a user-facing toggle
- Accent color: pale green
- Stack: React + Vite
- Movie API: TMDB
- Hosting: Vercel, assuming portfolio/personal use remains within the free Hobby plan
- Auth: email/password through Supabase; existing email-link users set a password through the normal recovery flow for the same account; Google login remains optional future scope
- Rating style: half-stars
- Watchlist behavior: users can mark a watchlist movie as watched by rating it
- Reviews: private synced review notes now; public/social reviews remain future scope
- Navigation: Discover, Search, Profile
- Taste Sprint placement: embedded inside Discover, not a standalone tab
- Watchlist placement: inside Profile, not a standalone tab
- Primary quick action: persistent plus button for adding a watched movie
- Recommendation inputs: weighted ratings, watchlist saves, Taste Sprint signals, and optional onboarding preferences
- Recommendation modes: Focused, Balanced, Exploratory
- Production recommender direction: OpenAI embeddings cached in PostgreSQL with `pgvector`
- Persistence direction: Supabase Auth plus RLS-protected account sync, with local browser storage as fallback
- Public identity: unique username only; email is private and never searchable
- Social graph: mutual friends, not following; full activity is visible only to accepted, unblocked friends
- Privacy: private accounts are undiscoverable but retain existing friends

## 17. Addictive UX Feature

Working name: Taste Sprint.

Taste Sprint is a fast swipe-style movie rating flow. The user sees one movie at a time and can make quick decisions:

- Swipe right / tap check: add to watchlist
- Swipe left / tap skip: not interested
- Swipe up / tap stars: rate if already watched
- Long press / details button: open the movie detail view

Why it fits BetterBoxd:

- It turns onboarding into a fun taste-building loop
- It gives the recommendation engine useful rating data quickly
- It works especially well on phones
- It creates a portfolio-worthy interaction without needing full social features first

Important constraint:

- The feature should not replace normal search. Search remains the core utility. Taste Sprint is the fast, fun layer that improves recommendations.

Implementation plan:

- Use TMDB popular/trending/search results as the card source
- Keep a local queue of unseen movies
- Store each action as taste feedback: rated, watchlisted, skipped, or opened
- Update recommendations after each rating
- Add keyboard support on desktop: left arrow skips, right arrow watchlists, number keys rate
- Use simple motion: card slides out, next card moves in, no excessive animation

Later expansion:

- Compare two movies side by side and ask “Which did you like more?”
- Use pairwise comparisons to refine rankings when star ratings feel hard
- Generate taste badges such as “slow-burn sci-fi,” “character drama,” or “high-energy animation”
