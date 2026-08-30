// Desk ↔ Slack awareness: matching internal Slack discussions to an Intercom
// conversation must be deterministic (explicit references only — id, email,
// full name), replies must collapse into one card per thread, and the prompt
// block must tell the model whether the team is still digging or already done.
import { describe, expect, it } from "vitest";

import {
  buildSlackThreadBlock,
  classifySlackReference,
  matchSlackDiscussions,
  slackPermalink,
  slackThreadActive,
  type DeskSlackMessage,
  type DeskSlackTarget,
} from "../../../functions/desk-slack";

const target: DeskSlackTarget = {
  conversationId: "215479310",
  customerEmail: "anna@acme.io",
  customerName: "Anna Petrova",
};

function msg(overrides: Partial<DeskSlackMessage>): DeskSlackMessage {
  return {
    channelId: "C1",
    channelName: "support",
    ts: "1725012345.000100",
    threadTs: "",
    author: "maria",
    text: "",
    replyCount: 0,
    lastActivityTs: 1_725_012_345,
    ...overrides,
  };
}

describe("classifySlackReference", () => {
  it("matches the conversation id via Intercom URL, #id, and bare id with boundaries", () => {
    expect(
      classifySlackReference(
        "see https://app.intercom.com/a/inbox/x/conversation/215479310 please",
        target,
      ),
    ).toBe("conversation");
    expect(classifySlackReference("re: #215479310 — refund case", target)).toBe("conversation");
    expect(classifySlackReference("им занимаюсь, 215479310 в работе", target)).toBe("conversation");
  });

  it("does not match the id inside a longer number or decimal", () => {
    expect(classifySlackReference("order 9215479310 shipped", target)).toBeNull();
    expect(classifySlackReference("ratio is 215479310.5 today", target)).toBeNull();
  });

  it("requires 6+ digits for a bare id but still honors the # prefix for short ids", () => {
    const short: DeskSlackTarget = { ...target, conversationId: "12345" };
    expect(classifySlackReference("check 12345 maybe", short)).toBeNull();
    expect(classifySlackReference("check #12345 maybe", short)).toBe("conversation");
  });

  it("matches the customer email case-insensitively", () => {
    expect(classifySlackReference("ticket from ANNA@ACME.IO again", target)).toBe("email");
  });

  it("matches only the FULL customer name, never a bare first name", () => {
    expect(classifySlackReference("что там у anna petrova с экспортом?", target)).toBe("name");
    expect(classifySlackReference("Anna pinged us again", target)).toBeNull();
  });

  it("returns null when nothing references the case or the target is empty", () => {
    expect(classifySlackReference("deploy went fine, closing the incident", target)).toBeNull();
    expect(
      classifySlackReference("random text 123456789", {
        conversationId: "",
        customerEmail: "",
        customerName: "",
      }),
    ).toBeNull();
  });
});

describe("matchSlackDiscussions", () => {
  it("collapses thread replies into one card keyed by the root ts", () => {
    const matches = matchSlackDiscussions(target, [
      msg({ ts: "100.1", threadTs: "", text: "looking at #215479310", lastActivityTs: 100 }),
      msg({ ts: "200.1", threadTs: "100.1", text: "anna@acme.io says it broke", lastActivityTs: 200 }),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.rootTs).toBe("100.1");
    // Max of the reply's own ts (200.1) and the reported thread activity (200).
    expect(matches[0]?.lastActivityTs).toBe(200.1);
  });

  it("keeps the strongest signal as the label (conversation > email > name)", () => {
    const matches = matchSlackDiscussions(target, [
      msg({ ts: "100.1", text: "Anna Petrova is unhappy", lastActivityTs: 100 }),
      msg({ ts: "150.1", threadTs: "100.1", text: "it is #215479310", lastActivityTs: 150 }),
    ]);
    expect(matches[0]?.matchedBy).toBe("conversation");
  });

  it("sorts newest activity first and caps the list", () => {
    const matches = matchSlackDiscussions(
      target,
      [
        msg({ channelId: "C1", ts: "100.1", text: "#215479310 one", lastActivityTs: 100 }),
        msg({ channelId: "C2", ts: "300.1", text: "#215479310 three", lastActivityTs: 300 }),
        msg({ channelId: "C3", ts: "200.1", text: "#215479310 two", lastActivityTs: 200 }),
      ],
      2,
    );
    expect(matches.map((m) => m.channelId)).toEqual(["C2", "C3"]);
  });

  it("ignores unrelated chatter entirely", () => {
    expect(
      matchSlackDiscussions(target, [msg({ text: "lunch?" }), msg({ text: "standup in 5" })]),
    ).toEqual([]);
  });
});

describe("slackThreadActive", () => {
  const now = 1_725_100_000_000;
  it("treats activity within the last hour as a live investigation", () => {
    expect(slackThreadActive(now / 1000 - 30 * 60, now)).toBe(true);
    expect(slackThreadActive(now / 1000 - 2 * 60 * 60, now)).toBe(false);
    expect(slackThreadActive(0, now)).toBe(false);
  });
});

describe("slackPermalink", () => {
  it("builds the archive URL and strips the ts dot and trailing slashes", () => {
    expect(slackPermalink("https://acme.slack.com/", "C42", "1725012345.000100")).toBe(
      "https://acme.slack.com/archives/C42/p1725012345000100",
    );
  });
});

describe("buildSlackThreadBlock", () => {
  const now = 1_725_100_000_000;
  it("labels an active thread so the model waits instead of inventing", () => {
    const block = buildSlackThreadBlock(
      {
        channelName: "support",
        active: true,
        lastActivityTs: now / 1000 - 10 * 60,
        lines: [
          { author: "maria", text: "digging   into\nthe export bug" },
          { author: "lev", text: "repro found" },
        ],
      },
      now,
    );
    expect(block).toContain("[#support] last activity 10m ago (ACTIVE — the team is working it right now):");
    expect(block).toContain("  @maria: digging into the export bug");
    expect(block).toContain("  @lev: repro found");
  });

  it("marks an old thread as quiet with a day-scale age", () => {
    const block = buildSlackThreadBlock(
      {
        channelName: "eng",
        active: false,
        lastActivityTs: now / 1000 - 3 * 24 * 60 * 60,
        lines: [{ author: "lev", text: "fixed, shipping tomorrow" }],
      },
      now,
    );
    expect(block).toContain("[#eng] last activity 3d ago (quiet):");
  });
});
