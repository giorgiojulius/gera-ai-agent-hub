// Client for /projects/* — team workspaces with scoped agents and
// Slack-style channels. Mirrors the worker's wire types; secrets never come
// back from the server (only set/unset flags).
import { FUNCTIONS_URL, authedFetch, parseOrThrow } from "@/lib/backend";
import { normalizeExecutionOutcome } from "@/lib/execution-outcome";
import type { ExecutionOutcome } from "@/lib/types";

export type ProjectRole = "owner" | "admin" | "member";

export type GithubAccessLevel = "off" | "read" | "write";

export type AgentAccess = {
  web: boolean;
  github: GithubAccessLevel;
  intercom: boolean;
  slack: boolean;
  /** Linked MCP servers — picked from a project admin's connected list. */
  mcp: boolean;
};

export type AgentSecretFlags = { github: boolean; intercom: boolean; slack: boolean; slackSigning: boolean };

/**
 * One linked MCP server as the client sees it — just a name chip. The ids
 * point into the linking admin's connected servers (the same list chat
 * uses); URLs, keys and sign-ins stay on that account server-side.
 */
export type AgentMcpServer = { id: string; name: string };

export const MAX_AGENT_MCP_SERVERS = 5;

export type ProjectAgent = {
  id: string;
  name: string;
  handle: string;
  emoji: string;
  instructions: string;
  model: string;
  access: AgentAccess;
  secretsSet: AgentSecretFlags;
  mcpServers?: AgentMcpServer[];
  /** Whose account the linked MCP servers resolve through ("" = none). */
  mcpOwner?: string;
  /** Set when the Slack app was created from Gera; `team` fills in on install. */
  slackApp?: { appId: string; team: string } | null;
  createdAt: number;
  updatedAt: number;
};

export type ProjectMember = {
  email: string;
  role: ProjectRole;
  name: string;
  addedAt: number;
};

export type ProjectChannel = {
  id: string;
  name: string;
  topic: string;
  createdAt: number;
  unread: number;
  lastAt: number;
};

export type ProjectMessage = {
  id: string;
  channelId: string;
  rootId: string | null;
  kind: "user" | "agent";
  author: string;
  authorName: string;
  body: string;
  pending: boolean;
  execution?: ExecutionOutcome;
  createdAt: number;
  updatedAt: number;
};

export type ThreadStat = { root: string; count: number; lastAt: number };

// --- Screens: admin-composed widget desks ------------------------------------

export type ScreenWidgetKind = "intercom-inbox" | "agent-chat" | "channel-post";

export type ScreenWidget = {
  id: string;
  kind: ScreenWidgetKind;
  agentId: string | null;
  channelId: string | null;
};

export type ProjectScreen = {
  id: string;
  name: string;
  emoji: string;
  widgets: ScreenWidget[];
  createdAt: number;
  updatedAt: number;
};

/** One row of my PRIVATE assistant chat on a screen (per member). */
export type ScreenChatMessage = {
  id: string;
  kind: "user" | "agent";
  authorName: string;
  body: string;
  pending: boolean;
  execution?: ExecutionOutcome;
  createdAt: number;
  updatedAt: number;
};

export type IntercomInboxItem = {
  id: string;
  state: string;
  author: string;
  email: string;
  snippet: string;
  createdAt: number;
  updatedAt: number;
  /** Money signal: the contact's biggest spend-looking attribute (server-derived). */
  spend?: number | null;
  /** 1 = top spender … 3 = pays anything; null/absent = no known spend. */
  tier?: number | null;
};

/**
 * Compact spend for tier badges — "980", "1.2k", "48k", "1.1M". No currency
 * sign on purpose: Intercom attributes don't say which currency they bill in.
 */
export function formatSpendCompact(spend: number): string {
  if (!Number.isFinite(spend) || spend <= 0) {
    return "";
  }
  if (spend >= 1_000_000) {
    const millions = spend / 1_000_000;
    return `${millions >= 10 ? Math.round(millions) : Math.round(millions * 10) / 10}M`;
  }
  if (spend >= 1_000) {
    const thousands = spend / 1_000;
    return `${thousands >= 10 ? Math.round(thousands) : Math.round(thousands * 10) / 10}k`;
  }
  return `${Math.round(spend)}`;
}

