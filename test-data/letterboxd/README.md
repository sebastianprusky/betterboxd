# Synthetic Letterboxd test exports

These ZIP files are generated test fixtures. They contain no real Letterboxd account or personal information.

- `wide-ranging-cinephile.zip` exercises broad genre and rating coverage.
- `midnight-genre-fan.zip` creates strong horror, science-fiction, thriller, fantasy, and animation preferences.
- `comfort-blockbuster-fan.zip` favors comedy, adventure, animation, family films, and accessible crowd-pleasers.

Each archive includes ratings, watched movies, diary entries, reviews, a watchlist, liked films, and a synthetic profile. Upload the ZIP directly through PickAMovie's Letterboxd import control. PickAMovie reads the five core files plus `likes/films.csv` and safely ignores the synthetic profile and README.

The fixtures are deterministic and based on movie titles, genres, and anonymous aggregate rating statistics from the public MovieLens latest-small dataset. Ratings and reviews are synthetic; they do not represent real people.

Regenerate them with:

```sh
node scripts/generate-letterboxd-test-exports.mjs
```

You may optionally pass a local `ml-latest-small.zip` path to avoid downloading the public dataset again.
