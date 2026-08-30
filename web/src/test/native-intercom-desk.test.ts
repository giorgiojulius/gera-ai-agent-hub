// Pure derivation helpers behind the screen-desk Intercom widgets: inbox rows
// must surface the CUSTOMER and the LAST message (not the bot greeting), rank
// money-first (higher spender = tier-1), and the details panel must map
// assignees, teams, and contact attributes.
import { describe, expect, it } from "vitest";

import {
  attachmentLabel,
  buildIntercomNoteBody,
  deriveCompanyRows,
  deriveContactProfile,
  deriveConversationMeta,
  deriveConversationTranscript,
  deriveEventRows,
  deriveInboxRow,
  deriveReplyPairs,
  deriveThreadParts,
  extractSpendValue,
  moneyValue,
  rankInboxRows,
  readAttachments,
  scalarAttrs,
} from "../../../functions/native-intercom";

import { formatSpendCompact } from "../lib/projects";

const part = (
  type: string,
  authorType: string,
  name: string,
  body: string,
): Record<string, unknown> => ({
  id: `p-${name}-${body.length}`,
  part_type: type,
  body,
  created_at: 1_700_000_100,
  author: { type: authorType, name, email: authorType === "user" ? "kome@example.com" : "" },
});

const botStartedConversation: Record<string, unknown> = {
  id: "215475704643535",
  state: "open",
  created_at: 1_700_000_000,
  updated_at: 1_700_000_200,
  contacts: { contacts: [{ id: "c-1" }] },
  source: {
    author: { type: "bot", name: "Howard" },
    body: "<p>Hi there! You're speaking with Howard AI Agent.</p>",
    subject: "",
  },
  conversation_parts: {
    conversation_parts: [
      part("comment", "bot", "Howard", "So, how can we help you?"),
      part("comment", "user", "根津孝誠", "MCPは有料ですか？"),
      part("comment", "user", "根津孝誠", "解決しました。"),
    ],
  },
};

describe("deriveInboxRow", () => {
  it("names the customer and previews the last message, not the bot greeting", () => {
    const row = deriveInboxRow(botStartedConversation);
    expect(row.customerName).toBe("根津孝誠");
    expect(row.snippet).toBe("解決しました。");
    expect(row.contactId).toBe("c-1");
    expect(row.updatedAt).toBe(1_700_000_200_000);
  });

  it("prefixes teammate replies and notes with the author's first name", () => {
    const row = deriveInboxRow({
      ...botStartedConversation,
      conversation_parts: {
        conversation_parts: [
          part("comment", "user", "根津孝誠", "credits not showing"),
          part("note", "admin", "Robert Smith", "Glad i could help."),
        ],
      },
    });
    expect(row.snippet).toBe("Robert (note): Glad i could help.");
    expect(row.customerName).toBe("根津孝誠");
  });

  it("greeting-only conversations keep the contact id for name resolution", () => {
    const row = deriveInboxRow({
      ...botStartedConversation,
      conversation_parts: {
        conversation_parts: [part("comment", "bot", "Howard", "Ask me anything!")],
      },
    });
    expect(row.customerName).toBe("");
    expect(row.contactId).toBe("c-1");
    expect(row.snippet).toBe("Howard: Ask me anything!");
  });

  it("survives the bare list payload (no parts) without inventing data", () => {
    const listItem: Record<string, unknown> = {
      ...botStartedConversation,
      conversation_parts: undefined,
    };
    const row = deriveInboxRow(listItem);
    expect(row.snippet).toContain("Howard: Hi there!");
    expect(row.customerName).toBe("");
  });
});

