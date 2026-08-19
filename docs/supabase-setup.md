# Supabase Setup

This app works without Supabase, but account sync turns local browser data into cross-device saved data.

## Phone-Friendly Setup

1. Create a free Supabase project.
2. Open the Supabase SQL editor.
3. Paste and run `supabase/schema.sql`.
4. Go to Project Settings > API.
5. Copy the Project URL and anon public key.
6. Add these environment variables in Vercel:

```text
VITE_SUPABASE_URL=your_project_url
VITE_SUPABASE_ANON_KEY=your_anon_public_key
```

7. Redeploy the Vercel project.

## Auth URL Settings

In Supabase, go to Authentication > URL Configuration and set:

```text
Site URL: https://i-want-to-make-a-better.vercel.app
Redirect URLs:
https://i-want-to-make-a-better.vercel.app
https://betterboxd-sebastian-a6gp1ld08-sebastian-pruskys-projects.vercel.app
```

The app also passes the current deployed origin as `emailRedirectTo` when users create an account.

## Auth

The app currently supports email/password sign up and sign in.

Supabase may require email confirmation depending on the project's Auth settings. If confirmation is enabled, users may need to check their email before the first login fully works.

If the project is on the Supabase free tier and uses Supabase's default email provider, new projects may not be able to customize the auth email template. The app therefore tells users to look for a Supabase confirmation email for BetterBoxd.

When Supabase env vars are configured, users must sign in or explicitly continue as guest before rating, saving, reviewing, using Taste Sprint, or editing taste preferences. Guest saves stay in local browser storage and do not sync across devices. Browsing and search stay public.

## Data Model

V1 uses one row per user in `public.user_app_state`.

That row stores:

- ratings
- watchlist
- watched movies
- Taste Sprint signals
- review notes
- taste preferences
- recommendation feedback events

Row-level security ensures each user can only read and write their own row.

## Later Upgrade

Once the app has stable workflows, split `user_app_state` into normalized tables:

- `ratings`
- `watchlist_items`
- `watched_movies`
- `taste_preferences`
- `recommendation_events`

The current JSON snapshot is intentionally simple so the frontend can get real account sync first.
