/// <reference types="vite/client" />

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