describe("deriveConversationMeta", () => {
  it("maps assignee/team ids to names and reads tags + priority", () => {
    const meta = deriveConversationMeta(
      {
        id: "9",
        state: "open",
        priority: "priority",
        created_at: 1_700_000_000,
        updated_at: 1_700_000_050,
        waiting_since: 1_700_000_010,
        admin_assignee_id: 814860,
        team_assignee_id: 55,
        tags: { tags: [{ name: "billing" }, { name: "bug" }] },
        source: { type: "conversation", delivered_as: "customer_initiated", subject: "" },
        custom_attributes: { Language: "ja" },
      },
      new Map([["814860", "Olivia Jason"]]),
      new Map([["55", "Engineering"]]),
    );
    expect(meta.assignee).toBe("Olivia Jason");
    expect(meta.teamInbox).toBe("Engineering");
    expect(meta.priority).toBe(true);
    expect(meta.channel).toBe("Chat");
    expect(meta.tags).toEqual(["billing", "bug"]);
    expect(meta.attributes).toEqual([{ key: "Language", value: "ja" }]);
  });

  it("keeps honest #id labels when the directory misses the admin", () => {
    const meta = deriveConversationMeta(
      { id: "9", admin_assignee_id: 1, source: { type: "email" } },
      new Map<string, string>(),
      new Map<string, string>(),
    );
    expect(meta.assignee).toBe("Admin #1");
    expect(meta.teamInbox).toBe("");
    expect(meta.channel).toBe("Email");
  });
});

describe("deriveContactProfile", () => {
  it("maps the standard fields plus scalar custom attributes", () => {
    const profile = deriveContactProfile(
      {
        id: "c-1",
        name: "根津孝誠",
        email: "kome@example.com",
        role: "user",
        external_id: "542bca91",
        owner_id: 814860,
        location: { city: "", region: "", country: "Japan" },
        browser: "chrome",
        browser_version: "150.0.0.0",
        os: "Mac OS X",
        browser_language: "ja",
        signed_up_at: 1_700_000_000,
        last_seen_at: 1_700_000_100,
        created_at: 1_699_000_000,
        custom_attributes: {
          Plan: "Max 200",
          "Stripe plan price": 200,
          "Revenuecat customer id": null,
          nested: { skip: true },
        },
      },
      ["Acme"],
      new Map([["814860", "Olivia Jason"]]),
    );
    expect(profile.owner).toBe("Olivia Jason");
    expect(profile.location).toBe("Japan");
    expect(profile.userId).toBe("542bca91");
    expect(profile.companies).toEqual(["Acme"]);
    expect(profile.browser).toBe("chrome");
    expect(profile.attributes).toEqual([
      { key: "Plan", value: "Max 200" },
      { key: "Stripe plan price", value: "200" },
    ]);
  });
});

describe("scalarAttrs", () => {
  it("skips objects, nulls and empties; stringifies booleans and numbers", () => {
    expect(scalarAttrs({ a: "x", b: 2, c: true, d: null, e: "", f: { g: 1 } })).toEqual([
      { key: "a", value: "x" },
      { key: "b", value: "2" },
      { key: "c", value: "true" },
    ]);
  });
});

describe("deriveEventRows", () => {
  it("maps event names to readable rows, newest first, skipping unnamed", () => {
    const rows = deriveEventRows({
      events: [
        { event_name: "opened-project", created_at: 1_700_000_000 },
        { event_name: "purchased_plan", created_at: 1_700_000_100 },
        { event_name: "", created_at: 1_700_000_200 },
      ],
    });
    expect(rows).toEqual([
      { name: "purchased plan", at: 1_700_000_100_000 },
      { name: "opened project", at: 1_700_000_000_000 },
    ]);
  });

  it("returns empty for payloads without events", () => {
    expect(deriveEventRows({})).toEqual([]);
  });
});

