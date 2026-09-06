import { fetchGitHubViewer } from "./native-github";
import { isRecord, redactMcpText } from "./mcp-protocol-shared";

/** Validates a new project PAT without touching the personal GitHub connector or any vault row. */
export async function validateProjectGitHubToken(value: unknown): ReturnType<typeof fetchGitHubViewer> {
  const raw = typeof value === "string" ? value.trim() : "";
  const token = raw.replace(/^Bearer\s+/i, "");
  if (!token || token.length > 16_000 || /[\r\n]/.test(token) || token.startsWith("gera-account:")) throw new Error("Paste a valid project PAT.");
  try { return await fetchGitHubViewer(`Bearer ${token}`); }
  catch (error) { throw new Error(redactMcpText(error instanceof Error ? error.message : "GitHub verification failed", [raw, token])); }
}
/** Project member/admin checks occur before this helper is allowed to contact GitHub. */
export async function handleProjectGitHubValidate(body: unknown, canManage: boolean): Promise<Response> {
  if (!canManage) return Response.json({ error: "admin_required" }, { status: 403 });
  if (!isRecord(body)) return Response.json({ error: "invalid_body" }, { status: 400 });
  try { return Response.json({ viewer: await validateProjectGitHubToken(body.token) }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "GitHub verification failed" }, { status: 400 }); }
}
