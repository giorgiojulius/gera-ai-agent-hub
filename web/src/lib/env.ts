export function getToolkitUrl(): string {
  const url = import.meta.env.EXPO_PUBLIC_TOOLKIT_URL;
  if (typeof url !== "string" || url.length === 0) {
    return "https://toolkit.rork.com";
  }
  return url.replace(/\/$/, "");
}

export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