describe("deriveCompanyRows", () => {
  it("collects names, plan, spend, and scalar custom attributes (incl. Cyrillic keys)", () => {
    const { names, rows } = deriveCompanyRows([
      {
        name: "Acme",
        plan: { name: "Scale" },
        monthly_spend: 200,
        custom_attributes: {
          "Долг по проекту": 150,
          Link: "https://acme.dev/project",
          nested: { skip: true },
        },
      },
    ]);
    expect(names).toEqual(["Acme"]);
    expect(rows).toEqual([
      { key: "Acme plan", value: "Scale" },
      { key: "Acme monthly spend", value: "200" },
      { key: "Долг по проекту", value: "150" },
      { key: "Link", value: "https://acme.dev/project" },
    ]);
  });

  it("zero spend and empty attributes yield no billing rows", () => {
    const { names, rows } = deriveCompanyRows([{ name: "Empty Co", monthly_spend: 0 }]);
    expect(names).toEqual(["Empty Co"]);
    expect(rows).toEqual([]);
  });
});

describe("moneyValue", () => {
  it("parses plain numbers, currency strings and RU formats", () => {
    expect(moneyValue(499)).toBe(499);
    expect(moneyValue("$4,990.50")).toBe(4990.5);
    expect(moneyValue("4 990 ₽")).toBe(4990);
    expect(moneyValue("499 USD")).toBe(499);
    expect(moneyValue("4990,50")).toBe(4990.5);
  });

  it("rejects ids, dates and prose", () => {
    expect(moneyValue("price_1NxYzAbC")).toBeNull();
    expect(moneyValue("2026-08-30")).toBeNull();
    expect(moneyValue("two hundred")).toBeNull();
    expect(moneyValue("")).toBeNull();
    expect(moneyValue({ nested: true })).toBeNull();
  });
});

describe("extractSpendValue", () => {
  it("takes the largest spend-looking attribute across EN and RU keys", () => {
    expect(
      extractSpendValue({
        monthly_spend: 120,
        "Stripe plan price": "$499.00",
        "оплата в месяц": "4 990 ₽",
        plan: "Scale",
      }),
    ).toBe(4990);
  });

  it("ignores ids, dates, debt/balance keys and zero values", () => {
    expect(
      extractSpendValue({
        stripe_price_id: "price_1NxYz",
        paid_at: 1_700_000_000,
        "Stripe account balance": -2000,
        "Долг по проекту": 1500,
        spend: 0,
      }),
    ).toBeNull();
  });
});

describe("rankInboxRows", () => {
  const row = (id: string, spend: number | null, updatedAt: number) => ({ id, spend, updatedAt });

  it("puts higher spenders first and stamps tiers relative to the top payer", () => {
    const ranked = rankInboxRows([
      row("late-free", null, 400),
      row("small", 100, 100),
      row("top", 900, 50),
      row("mid", 500, 300),
      row("early-free", null, 200),
    ]);
    expect(ranked.map((r) => r.id)).toEqual(["top", "mid", "small", "late-free", "early-free"]);
    expect(ranked.map((r) => r.tier)).toEqual([1, 2, 3, null, null]);
  });

  it("tiers equal payers equally and orders them by recency", () => {
    const ranked = rankInboxRows([row("older", 200, 10), row("newer", 200, 99)]);
    expect(ranked.map((r) => r.id)).toEqual(["newer", "older"]);
    expect(ranked.map((r) => r.tier)).toEqual([1, 1]);
  });

  it("gives no tiers when nobody pays", () => {
    const ranked = rankInboxRows([row("a", null, 2), row("b", 0, 1)]);
    expect(ranked.map((r) => r.id)).toEqual(["a", "b"]);
    expect(ranked.map((r) => r.tier)).toEqual([null, null]);
  });
});

// The tier badge carries the amount inline ("T1 · 1.2k") — priority must be
// visible in the list, not hidden behind a hover tooltip.
describe("formatSpendCompact", () => {
  it("keeps the amount readable right on the badge", () => {
    expect(formatSpendCompact(980)).toBe("980");
    expect(formatSpendCompact(1234)).toBe("1.2k");
    expect(formatSpendCompact(48251)).toBe("48k");
    expect(formatSpendCompact(1150000)).toBe("1.2M");
    expect(formatSpendCompact(24000000)).toBe("24M");
  });

  it("stays silent when there is no positive spend", () => {
    expect(formatSpendCompact(0)).toBe("");
    expect(formatSpendCompact(-12)).toBe("");
    expect(formatSpendCompact(Number.NaN)).toBe("");
  });
});

