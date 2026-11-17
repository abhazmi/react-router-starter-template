import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
export default defineConfig({
  root: __dirname, base: "/", publicDir: "../public", plugins: [tailwindcss()], esbuild: { jsx: "automatic" },
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"] },
  build: { outDir: "dist", emptyOutDir: true },
});
