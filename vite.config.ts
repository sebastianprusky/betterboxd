import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import semanticSearchHandler from "./api/semantic-search";

declare const process: { env: Record<string, string | undefined> };

type SemanticSearchRequest = Parameters<typeof semanticSearchHandler>[0];
type SemanticSearchResponse = Parameters<typeof semanticSearchHandler>[1];

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
      server.middlewares.use("/api/semantic-search", (request, response) => {
        semanticSearchHandler(request as SemanticSearchRequest, response as SemanticSearchResponse);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), semanticSearchApi()],
});
