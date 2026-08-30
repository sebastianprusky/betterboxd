#!/usr/bin/env python3
"""Leakage-safe offline benchmark for PickAMovie Prediction Model 2.0.

This script is research tooling only. It never ships ratings or a MovieLens-derived
artifact to the browser. It compares fixed-size personal models on users excluded
from collaborative representation training.
"""

from __future__ import annotations

import argparse
import csv
import io
import math
import time
import tracemalloc
import zipfile
from collections import defaultdict
from pathlib import Path

import numpy as np

try:
    from scipy.sparse import coo_matrix
    from sklearn.decomposition import TruncatedSVD
except ImportError:  # Small datasets can use the deterministic NumPy fallback.
    coo_matrix = None
    TruncatedSVD = None


PROFILE_SIZES = (20, 100, 500, 2_000, 5_000)
MODELS = ("user-mean", "audience", "current-kernel", "content-ridge", "factor-fold-in", "hybrid-ridge")


def read_csv(archive: zipfile.ZipFile, suffix: str):
    name = next(name for name in archive.namelist() if name.endswith(suffix))
    with archive.open(name) as raw:
        yield from csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8"))


def read_dataset(dataset: Path):
    with zipfile.ZipFile(dataset) as archive:
        genres = {
            int(row["movieId"]): tuple(value for value in row["genres"].split("|") if value and value != "(no genres listed)")
            for row in read_csv(archive, "movies.csv")
        }
        ratings = [
            (int(row["userId"]), int(row["movieId"]), float(row["rating"]), int(row.get("timestamp") or 0))
            for row in read_csv(archive, "ratings.csv")
        ]
    return ratings, genres


def build_representation(ratings, dimensions=64, item_limit=30_000):
    support = defaultdict(int)
    values = defaultdict(list)
    for _, movie_id, rating, _ in ratings:
        support[movie_id] += 1
        values[movie_id].append(rating)
    movies = [movie_id for movie_id, _ in sorted(support.items(), key=lambda item: (-item[1], item[0]))[:item_limit]]
    movie_index = {movie_id: index for index, movie_id in enumerate(movies)}
    users = sorted({user_id for user_id, movie_id, _, _ in ratings if movie_id in movie_index})
    user_index = {user_id: index for index, user_id in enumerate(users)}
    user_values = defaultdict(list)
    for user_id, movie_id, rating, _ in ratings:
        if movie_id in movie_index:
            user_values[user_id].append(rating)
    means = {user_id: float(np.mean(rows)) for user_id, rows in user_values.items()}
    rows, columns, data = [], [], []
    for user_id, movie_id, rating, _ in ratings:
        if movie_id not in movie_index:
            continue
        rows.append(movie_index[movie_id]); columns.append(user_index[user_id]); data.append(rating - means[user_id])
    if coo_matrix is not None and TruncatedSVD is not None:
        matrix = coo_matrix((data, (rows, columns)), shape=(len(movies), len(users)), dtype=np.float32).tocsr()
        factors = TruncatedSVD(n_components=dimensions, random_state=20260829, n_iter=7).fit_transform(matrix)
    else:
        if len(movies) * len(users) > 30_000_000:
            raise SystemExit("Large MovieLens benchmarks require scipy and scikit-learn: python3 -m pip install scipy scikit-learn")
        matrix = np.zeros((len(movies), len(users)), dtype=np.float64)
        matrix[rows, columns] = data
        left, singular, _ = np.linalg.svd(matrix, full_matrices=False)
        factors = left[:, :dimensions] * np.sqrt(singular[:dimensions])
    norms = np.linalg.norm(factors, axis=1, keepdims=True)
    factors = np.divide(factors, norms, out=np.zeros_like(factors), where=norms > 0)
    global_mean = float(np.mean([rating for _, _, rating, _ in ratings]))
    item_bias = {
        movie_id: (float(np.mean(values[movie_id])) - global_mean) * len(values[movie_id]) / (len(values[movie_id]) + 25)
        for movie_id in movies
    }
    return movie_index, factors, item_bias, global_mean


