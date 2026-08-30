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
  /** Main prompt textarea inside the composer. */
  composerInput: "composer-input",
  /** Round send button in the composer's bottom rail. */
  composerSend: "composer-send",
  /** Round stop button shown while the thread's run is live. */
  composerStop: "composer-stop",
  /** Scrollable message thread container. */
  chatThread: "chat-thread",
  /** One user message row (repeats per turn). */
  messageUser: "message-user",
  /** One assistant message row (repeats per turn). */
  messageAssistant: "message-assistant",
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
  /** Model picker trigger in the composer rail. */
  modelPickerTrigger: "model-picker-trigger",
  /** "Model" row in the chat picker's root menu — opens the catalog submenu. */
  modelPickerModelRow: "model-picker-model-row",
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
  /** Gera's reply-suggestion strip above the desk composer. */
  screenDeskSuggest: "screen-desk-suggest",
  /** Header button opening the desk's team-performance panel. */
  screenDeskPerformance: "screen-desk-performance",
  /** Full-screen team-performance panel (stats, grades, coaching, links). */
  screenDeskPerformancePanel: "screen-desk-performance-panel",
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

/** Content root of one workspace page (automations, hub, mcp, settings…). */
export function studioPageTid(page: string): string {
  return `page-${page}`;
}

/** Segmented tab that navigates to one workspace page. */
export function studioTabTid(page: string): string {
  return `nav-tab-${page}`;
}
