# Movie Profiles

Movie profiles are the canonical text documents used by PickAMovie recommendation and search logic.

The goal is to keep one shared representation so local vectors, fallback text search, and server-side OpenAI embeddings compare the same movie text.

## Builder

`src/services/movieProfiles.ts` exports:

- `buildMovieProfile(movie)`
- `searchMovieProfiles(query, movies)`

`src/services/localEmbeddings.ts` exports the deterministic local embedding adapter used by the recommender and semantic fallback:

- `embedText(text)`
- `cosineSimilarity(a, b)`
- `addWeightedEmbedding(target, source, weight)`
- `emptyEmbedding()`

## Profile Format

Each profile uses stable labeled fields:

```text
Title: Parasite
Year: 2019
Genres: Drama, Thriller
Overview: A struggling family inserts itself into a wealthy household...
Director: Bong Joon-ho
Cast: Song Kang-ho, Lee Sun-kyun
Keywords: class conflict, deception, wealth
Language: ko
Countries: South Korea
Decade: 2010s
TMDB similar movie IDs: ...
TMDB recommended movie IDs: ...
```

Missing fields are omitted.

## Current Usage

- Recommendation vectors are generated from `buildMovieProfile(movie)`.
- Recommendation and fallback search both use the local embedding adapter.
- Fallback local search embeds the query and compares it against embedded movie profiles.

## Current Semantic Search

The client fallback embeds this profile locally. Ask PickAMovie can also send bounded movie candidates to `api/semantic-search.ts`, which mirrors these labeled fields and embeds them with OpenAI server-side:

```text
movie_embedding = embed(buildMovieProfile(movie))
query_embedding = embed(user_query)
results = nearest_movies(query_embedding, movie_embedding)
```

Keeping the profile builder stable keeps local and remote relevance aligned.

The remaining production swap is durable vector storage:

```text
warm serverless embedding cache -> durable movie embeddings
request-time cosine scan -> pgvector nearest-neighbor query
```
