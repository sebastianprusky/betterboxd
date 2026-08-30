# Collaborative model gate

No collaborative dataset derivative is bundled into the production site.
Prediction Model 2.0 uses content features unless a reviewed deployment
explicitly enables a licensed, versioned model URL.

Run the leakage-safe held-out-user research benchmark with:

```sh
npm run benchmark:rating-model -- /path/to/ml-latest-small.zip
```

See `docs/MODEL_DATA_AUDIT.md` for the licensing and accuracy gates that must be
cleared before enabling a collaborative provider.