def content_matrix(movie_ids, genres):
    vocabulary = sorted({genre for values in genres.values() for genre in values})
    genre_index = {genre: index for index, genre in enumerate(vocabulary)}
    matrix = np.zeros((len(movie_ids), len(vocabulary) + 2), dtype=np.float64)
    for row, movie_id in enumerate(movie_ids):
        for genre in genres.get(movie_id, ()):
            matrix[row, genre_index[genre]] = 1 / math.sqrt(max(1, len(genres.get(movie_id, ()))))
        matrix[row, -2] = 1
        matrix[row, -1] = math.log1p(movie_id % 10_000) / 10
    return matrix


def feature_rows(movie_ids, kind, movie_index, factors, genres):
    content = content_matrix(movie_ids, genres)
    factor = np.zeros((len(movie_ids), factors.shape[1]), dtype=np.float64)
    coverage = 0
    for row, movie_id in enumerate(movie_ids):
        index = movie_index.get(movie_id)
        if index is not None:
            factor[row] = factors[index]
            coverage += 1
    if kind == "content-ridge":
        return content, coverage / max(1, len(movie_ids))
    if kind == "factor-fold-in":
        return factor, coverage / max(1, len(movie_ids))
    return np.concatenate((factor, content), axis=1), coverage / max(1, len(movie_ids))


def ridge_predictions(train, test, kind, movie_index, factors, item_bias, genres, regularization=2.0):
    train_ids = [movie_id for movie_id, _, _ in train]
    test_ids = [movie_id for movie_id, _, _ in test]
    mean_rating = (sum(rating for _, rating, _ in train) + 14) / (len(train) + 4)
    if kind == "user-mean":
        return np.full(len(test), mean_rating), 1.0
    if kind == "audience":
        return np.array([np.clip(mean_rating + item_bias.get(movie_id, 0) * .45, .5, 5) for movie_id in test_ids]), sum(movie_id in movie_index for movie_id in test_ids) / max(1, len(test_ids))
    x_train, _ = feature_rows(train_ids, kind, movie_index, factors, genres)
    x_test, coverage = feature_rows(test_ids, kind, movie_index, factors, genres)
    baseline = np.array([mean_rating + item_bias.get(movie_id, 0) * .45 for movie_id in train_ids])
    residuals = np.array([rating for _, rating, _ in train]) - baseline
    with np.errstate(over="ignore", invalid="ignore", divide="ignore"):
        weights = np.linalg.solve(x_train.T @ x_train + np.eye(x_train.shape[1]) * regularization, x_train.T @ residuals)
    prior = np.array([mean_rating + item_bias.get(movie_id, 0) * .45 for movie_id in test_ids])
    with np.errstate(over="ignore", invalid="ignore", divide="ignore"):
        predicted = np.clip(prior + x_test @ weights, .5, 5)
    if not np.isfinite(predicted).all():
        raise ValueError(f"{kind} produced non-finite predictions")
    return predicted, coverage


def kernel_predictions(train, test, movie_index, factors, item_bias):
    if len(train) > 500:
        return None, 0.0
    ids = [movie_id for movie_id, _, _ in train]
    targets = [movie_id for movie_id, _, _ in test]
    x_train = np.array([factors[movie_index[movie_id]] if movie_id in movie_index else np.zeros(factors.shape[1]) for movie_id in ids])
    x_test = np.array([factors[movie_index[movie_id]] if movie_id in movie_index else np.zeros(factors.shape[1]) for movie_id in targets])
    mean_rating = (sum(rating for _, rating, _ in train) + 14) / (len(train) + 4)
    residuals = np.array([rating - (mean_rating + item_bias.get(movie_id, 0) * .45) for movie_id, rating, _ in train])
    with np.errstate(over="ignore", invalid="ignore", divide="ignore"):
        alpha = np.linalg.solve(x_train @ x_train.T + np.eye(len(train)) * 1.25, residuals)
    prior = np.array([mean_rating + item_bias.get(movie_id, 0) * .45 for movie_id in targets])
    with np.errstate(over="ignore", invalid="ignore", divide="ignore"):
        predicted = np.clip(prior + (x_test @ x_train.T) @ alpha, .5, 5)
    if not np.isfinite(predicted).all():
        raise ValueError("current kernel produced non-finite predictions")
    return predicted, sum(movie_id in movie_index for movie_id in targets) / max(1, len(targets))


