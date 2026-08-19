import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { handleCreatorAccountOverviewRequest } from "./api/creator-account-overview";
import { handleSemanticSearchRequest } from "./api/semantic-search";

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
    name: "betterboxd-semantic-search-api",
    config(_, { mode }) {
      const env = loadEnv(mode, ".", "");
      [
        "OPENAI_API_KEY",
        "SUPABASE_URL",
        "SUPABASE_ANON_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
        "BETTERBOXD_CREATOR_USER_ID",
        "VITE_SUPABASE_URL",
        "VITE_SUPABASE_ANON_KEY",
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
      server.middlewares.use("/api/creator-account-overview", async (request, response) => {
        const nodeRequest = request as NodeRequest;
        const fetchRequest = new Request(`http://localhost${nodeRequest.url || "/api/creator-account-overview"}`, {
          method: nodeRequest.method,
          headers: nodeRequest.headers as HeadersInit,
        });
        await writeFetchResponse(await handleCreatorAccountOverviewRequest(fetchRequest), response as NodeResponse);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), semanticSearchApi()],
});
