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

8. Configure auth redirect URLs for Google OAuth, then redeploy the Vercel project.

## Auth URL Settings

In Supabase, go to Authentication > URL Configuration and set:

```text
Site URL: https://usepickamovie.vercel.app
Redirect URLs:
https://usepickamovie.vercel.app
```

The app passes the current deployed origin for Google OAuth redirects and legacy password-recovery redirects. Add each production and preview origin that should accept Supabase auth callbacks.

## Google Sign-In

PickAMovie’s public account flow is Google-first so sign-up does not depend on Supabase’s default auth email sender. In Supabase, enable Authentication > Sign In / Providers > Google only after a Google OAuth client exists.

Use the production Supabase callback URL in Google Cloud as an authorized redirect URI:

```text
https://rkkqbfuxorbunwewyowm.supabase.co/auth/v1/callback
```

Use the public Vercel app as an authorized JavaScript origin:

```text
https://usepickamovie.vercel.app
```

After Google redirects back, the app still requires the user to choose a unique public username before profile provisioning and guest-data merge. Email remains private and is not stored in `public.profiles`.

## Creator Account Overview

The private account overview is served through `/api/creator-account-overview` and should only be deployed with server-only environment variables:

```text
SUPABASE_SERVICE_ROLE_KEY=server_only_service_role_key
PICKAMOVIE_CREATOR_USER_ID=creator_supabase_auth_user_id
```

Do not prefix the service-role key with `VITE_`. The browser dashboard sends the current Supabase session token to the API; the API verifies that token belongs to the creator user id before using the service-role key server-side. The response intentionally omits email, passwords, reset links, secrets, and private movie data. It only returns aggregate counts and minimal profile identity/activity counts.

## Auth and Public Identity

The app uses Supabase Google OAuth for public sign-in. Email/password sign-in is retained only as an existing-account fallback; public email/password account creation and reset links require production SMTP and should remain hidden until that delivery path is configured. After the first authenticated session, the user must claim a unique lowercase username before profile provisioning and local-data merge. Email remains in Supabase Auth and is never stored in `public.profiles` or returned by social search.

Users who previously authenticated with email links can only use password recovery after production SMTP is configured. Supabase recovery sets a password on the existing verified email account, preserving the original auth user id, profile, username, friend graph, and merge receipts. PickAMovie never asks an operator to set or handle a user's password.

Users can always continue as guests. Guest activity remains local and no sign-in prompt interrupts Discover or Search.

If the project is on the Supabase free tier and uses Supabase's default email provider, new projects may not be able to customize the auth email template. The app therefore uses generic confirmation and recovery copy and does not depend on a custom template.

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
