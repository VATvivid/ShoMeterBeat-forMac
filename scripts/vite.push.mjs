import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  root: here(".."), logLevel: "error",
  build: { lib: { entry: here("push-entry.ts"), formats: ["es"], fileName: () => "push.js" }, outDir: here("../node_modules/.smoke"), emptyOutDir: false, minify: false },
});
