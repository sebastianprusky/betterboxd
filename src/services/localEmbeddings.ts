export type LocalEmbedding = number[];

const dimensions = 64;

export function embedText(text: string): LocalEmbedding {
  const vector = emptyVector();
  tokenize(text).forEach((token) => {
    const index = hash(token) % dimensions;
    vector[index] += token.length > 4 ? 1.2 : 0.7;
  });
  return normalizeVector(vector);
}

export function cosineSimilarity(a: LocalEmbedding, b: LocalEmbedding) {
  const denominator = magnitude(a) * magnitude(b);
  if (!denominator) return 0;
  return a.reduce((total, value, index) => total + value * b[index], 0) / denominator;
}

export function addWeightedEmbedding(target: LocalEmbedding, source: LocalEmbedding, weight: number) {
  source.forEach((value, index) => {
    target[index] += value * weight;
  });
}

export function emptyEmbedding() {
  return emptyVector();
}

export function embeddingMagnitude(vector: LocalEmbedding) {
  return magnitude(vector);
}

function tokenize(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

function hash(value: string) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return Math.abs(result);
}

function emptyVector() {
  return Array.from({ length: dimensions }, () => 0);
}

function normalizeVector(vector: LocalEmbedding) {
  const length = magnitude(vector);
  return length ? vector.map((value) => value / length) : vector;
}

function magnitude(vector: LocalEmbedding) {
  return Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
}