export type IntercomAttachment = {
  name: string;
  /** Signed Intercom CDN link — public but expiring; refreshed with each thread poll. */
  url: string;
  contentType: string;
  /** Bytes; 0 = unknown. */
  size: number;
};

/** "1.2 MB" / "340 KB" for the attachment chip; "" when the size is unknown. */
export function formatAttachmentBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "";
  }
  if (bytes < 1024) {
    return `${Math.trunc(bytes)} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb >= 10 ? Math.round(kb) : Math.round(kb * 10) / 10} KB`;
  }
  const mb = kb / 1024;
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

export type IntercomPart = {
  id: string;
  author: string;
  role: "customer" | "teammate" | "bot";
  note: boolean;
  body: string;
  createdAt: number;
  /** Optional — older worker payloads did not carry it. */
  attachments?: IntercomAttachment[];
};

export type IntercomThread = {
  id: string;
  state: string;
  author: string;
  email: string;
  parts: IntercomPart[];
};

export type IntercomAttr = { key: string; value: string };

export type IntercomEventRow = { name: string; at: number };

/** Inbox filter — Intercom's own inbox defaults to open conversations. */
export type IntercomInboxState = "open" | "closed" | "snoozed" | "all";

export type IntercomContactProfile = {
  id: string;
  name: string;
  email: string;
  phone: string;
  type: string;
  userId: string;
  owner: string;
  location: string;
  browser: string;
  browserVersion: string;
  os: string;
  language: string;
  signedUpAt: number;
  lastSeenAt: number;
  createdAt: number;
  companies: string[];
  attributes: IntercomAttr[];
  /** Plan / spend / scalar custom attributes of the attached companies. */
  companyAttrs: IntercomAttr[];
};

/** Intercom-style right panel: conversation meta + the full contact profile. */
export type IntercomConversationDetails = {
  id: string;
  state: string;
  priority: boolean;
  createdAt: number;
  updatedAt: number;
  waitingSince: number;
  snoozedUntil: number;
  channel: string;
  subject: string;
  assignee: string;
  teamInbox: string;
  tags: string[];
  attributes: IntercomAttr[];
  /** Recent Data-API events — the closest REST signal to "Recent page views". */
  events: IntercomEventRow[];
  /** Deep link into Intercom's inbox (empty when the workspace id is unknown). */
  intercomUrl: string;
  contact: IntercomContactProfile | null;
};

/** One first-party page view tracked by Gera's pv.js snippet on the customer's site. */
export type DeskPageView = { url: string; title: string; at: number };

/**
 * Details payload for the desk panel: Intercom data plus Gera's own page-view
 * tracking — Intercom's API keeps page views private, so Gera collects them.
 */
export type DeskConversationDetails = IntercomConversationDetails & {
  pageViews: DeskPageView[];
  /** True once an admin generated the project's tracking snippet. */
  tracking: boolean;
  viewerIsAdmin: boolean;
};

export type ScreenWidgetDraft = { kind: ScreenWidgetKind; agentId?: string; channelId?: string };

/** Project-level Slack app-manager connection status (tokens stay server-side). */
export type ProjectSlackConfig = { team: string; renews: boolean; connectedAt: number };

export type ProjectOverview = {
  project: { id: string; name: string; createdBy: string; createdAt: number };
  me: { email: string; role: ProjectRole };
  members: ProjectMember[];
  agents: ProjectAgent[];
  channels: ProjectChannel[];
  screens: ProjectScreen[];
  slackConfig?: ProjectSlackConfig | null;
};

export type ProjectListEntry = { id: string; name: string; role: ProjectRole };

export type MessagesPage = { messages: ProjectMessage[]; threads: ThreadStat[]; now: number };

export const PROJECT_MESSAGE_LIMIT = 8_000;