const replyPairsFixture: Record<string, unknown> = {
    id: "77",
    created_at: 1_700_000_000,
    source: { body: "<p>Help, export fails</p>", author: { type: "user", name: "Anna" } },
    conversation_parts: {
      conversation_parts: [
        {
          id: "p1",
          part_type: "comment",
          body: "<p>Hi! Which browser?</p>",
          created_at: 1_700_000_060,
          author: { type: "admin", id: 9, name: "Maria" },
        },
        {
          id: "p2",
          part_type: "comment",
          body: "<p>Chrome</p>",
          created_at: 1_700_000_120,
          author: { type: "user", name: "Anna" },
        },
        {
          id: "p3",
          part_type: "note",
          body: "<p>check logs</p>",
          created_at: 1_700_000_130,
          author: { type: "admin", id: 9, name: "Maria" },
        },
        {
          id: "p4",
          part_type: "comment",
          body: "<p>bot says hi</p>",
          created_at: 1_700_000_140,
          author: { type: "bot", name: "Fin" },
        },
        {
          id: "p5",
          part_type: "comment",
          body: "<p>Fixed — try again</p>",
          created_at: 1_700_000_400,
          author: { type: "admin", id: "9", name: "Maria" },
        },
        {
          id: "p6",
          part_type: "comment",
          body: "<p>Also, ping me anytime</p>",
          created_at: 1_700_000_460,
          author: { type: "admin", id: "9", name: "Maria" },
        },
      ],
    },
};

describe("deriveReplyPairs", () => {
  it("pairs human replies with the customer message they answered", () => {
    const pairs = deriveReplyPairs(replyPairsFixture);
    expect(pairs.map((pair) => pair.id)).toEqual(["p1", "p5", "p6"]);
    expect(pairs[0]).toMatchObject({
      adminId: "9",
      adminName: "Maria",
      customerText: "Help, export fails",
      responseMs: 60_000,
    });
    expect(pairs[1]).toMatchObject({ customerText: "Chrome", responseMs: 280_000 });
  });

  it("skips notes and bots; follow-ups do not re-claim the customer message", () => {
    const pairs = deriveReplyPairs(replyPairsFixture);
    expect(pairs.find((pair) => pair.id === "p3")).toBeUndefined();
    expect(pairs.find((pair) => pair.id === "p4")).toBeUndefined();
    expect(pairs[2]).toMatchObject({ id: "p6", customerText: "", responseMs: 0 });
  });

  it("does not treat an admin-started opener as customer context", () => {
    const outbound: Record<string, unknown> = {
      id: "88",
      created_at: 1_700_000_000,
      source: { body: "<p>Hey, checking in!</p>", author: { type: "admin", id: 9, name: "Maria" } },
      conversation_parts: {
        conversation_parts: [
          {
            id: "q1",
            part_type: "comment",
            body: "<p>All good, thanks</p>",
            created_at: 1_700_000_100,
            author: { type: "user", name: "Anna" },
          },
          {
            id: "q2",
            part_type: "comment",
            body: "<p>Great!</p>",
            created_at: 1_700_000_160,
            author: { type: "admin", id: 9, name: "Maria" },
          },
        ],
      },
    };
    const pairs = deriveReplyPairs(outbound);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ id: "q2", customerText: "All good, thanks", responseMs: 60_000 });
  });
});

