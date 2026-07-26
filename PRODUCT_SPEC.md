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

Initial algorithm:

- Collect movies the user rated highly, especially 4 stars and above
- Weight genres, directors, release eras, and keywords from those movies
- Recommend unrated movies with overlapping attributes
- Penalize movies similar to low-rated movies
- Explain recommendations in plain language, such as “Recommended because you rated sci-fi dramas highly”

Portfolio demo version:

- Use TMDB metadata plus local rating data
- Start with genre-weighted scoring
- Add director/keyword weighting if the API data supports it cleanly

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
- Hosted on Vercel or Netlify

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

## 14. Build Plan

### Phase 1: Portfolio Demo

- Replace the current static seed library with TMDB search
- Add rating persistence with local storage
- Add watchlist persistence with local storage
- Build clean responsive UI for phone and desktop
- Remove the decorative generated image direction
- Add a quick-rating flow that makes rating movies feel fast and addictive
- Write clear README setup and deployment instructions

### Phase 2: Hosted Demo

- Push to GitHub
- Deploy with GitHub Pages, Vercel, or Netlify
- Add environment variable handling for TMDB
- Test from phone using the hosted URL

### Phase 3: Real User Foundation

- Add authentication
- Move ratings and watchlist to a database
- Add public profiles
- Add following
- Add taste comparison

## 15. Open Decisions

- Exact implementation of quick-rating / taste-matching interaction
- Whether to require a TMDB API key before the first usable demo
- Final app icon / logo mark

## 16. Decisions Made

- App name: BetterBoxd for now
- Theme: light and dark mode, with a user-facing toggle
- Accent color: pale green
- Stack: React + Vite
- Movie API: TMDB
- Hosting: Vercel, assuming portfolio/personal use remains within the free Hobby plan
- Future auth: Google login plus email/password
- Rating style: half-stars
- Watchlist behavior: users can mark a watchlist movie as watched by rating it
- Reviews: reserve data model space, but do not build review UI in v1
- Navigation: Discover, Search, Profile
- Taste Sprint placement: embedded inside Discover, not a standalone tab
- Watchlist placement: inside Profile, not a standalone tab
- Primary quick action: persistent plus button for adding a watched movie

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