/** Secrets patch semantics: non-empty string replaces, "" keeps, null clears. */
export type AgentSecretsPatch = {
  githubToken?: string | null;
  /** Link the saving admin's account-owned GitHub grant; no token crosses the browser. */
  githubFromAccount?: boolean;
  intercomToken?: string | null;
  slackToken?: string | null;
  slackSigningSecret?: string | null;
  /** null disconnects the Gera-created Slack app (and forgets its signing secret + bot token). */
  slackApp?: null;
  /**
   * Full desired MCP link — ids + names picked from YOUR connected servers
   * (the same list chat and automations use); omit the field to keep the
   * stored link untouched, [] unlinks. Runs resolve the link through your
   * account server-side — keys and sign-ins never copy into the project.
   */
  mcpSelection?: AgentMcpServer[];
};

/** Public Slack Events API URL for one agent — pasted into the Slack app config. */
export function slackEventsUrl(projectId: string, agentId: string): string {
  return `${FUNCTIONS_URL}/slack/events/${projectId}/${agentId}`;
}

export type SlackAppCreateResult = {
  agent: ProjectAgent | null;
  installUrl?: string;
  warning?: string;
};

/**
 * Creates a real Slack app for the agent via Slack's manifest API — scopes,
 * events URL and signing secret are configured server-side. Uses the stored
 * project-level app-manager connection; a pasted token is optional.
 */
export async function createAgentSlackApp(
  projectId: string,
  agentId: string,
  configToken?: string,
): Promise<SlackAppCreateResult> {
  const response = await authedFetch(`/projects/${projectId}/agents/slack-create-app`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(configToken ? { agentId, configToken } : { agentId }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(body.message ?? body.error ?? `Could not create the Slack app (${response.status})`);
  }
  return (await response.json()) as SlackAppCreateResult;
}

/** Fresh OAuth install link for the agent's Gera-created Slack app. */
export async function fetchAgentSlackInstallUrl(projectId: string, agentId: string): Promise<string> {
  const response = await authedFetch(`/projects/${projectId}/agents/slack-install-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId }),
  });
  const data = await parseOrThrow<{ url?: string }>(response, "Could not get the install link");
  if (!data.url) {
    throw new Error("Could not get the install link");
  }
  return data.url;
}

/**
 * Connects (token) or disconnects (null) the project-level Slack app manager.
 * Paste the refresh token once — the server stores the pair and rotates it
 * automatically, so creating Slack bots stops asking for tokens.
 */
export async function saveProjectSlackConfig(
  projectId: string,
  token: string | null,
): Promise<ProjectSlackConfig | null> {
  const response = await authedFetch(`/projects/${projectId}/slack-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const data = await parseOrThrow<{ slackConfig?: ProjectSlackConfig | null }>(
    response,
    "Could not update the Slack connection",
  );
  return data.slackConfig ?? null;
}

export type AgentUpsertPayload = {
  id?: string;
  name: string;
  handle?: string;
  emoji?: string;
  instructions?: string;
  model?: string;
  access: AgentAccess;
  secrets?: AgentSecretsPatch;
};

export async function listProjects(): Promise<ProjectListEntry[]> {
  const response = await authedFetch("/projects");
  const data = await parseOrThrow<{ projects?: ProjectListEntry[] }>(response, "Could not load projects");
  return data.projects ?? [];
}

export async function createProject(name: string, ownerName: string): Promise<{ id: string; name: string }> {
  const response = await authedFetch("/projects/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, ownerName }),
  });
  return parseOrThrow(response, "Could not create the project");
}

export async function fetchProjectOverview(projectId: string): Promise<ProjectOverview> {
  const response = await authedFetch(`/projects/${projectId}/overview`);
  return parseOrThrow(response, "Could not load the project");
}

export async function fetchProjectMessages(
  projectId: string,
  channelId: string,
  options?: { since?: number; root?: string },
): Promise<MessagesPage> {
  const params = new URLSearchParams({ channel: channelId });
  if (options?.since && options.since > 0) {
    params.set("since", String(Math.floor(options.since)));
  }
  if (options?.root) {
    params.set("root", options.root);
  }
  const response = await authedFetch(`/projects/${projectId}/messages?${params.toString()}`);
  const page = await parseOrThrow<MessagesPage>(response, "Could not load messages");
  return {
    ...page,
    messages: page.messages.map((message) => ({
      ...message,
      execution: normalizeExecutionOutcome(message.execution),
    })),
  };
}

export async function postProjectMessage(
  projectId: string,
  payload: { channelId: string; rootId?: string; body: string },
): Promise<{ ok: boolean; id: string; rootId: string | null; jobs: string[] }> {
  const response = await authedFetch(`/projects/${projectId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return parseOrThrow(response, "Could not send the message");
}

export async function markProjectChannelRead(
  projectId: string,
  channelId: string,
  at: number,
): Promise<void> {
  await authedFetch(`/projects/${projectId}/read`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channelId, at }),
  }).catch(() => undefined);
}

export async function createProjectChannel(
  projectId: string,
  name: string,
  topic: string,
): Promise<{ id: string; name: string }> {
  const response = await authedFetch(`/projects/${projectId}/channels/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, topic }),
  });
  return parseOrThrow(response, "Could not create the channel");
}

