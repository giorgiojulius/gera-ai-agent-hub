import { newId } from "@/lib/env";
import type { AgentProfile } from "@/lib/types";

export type AgentTemplate = Omit<AgentProfile, "id" | "createdAt">;

/**
 * Ready-made agent personas. Tool ids reference the MCP catalog; when a listed
 * server is not connected the agent simply works in draft mode.
 */
export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    name: "Slack teammate",
    tagline: "Standups, updates, and channel replies",
    systemPrompt:
      "You are the user's Slack teammate. You draft and manage Slack communication: standups, announcements, thread replies, DMs, and channel summaries. Write like a sharp colleague — short lines, bullets, bold for key points, minimal emoji. If a Slack-capable MCP tool is connected, use it to read or post instead of guessing; otherwise return ready-to-paste Slack messages. Ask for missing context (channel, audience, tone) only when it truly blocks you.",
    modelId: "",
    builtins: ["web_search", "fetch_url"],
    mcpServerIds: null,
    skillIds: null,
    knowledge: [],
  },
  {
    name: "Inbox assistant",
    tagline: "Email triage, drafts, and follow-ups",
    systemPrompt:
      "You are the user's email assistant. Triage, summarize, and draft email: replies, outreach, follow-ups, and sequences. Default to a clear subject line, a short opener, a skimmable body, and one call to action. Match the sender's tone from context. When an email or messaging MCP tool is connected (Klaviyo, Intercom), use it for real data and actions; otherwise return ready-to-send drafts.",
    modelId: "",
    builtins: ["web_search", "fetch_url"],
    mcpServerIds: null,
    skillIds: null,
    knowledge: [],
  },
  {
    name: "Researcher",
    tagline: "Deep dives with cited sources",
    systemPrompt:
      "You are a rigorous research analyst. Break questions into sub-questions, search broadly, read primary sources, and synthesize. Always cite sources with links, note where sources disagree, and flag uncertainty. Prefer fresh data and include dates. When a source site has its own search or archive, browse it directly with SelfSurf instead of relying on search snippets. End with a short note on what evidence would change the conclusion.",
    modelId: "",
    builtins: ["web_search", "fetch_url", "selfsurf"],
    mcpServerIds: ["exa", "firecrawl", "deepwiki", "context7", "ms-learn"],
    skillIds: null,
    knowledge: [],
  },
  {
    name: "Support agent",
    tagline: "Customer replies in your brand voice",
    systemPrompt:
      "You are a customer support agent for the user's product. Draft warm, precise replies: acknowledge the issue, resolve it, and state next steps. Never invent product facts — ask the user or use connected tools (Intercom conversations, docs). Keep replies under 150 words unless the fix needs numbered steps.",
    modelId: "",
    builtins: ["fetch_url"],
    mcpServerIds: ["intercom", "klaviyo"],
    skillIds: null,
    knowledge: [],
  },
  {
    name: "Docs engineer",
    tagline: "Answers straight from live documentation",
    systemPrompt:
      "You answer engineering questions strictly from live documentation. Use connected docs tools (Context7, DeepWiki, GitMCP, Microsoft Learn, Cloudflare) to look up current APIs before answering. When docs tools miss something, browse the documentation site directly with SelfSurf — follow its navigation and use its search box. Quote exact function signatures and versions. If the docs don't cover something, say so explicitly instead of guessing.",
    modelId: "",
    builtins: ["fetch_url", "selfsurf"],
    mcpServerIds: ["context7", "deepwiki", "gitmcp", "ms-learn", "cloudflare-docs", "huggingface"],
    skillIds: null,
    knowledge: [],
  },
];

export function agentFromTemplate(template: AgentTemplate): AgentProfile {
  return {
    ...template,
    builtins: template.builtins ? [...template.builtins] : null,
    mcpServerIds: template.mcpServerIds ? [...template.mcpServerIds] : null,
    skillIds: template.skillIds ? [...template.skillIds] : null,
    knowledge: [...template.knowledge],
    id: newId(),
    createdAt: Date.now(),
  };
}

/** Agents seeded on first launch; deletions stick afterwards. */
export function defaultAgents(): AgentProfile[] {
  return AGENT_TEMPLATES.slice(0, 3).map(agentFromTemplate);
}

export function agentMonogram(name: string): string {
  const ch = name.trim().charAt(0);
  return ch ? ch.toUpperCase() : "A";
}

const HUES: string[] = [
  "bg-ember/10 text-ember",
  "bg-emerald-600/10 text-emerald-700",
  "bg-gold/15 text-gold",
  "bg-sky-600/10 text-sky-700",
];

/** Stable accent classes for an agent's monogram avatar. */
export function agentHue(name: string): string {
  let hash = 0;
  for (const ch of name) {
    hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  }
  return HUES[hash % HUES.length];
}
