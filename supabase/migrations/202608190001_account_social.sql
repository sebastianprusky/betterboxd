create extension if not exists citext;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username citext not null unique,
  display_name text,
  avatar_url text,
  is_public boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_username_format check (username::text ~ '^[a-z0-9_]{3,24}$'),
  constraint profiles_display_name_length check (display_name is null or char_length(display_name) <= 80),
  constraint profiles_avatar_url_length check (avatar_url is null or (char_length(avatar_url) <= 500 and avatar_url ~ '^https://'))
);

do $$ begin
  create type public.friend_request_status as enum ('pending', 'accepted', 'declined', 'cancelled');
exception when duplicate_object then null;
end $$;

create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(user_id) on delete cascade,
  recipient_id uuid not null references public.profiles(user_id) on delete cascade,
  status public.friend_request_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint friend_requests_not_self check (requester_id <> recipient_id)
);

create unique index if not exists friend_requests_one_pending_pair
  on public.friend_requests (least(requester_id, recipient_id), greatest(requester_id, recipient_id))
  where status = 'pending';

create table if not exists public.friendships (
  user_low uuid not null references public.profiles(user_id) on delete cascade,
  user_high uuid not null references public.profiles(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_low, user_high),
  constraint friendships_canonical_pair check (user_low < user_high)
);

