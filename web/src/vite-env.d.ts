/// <reference types="vite/client" />

/**
 * Mermaid's single-file IIFE bundle. Imported for its side effect only —
 * it assigns `globalThis.mermaid`. Used instead of the ESM entry so the
 * build produces one mermaid chunk rather than dozens of per-diagram files
 * (the preview uploader is unreliable with many small files).
 */
declare module "mermaid/dist/mermaid.min.js";

interface ImportMetaEnv {
  readonly EXPO_PUBLIC_TOOLKIT_URL?: string;
  readonly EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY?: string;
  readonly EXPO_PUBLIC_PROJECT_ID?: string;
  readonly EXPO_PUBLIC_RORK_FUNCTIONS_URL?: string;
  readonly EXPO_PUBLIC_RORK_APP_KEY?: string;
  readonly EXPO_PUBLIC_RORK_AUTH_URL?: string;
  readonly EXPO_PUBLIC_GITHUB_OAUTH_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
