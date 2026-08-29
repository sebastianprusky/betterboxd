/// <reference lib="webworker" />

import type { CollaborativeModel } from "../services/collaborative";
import { buildRatingCalibration, predictCandidateRatings } from "../services/ratingCalibration";
import type { Movie, RatingMap, WatchedMap } from "../types";

type RatingModelRequest = {
  requestId: number;
  movies: Movie[];
  ratings: RatingMap;
  watched: WatchedMap;
  candidates: Movie[];
  model: CollaborativeModel | null;
  calibrate?: boolean;
};

self.onmessage = (event: MessageEvent<RatingModelRequest>) => {
  const { requestId, movies, ratings, watched, candidates, model, calibrate = true } = event.data;
  const calibration = calibrate ? buildRatingCalibration(movies, ratings, watched, model) : undefined;
  const predictions = (!calibrate || calibration?.benchmarkPassed)
    ? [...predictCandidateRatings(candidates, ratings, watched, model).entries()]
    : [];
  self.postMessage({ requestId, calibration, predictions });
};
