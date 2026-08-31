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
        // while disabling splitting creates a 7 MB entry that can race the
        // preview reload. Keep a small entry and collapse each heavy, deferred
        // feature (including its internal imports) into one durable chunk.
        codeSplitting: {
          groups: [
            {
              name: "mermaid",
              test: /node_modules[\\/]mermaid[\\/]/,
              priority: 40,
            },
            {
              name: "syntax-highlighter",
              test: /node_modules[\\/](?:react-syntax-highlighter|refractor|prismjs)[\\/]/,
              priority: 30,
            },
            {
              name: "document-readers",
              test: /node_modules[\\/](?:pdfjs-dist|mammoth|xlsx)[\\/]/,
              priority: 20,
            },
            {
              name: "maps",
              test: /node_modules[\\/]leaflet[\\/]/,
              priority: 10,
            },
          ],
        },
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
