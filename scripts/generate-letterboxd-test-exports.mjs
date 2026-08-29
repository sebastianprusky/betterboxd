import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";

const DATASET_URL = "https://files.grouplens.org/datasets/movielens/ml-latest-small.zip";
const outputDirectory = resolve("test-data/letterboxd");
const suppliedDataset = process.argv[2] ? resolve(process.argv[2]) : null;

const profiles = [
  {
    slug: "wide-ranging-cinephile",
    name: "Wide-Ranging Cinephile",
    summary: "Broad, adventurous taste with strong opinions across genres and decades.",
    weights: { Drama: .35, Documentary: .55, "Film-Noir": .55, Mystery: .3, Animation: .25, Horror: -.05, Comedy: .05, Romance: .1 },
    center: 3.45,
    noise: .78,
  },
  {
    slug: "midnight-genre-fan",
    name: "Midnight Genre Fan",
    summary: "Strong preference for horror, science fiction, thrillers, fantasy, and animation.",
    weights: { Horror: 1.05, "Sci-Fi": .9, Thriller: .65, Mystery: .5, Fantasy: .45, Animation: .4, Romance: -.8, Musical: -.7, Drama: -.15, Comedy: -.15 },
    center: 3.15,
    noise: .48,
  },
  {
    slug: "comfort-blockbuster-fan",
    name: "Comfort & Blockbuster Fan",
    summary: "Warm, accessible taste favoring comedy, adventure, family films, and crowd-pleasers.",
    weights: { Comedy: .8, Adventure: .7, Animation: .75, Children: .8, Fantasy: .45, Romance: .3, Action: .3, Horror: -.9, "Film-Noir": -.55, War: -.45, Crime: -.25 },
    center: 3.35,
    noise: .4,
  },
];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell); cell = "";
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else cell += character;
  }
  row.push(cell);
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function records(text) {
  const [headers, ...rows] = parseCsv(text);
  return rows.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] || ""])));
}