export async function addProjectMember(
  projectId: string,
  email: string,
  role: "admin" | "member",
): Promise<{ email: string; role: ProjectRole; invited?: boolean }> {
  const response = await authedFetch(`/projects/${projectId}/members/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
  return parseOrThrow(response, "Could not add the member");
}

export async function removeProjectMember(projectId: string, email: string): Promise<void> {
  const response = await authedFetch(`/projects/${projectId}/members/remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  await parseOrThrow(response, "Could not remove the member");
}

export async function setProjectMemberRole(
  projectId: string,
  email: string,
  role: "admin" | "member",
): Promise<void> {
  const response = await authedFetch(`/projects/${projectId}/members/role`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
  await parseOrThrow(response, "Could not change the role");
}

export async function upsertProjectAgent(
  projectId: string,
  payload: AgentUpsertPayload,
): Promise<ProjectAgent> {
  const response = await authedFetch(`/projects/${projectId}/agents/upsert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await parseOrThrow<{ agent: ProjectAgent }>(response, "Could not save the agent");
  return data.agent;
}

export async function deleteProjectAgent(projectId: string, agentId: string): Promise<void> {
  const response = await authedFetch(`/projects/${projectId}/agents/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: agentId }),
  });
  await parseOrThrow(response, "Could not delete the agent");
}

export async function renameProject(projectId: string, name: string): Promise<void> {
  const response = await authedFetch(`/projects/${projectId}/project/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  await parseOrThrow(response, "Could not rename the project");
}

export async function deleteProject(projectId: string): Promise<void> {
  const response = await authedFetch(`/projects/${projectId}/project/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  await parseOrThrow(response, "Could not delete the project");
}

export async function upsertProjectScreen(
  projectId: string,
  payload: { id?: string; name: string; emoji?: string; widgets: ScreenWidgetDraft[] },
): Promise<ProjectScreen> {
  const response = await authedFetch(`/projects/${projectId}/screens/upsert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await parseOrThrow<{ screen: ProjectScreen }>(response, "Could not save the screen");
  return data.screen;
}

export async function deleteProjectScreen(projectId: string, screenId: string): Promise<void> {
  const response = await authedFetch(`/projects/${projectId}/screens/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: screenId }),
  });
  await parseOrThrow(response, "Could not delete the screen");
}

export async function fetchScreenInbox(
  projectId: string,
  screenId: string,
  state: IntercomInboxState = "open",
): Promise<IntercomInboxItem[]> {
  const response = await authedFetch(`/projects/${projectId}/intercom/inbox`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ screenId, state }),
  });
  const data = await parseOrThrow<{ conversations?: IntercomInboxItem[] }>(
    response,
    "Could not load the inbox",
  );
  return data.conversations ?? [];
}

