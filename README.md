# BetterBoxd

BetterBoxd is a clean movie rating and recommendation web app prototype. It is portfolio-first, but structured so it can later support accounts, follows, reviews, and real user data.

## Current Features

- Discover page with an embedded Taste Sprint quick-rating flow
- TMDB-powered movie search when `VITE_TMDB_API_KEY` is configured
- Server-side OpenAI semantic search when `OPENAI_API_KEY` is configured
- Fallback demo movie data with real poster URLs for local testing without an API key
- Half-star rating system stored in `localStorage`
- Watchlist stored in `localStorage`
- Profile page with taste stats, watchlist, and recent ratings
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

Run the app:

```bash
npm run dev
```

Then open the local URL printed by Vite.

## Deployment

Vercel is the recommended first host for portfolio and phone testing. Add `VITE_TMDB_API_KEY` and the server-only `OPENAI_API_KEY` environment variable in Vercel before deploying.

## Product Direction

See [PRODUCT_SPEC.md](./PRODUCT_SPEC.md) for the planned product scope, layout decisions, recommendation logic, and future auth/social model.
