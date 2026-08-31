# Gera Feature Map (user POV)

Last synced: 2026-08-31 · commit `a89fc17` (+ Luna suggestion model,
fable back in chat, note @-mentions, explicit inbox ranking, home &
composer shortcut strips, settings redesign, attachment image shrink,
stop/steering hardening, GitHub run credential hand-off + pin/access fixes,
truthful MCP health + OAuth/account-session/sleep-resume hardening,
authenticated file reads, Intercom attachments, full 98-entry MCP audit, and
the live code Changes / Preview workbench with sandboxed HTML and deployment
previews)
Drift check: `git log --oneline a89fc17..HEAD`, then compare against
`web/src/App.tsx` (routes), `StudioPageShell.tsx` (tabs), `testids.ts`,
`e2e/scenarios.ts`, `functions/index.ts` (worker routes).

Module layout after the 2026-08-29 splits (verbatim extractions, no behavior
change): `functions/chat-store.ts` keeps the ChatStore DO; shared caps and
coercers live in `functions/chat-shared.ts`, schedule math + webhook queues +
skills digest in `functions/automation-schedule.ts`, migration/registry
routes in `functions/chat-migration-routes.ts`. `web/src/hooks/use-agent.tsx`
keeps AgentProvider; the context contract is `hooks/agent-context.ts`, cloud
sync `hooks/use-cloud-sync.ts`, MCP actions `hooks/use-mcp-actions.ts`,
attachment intake `web/src/lib/attachments.ts`.

Projects (2026-08-29): `functions/project-store.ts` is the ProjectStore DO
(registry singleton + per-project shards + in-DO agent runs);
`functions/project-shared.ts` holds the platform-neutral contracts (roles,
caps, mentions, access→tool planning, screen-widget validation). Web:
`lib/projects.ts` API client, `pages/Projects.tsx` list,
`pages/ProjectSpace.tsx` workspace, `pages/ScreenDesk.tsx` screen desk,
`components/gera/projects/` (ChannelChat, AgentsPanel, MembersPanel,
ScreensPanel). The structured Intercom inbox API (typed rows for the desk
UI, not LLM strings) lives in `functions/native-intercom.ts`.