export async function fetchScreenThread(
  projectId: string,
  screenId: string,
  conversationId: string,
): Promise<IntercomThread> {
  const response = await authedFetch(`/projects/${projectId}/intercom/thread`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ screenId, conversationId }),
  });
  const data = await parseOrThrow<{ thread: IntercomThread }>(response, "Could not load the conversation");
  return data.thread;
}

export async function fetchScreenConversationDetails(
  projectId: string,
  screenId: string,
  conversationId: string,
): Promise<DeskConversationDetails> {
  const response = await authedFetch(`/projects/${projectId}/intercom/details`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ screenId, conversationId }),
  });
  const data = await parseOrThrow<{
    details: IntercomConversationDetails;
    pageViews?: DeskPageView[];
    tracking?: boolean;
    viewerIsAdmin?: boolean;
  }>(response, "Could not load conversation details");
  return {
    ...data.details,
    pageViews: data.pageViews ?? [],
    tracking: data.tracking === true,
    viewerIsAdmin: data.viewerIsAdmin === true,
  };
}

/** Admin-only: creates (once) and returns the project's page-view beacon key. */
export async function setupDeskTracking(projectId: string): Promise<{ key: string }> {
  const response = await authedFetch(`/projects/${projectId}/tracking/setup`, { method: "POST" });
  return parseOrThrow(response, "Could not set up page-view tracking");
}

/** Copy-paste snippet for the customer's site — powers "Recent page views". */
export function deskTrackerSnippet(projectId: string, key: string): string {
  return `<script async src="${FUNCTIONS_URL}/pv.js" data-endpoint="${FUNCTIONS_URL}/pv/${projectId}" data-key="${key}"></script>`;
}

