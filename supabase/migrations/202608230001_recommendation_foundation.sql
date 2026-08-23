-- Recommendation-first infrastructure. This migration is additive and does not modify social tables.
create extension if not exists vector with schema extensions;

create table if not exists public.movie_embeddings (
  tmdb_id bigint primary key,
  embedding extensions.vector(1536) not null,
  embedding_model text not null,
  content_hash text not null,
  metadata jsonb not null default '{}'::jsonb,
  schema_version integer not null default 1,
  updated_at timestamptz not null default now()
);

create index if not exists movie_embeddings_hnsw_cosine
  on public.movie_embeddings using hnsw (embedding extensions.vector_cosine_ops);

create table if not exists public.movie_collaborative_factors (
  tmdb_id bigint primary key,
  factors extensions.vector(64) not null,
  bias real not null default 0,
  support integer not null default 0,
  model_version text not null,
  updated_at timestamptz not null default now()
);

create index if not exists movie_collaborative_factors_hnsw_cosine
  on public.movie_collaborative_factors using hnsw (factors extensions.vector_cosine_ops);

create table if not exists public.movie_collaborative_neighbors (
  tmdb_id bigint not null,
  neighbor_tmdb_id bigint not null,
  score real not null,
  support integer not null default 0,
  model_version text not null,
  primary key (tmdb_id, neighbor_tmdb_id)
);

create index if not exists movie_collaborative_neighbors_lookup
  on public.movie_collaborative_neighbors (tmdb_id, score desc);

create table if not exists public.movie_map_positions (
  tmdb_id bigint primary key,
  x real not null,
  y real not null,
  cluster integer,
  model_version text not null,
  updated_at timestamptz not null default now()
);

alter table public.movie_embeddings enable row level security;
alter table public.movie_collaborative_factors enable row level security;
alter table public.movie_collaborative_neighbors enable row level security;
alter table public.movie_map_positions enable row level security;

-- Model artifacts are public movie metadata. Writes remain server-only through the service role.
create policy "Public can read movie embeddings" on public.movie_embeddings for select using (true);
create policy "Public can read collaborative factors" on public.movie_collaborative_factors for select using (true);
create policy "Public can read collaborative neighbors" on public.movie_collaborative_neighbors for select using (true);
create policy "Public can read movie map positions" on public.movie_map_positions for select using (true);

