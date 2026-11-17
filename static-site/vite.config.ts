// Standalone static build of the home page (used for the Vercel deployment):
// `npm run build:static` writes static-site/dist with the ffmpeg core in /ffmpeg/.
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: __dirname,
  base: "/",
  publicDir: "../public",
  plugins: [tailwindcss()],
  esbuild: { jsx: "automatic" },
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"] },
  build: { outDir: "dist", emptyOutDir: true },
});
