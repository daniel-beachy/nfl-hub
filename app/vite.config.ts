import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Relative base so the build works at any GitHub Pages path; routing is hash based.
export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  test: { root: `${import.meta.dirname}/..`, include: ["{app,pipeline,shared}/**/*.test.{ts,tsx}"] },
});
