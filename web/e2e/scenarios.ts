import {
  TID,
  effortOptionTid,
  mcpCatalogConnectTid,
  mcpServerCardTid,
  modelOptionTid,
  runModeOptionTid,
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
      { do: "see", target: TID.repoPreviewFrame },
    ],
  },
  {
    id: "switch-chat-model",
    title: "The picker keeps four primary models up front and opens the rest under More",
    steps: [
      { do: "goto", path: "/" },
      { do: "see", target: TID.composerInput, timeoutMs: 20_000 },
      { do: "tap", target: TID.modelPickerTrigger },
      { do: "tap", target: TID.modelPickerModelRow },
      { do: "see", target: modelOptionTid("spacexai/grok-4.6") },
      { do: "see", target: modelOptionTid("openai/gpt-5.6-sol") },
      { do: "see", target: modelOptionTid("anthropic/claude-fable-5.1") },
      { do: "see", target: modelOptionTid("openai/gpt-5.6-luna") },
      { do: "tap", target: TID.modelPickerMoreRow },
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
