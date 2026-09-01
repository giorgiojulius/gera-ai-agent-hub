// Desk intelligence parsers/prompts: reply suggestions must survive messy LLM
// output (fences, prose), grading must drop unusable entries, and the prompt
// builders must carry the transcript + calibration blocks the desk relies on.
import { describe, expect, it } from "vitest";

import {
  buildGradeMessages,
  buildSuggestMessages,
  parseGradePayload,
  parseSuggestPayload,
} from "../../../functions/desk-intelligence";

describe("parseSuggestPayload", () => {
  it("parses a clean JSON payload", () => {
    const parsed = parseSuggestPayload(
      JSON.stringify({
        replies: ["Привет! Сейчас проверю и вернусь.", "А какой у вас тариф?"],
        action: "reply",
        action_reason: "customer waits",
        functionality_question: null,
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.replies).toHaveLength(2);
    expect(parsed?.action).toBe("reply");
    expect(parsed?.functionalityQuestion).toBe("");
  });

  it("parses fenced JSON surrounded by prose", () => {
    const raw = [
      "Here you go:",
      "```json",
      '{"replies":["On it — checking now."],"action":"snooze","action_reason":"waiting on the customer","functionality_question":"Does the API support webhooks?"}',
      "```",
      "Hope that helps!",
    ].join("\n");
    const parsed = parseSuggestPayload(raw);
    expect(parsed?.replies).toEqual(["On it — checking now."]);
    expect(parsed?.action).toBe("snooze");
    expect(parsed?.functionalityQuestion).toBe("Does the API support webhooks?");
  });

  it("normalizes unknown actions to reply and caps replies at 3", () => {
    const parsed = parseSuggestPayload(
      JSON.stringify({ replies: ["a", "b", "c", "d"], action: "escalate" }),
    );
    expect(parsed?.replies).toEqual(["a", "b", "c"]);
    expect(parsed?.action).toBe("reply");
  });

  it("accepts an action-only payload (nothing to reply, recommends close)", () => {
    const parsed = parseSuggestPayload(
      JSON.stringify({ replies: [], action: "close", action_reason: "customer said thanks" }),
    );
    expect(parsed?.replies).toEqual([]);
    expect(parsed?.action).toBe("close");
  });

  it("returns null for garbage and for empty reply-action payloads", () => {
    expect(parseSuggestPayload("no json here")).toBeNull();
    expect(parseSuggestPayload(JSON.stringify({ replies: [], action: "reply" }))).toBeNull();
    expect(parseSuggestPayload("[1,2,3]")).toBeNull();
  });

  it("reads the Slack investigation flag and drops unknown statuses", () => {
    const inProgress = parseSuggestPayload(
      JSON.stringify({
        replies: ["Мы уже разбираемся — вернусь с ответом."],
        action: "snooze",
        investigation: { status: "in_progress", summary: "Команда ищет причину в #support" },
      }),
    );
    expect(inProgress?.investigation).toEqual({
      status: "in_progress",
      summary: "Команда ищет причину в #support",
    });

    const answered = parseSuggestPayload(
      JSON.stringify({
        replies: ["Починили — попробуйте ещё раз."],
        action: "reply",
        investigation: { status: "answered", summary: "Фикс уже выкачен" },
      }),
    );
    expect(answered?.investigation?.status).toBe("answered");

    const garbage = parseSuggestPayload(
      JSON.stringify({
        replies: ["ok"],
        action: "reply",
        investigation: { status: "maybe", summary: "??" },
      }),
    );
    expect(garbage?.investigation).toBeNull();

    const missing = parseSuggestPayload(JSON.stringify({ replies: ["ok"], action: "reply" }));
    expect(missing?.investigation).toBeNull();
  });
});

describe("parseGradePayload", () => {
  it("keeps only good/bad verdicts with ids and reads coaching", () => {
    const parsed = parseGradePayload(
      JSON.stringify({
        grades: [
          { id: "p1", verdict: "good", reason: "solved it fast" },
          { id: "p2", verdict: "meh", reason: "??" },
          { id: "", verdict: "bad", reason: "no id" },
          { id: "p3", verdict: "BAD", reason: "missed the question" },
        ],
        coaching: [
          { admin_id: "9", text: "You answer fast — keep quoting the exact fix." },
          { admin_id: "", text: "orphan" },
          { admin_id: "10", text: "" },
        ],
      }),
    );
    expect(parsed?.grades).toEqual([
      { id: "p1", verdict: "good", reason: "solved it fast" },
      { id: "p3", verdict: "bad", reason: "missed the question" },
    ]);
    expect(parsed?.coaching).toEqual([
      { adminId: "9", text: "You answer fast — keep quoting the exact fix." },
    ]);
  });

  it("returns null when nothing usable came back", () => {
    expect(parseGradePayload("total garbage")).toBeNull();
    expect(parseGradePayload(JSON.stringify({ grades: [], coaching: [] }))).toBeNull();
  });
});

describe("prompt builders", () => {
  it("suggest prompt carries the transcript and calibration blocks", () => {
    const messages = buildSuggestMessages({
      customer: "Anna",
      state: "open",
      transcript: ["Customer (Anna): Export fails", "Maria (teammate): Which browser?"],
      likedExamples: ["Sure — checking right now."],
      dislikedExamples: ["We apologize for any inconvenience caused."],
      teamExamples: ["Fixed, try again please!"],
    });
    expect(messages[0].role).toBe("system");
    expect(String(messages[0].content)).toContain("STRICT JSON");
    const user = String(messages[1].content);
    expect(user).toContain("Customer (Anna): Export fails");
    expect(user).toContain("rated UP");
    expect(user).toContain("rated DOWN");
    expect(user).toContain("graded good");
  });

  it("suggest prompt carries the Team Slack block only when threads exist", () => {
    const withSlack = buildSuggestMessages({
      customer: "Anna",
      state: "open",
      transcript: ["Customer (Anna): Export fails"],
      likedExamples: [],
      dislikedExamples: [],
      teamExamples: [],
      slackThreads: [
        "[#support] last activity 5m ago (ACTIVE — the team is working it right now):\n  @maria: digging in",
      ],
    });
    const user = String(withSlack[1].content);
    expect(user).toContain("Team Slack — internal discussions");
    expect(user).toContain("@maria: digging in");
    expect(String(withSlack[0].content)).toContain('"investigation"');

    const without = buildSuggestMessages({
      customer: "Anna",
      state: "open",
      transcript: ["Customer (Anna): Export fails"],
      likedExamples: [],
      dislikedExamples: [],
      teamExamples: [],
    });
    expect(String(without[1].content)).not.toContain("Team Slack");
  });

  it("grade prompt groups replies inside their conversation transcript", () => {
    const messages = buildGradeMessages({
      conversations: [
        {
          conversationId: "77",
          transcript: [
            "Customer (Anna): Export fails",
            "[p1] Maria (teammate): Which browser?",
            "Customer (Anna): Chrome",
            "Internal note (Maria): check logs",
            "[p5] Maria (teammate): Fixed — try once more.",
          ].join("\n"),
          replies: [{ id: "p5", adminId: "9", adminName: "Maria", responseMs: 45_000 }],
        },
      ],
      orphans: [
        {
          id: "p9",
          adminId: "9",
          adminName: "Maria",
          customerText: "",
          replyText: "Ping me anytime!",
          responseMs: 0,
        },
      ],
    });
    const user = String(messages[1].content);
    expect(user).toContain("Conversation 1 (id 77), oldest first:");
    expect(user).toContain("[p5] Maria (teammate): Fixed — try once more.");
    expect(user).toContain("Internal note (Maria): check logs");
    expect(user).toContain("- [p5] Maria (admin_id 9) — customer waited 45s");
    expect(user).toContain("- [p9] Maria (admin_id 9) — proactive / follow-up");
    expect(user).toContain("no preceding customer message");
    const system = String(messages[0].content);
    expect(system).toContain("WHOLE CONVERSATION");
    expect(system).toContain('"good|bad"');
  });

  it("grade prompt trims oldest unmarked lines but never the replies being graded", () => {
    const filler = Array.from({ length: 100 }, (_, i) => `Customer (Anna): filler message ${i}`);
    const transcript = [
      "[p1] Maria (teammate): Early reply",
      ...filler,
      "[p2] Maria (teammate): Late reply",
    ].join("\n");
    const messages = buildGradeMessages({
      conversations: [
        {
          conversationId: "77",
          transcript,
          replies: [
            { id: "p1", adminId: "9", adminName: "Maria", responseMs: 1_000 },
            { id: "p2", adminId: "9", adminName: "Maria", responseMs: 2_000 },
          ],
        },
      ],
      orphans: [],
    });
    const user = String(messages[1].content);
    expect(user).toContain("earlier messages trimmed");
    expect(user).toContain("[p1] Maria (teammate): Early reply");
    expect(user).toContain("[p2] Maria (teammate): Late reply");
    expect(user).not.toContain("filler message 0");
    expect(user).toContain("filler message 99");
  });
});