function csv(headers, rows) {
  const escape = (value) => {
    const string = String(value ?? "");
    return /[",\n\r]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
  };
  return `${headers.join(",")}\n${rows.map((row) => headers.map((header) => escape(row[header])).join(",")).join("\n")}\n`;
}

function hashNumber(value) {
  return Number.parseInt(createHash("sha256").update(value).digest("hex").slice(0, 8), 16) / 0xffffffff;
}

function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
function halfStar(value) { return Math.round(clamp(value, .5, 5) * 2) / 2; }
function isoDate(index, start = Date.UTC(2021, 0, 3)) { return new Date(start + index * 8.64e7 * 9).toISOString().slice(0, 10); }
function slug(value) { return value.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function letterboxdUri(movie) { return `https://letterboxd.com/film/${slug(movie.title)}/`; }

function personalRating(movie, profile) {
  const genreBias = movie.genres.reduce((total, genre) => total + (profile.weights[genre] || 0), 0);
  const communitySignal = clamp((movie.communityMean - 3.4) * .38, -.45, .45);
  const noise = (hashNumber(`${profile.slug}:${movie.movieId}:rating`) - .5) * 2 * profile.noise;
  return halfStar(profile.center + genreBias + communitySignal + noise);
}

const praise = [
  "The atmosphere, pacing, and character choices all worked for me.",
  "Confident filmmaking with images and moments that stayed with me.",
  "Distinctive, emotionally precise, and easy to recommend.",
  "The craft supports the story instead of getting in its way.",
];
const mixed = [
  "There is plenty to admire, even if the pacing did not always land for me.",
  "Strong individual moments, but the whole felt less consistent than its best scenes.",
  "I liked the premise and performances more than the execution.",
  "Worth seeing once, though I was not fully pulled into its rhythm.",
];
const criticism = [
  "The premise had potential, but the pacing and character work kept me at a distance.",
  "Technically polished, yet the story never became involving for me.",
  "The tone and structure worked against what I wanted from this genre.",
  "A few effective scenes could not overcome an experience that felt too flat.",
];

function reviewFor(movie, rating, profile) {
  const options = rating >= 4 ? praise : rating >= 3 ? mixed : criticism;
  const base = options[Math.floor(hashNumber(`${profile.slug}:${movie.movieId}:review`) * options.length)];
  const genres = movie.genres.slice(0, 2).map((genre) => genre.toLowerCase()).join(" and ");
  const verdict = rating >= 4.5
    ? `This is exactly the kind of ${genres || "movie"} storytelling I respond to.`
    : rating <= 2
      ? `Its ${genres || "overall"} approach is not a strong match for my taste.`
      : `I can see the appeal of its ${genres || "creative"} approach, even with reservations.`;
  return `${base} ${verdict}`;
}

function buildProfile(moviePool, profile) {
  const ordered = [...moviePool].sort((left, right) => {
    const leftScore = Math.log1p(left.support) * 4 + hashNumber(`${profile.slug}:${left.movieId}:select`) * 5;
    const rightScore = Math.log1p(right.support) * 4 + hashNumber(`${profile.slug}:${right.movieId}:select`) * 5;
    return rightScore - leftScore || Number(left.movieId) - Number(right.movieId);
  });
  const rated = ordered.slice(0, 160).map((movie) => ({ ...movie, rating: personalRating(movie, profile) }));
  const preferenceOrder = [...rated].sort((left, right) => left.rating - right.rating || Number(left.movieId) - Number(right.movieId));
  preferenceOrder.slice(0, 3).forEach((movie) => { movie.rating = .5; });
  preferenceOrder.slice(3, 7).forEach((movie) => { movie.rating = 1.5; });
  preferenceOrder.slice(-8).forEach((movie) => { movie.rating = 5; });
  const watchedOnly = ordered.slice(160, 195);
  const watchlist = ordered.slice(195, 240);
  const reviewed = [...rated]
    .sort((left, right) => Math.abs(right.rating - 3) - Math.abs(left.rating - 3) || Number(left.movieId) - Number(right.movieId))
    .slice(0, 80);
  const diary = [...rated].sort((left, right) => Number(left.movieId) - Number(right.movieId)).slice(0, 120);
  const watched = [...rated, ...watchedOnly];
  const liked = rated.filter((movie) => movie.rating >= 4.5).slice(0, 35);

  const common = (movie, index) => ({
    Date: isoDate(index),
    Name: movie.title,
    Year: movie.year,
    "Letterboxd URI": letterboxdUri(movie),
  });
  const archive = {
    [`letterboxd-${profile.slug}/ratings.csv`]: strToU8(csv(
      ["Date", "Name", "Year", "Letterboxd URI", "Rating"],
      rated.map((movie, index) => ({ ...common(movie, index), Rating: movie.rating })),
    )),
    [`letterboxd-${profile.slug}/watched.csv`]: strToU8(csv(
      ["Date", "Name", "Year", "Letterboxd URI"],
      watched.map((movie, index) => common(movie, index)),
    )),
    [`letterboxd-${profile.slug}/diary.csv`]: strToU8(csv(
      ["Date", "Name", "Year", "Letterboxd URI", "Rating", "Rewatch", "Tags", "Watched Date"],
      diary.map((movie, index) => ({
        ...common(movie, index),
        Rating: movie.rating,
        Rewatch: index % 17 === 0 ? "Yes" : "",
        Tags: movie.genres.slice(0, 3).map((genre) => genre.toLowerCase()).join(", "),
        "Watched Date": isoDate(index),
      })),
    )),
    [`letterboxd-${profile.slug}/reviews.csv`]: strToU8(csv(
      ["Date", "Name", "Year", "Letterboxd URI", "Rating", "Rewatch", "Review"],
      reviewed.map((movie, index) => ({
        ...common(movie, index), Rating: movie.rating, Rewatch: index % 19 === 0 ? "Yes" : "", Review: reviewFor(movie, movie.rating, profile),
      })),
    )),
    [`letterboxd-${profile.slug}/watchlist.csv`]: strToU8(csv(
      ["Date", "Name", "Year", "Letterboxd URI"],
      watchlist.map((movie, index) => common(movie, index + 300)),
    )),
    [`letterboxd-${profile.slug}/likes/films.csv`]: strToU8(csv(
      ["Date", "Name", "Year", "Letterboxd URI"],
      liked.map((movie, index) => common(movie, index)),
    )),
    [`letterboxd-${profile.slug}/profile.csv`]: strToU8(csv(
      ["Date", "Username", "Given Name", "Family Name", "Email", "Location", "Website", "Bio", "Pronoun"],
      [{ Date: "2026-08-29", Username: profile.slug, "Given Name": "Synthetic", "Family Name": "Tester", Email: "", Location: "", Website: "", Bio: profile.summary, Pronoun: "" }],
    )),
    [`letterboxd-${profile.slug}/README.txt`]: strToU8([
      "SYNTHETIC TEST DATA — contains no real Letterboxd account information.",
      profile.name,
      profile.summary,
      `${rated.length} ratings; ${watched.length} watched; ${diary.length} diary entries; ${reviewed.length} reviews; ${watchlist.length} watchlist titles; ${liked.length} liked films.`,
      "Ratings and review text are deterministic test fixtures derived from public MovieLens movie metadata.",
    ].join("\n")),
  };
  return { archive, counts: { ratings: rated.length, watched: watched.length, diary: diary.length, reviews: reviewed.length, watchlist: watchlist.length, likes: liked.length } };
}

async function loadDataset() {
  if (suppliedDataset) return new Uint8Array(await readFile(suppliedDataset));
  const response = await fetch(DATASET_URL);
  if (!response.ok) throw new Error(`MovieLens download failed: ${response.status} ${response.statusText}`);
  return new Uint8Array(await response.arrayBuffer());
}

const bytes = await loadDataset();
const archive = unzipSync(bytes);
const find = (suffix) => Object.entries(archive).find(([name]) => name.endsWith(suffix))?.[1];
const movieBytes = find("/movies.csv");
const ratingBytes = find("/ratings.csv");
const linkBytes = find("/links.csv");
if (!movieBytes || !ratingBytes || !linkBytes) throw new Error(`Unexpected MovieLens archive: ${basename(suppliedDataset || DATASET_URL)}`);

const decoder = new TextDecoder();
const links = new Map(records(decoder.decode(linkBytes)).filter((row) => row.tmdbId).map((row) => [row.movieId, row.tmdbId]));
const ratingStats = new Map();
for (const row of records(decoder.decode(ratingBytes))) {
  const current = ratingStats.get(row.movieId) || { sum: 0, support: 0 };
  current.sum += Number(row.rating);
  current.support += 1;
  ratingStats.set(row.movieId, current);
}

const movies = records(decoder.decode(movieBytes)).flatMap((row) => {
  const match = row.title.match(/^(.*) \((\d{4})\)$/);
  const stats = ratingStats.get(row.movieId);
  if (!match || !stats || !links.has(row.movieId) || row.genres.includes("(no genres listed)")) return [];
  const rawTitle = match[1].trim();
  const article = rawTitle.match(/^(.*),\s*(The|An|A)$/);
  const title = article ? `${article[2]} ${article[1]}` : rawTitle;
  if (!title || title.includes("(a.k.a.") || title.includes("(aka ")) return [];
  return [{ movieId: row.movieId, tmdbId: links.get(row.movieId), title, year: match[2], genres: row.genres.split("|").filter((genre) => genre !== "IMAX"), support: stats.support, communityMean: stats.sum / stats.support }];
}).sort((left, right) => right.support - left.support || Number(left.movieId) - Number(right.movieId)).slice(0, 900);

await mkdir(outputDirectory, { recursive: true });
const manifest = [];
for (const profile of profiles) {
  const { archive: profileArchive, counts } = buildProfile(movies, profile);
  const output = resolve(outputDirectory, `${profile.slug}.zip`);
  await writeFile(output, zipSync(profileArchive, { level: 6 }));
  manifest.push({ file: basename(output), profile: profile.name, summary: profile.summary, ...counts });
  console.log(`Wrote ${output}`);
}
await writeFile(resolve(outputDirectory, "manifest.json"), `${JSON.stringify({ generatedAt: "2026-08-29", source: DATASET_URL, profiles: manifest }, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