def pairwise_accuracy(predicted, actual):
    correct = total = 0.0
    for left in range(len(actual)):
        for right in range(left + 1, len(actual)):
            if abs(actual[left] - actual[right]) < .5:
                continue
            total += 1
            difference = predicted[left] - predicted[right]
            correct += .5 if abs(difference) < 1e-9 else float(np.sign(difference) == np.sign(actual[left] - actual[right]))
    return correct / total if total else .5


def rank_correlation(predicted, actual):
    if len(predicted) < 2 or len(set(actual)) < 2:
        return 0.0
    return float(np.corrcoef(np.argsort(np.argsort(predicted)), np.argsort(np.argsort(actual)))[0, 1])


def ndcg_at_10(predicted, actual):
    order = np.argsort(predicted)[::-1][:10]
    ideal = np.argsort(actual)[::-1][:10]
    gain = lambda indices: sum((2 ** actual[index] - 1) / math.log2(rank + 2) for rank, index in enumerate(indices))
    denominator = gain(ideal)
    return gain(order) / denominator if denominator else 0.0


def evaluate_profile(rows, size, movie_index, factors, item_bias, genres):
    selected = sorted(rows, key=lambda row: (row[2], row[0]))[-size:]
    split = max(4, math.ceil(len(selected) * .2))
    train, test = selected[:-split], selected[-split:]
    actual = np.array([rating for _, rating, _ in test])
    output = []
    for kind in MODELS:
        tracemalloc.start()
        started = time.perf_counter()
        if kind == "current-kernel":
            predicted, coverage = kernel_predictions(train, test, movie_index, factors, item_bias)
        else:
            predicted, coverage = ridge_predictions(train, test, kind, movie_index, factors, item_bias, genres)
        elapsed = time.perf_counter() - started
        _, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        if predicted is None:
            output.append((kind, "skipped", "skipped", "skipped", "skipped", coverage, elapsed, peak / 1_000_000))
            continue
        output.append((kind, float(np.mean(np.abs(predicted - actual))), pairwise_accuracy(predicted, actual), rank_correlation(predicted, actual), ndcg_at_10(predicted, actual), coverage, elapsed, peak / 1_000_000))
    return output


def benchmark(dataset: Path, max_users: int, item_limit: int):
    ratings, genres = read_dataset(dataset)
    all_users = sorted({user_id for user_id, _, _, _ in ratings})
    representation_users = {user_id for user_id in all_users if user_id % 5 != 0}
    test_users = {user_id for user_id in all_users if user_id % 5 == 0}
    representation_rows = [row for row in ratings if row[0] in representation_users]
    movie_index, factors, item_bias, _ = build_representation(representation_rows, item_limit=item_limit)
    by_user = defaultdict(list)
    for user_id, movie_id, rating, timestamp in ratings:
        if user_id in test_users:
            by_user[user_id].append((movie_id, rating, timestamp))

    print("profile_size,users,model,mae,pairwise,spearman,ndcg10,coverage,seconds,peak_mb")
    for size in PROFILE_SIZES:
        eligible = [(user_id, rows) for user_id, rows in sorted(by_user.items()) if len(rows) >= size][:max_users]
        for _, rows in eligible:
            for result in evaluate_profile(rows, size, movie_index, factors, item_bias, genres):
                kind, mae, pairwise, spearman, ndcg, coverage, seconds, peak_mb = result
                values = [mae, pairwise, spearman, ndcg]
                formatted = [value if isinstance(value, str) else f"{value:.4f}" for value in values]
                print(f"{size},{len(eligible)},{kind},{','.join(formatted)},{coverage:.4f},{seconds:.4f},{peak_mb:.2f}")
        if not eligible:
            print(f"{size},0,no-eligible-users,,,,,,,")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path, help="Path to a MovieLens ZIP; use only under its dataset terms")
    parser.add_argument("--max-users", type=int, default=8)
    parser.add_argument("--item-limit", type=int, default=30_000)
    arguments = parser.parse_args()
    benchmark(arguments.dataset, arguments.max_users, arguments.item_limit)