describe("deriveConversationTranscript", () => {
  it("labels speakers, marks human replies with part ids, keeps notes and bots as context", () => {
    const transcript = deriveConversationTranscript(replyPairsFixture);
    const lines = transcript.split("\n");
    expect(lines[0]).toBe("Customer (Anna): Help, export fails");
    expect(lines).toContain("[p1] Maria (teammate): Hi! Which browser?");
    expect(lines).toContain("Customer (Anna): Chrome");
    expect(lines).toContain("Internal note (Maria): check logs");
    expect(lines).toContain("Bot (Fin): bot says hi");
    expect(lines).toContain("[p5] Maria (teammate): Fixed — try again");
    expect(lines).toContain("[p6] Maria (teammate): Also, ping me anytime");
  });

  it("keeps an admin opener as unmarked context", () => {
    const outbound: Record<string, unknown> = {
      id: "88",
      created_at: 1_700_000_000,
      source: { body: "<p>Hey, checking in!</p>", author: { type: "admin", id: 9, name: "Maria" } },
      conversation_parts: { conversation_parts: [] },
    };
    expect(deriveConversationTranscript(outbound)).toBe("Maria (teammate, opener): Hey, checking in!");
  });
});

// Attachments: Intercom delivers pasted screenshots/files as `attachments`
// arrays on sources and parts — often with NO text body. Dropping bodyless
// parts silently hid whole customer turns from the desk, previews, and the
// model-facing transcripts.
const upload = (name: string, contentType: string, filesize = 0): Record<string, unknown> => ({
  type: "upload",
  name,
  url: `https://downloads.intercomcdn.com/i/o/${name}?expires=1&signature=s`,
  content_type: contentType,
  filesize,
});

describe("readAttachments", () => {
  it("parses name/type/size and keeps only http(s) links", () => {
    const parsed = readAttachments({
      attachments: [
        upload("screen.png", "image/png", 1_300_000),
        { type: "upload", name: "evil", url: "javascript:alert(1)", content_type: "" },
        { type: "upload", name: "", url: "https://downloads.intercomcdn.com/x", content_type: "text/plain" },
      ],
    });
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ name: "screen.png", contentType: "image/png", size: 1_300_000 });
    expect(parsed[1]?.name).toBe("attachment");
  });

  it("returns empty for payloads without attachments", () => {
    expect(readAttachments({})).toEqual([]);
  });
});

describe("attachmentLabel", () => {
  it("names files with type and size — never the expiring URL", () => {
    const label = attachmentLabel(
      readAttachments({ attachments: [upload("a.png", "image/png", 1_300_000), upload("b.log", "")] }),
    );
    expect(label).toBe("[attached: a.png (image/png, 1.2 MB); b.log]");
    expect(label).not.toContain("https://");
    expect(attachmentLabel([])).toBe("");
  });
});

describe("deriveThreadParts", () => {
  it("keeps attachment-only customer messages that were previously dropped", () => {
    const parts = deriveThreadParts({
      id: "55",
      created_at: 1_700_000_000,
      source: { body: "<p>hi</p>", author: { type: "user", name: "Anna" } },
      conversation_parts: {
        conversation_parts: [
          {
            id: "p1",
            part_type: "comment",
            body: "",
            created_at: 1_700_000_060,
            author: { type: "user", name: "Anna" },
            attachments: [upload("crash.png", "image/png", 52_000)],
          },
        ],
      },
    });
    expect(parts).toHaveLength(2);
    expect(parts[1]).toMatchObject({ id: "p1", role: "customer", body: "" });
    expect(parts[1]?.attachments[0]).toMatchObject({ name: "crash.png", contentType: "image/png" });
    expect(parts[1]?.attachments[0]?.url).toContain("https://downloads.intercomcdn.com");
  });

  it("keeps an attachment-only opener", () => {
    const parts = deriveThreadParts(
      {
        id: "",
        created_at: 1_700_000_000,
        source: {
          body: "",
          author: { type: "user", name: "Anna" },
          attachments: [upload("invoice.pdf", "application/pdf")],
        },
        conversation_parts: { conversation_parts: [] },
      },
      "56",
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]?.id).toBe("src-56");
    expect(parts[0]?.attachments[0]?.name).toBe("invoice.pdf");
  });
});

