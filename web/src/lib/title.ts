import { TITLE_MODEL } from "@/lib/models";
import { chatGatewayOptions } from "@/lib/tools";
import { toolkitFetch } from "@/lib/toolkit";
import { reportUsage } from "@/lib/usage";

/**
 * Thread auto-titling: Luna condenses the first prompt into a short human
 * title ("Рецепт борща", "Trip budget planner"). Any failure returns null
 * and the caller keeps the raw-prompt fallback title.
 */
const TITLE_PROMPT = `You name chat threads. The user message below is the FIRST message of a conversation. Reply with ONLY the thread title.
Rules:
- 2-5 words, at most 40 characters.
- Same language as the message.
- Name the topic or goal, like a good notebook tab. Never answer the message itself.
- Plain text: no quotes, no emoji, no markdown, no trailing punctuation.`;

/** Symmetric quote pairs the models love to wrap titles in. */
const WRAPPERS: Array<[string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["«", "»"],
  ["“", "”"],
  ["‘", "’"],
  ["„", "“"],
  ["`", "`"],
];

/**
 * Normalizes raw model output into a sidebar-ready title, or null when the
 * output is unusable (empty, or so long the model clearly answered instead
 * of titling) — the caller then keeps the fallback title.
 */
export function cleanGeneratedTitle(raw: string): string | null {
  let text =
    raw
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  text = text.replace(/^(?:title|название|заголовок|тема)\s*[:\-–—]\s*/i, "");
  text = text.replace(/[*_`#]+/g, "").replace(/\s+/g, " ").trim();

  // Quotes and trailing punctuation can nest (e.g. `«Рецепт борща».`) —
  // alternate both strips until the text stabilizes.
  let changed = true;
  while (changed) {
    changed = false;
    const trimmed = text.replace(/[\s.…!?,:;]+$/u, "").trim();
    if (trimmed !== text) {
      text = trimmed;
      changed = true;
    }
    for (const [open, close] of WRAPPERS) {
      if (
        text.length > open.length + close.length &&
        text.startsWith(open) &&
        text.endsWith(close)
      ) {
        text = text.slice(open.length, text.length - close.length).trim();
        changed = true;
      }
    }
  }

  if (text.length < 2 || text.length > 60) {
    return null;
  }
  if (text.length > 48) {
    const cut = text.slice(0, 48);
    const space = cut.lastIndexOf(" ");
    text = `${(space > 24 ? cut.slice(0, space) : cut).trimEnd()}…`;
  }
  return text;
}

/**
 * Asks Luna for a pretty thread title. Fire-and-forget friendly:
 * never throws, ~8s budget, usage is reported into the session cost meter.
 */
export async function generateChatTitle(prompt: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 8000);
  try {
    const response = await toolkitFetch("/v2/vercel/v1/chat/completions", {
      method: "POST",
      retry: false,
      signal: controller.signal,
      body: JSON.stringify({
        model: TITLE_MODEL,
        stream: false,
        temperature: 0.4,
        max_tokens: 64,
        messages: [
          { role: "system", content: TITLE_PROMPT },
          { role: "user", content: prompt.slice(0, 1500) },
        ],
        providerOptions: chatGatewayOptions(),
      }),
    });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: Record<string, unknown>;
    };
    reportUsage(TITLE_MODEL, data.usage, "service");
    return cleanGeneratedTitle(data.choices?.[0]?.message?.content ?? "");
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}
