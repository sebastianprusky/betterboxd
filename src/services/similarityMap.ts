import type { Movie } from "../types";
import { cosineSimilarity, embedText } from "./localEmbeddings";
import { buildMovieProfile } from "./movieProfiles";

export type SimilarityMapPoint = {
  movie: Movie;
  x: number;
  y: number;
};

export function buildSimilarityMap(movies: Movie[], limit = 24): SimilarityMapPoint[] {
  const sample = movies.slice(0, limit);
  if (!sample.length) return [];
  const vectors = sample.map((movie) => embedText(buildMovieProfile(movie)));
  const firstAnchor = 0;
  const secondAnchor = farthestFrom(vectors, firstAnchor);
  const thirdAnchor = farthestFromPair(vectors, firstAnchor, secondAnchor);
  const raw = sample.map((movie, index) => ({
    movie,
    x: 1 - cosineSimilarity(vectors[index], vectors[secondAnchor]),
    y: 1 - cosineSimilarity(vectors[index], vectors[thirdAnchor]),
  }));
  const xValues = raw.map((point) => point.x);
  const yValues = raw.map((point) => point.y);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);
  return raw.map((point) => ({
    ...point,
    x: 7 + normalize(point.x, minX, maxX) * 86,
    y: 8 + normalize(point.y, minY, maxY) * 84,
  }));
}

function farthestFrom(vectors: number[][], anchor: number) {
  let selected = anchor;
  let distance = Number.NEGATIVE_INFINITY;
  vectors.forEach((vector, index) => {
    const next = 1 - cosineSimilarity(vector, vectors[anchor]);
    if (next > distance) { selected = index; distance = next; }
  });
  return selected;
}

function farthestFromPair(vectors: number[][], first: number, second: number) {
  let selected = first;
  let distance = Number.NEGATIVE_INFINITY;
  vectors.forEach((vector, index) => {
    const next = (1 - cosineSimilarity(vector, vectors[first])) + (1 - cosineSimilarity(vector, vectors[second]));
    if (next > distance) { selected = index; distance = next; }
  });
  return selected;
}

function normalize(value: number, minimum: number, maximum: number) {
  if (maximum - minimum < 0.0001) return 0.5;
  return (value - minimum) / (maximum - minimum);
}