describe("attachment-only turns in previews and grading inputs", () => {
  it("deriveInboxRow previews the attachment instead of hiding the turn", () => {
    const row = deriveInboxRow({
      ...botStartedConversation,
      conversation_parts: {
        conversation_parts: [
          {
            id: "p9",
            part_type: "comment",
            body: "",
            created_at: 1_700_000_100,
            author: { type: "user", name: "根津孝誠", email: "kome@example.com" },
            attachments: [upload("bug.png", "image/png", 10_000), upload("log.txt", "text/plain")],
          },
        ],
      },
    });
    expect(row.snippet).toBe("Attachments: bug.png +1");
    expect(row.customerName).toBe("根津孝誠");
  });

  it("deriveReplyPairs pairs the reply to a screenshot-only turn with its wait time", () => {
    const pairs = deriveReplyPairs({
      id: "78",
      created_at: 1_700_000_000,
      source: { body: "<p>see this</p>", author: { type: "user", name: "Anna" } },
      conversation_parts: {
        conversation_parts: [
          {
            id: "s1",
            part_type: "comment",
            body: "",
            created_at: 1_700_000_060,
            author: { type: "user", name: "Anna" },
            attachments: [upload("error.png", "image/png", 1_300_000)],
          },
          {
            id: "s2",
            part_type: "comment",
            body: "<p>Thanks, looking!</p>",
            created_at: 1_700_000_120,
            author: { type: "admin", id: 9, name: "Maria" },
          },
        ],
      },
    });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      id: "s2",
      customerText: "[attached: error.png (image/png, 1.2 MB)]",
      responseMs: 60_000,
    });
  });

  it("deriveConversationTranscript mentions attachments inline for the grader", () => {
    const transcript = deriveConversationTranscript({
      id: "79",
      created_at: 1_700_000_000,
      source: {
        body: "",
        author: { type: "user", name: "Anna" },
        attachments: [upload("err.png", "image/png")],
      },
      conversation_parts: {
        conversation_parts: [
          {
            id: "t1",
            part_type: "comment",
            body: "<p>fix attached</p>",
            created_at: 1_700_000_060,
            author: { type: "admin", id: 9, name: "Maria" },
            attachments: [upload("patch.txt", "text/plain")],
          },
        ],
      },
    });
    const lines = transcript.split("\n");
    expect(lines[0]).toBe("Customer (Anna): [attached: err.png (image/png)]");
    expect(lines[1]).toBe("[t1] Maria (teammate): fix attached [attached: patch.txt (text/plain)]");
  });
});

describe("buildIntercomNoteBody", () => {
  it("turns @Name into an Intercom mention link and escapes the rest", () => {
    const html = buildIntercomNoteBody(
      "Ping @Maria Lopez — customer is blocked <now>",
      [{ id: "77", name: "Maria Lopez" }],
      "abc123",
    );
    expect(html).toBe(
      '<p>Ping <a href="https://app.intercom.com/a/apps/abc123/admins/77" class="mention">@Maria Lopez</a> — customer is blocked &lt;now&gt;</p>',
    );
  });

  it("prefers the longest name at a shared prefix and guards word boundaries", () => {
    const html = buildIntercomNoteBody("@Ann meet @Anna", [
      { id: "1", name: "Ann" },
      { id: "2", name: "Anna" },
    ]);
    expect(html).toContain('admins/1" class="mention">@Ann</a> meet');
    expect(html).toContain('admins/2" class="mention">@Anna</a>');
    expect(buildIntercomNoteBody("@Annabelle", [{ id: "1", name: "Ann" }])).toBe("<p>@Annabelle</p>");
  });

  it("leaves the body untouched when no listed mention appears in the text", () => {
    expect(buildIntercomNoteBody("plain note", [{ id: "9", name: "Maria" }])).toBe("<p>plain note</p>");
    expect(buildIntercomNoteBody("no tags here", [])).toBe("<p>no tags here</p>");
  });
});
