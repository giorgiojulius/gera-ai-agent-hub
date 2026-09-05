import {
  TID,
  composerMcpItemTid,
  effortOptionTid,
  mcpArgsFieldTid,
  mcpCatalogConnectTid,
  mcpLoadingOptionTid,
  mcpServerCardTid,
  mcpServerConnectTid,
  mcpServerEnabledTid,
  modelOptionTid,
  runModeOptionTid,
  runPauseFieldTid,
  studioPageTid,
  studioTabTid,
} from "../src/lib/testids";

import type { E2eScenario } from "./types";

/**
 * Platform-agnostic click-flow catalog. Every step speaks testids from the
 * shared registry, so the web driver runs these today and the mobile driver
 * will run the exact same list — results aggregate in one stats table.
 *
 * Scenario ids are stable API: stats history keys on them. Rename with care.
 */

/** Snippet of the deterministic assistant reply each platform's stub streams. */
export const STUB_REPLY_SNIPPET = "Gera e2e reply";

/**
 * Prompt marker that makes the platform stub stream hang without a terminal
 * event while /runs/stop answers "not_running" — the production shape behind
 * "stop only works after a page reload".
 */
export const STUB_HANG_PROMPT = "Hang this run for the stop regression";

/** Prompt marker that makes the platform stub stream a code edit + runnable HTML preview. */
export const STUB_CODE_PROMPT = "Build a tiny runnable code preview";

/** Prompt marker that makes the platform stub stream a deferred MCP search + call before the reply. */
export const STUB_MCP_PROMPT = "Ask DeepWiki through the deferred MCP tools";

/** Server · tool label the deferred MCP call row must show. */
export const STUB_MCP_CALL_LABEL = "deepwiki · ask_question";

/** Prompt marker that makes the platform stub pause the run on an MCP elicitation card before replying. */
export const STUB_ELICIT_PROMPT = "Deploy through the MCP server that asks for a region";

/** MCP server / prompt / resource the platform stub lists for the composer menus. */
export const STUB_MCP_SERVER_ID = "deepwiki";
export const STUB_MCP_PROMPT_NAME = "explain_repo";
export const STUB_MCP_PROMPT_ARG = "repoName";
/** Text the stubbed prompts/get returns — must land in the composer input. */
export const STUB_MCP_PROMPT_TEXT = "Explain the repository acme/private-app in plain words";
export const STUB_MCP_RESOURCE_URI = "wiki://acme/private-app/README";
/** Attachment label the stubbed resources/read produces (server · file name). */
export const STUB_MCP_RESOURCE_LABEL = "README";
/** Field the stubbed elicitation asks for. */
export const STUB_ELICIT_FIELD = "region";

/** Prompt marker that makes the platform stub pause the run on a write-tool confirmation card before replying. */
export const STUB_CONFIRM_PROMPT = "Create the release issue through the MCP server";
/** Tool the stubbed confirmation card guards. */
export const STUB_CONFIRM_TOOL = "create_issue";

/** Custom OAuth server signed in through the stubbed server-side flow; its grant lives only in the vault. */
export const STUB_VAULT_OAUTH_SERVER_ID = "vault-oauth";
export const STUB_VAULT_OAUTH_IDENTITY = "Vault Things · server verified";
/** OAuth server whose grant an older bundle kept in this browser — retired on boot. */
export const STUB_LEGACY_OAUTH_SERVER_ID = "legacy-oauth";

/** Custom OAuth server whose stubbed /mcp/check reports a pending scope step-up. */
export const STUB_STEP_UP_SERVER_ID = "scoped";
/** Scope the stubbed insufficient_scope challenge demanded. */
export const STUB_STEP_UP_SCOPE = "things:write";

/** Curated chat model every platform's picker must offer. */
export const SWITCH_TARGET_MODEL_ID = "anthropic/claude-opus-5";
export const SWITCH_TARGET_MODEL_NAME = "Claude Opus 5";