export async function sendScreenIntercomReply(
  projectId: string,
  payload: {
    screenId: string;
    conversationId: string;
    body: string;
    note: boolean;
    /** Teammates tagged via @ in a note — become real Intercom mention links. */
    mentions?: Array<{ id: string; name: string }>;
  },
): Promise<{ admin: string }> {
  const response = await authedFetch(`/projects/${projectId}/intercom/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return parseOrThrow(response, "Could not send to Intercom");
}

export type DeskMentionAdmin = { id: string; name: string; email: string };

/** Intercom teammates available for @-mentions in internal notes. */
export async function fetchScreenMentionAdmins(projectId: string, screenId: string): Promise<DeskMentionAdmin[]> {
  const response = await authedFetch(`/projects/${projectId}/intercom/mention-admins`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ screenId }),
  });
  const data = await parseOrThrow<{ admins?: DeskMentionAdmin[] }>(response, "Could not load teammates to mention");
  return data.admins ?? [];
}

export async function fetchScreenChat(
  projectId: string,
  screenId: string,
  widgetId: string,
): Promise<ScreenChatMessage[]> {
  const params = new URLSearchParams({ screen: screenId, widget: widgetId });
  const response = await authedFetch(`/projects/${projectId}/screen-chat?${params.toString()}`);
  const data = await parseOrThrow<{ messages?: ScreenChatMessage[] }>(
    response,
    "Could not load the assistant chat",
  );
  return (data.messages ?? []).map((message) => ({
    ...message,
    execution: normalizeExecutionOutcome(message.execution),
  }));
}

export async function sendScreenChatMessage(
  projectId: string,
  payload: { screenId: string; widgetId: string; body: string; conversationId?: string },
): Promise<{ ok: boolean; id: string; jobs: string[] }> {
  const response = await authedFetch(`/projects/${projectId}/screen-chat/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return parseOrThrow(response, "Could not message the assistant");
}

// --- Desk intelligence ---------------------------------------------------------
// Reply suggestions (calibrated by 👍/👎), snooze/close actions, "Ask Gera"
// research runs, and team-performance stats with grades + coaching.

export type DeskSuggestion = { id: string; text: string };

export type DeskInvestigation = {
  /** "in_progress" = the team's Slack thread is still open — wait, don't invent. */
  status: "in_progress" | "answered";
  summary: string;
};

export type DeskSuggestPayload = {
  suggestions: DeskSuggestion[];
  action: "reply" | "snooze" | "close";
  actionReason: string;
  /** Non-empty when the customer asks how the product works — feeds "Ask Gera". */
  functionalityQuestion: string;
  /** Set when the team's Slack already covers this case. */
  investigation?: DeskInvestigation | null;
  /** Seconds — the latest Slack activity these drafts were generated against. */
  slackLastTs?: number;
  generatedAt: number;
  cached?: boolean;
};

export type DeskSlackLine = { author: string; text: string; ts: string };

export type DeskSlackThread = {
  channelId: string;
  channelName: string;
  rootTs: string;
  permalink: string;
  matchedBy: "conversation" | "email" | "name";
  /** Seconds — the thread's latest activity. */
  lastActivityTs: number;
  /** Activity within the last hour — reads as a live investigation. */
  active: boolean;
  replyCount: number;
  lines: DeskSlackLine[];
};

export type DeskSlackRelated = {
  /** null = this screen has no working Slack agent; `reason` says why. */
  slack: {
    team: string;
    channels: Array<{ id: string; name: string }>;
    related: DeskSlackThread[];
    syncedAt: number;
  } | null;
  reason?: string;
  now: number;
};

export type DeskAskStatus = {
  /** The latest "Ask Gera" research on this conversation — shared with the team. */
  ask: {
    status: "running" | "done" | "error";
    question: string;
    answer: string;
    execution?: ExecutionOutcome;
    by: string;
    at: number;
  } | null;
};

export type DeskGradedExample = {
  customer: string;
  reply: string;
  grade: string;
  reason: string;
  at: number;
  responseMs: number;
};

export type DeskTeammate = {
  adminId: string;
  name: string;
  /** Gera member email this Intercom admin is linked to ("" = not linked). */
  linkedEmail: string;
  replies: number;
  conversations: number;
  responseSamples: number;
  medianResponseMs: number;
  p90ResponseMs: number;
  withinOneHour: number;
  good: number;
  bad: number;
  ungraded: number;
  firstAt: number;
  lastAt: number;
  coaching: string;
  examples: DeskGradedExample[];
};

export type DeskStatsRange = { from: number; to: number };

export type DeskStats = {
  isAdmin: boolean;
  teammates: DeskTeammate[];
  totalReplies: number;
  conversations: number;
  gradedReplies: number;
  badReplies: number;
  responseSamples: number;
  withinOneHour: number;
  p90ResponseMs: number;
  ungraded: number;
  range: DeskStatsRange;
  coverage: {
    scannedConversations: number;
    analyzedConversations: number;
    from: number;
    to: number;
    collectedAt: number;
    limitReached: boolean;
  } | null;
  members?: Array<{ email: string; name: string }>;
  intercomAdmins?: Array<{ id: string; name: string; email: string }>;
  collected?: number;
  added?: number;
  /** Replies graded during the latest explicit analysis pass. */
  graded?: number;
  scannedConversations?: number;
  analyzedConversations?: number;
  limitReached?: boolean;
  gradeError?: string;
  now: number;
};

export async function fetchScreenSuggestions(
  projectId: string,
  payload: { screenId: string; conversationId: string; force?: boolean },
): Promise<DeskSuggestPayload> {
  const response = await authedFetch(`/projects/${projectId}/intercom/suggest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return parseOrThrow(response, "Could not draft suggestions");
}

export async function rateScreenSuggestion(
  projectId: string,
  payload: { screenId: string; suggestionId: string; verdict: "up" | "down" },
): Promise<void> {
  const response = await authedFetch(`/projects/${projectId}/intercom/suggest/rate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await parseOrThrow(response, "Could not save the rating");
}

export async function actOnScreenConversation(
  projectId: string,
  payload: { screenId: string; conversationId: string; action: "snooze" | "close" },
): Promise<{ ok: boolean; state: string; admin: string }> {
  const response = await authedFetch(`/projects/${projectId}/intercom/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return parseOrThrow(response, "Could not update the conversation");
}

export async function askGeraFromScreen(
  projectId: string,
  payload: { screenId: string; widgetId: string; question: string; conversationId?: string },
): Promise<{ ok: boolean; jobs: string[]; alreadyRunning?: boolean }> {
  const response = await authedFetch(`/projects/${projectId}/intercom/ask-gera`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return parseOrThrow(response, "Could not start the research");
}

/** Slack discussions that reference one open conversation (live tails). */
export async function fetchDeskSlackRelated(
  projectId: string,
  payload: { screenId: string; conversationId: string },
): Promise<DeskSlackRelated> {
  const response = await authedFetch(`/projects/${projectId}/intercom/slack-related`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return parseOrThrow(response, "Could not check Slack");
}

/** The latest "Ask Gera" investigation on one conversation (any member's). */
export async function fetchDeskAskStatus(
  projectId: string,
  payload: { screenId: string; conversationId: string },
): Promise<DeskAskStatus> {
  const response = await authedFetch(`/projects/${projectId}/intercom/ask-status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const status = await parseOrThrow<DeskAskStatus>(response, "Could not check the investigation");
  return status.ask
    ? { ...status, ask: { ...status.ask, execution: normalizeExecutionOutcome(status.ask.execution) } }
    : status;
}

export async function fetchDeskStats(
  projectId: string,
  screenId: string,
  range: DeskStatsRange = { from: 0, to: 0 },
): Promise<DeskStats> {
  const response = await authedFetch(`/projects/${projectId}/intercom/stats`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ screenId, ...range }),
  });
  return parseOrThrow(response, "Could not load team performance");
}

