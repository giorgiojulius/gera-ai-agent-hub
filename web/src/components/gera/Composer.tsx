import {
  ArrowDownToLine,
  ArrowUp,
  AudioLines,
  Check,
  ChevronDown,
  ChevronsUpDown,
  Clapperboard,
  Cloud,
  Compass,
  FileText,
  Github,
  Globe,
  GripVertical,
  ImageIcon,
  Landmark,
  Link2,
  ListEnd,
  MessageSquare,
  Paperclip,
  Play,
  Plug,
  Plus,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  Telescope,
  Wrench,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { useAutoGrow } from "@/hooks/use-autogrow";
import { useIsMobile } from "@/hooks/use-mobile";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import {
  ComposerMcpMenuPanel,
  McpArgsDialog,
  resourceToken,
  useComposerMcpMenu,
  type ComposerMcpItem,
  type McpArgsField,
} from "@/components/gera/ComposerMcpMenu";
import { ModelPicker } from "@/components/gera/ModelPicker";
import { RepoLaunchDialog } from "@/components/gera/RepoLaunchDialog";
import { MediaImg } from "@/components/gera/VaultMedia";
import { useAgent } from "@/hooks/use-agent";
import { agentHue, agentMonogram } from "@/lib/agents";
import { RESEARCH_PROFILES } from "@/lib/deep-research";
import { composerAccept, filterDroppedFiles } from "@/lib/composer-drop";
import { errorFromUnknown } from "@/lib/errors";
import {
  githubAuthorizationFingerprint,
  listRepoOptions,
  resolveGitHubAuth,
  type RepoOption,
} from "@/lib/github-native";
import { RepoAccessCheck } from "./RepoAccessCheck";
import { JULIUS_MAX_CANDIDATES, JULIUS_MIN_CANDIDATES, juliusLetter } from "@/lib/julius";
import { serverIconUrl } from "@/lib/mcp-catalog";
import {
  expandUriTemplate,
  getMcpPrompt,
  promptImagesToAttachments,
  promptMessagesToText,
  readMcpResource,
  replaceComposerToken,
  resourceContentsToAttachments,
  uriTemplateVariables,
  type ComposerMenuTrigger,
} from "@/lib/mcp-inventory";
import { cloudRunPhase, cloudRunsVersion, subscribeCloudRuns } from "@/lib/server-run";
import { SKILL_SURFACE_LABEL, groupSkillsByFolder, setFolderSurface, setSkillSurface } from "@/lib/skills";
import { isSteerableRun } from "@/lib/steering";
import {
  composerPlaceholder,
  findModel,
  MODE_MODEL_IDS,
  modelIdForMode,
  modelShortName,
  modelsForMode,
  parseModelSelection,
  videoModelTakesLocalFiles,
  voicesForModel,
} from "@/lib/models";
import { runModeOptionTid, TID } from "@/lib/testids";
import type { BuiltinToolId, CreateMode, ImageSize, JuliusSettings, McpServerConfig, ResearchDepth, SkillSurface, VideoAspect } from "@/lib/types";
import { cn } from "@/lib/utils";
import { connectorCacheKey, subscribeConnectorCaches } from "@/lib/connector-cache-scope";

const MODES: { id: CreateMode; label: string; icon: typeof MessageSquare }[] = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "image", label: "Image", icon: ImageIcon },
  { id: "video", label: "Video", icon: Clapperboard },
  { id: "audio", label: "Audio", icon: AudioLines },
];

const IMAGE_SIZES: { value: ImageSize; label: string }[] = [
  { value: "1024x1024", label: "Square" },
  { value: "1536x1024", label: "Wide" },
  { value: "1024x1536", label: "Tall" },
];

/** Variations per image prompt — typing an explicit count in the prompt overrides the chip. */
const IMAGE_COUNTS: number[] = [1, 2, 3, 4];

const VIDEO_ASPECTS: { value: VideoAspect; label: string }[] = [
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
  { value: "1:1", label: "1:1" },
];

const TOOL_MENU: { id: BuiltinToolId; label: string; hint: string; icon: typeof Globe }[] = [
  { id: "web_search", label: "Web search", hint: "Exa live results", icon: Globe },
  { id: "fetch_url", label: "Fetch URL", hint: "Read any page", icon: Link2 },
  { id: "selfsurf", label: "SelfSurf", hint: "Agentic browsing", icon: Compass },
  { id: "generate_image", label: "Images", hint: "GPT Image 2", icon: ImageIcon },
  { id: "generate_video", label: "Video", hint: "Seedance 2.5", icon: Clapperboard },
  { id: "generate_audio", label: "Audio", hint: "Grok TTS", icon: AudioLines },
];

