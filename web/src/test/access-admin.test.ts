// Admin panel view helpers: headline stats, the people search, and the
// member ordering. Pure functions over the /admin/overview payload.
import { describe, expect, it } from "vitest";

import {
  accessStats,
  filterAccessOverview,
  sortInvites,
  type AccessOverview,
  type InviteEntry,
  type RequestEntry,
} from "@/lib/access";

function invite(patch: Partial<InviteEntry>): InviteEntry {
  return { email: "person@example.com", role: "member", invitedBy: null, createdAt: 1, ...patch };
}

function request(patch: Partial<RequestEntry>): RequestEntry {
  return { email: "ask@example.com", name: null, note: null, status: "pending", createdAt: 1, ...patch };
}

const OVERVIEW: AccessOverview = {
  invites: [
    invite({ email: "george@gmail.com", role: "admin", invitedBy: "seed", createdAt: 10 }),
    invite({ email: "ana@rork.com", invitedBy: "domain:rork.com", createdAt: 20 }),
    invite({ email: "bob@mail.com", invitedBy: "george@gmail.com", createdAt: 30 }),
  ],
  requests: [
    request({ email: "carl@mail.com", name: "Carl", note: "Building a startup", status: "pending", createdAt: 40 }),
    request({ email: "dora@mail.com", status: "dismissed", createdAt: 50 }),
    request({ email: "ana@rork.com", status: "approved", createdAt: 5 }),
  ],
};

describe("accessStats", () => {
  it("counts members, admins, the live waitlist, and domain auto-invites", () => {
    expect(accessStats(OVERVIEW)).toEqual({ members: 3, admins: 1, waiting: 1, autoInvited: 1 });
  });

  it("is all zeros on an empty registry", () => {
    expect(accessStats({ invites: [], requests: [] })).toEqual({
      members: 0,
      admins: 0,
      waiting: 0,
      autoInvited: 0,
    });
  });
});

describe("filterAccessOverview", () => {
  it("returns everything untouched for a blank query", () => {
    expect(filterAccessOverview(OVERVIEW, "   ")).toEqual(OVERVIEW);
  });

  it("matches invites on email and inviter, case-insensitively", () => {
    const byEmail = filterAccessOverview(OVERVIEW, "BOB@");
    expect(byEmail.invites.map((entry) => entry.email)).toEqual(["bob@mail.com"]);
    // "george" hits the admin's own row AND the row he invited.
    const byInviter = filterAccessOverview(OVERVIEW, "george");
    expect(byInviter.invites.map((entry) => entry.email)).toEqual(["george@gmail.com", "bob@mail.com"]);
  });

  it("matches requests on email, name and note", () => {
    expect(filterAccessOverview(OVERVIEW, "startup").requests.map((entry) => entry.email)).toEqual(["carl@mail.com"]);
    expect(filterAccessOverview(OVERVIEW, "carl").requests).toHaveLength(1);
    expect(filterAccessOverview(OVERVIEW, "zzz").requests).toHaveLength(0);
  });
});

describe("sortInvites", () => {
  it("puts admins first, then newest members, without mutating the input", () => {
    const input = OVERVIEW.invites;
    const snapshot = [...input];
    const sorted = sortInvites(input);
    expect(sorted.map((entry) => entry.email)).toEqual(["george@gmail.com", "bob@mail.com", "ana@rork.com"]);
    expect(input).toEqual(snapshot);
  });
});
