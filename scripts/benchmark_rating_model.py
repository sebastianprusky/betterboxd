#!/usr/bin/env python3
"""Leakage-safe offline benchmark for PickAMovie's personal factor model.

The collaborative representation is trained on one group of MovieLens users;
personal ridge models are then evaluated on entirely held-out users. Nothing in
this script ships to the browser or becomes a production dependency.
"""

from __future__ import annotations

import argparse
import csv
import io
import zipfile
from collections import defaultdict
from pathlib import Path

import numpy as np


def read_ratings(dataset: Path):
    with zipfile.ZipFile(dataset) as archive:
        name = next(name for name in archive.namelist() if name.endswith("ratings.csv"))
        with archive.open(name) as raw:
            return [
                (int(row["userId"]), int(row["movieId"]), float(row["rating"]))
                for row in csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8"))
            ]


def build_factors(ratings, dimensions=32, limit=5000):
    support = defaultdict(int)
    for _, movie_id, _ in ratings:
        support[movie_id] += 1
    movies = [movie_id for movie_id, _ in sorted(support.items(), key=lambda item: (-item[1], item[0]))[:limit]]
    movie_index = {movie_id: index for index, movie_id in enumerate(movies)}
    users = sorted({user_id for user_id, movie_id, _ in ratings if movie_id in movie_index})
    user_index = {user_id: index for index, user_id in enumerate(users)}
    user_values = defaultdict(list)
    item_values = defaultdict(list)
    for user_id, movie_id, rating in ratings:
        if movie_id in movie_index:
            user_values[user_id].append(rating)
            item_values[movie_id].append(rating)
    user_means = {user_id: float(np.mean(values)) for user_id, values in user_values.items()}
    matrix = np.zeros((len(movies), len(users)), dtype=np.float64)
    for user_id, movie_id, rating in ratings:
        if movie_id in movie_index:
            matrix[movie_index[movie_id], user_index[user_id]] = rating - user_means[user_id]
    rng = np.random.default_rng(20260829)
    with np.errstate(over="ignore", invalid="ignore", divide="ignore"):
        projected = matrix @ rng.normal(size=(matrix.shape[1], dimensions + 8))
        for _ in range(2):
            projected, _ = np.linalg.qr(projected, mode="reduced")
            projected = matrix @ (matrix.T @ projected)
        basis, _ = np.linalg.qr(projected, mode="reduced")
        compressed = basis.T @ matrix
        left, singular, _ = np.linalg.svd(compressed, full_matrices=False)
        factors = (basis @ left[:, :dimensions]) * np.sqrt(singular[:dimensions])
    if not np.isfinite(factors).all():
        raise ValueError("Collaborative factor construction produced non-finite values.")
    norms = np.linalg.norm(factors, axis=1, keepdims=True)
    factors = np.divide(factors, norms, out=np.zeros_like(factors), where=norms > 0)
    global_mean = float(np.mean([rating for _, _, rating in ratings]))
    item_bias = {
        movie_id: (float(np.mean(item_values[movie_id])) - global_mean) * len(item_values[movie_id]) / (len(item_values[movie_id]) + 25)
        for movie_id in movies
    }
    return movie_index, factors, item_bias


def ridge_predict(training, targets, movie_index, factors, item_bias, regularization):
    mean = (sum(rating for _, rating in training) + 14) / (len(training) + 4)
    x_train = np.array([factors[movie_index[movie_id]] for movie_id, _ in training])
    base = np.array([mean + item_bias[movie_id] * .45 for movie_id, _ in training])
    residuals = np.array([rating for _, rating in training]) - base
    with np.errstate(over="ignore", invalid="ignore", divide="ignore"):
        weights = np.linalg.solve(x_train.T @ x_train + np.eye(x_train.shape[1]) * regularization, x_train.T @ residuals)
        predictions = np.array([mean + item_bias[movie_id] * .45 for movie_id, _ in targets]) + np.array([factors[movie_index[movie_id]] for movie_id, _ in targets]) @ weights
    if not np.isfinite(predictions).all():
        raise ValueError("Ridge prediction produced non-finite values.")
    return np.clip(predictions, .5, 5)


def select_lambda(training, movie_index, factors, item_bias):
    candidates = (.35, 1.25, 4.5)
    ordered = sorted(training)
    losses = []
    for regularization in candidates:
        errors = []
        for fold in range(4):
            inner_train = [entry for index, entry in enumerate(ordered) if index % 4 != fold]
            inner_test = [entry for index, entry in enumerate(ordered) if index % 4 == fold]
            if not inner_test:
                continue
            predicted = ridge_predict(inner_train, inner_test, movie_index, factors, item_bias, regularization)
            errors.extend(abs(predicted[index] - rating) for index, (_, rating) in enumerate(inner_test))
        losses.append((float(np.mean(errors)), regularization))
    return min(losses)[1]


def benchmark(dataset: Path, max_users: int):
    ratings = read_ratings(dataset)
    users = sorted({user_id for user_id, _, _ in ratings})
    training_users = {user_id for user_id in users if user_id % 5 != 0}
    test_users = [user_id for user_id in users if user_id % 5 == 0]
    representation_rows = [row for row in ratings if row[0] in training_users]
    movie_index, factors, item_bias = build_factors(representation_rows)
    by_user = defaultdict(list)
    for user_id, movie_id, rating in ratings:
        if user_id in test_users and movie_id in movie_index:
            by_user[user_id].append((movie_id, rating))
    eligible = [(user_id, rows) for user_id, rows in sorted(by_user.items()) if len(rows) >= 20][:max_users]
    baseline_errors = []
    factor_errors = []
    correlations = []
    for _, rows in eligible:
        ordered = sorted(rows)
        actual = []
        predicted = []
        for fold in range(5):
            training = [entry for index, entry in enumerate(ordered) if index % 5 != fold]
            targets = [entry for index, entry in enumerate(ordered) if index % 5 == fold]
            if not targets:
                continue
            mean = (sum(rating for _, rating in training) + 14) / (len(training) + 4)
            regularization = select_lambda(training, movie_index, factors, item_bias)
            fold_predictions = ridge_predict(training, targets, movie_index, factors, item_bias, regularization)
            for index, (_, rating) in enumerate(targets):
                baseline_errors.append(abs(mean - rating))
                factor_errors.append(abs(float(fold_predictions[index]) - rating))
                actual.append(rating)
                predicted.append(float(fold_predictions[index]))
        if len(set(actual)) > 1:
            correlations.append(float(np.corrcoef(predicted, actual)[0, 1]))
    baseline_mae = float(np.mean(baseline_errors))
    factor_mae = float(np.mean(factor_errors))
    improvement = 1 - factor_mae / baseline_mae
    print(f"held-out users: {len(eligible)}")
    print(f"held-out ratings: {len(factor_errors)}")
    print(f"user-mean MAE: {baseline_mae:.3f}")
    print(f"factor-ridge MAE: {factor_mae:.3f}")
    print(f"MAE improvement: {improvement:.1%}")
    print(f"mean per-user correlation: {float(np.nanmean(correlations)):.3f}")
    if improvement < .05:
        raise SystemExit("Factor ridge did not clear the 5% held-out improvement gate.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path, help="Path to a MovieLens ZIP, such as ml-latest-small.zip")
    parser.add_argument("--max-users", type=int, default=120)
    args = parser.parse_args()
    benchmark(args.dataset, args.max_users)
