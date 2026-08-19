# Supabase Setup

This app works without Supabase, but account sync turns local browser data into cross-device saved data.

## Phone-Friendly Setup

1. Create a free Supabase project.
2. Open the Supabase SQL editor.
3. Paste and run `supabase/schema.sql`.
4. Paste and run `supabase/migrations/202608190001_account_social.sql`.
5. Go to Project Settings > API.
6. Copy the Project URL and anon public key.
7. Add these environment variables in Vercel:

```text
VITE_SUPABASE_URL=your_project_url
VITE_SUPABASE_ANON_KEY=your_anon_public_key
```

8. Configure passwordless email redirect URLs, then redeploy the Vercel project.

## Auth URL Settings

In Supabase, go to Authentication > URL Configuration and set:

```text
Site URL: https://i-want-to-make-a-better.vercel.app
Redirect URLs:
https://i-want-to-make-a-better.vercel.app
https://betterboxd-sebastian-a6gp1ld08-sebastian-pruskys-projects.vercel.app
```

The app also passes the current deployed origin as `emailRedirectTo` when users create an account.

## Auth and Public Identity

The app uses passwordless email sign-in. After the first authenticated session, the user must claim a unique lowercase username before profile provisioning and local-data merge. Email remains in Supabase Auth and is never stored in `public.profiles` or returned by social search.

Users can always continue as guests. Guest activity remains local and no sign-in prompt interrupts Discover or Search.

If the project is on the Supabase free tier and uses Supabase's default email provider, new projects may not be able to customize the auth email template. The app therefore tells users to look for a Supabase confirmation email for BetterBoxd.

On first completed sign-in, local activity is deterministically merged with account state. Collection entries are unioned, editable values use update metadata, recommendation events are deduplicated by ID, and a per-account/device receipt makes retries idempotent.

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

The social migration adds a friend-read policy: accepted, unblocked friends can read the full row. Public strangers can only read basic identity fields from `profiles`; they cannot read app state. Private profiles are excluded from username search and new requests. Blocking removes friendship and pending requests and immediately revokes profile/app-state access in both directions.

## Later Upgrade

Once the app has stable workflows, split `user_app_state` into normalized tables:

- `ratings`
- `watchlist_items`
- `watched_movies`
- `taste_preferences`
- `recommendation_events`

The current JSON snapshot is intentionally simple so the frontend can get real account sync first.
