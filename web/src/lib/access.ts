// Invite-only access API — talks to the Gera backend /access routes, which
// verify the Rork Auth JWT platform-side and consult the AccessRegistry DO.
import { getAccessToken, refreshAccessToken } from "@/lib/auth-tokens";

const FUNCTIONS_URL: string = (() => {
  const url = import.meta.env.EXPO_PUBLIC_RORK_FUNCTIONS_URL;
  if (typeof url === "string" && url.length > 0) {
    return url.replace(/\/+$/, "");
  }
  return "https://gera-ai-agent-hub-backend.rork.app";
})();

export type AccessRole = "admin" | "member" | null;

export type AccessStatus = {
  email: string;
  status: "invited" | "pending" | "none";
  role: AccessRole;
  requestedAt: number | null;
};

export type InviteEntry = {
  email: string;
  role: "admin" | "member";
  invitedBy: string | null;
  createdAt: number;
};

export type RequestEntry = {
  email: string;
  name: string | null;
  note: string | null;
  status: "pending" | "approved" | "dismissed";
  createdAt: number;
};

export type AccessOverview = {
  invites: InviteEntry[];
  requests: RequestEntry[];
};

/** Fetch with the stored Bearer token; retries once after a token refresh on 401. */
async function accessFetch(path: string, init?: RequestInit): Promise<Response> {
  const attempt = (token: string | null) =>
    fetch(`${FUNCTIONS_URL}/access${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  let response = await attempt(getAccessToken());
  if (response.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      response = await attempt(refreshed);
    }
  }
  return response;
}

async function parseOrThrow<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${fallback} (${response.status})`);
  }
  return (await response.json()) as T;
}

export async function fetchAccessStatus(): Promise<AccessStatus> {
  const response = await accessFetch("/status");
  return parseOrThrow<AccessStatus>(response, "Access check failed");
}

export async function submitAccessRequest(note: string): Promise<void> {
  const response = await accessFetch("/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note }),
  });
  await parseOrThrow<{ ok: boolean }>(response, "Could not send the request");
}

export async function fetchAccessOverview(): Promise<AccessOverview> {
  const response = await accessFetch("/admin/overview");
  return parseOrThrow<AccessOverview>(response, "Could not load invites");
}

export async function inviteEmail(email: string): Promise<void> {
  const response = await accessFetch("/admin/invite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  await parseOrThrow<{ ok: boolean }>(response, "Could not send the invite");
}

export async function revokeInvite(email: string): Promise<void> {
  const response = await accessFetch("/admin/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  await parseOrThrow<{ ok: boolean }>(response, "Could not revoke the invite");
}

/** Promote or demote a member. The backend refuses self-changes so one admin always remains. */
export async function setAccessRole(email: string, role: "admin" | "member"): Promise<void> {
  const response = await accessFetch("/admin/role", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
  await parseOrThrow<{ ok: boolean }>(response, "Could not change the role");
}

/** Dismiss a pending waitlist request; the row stays with status "dismissed". */
export async function dismissRequest(email: string): Promise<void> {
  const response = await accessFetch("/admin/dismiss", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  await parseOrThrow<{ ok: boolean }>(response, "Could not dismiss the request");
}

// ---------------------------------------------------------------------------
// Pure view helpers for the admin panel — no fetches, unit-tested.

export type AccessStats = {
  members: number;
  admins: number;
  waiting: number;
  autoInvited: number;
};

/** Headline numbers for the admin panel, computed from the raw overview. */
export function accessStats(overview: AccessOverview): AccessStats {
  return {
    members: overview.invites.length,
    admins: overview.invites.filter((entry) => entry.role === "admin").length,
    waiting: overview.requests.filter((entry) => entry.status === "pending").length,
    autoInvited: overview.invites.filter((entry) => entry.invitedBy?.startsWith("domain:")).length,
  };
}

/**
 * Case-insensitive search across both lists: invites match on email and
 * inviter, requests on email, name and note. Empty query returns everything.
 */
export function filterAccessOverview(overview: AccessOverview, query: string): AccessOverview {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return overview;
  }
  return {
    invites: overview.invites.filter((entry) =>
      [entry.email, entry.invitedBy ?? ""].some((field) => field.toLowerCase().includes(needle)),
    ),
    requests: overview.requests.filter((entry) =>
      [entry.email, entry.name ?? "", entry.note ?? ""].some((field) => field.toLowerCase().includes(needle)),
    ),
  };
}

/** Panel order for the member list: admins first, then newest invites. */
export function sortInvites(invites: InviteEntry[]): InviteEntry[] {
  return [...invites].sort((a, b) => {
    const aAdmin = a.role === "admin" ? 0 : 1;
    const bAdmin = b.role === "admin" ? 0 : 1;
    if (aAdmin !== bAdmin) {
      return aAdmin - bAdmin;
    }
    return b.createdAt - a.createdAt;
  });
}
