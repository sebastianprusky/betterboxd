-- Base private account-state storage. Apply this first, then apply every file in
-- supabase/migrations in filename order. The social migration adds profiles,
-- mutual friendships, blocking, merge receipts, RPCs, and friend-only read RLS.

create table if not exists public.user_app_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  app_state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_app_state enable row level security;

grant select, insert, update on public.user_app_state to authenticated;

drop policy if exists "Users can read their own app state" on public.user_app_state;
create policy "Users can read their own app state"
  on public.user_app_state
  for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own app state" on public.user_app_state;
create policy "Users can insert their own app state"
  on public.user_app_state
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own app state" on public.user_app_state;
create policy "Users can update their own app state"
  on public.user_app_state
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