export const E2E_SCENARIOS: E2eScenario[] = [
  {
    id: "boot-to-launchpad",
    title: "Boot lands on the launchpad behind the invite gate",
    steps: [
      { do: "goto", path: "/" },
      { do: "see", target: TID.launchpad, timeoutMs: 20_000 },
      { do: "see", target: TID.composerInput },
      { do: "see", target: TID.sidebarNewChat },
    ],
  },
  {
    id: "starters-hide-while-typing",
    title: "Starter chips fade away while a prompt is being written",
    steps: [
      { do: "goto", path: "/" },
      { do: "see", target: TID.launchpadStarters, timeoutMs: 20_000 },
      { do: "fill", target: TID.composerInput, text: "Draft in progress" },
      { do: "notSee", target: TID.launchpadStarters },
      { do: "fill", target: TID.composerInput, text: "" },
      { do: "see", target: TID.launchpadStarters },
    ],
  },
  {
    id: "send-chat-message",
    title: "Sending a message renders the user turn and a streamed reply",
    steps: [
      { do: "goto", path: "/" },
      { do: "see", target: TID.composerInput, timeoutMs: 20_000 },
      { do: "fill", target: TID.composerInput, text: "Ping from the e2e suite" },
      { do: "tap", target: TID.composerSend },
      { do: "see", target: TID.chatThread },
      { do: "seeText", target: TID.messageUser, text: "Ping from the e2e suite" },
      { do: "seeText", target: TID.messageAssistant, text: STUB_REPLY_SNIPPET, timeoutMs: 20_000 },
      // Every chat gets its own address once it has a message.
      { do: "urlContains", text: "/c/" },
    ],
  },
  {
    id: "code-changes-preview",
    title: "Code edits open a live Changes workbench and runnable preview",
    steps: [
      { do: "goto", path: "/" },
      { do: "see", target: TID.composerInput, timeoutMs: 20_000 },
      { do: "fill", target: TID.composerInput, text: STUB_CODE_PROMPT },
      { do: "tap", target: TID.composerSend },
      { do: "seeText", target: TID.codeChangeFlow, text: "index.html", timeoutMs: 20_000 },
      { do: "tap", target: TID.codeChangeChangesTab },
      { do: "seeText", target: TID.codeChangeFlow, text: "Hello from preview" },
      { do: "tap", target: TID.codeChangePreviewTab },
      { do: "seeText", target: TID.codeChangeFlow, text: "Preview running" },
      { do: "see", target: TID.codeChangePreview },
    ],
  },
  {
    id: "new-chat-keeps-history",
    title: "New chat returns to the launchpad and keeps the thread listed",
    steps: [
      { do: "goto", path: "/" },
      { do: "see", target: TID.composerInput, timeoutMs: 20_000 },
      { do: "fill", target: TID.composerInput, text: "Thread to keep" },
      { do: "tap", target: TID.composerSend },
      { do: "seeText", target: TID.messageAssistant, text: STUB_REPLY_SNIPPET, timeoutMs: 20_000 },
      { do: "tap", target: TID.sidebarNewChat },
      { do: "see", target: TID.launchpad },
      { do: "see", target: TID.sidebarThread },
    ],
  },
  {
    id: "github-pin-and-send",
    title: "GitHub repo picker pins a private repo and carries it into a run",
    steps: [
      { do: "goto", path: "/" },
      { do: "see", target: TID.composerRepo, timeoutMs: 20_000 },
      { do: "tap", target: TID.composerRepo },
      { do: "see", target: TID.composerRepoPanel },
      { do: "tap", target: TID.composerRepoOption },
      { do: "seeText", target: TID.composerRepo, text: "private-app" },
      { do: "fill", target: TID.composerInput, text: "Inspect the pinned repository" },
      { do: "tap", target: TID.composerSend },
      { do: "seeText", target: TID.messageAssistant, text: STUB_REPLY_SNIPPET, timeoutMs: 20_000 },
    ],
  },
  {
    id: "github-launch-web-preview",
    title: "A pinned GitHub web repository launches into a live Rork preview",
    steps: [
      { do: "goto", path: "/" },
      { do: "see", target: TID.composerRepo, timeoutMs: 20_000 },
      { do: "tap", target: TID.composerRepo },
      { do: "see", target: TID.composerRepoPanel },
      { do: "tap", target: TID.composerRepoOption },
      { do: "tap", target: TID.composerRepoLaunch },
      { do: "see", target: TID.repoLaunchDialog },
      { do: "seeText", target: TID.repoLaunchDialog, text: "Vite · bun", timeoutMs: 20_000 },
      { do: "tap", target: TID.repoLaunchStart },
      { do: "seeText", target: TID.repoPreviewFlow, text: "Preview running", timeoutMs: 20_000 },
      { do: "see", target: TID.repoPreviewPanel },
      { do: "see", target: TID.repoPreviewFrame },
    ],
  },
  {
    id: "switch-chat-model",
    title: "The picker offers Astra and Grok in quick choices and opens the rest under More",
    steps: [
      { do: "goto", path: "/" },
      { do: "see", target: TID.composerInput, timeoutMs: 20_000 },
      { do: "tap", target: TID.modelPickerTrigger },
      { do: "tap", target: TID.modelPickerModelRow },
      { do: "see", target: modelOptionTid("openai/gpt-6-astra") },
      { do: "see", target: modelOptionTid("spacexai/grok-4.6") },
      { do: "notSee", target: modelOptionTid("openai/gpt-6-astra-fast") },
      { do: "see", target: modelOptionTid("openai/gpt-5.6-sol") },
      { do: "see", target: modelOptionTid("anthropic/claude-fable-5.1") },
      { do: "see", target: modelOptionTid("openai/gpt-5.6-luna") },
      { do: "tap", target: modelOptionTid("openai/gpt-6-astra") },
      { do: "seeText", target: TID.modelPickerTrigger, text: "GPT-6 Astra" },
      { do: "tap", target: TID.modelPickerTrigger },
      { do: "tap", target: TID.modelPickerModelRow },
      { do: "tap", target: modelOptionTid("spacexai/grok-4.6") },
      { do: "seeText", target: TID.modelPickerTrigger, text: "Grok 4.6" },
      { do: "tap", target: TID.modelPickerTrigger },
      { do: "tap", target: TID.modelPickerModelRow },
      { do: "tap", target: TID.modelPickerMoreRow },
      { do: "notSee", target: modelOptionTid("openai/gpt-6-astra") },
      { do: "notSee", target: modelOptionTid("spacexai/grok-4.6") },
      { do: "notSee", target: modelOptionTid("openai/gpt-6-astra-fast") },
      { do: "tap", target: modelOptionTid(SWITCH_TARGET_MODEL_ID) },
      { do: "seeText", target: TID.modelPickerTrigger, text: SWITCH_TARGET_MODEL_NAME },
    ],
  },
  {
    id: "switch-chat-effort",
    title: "The picker's Effort submenu pins the thinking budget",
    steps: [
      { do: "goto", path: "/" },
      { do: "see", target: TID.composerInput, timeoutMs: 20_000 },
      { do: "tap", target: TID.modelPickerTrigger },
      { do: "tap", target: TID.modelPickerEffortRow },
      { do: "tap", target: effortOptionTid("medium") },
      { do: "seeText", target: TID.modelPickerTrigger, text: "Medium" },
    ],
  },
  {
    id: "switch-run-mode",
    title: "The model-style run-mode picker engages Deep research",
    steps: [
      { do: "goto", path: "/" },
      { do: "see", target: TID.composerInput, timeoutMs: 20_000 },
      { do: "tap", target: TID.composerModeTrigger },
      { do: "tap", target: runModeOptionTid("research") },
      { do: "seeText", target: TID.composerModeTrigger, text: "Deep research" },
    ],
  },
  {
    id: "run-mode-settings-panel",
    title: "The engaged run mode's gear opens its settings panel",
    steps: [
      { do: "goto", path: "/" },
      { do: "see", target: TID.composerInput, timeoutMs: 20_000 },
      { do: "tap", target: TID.composerModeTrigger },
      { do: "tap", target: runModeOptionTid("research") },
      { do: "tap", target: TID.composerModeConfig },
      { do: "see", target: TID.composerModeConfigPanel },
      { do: "seeText", target: TID.composerModeConfigPanel, text: "Balanced" },
    ],
  },
  {
    id: "skills-rail-panel",
    title: "The rail Skills button opens the per-mode packs panel",
    steps: [
      { do: "goto", path: "/" },
      { do: "see", target: TID.composerInput, timeoutMs: 20_000 },
      { do: "tap", target: TID.composerSkills },
      { do: "see", target: TID.composerSkillsPanel },
      { do: "seeText", target: TID.composerSkillsPanel, text: "Skills" },
    ],
  },
  {
    id: "projects-page-opens",
    title: "Projects page renders with the create action behind the gate",
    steps: [
      { do: "goto", path: "/projects" },
      { do: "see", target: studioPageTid("projects"), timeoutMs: 20_000 },
      { do: "see", target: TID.projectCreate },
    ],
  },
  {
    id: "studio-pages-navigate",
    title: "Workspace tabs hop between Automations, Hub, MCP and Settings",
    steps: [
      { do: "goto", path: "/automations" },
      { do: "see", target: studioPageTid("automations"), timeoutMs: 20_000 },
      { do: "tap", target: studioTabTid("hub") },
      { do: "see", target: studioPageTid("hub") },
      { do: "tap", target: studioTabTid("mcp") },
      { do: "see", target: studioPageTid("mcp") },
      { do: "tap", target: studioTabTid("settings") },
      { do: "see", target: studioPageTid("settings") },
    ],
  },
  {
    id: "connect-open-mcp",
    title: "An open MCP catalog server handshakes and lists its tools",
    steps: [
      { do: "goto", path: "/mcp" },
      { do: "see", target: studioPageTid("mcp"), timeoutMs: 20_000 },
      { do: "tap", target: mcpCatalogConnectTid("deepwiki") },
      { do: "seeText", target: mcpServerCardTid("deepwiki"), text: "1 tools", timeoutMs: 20_000 },
    ],
  },
  {
    id: "mcp-deploy-recovery",
    title: "MCP cards recover stored deployment errors without replacing credentials",
    steps: [
      { do: "goto", path: "/mcp" },
      { do: "seeText", target: mcpServerCardTid("github"), text: "GitHub · recovered", timeoutMs: 20_000 },
      { do: "seeText", target: mcpServerCardTid("intercom"), text: "Intercom · recovered", timeoutMs: 20_000 },
      { do: "seeText", target: mcpServerCardTid("testerarmy"), text: "TesterArmy · recovered", timeoutMs: 20_000 },
    ],
  },
  {
    id: "mcp-cancel-check",
    title: "Disabling an in-flight MCP check leaves Connect usable on re-enable",
    steps: [
      { do: "goto", path: "/mcp" },
      { do: "see", target: mcpServerCardTid("cancel-check"), timeoutMs: 20_000 },
      { do: "tap", target: mcpServerConnectTid("cancel-check") },
      { do: "seeText", target: mcpServerCardTid("cancel-check"), text: "Connecting…" },
      { do: "tap", target: mcpServerEnabledTid("cancel-check") },
      { do: "tap", target: mcpServerEnabledTid("cancel-check") },
      { do: "seeText", target: mcpServerConnectTid("cancel-check"), text: "Connect" },
      { do: "tap", target: mcpServerConnectTid("cancel-check") },
      { do: "seeText", target: mcpServerCardTid("cancel-check"), text: "Fresh check verified", timeoutMs: 20_000 },
    ],
  },
  {
    id: "blender-mcp-setup",
    title: "Blender setup explains the local bridge, rejects localhost and never creates a phantom connection",
    steps: [
      { do: "goto", path: "/mcp" },
      { do: "see", target: TID.mcpCatalogSearch, timeoutMs: 20_000 },
      { do: "fill", target: TID.mcpCatalogSearch, text: "Blender" },
      { do: "tap", target: mcpCatalogConnectTid("blender") },
      { do: "see", target: TID.blenderSetup },
      { do: "seeText", target: TID.blenderGuide, text: "9876" },
      { do: "seeText", target: TID.blenderGuide, text: "Service Auth" },
      { do: "notSee", target: mcpServerCardTid("blender") },
      { do: "fill", target: TID.blenderEndpoint, text: "http://localhost:9876" },
      { do: "tap", target: TID.blenderConnect },
      { do: "seeText", target: TID.blenderSetup, text: "Gera cannot reach localhost" },
      { do: "notSee", target: mcpServerCardTid("blender") },
      { do: "tap", target: TID.blenderCancel },
      { do: "notSee", target: TID.blenderSetup },
      { do: "notSee", target: mcpServerCardTid("blender") },
    ],
  },
  {
    id: "blender-mcp-connect",
    title: "A protected Blender bridge is verified through the existing MCP path (stubbed)",
    steps: [
      { do: "goto", path: "/mcp" },
      { do: "see", target: TID.mcpCatalogSearch, timeoutMs: 20_000 },
      { do: "fill", target: TID.mcpCatalogSearch, text: "Blender" },
      { do: "tap", target: mcpCatalogConnectTid("blender") },
      { do: "fill", target: TID.blenderEndpoint, text: "https://blender.example.com/mcp" },
      { do: "fill", target: TID.blenderClientId, text: "test-client.access" },
      { do: "fill", target: TID.blenderClientSecret, text: "test-service-credential" },
      { do: "tap", target: TID.blenderAcknowledge },
      { do: "tap", target: TID.blenderConnect },
      { do: "notSee", target: TID.blenderSetup },
      { do: "seeText", target: mcpServerCardTid("blender"), text: "get_scene_info", timeoutMs: 20_000 },
      { do: "seeText", target: mcpServerCardTid("blender"), text: "2 tools" },
    ],
  },
  {
    id: "connect-open-mcp-deferred",
    title: "Deferred MCP loading rides into the run and its meta calls read like native tools",
    steps: [
      { do: "goto", path: "/settings" },
      { do: "see", target: studioPageTid("settings"), timeoutMs: 20_000 },
      { do: "see", target: TID.settingsMcpLoading },
      { do: "tap", target: mcpLoadingOptionTid("deferred") },
      { do: "goto", path: "/" },
      { do: "see", target: TID.composerInput, timeoutMs: 20_000 },
      { do: "fill", target: TID.composerInput, text: STUB_MCP_PROMPT },
      { do: "tap", target: TID.composerSend },
      // The search + call rows render as "MCP · server · tool" with the same
      // status chip a natively armed tool gets.
      { do: "seeText", target: TID.messageToolCall, text: STUB_MCP_CALL_LABEL, timeoutMs: 20_000 },
      { do: "seeText", target: TID.messageToolCall, text: "done" },
      { do: "seeText", target: TID.messageAssistant, text: STUB_REPLY_SNIPPET, timeoutMs: 20_000 },
    ],
  },
  {
    id: "prompt-slash",
    title: "Slash menu lists MCP prompts, collects arguments, and inserts the prompt text",
    steps: [
      { do: "goto", path: "/" },
      { do: "see", target: TID.composerInput, timeoutMs: 20_000 },
      { do: "fill", target: TID.composerInput, text: "/expl" },
      { do: "see", target: TID.composerMcpMenu, timeoutMs: 15_000 },
      { do: "tap", target: composerMcpItemTid("prompt", STUB_MCP_SERVER_ID, STUB_MCP_PROMPT_NAME) },
      // The prompt declares a required argument → the form opens first.
      { do: "see", target: TID.mcpArgsDialog },
      { do: "fill", target: mcpArgsFieldTid(STUB_MCP_PROMPT_ARG), text: "acme/private-app" },
      { do: "tap", target: TID.mcpArgsSubmit },
      { do: "seeValue", target: TID.composerInput, text: STUB_MCP_PROMPT_TEXT, timeoutMs: 15_000 },
      { do: "notSee", target: TID.mcpArgsDialog },
    ],
  },
  {
    id: "resource-mention",
    title: "@ menu lists MCP resources and attaches the one picked",
    steps: [
      { do: "goto", path: "/" },
      { do: "see", target: TID.composerInput, timeoutMs: 20_000 },
      { do: "fill", target: TID.composerInput, text: "@READ" },
      { do: "see", target: TID.composerMcpMenu, timeoutMs: 15_000 },
      { do: "tap", target: composerMcpItemTid("resource", STUB_MCP_SERVER_ID, STUB_MCP_RESOURCE_URI) },
      { do: "seeText", target: TID.composerAttachment, text: STUB_MCP_RESOURCE_LABEL, timeoutMs: 15_000 },
      // The mention stays in the message so the model knows what was attached.
      { do: "seeValue", target: TID.composerInput, text: `@${STUB_MCP_SERVER_ID}/${STUB_MCP_RESOURCE_URI}` },
    ],
  },
  {
    id: "elicitation-accept",
    title: "An MCP elicitation pauses the run on a card; accepting resumes it",
    steps: [
      { do: "goto", path: "/" },
      { do: "see", target: TID.composerInput, timeoutMs: 20_000 },
      { do: "tap", target: TID.sidebarNewChat },
      { do: "fill", target: TID.composerInput, text: STUB_ELICIT_PROMPT },
      { do: "tap", target: TID.composerSend },
      { do: "see", target: TID.runPauseCard, timeoutMs: 20_000 },
      { do: "fill", target: runPauseFieldTid(STUB_ELICIT_FIELD), text: "eu" },
      { do: "tap", target: TID.runPauseAccept },
      { do: "seeText", target: TID.messageAssistant, text: STUB_REPLY_SNIPPET, timeoutMs: 20_000 },
      { do: "notSee", target: TID.runPauseCard },
    ],
  },
  {
    id: "mcp-confirm-card",
    title: "With confirmations on, a write tool pauses the run on a card; Run once resumes it",
    steps: [
      // The account switch rides into the run config as a snapshot.
      { do: "goto", path: "/settings" },
      { do: "see", target: studioPageTid("settings"), timeoutMs: 20_000 },
      { do: "tap", target: TID.settingsConfirmWrites },
      { do: "goto", path: "/" },
      { do: "see", target: TID.composerInput, timeoutMs: 20_000 },
      { do: "tap", target: TID.sidebarNewChat },
      { do: "fill", target: TID.composerInput, text: STUB_CONFIRM_PROMPT },
      { do: "tap", target: TID.composerSend },
      { do: "see", target: TID.runConfirmCard, timeoutMs: 20_000 },
      // The card names the tool and server and shows the redacted arguments.
      { do: "seeText", target: TID.runConfirmCard, text: STUB_CONFIRM_TOOL },
      { do: "seeText", target: TID.runConfirmCard, text: "•••" },
      { do: "see", target: TID.runConfirmAlways },
      { do: "see", target: TID.runConfirmDecline },
      { do: "tap", target: TID.runConfirmOnce },
      { do: "seeText", target: TID.messageAssistant, text: STUB_REPLY_SNIPPET, timeoutMs: 20_000 },
      { do: "notSee", target: TID.runConfirmCard },
    ],
  },
  {
    id: "oauth-step-up",
    title: "A scope challenge shows “Sign in again with wider access” and the Advanced OAuth fields",
    steps: [
      // The card is focused by address; the boot re-check hits the stubbed
      // /mcp/check, which reports the step-up a run recorded.
      { do: "goto", path: `/mcp?server=${STUB_STEP_UP_SERVER_ID}` },
      { do: "see", target: studioPageTid("mcp"), timeoutMs: 20_000 },
      { do: "see", target: mcpServerCardTid(STUB_STEP_UP_SERVER_ID) },
      { do: "seeText", target: TID.mcpStepUpHint, text: STUB_STEP_UP_SCOPE, timeoutMs: 20_000 },
      { do: "see", target: TID.mcpStepUpSignIn },
      // Advanced stays collapsed until asked; both fields live behind it.
      { do: "notSee", target: TID.mcpScopesInput },
      { do: "tap", target: TID.mcpAdvancedToggle },
      { do: "see", target: TID.mcpScopesInput },
      { do: "see", target: TID.mcpMetadataUrlInput },
    ],
  },
  {
    id: "oauth-sign-in-vault",
    title: "OAuth sign-in ends with a verified green card and no token in this browser",
    steps: [
      { do: "goto", path: `/mcp?server=${STUB_VAULT_OAUTH_SERVER_ID}` },
      { do: "see", target: studioPageTid("mcp"), timeoutMs: 20_000 },
      { do: "see", target: mcpServerCardTid(STUB_VAULT_OAUTH_SERVER_ID) },
      { do: "seeText", target: mcpServerConnectTid(STUB_VAULT_OAUTH_SERVER_ID), text: "Sign in" },
      // The popup is a stub window; the account shard runs discovery, PKCE and
      // the code exchange, then the real /mcp/check proves the vault grant.
      { do: "tap", target: mcpServerConnectTid(STUB_VAULT_OAUTH_SERVER_ID) },
      { do: "seeText", target: mcpServerConnectTid(STUB_VAULT_OAUTH_SERVER_ID), text: "Re-check", timeoutMs: 20_000 },
      { do: "seeText", target: mcpServerCardTid(STUB_VAULT_OAUTH_SERVER_ID), text: STUB_VAULT_OAUTH_IDENTITY },
    ],
  },
  {
    id: "mcp-vault-migration",
    title: "A browser-held sign-in is retired on boot: the card asks to sign in again instead of failing red",
    steps: [
      { do: "goto", path: `/mcp?server=${STUB_LEGACY_OAUTH_SERVER_ID}` },
      { do: "see", target: studioPageTid("mcp"), timeoutMs: 20_000 },
      { do: "see", target: mcpServerCardTid(STUB_LEGACY_OAUTH_SERVER_ID) },
      { do: "seeText", target: TID.mcpResigninNotice, text: "sign in again" },
      { do: "seeText", target: mcpServerConnectTid(STUB_LEGACY_OAUTH_SERVER_ID), text: "Sign in" },
    ],
  },
  {
    id: "objects-have-addresses",
    title: "Editors and studio objects open straight from their URLs",
    steps: [
      { do: "goto", path: "/automations/new" },
      { do: "see", target: TID.automationEditor, timeoutMs: 20_000 },
      { do: "goto", path: "/skills/new" },
      { do: "see", target: TID.skillEditor },
      { do: "goto", path: "/profiles/new" },
      { do: "see", target: TID.profileEditor },
      { do: "goto", path: "/hub?tab=memory" },
      { do: "see", target: studioPageTid("hub") },
    ],
  },
  {
    id: "stop-run-settles-ui",
    title: "Stop settles the composer even when the run node lost the run",
    steps: [
      { do: "goto", path: "/" },
      { do: "see", target: TID.composerInput, timeoutMs: 20_000 },
      { do: "tap", target: TID.sidebarNewChat },
      { do: "fill", target: TID.composerInput, text: STUB_HANG_PROMPT },
      { do: "tap", target: TID.composerSend },
      { do: "see", target: TID.composerStop },
      { do: "tap", target: TID.composerStop },
      // The dead-button regression: the stub's /runs/stop says "not_running"
      // and the hanging stream never sends a terminal event — the composer
      // must return to Send without a page reload.
      { do: "see", target: TID.composerSend, timeoutMs: 10_000 },
    ],
  },
];