create table if not exists public.blocks (
  blocker_id uuid not null references public.profiles(user_id) on delete cascade,
  blocked_id uuid not null references public.profiles(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocks_not_self check (blocker_id <> blocked_id)
);

create table if not exists public.guest_merge_receipts (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  merge_key text not null,
  merged_at timestamptz not null default now(),
  primary key (user_id, merge_key),
  constraint guest_merge_key_length check (char_length(merge_key) between 8 and 120)
);

create or replace function public.is_blocked_between(first_user uuid, second_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.blocks
    where (blocker_id = first_user and blocked_id = second_user)
       or (blocker_id = second_user and blocked_id = first_user)
  );
$$;

create or replace function public.are_friends(first_user uuid, second_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select first_user is not null
     and second_user is not null
     and not public.is_blocked_between(first_user, second_user)
     and exists (
       select 1 from public.friendships
       where user_low = least(first_user, second_user)
         and user_high = greatest(first_user, second_user)
     );
$$;

create or replace function public.has_pending_request(first_user uuid, second_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.friend_requests
    where status = 'pending'
      and ((requester_id = first_user and recipient_id = second_user)
        or (requester_id = second_user and recipient_id = first_user))
  );
$$;

alter table public.profiles enable row level security;
alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;
alter table public.blocks enable row level security;
alter table public.guest_merge_receipts enable row level security;

revoke all on public.profiles, public.friend_requests, public.friendships, public.blocks, public.guest_merge_receipts from anon;
grant select on public.profiles, public.friend_requests, public.friendships, public.blocks to authenticated;
grant select, insert, update on public.guest_merge_receipts to authenticated;
revoke update on public.profiles from authenticated;
grant update (display_name, avatar_url, is_public, updated_at) on public.profiles to authenticated;

drop policy if exists "Profiles are visible within allowed relationships" on public.profiles;
create policy "Profiles are visible within allowed relationships"
  on public.profiles for select to authenticated
  using (
    auth.uid() = user_id
    or public.are_friends(auth.uid(), user_id)
    or public.has_pending_request(auth.uid(), user_id)
    or (is_public and not public.is_blocked_between(auth.uid(), user_id))
  );

drop policy if exists "Users update their own profile" on public.profiles;
create policy "Users update their own profile"
  on public.profiles for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users view their own requests" on public.friend_requests;
create policy "Users view their own requests"
  on public.friend_requests for select to authenticated
  using (auth.uid() = requester_id or auth.uid() = recipient_id);

drop policy if exists "Friends view their friendship" on public.friendships;
create policy "Friends view their friendship"
  on public.friendships for select to authenticated
  using (auth.uid() = user_low or auth.uid() = user_high);

drop policy if exists "Users view their own blocks" on public.blocks;
create policy "Users view their own blocks"
  on public.blocks for select to authenticated
  using (auth.uid() = blocker_id);

drop policy if exists "Users manage their merge receipts" on public.guest_merge_receipts;
create policy "Users manage their merge receipts"
  on public.guest_merge_receipts for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Friends can read shared app state" on public.user_app_state;
create policy "Friends can read shared app state"
  on public.user_app_state for select to authenticated
  using (public.are_friends(auth.uid(), user_id));

create or replace function public.is_username_available(candidate_username text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select candidate_username ~ '^[a-z0-9_]{3,24}$'
    and not exists (select 1 from public.profiles where username = candidate_username::citext);
$$;

create or replace function public.provision_profile(requested_username text, requested_display_name text default null)
returns table (
  user_id uuid,
  username citext,
  display_name text,
  avatar_url text,
  is_public boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_username text := lower(trim(requested_username));
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if normalized_username !~ '^[a-z0-9_]{3,24}$' then raise exception 'Username must be 3-24 lowercase letters, numbers, or underscores'; end if;

  insert into public.profiles (user_id, username, display_name)
  values (auth.uid(), normalized_username::citext, nullif(trim(requested_display_name), ''))
  on conflict on constraint profiles_pkey do nothing;

  return query select p.user_id, p.username, p.display_name, p.avatar_url, p.is_public, p.created_at, p.updated_at
    from public.profiles p where p.user_id = auth.uid();
exception when unique_violation then
  raise exception 'Username is already taken';
end;
$$;

create or replace function public.search_public_profiles(search_query text)
returns table (
  user_id uuid,
  username citext,
  display_name text,
  avatar_url text,
  is_public boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select p.user_id, p.username, p.display_name, p.avatar_url, p.is_public, p.created_at, p.updated_at
  from public.profiles p
  where auth.uid() is not null
    and p.user_id <> auth.uid()
    and p.is_public
    and not public.is_blocked_between(auth.uid(), p.user_id)
    and p.username::text ilike lower(trim(search_query)) || '%'
  order by case when p.username::text = lower(trim(search_query)) then 0 else 1 end, p.username
  limit 20;
$$;

create or replace function public.send_friend_request(target_username text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_id uuid;
  new_request_id uuid;
begin
  select user_id into target_id from public.profiles
    where username = lower(trim(target_username))::citext and is_public;
  if target_id is null then raise exception 'Public profile not found'; end if;
  if target_id = auth.uid() then raise exception 'You cannot add yourself'; end if;
  if public.is_blocked_between(auth.uid(), target_id) then raise exception 'Profile unavailable'; end if;
  if public.are_friends(auth.uid(), target_id) then raise exception 'Already friends'; end if;

  insert into public.friend_requests (requester_id, recipient_id)
  values (auth.uid(), target_id)
  returning id into new_request_id;
  return new_request_id;
end;
$$;

create or replace function public.respond_to_friend_request(request_id uuid, accept_request boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  request_row public.friend_requests%rowtype;
begin
  select * into request_row from public.friend_requests where id = request_id and status = 'pending' for update;
  if request_row.id is null or request_row.recipient_id <> auth.uid() then raise exception 'Request unavailable'; end if;
  if public.is_blocked_between(request_row.requester_id, request_row.recipient_id) then raise exception 'Request unavailable'; end if;

  update public.friend_requests
    set status = case
      when accept_request then 'accepted'::public.friend_request_status
      else 'declined'::public.friend_request_status
    end,
    updated_at = now()
    where id = request_id;
  if accept_request then
    insert into public.friendships (user_low, user_high)
    values (least(request_row.requester_id, request_row.recipient_id), greatest(request_row.requester_id, request_row.recipient_id))
    on conflict do nothing;
  end if;
end;
$$;

create or replace function public.cancel_friend_request(request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.friend_requests set status = 'cancelled'::public.friend_request_status, updated_at = now()
  where id = request_id and status = 'pending' and auth.uid() in (requester_id, recipient_id);
  if not found then raise exception 'Request unavailable'; end if;
end;
$$;

create or replace function public.remove_friend(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.friendships
  where user_low = least(auth.uid(), target_user_id) and user_high = greatest(auth.uid(), target_user_id);
end;
$$;

create or replace function public.block_user(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if target_user_id = auth.uid() then raise exception 'You cannot block yourself'; end if;
  insert into public.blocks (blocker_id, blocked_id) values (auth.uid(), target_user_id) on conflict do nothing;
  delete from public.friendships
    where user_low = least(auth.uid(), target_user_id) and user_high = greatest(auth.uid(), target_user_id);
  update public.friend_requests set status = 'cancelled'::public.friend_request_status, updated_at = now()
    where status = 'pending'
      and ((requester_id = auth.uid() and recipient_id = target_user_id)
        or (requester_id = target_user_id and recipient_id = auth.uid()));
end;
$$;

revoke all on function public.is_blocked_between(uuid, uuid) from public;
revoke all on function public.are_friends(uuid, uuid) from public;
revoke all on function public.has_pending_request(uuid, uuid) from public;
revoke all on function public.is_username_available(text) from public;
revoke all on function public.provision_profile(text, text) from public;
revoke all on function public.search_public_profiles(text) from public;
revoke all on function public.send_friend_request(text) from public;
revoke all on function public.respond_to_friend_request(uuid, boolean) from public;
revoke all on function public.cancel_friend_request(uuid) from public;
revoke all on function public.remove_friend(uuid) from public;
revoke all on function public.block_user(uuid) from public;

grant execute on function public.is_username_available(text) to authenticated;
grant execute on function public.is_blocked_between(uuid, uuid) to authenticated;
grant execute on function public.are_friends(uuid, uuid) to authenticated;
grant execute on function public.has_pending_request(uuid, uuid) to authenticated;
grant execute on function public.provision_profile(text, text) to authenticated;
grant execute on function public.search_public_profiles(text) to authenticated;
grant execute on function public.send_friend_request(text) to authenticated;
grant execute on function public.respond_to_friend_request(uuid, boolean) to authenticated;
grant execute on function public.cancel_friend_request(uuid) to authenticated;
grant execute on function public.remove_friend(uuid) to authenticated;
grant execute on function public.block_user(uuid) to authenticated;
