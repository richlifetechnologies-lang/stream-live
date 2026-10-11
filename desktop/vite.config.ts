import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@stream-live/client": path.resolve(__dirname, "../client/stream-live-client.ts"),
      // client/ sits outside this package, so its bare imports would resolve from
      // the repo root where nothing is installed. Pin it to the app's tree.
      "@supabase/supabase-js": path.resolve(__dirname, "./node_modules/@supabase/supabase-js"),
    },
  },
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, "index.html"),
    },
  },
  server: {
    port: 5173,
    fs: {
      allow: [".."],
    },
  },
});