export async function refreshDeskStats(
  projectId: string,
  screenId: string,
  range: DeskStatsRange = { from: 0, to: 0 },
): Promise<DeskStats> {
  const response = await authedFetch(`/projects/${projectId}/intercom/stats/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ screenId, ...range }),
  });
  return parseOrThrow(response, "Could not collect team stats");
}

/** Permanently clears harvested replies, grades and coaching for one desk. */
export async function clearDeskStats(
  projectId: string,
  screenId: string,
  range: DeskStatsRange = { from: 0, to: 0 },
): Promise<DeskStats> {
  const response = await authedFetch(`/projects/${projectId}/intercom/stats/clear`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ screenId, ...range }),
  });
  return parseOrThrow(response, "Could not clear team performance");
}

export async function linkDeskTeammate(
  projectId: string,
  payload: { adminId: string; email: string; adminName?: string; adminEmail?: string },
): Promise<void> {
  const response = await authedFetch(`/projects/${projectId}/intercom/stats/link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await parseOrThrow(response, "Could not update the link");
}

/** Short human label for what one agent may touch — shown on cards. */
export function accessSummary(agent: ProjectAgent): string[] {
  const chips: string[] = [];
  if (agent.access.web) {
    chips.push("Web");
  }
  if (agent.access.github === "read") {
    chips.push(agent.secretsSet.github ? "GitHub · read-only" : "GitHub · no token");
  } else if (agent.access.github === "write") {
    chips.push(agent.secretsSet.github ? "GitHub · full" : "GitHub · no token");
  }
  if (agent.access.intercom) {
    chips.push(agent.secretsSet.intercom ? "Intercom" : "Intercom · no token");
  }
  if (agent.access.slack) {
    const team = agent.slackApp?.team ?? "";
    chips.push(agent.secretsSet.slack ? (team ? `Slack · ${team}` : "Slack") : "Slack · no token");
    if (agent.secretsSet.slack && agent.secretsSet.slackSigning) {
      chips.push("@mentionable in Slack");
    }
  }
  if (agent.access.mcp) {
    const servers = agent.mcpServers ?? [];
    if (servers.length === 0) {
      chips.push("MCP · no servers");
    } else {
      for (const server of servers) {
        chips.push(`MCP · ${server.name}`);
      }
    }
  }
  if (chips.length === 0) {
    chips.push("Chat only");
  }
  return chips;
}
