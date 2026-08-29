import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { handleCreatorAccountOverviewRequest } from "./api/creator-account-overview";
import { handleSemanticSearchRequest } from "./api/semantic-search";
import { handleReviewInsightsRequest } from "./api/review-insights";
import { handleSearchPlanRequest } from "./api/search-plan";
import { handleAiMovieSearchRequest } from "./api/ai-movie-search";

declare const process: { env: Record<string, string | undefined> };

type NodeRequest = {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  on: (event: "data" | "end" | "error", callback: (chunk?: { toString: (encoding?: string) => string }) => void) => void;
};

type NodeResponse = {
  statusCode: number;
  setHeader: (name: string, value: string) => void;
  end: (body?: string) => void;
};

async function readRequestBody(request: NodeRequest) {
  const chunks: string[] = [];
  await new Promise<void>((resolve, reject) => {
    request.on("data", (chunk) => {
      if (chunk) chunks.push(chunk.toString("utf8"));
    });
    request.on("end", () => resolve());
    request.on("error", () => reject(new Error("Failed to read request body")));
  });
  return chunks.join("");
}

async function writeFetchResponse(fetchResponse: Response, response: NodeResponse) {
  response.statusCode = fetchResponse.status;
  fetchResponse.headers.forEach((value, name) => response.setHeader(name, value));
  response.end(await fetchResponse.text());
}

function semanticSearchApi(): Plugin {
  return {
    name: "pickamovie-semantic-search-api",
    config(_, { mode }) {
      const env = loadEnv(mode, ".", "");
      [
        "OPENAI_API_KEY",
        "TMDB_API_KEY",
        "VITE_TMDB_API_KEY",
        "SUPABASE_URL",
        "SUPABASE_ANON_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
        "PICKAMOVIE_CREATOR_USER_ID",
        "BETTERBOXD_CREATOR_USER_ID",
        "VITE_SUPABASE_URL",
        "VITE_SUPABASE_ANON_KEY",
        "VITE_AUTH_REDIRECT_URL",
      ].forEach((key) => {
        if (env[key] && !process.env[key]) process.env[key] = env[key];
      });
    },
    configureServer(server) {
      server.middlewares.use("/api/semantic-search", async (request, response) => {
        const nodeRequest = request as NodeRequest;
        const body = nodeRequest.method === "POST" ? await readRequestBody(nodeRequest) : undefined;
        const fetchRequest = new Request(`http://localhost${nodeRequest.url || "/api/semantic-search"}`, {
          method: nodeRequest.method,
          headers: nodeRequest.headers as HeadersInit,
          body,
        });
        await writeFetchResponse(await handleSemanticSearchRequest(fetchRequest), response as NodeResponse);
      });
      server.middlewares.use("/api/search-plan", async (request, response) => {
        const nodeRequest = request as NodeRequest;
        const body = nodeRequest.method === "POST" ? await readRequestBody(nodeRequest) : undefined;
        const fetchRequest = new Request(`http://localhost${nodeRequest.url || "/api/search-plan"}`, {
          method: nodeRequest.method,
          headers: nodeRequest.headers as HeadersInit,
          body,
        });
        await writeFetchResponse(await handleSearchPlanRequest(fetchRequest), response as NodeResponse);
      });
      server.middlewares.use("/api/ai-movie-search", async (request, response) => {
        const nodeRequest = request as NodeRequest;
        const body = nodeRequest.method === "POST" ? await readRequestBody(nodeRequest) : undefined;
        const fetchRequest = new Request(`http://localhost${nodeRequest.url || "/api/ai-movie-search"}`, {
          method: nodeRequest.method,
          headers: nodeRequest.headers as HeadersInit,
          body,
        });
        await writeFetchResponse(await handleAiMovieSearchRequest(fetchRequest), response as NodeResponse);
      });
      server.middlewares.use("/api/creator-account-overview", async (request, response) => {
        const nodeRequest = request as NodeRequest;
        const fetchRequest = new Request(`http://localhost${nodeRequest.url || "/api/creator-account-overview"}`, {
          method: nodeRequest.method,
          headers: nodeRequest.headers as HeadersInit,
        });
        await writeFetchResponse(await handleCreatorAccountOverviewRequest(fetchRequest), response as NodeResponse);
      });
      server.middlewares.use("/api/review-insights", async (request, response) => {
        const nodeRequest = request as NodeRequest;
        const body = nodeRequest.method === "POST" ? await readRequestBody(nodeRequest) : undefined;
        const fetchRequest = new Request(`http://localhost${nodeRequest.url || "/api/review-insights"}`, {
          method: nodeRequest.method,
          headers: nodeRequest.headers as HeadersInit,
          body,
        });
        await writeFetchResponse(await handleReviewInsightsRequest(fetchRequest), response as NodeResponse);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), semanticSearchApi()],
});
