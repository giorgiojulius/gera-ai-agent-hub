/**
 * Platform-neutral element identifiers — the single source of truth for every
 * E2E driver.
 *
 * Web components attach them as `data-testid={TID.x}` (queried by the vitest
 * browser / Playwright driver). The future mobile app attaches the SAME
 * constants as `testID={TID.x}` (queried by Detox/Maestro/XCUITest). One
 * registry means the shared scenario catalog (`e2e/scenarios.ts`) drives real
 * clicks on every platform and every run lands in the same stats format.
 *
 * Zero dependencies on purpose — safe to import from any app target.
 */
export const TID = {
  /** Empty-thread hero screen with the big composer. */
  launchpad: "launchpad",
  /** Starter-prompt chip row under the hero composer — hidden while typing. */
  launchpadStarters: "launchpad-starters",
  /** Main prompt textarea inside the composer. */
  composerInput: "composer-input",
  /** Round send button in the composer's bottom rail. */
  composerSend: "composer-send",
  /** Round stop button shown while the thread's run is live. */
  composerStop: "composer-stop",
  /** Drop-files overlay covering the prompt card while files are dragged over it. */
  composerDropZone: "composer-drop-zone",
  /** One queued attachment chip above the composer (repeats). */
  composerAttachment: "composer-attachment",
  /** Scrollable message thread container. */
  chatThread: "chat-thread",
  /** One user message row (repeats per turn). */
  messageUser: "message-user",
  /** One assistant message row (repeats per turn). */
  messageAssistant: "message-assistant",
  /** Evidence-backed outcome receipt under an autonomous agent reply. */
  executionOutcome: "execution-outcome",
  /** Live repository edit workbench inside an assistant turn. */
  codeChangeFlow: "code-change-flow",
  /** Changes tab inside the repository edit workbench. */
  codeChangeChangesTab: "code-change-changes-tab",
  /** Preview tab inside the repository edit workbench. */
  codeChangePreviewTab: "code-change-preview-tab",
  /** Sandboxed iframe running committed HTML or a real deployment URL. */
  codeChangePreview: "code-change-preview",
  /** "New chat" action in the navigation rail. */
  sidebarNewChat: "sidebar-new-chat",
  /** One saved conversation row in the rail (repeats). */
  sidebarThread: "sidebar-thread",
  /** Run-mode selector trigger in the composer rail (Standard / Deep research / Julius). */
  composerModeTrigger: "composer-mode-trigger",
  /** Gear beside the run-mode pill — opens the engaged mode's settings popover. */
  composerModeConfig: "composer-mode-config",
  /** Body of the run-mode settings popover (research depth / Julius panel). */
  composerModeConfigPanel: "composer-mode-config-panel",
  /** The one Skills button in the rail — its badge counts packs riding the active run mode. */
  composerSkills: "composer-skills",
  /** Body of the Skills popover (per-surface toggles). */
  composerSkillsPanel: "composer-skills-panel",
  /** GitHub repo pin in the composer rail — shown only when the GitHub connector is on. */
  composerRepo: "composer-repo",
  /** Body of the repo-pin popover (search + repo list). */
  composerRepoPanel: "composer-repo-panel",
  /** One repository choice inside the GitHub pin popover (repeats). */
  composerRepoOption: "composer-repo-option",
  /** "Can't see a private repo?" trigger inside the repo-pin popover. */
  composerRepoDiagnose: "composer-repo-diagnose",
  /** Verdict card of the repo access check. */
  composerRepoVerdict: "composer-repo-verdict",
  /** Cloud-play action shown beside a pinned repository. */
  composerRepoLaunch: "composer-repo-launch",
  /** Repository launch configuration and one-time runner setup dialog. */
  repoLaunchDialog: "repo-launch-dialog",
  /** Explicit setup-PR action for the bounded repository runner. */
  repoLaunchInstall: "repo-launch-install",
  /** Starts one immutable repository build. */
  repoLaunchStart: "repo-launch-start",
  /** Durable Rork web-repository launch receipt in the thread. */
  repoPreviewFlow: "repo-preview-flow",
  /** Sandboxed iframe serving the built repository from Rork storage. */
  repoPreviewFrame: "repo-preview-frame",
  /** Expands/collapses the bounded redacted build log. */
  repoPreviewLogs: "repo-preview-logs",
  /** Stops an active repository launch. */
  repoPreviewStop: "repo-preview-stop",
  /** Starts a fresh build of a terminal repository launch. */
  repoPreviewRebuild: "repo-preview-rebuild",
  /** v0-style dock to the right of the thread hosting the live repository preview (desktop). */
  repoPreviewPanel: "repo-preview-panel",
  /** Closes the docked preview panel for the active thread. */
  repoPreviewPanelClose: "repo-preview-panel-close",
  /** Browser-style tab strip in the dock; appears once the preview opened a second page. */
  repoPreviewTabs: "repo-preview-tabs",
  /** One page tab in the dock (label + close). */
  repoPreviewTab: "repo-preview-tab",
  /** Address bar of the active dock tab (host + in-app route). */
  repoPreviewAddress: "repo-preview-address",
  /** Dock tab body standing in for a popup that is not an in-preview page (empty page or real window). */
  repoPreviewPopupPage: "repo-preview-popup-page",
  /** Retries the real window behind a popup tab after the browser blocked it. */
  repoPreviewWindowOpen: "repo-preview-window-open",
  /** Model picker trigger in the composer rail. */
  modelPickerTrigger: "model-picker-trigger",
  /** "Model" row in the chat picker's root menu — opens the catalog submenu. */
  modelPickerModelRow: "model-picker-model-row",
  /** "More" row after Grok, Sol, Fable and Luna — opens the rest of the chat catalog. */
  modelPickerMoreRow: "model-picker-more-row",
  /** "Effort" row in the chat picker's root menu — opens the thinking-budget submenu. */
  modelPickerEffortRow: "model-picker-effort-row",
  /** "Reset to default" row in the chat picker's root menu. */
  modelPickerReset: "model-picker-reset",
  /** Root of the workspace (studio) page shell. */
  studioShell: "studio-shell",
  /** "New project" action on the Projects page. */
  projectCreate: "project-create",
  /** One project card on the Projects page (repeats). */
  projectCard: "project-card",
  /** Root of one project's workspace (channels + agents + members). */
  projectSpace: "project-space",
  /** Message composer input inside a project channel. */
  projectComposer: "project-composer",
  /** Root of the project's Settings tab (rename, channels, Slack, delete). */
  projectSettings: "project-settings",
  /** "New screen" action on the project's Screens tab (admins). */
  projectScreenCreate: "project-screen-create",
  /** One screen card on the project's Screens tab (repeats). */
  projectScreenCard: "project-screen-card",
  /** Root of one screen's desk (inbox + thread + details panel). */
  screenDesk: "screen-desk",
  /** Intercom-style details panel on a screen desk (assignee, user data). */
  screenDeskDetails: "screen-desk-details",
  /** Floating live-chat launcher for the desk's AI assistant. */
  screenDeskAssistant: "screen-desk-assistant",
  /** The assistant's fixed floating panel (open state). */
  screenDeskAssistantPanel: "screen-desk-assistant-panel",
  /** Gera's reply-suggestion strip above the desk composer. */
  screenDeskSuggest: "screen-desk-suggest",
  /** Header button opening the desk's team-performance panel. */
  screenDeskPerformance: "screen-desk-performance",
  /** Full-screen team-performance panel (stats, grades, coaching, links). */
  screenDeskPerformancePanel: "screen-desk-performance-panel",
  /** Date-range controls for filtering and collecting team performance. */
  screenDeskPerformanceDates: "screen-desk-performance-dates",
  /** Starts a deep Intercom collection and grading pass. */
  screenDeskPerformanceAnalyze: "screen-desk-performance-analyze",
  /** Clears harvested team-performance results while preserving links. */
  screenDeskPerformanceClear: "screen-desk-performance-clear",
  /** "Already in Slack" awareness section inside the desk suggest strip. */
  screenDeskSlack: "screen-desk-slack",
  /** Inline "Ask Gera" investigation card (running / answer) in the strip. */
  screenDeskAsk: "screen-desk-ask",
  /** First-party "Recent page views" block inside the desk details panel. */
  screenDeskPageViews: "screen-desk-page-views",
  /** Admin dialog with the page-view tracking snippet. */
  screenDeskTrackingSetup: "screen-desk-tracking-setup",
  /** Sectioned automation editor — addressed at /automations/new|<id>. */
  automationEditor: "automation-editor",
  /** Sectioned profile editor — addressed at /profiles/new|<id>. */
  profileEditor: "profile-editor",
  /** Sectioned skill editor — addressed at /skills/new|<id>. */
  skillEditor: "skill-editor",
  /** Project/screen shortcut strip at the top of the empty home screen. */
  homeShortcuts: "home-shortcuts",
  /** One-tap profile monogram row at the hero composer's top right. */
  composerProfiles: "composer-profiles",
} as const;

/** All registry values, for uniqueness checks in tests. */
export type TestId = (typeof TID)[keyof typeof TID];

/** Row for one model inside the model picker catalog. */
export function modelOptionTid(modelId: string): string {
  return `model-option-${modelId}`;
}

/** Row for one thinking budget in the chat picker ("default", "low", "medium", "high", "xhigh"). */
export function effortOptionTid(effort: string): string {
  return `effort-option-${effort}`;
}

/** Row for one run mode inside the composer mode menu ("standard", "research", "julius", "both"). */
export function runModeOptionTid(mode: string): string {
  return `run-mode-option-${mode}`;
}

/** Connect action for one catalog MCP entry. */
export function mcpCatalogConnectTid(serverId: string): string {
  return `mcp-catalog-connect-${serverId}`;
}

/** Connected/configured MCP card in "Your tools". */
export function mcpServerCardTid(serverId: string): string {
  return `mcp-server-${serverId}`;
}

/** Content root of one workspace page (automations, hub, mcp, settings…). */
export function studioPageTid(page: string): string {
  return `page-${page}`;
}

/** Segmented tab that navigates to one workspace page. */
export function studioTabTid(page: string): string {
  return `nav-tab-${page}`;
}
