/// <reference lib="webworker" />

import { loadCollaborativeModel, type CollaborativeModel } from "../services/collaborative";
import { buildRatingCalibration, predictCandidateRatings } from "../services/ratingCalibration";
import type { PersonalModelSnapshot } from "../services/personalRatingModel";
import type { Movie, RatingMap, WatchedMap } from "../types";

type RatingModelRequest = {
  requestId: number;
  movies: Movie[];
  ratings: RatingMap;
  watched: WatchedMap;
  candidates: Movie[];
  model?: CollaborativeModel | null;
  snapshot?: PersonalModelSnapshot;
  calibrate?: boolean;
};

self.onmessage = async (event: MessageEvent<RatingModelRequest>) => {
  const { requestId, movies, ratings, watched, candidates, calibrate = true, snapshot } = event.data;
  self.postMessage({ requestId, progress: "features" });
  const model = event.data.model === undefined ? await loadCollaborativeModel() : event.data.model;
  self.postMessage({ requestId, progress: calibrate ? "validation" : "prediction" });
  const calibration = calibrate ? buildRatingCalibration(movies, ratings, watched, model) : undefined;
  self.postMessage({ requestId, progress: "calibration" });
  const activeSnapshot = snapshot || calibration?.modelSnapshot;
  const predictions = (!calibrate || calibration?.rankingReady) && activeSnapshot
    ? [...predictCandidateRatings(candidates, ratings, watched, model, activeSnapshot).entries()]
    : [];
  self.postMessage({ requestId, calibration, predictions });
};
