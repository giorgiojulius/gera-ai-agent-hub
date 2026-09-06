/** Logical provider URL behind a browser proxy request, or the real Worker request URL. */
export function githubTestTarget(input: RequestInfo | URL): URL {
  const url = new URL(String(input));
  return url.pathname === "/github-proxy" ? new URL(url.searchParams.get("path") ?? "/", "https://api.github.com") : url;
}
