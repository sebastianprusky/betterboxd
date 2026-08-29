import { build } from "esbuild";
import { unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const entry = process.argv[2];
if (!entry) throw new Error("Provide a test entry file.");
const output = `/tmp/pickamovie-test-${process.pid}-${Date.now()}.mjs`;
try {
  await build({ entryPoints: [entry], outfile: output, bundle: true, platform: "node", format: "esm", target: "node22" });
  await import(`${pathToFileURL(output).href}?run=${Date.now()}`);
} finally {
  await unlink(output).catch(() => undefined);
}