/** Touch keyboards have no Shift+Enter — there Enter makes a new line and the send button sends. */
function hasTouchKeyboard(): boolean {
  return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

export function Composer({ variant = "docked" }: { variant?: "docked" | "hero" }) {
  const {
    state,
    active,
    activeAgent,
    setChatAgent,
    newChatWithAgent,
    setInput,
    send,
    stop,
    queueMessage,
    removeQueued,
    reorderQueued,
    sendQueuedNow,
    addAttachments,
    addAttachmentRecords,
    removeAttachment,
    mode,
    setMode,
    patchSettings,
  } = useAgent();
  const fileRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();
  // The prompt box grows line by line (animated by the height-transition
  // class) and only scrolls past its cap — long prompts stay reviewable.
  const inputMaxHeight = variant === "hero" ? (isMobile ? 224 : 320) : isMobile ? 192 : 256;
  const inputRef = useAutoGrow(state.input, inputMaxHeight);
  // The auto-grow hook hands out a callback ref; the MCP menus also need the
  // node itself to restore focus and caret after a token replacement.
  const textareaNode = useRef<HTMLTextAreaElement | null>(null);
  const attachTextarea = useCallback(
    (node: HTMLTextAreaElement | null) => {
      textareaNode.current = node;
      inputRef(node);
    },
    [inputRef],
  );

  const settings = state.settings;
  const isChat = mode === "chat";
  // Image mode edits attached images; video mode animates one — but only
  // when the picked video model takes local files (Seedance is link-only,
  // Wan has no image input). Audio takes none.
  const videoTakesFiles = videoModelTakesLocalFiles(modelIdForMode(settings, "video"));
  const canAttach = isChat || mode === "image" || (mode === "video" && videoTakesFiles);
  const hasImageAttachment = state.attachments.some((file) => file.mime.startsWith("image/"));
  const voices = mode === "audio" ? voicesForModel(settings.audioModelId) : [];
  const voiceValue = voices.includes(settings.audioVoice) ? settings.audioVoice : voices[0] ?? "";
  const canSend = isChat ? Boolean(state.input.trim()) || state.attachments.length > 0 : Boolean(state.input.trim());
  const activeRunning = state.activeId ? state.runningIds.includes(state.activeId) : false;
  const queuedItems = state.activeId ? state.queued[state.activeId] ?? [] : [];
  // Live agent loops absorb steering mid-run; research/Julius/media runs don't.
  // Streaming re-renders keep this fresh without extra reactive plumbing.
  const steerable = activeRunning && isSteerableRun(state.activeId);
  // Honest cloud indicator: the run executes on the server; this shows the
  // live-channel state (stream / snapshot polling / reconnecting).
  useSyncExternalStore(subscribeCloudRuns, cloudRunsVersion);
  const cloudPhase = activeRunning ? cloudRunPhase(state.activeId) : null;
  const navigate = useNavigate();

  // One-tap profile monograms at the hero composer's top right (Settings →
  // Shortcuts). Hidden in incognito — profile threads are regular saved chats.
  const showProfileRow =
    variant === "hero" && settings.composerProfiles && active?.incognito !== true && settings.agents.length > 0;
  const profileRow = showProfileRow ? settings.agents.slice(0, 3) : [];
  const profileOverflow = showProfileRow ? Math.max(0, settings.agents.length - 3) : 0;

  // Drag-and-drop reorder of queued follow-ups (Cursor 2.4 style). Pointer
  // events cover mouse and touch alike; rows swap live as the pointer crosses
  // a neighbour's band, so dropping is just releasing. Row elements keep their
  // identity (keyed by id), so pointer capture survives the reorder.
  const [dragId, setDragId] = useState<string | null>(null);
  const queueRowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const startQueueDrag = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    // Keep the gesture on the handle: no text selection, no touch scroll.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragId(id);
  };

  const moveQueueDrag = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (dragId !== id) {
      return;
    }
    for (const other of queuedItems) {
      if (other.id === id) {
        continue;
      }
      const row = queueRowRefs.current.get(other.id);
      if (!row) {
        continue;
      }
      const rect = row.getBoundingClientRect();
      if (event.clientY >= rect.top && event.clientY <= rect.bottom) {
        // Entering a neighbour's band swaps positions — stable for uniform
        // row heights: the pointer lands inside the dragged row's new band.
        reorderQueued(id, other.id);
        break;
      }
    }
  };

  const endQueueDrag = () => setDragId(null);

  // Drag-and-drop attach: dropping files anywhere on the prompt card attaches
  // them with the same accept rules as the paperclip. Depth counting keeps the
  // overlay steady while the pointer crosses the card's children.
  const [dropActive, setDropActive] = useState<boolean>(false);
  const dropDepthRef = useRef<number>(0);
  const dropAccept = canAttach ? composerAccept(mode, videoTakesFiles) : null;

  const dragHasFiles = (event: ReactDragEvent<HTMLDivElement>): boolean =>
    [...(event.dataTransfer?.types ?? [])].includes("Files");

  const onDropZoneEnter = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!dropAccept || !dragHasFiles(event)) {
      return;
    }
    event.preventDefault();
    dropDepthRef.current += 1;
    setDropActive(true);
  };

  const onDropZoneOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!dropAccept || !dragHasFiles(event)) {
      return;
    }
    // preventDefault marks the card as a valid drop target (otherwise the
    // browser navigates to the file on drop).
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const onDropZoneLeave = () => {
    if (dropDepthRef.current === 0) {
      return;
    }
    dropDepthRef.current -= 1;
    if (dropDepthRef.current <= 0) {
      dropDepthRef.current = 0;
      setDropActive(false);
    }
  };

  const onDropZoneDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!dropAccept) {
      return;
    }
    event.preventDefault();
    dropDepthRef.current = 0;
    setDropActive(false);
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length === 0) {
      return;
    }
    const accepted = filterDroppedFiles(files, dropAccept);
    if (accepted.length === 0) {
      toast.error(
        isChat
          ? "Those files aren't supported — images, PDF, Office and text files work"
          : "Drop an image file",
      );
      return;
    }
    // Video animates exactly one image — a new drop replaces the old one.
    void addAttachments(mode === "video" ? accepted.slice(0, 1) : accepted, {
      replace: mode === "video",
    });
  };

  // Mobile placeholders drop desktop-only shortcut hints and stay short enough
  // for a one-line textarea on a narrow screen. Desktop strings are unchanged.
  const placeholder = ((): string => {
    if (activeRunning) {
      if (steerable) {
        return isMobile
          ? "Steer the run or queue a follow-up…"
          : "Steer the run — Ctrl/⌘ Enter steers · Enter queues";
      }
      return isMobile ? "Queue a follow-up…" : "Queue a follow-up — Enter queues";
    }
    if (isChat && state.deepResearch && state.julius) {
      return isMobile
        ? "Deep research + Julius council"
        : "Deep research + Julius — every candidate researches; the council distills one final report";
    }
    if (isChat && state.deepResearch) {
      return isMobile
        ? "What should I research in depth?"
        : "What should I research in depth? I'll search in waves and write a cited report";
    }
    if (isChat && state.julius) {
      if (settings.julius.candidateModelIds.length === 1) {
        return isMobile
          ? "Ask — the council checks quality"
          : "Ask — one model answers, then the council checks the quality";
      }
      return isMobile
        ? `Ask the panel — ${settings.julius.candidateModelIds.length} models compete`
        : `Ask the panel — ${settings.julius.candidateModelIds.length} models answer in parallel, then the winner is picked`;
    }
    if (mode === "image" && hasImageAttachment) {
      return "Describe how to edit or restyle the attached image…";
    }
    if (mode === "video" && videoTakesFiles && hasImageAttachment) {
      return "Describe how the attached image should move…";
    }
    return composerPlaceholder(mode);
  })();

  // MCP prompt (`/`) and resource (`@`) menus. The caret position decides
  // which token is being typed; selections replace that token and, for
  // resources, attach what the account shard read.
  const [caret, setCaret] = useState<number>(0);
  const [mcpBusy, setMcpBusy] = useState<boolean>(false);
  const [mcpArgs, setMcpArgs] = useState<{ item: ComposerMcpItem; trigger: ComposerMenuTrigger; fields: McpArgsField[] } | null>(null);

  const applyToken = useCallback(
    (trigger: ComposerMenuTrigger, replacement: string) => {
      const next = replaceComposerToken(state.input, trigger, replacement);
      setInput(next.value);
      setCaret(next.caret);
      window.requestAnimationFrame(() => {
        const node = textareaNode.current;
        if (node) {
          node.focus();
          node.setSelectionRange(next.caret, next.caret);
        }
      });
    },
    [setInput, state.input],
  );

  const runPrompt = useCallback(
    async (item: Extract<ComposerMcpItem, { kind: "prompt" }>, trigger: ComposerMenuTrigger, args: Record<string, string>) => {
      setMcpBusy(true);
      try {
        const result = await getMcpPrompt(item.server.id, item.prompt.name, args);
        const text = promptMessagesToText(result);
        applyToken(trigger, text);
        addAttachmentRecords(promptImagesToAttachments(result, `${item.server.name}-${item.prompt.name}`));
        setMcpArgs(null);
      } catch (error) {
        toast.error(`Prompt “${item.prompt.name}” failed`, { description: errorFromUnknown(error) });
      } finally {
        setMcpBusy(false);
      }
    },
    [addAttachmentRecords, applyToken],
  );

  const attachResource = useCallback(
    async (server: McpServerConfig, uri: string, trigger: ComposerMenuTrigger) => {
      setMcpBusy(true);
      try {
        const contents = await readMcpResource(server.id, uri);
        const records = resourceContentsToAttachments(server, contents);
        applyToken(trigger, resourceToken(server, uri));
        addAttachmentRecords(records);
        setMcpArgs(null);
        if (records.length === 0) {
          toast.error("The resource came back empty", { description: uri });
        }
      } catch (error) {
        toast.error("Could not attach the resource", { description: errorFromUnknown(error) });
      } finally {
        setMcpBusy(false);
      }
    },
    [addAttachmentRecords, applyToken],
  );

  const onMcpSelect = useCallback(
    (item: ComposerMcpItem, trigger: ComposerMenuTrigger) => {
      if (item.kind === "prompt") {
        const fields: McpArgsField[] = (item.prompt.arguments ?? []).map((argument) => ({
          name: argument.name,
          description: argument.description,
          required: argument.required === true,
        }));
        if (fields.length === 0) {
          void runPrompt(item, trigger, {});
          return;
        }
        setMcpArgs({ item, trigger, fields });
        return;
      }
      if (item.kind === "resource") {
        void attachResource(item.server, item.resource.uri, trigger);
        return;
      }
      const variables = uriTemplateVariables(item.template.uriTemplate);
      if (variables.length === 0) {
        void attachResource(item.server, item.template.uriTemplate, trigger);
        return;
      }
      setMcpArgs({ item, trigger, fields: variables.map((name) => ({ name, required: true })) });
    },
    [attachResource, runPrompt],
  );

  const mcpMenu = useComposerMcpMenu({
    input: state.input,
    caret,
    servers: settings.mcpServers,
    enabled: isChat && !mcpArgs,
    onSelect: onMcpSelect,
  });

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mcpMenu.onKeyDown(event)) {
      return;
    }
    if (event.key !== "Enter") {
      return;
    }
    const mod = event.metaKey || event.ctrlKey;
    // Ctrl/⌘+Shift+Enter — interrupt: stop the live run, send immediately.
    // A separate explicit gesture, never the default (Cursor's "Stop & send").
    if (mod && event.shiftKey) {
      event.preventDefault();
      if (!canSend) {
        return;
      }
      if (activeRunning) {
        queueMessage({ interrupt: true });
      } else {
        send();
      }
      return;
    }
    if (!event.shiftKey) {
      if (hasTouchKeyboard()) {
        // Phones/tablets: Enter inserts a newline; sending is the button's job.
        return;
      }
      if (!settings.enterSends && !mod) {
        return; // Enter-sends is off: Enter makes a newline, Ctrl/⌘+Enter sends.
      }
      event.preventDefault();
      if (!canSend) {
        return;
      }
      if (activeRunning) {
        // Enter queues the follow-up; Ctrl/⌘+Enter steers it into the live run
        // — the reply takes it mid-stream and keeps going, nothing restarts.
        // With Enter-sends off, Ctrl/⌘+Enter IS the send gesture — it queues.
        queueMessage({ steer: settings.enterSends ? mod : false });
      } else {
        send();
      }
    }
  };

  return (
    <div
      className={
        variant === "docked"
          ? "mx-auto w-full max-w-3xl px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-2"
          : "w-full"
      }
    >
      <div className={cn("mb-2.5 flex", variant === "hero" ? "relative justify-center" : "justify-start")}>
        <div className="inline-flex items-center gap-0.5 rounded-full border border-border/70 bg-card p-1 shadow-sm">
          {MODES.map((item) => {
            const Icon = item.icon;
            const active = mode === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={active}
                onClick={() => setMode(item.id)}
                className={cn(
                  "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                  active ? "bg-ember text-ember-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {item.label}
              </button>
            );
          })}
        </div>
        {showProfileRow ? (
          <div
            data-testid={TID.composerProfiles}
            className="absolute inset-y-0 right-0 hidden items-center gap-1.5 sm:flex"
          >
            <span className="hidden text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/60 md:inline">
              Profiles
            </span>
            <div className="flex items-center -space-x-1.5">
              {profileRow.map((agent) => {
                const attached = activeAgent?.id === agent.id;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    aria-pressed={attached}
                    aria-label={attached ? `Detach ${agent.name} from this thread` : `New thread with ${agent.name}`}
                    title={attached ? `${agent.name} — tap to detach` : `New thread with ${agent.name}`}
                    onClick={() => (attached ? setChatAgent(null) : newChatWithAgent(agent.id))}
                    className={cn(
                      "flex h-7 w-7 items-center justify-center rounded-full font-display text-[11px] ring-2 transition-transform hover:-translate-y-0.5",
                      agentHue(agent.name),
                      attached ? "ring-ember" : "ring-background",
                    )}
                  >
                    {agentMonogram(agent.name)}
                  </button>
                );
              })}
            </div>
            {profileOverflow > 0 ? (
              <button
                type="button"
                title="All profiles"
                aria-label="All profiles"
                onClick={() => navigate("/profiles")}
                className="flex h-7 items-center rounded-full border border-border/70 bg-card px-2 text-[10px] font-semibold text-muted-foreground transition-colors hover:text-ember"
              >
                +{profileOverflow}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {isChat && activeAgent ? (
        <div className={cn("mb-2 flex", variant === "hero" ? "justify-center" : "justify-start")}>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-ember/40 bg-accent/70 py-1 pl-1 pr-1.5 text-xs shadow-sm">
            <span
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded-full font-display text-[11px]",
                agentHue(activeAgent.name),
              )}
            >
              {agentMonogram(activeAgent.name)}
            </span>
            <span className="font-medium">{activeAgent.name}</span>
            <span className="hidden text-muted-foreground sm:inline">· thread agent</span>
            <button
              type="button"
              aria-label="Detach agent from this thread"
              onClick={() => setChatAgent(null)}
              className="rounded-full p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        </div>
      ) : null}
      {canAttach && state.attachments.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {state.attachments.map((file) => (
            <div
              key={file.id}
              data-testid={TID.composerAttachment}
              className={cn(
                "relative h-16 overflow-hidden rounded-xl border border-border bg-card",
                file.mime.startsWith("image/") ? "w-16" : "w-28",
              )}
            >
              {file.mime.startsWith("image/") && file.dataUrl ? (
                <MediaImg src={file.dataUrl} alt={file.name} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-2">
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="w-full truncate text-center text-[9px] leading-tight text-muted-foreground">
                    {file.name}
                  </span>
                </div>
              )}
              <button
                type="button"
                aria-label="Remove attachment"
                onClick={() => removeAttachment(file.id)}
                className="absolute right-1 top-1 rounded-full bg-foreground/80 p-0.5 text-background"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {cloudPhase ? (
        <div className="mb-2 flex items-center gap-1.5 px-1 text-[11px] font-medium text-muted-foreground">
          <Cloud className={cn("h-3 w-3", cloudPhase === "live" ? "text-ember" : "animate-pulse")} />
          {cloudPhase === "live"
            ? "Running in the cloud — live stream; closing this tab won't stop it"
            : cloudPhase === "polling"
              ? "Running in the cloud — updating via snapshots"
              : "Running in the cloud — reconnecting…"}
        </div>
      ) : null}
      {queuedItems.length > 0 ? (
        <div className="mb-2 overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
          <div className="flex items-center gap-1.5 border-b border-border/50 bg-muted/40 px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
            <ListEnd className="h-3 w-3" />
            Queued · {queuedItems.length}
            <span className="ml-auto hidden font-normal sm:inline">
              {steerable && queuedItems.some((item) => item.steer)
                ? "steering — lands in the live run"
                : activeRunning
                  ? "runs after the current response"
                  : "sends next"}
              {queuedItems.length > 1 ? " · drag to reorder" : ""}
            </span>
          </div>
          {queuedItems.map((item) => {
            const ModeIcon = MODES.find((entry) => entry.id === item.mode)?.icon ?? MessageSquare;
            // The steer flag only means "riding the live run" while that run is
            // still steerable; after a Stop it renders as a plain queued item.
            const steering = item.steer === true && steerable;
            return (
              <div
                key={item.id}
                ref={(node) => {
                  if (node) {
                    queueRowRefs.current.set(item.id, node);
                  } else {
                    queueRowRefs.current.delete(item.id);
                  }
                }}
                className={cn(
                  "flex items-center gap-2 border-b border-border/40 px-3 py-1.5 transition-colors last:border-b-0",
                  dragId === item.id && "bg-accent/70",
                )}
              >
                {queuedItems.length > 1 ? (
                  <button
                    type="button"
                    aria-label="Reorder — drag or use arrow keys"
                    title="Drag to reorder · ↑/↓ moves"
                    onPointerDown={(event) => startQueueDrag(event, item.id)}
                    onPointerMove={(event) => moveQueueDrag(event, item.id)}
                    onPointerUp={endQueueDrag}
                    onPointerCancel={endQueueDrag}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                        event.preventDefault();
                        const index = queuedItems.findIndex((entry) => entry.id === item.id);
                        const target = queuedItems[event.key === "ArrowUp" ? index - 1 : index + 1];
                        if (target) {
                          reorderQueued(item.id, target.id);
                        }
                      }
                    }}
                    className={cn(
                      "-ml-1.5 shrink-0 touch-none rounded p-1 transition-colors",
                      dragId === item.id
                        ? "cursor-grabbing text-foreground"
                        : "cursor-grab text-muted-foreground/50 hover:text-foreground",
                    )}
                  >
                    <GripVertical className="h-3.5 w-3.5" />
                  </button>
                ) : null}
                {steering ? (
                  <ArrowUp className="h-3.5 w-3.5 shrink-0 animate-pulse text-ember" aria-label="Steering" />
                ) : null}
                {item.mode !== "chat" ? (
                  <ModeIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <>
                    {item.deepResearch ? <Telescope className="h-3.5 w-3.5 shrink-0 text-ember" /> : null}
                    {item.julius ? <Landmark className="h-3.5 w-3.5 shrink-0 text-ember" /> : null}
                  </>
                )}
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  {item.text || item.attachments.map((file) => file.name).join(", ")}
                </span>
                {item.attachments.length > 0 ? (
                  <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground">
                    <Paperclip className="h-3 w-3" />
                    {item.attachments.length}
                  </span>
                ) : null}
                {steering ? null : (
                  <button
                    type="button"
                    onClick={() => sendQueuedNow(item.id)}
                    title={
                      steerable && item.mode === "chat"
                        ? "Steer into the current run — no interruption"
                        : activeRunning
                          ? "Send now — interrupts the current response"
                          : "Send now"
                    }
                    aria-label="Send now"
                    className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => removeQueued(item.id)}
                  title="Remove from queue"
                  aria-label="Remove from queue"
                  className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      <div
        onDragEnter={onDropZoneEnter}
        onDragOver={onDropZoneOver}
        onDragLeave={onDropZoneLeave}
        onDrop={onDropZoneDrop}
        className={cn(
          "relative rounded-3xl border border-border/70 bg-card",
          variant === "hero"
            ? "shadow-[0_2px_4px_rgba(35,20,28,0.05),0_44px_90px_-48px_rgba(122,46,80,0.5)]"
            : "shadow-[0_1px_2px_rgba(35,20,28,0.04),0_24px_50px_-32px_rgba(35,20,28,0.35)]",
        )}
      >
        {dropActive ? (
          <div
            data-testid={TID.composerDropZone}
            aria-hidden
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center overflow-hidden rounded-3xl bg-card/80 backdrop-blur-md animate-in fade-in-0 duration-150"
          >
            <span className="absolute inset-[6px] rounded-[20px] border border-dashed border-ember/40" />
            <span className="absolute inset-0 bg-[radial-gradient(70%_140%_at_50%_110%,hsl(var(--ember)/0.14),transparent_65%)]" />
            <span className="relative flex items-center gap-3.5 animate-in fade-in-0 slide-in-from-bottom-1 duration-200">
              <span className="relative flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-b from-ember to-ember/80 text-ember-foreground shadow-[0_8px_24px_-8px_hsl(var(--ember)/0.7),inset_0_1px_0_rgba(255,255,255,0.25)]">
                <span className="absolute inset-0 rounded-2xl border border-ember/30 animate-ping [animation-duration:2s]" />
                <ArrowDownToLine className="relative h-[18px] w-[18px] animate-bounce [animation-duration:1.6s]" strokeWidth={2.25} />
              </span>
              <span className="flex flex-col gap-0.5 leading-none">
                <span className="font-display text-[17px] tracking-[-0.01em] text-foreground">
                  {isChat ? "Drop to attach" : mode === "image" ? "Drop to edit" : "Drop to animate"}
                </span>
                <span className="text-[11.5px] tracking-[0.01em] text-muted-foreground">
                  {isChat
                    ? "Images, PDF, Word and Excel"
                    : mode === "image"
                      ? "One image — PNG, JPG or WebP"
                      : "One image — it becomes the first frame"}
                </span>
              </span>
            </span>
          </div>
        ) : null}
        <ComposerMcpMenuPanel menu={mcpMenu} />
        <McpArgsDialog
          open={mcpArgs !== null}
          title={
            mcpArgs?.item.kind === "prompt"
              ? `Prompt “${mcpArgs.item.prompt.title ?? mcpArgs.item.prompt.name}”`
              : mcpArgs?.item.kind === "template"
                ? `Resource “${mcpArgs.item.template.title ?? mcpArgs.item.template.name}”`
                : "MCP"
          }
          description={
            mcpArgs?.item.kind === "prompt"
              ? mcpArgs.item.prompt.description ?? `${mcpArgs.item.server.name} fills this prompt with your arguments and inserts it into the message.`
              : mcpArgs?.item.kind === "template"
                ? `${mcpArgs.item.template.uriTemplate} — fill in the variables to read this resource from ${mcpArgs.item.server.name}.`
                : undefined
          }
          fields={mcpArgs?.fields ?? []}
          submitLabel={mcpArgs?.item.kind === "prompt" ? "Insert prompt" : "Attach resource"}
          busy={mcpBusy}
          onClose={() => setMcpArgs(null)}
          onSubmit={(values) => {
            if (!mcpArgs) {
              return;
            }
            if (mcpArgs.item.kind === "prompt") {
              void runPrompt(mcpArgs.item, mcpArgs.trigger, values);
            } else if (mcpArgs.item.kind === "template") {
              void attachResource(mcpArgs.item.server, expandUriTemplate(mcpArgs.item.template.uriTemplate, values), mcpArgs.trigger);
            }
          }}
        />
        <textarea
          ref={attachTextarea}
          data-testid={TID.composerInput}
          value={state.input}
          onChange={(event) => {
            setInput(event.target.value);
            setCaret(event.target.selectionStart ?? event.target.value.length);
          }}
          onKeyUp={(event) => setCaret(event.currentTarget.selectionStart ?? state.input.length)}
          onClick={(event) => setCaret(event.currentTarget.selectionStart ?? state.input.length)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={1}
          className={cn(
            "w-full resize-none bg-transparent px-5 pt-4 text-[15px] leading-relaxed outline-none transition-[height] duration-200 ease-out placeholder:text-muted-foreground motion-reduce:transition-none",
            variant === "hero" ? "min-h-[64px]" : "min-h-[52px]",
          )}
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            {canAttach ? (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept={dropAccept ?? undefined}
                  multiple={mode !== "video"}
                  className="hidden"
                  onChange={(event) => {
                    const files = [...(event.target.files ?? [])];
                    if (files.length > 0) {
                      // Video animates exactly one image — a new pick replaces the old one.
                      void addAttachments(mode === "video" ? files.slice(0, 1) : files, {
                        replace: mode === "video",
                      });
                    }
                    event.target.value = "";
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 rounded-full"
                  onClick={() => fileRef.current?.click()}
                  aria-label={
                    isChat
                      ? "Attach"
                      : mode === "image"
                        ? "Attach an image to edit"
                        : "Attach an image to animate"
                  }
                  title={
                    isChat
                      ? "Attach files"
                      : mode === "image"
                        ? "Attach an image to edit or restyle"
                        : "Attach an image to animate"
                  }
                >
                  <Paperclip className="h-4 w-4" />
                </Button>
              </>
            ) : null}
            {isChat ? (
              <>
                <StudioMenu />
                <RunModeSelector />
                <SkillsRailButton />
                <GitHubRepoPin />
              </>
            ) : null}
            {mode === "image" ? (
              <>
                {IMAGE_SIZES.map((item) => (
                  <OptionChip
                    key={item.value}
                    label={item.label}
                    active={settings.imageSize === item.value}
                    onClick={() => patchSettings({ imageSize: item.value })}
                  />
                ))}
                <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 self-center bg-border/70" />
                {IMAGE_COUNTS.map((count) => (
                  <OptionChip
                    key={count}
                    label={`${count}×`}
                    title={
                      count === 1
                        ? "One image per prompt"
                        : `${count} variations per prompt — typing “${count} variants” in the prompt works too`
                    }
                    active={settings.imageCount === count}
                    onClick={() => patchSettings({ imageCount: count })}
                  />
                ))}
              </>
            ) : null}
            {mode === "video"
              ? VIDEO_ASPECTS.map((item) => (
                  <OptionChip
                    key={item.value}
                    label={item.label}
                    active={settings.videoAspect === item.value}
                    onClick={() => patchSettings({ videoAspect: item.value })}
                  />
                ))
              : null}
            {mode === "audio" && voices.length > 0 ? (
              <label className="flex items-center gap-1.5 pl-1 text-[11px] text-muted-foreground">
                Voice
                <select
                  value={voiceValue}
                  onChange={(event) => patchSettings({ audioVoice: event.target.value })}
                  className="h-8 rounded-full border border-border/70 bg-card px-2.5 text-xs capitalize outline-none"
                >
                  {voices.map((voice) => (
                    <option key={voice} value={voice}>
                      {voice}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {isChat && state.julius ? <JuliusRosterPill /> : <ModelPicker />}
            {activeRunning ? (
              <>
                {canSend ? (
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    onClick={() => queueMessage()}
                    title={
                      steerable
                        ? "Queue — Enter · Steer mid-run — Ctrl/⌘ Enter"
                        : "Queue — sends when this run finishes"
                    }
                    aria-label="Queue message"
                    className="h-10 w-10 rounded-full border-border/70"
                  >
                    <ListEnd className="h-4 w-4" />
                  </Button>
                ) : null}
                {canSend && steerable ? (
                  <Button
                    type="button"
                    size="icon"
                    onClick={() => queueMessage({ steer: true })}
                    title="Steer — the live reply takes it instantly and keeps going (Ctrl/⌘ Enter)"
                    aria-label="Steer the run"
                    className="h-10 w-10 shrink-0 rounded-full bg-ember text-ember-foreground hover:bg-ember/90"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="icon"
                  onClick={stop}
                  data-testid={TID.composerStop}
                  className="h-10 w-10 shrink-0 rounded-full bg-foreground text-background hover:bg-foreground/90"
                  aria-label="Stop"
                >
                  <Square className="h-3.5 w-3.5 fill-current" />
                </Button>
              </>
            ) : (
              <Button
                type="button"
                size="icon"
                onClick={send}
                disabled={!canSend}
                data-testid={TID.composerSend}
                className="h-10 w-10 shrink-0 rounded-full bg-ember text-ember-foreground hover:bg-ember/90 disabled:opacity-40"
                aria-label="Send"
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const RESEARCH_DEPTH_OPTIONS: { value: ResearchDepth; title: string; hint: string }[] = [
  { value: "eco", title: "Eco", hint: "Saves credits — a quick pass for simple questions" },
  { value: "balanced", title: "Balanced", hint: "The default — solid coverage for most topics" },
  { value: "max", title: "Max", hint: "Exhaustive — slowest and spends the most credits" },
];

/** Icon-chip header shared by the run-mode config popovers. */
function ConfigHeader({ icon: Icon, title, blurb }: { icon: typeof Telescope; title: string; blurb: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-ember/10 text-ember">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold leading-tight">{title}</p>
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{blurb}</p>
      </div>
    </div>
  );
}

/** One figure in the research budget strip. */
function DepthStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="px-1 text-center">
      <span className="block text-[13px] font-semibold leading-tight tabular-nums">{value}</span>
      <span className="mt-0.5 block text-[9px] uppercase tracking-[0.06em] text-muted-foreground">{label}</span>
    </div>
  );
}

/** Deep research depth: caps on iterations, page reads, and live browsing per run. */
function ResearchConfig() {
  const { state, patchSettings } = useAgent();
  const depth = state.settings.researchDepth;
  const activeOption = RESEARCH_DEPTH_OPTIONS.find((option) => option.value === depth) ?? RESEARCH_DEPTH_OPTIONS[1];
  const profile = RESEARCH_PROFILES[activeOption.value];
  // Connected generic MCP servers (not the native GitHub connector) reach
  // research through the deferred meta tools — the panel says so honestly.
  const mcpServers = state.settings.mcpServers.filter(
    (server) =>
      server.enabled &&
      server.status === "connected" &&
      !["github", "slack", "intercom"].includes(server.catalogId ?? server.id),
  );
  return (
    <div className="space-y-4">
      <ConfigHeader
        icon={Telescope}
        title="Deep research"
        blurb="Searches in waves, reads pages in full, browses live with SelfSurf — then writes a cited report."
      />
      <div className="space-y-2">
        <p className="px-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Depth · budget per run
        </p>
        <div className="grid grid-cols-3 gap-1 rounded-xl bg-muted/60 p-1">
          {RESEARCH_DEPTH_OPTIONS.map((option) => {
            const active = depth === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => patchSettings({ researchDepth: option.value })}
                aria-pressed={active}
                title={option.hint}
                className={cn(
                  "rounded-lg py-1.5 text-xs font-medium transition-colors",
                  active ? "bg-card text-ember shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option.title}
              </button>
            );
          })}
        </div>
        <p className="px-0.5 text-[11px] leading-snug text-muted-foreground">{activeOption.hint}</p>
        <div className="grid grid-cols-4 divide-x divide-border/50 rounded-xl border border-border/60 bg-card py-2">
          <DepthStat value={String(profile.maxWaves)} label="waves" />
          <DepthStat value={`≤${profile.maxQueriesTotal}`} label="searches" />
          <DepthStat value={`≤${profile.maxReadsTotal}`} label="page reads" />
          <DepthStat value={`≤${profile.maxBrowseTotal}`} label="live pages" />
        </div>
        <p className="px-0.5 text-[10px] leading-snug text-muted-foreground">
          {mcpServers.length > 0
            ? `MCP: ${mcpServers.map((server) => server.name).join(", ")} — searched on demand (deferred tools, up to 6 reads per run) and cited as sources.`
            : "MCP: connected servers are searched on demand (deferred tools) and cited as sources — none connected yet."}
        </p>
        {state.julius ? (
          <p className="px-0.5 text-[10px] leading-snug text-muted-foreground">
            Julius is on — every candidate researches at this depth.
          </p>
        ) : null}
      </div>
    </div>
  );
}

type CouncilRole = {
  key: "proponentModelId" | "criticModelId" | "verifierModelId" | "chairmanModelId";
  label: string;
  hint: string;
};

const COUNCIL_ROLES: CouncilRole[] = [
  { key: "proponentModelId", label: "Proponent", hint: "always argues for" },
  { key: "criticModelId", label: "Critic", hint: "always attacks" },
  { key: "verifierModelId", label: "Verifier", hint: "checks facts, can search" },
  { key: "chairmanModelId", label: "Chairman", hint: "weighs it all, rules" },
];

/** Council v2: no Proponent / Critic — Jev rules on the Verifier's evidence; the chairman only writes. */
const COUNCIL_V2_ROLES: CouncilRole[] = [
  { key: "verifierModelId", label: "Verifier", hint: "checks facts, can search" },
  { key: "chairmanModelId", label: "Editor", hint: "writes from Jev's plan" },
];

/** Julius panel configuration: candidate models, decision mode, council models. */
function JuliusConfig() {
  const { state, models, patchSettings } = useAgent();
  const julius = state.settings.julius;
  const singleCandidate = julius.candidateModelIds.length === 1;
  const options = useMemo(() => {
    const curated = modelsForMode(models, "chat");
    return curated.length > 0
      ? curated.map((model) => ({ id: model.id, name: model.name }))
      : MODE_MODEL_IDS.chat.map((id) => ({ id, name: id }));
  }, [models]);
  const patch = (next: Partial<JuliusSettings>) => patchSettings({ julius: { ...julius, ...next } });
  // One candidate has nothing to pick between: "I pick" falls back to the classic council.
  const jev = julius.decision === "council_v2";
  const classic = julius.decision === "council" || (singleCandidate && julius.decision === "manual");
  const roles = jev ? COUNCIL_V2_ROLES : COUNCIL_ROLES;

  return (
    <div className="space-y-4">
      <ConfigHeader
        icon={Landmark}
        title="Julius panel"
        blurb={
          state.deepResearch
            ? "Candidates answer in parallel, each running its own research — the council distills the reports into one final answer."
            : "Candidates answer in parallel — you pick the winner, or the council debates and the chairman writes the final answer."
        }
      />
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between px-0.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Candidates</p>
          <span className="text-[10px] tabular-nums text-muted-foreground/70">
            {julius.candidateModelIds.length}/{JULIUS_MAX_CANDIDATES}
          </span>
        </div>
        {julius.candidateModelIds.map((id, index) => (
          <div key={`candidate-${index}`} className="flex items-center gap-1.5">
            <span className="flex h-8 w-7 shrink-0 items-center justify-center rounded-lg bg-ember/10 font-mono text-[11px] font-medium text-ember">
              {juliusLetter(index)}
            </span>
            <select
              value={id}
              onChange={(event) =>
                patch({
                  candidateModelIds: julius.candidateModelIds.map((item, position) =>
                    position === index ? event.target.value : item,
                  ),
                })
              }
              className="h-8 w-full min-w-0 flex-1 rounded-lg border border-border/70 bg-card px-2 text-xs outline-none"
            >
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
            {julius.candidateModelIds.length > JULIUS_MIN_CANDIDATES ? (
              <button
                type="button"
                aria-label={`Remove candidate ${juliusLetter(index)}`}
                onClick={() =>
                  patch({
                    candidateModelIds: julius.candidateModelIds.filter((_, position) => position !== index),
                  })
                }
                className="shrink-0 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        ))}
        {julius.candidateModelIds.length < JULIUS_MAX_CANDIDATES ? (
          <button
            type="button"
            onClick={() =>
              patch({
                candidateModelIds: [
                  ...julius.candidateModelIds,
                  options[0]?.id ?? julius.candidateModelIds[0],
                ],
              })
            }
            className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-border py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-ember/50 hover:bg-ember/5 hover:text-ember"
          >
            <Plus className="h-3 w-3" />
            Add candidate
          </button>
        ) : null}
      </div>
      <div className="space-y-1.5">
        <p className="px-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Decision</p>
        <div className="grid grid-cols-2 gap-1.5">
          <DecisionOption
            active={!singleCandidate && julius.decision === "manual"}
            disabled={singleCandidate}
            onClick={() => patch({ decision: "manual" })}
            title="I pick"
            description={singleCandidate ? "Needs 2+ candidates" : "Answers side by side — you choose the winner"}
          />
          <DecisionOption
            active={classic}
            onClick={() => patch({ decision: "council" })}
            title="Council decides"
            description="Proponent vs Critic, Verifier checks, Chairman rules"
          />
          <DecisionOption
            active={jev}
            onClick={() => patch({ decision: "council_v2" })}
            title="Council v2 · Jev"
            description="Verifier checks; Jev rules keep / fix / drop on every block; the editor writes"
            testId={TID.juliusDecisionV2}
            badge="new"
          />
        </div>
        {jev ? (
          <p className="px-0.5 text-[10px] leading-snug text-muted-foreground">
            Jev (TypeSafe AI) is a decision model: no prose, typed rulings with calibrated probabilities, ~100× cheaper
            than an LLM chairman. It picks the backbone{singleCandidate ? "" : " among the candidates"} and rules on
            every block; no model argues a side.
          </p>
        ) : singleCandidate ? (
          <p className="px-0.5 text-[10px] leading-snug text-muted-foreground">
            With one candidate the council always reviews the answer quality.
          </p>
        ) : null}
      </div>
      {classic || jev ? (
        <div className="space-y-1.5">
          <p className="px-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {jev ? "Council v2 models" : "Council models"}
          </p>
          {roles.map((role) => (
            <label key={role.key} className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-xs">
                {role.label}
                <span className="block text-[10px] leading-tight text-muted-foreground">{role.hint}</span>
              </span>
              <select
                value={julius[role.key]}
                onChange={(event) => patch({ [role.key]: event.target.value } as Partial<JuliusSettings>)}
                className="h-8 w-full min-w-0 flex-1 rounded-lg border border-border/70 bg-card px-2 text-xs outline-none"
              >
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Stands in for the model picker while Julius is engaged: the answer comes
 * from the candidate roster (and the council), never from one picked model,
 * so the rail names the roster and opens the panel config instead.
 */
function JuliusRosterPill() {
  const { state, models } = useAgent();
  const julius = state.settings.julius;
  const names = julius.candidateModelIds.map(
    (id) => findModel(models, id)?.name ?? modelShortName(parseModelSelection(id).catalogId),
  );
  const single = names.length === 1;
  const decision =
    julius.decision === "council_v2" ? "Jev rules" : julius.decision === "council" || single ? "council rules" : "you pick";
  const roster = names.join(" · ");
  const detail = [
    ...julius.candidateModelIds.map((id, index) => `${juliusLetter(index)} · ${names[index]} (${id})`),
    `Decision: ${decision}`,
  ].join("\n");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={TID.composerJuliusRoster}
          aria-label={`Julius panel: ${names.length} ${single ? "candidate" : "candidates"} — ${roster}; ${decision}. Open panel settings.`}
          title={`Julius answers with its own roster — the model picker does not apply.\n${detail}`}
          className="flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground data-[state=open]:bg-foreground/5 data-[state=open]:text-foreground"
        >
          <Landmark className="h-3.5 w-3.5 shrink-0 text-ember" />
          <span className="max-w-[9rem] truncate sm:max-w-[16rem]">{roster}</span>
          <span className="hidden shrink-0 text-muted-foreground/70 md:inline">· {decision}</span>
          <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={10}
        collisionPadding={12}
        data-testid={TID.composerJuliusRosterPanel}
        className="max-h-[min(70vh,30rem)] w-[min(92vw,22rem)] overflow-y-auto rounded-2xl border-border/80 bg-popover p-4 shadow-[0_24px_60px_-24px_rgba(35,20,28,0.45)]"
      >
        <JuliusConfig />
      </PopoverContent>
    </Popover>
  );
}

function DecisionOption({
  active,
  disabled,
  onClick,
  title,
  description,
  testId,
  badge,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  description: string;
  testId?: string;
  badge?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      data-testid={testId}
      className={cn(
        "rounded-xl border px-2.5 py-2 text-left transition-colors",
        active ? "border-ember/60 bg-ember/10" : "border-border/70 hover:bg-muted/50",
        disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
      )}
    >
      <span className={cn("flex items-center gap-1.5 text-xs font-medium", active && "text-ember")}>
        {title}
        {badge ? (
          <span className="rounded-full bg-gold/15 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-gold">
            {badge}
          </span>
        ) : null}
      </span>
      <span className="mt-0.5 block text-[10px] leading-tight text-muted-foreground">{description}</span>
    </button>
  );
}

/**
 * Per-surface skill switches inside the rail Skills popover: checked = the
 * skill rides runs of that surface. Turning one ON re-enables a globally
 * disabled skill; turning OFF leaves the other surfaces untouched.
 */
function SkillsSurfaceList({ surface }: { surface: SkillSurface }) {
  const { state, patchSettings } = useAgent();
  const skills = state.settings.skills;
  const groups = groupSkillsByFolder(skills);
  const hasFolders = groups.some((group) => group.folder !== null);
  return (
    <div className="max-h-56 space-y-2 overflow-y-auto pr-0.5">
      {groups.map((group) => {
        const total = group.skills.length;
        const on = group.skills.filter((skill) => skill.enabled && skill.surfaces[surface]).length;
        return (
          <div key={group.folder ?? "__none"} className="space-y-1">
            {hasFolders ? (
              <div className="flex items-center justify-between gap-2 px-0.5">
                <span className="min-w-0 truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {group.folder ?? "Other"} · {on}/{total}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    patchSettings({
                      skills: setFolderSurface(skills, group.folder, surface, on !== total),
                    })
                  }
                  className="shrink-0 text-[10px] font-medium text-ember transition-opacity hover:opacity-80"
                >
                  {on === total ? "All off" : "All on"}
                </button>
              </div>
            ) : null}
            <div className="divide-y divide-border/50 overflow-hidden rounded-lg border border-border/60 bg-card">
              {group.skills.map((skill) => (
                <label
                  key={skill.id}
                  className="flex cursor-pointer items-center justify-between gap-2 px-2.5 py-1.5 transition-colors hover:bg-muted/40"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs">{skill.name || "Untitled skill"}</span>
                    {skill.description ? (
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {skill.description}
                      </span>
                    ) : null}
                  </span>
                  <Switch
                    checked={skill.enabled && skill.surfaces[surface]}
                    onCheckedChange={(checked) =>
                      patchSettings({ skills: setSkillSurface(skills, skill.id, surface, checked === true) })
                    }
                    aria-label={`Use ${skill.name || "skill"} in ${SKILL_SURFACE_LABEL[surface]} runs`}
                  />
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The one Skills home in the rail. The badge counts packs riding the active
 * run mode (Standard → chat, Deep research, Julius; the combo counts packs
 * on either engine); the popover toggles them per surface.
 */
function SkillsRailButton() {
  const { state, activeAgent } = useAgent();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"research" | "julius">("research");
  const research = state.deepResearch;
  const julius = state.julius;
  const combo = research && julius;
  const skills = state.settings.skills;
  const countFor = (surface: SkillSurface) =>
    skills.filter((skill) => skill.enabled && skill.surfaces[surface]).length;
  const riding = combo
    ? skills.filter((skill) => skill.enabled && (skill.surfaces.research || skill.surfaces.julius)).length
    : countFor(research ? "research" : julius ? "julius" : "chat");
  const surface: SkillSurface = combo ? tab : research ? "research" : julius ? "julius" : "chat";
  const modeLabel = combo ? "Research × Julius" : research ? "Deep research" : julius ? "Julius" : "standard chat";
  const blurb = combo
    ? "Research and Julius each carry their own packs — toggle per engine."
    : research
      ? "Instruction packs riding every Deep research run."
      : julius
        ? "Instruction packs every candidate and the council see."
        : "Instruction packs riding every chat answer.";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid={TID.composerSkills}
          className="relative h-9 w-9 rounded-full data-[state=open]:bg-accent data-[state=open]:text-ember"
          aria-label={`Skills — ${riding} riding ${modeLabel} runs`}
          title={`Skills — ${riding} riding ${modeLabel} runs`}
        >
          <Sparkles className="h-4 w-4" />
          {riding > 0 ? (
            <span
              aria-hidden
              className="absolute -right-px -top-px flex h-4 min-w-4 items-center justify-center rounded-full bg-ember px-1 text-[9px] font-semibold leading-none text-ember-foreground ring-2 ring-background tabular-nums"
            >
              {riding}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        data-testid={TID.composerSkillsPanel}
        className="max-h-[min(70vh,26rem)] w-[min(92vw,20rem)] overflow-y-auto rounded-2xl border-border/80 bg-popover p-4 shadow-[0_24px_60px_-24px_rgba(35,20,28,0.45)]"
      >
        <div className="space-y-3.5">
          <ConfigHeader icon={Sparkles} title="Skills" blurb={blurb} />
          {combo ? (
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted/60 p-1">
              {(["research", "julius"] as const).map((engine) => (
                <button
                  key={engine}
                  type="button"
                  onClick={() => setTab(engine)}
                  aria-pressed={tab === engine}
                  className={cn(
                    "flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-medium transition-colors",
                    tab === engine ? "bg-card text-ember shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {engine === "research" ? (
                    <Telescope className="h-3.5 w-3.5" />
                  ) : (
                    <Landmark className="h-3.5 w-3.5" />
                  )}
                  {engine === "research" ? "Research" : "Julius"}
                  <span className="text-[10px] tabular-nums opacity-70">{countFor(engine)}</span>
                </button>
              ))}
            </div>
          ) : null}
          {skills.length === 0 ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              No skills yet — reusable instruction packs that shape how runs work.{" "}
              <button
                type="button"
                onClick={() => navigate("/skills")}
                className="font-medium text-ember transition-opacity hover:opacity-80"
              >
                Browse the catalog
              </button>
            </p>
          ) : (
            <SkillsSurfaceList surface={surface} />
          )}
          {activeAgent && activeAgent.skillIds !== null ? (
            <p className="text-[10px] leading-snug text-muted-foreground">
              Thread agent “{activeAgent.name}” narrows this further to its {activeAgent.skillIds.length} picked
              skill{activeAgent.skillIds.length === 1 ? "" : "s"} — edit in Profiles.
            </p>
          ) : null}
          {skills.length > 0 ? (
            <button
              type="button"
              onClick={() => navigate("/skills")}
              className="text-[11px] font-medium text-ember transition-opacity hover:opacity-80"
            >
              Manage skills…
            </button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Repo listing cache, isolated by connector and non-secret credential fingerprint. */
let repoPickCache: { serverId: string; credential: string; at: number; repos: RepoOption[] } | null = null;
subscribeConnectorCaches(() => { repoPickCache = null; });

/**
 * GitHub repo pin — rendered only while the GitHub connector is on. Pins one
 * of the user's repositories to the active thread: every run in the thread
 * sees the pin in its system prompt and defaults GitHub tools to that repo
 * (the connector arms automatically, no need to name the repo every message).
 */
function GitHubRepoPin() {
  const { state, setChatRepo } = useAgent();
  const navigate = useNavigate();
  const [open, setOpen] = useState<boolean>(false);
  const [query, setQuery] = useState<string>("");
  const [repos, setRepos] = useState<RepoOption[] | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [launchOpen, setLaunchOpen] = useState<boolean>(false);
  const [launchConversationId, setLaunchConversationId] = useState<string>("");
  const loadRevision = useRef<number>(0);
  useEffect(() => subscribeConnectorCaches(() => {
    loadRevision.current += 1;
    setRepos(null); setError(""); setLoading(false);
  }), []);
  useEffect(() => () => { loadRevision.current += 1; }, []);

  const active = state.conversations.find((item) => item.id === state.activeId);
  const activeAgent = active?.agentId
    ? state.settings.agents.find((item) => item.id === active.agentId)
    : undefined;
  const configuredServer = state.settings.mcpServers.find(
    (item) => item.enabled && (item.catalogId ?? item.id) === "github",
  );
  const agentAllowsServer =
    !activeAgent ||
    activeAgent.mcpServerIds === null ||
    Boolean(
      configuredServer &&
        (activeAgent.mcpServerIds.includes(configuredServer.id) ||
          (configuredServer.catalogId
            ? activeAgent.mcpServerIds.includes(configuredServer.catalogId)
            : false)),
    );
  const server = agentAllowsServer ? configuredServer : undefined;
  const pinned = active?.githubRepo ?? "";

  if (!configuredServer) {
    return null;
  }
  if (!server && activeAgent) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        data-testid={TID.composerRepo}
        onClick={() => navigate(`/profiles/${activeAgent.id}`)}
        className="relative h-9 w-9 rounded-full text-amber-700 hover:text-amber-800"
        aria-label={`${activeAgent.name} does not have GitHub access. Edit the profile to allow it.`}
        title={`${activeAgent.name} excludes GitHub — edit the profile's MCP access to use repository pins.`}
      >
        <Github className="h-4 w-4 opacity-60" />
        <span className="absolute right-1 top-0.5 text-[10px] font-bold">!</span>
      </Button>
    );
  }
  if (!server) {
    return null;
  }

  const load = async (force?: boolean) => {
    const revision = ++loadRevision.current;
    const scope = connectorCacheKey(server.id);
    const current = () => loadRevision.current === revision && connectorCacheKey(server.id) === scope;
    setLoading(true);
    setError("");
    try {
      const auth = await resolveGitHubAuth(server);
      if (!current()) return;
      const credential = `${scope}:${githubAuthorizationFingerprint(auth)}`;
      if (
        !force &&
        repoPickCache &&
        repoPickCache.serverId === server.id &&
        repoPickCache.credential === credential &&
        Date.now() - repoPickCache.at < 300_000
      ) {
        setRepos(repoPickCache.repos);
        return;
      }
      const list = await listRepoOptions(auth);
      if (!current()) return;
      repoPickCache = { serverId: server.id, credential, at: Date.now(), repos: list };
      setRepos(list);
    } catch (err) {
      if (current()) { setRepos(null); setError(errorFromUnknown(err)); }
    } finally {
      if (current()) setLoading(false);
    }
  };

  const needle = query.trim().toLowerCase();
  const shown = (repos ?? [])
    .filter((repo) => (needle ? `${repo.fullName} ${repo.description}`.toLowerCase().includes(needle) : true))
    .slice(0, 60);
  const shortName = pinned.includes("/") ? pinned.slice(pinned.indexOf("/") + 1) : pinned;

  return (
    <>
      <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          void load();
        }
      }}
    >
      {pinned ? (
        <span className="flex min-w-0 items-center overflow-hidden rounded-full border border-ember/60 bg-ember/10 text-ember">
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid={TID.composerRepo}
              aria-label={`GitHub repository pinned: ${pinned}`}
              title={`Pinned to ${pinned} — GitHub tools default to it in this thread. Click to change.`}
              className="flex min-w-0 items-center gap-1.5 py-1.5 pl-2.5 pr-1 text-[11px] font-medium"
            >
              <Github className="h-3.5 w-3.5 shrink-0" />
              <span className="max-w-[8rem] truncate">{shortName}</span>
              <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
            </button>
          </PopoverTrigger>
          <button
            type="button"
            aria-label="Unpin repository from this thread"
            title="Unpin repository"
            onClick={() => setChatRepo(null)}
            className="shrink-0 py-1.5 pl-0.5 pr-2 transition-opacity hover:opacity-70"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ) : (
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-testid={TID.composerRepo}
            className="h-9 w-9 rounded-full data-[state=open]:bg-accent data-[state=open]:text-ember"
            aria-label="Pin a GitHub repository to this thread"
            title="Pin a GitHub repository — Gera reads it by default in this thread"
          >
            <Github className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
      )}
      <PopoverContent
        align="start"
        data-testid={TID.composerRepoPanel}
        className="w-[min(92vw,22rem)] rounded-2xl border-border/80 bg-popover p-4 shadow-[0_24px_60px_-24px_rgba(35,20,28,0.45)]"
      >
        <div className="space-y-3">
          <ConfigHeader
            icon={Github}
            title="GitHub repository"
            blurb={
              pinned
                ? `Pinned to ${pinned} — every answer in this thread reads it by default.`
                : "Pin one of your repositories to this thread — Gera reads it by default instead of asking which repo you mean."
            }
          />
          {pinned ? (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-ember/40 bg-ember/5 px-2.5 py-1.5">
              <span className="min-w-0 truncate text-xs font-medium">{pinned}</span>
              <button
                type="button"
                onClick={() => setChatRepo(null)}
                className="shrink-0 text-[11px] font-medium text-ember transition-opacity hover:opacity-80"
              >
                Unpin
              </button>
            </div>
          ) : null}
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search repositories…"
            aria-label="Search repositories"
            className="h-8 w-full rounded-lg border border-border/70 bg-card px-2.5 text-xs outline-none placeholder:text-muted-foreground"
          />
          {error ? (
            <div className="space-y-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-2.5 py-2">
              <p className="text-[11px] leading-snug text-amber-700">{error}</p>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void load(true)}
                  className="text-[11px] font-medium text-ember transition-opacity hover:opacity-80"
                >
                  Retry
                </button>
                <button
                  type="button"
                  onClick={() => navigate(`/mcp?server=${server.id}`)}
                  className="text-[11px] font-medium text-ember transition-opacity hover:opacity-80"
                >
                  Manage GitHub…
                </button>
              </div>
            </div>
          ) : loading || repos === null ? (
            <p className="animate-pulse px-0.5 text-[11px] text-muted-foreground">Loading your repositories…</p>
          ) : (
            <div className="max-h-56 divide-y divide-border/50 overflow-y-auto rounded-xl border border-border/60 bg-card">
              {shown.length === 0 ? (
                <p className="px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
                  {needle
                    ? `No repos match “${query.trim()}”.`
                    : "No repositories are visible to this account — check org access on the GitHub card."}
                </p>
              ) : (
                shown.map((repo) => (
                  <button
                    key={repo.fullName}
                    type="button"
                    data-testid={TID.composerRepoOption}
                    onClick={() => {
                      setChatRepo(repo.fullName);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-muted/40"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{repo.fullName}</span>
                      {repo.description ? (
                        <span className="block truncate text-[10px] text-muted-foreground">{repo.description}</span>
                      ) : null}
                    </span>
                    {repo.private ? (
                      <span className="shrink-0 rounded-full bg-foreground/5 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
                        private
                      </span>
                    ) : null}
                    {pinned === repo.fullName ? <Check className="h-3.5 w-3.5 shrink-0 text-ember" /> : null}
                  </button>
                ))
              )}
            </div>
          )}
          <RepoAccessCheck server={server} seed={query} />
          <p className="px-0.5 text-[10px] leading-snug text-muted-foreground">
            The pin rides this thread only — new chats start clean. Deep research still reads repos you name in
            the prompt.
          </p>
        </div>
      </PopoverContent>
      </Popover>
      {pinned && active?.incognito !== true ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid={TID.composerRepoLaunch}
          disabled={Boolean(active && state.runningIds.includes(active.id))}
          onClick={() => {
            setLaunchConversationId(active?.id ?? "");
            setLaunchOpen(true);
          }}
          className="h-9 w-9 rounded-full text-cyan-700 hover:bg-cyan-500/10 hover:text-cyan-800 disabled:opacity-35"
          aria-label={`Run ${pinned} as a web preview`}
          title="Build this repository in the cloud and open a live Rork preview"
        >
          <Play className="h-3.5 w-3.5 fill-current" />
        </Button>
      ) : null}
      <RepoLaunchDialog
        open={launchOpen}
        onOpenChange={setLaunchOpen}
        repository={pinned}
        conversationId={launchConversationId}
        server={server}
      />
    </>
  );
}

type RunModeId = "standard" | "research" | "julius" | "both";

const RUN_MODES: {
  id: RunModeId;
  research: boolean;
  julius: boolean;
  label: string;
  short: string;
  hint: string;
}[] = [
  { id: "standard", research: false, julius: false, label: "Standard", short: "Standard", hint: "One model answers directly" },
  { id: "research", research: true, julius: false, label: "Deep research", short: "Research", hint: "Web search in waves, then a cited report" },
  { id: "julius", research: false, julius: true, label: "Julius", short: "Julius", hint: "Parallel answers compete — the council rules" },
  { id: "both", research: true, julius: true, label: "Research × Julius", short: "R×J", hint: "Every candidate researches; the council distills one report" },
];

/** Icon(s) naming a run mode; the combo shows both glyphs side by side. */
function ModeGlyph({ mode, className }: { mode: RunModeId; className?: string }) {
  if (mode === "research") {
    return <Telescope className={className} />;
  }
  if (mode === "julius") {
    return <Landmark className={className} />;
  }
  if (mode === "both") {
    return (
      <span className="flex items-center gap-0.5">
        <Telescope className={className} />
        <Landmark className={className} />
      </span>
    );
  }
  return <MessageSquare className={className} />;
}

/**
 * Model-picker-style selector for how a chat answer is produced — Standard,
 * Deep research, Julius, or both combined. The compact trigger and checked
 * catalog mirror the AI model picker; the adjacent gear opens the active
 * mode's settings (tabbed when both engines ride together).
 */
function RunModeSelector() {
  const { state, toggleDeepResearch, toggleJulius } = useAgent();
  const [open, setOpen] = useState<boolean>(false);
  const settings = state.settings;
  const active =
    RUN_MODES.find((mode) => mode.research === state.deepResearch && mode.julius === state.julius) ??
    RUN_MODES[0];
  const engaged = state.deepResearch || state.julius;

  const apply = (mode: (typeof RUN_MODES)[number]) => {
    if (state.deepResearch !== mode.research) {
      toggleDeepResearch();
    }
    if (state.julius !== mode.julius) {
      toggleJulius();
    }
    setOpen(false);
  };

  const depthTitle =
    RESEARCH_DEPTH_OPTIONS.find((option) => option.value === settings.researchDepth)?.title ?? "Balanced";
  const gearLabel =
    state.deepResearch && state.julius
      ? "Research & Julius settings"
      : state.deepResearch
        ? "Deep research depth settings"
        : "Julius panel settings";
  const gearTitle =
    state.deepResearch && state.julius
      ? `Research depth (${depthTitle}) and the Julius panel — configure both`
      : state.deepResearch
        ? `Research depth: ${depthTitle} — set iterations and reading budget`
        : "Configure candidates, decision mode, and council models";

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid={TID.composerModeTrigger}
            aria-label={`Run mode: ${active.label}`}
            title="Choose how the answer is produced"
            className={cn(
              "flex h-8 min-w-0 items-center gap-1 rounded-lg px-2 text-xs font-medium transition-colors hover:bg-foreground/5 data-[state=open]:bg-foreground/5",
              engaged
                ? "bg-ember/10 text-ember hover:bg-ember/15 data-[state=open]:bg-ember/15"
                : "text-muted-foreground hover:text-foreground data-[state=open]:text-foreground",
            )}
          >
            <ModeGlyph mode={active.id} className="h-3.5 w-3.5 shrink-0" />
            <span className="max-w-[7rem] truncate sm:hidden">{active.short}</span>
            <span className="hidden max-w-[10rem] truncate sm:inline">{active.label}</span>
            <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-50" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          sideOffset={10}
          collisionPadding={12}
          className="flex max-h-[min(70vh,var(--radix-popover-content-available-height))] w-[min(92vw,20rem)] flex-col overflow-hidden rounded-2xl border-border bg-popover p-0 shadow-2xl"
        >
          <div className="min-h-0 overflow-y-auto p-2">
            <p className="px-2 py-1.5 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              Answer mode
            </p>
            {RUN_MODES.map((mode) => {
              const selected = active.id === mode.id;
              return (
                <button
                  key={mode.id}
                  type="button"
                  data-testid={runModeOptionTid(mode.id)}
                  onClick={() => apply(mode)}
                  aria-pressed={selected}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left transition-colors hover:bg-foreground/5",
                    selected && "bg-ember/10",
                  )}
                >
                  <Check className={cn("h-3.5 w-3.5 shrink-0", selected ? "text-ember" : "opacity-0")} />
                  <span
                    className={cn(
                      "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                      selected ? "bg-ember/10 text-ember" : "bg-foreground/5 text-muted-foreground",
                    )}
                  >
                    <ModeGlyph mode={mode.id} className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm">{mode.label}</span>
                    <span className="block text-[11px] leading-snug text-muted-foreground">{mode.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
      {engaged ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid={TID.composerModeConfig}
              aria-label={gearLabel}
              title={gearTitle}
              className="flex items-center rounded-full border border-ember/60 bg-ember/10 px-2 py-1.5 text-ember transition-opacity hover:opacity-80"
            >
              <Settings2 className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            data-testid={TID.composerModeConfigPanel}
            className="max-h-[min(70vh,30rem)] w-[min(92vw,22rem)] overflow-y-auto rounded-2xl border-border/80 bg-popover p-4 shadow-[0_24px_60px_-24px_rgba(35,20,28,0.45)]"
          >
            <ModeConfigBody research={state.deepResearch} julius={state.julius} />
          </PopoverContent>
        </Popover>
      ) : null}
    </>
  );
}

/** Settings body for the active run mode; Research | Julius tabs when both ride. */
function ModeConfigBody({ research, julius }: { research: boolean; julius: boolean }) {
  const [tab, setTab] = useState<"research" | "julius">(research ? "research" : "julius");
  if (!(research && julius)) {
    return research ? <ResearchConfig /> : <JuliusConfig />;
  }
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted/60 p-1">
        <button
          type="button"
          onClick={() => setTab("research")}
          aria-pressed={tab === "research"}
          className={cn(
            "flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-medium transition-colors",
            tab === "research" ? "bg-card text-ember shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Telescope className="h-3.5 w-3.5" />
          Research
        </button>
        <button
          type="button"
          onClick={() => setTab("julius")}
          aria-pressed={tab === "julius"}
          className={cn(
            "flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-medium transition-colors",
            tab === "julius" ? "bg-card text-ember shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Landmark className="h-3.5 w-3.5" />
          Julius
        </button>
      </div>
      {tab === "research" ? <ResearchConfig /> : <JuliusConfig />}
    </div>
  );
}

/**
 * Claude-desktop-style studio menu next to the attach button: toolkit toggles,
 * MCP servers, auto routing, and a door into the full studio drawer.
 */
function StudioMenu() {
  const { state, toggleBuiltin, setAutoTools, updateMcp, updateLife } = useAgent();
  const navigate = useNavigate();
  const settings = state.settings;
  const toolsOn = TOOL_MENU.filter((tool) => settings.builtinTools[tool.id]).length;
  const servers = settings.mcpServers;
  const liveCount = servers.filter((item) => item.enabled && item.status === "connected").length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-9 w-9 rounded-full data-[state=open]:bg-accent data-[state=open]:text-ember"
          aria-label="Studio — tools, MCP servers, behavior"
          title="Studio — tools, MCP servers, behavior"
        >
          <SlidersHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        className="w-60 rounded-2xl border-border/80 bg-popover p-1.5 shadow-[0_24px_60px_-24px_rgba(35,20,28,0.45)]"
      >
        <DropdownMenuLabel className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Studio
        </DropdownMenuLabel>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="gap-2 rounded-xl px-2 py-2 text-[13px]">
            <Wrench className="h-4 w-4 text-muted-foreground" />
            Tools
            <span className="ml-auto rounded-full bg-foreground/5 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {toolsOn} on
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            sideOffset={6}
            className="w-64 rounded-2xl border-border/80 bg-popover p-1.5 shadow-xl"
          >
            {TOOL_MENU.map((tool) => {
              const Icon = tool.icon;
              return (
                <DropdownMenuCheckboxItem
                  key={tool.id}
                  checked={settings.builtinTools[tool.id]}
                  onCheckedChange={() => toggleBuiltin(tool.id)}
                  onSelect={(event) => event.preventDefault()}
                  className="rounded-xl py-2 text-[13px]"
                >
                  <Icon className="mr-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{tool.label}</span>
                  <span className="ml-2 shrink-0 text-[10px] text-muted-foreground/80">{tool.hint}</span>
                </DropdownMenuCheckboxItem>
              );
            })}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="gap-2 rounded-xl px-2 py-2 text-[13px]">
            <Plug className="h-4 w-4 text-muted-foreground" />
            MCP servers
            {liveCount > 0 ? (
              <span className="ml-auto rounded-full bg-emerald-600/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                {liveCount} live
              </span>
            ) : null}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            sideOffset={6}
            className="w-60 rounded-2xl border-border/80 bg-popover p-1.5 shadow-xl"
          >
            {servers.length === 0 ? (
              <p className="px-2 py-2 text-xs leading-relaxed text-muted-foreground">
                No servers yet — connect Notion, GitHub, Linear and more from the catalog.
              </p>
            ) : (
              servers.map((server) => (
                <DropdownMenuCheckboxItem
                  key={server.id}
                  checked={server.enabled}
                  onCheckedChange={(checked) => updateMcp(server.id, { enabled: checked === true })}
                  onSelect={(event) => event.preventDefault()}
                  className="rounded-xl py-2 text-[13px]"
                >
                  <ServerFavicon server={server} />
                  <span className="min-w-0 flex-1 truncate">{server.name || "Untitled server"}</span>
                  <span
                    className={cn(
                      "ml-2 h-1.5 w-1.5 shrink-0 rounded-full",
                      server.status === "connected"
                        ? "bg-emerald-500"
                        : server.status === "error"
                          ? "bg-red-500"
                          : server.status === "connecting"
                            ? "bg-amber-500"
                            : "bg-muted-foreground/30",
                    )}
                  />
                </DropdownMenuCheckboxItem>
              ))
            )}
            <DropdownMenuSeparator className="bg-border/60" />
            <DropdownMenuItem
              onSelect={() => navigate("/mcp")}
              className="gap-2 rounded-xl px-2 py-2 text-[13px]"
            >
              <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
              Manage & browse catalog…
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator className="bg-border/60" />
        <DropdownMenuCheckboxItem
          checked={settings.autoTools}
          onCheckedChange={(checked) => setAutoTools(checked === true)}
          onSelect={(event) => event.preventDefault()}
          className="rounded-xl py-2 text-[13px]"
        >
          <span className="flex min-w-0 flex-col">
            <span>Auto tool routing</span>
            <span className="text-[10px] leading-tight text-muted-foreground">
              Gera picks tools & servers per prompt
            </span>
          </span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={state.life.memoryEnabled}
          onCheckedChange={(checked) => updateLife((prev) => ({ ...prev, memoryEnabled: checked === true }))}
          onSelect={(event) => event.preventDefault()}
          className="rounded-xl py-2 text-[13px]"
        >
          <span className="flex min-w-0 flex-col">
            <span>Memory</span>
            <span className="text-[10px] leading-tight text-muted-foreground">
              {state.life.memoryEnabled ? "Saves & recalls facts from chat" : "Off — no saving, no recall"}
            </span>
          </span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator className="bg-border/60" />
        <DropdownMenuItem
          onSelect={() => navigate("/settings")}
          className="gap-2 rounded-xl px-2 py-2 text-[13px]"
        >
          <Settings2 className="h-4 w-4 text-muted-foreground" />
          System prompt & advanced…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Tiny brand favicon for MCP rows in the studio menu; falls back to a plug glyph. */
function ServerFavicon({ server }: { server: McpServerConfig }) {
  const [failed, setFailed] = useState<boolean>(false);
  const url = serverIconUrl(server);
  if (!url || failed) {
    return <Plug className="mr-2 h-4 w-4 shrink-0 text-muted-foreground/70" />;
  }
  return (
    <span className="mr-2 flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded-[5px] border border-border/50 bg-white">
      <img
        src={url}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        className="h-3 w-3 object-contain"
      />
    </span>
  );
}

function OptionChip({
  label,
  active,
  onClick,
  title,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={cn(
        "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
        active
          ? "border-ember/60 bg-ember/10 text-ember"
          : "border-border/70 text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}
