import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  root: here(".."), logLevel: "error",
  build: { lib: { entry: here("smoke-entry.ts"), formats: ["es"], fileName: () => "smoke.js" },
    outDir: here("../node_modules/.smoke"), emptyOutDir: true, minify: false },
});