Contents: [Access gate](#access-gate) · [Navigation](#navigation) ·
[Chat](#chat-) · [Model picker](#model-picker) · [Threads](#threads--sidebar) ·
[Deep Research](#deep-research) · [Julius](#julius) · [Media modes](#media-modes) ·
[Profiles](#profiles-profiles) · [Skills](#skills-skills) ·
[Projects](#projects-projects) ·
[Automations](#automations-automations) · [Hub](#hub-hub) · [MCP](#mcp-mcp) ·
[Settings](#settings-settings) · [Admin](#admin-admin) · [Sharing](#sharing-sshareid) ·
[Notifications](#notifications-behavior) · [Worker routes](#worker-route-map) ·
[E2E coverage](#e2e-coverage)

## Access gate

Every app route is wrapped in `AccessGate`. The user signs in with Google or
Apple; the worker (`/access/status`) answers `invited` (app unlocks),
`pending` ("You're on the list", re-polls every 15s), or none (request-access
form with an optional note → `/access/request`). Sign-out is available from
every gate state. E2E bypasses the gate: fake JWT in `localStorage` +
stubbed `/access/status` → `invited`.

## Navigation

- Left sidebar (⌘B): New chat (`sidebar-new-chat`), thread rows
  (`sidebar-thread`), links to workspace pages.
- Workspace pages share `StudioPageShell` with segmented tabs
  (`nav-tab-<id>` → `page-<id>`): profiles, skills, projects, automations,
  hub, mcp, settings, admin (admin-only tab).
- Routes: `/` chat (blank draft) · `/c/:chatId` (every chat's own address) ·
  `/profiles` + `/profiles/new|:id` editor (old `/agents` redirects) ·
  `/skills` + `/skills/new|:id` editor · `/projects` + `/projects/:id`
  (workspace — normalizes to the first channel's address) +
  `/projects/:id/channels/:channelId` (`?thread=<root>` opens a thread) +
  `/projects/:id/{screens|agents|members}` tabs ·
  `/projects/:id/screens/:sid` desk (`?conversation=<id>` open case,
  `?panel=performance`) · `/automations` + `/automations/new|:id` editor ·
  `/hub?tab=trackers|tasks|memory` · `/mcp?server=<id>` (expanded card) ·
  `/settings` · `/admin?tab=people|arena|diagnostics` (old `/arena`
  redirects) · `/auth/callback`, `/oauth/callback` (OAuth returns) ·
  `/s/:shareId` (public) · `*` → NotFound.
- **Every object has an address.** Chats live at `/c/<id>` the moment they
  hold a message; the blank draft and incognito threads stay at `/`
  (incognito ids never enter browser history). The two-way URL↔state sync is
  `hooks/use-chat-url.ts`: links/back/forward select the chat, app actions
  rewrite the URL (push on switches, replace on boot/first-message/deletion),
  an id missing on this device waits for cloud sync (8s signed-in / 2s out)
  then honestly toasts "Chat not found" and lands on `/`. Editor addresses
  (automations/profiles/skills `/new|/<id>`) resolve after a 2.5s profile-sync
  grace, else toast + return to the list. Background-run toasts and desktop
  notifications navigate to the finished chat via the NavBridge
  (`lib/nav.ts`, registered inside the router in `App.tsx`).

## Chat (`/`)

Empty thread shows the Launchpad hero (`launchpad`) with the big composer
(`composer-input`, send `composer-send`). A thread renders `chat-thread`
with `message-user` / `message-assistant` rows (markdown, artifacts, media).

Code-change workbench (2026-08-31): the first repository branch/write call
streams a `code` run event and opens `code-change-flow` inside that assistant
turn — no need to wait for the final answer. Its live Branch → Changes → Checks
→ Preview rail mirrors real tool status; mutation chips are folded into this one
card while unrelated reads/tools stay visible. Changes (`code-change-changes-tab`)
shows the touched-file list, create/update/delete state, +/− totals, per-file
errors, and a bounded line diff. When the agent read the old GitHub file first,
the diff is old vs complete new body; without a readable old body it honestly
shows the available new/patch side instead of inventing a baseline. The ledger
survives snapshots, reconnects, sync, reload recovery, and resumed turns; large
HTML/diffs are the first optional payload trimmed under history limits.

Preview (`code-change-preview-tab`) starts automatically after a runnable result:
a committed standalone HTML page runs in `code-change-preview`, with CSS/JS files
changed in the same turn inlined when referenced locally. It runs in a sandboxed
iframe with no same-origin privilege. For built apps (React/Vite/etc.), Gera asks
GitHub for workflow/deployment status; a provider-published public HTTPS
`environment_url` becomes an embedded live preview plus Open link. If neither
committed HTML nor a real deployment URL exists, the tab says so — no fake local
server or invented URL. External preview, PR, and checks links accept HTTPS only,
reject embedded credentials, and synced workbench payloads are size/type
validated before rendering. Tests: `code-change-flow.test.ts`; E2E:
`code-changes-preview` switches Changes → Preview and sees the running iframe.

Above the greeting a Shortcuts strip (`home-shortcuts`, toggle in
Settings → Shortcuts; hidden in incognito, while loading/failed, and
with zero projects — no skeletons): with 1-2 projects each flattens into
a segmented pill — project chip (FolderKanban → `/projects/<id>`) plus
one segment per screen desk (emoji + name, up to 3, straight to the
desk URL). Screens ride `fetchProjectOverview` only in that 1-2 project
case; a failed overview quietly drops to a plain project chip. 3+
projects render up to 4 plain chips plus a dashed "All projects" tail.

Mode switcher (Chat/Image/Video/Audio) sits above the composer card. On
the hero the same row carries a one-tap profile strip at its top right
(`composer-profiles`, sm+ only, toggle in Settings → Shortcuts, hidden
in incognito and with zero profiles): up to 3 monogram circles — tap
starts/reuses a draft with that profile (`newChatWithAgent`), tapping
the attached one detaches it, the attached circle wears an ember ring —
plus a "+N" chip to `/profiles` when more profiles exist.
Bottom rail (left→right): attach, Studio popover ("Studio — tools, MCP
servers, behavior": builtin tools, MCP servers, auto routing, memory,
settings link), run-mode selector + config gear, Skills button, GitHub
repo pin (only while the GitHub connector is on), model picker, send. The
run-mode selector (`composer-mode-trigger`) mirrors the AI model picker: the
same compact, borderless trigger with up/down chevrons opens a checked catalog
of Standard / Deep research / Julius / Research × Julius
(`run-mode-option-<id>`), with an icon and explanation on every row. On narrow
screens it shows a short label (Research / Julius / R×J). A single
config gear (`composer-mode-config`) appears beside it only while
research/Julius is engaged and opens the mode's settings panel
(`composer-mode-config-panel`) — Research | Julius tabs when both ride.
The panels share one layout: icon-chip header with a one-line blurb;
Research = segmented Eco/Balanced/Max control + a four-figure budget strip
(waves / searches / page reads / live pages) + honest "Julius is on"
footnote when riding together; Julius = candidates (lettered chips,
N/8 counter, dashed add button), decision cards, council model rows.
Attachments: text-like files (incl. PDF/DOCX/XLSX) travel as extracted
text; images ride as vision parts. Oversized images are re-encoded once
at intake (ladder from 1600px, JPEG) because the WHOLE model request must
fit the gateway's ~4.5 MB body cap; legacy oversized images in history
are shrunk transiently before every run (`shrinkMessagesForApi`, budget
split across all images of the turn). Shrink fails soft (HEIC on Chrome
rides as-is). An image whose bytes are gone (cleared vault) is not
dropped silently — the model gets an honest "could not be loaded" note
and says so. Tested in `attachment-shrink.test.ts`.

Skills live in ONE rail button (`composer-skills`, sparkles icon) — the
only composer home for packs (the Studio popover and the config panels
hold none). A small numeric badge counts packs riding the active run mode
(Standard → chat, Research, Julius; the combo counts packs on either
engine). Its popover (`composer-skills-panel`) holds the per-surface
switches (folders keep All on/off), the thread-agent narrowing note, and
a Manage skills… link; in the combo it splits into Research · n |
Julius · n tabs. In the MCP catalog, amber "server-side" reasons clamp to
two lines and expand on tap (no hover on phones).

GitHub repo pin (`composer-repo`, GitHub glyph): rendered only while an
enabled GitHub connector exists in settings AND the active profile allows
that connector. A profile that excludes GitHub gets an amber `!` GitHub
button leading to its profile editor instead of a picker that promises
access the profile cannot use. Its popover
(`composer-repo-panel`) lists the account's repositories (same
deterministic /user/repos listing as list_my_repos, newest push first,
cached ~5 min) with search, private badges, and honest error states
(Retry + "Manage GitHub…" → `/mcp?server=<id>`). Picking a repo pins it
to the ACTIVE thread (`conversation.githubRepo`, synced like any thread
field; pinning on an empty Launchpad creates the draft): the pill shows
the repo short name with an X to unpin. Every run kind in the thread
(chat / research / Julius / resume) carries both the human-readable
"Pinned GitHub repository" block AND structured `config.githubRepo`.
`githubRunRepoRefs` gives an explicitly named repo precedence and otherwise
returns the pin; this fixes Research and Research × Julius, whose deterministic
GitHub preload used to inspect only the typed question and therefore ignored
the pin. Plain Julius candidates receive the scoped native GitHub routes too;
the council Verifier now receives the same route in both Julius modes, rather
than losing it at the debate boundary. Its tool list is enforced read-only —
GitHub mutations are absent while it independently checks repository claims.
Chat and resume force-arm GitHub past the tool router (like skill pins), then
the worker performs a SAME-CREDENTIAL server preflight: repo metadata + root
contents are read before the model answers and the real root listing is added
to context. A missing/expired credential, profile exclusion, org 404, or
fine-grained PAT without Contents permission becomes an explicit failed
`mcp_github_get_contents` record — never a model pretending it read code.
Explicit owner/repo text now force-arms GitHub just like a thread pin. Disabled
native tools remain disabled in deterministic pin preflight and Deep Research;
profile and automation connector allow-lists intersect in cloud runs exactly as
in the browser. Julius candidates and Verifier are read-only at BOTH definition
and route-execution layers, so parallel candidates cannot multiply GitHub writes
and a hidden write name cannot bypass the filter.
Credential hand-off (2026-08-30): the browser resolves the credential at run
start (PAT or device-flow sign-in) and injects it only into the authenticated
run request (`injectGitHubRunAuth`); it is neither logged nor persisted in the
run row. This immediate hand-off avoids relying on best-effort profile sync.
Cloud REST transport now identifies EVERY native GitHub request with GitHub's
mandatory User-Agent + API version. The missing header made GitHub reject all
Worker calls — including `/user` — with 403 while the same credential passed in
the browser, producing the false "token dead" diagnosis. Live control probe:
no User-Agent → 403, identified request → 200. Error classification matches the
browser: only 401 asks for a new credential; 403/429 (including Retry-After
secondary limits) keeps it and reports the actual rate-limit/SSO/org-policy
cause. Native browser and Worker tables are contract-tested as the same 30 tools;
every dispatcher has a method/endpoint fixture. New GitHub connections start
read-only: seven mutations remain disabled until deliberately enabled. `get_contents` now requires an exact
path (empty string means root) and returns the real file body, not just the tree:
inline base64 still takes the fast path, while GitHub's normal `encoding:none`
response for 1–100 MB files is retried through the authenticated raw media type
with the same branch/ref; empty files remain valid and binary payloads stay
honestly labelled. Owner/repo values and every Contents path are validated before
fetch; empty or dot-segments cannot escape the selected repo. File reads show
GitHub's blob sha; updates and deletes require the sha that was actually read and
refuse stale versions, while an explicit empty new file remains valid. PR file
diffs page to GitHub's 3,000-file ceiling. Actions logs stream only a bounded
tail; their signed cross-host redirect is followed without Authorization.
Regressions: `github-run-flow.test.ts`, `mcp-file-content.test.ts`,
`github-security.test.ts`. New chats start without a pin; signed out stays an
honest unavailable state.

Repo access probe (2026-08-30, `composer-repo-diagnose`): listing repos
and reading one are separate GitHub authorization contours — GitHub
answers 404 (never 403) for private repos a credential cannot see, so a
missing repo looks nonexistent. The picker popover's "Can't see a
private repo?" expands an input (owner/repo or github.com URL, seeded
from the search query) + Check: the browser probes BOTH contours with
the SAME credential the picker and runs use (`/repos/{o}/{r}` metadata,
then `/contents` — only if metadata answers), plus whoami scopes and
visible orgs. The pure mapper (`diagnoseRepoAccess` in
`github-diagnose.ts`, unit-tested matrix) yields verdicts: ok · empty
repo (size 0 contents-404 is honest) · fine-grained-token contents gap
(metadata 200 / contents 404 → link to token settings) · missing "repo"
scope · own-repo missing from FG-PAT selection · org visible but repo
hidden · org NOT visible → OAuth-app approval verdict with "Review org
access" link (`githubOrgAccessUrl`) · SAML SSO challenge (X-GitHub-SSO
header → authorize URL) · 401 dead token · 403 rate-limit/IP-allow-list
(quotes GitHub's message). Verdict card (`composer-repo-verdict`) shows
title, plain-language fix, honest probe trace ("Checked as @login —
repo HTTP 404"), external action link, and "Sign in on the MCP page…"
for scope/401 verdicts. SSO and GitHub refusal text are collected from the
contents response too, not only metadata. These diagnostic probes stay entirely
in the browser; actual cloud agent runs transmit the credential to Gera's
authenticated worker for that run so the server can call GitHub, but do not log
or persist it. Repo picker cache entries are keyed by a non-secret credential
fingerprint, so an account/PAT swap cannot show the previous account's private
repo names. Explicit Gera sign-out/account exchange clears account-scoped local
data and in-memory MCP sessions before the next identity mounts; a missing local
GitHub credential also removes the connector from the run instead of resurrecting
a stale synced grant. Project-agent GitHub tokens are normalized and a newly
entered token must verify before save. Slack-originated project-agent runs are
always native GitHub read-only, even when the same agent has write access inside
authenticated Gera.

- Attachments: paste/pick files (images, pdf, docx, xlsx), remove, drag to
  reorder (↑/↓ works too).
- While a run is live: Send becomes **Queue message** (queued items support
  "Send now" / "Remove from queue"); **Steer** (Ctrl/⌘ Enter) injects text
  into the live run; **Stop** cancels (never plays a completion chime).
- Stop guarantees (2026-08-30): server-side the engine cuts streams AND the
  tool phase — a grinding call (web search, MCP) is raced against the stop
  ping, remaining calls are skipped, cut/skipped chips marked honestly
  (`agent-engine.ts` tool loop). A stop landing as the reply completes still
  reports status "stopped" (queue holds). Client-side `runServerTurn` checks
  the abort signal before AND after `/runs/start` (a stop during prep never
  starts the run; during start it is killed server-side), and `stop()` fires
  a best-effort server stop when the thread runs but isn't attached yet.
- Stop watchdog (2026-08-30, `stopCloudRun` in use-agent.tsx): the button
  never depends on the terminal event alone. `/runs/stop` answering
  `ok:false` ("not_running" — the node lost the run, e.g. after a worker
  deploy) detaches the tab immediately; a confirmed stop whose terminal
  event never lands detaches after a ~6s grace window (draft stays, sync
  reconciles). A successor turn in the same thread is never touched
  (controller identity check); a pending "stop & send" still dispatches its
  message after a forced detach. Fixes "stop only works after a page
  reload". E2E: `stop-run-settles-ui` (hanging stream + not_running stop).
- Turn ownership (`turnOwners` in agent-store): a successor turn (interrupt,
  "stop & send", quick re-send) owns the thread's slot; the aborted
  predecessor's finally no longer closes the successor's steering inbox
  (used to cause "This run can't take mid-run steering") or hide its Stop
  button. At settle the owner strips EVERY stale ⚡ flag
  (`stripSteerFlags`) — accepted-but-unconsumed steering becomes a plain
  queued follow-up instead of a dead chip. Tested in `agent-steering.test.ts`
  (mid-tool stop, between-tools stop) and `steering.test.ts`.
- Enter behavior follows Settings → `enterSends`: on → Enter sends; off →
  Enter is a newline, Ctrl/⌘ Enter sends.
- A thread started from a Profile shows an agent chip with "Detach agent
  from this thread".
- Runs execute on the worker (`/runs/start` + SSE `/runs/stream`) — closing
  the tab does not kill them; reopening adopts the live run.

## Model picker

Trigger `model-picker-trigger` in the composer rail (shows name + pinned
effort + blended cost; effort label and cost hide on narrow screens — the
picker itself always shows them). Chat mode opens a root menu:

- **Model** (`model-picker-model-row`) → searchable catalog submenu, one row
  per base model (`model-option-<id>`), cost badge + tier, effort variants
  deduped.
- **Effort** (`model-picker-effort-row`) → `effort-option-default|low|medium|high|xhigh`;
  pins `reasoning.effort` (selection id becomes `catalogId:effort`).
- **Reset to default** (`model-picker-reset`) → Grok 4.6 xHigh.

Model and effort are orthogonal — switching one keeps the other. Media modes
open the flat catalog directly. Selection persists per mode in settings.

## Threads & sidebar

TopNav: thread-title dropdown — Pin (P), Mark as unread (U), Rename (R),
Delete (D); Share button (hidden for empty or incognito threads); ghost
button = new **incognito** chat (⌘⇧N, never saved, no share/pin). Attention
dot on the sidebar toggle while runs are live or threads unread. Threads
cloud-sync via `/chats/sync`.

## Deep Research

Composer toggle "Multi-wave web research with a cited report" + depth
settings (deeper = longer + more credits). Produces a cited report; with
Julius on, every candidate researches independently and the council
distills one final report.

Research runs on the question text alone (2026-08-30): an attachments-only
send in research mode is blocked with an honest toast, and both engines
(`functions/research-runner.ts` + browser twin `deep-research.ts`) reject a
blank prompt before any network call — previously the report ended up
riffing on the skill packs, the only content left in context. Workspace
context (profile + skills + knowledge) rides into the report writer via
`synthesisSystem` framed as guidance that "is NOT the research subject",
replacing the old "User instructions (always follow these)" label.

## Julius

Composer toggle: parallel candidate answers compete, or the council
quality-checks a single answer; after the ruling the chairman merges the
best parts. Config popover: candidate count/models, decision mode — "I pick"
(user chooses) vs "Council decides". Verdicts render as a dedicated panel
in the thread (`JuliusPanel`). The Verifier receives the run's scoped native
GitHub route in plain Julius and Research × Julius, is explicitly told to
inspect connected sources, and can execute read tools only (no issues, branches,
files, comments, or PR writes). Regression: `github-run-flow.test.ts`.

## Media modes

Composer modes Image / Video / Audio switch the picker catalog and options
(image size, video aspect, voices). Results render as media cards in the
thread (`VaultMedia`): preview, download, reuse actions. Usage is billed in
honest units (images / seconds / characters).

## Profiles (`/profiles`)

"Reusable teammates — each with its own instructions, model, tool pool, and
knowledge." Gallery of agent profiles; Start chat with one (chip appears in
composer) or create/edit your own. Editor sections: Identity, Model,
Built-in tools, MCP servers, Skills, Knowledge (uploaded docs indexed via
worker `/knowledge/*`).

## Skills (`/skills`)

Reusable instruction packs that ride into chats, Deep Research and Julius.
Max 24 per user. Features: create/edit (name, instructions, "when to use"
trigger, surfaces chat/research/julius), folders (flip a whole set per
tool), MCP-connector binding. Catalog below the list — 21 templates in
three groups: **Essentials** (13, everyday craft), **Workflows** (4, strict
protocols: PR review, security review, test author, agent design),
**Playbooks** (4, GitHub delivery: ship as PR, debug CI from logs, babysit
a PR to green, maintain a feature map); clicking a template card opens a
full-text preview dialog (complete instructions, folder, surfaces, Add
inside); the card's quick **Add** and the **Add all** button stay — hitting
the 24 limit adds what fits and shows an honest toast. Skills are also editable
from chat (the agent can propose edits via skill-ops). The prompt-block
headers (browser `buildSkillsBlock` + cloud `cloudSkillsBlock`) mark skills
as guidance that is "never the task itself" — models must not research or
summarize them unless the user explicitly asks (2026-08-30).

## Projects (`/projects`)

Team spaces: scoped agents + Slack-style channels with threads + screens
(widget desks). List page is a studio tab (`page-projects`, create action
`project-create`); each project opens a full-bleed workspace at
`/projects/:id` (`project-space`, normalizes to the first channel's address
`/projects/:id/channels/:cid`; tabs live at
`/projects/:id/{screens|agents|members}`, an open thread rides
`?thread=<root id>` — Back closes it on mobile); a screen opens its own desk
at `/projects/:id/screens/:sid` (`screen-desk`; the open case rides
`?conversation=<id>`, the performance panel `?panel=performance`).

- **Create / list**: New project → creator becomes owner; the list comes
  from the ProjectStore registry singleton (instant after create).
- **Roles**: owner (delete project) > admin (channels, agents, members,
  rename) > member (talk, summon agents, leave). Enforced inside the
  project's ProjectStore shard (`proj:<id>`), never client-side.
- **Channels & threads**: `#general` auto-created; admins add channels
  (name + topic, ··· menu or rail +). Replies live in threads; root rows
  show reply-count chips; thread pane is a side column (overlay on mobile).
- **Agent profiles (the point)**: admin-owned, general-purpose — code,
  support, research, writing. The Agents tab is the project's admin
  panel: owner/admins configure name/emoji/handle, instructions, model
  (chat catalog, short names) + thinking-effort pin (stored as one
  `model:effort` string, parsed by the engine; empty = Grok 4.6 default),
  and per-agent access — icon rows with switches: Web, GitHub (when on,
  Read-only / Read & write level cards), Intercom, Slack. Five role
  presets (repo guide, support triage, release engineer, researcher,
  writer) prefill the create dialog. Read-only GitHub has literally zero
  write tools (`GITHUB_READ_TOOL_NAMES` in `functions/project-shared.ts`).
  Credentials are project-scoped, stored server-side, clients only see
  set/unset flags; no token → the agent says so instead of pretending.
  GitHub credential is one tap: "Sign in with GitHub" / "Use my GitHub"
  reuses the workspace device-flow dialog (`GitHubSignInDialog`; token
  read from the browser's MCP sign-in store via `exportOAuthTokens`), and
  any token — signed-in or pasted — verifies in-browser against
  api.github.com ("Acts as @login", scope warnings from
  `githubIdentityLabel`). Intercom/Slack stay paste fields with direct
  "where to get it" links (Developer Hub / api.slack.com/apps).
- **Linked MCP servers per agent**: fifth access row "MCP servers"
  (plug icon) — the SAME picker pattern as chat/automations, not paste
  fields: the admin toggles up to 5 of their connected MCP servers
  (favicon + name + tool count + amber "connect first" readiness chip
  via `cloudMcpReadiness`; native GitHub/Slack/Intercom entries are
  excluded — they have dedicated rows). Empty state links to /mcp; the
  footer counter also links there ("Missing a server?") and says the
  native trio has its own rows above. The
  agent stores only refs `{owner, servers:[{id,name}]}`
  (`parseMcpSelectionPatch` / `normalizeStoredMcpSelection` in
  `functions/project-shared.ts`; honest 400s `invalid_mcp_selection` /
  `too_many_mcp_servers`; omit = keep, [] unlinks, every non-empty save
  re-links to the saving admin — refs saved by another admin render as
  removable "saved link" rows plus an amber "linked through <owner>'s
  account" note). Authenticated runs — channel mention and screen assistant —
  resolve the refs through the owner's account shard (internal worker-only
  `POST /mcp/resolve` on ChatStore: profile
  blob + rotation overlays via `cloudMcpServersForAutomation`, expiring
  sign-ins refreshed there with rotations persisted — the exact cloud
  automations pipeline; `normalizeCloudMcpServer` revives the wire),
  connects in parallel (`connectCloudMcp`, one forced re-resolve retry
  after "auth rejected"), exposes tools as `mcp_<serverId>_<tool>`
  (90-route cap) and reports per-server status honestly: connected · N
  tools, FAILED with reason, or "not among <owner>'s connected servers
  anymore". Tool results retain actual file bodies across every project-agent
  surface: text and embedded resources are flattened for the model,
  `structuredContent` is used when no text block exists, and `resource_link`
  entries are fetched through authenticated `resources/read` (up to four per
  call). Progress notifications preceding a Streamable HTTP result are skipped
  until the matching request id arrives, rather than becoming an empty file.
  Keys/sign-ins never copy into the project; members see name chips only.
  Removing an admin or demoting them to member revokes every agent MCP link
  delegated through that account, and every run rechecks that the link owner is
  still owner/admin. Inbound Slack deliberately gets NO generic MCP tools:
  arbitrary remote tool names cannot be classified reliably as read vs write;
  native GitHub remains separately available read-only. Cards/profiles show
  "MCP · <name>" chips; amber "MCP · no servers" when the switch is on with
  nothing linked.
- **Inbound Slack bot (mentionable agents)**: the Slack access row also
  takes the Slack app's Signing secret + shows a per-agent Request URL
  (`slackEventsUrl` → `/slack/events/:projectId/:agentId`) with copy
  button and 4 setup steps (secret → save → paste URL → subscribe
  `app_mention`, scopes `app_mentions:read` + `chat:write`, optional
  `channels:history`). @mentioning the agent in Slack fires the Events
  API → relay forwards the RAW body to the project shard →
  `verifySlackSignature` (v0 HMAC, ±5-min window, timing-safe) +
  `classifySlackEvent` (pure, unit-tested; bot/subtype events ignored —
  no reply loops) → event-id dedup (`slack_events`, 2h TTL) → queued
  `slack_jobs` row → waitUntil `/slack-run`: same `buildAgentToolset` +
  engine + budget as channel runs, reply posted into the SAME Slack
  thread via chat.postMessage (mrkdwn prompt rules, sources appendix,
  honest ⚠️ failure note on errors). URL check fails loudly until the
  signing secret is saved — setup order is honest. Read-only cards show
  an "@mentionable in Slack" chip when both Slack secrets exist.
- **Create the Slack bot from Gera (wizard)**: the Slack access row's
  primary path mints the app itself. Connect ONCE per project
  (Runbear-style): the admin pastes the Refresh Token (xoxe-1-…) from
  api.slack.com/apps → "Your App Configuration Tokens"; the shard
  validates it via `tooling.tokens.rotate`, stores the tooling pair in
  project meta (`slack_config`) and rotates automatically whenever a
  fresh access token is needed (`freshSlackConfigToken`, 10-min margin;
  Slack invalidates the old refresh token on every rotate so the new
  pair persists immediately; a dead connection is wiped so the UI
  honestly asks to reconnect). From then on "Create Slack app" is one
  click for every agent — no tokens. While the agent was never saved
  (no id yet — the bot URLs embed it) the wizard and the manual Request
  URL both show an amber `SaveAgentFirstNote` ("You're creating this
  agent right now…") with an inline "Save agent now" button:
  `save({stay:true})` persists and reloads the draft via
  `draftFrom(saved)`, so the editor stays open and the step unlocks in
  place. A plain access token (xoxe.xoxp-…)
  is accepted too but cannot renew (honest `renews: false`, ≤12 h).
  Admin-only `POST /slack-config` connects/disconnects ("Disconnect
  manager" in the wizard); the overview wire carries `slackConfig
  {team, renews, connectedAt}` — tooling tokens never reach the client.
  Creation: the shard calls
  `apps.manifest.create` (name from the agent, `SLACK_BOT_SCOPES`, OAuth
  redirect) → stores the returned credentials (app id, client id/secret,
  signing secret) in the agent's secrets → THEN wires Event
  Subscriptions via `apps.manifest.update`, ordered so Slack's URL
  challenge verifies against the already-stored secret (failure = honest
  `warning`, app still connected). "Install to Slack" opens OAuth v2
  (`slackAuthorizeUrl`; HMAC-signed state `base64url({p,a,e}).sig` keyed
  by the client secret, 30-min TTL); public `GET /slack/oauth/callback`
  renders a tiny HTML result page and the shard's `/slack-oauth`
  verifies the state, swaps the code via `oauth.v2.access`, stores the
  xoxb token + team name and flips `access.slack` on. The editor polls
  the overview (~4s, ≤3 min) until `secretsSet.slack` lands — no manual
  save needed. Wire carries `slackApp {appId, team}`; cards show
  "Slack · <team>". Disconnect is a draft flag → `secrets.slackApp:
  null` on save wipes the registration + signing secret + bot token
  (wipe runs before token patches, so a manual paste in the same save
  survives). The manual paste path stays under the "I already have a
  Slack app" toggle. Contracts unit-tested in
  `web/src/test/slack-app-create.test.ts` (manifest, credentials parse,
  install-state HMAC/expiry, authorize URL, config-token classification,
  rotate-response parse, access-freshness margin).
- **Members use, admins edit**: every agent card is clickable — admins
  get the editor, members get a read-only profile dialog (access chips,
  model label, role instructions, Copy @handle). Cards carry an explicit
  footer action so it's obvious where to click ("Configure agent" +
  pencil for admins, "View profile" + eye for members, chevron slides on
  hover, ember border tint), and the admin empty state has a "Create the
  first agent" CTA. All writes are admin-gated server-side
  (`admin_required`); members only pick from what's published.
- **Screens (widget desks)**: the Screens tab lists desks admins compose
  in a builder dialog (`project-screen-create`, cards `project-screen-card`)
  — "one job, one UI". Validation is `validateScreenWidgets` in
  `project-shared.ts`: ≤6 widgets, one inbox max, referenced agent/channel
  must exist, widget ids derive from kind+ref so members' private chats
  survive edits. V1 widgets: **Intercom inbox** — the team's REAL inbox via
  the token stored on a chosen agent (list polls 20s, thread 8s; Reply and
  internal Note post to Intercom as the connected admin; notes render
  amber, bots violet). In Note mode "@" opens a teammate picker
  (`desk-mention-list`/`desk-mention-option`, arrows/Enter/Tab or click;
  directory loads on flipping to Note via POST `/intercom/mention-admins`
  → `listIntercomAdmins`); picked names post as REAL Intercom mention
  links (`buildIntercomNoteBody`: escaped body, longest name first so
  `@Ann` never eats `@Annabelle`; deleting the name from the text drops
  the mention). The list has state filter chips — Open (default,
  like Intercom itself; bot-per-session workspaces otherwise read like a
  per-message feed) / Snoozed / Closed / All — non-"all" states go through
  POST /conversations/search. Rows rank MONEY-FIRST (`rankInboxRows`):
  higher spend on top, recency breaks ties and orders non-payers. Spend =
  the contact's largest money-looking EN/RU attribute (`extractSpendValue`
  — spend/mrr/price/оплат/тариф…; id/date/debt/balance keys and id-like
  strings rejected by `moneyValue`), riding the same contacts/search
  round-trip (contactLiteCache holds name+email+spend). Tiers are relative
  to the list max — T1 ≥⅔, T2 ≥⅓, T3 any spend — rendered as `TierBadge`
  chips (T1 ember-filled, T2 tinted, T3 outline; the compact amount rides
  IN the chip — "T1 · 1.2k" via `formatSpendCompact` in lib/projects.ts,
  exact sum in the tooltip) on inbox rows, the thread header and the
  details contact card. Ranking is EXPLICIT: with payers present the
  list splits into labelled sections (`InboxRankLabel`: "Paying
  customers · biggest spend first" / "Everyone else · newest first"),
  and the footer is honest — "higher spenders first" only when spend
  data exists, otherwise "no spend data on these contacts — newest
  first". Inbox rows show
  the CUSTOMER + the LAST message
  (like Intercom), not the source author: `deriveInboxRow` in
  `native-intercom.ts` reads per-conversation detail payloads (cached by
  updated_at across polls; teammate/bot previews prefixed "Name: ", notes
  "Name (note): "), and greeting-only threads resolve the human via ONE
  contacts/search IN round-trip (30-min cache). Attachments (2026-08-30):
  Intercom ships pasted screenshots/files as `attachments` arrays on the
  source and on parts — often with NO text body; `readAttachments` in
  `native-intercom.ts` parses them (http links only, name/type/size),
  attachment-only turns STAY in the thread (`deriveThreadParts`, body ""),
  bubbles render images inline (click opens the signed CDN link — links
  refresh with the 8s thread poll, so expiry never bites) and other files
  as paperclip chips with size (`formatAttachmentBytes` in lib/projects),
  inbox previews say "Attachment: name" instead of hiding the turn, and
  EVERY model-facing transcript (read_conversation in both twins, desk
  suggestion prompt, reply-pair harvesting + grading transcripts, list
  previews) mentions "[attached: name (type, size)]" — names/types only,
  never the expiring URLs, so drafts and grades know a screenshot exists
  instead of hallucinating its content. A right **Details panel**
  (`screen-desk-details`, polls 30s via POST `/intercom/details`) mirrors
  Intercom's sidebar, top to bottom: contact card (avatar initial,
  name/email, last-seen presence dot), Assignee + Team Inbox (names via
  /admins + /teams, cached ~10 min, honest "Admin #id" fallback), a
  HIGHLIGHTED "Subscription & payments" card (ember-tinted; the plan value
  renders as a badge; contact + attached-company attrs matched by EN/RU
  billing keys — stripe/plan/balance/долг/тариф…; debt-like numbers ≠ 0
  render red via `isNonZeroNumber`), Recent activity (last seen, signed
  up, Data-API events via GET /events, then a first-party **Recent page
  views** block `screen-desk-page-views` — Intercom's API keeps page
  views private, so Gera tracks its own: an admin opens the
  `screen-desk-tracking-setup` dialog ("Set up page views" / "Get the
  snippet", shown while the contact has no views) and pastes the copy-
  ready `pv.js` script tag into the customer site. The tracker
  (`functions/desk-pageviews.ts`, served at public GET `/pv.js`)
  auto-identifies visitors from `window.intercomSettings` (or
  `window.geraPageViews.identify(email)`), tracks SPA route changes,
  buffers up to 20 pre-login views in localStorage and flushes them
  after identify, then beacons to public POST `/pv/:projectId` — the
  shard verifies the project's write-only key (minted by admin-only
  POST `/projects/:id/tracking/setup`, stored as meta `pv_key`). Rows
  live in `desk_pageviews` (30-day retention, newest 40 per contact,
  written under email + external-id keys, 15s same-URL dedupe); the
  details payload matches the Intercom contact by either key and the
  panel lists up to 10 views (age + clickable URL, title on hover).
  Empty/unconfigured states are honest per role; the "Open in Intercom"
  deep link remains the ExternalLink icon in the panel header), User data
  (standard contact fields + ALL non-billing scalar custom attrs incl.
  company attrs, filled rows sort first, "See all" folding past 12 rows,
  URL values render as clickable links), and the Conversation section
  (state, channel, started/last activity, waiting, ID, conversation
  custom attributes, tags) moved to the BOTTOM, collapsed by default.
  The Stripe payments inbox app is NOT in Intercom's public REST API —
  honestly absent. **Reply suggestions** — a strip above the composer
  (`screen-desk-suggest`, POST `/intercom/suggest`): ONE model run per
  thread update (keyed by the last part id, cached ~15 min in
  `desk_suggest_cache`, refresh icon = force regenerate) drafts 2–3
  live-human replies in the customer's language — suggestions ride the
  fixed `DESK_SUGGEST_MODEL` (openai/gpt-5.6-luna) while grading keeps
  the inbox agent's model (prompts + STRICT-JSON
  parsers live in `desk-intelligence.ts`; unreadable output → honest 502).
  Clicking a draft loads it into the composer — a person still presses
  Send. 👍/👎 on each draft writes calibration memory (`desk_suggestions`,
  POST `/intercom/suggest/rate`); future prompts carry liked/disliked
  examples plus the team's graded-good REAL replies. The same payload
  recommends the next move — reply / snooze / close with a short reason —
  and the strip has one-tap "Snooze 1d" / "Close" buttons (POST
  `/intercom/action` → conversation parts API as the connected admin,
  snooze = +24h). When the customer asks how the product works the
  payload carries a functionality question → violet "Ask Gera AI" row:
  POST `/intercom/ask-gera` drops an "Ask Gera: …" turn + a
  research-kind screen job into the member's PRIVATE assistant chat (the
  worker post-effect fires `/screen-run`), the assistant panel opens; the
  run researches with the agent's own tools and — given GitHub WRITE
  access — files `docs/gera-kb/<slug>.md` via `github_put_file` and
  reports the path (read-only/no GitHub → says plainly no KB page).
  Re-asking the same conversation while a research is still running
  (<10 min) dedups server-side — the desk toasts "already running"
  instead of double-spending. **Ask Gera status** — the strip shows the
  LATEST investigation on the open conversation to all members
  (`screen-desk-ask`, POST `/intercom/ask-status`, polls 4s while
  running / 30s idle, visible 7 days): violet card with who asked, the
  question, a spinner while running, the answer inline (Show more/less)
  the moment it lands, and an "Open assistant" shortcut. **Slack
  awareness** — the strip watches the team's own Slack for this case
  (`screen-desk-slack`, POST `/intercom/slack-related`, polls 45s): the
  worker pools channels where the screen's Slack-armed widget agent's
  bot is a MEMBER (`users.conversations`; inviting the bot = selecting
  the channel, so one workspace splits between projects by bot), up to
  8 channels × 40 messages over 7 days, cached ~150s in
  `desk_slack_pool`. Matching is deterministic (`desk-slack.ts`,
  unit-tested): conversation id via Intercom URL / `#id` / bare 6+
  digits, customer email, or the FULL customer name — replies collapse
  into one card per thread (channel, last 3 lines, age, permalink);
  activity within the last hour = pulsing "investigating" badge. The
  suggest prompt carries up to 3 matched threads ("Team Slack" block):
  outcome already in Slack → drafts fold it in + green "Slack has the
  outcome" banner (`investigation: answered`); team still digging →
  honest "we're on it" draft, usually snooze, amber "Team is
  investigating — wait" banner (`in_progress`); internal Slack is never
  quoted verbatim to the customer. Slack moved AFTER the drafts were
  generated → the strip waits while the thread is hot (~2.5 min), then
  force-regenerates ONCE per burst (`slackLastTs`). No Slack-armed
  agent → the section is silently absent (`slack: null` + reason);
  Slack API failures → amber "Slack check failed" line, drafts still
  generate without Slack context. **Team performance** — header ChartColumn button
  (`screen-desk-performance`) opens a full-screen panel
  (`screen-desk-performance-panel`, POST `/intercom/stats`): per-teammate
  cards from REAL transcripts — reply counts, median response time,
  good/bad grades with reasons on examples, coaching paragraphs. Data
  flows only on demand: admin "Collect & grade" (POST
  `/intercom/stats/refresh`) harvests the latest ~20 conversations via
  `harvestIntercomReplyPairs`/`deriveReplyPairs` (human admin comments
  paired with the customer message they answered; bots and notes
  skipped; dedup by part id into `desk_replies`, cap 500) plus one full
  transcript per conversation (`deriveConversationTranscript` →
  `desk_transcripts`, pruned with the replies), then grades ≤12
  ungraded replies in ONE model call grouped BY CONVERSATION — the
  model sees each whole transcript with `[partId]` markers on human
  replies and judges every listed reply in context (medium reasoning
  effort; pair-only fallback when a transcript is gone;
  `buildGradeMessages`/`parseGradePayload`) — and refreshes per-teammate
  coaching (`desk_coach`, addressed as "you"). Intercom admins auto-link
  to Gera members by email match (`desk_links`); admins re-link manually
  per card and pre-link teammates with no replies yet ("Other Intercom
  teammates", POST `/intercom/stats/link`). Admins see the whole team;
  members see ONLY their own linked card — grades are coaching, not a
  public scoreboard. **AI assistant** — a floating live-chat
  launcher + panel (`screen-desk-assistant`, Intercom-messenger style,
  bottom-right), PRIVATE chat per member (3.5s poll only while open,
  pending "thinking…" row), an "Attach conv #id" chip makes the SERVER
  fetch the live transcript into the run (client-supplied context is never
  trusted); **Post to channel** — a third composer target beside
  Reply/Note that escalates into a project channel, prefixing a
  "> Intercom #id — author" reference line when a case is open. Assistant
  runs reuse the agent's exact access (screen_jobs → `/screen-run` inside
  the DO via relay waitUntil, ~110s budget, sources appendix).
  Missing/deleted tokens or agents → honest amber cards with the reason,
  never fake data. Desk is responsive: inbox→thread drill-in on mobile,
  details panel becomes a full-screen overlay below xl (PanelRight button
  in the thread header), the assistant floats everywhere.
- **Summoning**: @handle mention (composer autocompletes) queues a run;
  a pending "thinking…" row appears in the thread and fills when the
  engine finishes (runs inside the DO, fired via relay waitUntil, ~110s
  budget, sources appendix). Mentioning in a top-level message auto-opens
  the thread.
- **Notifications**: per-channel unread badges (rail + mobile chips),
  total unread in the browser tab title while the space is open. Honest
  polling — overview 5s, open channel 4s (delta by `updated_at` cursor),
  thread 3.5s. No fake realtime.
- **Honest limits**: adding a member ≠ Gera invite (response carries
  `invited`, UI warns); caps — 50 members, 12 agents, 30 channels, 12
  screens (≤6 widgets each), 2000 messages/channel (oldest fall off), 200
  rows per private assistant chat, 3 agent summons per message.

## Automations (`/automations`)

Scheduled agent runs. Create an automation with a prompt, agent profile,
schedule; platform cron fires every 5 min → worker `/cron/automations`
executes due ones server-side. "Run now" → `/automations/run-now`. Webhook
triggers: external POSTs to `/hooks/<id>` start a run. Run history with
statuses lives on the page. "Start from a template": Morning brief, Weekly
deep dive, Competitor pulse, Feature map drift-check (dogfood — daily
GitHub audit of this very map that opens a correcting PR).

Editor: Basics, Schedule, and Where-it-runs stay expanded; Webhook trigger,
Run as, MCP servers, Skills, and Browser extras are collapsed rows whose
header shows the current value (e.g. "Gera (default)", "All connected
servers", "3/5 allowed") — one click expands the full controls. The list
page ends with a 3-bullet "Honest fine print" (cloud / browser / webhook).

## Hub (`/hub`)

"Personal hub — Gera remembers, tracks, and reminds." Saying "drank 2
glasses of water" or "remind me tomorrow" in any thread lands here
automatically: memories, trackers with values, reminders. Managed via
HubStudio (view, edit, delete entries).

## MCP (`/mcp`)

Connector studio: add MCP servers from a catalog or by URL, OAuth sign-in
flows relayed through the worker (`/oauth-proxy`, `/mcp-proxy`,
`/mcp/oauth-rotations`), per-server tool listing and health, native
GitHub / Slack / Intercom connectors. Connected servers appear in the
composer Studio popover, in Profiles, and can bind to Skills.

OAuth popup sign-in has NO overall deadline — it waits as long as the user
needs (SSO, 2FA). `popup.closed` is treated as unreliable: COOP-protected
provider pages sever the opener link and report closed=true while the
window is still open, so results keep arriving via localStorage for a
10-minute grace after a "close". While waiting, the card button stays live
as "Sign in again" (restart supersedes the old attempt — a stale failure
never clobbers the newer attempt's state).

Token lifecycle (defenses against "works a day, then re-login"): access
tokens refresh 60s before expiry and once more reactively on 401; no
client-side TTL is invented when a server omits expires_in; refresh always
uses the stored token endpoint (no re-discovery); offline_access is
requested whenever the AS advertises it (otherwise many providers issue no
refresh token). Every sign-in/refresh/sign-out now bumps the profile clock,
so a browser-rotated pair reaches cloud runs before the old refresh token is
reused there. A newer account profile applies BOTH its MCP settings and its
validated `mcpOAuth` grants (the old loader discarded the grants but kept the
green flags); local-only grants remain. A transient relay/provider refresh
failure keeps the recoverable grant and says retry — it never deletes it or
asks for re-login; a fatal refresh (invalid_grant) still adopts the freshest
sibling/server rotation first, and only a genuinely dead or expired
non-refreshable grant drops to Sign in. Expired DCR registrations
(client_secret_expires_at) re-register instead of failing from cache.

Account/race boundary (2026-08-31): every Gera session has a persistent nonce
shared by tabs; logout or account replacement invalidates pending auth, MCP
popup, device-flow, refresh, relay and multi-round sync work before it can write
or retry. PKCE verifiers live per tab, popup callback slots are per OAuth state,
and only the newest per-server sign-in attempt may commit. Browser refreshes use
Web Locks across tabs, then compare-and-swap the full grant; independent
per-server token entries prevent simultaneous connectors from erasing each
other. After a sleeping tab's Gera JWT expires, every relay/sync/access retry is
now pinned to the rejected access-token generation: the first 401 refreshes,
while later 401s that belonged to the same old token reuse that winner instead
of rotating the Gera session once per MCP. This closes the shared ~12-hour cliff
where a burst of health checks could invalidate one another. A profile pull
applies only if neither its profile clock nor OAuth snapshot changed while it
was in flight. Cloud refresh holds its single-flight through durable persistence,
keeps a short completed-flight reuse window for stale callers, and rejects a
rotation whose source grant was replaced meanwhile.

File-result truth (2026-08-30): generic MCP calls preserve plain text,
embedded text resources and `structuredContent`; opaque image/audio/blob base64
is replaced by a short descriptor instead of crowding file text out of context.
A returned `resource_link` is resolved with `resources/read` on the same signed
session (up to four links). Streamable HTTP parsing scans notifications and
selects the final JSON-RPC response by request id, so progress events no longer
turn a file read into an empty result. The browser and Worker implementations
share regression fixtures in `mcp-file-content.test.ts`.

Status truth (2026-08-31): every persisted green card is live-checked once
per browser session, again when synced settings/auth arrive, every 10 minutes
in a long-open tab, and when the tab returns (the old mount-only pass often ran
too early). A `connected` card with missing OAuth/key bypasses the freshness
window and flips straight to a specific error. Background checks no longer move
healthy servers through a persisted Connecting state or turn a shared Gera
refresh/relay outage, sleeping network, 5xx, timeout, or rate limit into a
permanent synced disconnect; the connector stays armed and retries later.
Profiles poisoned by the former relay-error behavior self-heal on boot when the
credential/refresh grant still exists. Only a definitive provider auth rejection
turns that one card red; native Slack/Intercom classify credential failures
separately, and GitHub retries an early 401 with its refresh grant. GitHub's
`bad_refresh_token` spelling also uses the existing rotation rescue. Unit suites:
`auth-boundary.test.ts`, `mcp-oauth-refresh.test.ts`, `mcp-rotation.test.ts`,
`mcp-session.test.ts`; real-browser Web Lock/localStorage regression:
`auth-resume.browser.test.ts`.

Full catalog + transport audit (2026-08-30): all 98 catalog rows were probed
read-only. Of 94 generic connectable endpoints, 26 completed initialize +
tools/list without a credential (some still gate calls) and 68 returned the
expected auth challenge; GitHub/Slack/Intercom native roots are reachable; the
one blocked Intercom MCP remains listed with its provider-policy reason. All 52
catalog Sign-in endpoints advertise usable OAuth metadata + dynamic client
registration; Box is now an honest Developer Token entry because its metadata
has no DCR. Current provider contracts are pinned for Firecrawl (`/v2/mcp` +
Bearer, never key-in-URL), Exa (`x-api-key`), SearchAPI (`X-MCP-Token`), open
Chainstack, Zapier (`/api/v1/connect` + connection token), Octagon's new host,
and Datadog `/v1/mcp`; persisted legacy URLs migrate to the canonical rows.

Relay/auth safety (2026-08-31): browser MCP, OAuth, and native Intercom relays
require a platform-verified invited Gera identity — they are no longer public
CORS proxies. Gera's JWT occupies `Authorization`; provider Authorization is
carried in a dedicated internal header and restored only after the account gate,
so provider 401 never triggers a duplicate tool retry. Target URLs ride a header
rather than the relay query; paths/tokens are not logged. Browser relay AND
cloud runs reject local/private/reserved IPs, embedded URL credentials and
unsafe redirect targets; cross-origin POST redirects are refused. OAuth metadata
must provide absolute HTTPS endpoints, matching issuer metadata and S256 when
advertised; callback `iss` is checked when present, and every new grant is bound
to the MCP URL that requested it. URL/key/header edits invalidate the cached
session; a removed OAuth token cannot ride a stale in-memory header. Every
relay retry and every chat-sync round stays pinned to the session that created
its payload, so data from account A can never be retried with account B's JWT.

Protocol/runtime parity (2026-08-30): browser and cloud resolve No auth / Bearer /
custom headers / OAuth / auto identically, including provider-specific token
headers. Only enabled, verified-connected, non-blocked cards arm in cloud runs;
malformed headers fail closed. Initialize's negotiated protocol version is used
on later requests; tools/list follows cursors (20 pages / 500 tools), long-lived
SSE is cancelled as soon as the matching response arrives, and request bodies,
response bodies and flattened results are bounded. Mixed text +
`structuredContent` both survive; MCP `isError` becomes a real red tool failure.
Only the spec HTTP-404 stale-session signal is replayed — a JSON-RPC message that
says "session expired" cannot duplicate a write. Function names are stable,
valid and hash-disambiguated when normalization/truncation could collide.
Regressions: `auth-boundary.test.ts`, `mcp-security.test.ts` plus the
OAuth/session/file-content suites. Full verification on 2026-08-31: 704 unit
checks, 15 browser checks, web build, Worker deploy, live preview/ping and
unauthenticated relay-gate smoke probes all passed.

## Settings (`/settings`)

Redesigned: icon-tiled section cards plus an anchor rail on the left
(scrollspy highlights the section in view; phones get a scrollable chip
row instead). Sections: General, Shortcuts, Notifications, Toolkit.

- **General**: auto tools (router picks tools per message), Enter-sends
  switch, personal system prompt.
- **Shortcuts** (both default ON — `homeShortcuts` / `composerProfiles`,
  normalized in `history.ts`, tested in `notify.test.ts`): "Home
  shortcuts" — the project/screen strip above the home greeting;
  "Profiles at the composer" — the monogram row at the hero composer's
  top right.
- **Notifications**: completion sound Off / In background / Always +
  preview button; desktop notifications toggle (asks browser permission,
  honest toast when denied/unsupported, warning while permission is denied).
- **Toolkit**: per-builtin-tool master switches — off means the agent
  never sees the tool; auto routing picks media tools per prompt from the
  enabled set; search/fetch ride every message while enabled.
  Models are NOT here — they're picked in the composer/arena.

## Admin (`/admin`)

Requires `role === "admin"` from `/access/status`; others see an honest
"not for you" state. Tabs (deep-linkable `?tab=`):

- **People** — members, roles, invites, the waitlist (approve/reject).
- **Arena** — model standings, blind duels (ArenaStudio), usage stats with
  service-call split, usage clear.
- **Diagnostics** — client/worker error journal (`/diag`), clearable.

## Sharing (`/s/:shareId`)

Share button → dialog creates a public read-only snapshot link (worker
`/share/create`), lists mine (`/share/mine`), revoke (`/share/revoke`).
The share page renders without an account, on purpose.

## Notifications behavior

On run finish: chime per preference (default only when tab hidden or
another thread active); desktop notification only when the tab is hidden,
click focuses the thread. Manual stops and steer-interrupts never signal.
All notify paths fail silent.

## Worker route map

`functions/index.ts` dispatch: `/ping` health · `/access/*` gate+admin ·
`/share/*` · `/arena/*` (usage, battles, log, clear) · `/chats/sync` ·
`/runs/*` (start, stream SSE, active, steer/stop) · `/diag/*` ·
`/mcp/oauth-rotations` · `/automations/run-now` · `/projects` +
`/projects/create` + `/projects/:id/*` (overview, messages, message, read,
channels/create, members/*, agents/*, screens/*, intercom/inbox|thread|details|
reply|mention-admins|suggest(+rate)|action|ask-gera|ask-status|slack-related|stats(+refresh|link),
tracking/setup, screen-chat + screen-chat/send, project/rename|delete; agent replies fire
via waitUntil → shard `/agent-run`, desk assistant replies → `/screen-run`)
· `/slack/events/:projectId/:agentId` public Slack Events API endpoint
(no Gera identity — per-agent signing-secret HMAC verified in the shard;
challenge echo + mention jobs → waitUntil `/slack-run`)
· GET `/pv.js` public page-view tracker + POST `/pv/:projectId` public
beacon sink (no Gera identity — the shard checks the project's write-only
tracking key; feeds the desk's "Recent page views")
· `/hooks/<id>` webhook
triggers · `/surf` selfsurf · `/knowledge/*` · `/oauth-proxy` · `/mcp-proxy`
(invited identity required; manual redirects: same-origin keeps upstream auth,
cross-origin GET strips caller credentials, cross-origin POST is refused) ·
`/intercom/*` (same invited relay gate) · `/cron/automations` (HMAC via CRON_SECRET).

## E2E coverage

Scenarios in `web/e2e/scenarios.ts` (run: `cd web && bun run e2e`):

| Scenario | Covers |
| --- | --- |
| boot-to-launchpad | Gate bypass, launchpad, composer, sidebar render |
| send-chat-message | Send → user turn + streamed reply + `/c/` address |
| code-changes-preview | Repository edit event → live Changes diff → runnable sandbox Preview iframe |
| new-chat-keeps-history | New chat resets view, thread stays listed |
| github-pin-and-send | Connected GitHub → private repo list → pin → `/runs/start` carries exact repo + credential |
| switch-chat-model | Picker root → Model submenu → selection sticks |
| switch-chat-effort | Picker root → Effort submenu → budget pins |
| switch-run-mode | Model-style mode picker engages Deep research, trigger reflects it |
| run-mode-settings-panel | Gear opens the research settings panel (depth control) |
| skills-rail-panel | Skills rail button opens the per-mode packs panel |
| projects-page-opens | Projects page renders + create action behind the gate |
| studio-pages-navigate | Tabs automations → hub → mcp → settings |
| connect-open-mcp | MCP catalog → Connect → initialize/session/tools-list → verified tool count |
| objects-have-addresses | Deep links: /automations/new, /skills/new, /profiles/new, /hub?tab= |
| stop-run-settles-ui | Stop clears the composer when the run node lost the run (hanging stream, `not_running` stop) |

Browser-only auth coverage: `auth-resume.browser.test.ts` recreates two MCP
relay requests returning delayed 401s after a sleeping-tab token expiry and
proves both reuse one refreshed Gera generation (real localStorage + Web Lock).

Honest gaps (no click coverage yet): Skills page actions, Automations CRUD,
Admin tabs, MCP OAuth/API-key/custom-header setup (open connect is covered),
Share dialog, Settings toggles, media modes,
Julius/Deep Research runs, incognito, thread menu (pin/rename/delete),
Project workspace internals (posting, threads, agent editor, members,
screens tab, screen desk / Intercom widgets) — only the list page render
is clicked. Screen-widget validation IS unit-tested
(`project-shared.test.ts`).

Worker logic IS unit-tested from `web/src/test` — suites import `functions/`
modules directly: `cron-auth.test.ts` (HMAC contract), `run-protocol.test.ts`
(cloud media refs), `shard-migration.test.ts` (export→import paging, stall
finalize, sweep isolation), `automation-schedule.test.ts` (the
`automationDue ⟺ nextDueAt` alarm invariant across cadences/timezones),
`project-shared.test.ts` (handles/translit, @mention parsing incl. email
false-positives, the access→tool contract, and Slack-origin write downgrade:
read-only GitHub arms zero write tools; missing tokens arm nothing and are
reported), plus `mcp-rotation`, `mcp-file-content`, `github-security` (all 30
browser/Worker tools, traversal, optimistic SHA writes, redirects, scopes,
account isolation), `mcp-security` (catalog, auth-mode, OAuth/egress/session/
protocol and native Slack/Intercom parity), `auth-boundary` +
`mcp-oauth-refresh` + `mcp-session` (staggered expired-Gera 401s, provider-token
rotation rescue, transient health recovery), `code-change-flow` (diff capture,
HTML/CSS/JS assembly, HTTPS-only deployment previews, continuation merge),
`agent-steering`, `github-native`.
Only the Durable
Object glue in `chat-store.ts` / `project-store.ts` stays untested — its
typecheck happens at the functions deploy (`runChecks functions`), not in
web tsc.
