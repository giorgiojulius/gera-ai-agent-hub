/**
 * Base URL of the Gera backend Worker. Lives in its own dependency-free module
 * so both the backend client and the auth-token layer can read it without a
 * circular import.
 */
export const FUNCTIONS_URL: string = (() => {
  const url = import.meta.env.EXPO_PUBLIC_RORK_FUNCTIONS_URL;
  if (typeof url === "string" && url.length > 0) {
    return url.replace(/\/+$/, "");
  }
  return "https://gera-ai-agent-hub-backend.rork.app";
})();
