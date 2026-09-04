// The agent context contract — the full surface AgentProvider exposes to the
// app. Split out of use-agent.tsx so the provider file holds behavior, not a
// 75-line type. use-agent.tsx re-exports useAgent, so importers are unchanged.
import { createContext, useContext } from "react";

import type { AgentState } from "@/lib/agent-store";
import type { AutomationDraftInput } from "@/lib/automations";
import type {
  AgentProfile,
  AgentSettings,
  Attachment,
  Automation,
  Conversation,
  CreateMode,
  GatewayModel,
  LifeState,
  McpServerConfig,
  RepoPreviewJob,
} from "@/lib/types";

export type AgentDraftInput = Omit<AgentProfile, "id" | "createdAt">;

export type AgentContextValue = {
  state: AgentState;
  models: GatewayModel[];
  modelsLoading: boolean;
  active: Conversation | null;
  activeModel: GatewayModel | undefined;
  mode: CreateMode;
  setMode: (mode: CreateMode) => void;
  patchSettings: (patch: Partial<AgentSettings>) => void;
  agents: AgentProfile[];
  activeAgent: AgentProfile | undefined;
  newChat: (options?: { incognito?: boolean }) => void;
  newChatWithAgent: (agentId: string) => void;
  setChatAgent: (agentId: string | null) => void;
  /** Pins/unpins a GitHub repository ("owner/repo") on the active thread — runs default their GitHub tools to it. */
  setChatRepo: (repo: string | null) => void;
  /** Appends a durable repository launch receipt to its originating thread. */
  recordRepoPreview: (job: RepoPreviewJob, conversationId?: string) => void;
  /** Persists phase changes without syncing private preview URLs or build logs. */
  updateRepoPreview: (job: RepoPreviewJob) => void;
  createAgent: (input: AgentDraftInput) => string;
  updateAgent: (id: string, patch: Partial<AgentDraftInput>) => void;
  deleteAgent: (id: string) => void;
  automations: Automation[];
  createAutomation: (input: AutomationDraftInput) => string;
  updateAutomation: (id: string, patch: Partial<AutomationDraftInput>) => void;
  deleteAutomation: (id: string) => void;
  runAutomationNow: (id: string) => void;
  life: LifeState;
  updateLife: (updater: (prev: LifeState) => LifeState) => void;
  selectChat: (id: string) => void;
  deleteChat: (id: string) => void;
  renameChat: (id: string, title: string) => void;
  /** Pins/unpins a thread in the sidebar's Pinned section. */
  togglePinChat: (id: string) => void;
  /** Marks a thread unread — shows the ember dot in the sidebar until it's opened again. */
  markUnreadChat: (id: string) => void;
  setInput: (value: string) => void;
  addAttachments: (files: File[], options?: { replace?: boolean }) => Promise<void>;
  /** Attaches ready records (MCP resources read through the account shard, prompt images). */
  addAttachmentRecords: (records: Attachment[]) => void;
  removeAttachment: (id: string) => void;
  send: () => void;
  /** Edits a sent user message: truncates the thread there and resends. */
  editMessage: (messageId: string, newText: string) => void;
  /** Continues a reply that a reload cut mid-stream (partial text kept). */
  resumeInterrupted: (messageId: string) => void;
  /** Re-runs a turn that a reload killed before anything arrived. */
  retryInterrupted: (messageId: string) => void;
  stop: () => void;
  /** Queues the composer as a follow-up; steer injects it into the live run without interrupting. */
  queueMessage: (options?: { steer?: boolean; interrupt?: boolean }) => void;
  /** Removes a queued follow-up from the active thread. */
  removeQueued: (id: string) => void;
  /** Drag-and-drop reorder: the dragged queued follow-up takes the target's position. */
  reorderQueued: (fromId: string, toId: string) => void;
  /** Fires a queued follow-up now: steered into the live run when possible, else interrupts. */
  sendQueuedNow: (id: string) => void;
  toggleDeepResearch: () => void;
  /** Toggles Julius panel mode (mutually exclusive with deep research). */
  toggleJulius: () => void;
  /** Picks (or overrides) the winning candidate of a Julius panel message. */
  chooseJuliusWinner: (messageId: string, candidateIndex: number) => void;
  setModelId: (id: string) => void;
  setSystemPrompt: (value: string) => void;
  setAutoTools: (enabled: boolean) => void;
  toggleBuiltin: (id: keyof AgentSettings["builtinTools"]) => void;
  setSidebarOpen: (open: boolean) => void;
  updateMcp: (id: string, patch: Partial<McpServerConfig>) => void;
  addMcp: () => void;
  addCatalogMcpServer: (catalogId: string) => void;
  connectCatalog: (catalogId: string) => void;
  addCustomMcp: (input: {
    name: string;
    url: string;
    token?: string;
    headersJson?: string;
    authMode?: McpServerConfig["authMode"];
  }) => void;
  removeMcp: (id: string) => void;
  connectMcp: (id: string) => void;
  /** Forces the OAuth popup even for a connected server (step-up: wider scopes). */
  signInMcp: (id: string) => void;
  toggleMcpTool: (serverId: string, toolName: string) => void;
};

export const AgentContext = createContext<AgentContextValue | null>(null);

export function useAgent(): AgentContextValue {
  const ctx = useContext(AgentContext);
  if (!ctx) {
    throw new Error("useAgent must be used within AgentProvider");
  }
  return ctx;
}
