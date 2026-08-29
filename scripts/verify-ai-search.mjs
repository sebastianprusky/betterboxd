import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { selectTmdbMatch } from "../api/ai-movie-search.ts";

const claim = { title: "Black Widow", year: 2021, inclusionReason: "Marvel film released in the 2020s", matchedConstraints: ["Marvel", "2020s"], confidence: .99 };
const results = [
  { id: 1, title: "Black Widow", original_title: "Black Widow", release_date: "2021-07-07", poster_path: "/poster.jpg" },
  { id: 2, title: "Black Widow", original_title: "Black Widow", release_date: "1954-10-28", poster_path: "/old.jpg" },
];
assert.equal(selectTmdbMatch(claim, results)?.id, 1, "title and release year must resolve together");
assert.equal(selectTmdbMatch({ ...claim, year: 2020 }, results), null, "a mismatched year must not silently resolve");
assert.equal(selectTmdbMatch({ ...claim, title: "Invented Marvel Film" }, results), null, "an invented title must never be displayed");
const client = readFileSync(new URL("../src/services/aiMovieSearch.ts", import.meta.url), "utf8");
const requestBody = client.slice(client.indexOf("body: JSON.stringify"), client.indexOf("if (!response.ok)"));
assert(!/ratings|watchlist|interest|preferences|reviews/i.test(requestBody), "private taste history must not be sent to AI search");
const recommendations = readFileSync(new URL("../src/services/recommendations.ts", import.meta.url), "utf8");
assert.match(recommendations, /promptEvidence\?\.(reason|evidence)|promptEvidence\?\.reason/, "recommendations must use verified prompt evidence");
assert.match(recommendations, /personalEvidence/, "recommendations must append concrete local taste evidence");
const endpoint = readFileSync(new URL("../api/ai-movie-search.ts", import.meta.url), "utf8");
assert.match(endpoint, /const searchModel = "gpt-5\.6-luna"/, "normal search must use Luna");
assert.match(endpoint, /reasoning: \{ effort: "none" \}/, "Luna search must disable reasoning tokens");
assert.match(endpoint, /const maxModelOutputTokens = 2_200/, "model output must have a strict cost ceiling");
assert.match(endpoint, /store: false/, "responses must not be stored by OpenAI");
assert(!/gpt-5\.6-sol|type: "web_search"|verificationSchema|movie_search_verification/.test(endpoint), "Sol, web search, and second-pass verification must not remain in normal search");
assert.equal((endpoint.match(/= await callOpenAI\(\{/g) || []).length, 1, "the endpoint must contain one model call");

console.log("Low-cost AI search verification passed");
