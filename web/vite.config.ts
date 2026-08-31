import path from "path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        // The preview uploader sends every output file separately. Rolldown's
        // default splitting turns Mermaid and Prism into 100+ tiny chunks,
        // making an otherwise valid deployment vulnerable to partial uploads.
        // Keep dynamic-import semantics while shipping one deterministic JS
        // artifact; workers and public assets remain separate files.
        codeSplitting: false,
        strictExecutionOrder: true,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  // Expose both VITE_* (Vite default) and EXPO_PUBLIC_* (Rork's cross-platform
  // public-env convention, written by tools like getOrCreateAuthConfig).
  envPrefix: ["VITE_", "EXPO_PUBLIC_"],
}));
