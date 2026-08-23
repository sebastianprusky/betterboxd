# PickAMovie

PickAMovie is a clean movie discovery, rating, recommendation, and social web app.

## Current Features

- Discover page with an embedded Taste Sprint quick-rating flow
- TMDB-powered movie search when `VITE_TMDB_API_KEY` is configured
- Ask PickAMovie mode for natural-language requests with local filter parsing, TMDB discover filtering, and semantic ranking for fuzzy intent
- Server-side OpenAI semantic search when `OPENAI_API_KEY` is configured
- Fallback demo movie data with real poster URLs for local testing without an API key
- Half-star rating system stored in `localStorage`
- Watchlist stored in `localStorage`
- Weighted recommendation engine using ratings, watchlist saves, Taste Sprint signals, and optional onboarding preferences
- TMDB detail enrichment for keywords, credits, country/language, and similar/recommended movie relationships
- Shared local embedding adapter for recommendation vectors and fallback semantic-style search
- Local movie catalog cache fed by TMDB trending, popular, top-rated, upcoming, search, and viewed details
- Diversity reranking so recommendations are less repetitive
- Focused, Balanced, and Exploratory recommendation modes
- Brief recommendation reasons in the Recommended section
- Local recommendation feedback loop that tracks which recommendations get opened, saved, or highly rated
- Profile settings for editing optional onboarding inputs: favorite genres, movies, and directors
- Unobtrusive guest mode with Supabase email/password sign-in from the profile menu
- Required unique public username after first authentication; email is never public
- Idempotent first-sign-in merge of local ratings, lists, reviews, Taste Sprint signals, preferences, and recommendation feedback
- Public/private profile discovery, mutual friend requests, full friend-only activity sharing, removal, and blocking
- Profile page with taste stats, watchlist, and recent ratings
- Hidden Developer mode in Profile Settings for semantic-search and recommender diagnostics
- Persistent `+ Watched` quick-add flow
- Light/dark theme toggle with a pale green accent
- Responsive layout for phone and desktop

## Setup

Install dependencies:

```bash
npm install
```

Create a local env file:

```bash
cp .env.example .env.local
```

Add your API keys:

```bash
VITE_TMDB_API_KEY=your_tmdb_api_key_here
OPENAI_API_KEY=your_server_side_openai_api_key_here
```

`OPENAI_API_KEY` must remain server-side only. The browser calls `/api/semantic-search`, and the app falls back to local movie matching when the key is absent or the server route is unavailable.

The semantic search route is public, so it applies request-size, field-length, candidate-count, warm-instance cache, and basic per-IP rate-limit controls before calling OpenAI. Vercel serverless instances do not share memory globally, so configure provider spend limits before enabling billing.

To enable account sync, create a free Supabase project, run [supabase/schema.sql](./supabase/schema.sql), then apply [the account/social migration](./supabase/migrations/202608190001_account_social.sql) in the Supabase SQL editor. Add:

```bash
VITE_SUPABASE_URL=your_supabase_project_url_here
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key_here
```

Without Supabase env vars, the app remains fully usable as a local guest. Do not claim account sync or social access is live until the schema, RLS policies, auth redirect URLs, and end-to-end flows have been verified against the intended project.

Existing users who previously signed in with email links should use **Reset password** from the PickAMovie sign-in modal. Supabase sends a recovery link for the same verified email account, so the existing profile, username, friend graph, and first-sign-in merge receipt stay attached to the same auth user instead of creating a duplicate account.

Run the app:

```bash
npm run dev
```

Then open the local URL printed by Vite.

## Deployment

Vercel is the recommended first host for portfolio and phone testing. Add `VITE_TMDB_API_KEY` and the server-only `OPENAI_API_KEY` before deploying. Add the two `VITE_SUPABASE_*` variables only after applying and verifying both Supabase SQL files against the intended project.

## Product Direction

See [PRODUCT_SPEC.md](./PRODUCT_SPEC.md) for the planned product scope, layout decisions, recommendation logic, and future auth/social model.

See [docs/recommendation-engine.md](./docs/recommendation-engine.md) for the local recommender, OpenAI embedding path, and Postgres + pgvector schema.

See [docs/movie-profiles.md](./docs/movie-profiles.md) for the canonical movie text profile used by recommendations, fallback search, and future semantic search.
