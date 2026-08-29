# Collaborative recommendation seed

`movielens-small-svd64-v1.json` is generated from the official MovieLens
`latest-small` dataset by `scripts/build_movielens_model.py`. It contains
deterministic 64-dimensional item factors and support-shrunk co-like neighbors,
mapped to TMDB IDs through MovieLens `links.csv`.

The browser treats these as fixed movie representations, then learns a
regularized personal taste vector from the current user's ratings. Factor,
content, and hybrid ridge models compete in nested held-out tests; predictions
are enabled only when the winner beats the simple baselines on error and rating
order. Run the leakage-safe held-out-user benchmark with:

```sh
npm run benchmark:rating-model -- /path/to/ml-latest-small.zip
```

MovieLens data is licensed for research and noncommercial use. Replace this
provider or obtain permission before monetizing PickAMovie.
