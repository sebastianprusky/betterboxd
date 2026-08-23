#!/usr/bin/env python3
"""Build a deterministic, browser-sized MovieLens collaborative seed model."""

from __future__ import annotations

import argparse
import csv
import io
import json
import zipfile
from collections import defaultdict
from pathlib import Path

import numpy as np


def read_csv(archive: zipfile.ZipFile, suffix: str):
    name = next(name for name in archive.namelist() if name.endswith(suffix))
    with archive.open(name) as raw:
        yield from csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8"))


def build_model(dataset: Path, output: Path, limit: int = 5000, dimensions: int = 64):
    with zipfile.ZipFile(dataset) as archive:
        tmdb_by_movie = {
            int(row["movieId"]): int(row["tmdbId"])
            for row in read_csv(archive, "links.csv")
            if row.get("tmdbId")
        }
        ratings = [
            (int(row["userId"]), int(row["movieId"]), float(row["rating"]))
            for row in read_csv(archive, "ratings.csv")
            if int(row["movieId"]) in tmdb_by_movie
        ]

    support = defaultdict(int)
    for _, movie_id, _ in ratings:
        support[movie_id] += 1
    movie_ids = [movie_id for movie_id, _ in sorted(support.items(), key=lambda item: (-item[1], item[0]))[:limit]]
    selected = set(movie_ids)
    user_ids = sorted({user_id for user_id, movie_id, _ in ratings if movie_id in selected})
    user_index = {user_id: index for index, user_id in enumerate(user_ids)}
    movie_index = {movie_id: index for index, movie_id in enumerate(movie_ids)}

    user_values = defaultdict(list)
    for user_id, movie_id, rating in ratings:
        if movie_id in selected:
            user_values[user_id].append(rating)
    user_means = {user_id: float(np.mean(values)) for user_id, values in user_values.items()}

    matrix = np.zeros((len(movie_ids), len(user_ids)), dtype=np.float32)
    likes = np.zeros_like(matrix)
    raw_by_movie = defaultdict(list)
    for user_id, movie_id, rating in ratings:
        row = movie_index.get(movie_id)
        if row is None:
            continue
        column = user_index[user_id]
        matrix[row, column] = rating - user_means[user_id]
        likes[row, column] = 1.0 if rating >= 4.0 else 0.0
        raw_by_movie[movie_id].append(rating)

    rng = np.random.default_rng(20260823)
    projected = matrix @ rng.normal(size=(matrix.shape[1], dimensions + 8)).astype(np.float32)
    for _ in range(2):
        projected = matrix @ (matrix.T @ projected)
    basis, _ = np.linalg.qr(projected, mode="reduced")
    compressed = basis.T @ matrix
    left_small, singular, _ = np.linalg.svd(compressed, full_matrices=False)
    factors = (basis @ left_small[:, :dimensions]) * np.sqrt(singular[:dimensions])
    factor_norms = np.linalg.norm(factors, axis=1, keepdims=True)
    factors = np.divide(factors, factor_norms, out=np.zeros_like(factors), where=factor_norms > 0)

    like_norms = np.linalg.norm(likes, axis=1)
    neighbors: list[list[dict[str, float | int]]] = [[] for _ in movie_ids]
    for start in range(0, len(movie_ids), 160):
        stop = min(start + 160, len(movie_ids))
        co_likes = likes[start:stop] @ likes.T
        denominator = like_norms[start:stop, None] * like_norms[None, :]
        cosine = np.divide(co_likes, denominator, out=np.zeros_like(co_likes), where=denominator > 0)
        shrunk = cosine * (co_likes / (co_likes + 10.0))
        for offset, row_scores in enumerate(shrunk):
            row_index = start + offset
            row_scores[row_index] = -1
            best = np.argpartition(row_scores, -12)[-12:]
            best = best[np.argsort(row_scores[best])[::-1]]
            neighbors[row_index] = [
                {
                    "tmdbId": tmdb_by_movie[movie_ids[index]],
                    "score": round(float(row_scores[index]), 4),
                    "support": int(co_likes[offset, index]),
                }
                for index in best
                if row_scores[index] > 0
            ]

    items = {}
    for index, movie_id in enumerate(movie_ids):
        values = raw_by_movie[movie_id]
        items[str(tmdb_by_movie[movie_id])] = {
            "tmdbId": tmdb_by_movie[movie_id],
            "factors": [round(float(value), 5) for value in factors[index]],
            "bias": round((float(np.mean(values)) - 3.5) / 1.5, 4),
            "support": len(values),
            "neighbors": neighbors[index],
        }

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({
        "version": "movielens-latest-small-svd64-v1",
        "dimensions": dimensions,
        "source": "MovieLens latest-small; deterministic randomized SVD and shrunk co-like neighbors",
        "items": items,
    }, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {len(items)} mapped movies to {output} ({output.stat().st_size / 1_000_000:.2f} MB)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--limit", type=int, default=5000)
    args = parser.parse_args()
    build_model(args.dataset, args.output, args.limit)
