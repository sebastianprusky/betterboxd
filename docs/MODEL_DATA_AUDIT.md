# Collaborative model data audit

## Current artifact

The previously bundled `movielens-small-svd64-v1.json` was generated from
MovieLens latest-small. It contained normalized item factors, audience bias,
support, and co-like neighbor summaries for 5,000 TMDB-linked movies. It has
been removed from the production public assets.

The MovieLens dataset terms restrict commercial or revenue-bearing use without
separate permission from GroupLens. The application therefore does not load a
MovieLens-derived artifact by default. A reviewed deployment must explicitly
set both:

- `VITE_ENABLE_MOVIELENS_MODEL=true`
- `VITE_MOVIELENS_MODEL_URL` to the approved, versioned artifact URL

Without both values, Prediction Model 2.0 uses TMDB-derived content features.
The offline benchmark may use MovieLens datasets for research under their
published terms, but benchmark inputs and derived artifacts are not bundled
into the production application.

## Approval gate for a future artifact

A replacement collaborative representation may be enabled only after its data
license and redistribution terms are documented. It must also beat the
content-only model by at least two percentage points of held-out pairwise
accuracy and materially improve catalog coverage in the offline benchmark.
