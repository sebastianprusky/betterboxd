import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import semanticSearchHandler from "./api/semantic-search";

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
      if (env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY) {
        process.env.OPENAI_API_KEY = env.OPENAI_API_KEY;
      }
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
        await writeFetchResponse(await semanticSearchHandler.fetch(fetchRequest), response as NodeResponse);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), semanticSearchApi()],
});
