# Gera Feature Map (user POV)

Last synced: 2026-09-28 · model lines auto-update (functions/model-lineage.ts, backend codeId c0295feb); Julius roster pill replaces the model picker while Julius is engaged (`composer-julius-roster`); Julius Council v2 with Jev (TypeSafe AI's decision model) as the editorial board (backend redeployed 2026-09-17, codeId `36abc098`); server-run survival (keepalive alarm + seed/checkpoint resume) on top of `c9baa18` (backend redeployed 2026-09-15, codeId `5f4d0ddb`); dropped-connection recovery in the server engine on top of `c429d57` (backend redeployed 2026-09-15, codeId `67c27b43`); multi-tab run awareness, per-run usage attribution and the honest live-run cap (see below; backend redeployed 2026-09-15 with `ephemeral` on `/runs/active` and `limit` on 429); run-start gateway retries on top of `95f0152`; truthful run-status notice and status retries on top of `30d329b`; cloud-run observation/reopen fix on top of `eca4a20`; reply timeline (tool batches interleaved with the prose, commentary kept) on top of code commit `aa57eef`; published backend re-verified 2026-09-07 08:53Z (`/ping` 200, internal MCP routes 404, CORS preflight 204), redeployed 2026-09-08 for the tool-offset contract.

Model lines auto-update (2026-09-28): MODE_MODEL_IDS.chat in web/src/lib/models.ts is now a list of seed lines, not fixed versions. functions/model-lineage.ts (platform-neutral) masks version numbers into a family (spacexai/grok-4.6 becomes spacexai/grok-#; variant words such as fast, reasoning, max-prime stay separate lines) and picks the newest release of the same gateway type with a higher version and a release date not older than the current one; preview, beta, exp, free, stealth and dated snapshot builds are never picked. Web: the toolkit catalog query gera-models refetches every 30 min and on focus; the chat picker, primary quick picks, Julius options, Profiles, Arena and the project-agent model dropdown list the line heads; saved picks (composer model, Julius candidates and council roles, agent profiles) are upgraded in place per catalog load with the effort pin kept (upgradeSettingsModels, console line [models] upgraded to newer releases); sanitizeChatModel accepts any release of a curated line. Server: automations (runAutomationJob) and project agents call latestModelSelection on the 10-min catalog cache before each run; unreachable catalog keeps the stored pick. Media tabs stay hand-curated. On 2026-09-28 this moves grok-4.6 to 4.7, gpt-5.6-sol and luna to gpt-6-sol and luna, claude-opus-5 to 5.5, gemini-3.7-flash to 3.8-flash, deepseek-v4-flash to v4.1-flash, qwen3.7-flash to 3.8-flash in pickers. Static helpers bumped: fallbacks to gemini-3.8-flash, TITLE_MODEL and desk suggest to gpt-6-luna, OCR to gemini-3.8-flash. Tests: src/test/model-lineage.test.ts.

Julius hides the model picker (2026-09-17, later): while the Julius run mode is engaged in chat, the rail's model picker (`model-picker-trigger`, "Grok 4.6 xHigh $2→$6") is replaced by a roster pill (`composer-julius-roster`, Landmark icon in ember): it names every candidate (`Grok 4.6 · GPT-5.6 Terra · Claude Opus 5` — catalog names, or the short id when the catalog has not loaded) plus the decision (`you pick` / `council rules` / `Jev rules`; a single candidate always reads `council rules`), and its title lists every letter with its selection id. Tapping it opens the same Julius panel config (`composer-julius-roster-panel` = `JuliusConfig`: candidates, decision, council models); a second tap folds it. Why: a Julius answer comes from the roster and the council, never from the picked chat model — showing the picker suggested the answer would be written by that model. The picked chat model stays stored untouched and reappears the moment the run mode goes back to Standard or Deep research (research still runs on the picked model); image / video / audio modes keep their own picker. E2E `julius-hides-model-picker` (engage Julius → picker gone, pill shows Grok 4.6, pill opens "Candidates", folds, Standard brings the picker back); browser suite 13 files / 72 passed, `runChecks(web)` green.

Julius Council v2 — Jev decides (2026-09-17): a third decision mode in the Julius config, `decision: "council_v2"` ("Council v2 · Jev", `julius-decision-v2`, NEW badge; the classic "Council decides" and "I pick" are untouched, `normalizeJulius` accepts the new value, older clients keep reading `"council"`). Jev is `typesafe-ai/jev` on the AI Gateway (type `evaluation`, $0.042/1M input, output free, 70–500 ms, "System One" model: no text generation, typed Choice / Score / Boolean answers with calibrated probabilities — changelog 2026-09-16). Pipeline (`functions/julius-runner.ts`, `jevMode`): candidates answer in parallel as before → the **Verifier alone** fact-checks (no Proponent / Critic — nobody argues a side) → `runJevBoard` (`functions/jev-board.ts`) makes **two Jev rounds** over `state` = {task, request, verifier_report, candidates}: round 1 one `choice` question "backbone" (multi-candidate only) + one 4-level `score` "quality_<letter>" per candidate (unreliable / usable with caveats / solid / excellent); round 2 one call per candidate in parallel with one `choice` question per **block** — `splitBlocks` cuts the answer on blank lines, keeps fenced code atomic, attaches headings to the block after them, merges fragments < 80 chars and the smallest pairs down to `MAX_BLOCKS_PER_CANDIDATE` = 24 — with criteria KEEP / FIX (apply the Verifier's correction) / DROP wrong / DROP redundant; non-backbone rounds see the backbone text so redundancy is judged against it. The chairman then writes as an **EDITOR** bound by the plan (`editorPrompt`): material = every candidate with `⟦A3⟧` block markers (`markBlocks`), the backbone flagged, the VERIFIER REPORT, and `boardPlanText` (one line per block: id, ruling, probability, excerpt) — KEEP blocks keep their substance, FIX blocks take the Verifier's value and date, DROP blocks never appear in any form; no judgment is left to the LLM. Wire: `JuliusState.board: JuliusBoard` {modelId, status, error?, backbone {winner, probabilities[], confidence}, quality[] {candidate, score, level, confidence}, blocks[] {id, candidate, excerpt ≤160, chars, decision, probability, probabilities}, inputTokens, elapsedMs}, `decidedBy: "jev"`, reviews = [verifier]; the board streams while running (round 1 result emitted with blocks pending). Transport: `evaluateWithJev` POSTs `/v2/vercel/v4/ai/evaluation-model` (the AI SDK v4 evaluation endpoint behind the toolkit proxy; `ai-gateway-protocol-version: 0.0.1`, `ai-evaluation-model-specification-version: 4`, `ai-model-id`), retries transient 408/425/429/5xx (`JEV_ATTEMPTS` 3), never retries 4xx; every answer is checked against the asked questions (type, offered options) and an off-schema reply THROWS — the panel then refuses honestly: `board.status = "error"` with the reason, `verdict` "Jev could not rule (…) — pick the winner yourself" (multi) / "… the answer below is unreviewed" (single), no editor call, `status: "choice"`. Jev calls are billed to the run as **service** usage (`onUsage(modelId, {input_tokens, output_tokens: 0}, true)` — `ServerJuliusParams.onUsage` gained the `service` flag) so they count toward cost but never toward model adoption. Panel (`JuliusPanel`, `julius-board` / `julius-board-toggle` / `julius-board-block[data-decision]` / `julius-verdict`): header "Backbone: B · <model> · Jev's ruling"; "Jev’s board" section with the backbone probability bar per candidate (crown on the pick), quality chips with confidence, the keep / fix / drop tally as a proportional bar with a legend, and the per-block rulings (decision, probability, excerpt) behind a toggle; the classic chairman box is titled "Editor" in v2 and only shows honest notes. Summary lines: "The Verifier is checking…" → "Jev is ruling on every block…" → "The editor is writing from Jev's plan…". `healInterrupted` marks a board caught `running` as `error` "Interrupted by reload.". The legacy browser loop (`web/src/lib/julius.ts`) runs the classic council for `council_v2` — Jev is server-only. Regressions: `jev-board.test.ts` (11 — block splitting incl. code fences / headings / fragment merging / capping, wire headers, retry vs. no-retry, evaluation schema refusals, the two-round board with backbone-aware states, single-candidate board, off-schema refusal, plan text), `julius-council-v2.test.ts` (4 — the real runner: no Proponent / Critic, 3 Jev calls, editor material contains markers / backbone flag / Verifier report / plan lines, live states, service billing; single candidate; Jev unavailable → choice with the reason and no editor call; classic council unchanged), `julius-board.browser.test.tsx` (2 — the board renders backbone %, quality, tally, expands rulings; a failed board shows its reason and the pick buttons). NOT verified live: an actual Jev call through the toolkit (`/v2/vercel/v4/ai/evaluation-model` answers 401 without a key from the sandbox, so the path is proxied; whether the toolkit's gateway key has the evaluation modality enabled is unknown until the first real run — a refusal surfaces as the honest "Jev could not rule" path, never as a fake ruling). Validation 2026-09-17 11:35Z: unit **414 files / 1148 passed**, Chromium **13 files / 71 passed**, `runChecks(web)` + `runChecks(functions)` green.

Server-run survival (2026-09-15, night): the reported turn — "Deep research · Stopped · 267 sources", "Completion wasn't confirmed. No reply is available in this saved turn", Retry — is `finalizeStaleRow` in `functions/run-manager.ts`: the `agent_runs` row was still `running` but no `LiveRun` existed in memory. Root cause is the platform, not the model: a Durable Object is evicted after 70–140 s without INCOMING traffic — Cloudflare docs (lifecycle page, 2026-07) state a pending `waitUntil` or a plain `fetch()` subrequest "never keep the Durable Object alive, even while the response body is still streaming" — and every backend deploy kills every object outright. A tab keeps the object alive only while its `/runs/stream` subscription is open; close the laptop for two minutes (or deploy) and a 60-minute research run dies with its dossier, because the start body and the research registry lived only in memory. Now: (1) **keepalive** — `spawn()` arms `env.DO.setAlarm("ChatStore", <shard id>, now + KEEPALIVE_MS = 30 s)`; `ChatStore.onAlarm()` → `RunManager.onAlarm()` re-arms while any run is live and treats a `running` row without a live run as a dead node. The alarm survives eviction and deploys, so the gap is at most one tick. Bindings without `setAlarm` (staging, tests) fall back to the old traffic-only behaviour. (2) **recovery material** — new tables `agent_run_seeds` (the start body via `seedForStorage`: chat seed dropped, connector credentials / `research.githubAuth` stripped, inline media then grounding dropped when over `SEED_PAYLOAD_LIMIT` 1.5 MB; incognito stores nothing) and `agent_run_checkpoints` (research: `onCheckpoint` after the preparatory steps and after every wave — dossier with page texts water-filled to `CHECKPOINT_PAYLOAD_LIMIT` by `trimResearchCheckpoint`, spent/planned queries, notes, counters, repos, trail). Both rows go with the run when it settles (`dropRecoveryRows`) and are GC'd with `ROW_TTL_MS`. (3) **resume instead of interrupted** — `recoverStaleRow` (called from `sweepStale` on every `/runs/*` request and `/sync`, and from `onAlarm`) asks `decideRecovery` (`functions/run-recovery.ts`): chat runs re-execute with `resumeChatBody` (consumed steering, settled tool results capped at 4 000 chars, a call caught running marked `RESTART_TOOL_RESULT`, the shown text as `resume.partial` + `SERVER_RESUME_NOTE`, notes never stacked); research runs re-execute from the checkpoint (`runServerDeepResearch({ resumeFrom })`: no re-planning, no repeated searches, restored sources keep their `[n]` numbers, the trail marks the step the restart caught as `server restarted`, `startedAt` preserved). Same `runId`/row, so attached tabs simply see the run continue on their next reconnect; `restarts` counted per run, `MAX_RUN_RESTARTS = 4`. Refusals name their reason in the bubble via `staleRunError` ("… could not be resumed (its time budget ran out / it was stopped / incognito … / a Julius panel cannot be resumed mid-run / its request was not kept for recovery / it was already restarted N times)"); `/runs/stop` on a dead row still finalizes ("it was stopped"). Julius panels are not resumable (candidates are parallel, no checkpoint) — they keep the honest interrupted path. No client change was needed. Regressions: `run-recovery.test.ts` (14 — seed sanitising incl. no credential/chat seed, size fallbacks, malformed seeds; chat resume body, note de-duplication, running-call marking; every `decideRecovery` refusal reason; checkpoint round-trip and water-fill; the REAL research loop through a fake toolkit emitting checkpoints per wave, and a resumed run that never re-plans or re-searches). Not covered live: an actual eviction/deploy mid-run in production (needs a multi-minute run with the tab closed) — watch `rork-agent logs backend` for `stale run resumed:` / `stale run finalized as interrupted:`. Validation 2026-09-15 20:44Z: unit **407 files / 1133 passed**, Chromium **12 files / 69 passed**, `runChecks(web)` + `runChecks(functions)` green.

Dropped-connection recovery (2026-09-15): long replies from slow flagship models (Astra, Fable at xhigh) stopped mid-generation and the bubble settled as if finished — `iterateSse` in `functions/agent-engine.ts` treated ANY end of the upstream body (EOF without `[DONE]`, a read error, a gateway error object under HTTP 200) exactly like the provider's terminal marker, so `runEngineTurn` saw "no tool calls" and returned the partial text as `completed`. The client then showed the truncated reply with no chip and no toast. Now: (1) `iterateSse` records HOW the stream ended (`done` / `soft` / `eof` / `failed`, plus a 15-minute silence guard `STREAM_IDLE_MS`) and `streamGatewayCompletion` returns `cut: { kind: "dropped" | "error", detail }` whenever text arrived but the provider sent neither `finish_reason` nor the final usage chunk, or streamed an `error` event / `finish_reason: "error"`. (2) `runEngineTurn` and `streamGatewayText` keep the streamed text exactly as shown, drop the round's half-assembled tool calls (they never ran; ghost chips clear), replay the draft plus `CUT_DROPPED_NOTE` and continue the SAME reply over a fresh connection with `joinCutText` splicing; up to `MAX_DROPPED_ROUNDS = 8` consecutive drops, then the run fails honestly ("the connection to <model> dropped mid-reply N times in a row … the text received so far is kept; say “continue”"). A round that finishes resets the counter. (3) A request that fails BEFORE any token — non-2xx (`GatewayRequestError`: 408/425/429/5xx), a network `TypeError`, or a stream that dropped empty (`GatewayStreamCutError`) — is repeated up to `GATEWAY_ATTEMPTS = 3` with backoff (`isTransientGatewayError`); 400/401/404 are never retried. (4) `TIME_BUDGET_MS` in `run-manager.ts`: chat 15→40 min, research/julius 40→60 min (high-effort reasoning rounds take minutes before the first token). (5) Client: a failed server run that produced no text now puts `done.error` INTO the empty bubble (`failedRunBubblePatch` in `agent-store.ts`) instead of only a fading toast; a streamed draft is still never overwritten. Regressions: `agent-stream-cut.test.ts` (19 — EOF/failed/error-event/idle cuts, `[DONE]`-less but `finish_reason`/usage-bearing streams stay finished, continuation splice, tool-call drop, retry/backoff, honest give-up, counter reset, stop while retrying, `streamGatewayText` chain). `agent-steering.test.ts` / `agent-commentary.test.ts` fixtures now end rounds with `data: [DONE]` like the real gateway. Not covered: a live multi-minute production drop (no backend logs were available for the reported runs — the ai-gateway log only lists non-2xx responses, and the drops happened under HTTP 200). Validation 2026-09-15 18:01Z: unit **401 files / 1119 passed**, Chromium **12 files / 69 passed**, `runChecks(web)` + `runChecks(functions)` green.

Multi-tab runs, usage attribution, live-run cap (2026-09-15): every run executes on the server, but a tab only learned about a reply started in a sibling tab when sync delivered the finished text, and a message sent there meanwhile died with "Another reply is still running" in its bubble. Now: (1) `run-signals.ts` — `runServerTurn` announces a non-incognito start through `localStorage` (`gera.run-signal.v1`, carries only conversation id + timestamp + tab id); `AgentProvider` subscribes to the `storage` event, ignores its own echo, and runs a read-only `adoptActiveServerRuns({ runningOnly: true })` (single-flight, coalesced 350 ms) — also on `visibilitychange`/`focus`. It never starts, stops or replays a prompt. (2) A persistent `run_active` 409 is a typed `RunActiveError`: `sendPrompt` rolls the seeded user/assistant pair back, queues the message (user sends go to the tail, dispatched follow-ups to the head), attaches to the live run via a same-tab `gera:runs-changed` nudge, and shows an info toast; the adopted run drains the queue when it settles. `resumePrompt` attaches instead of re-marking the bubble interrupted. (3) `MAX_LIVE_RUNS_PER_OWNER = 3` is per account across every tab/device; `/runs/start` now returns `{ error: "too_many_runs", limit, active }` and `startServerRun` waits 2.5 s up to three times, then throws `RunCapReachedError` naming the limit — no more bare "(429)". Plain 429s stay definitive. (4) Server-run usage replay used the top-of-stack capture, so with two threads running the later thread's token bill could land on the earlier one; `settleDone(done, capture)` now bills the owning turn via `reportUsageTo`, and boot-applied finished runs use a detached tally. (5) `/runs/active` reports `ephemeral`; an adopted incognito run's placeholder thread stays incognito (never synced). Regressions: `run-signals.test.ts` (5), `usage.test.ts` +2 (`reportUsageTo`, detached tally), `server-run-start.test.ts` +4 (cap wait/limit message, slot frees, plain 429 definitive, `RunActiveError`). Full unit **99 files / 1100 passed**, browser **12 files / 69 passed** (14:26 UTC, after reinstalling headless Chromium + system libs), `runChecks(web)` and `runChecks(functions)` green. Not covered: a real two-browser session against the live backend; the `storage` event only reaches same-origin tabs of the same browser profile — other devices rely on focus/visibility reconcile and sync as before.

Cloud-run observation/reopen (2026-09-08): `server-run.ts` reconciles stored state after at most 15 seconds on one SSE subscription, including when pings continue or response headers stall. `/runs/active` has a 12-second observer timeout covering body reads; neither timeout stops/restarts the server job. Stream cancellation is best-effort and cannot delay an already received final result. A transport `AbortError` reconnects unless the caller actually aborted. Poll results take terminal status from the durable row (older backends omit `result.status`). Observations and adopted state updates stay bound to the original account session. `AgentProvider` adopts live runs before history hydration; finished-history acknowledgments and legacy local replay still wait for hydration. Already attached IDs stay in the adoption result to prevent duplicate local continuation. New `server-run.test.ts` regressions cover ping-only streams, hanging cancellation, upstream AbortError and stalled headers/tab detach. `run-recovery.browser.test.tsx` mounts the real provider + MessageList against controlled network/auth/history fixtures: reopens a job dated 20 minutes ago before hydration, remounts without start/stop requests, and settles a lost terminal SSE into visible final text + cleared running state. This is not a live 20-minute production job or a full browser reload. Actual Cloudflare restart/redeploy remains interrupting, not resumable execution; pending imports/write tools must not be blindly replayed. Backend audit also identified unresolved final-persistence failure, unbounded upstream waits and continuation recovery provenance risks; they are not fixed by this client patch. User-specific refresh/interruption remains untraced because live backend/runtime logs are unavailable.

Cloud-run fix validation: 2026-09-08 12:57 UTC, full unit **96 files / 1068 passed**, full Chromium browser **11 files / 58 passed**, no failed/skipped tests. Reports: `web/e2e-results/run-recovery-unit-2026-09-08.json` and `web/e2e-results/run-recovery-browser-2026-09-08.json`. Browser includes the 31-test existing e2e file; not additive. `runChecks(web)` passed static checks + build + preview publication; no functions edits/deployment were made for this patch, so it does not deliberately reset active backend jobs.

Run-status notice and retries (2026-09-08): `interrupted` is a legacy mixed-provenance flag, not evidence that a page reload killed execution. `MessageList` now shows neutral status checking until boot adoption + history hydration finish, without Continue/Retry; live/pending bubbles do not show interruption notices. Unresolved messages say completion was not confirmed and the saved reply **may** be incomplete, never assert a reload caused it. Failed adoption checks retry after 2/4/8/15/30 seconds (then 30), with a visible backoff message. `Check now` cancels the waiting timer and performs a read-only recheck, single-flight with boot checks; it can retrieve a later-available saved result or attach a live run, never invokes local prompt replay. Timers stop on unmount; delayed callbacks and state updates are session/mount guarded. Existing automatic legacy recovery at first boot is unchanged and is not a guarantee that lost backend computation can resume. `run-recovery.browser.test.tsx` now explicitly flushes debounced history before mounting so fixtures really exercise saved drafts (the earlier two scenarios also covered creation from server-only history). Three new notice regressions failed with the literal old warning before the fix; four retry tests cover automatic 503→503→success/backoff, Check now timer cancellation, later-available result, and unmount cleanup. Full unit **96 files / 1068 passed** and browser **11 files / 65 passed**, UTC starts 15:40:33 / 15:40:39; reports `web/e2e-results/run-status-retries-{unit|browser}-2026-09-08.json`. These remain controlled browser/network fixtures, not the user's live job.

Run-start gateway recovery (2026-09-09): reported HTTP 502 on both `/runs/active` and `/runs/start`. Source audit: `relayRuns` maps thrown account/relay failures to `upstream_unreachable` (502), but no live backend/runtime logs were available to identify this incident's source. `startServerRun` previously retried thrown network errors but failed immediately on HTTP 502. It now retries 502/504 acknowledgment failures with the **same run ID and once-serialized payload**, after 2/4/8/15 seconds (five total attempts). This uses the existing server's durable receipt/input-hash contract; it is not a new prompt/continuation. Definitive 4xx errors and idempotency conflicts are not gateway-retried; existing short `run_active` handling remains. Exhaustion reports unconfirmed acceptance, not proof of non-execution. `runServerTurn` passes its cancellation signal so waiting retries cannot start after Stop; in-flight successful acknowledgment still returns to the caller's existing explicit-stop handling. Session guards before each attempt and after response parsing prevent cross-account delivery. These retries are scoped to the original submission, not refresh/Check now (which remain observation-only). No backend edits/deployment. A hung POST or truncated success body is not newly handled by this patch, and an actual backend computation reset remains non-resumable.

Gateway validation: three new unit regressions failed before the implementation (HTTP recovery, exhaustion, session switch); final full unit **97 files / 1079 passed**, 06:11:17 UTC, report `web/e2e-results/run-gateway-unit-2026-09-09.json`. Full browser **11 files / 67 passed**, 06:12:23 UTC, report `web/e2e-results/run-gateway-browser-final-2026-09-09.json`. Includes the real App one-Send/502/same-payload-receipt/one-reply fixture and provider GET 502→502→success fixture. Backend receipt behavior was inspected in source; this turn did not run staging acceptance or a live authenticated job. First browser attempt could not launch Chromium; installed headless shell and system libraries, then reran successfully. The failed environment report is retained separately. Browser e2e is a subset, not an extra test total.

Current MCP contract: cold auto/deferred starts make no provider requests; an addressed search warms only one server, and a first cold call returns `executed:false` with its schema. GitHub operations use server-owned references only. Inventory persists negotiated wire, project warmups write back to the owner, and both protocol families retain their policy/credential boundaries.

Reply length contract (2026-09-07): Gera never rations a reply. Every completion carries the picked model's own output ceiling (`max_tokens` from the gateway catalog — the tab sends `maxOutputTokens` in the run config, the server falls back to its 10-minute catalog cache) instead of the provider default (Anthropic: 4096 tokens, the cause of Fable 5.1 cuts); a 400 that rejects the cap is retried once without it. A round the provider ends with `finish_reason: "length"` is continued in place — the chunk is replayed as an assistant turn plus `CUT_CONTINUE_NOTE`, the model repeats a few words and `joinCutText` splices the seam (the shown text only grows) — until the model stops on its own. This holds for Standard chat (`runEngineTurn`), the research report writer, Julius candidates/verifier/council/chairman/synthesis (`streamGatewayText`) and project agents. A cut inside a tool call drops the incomplete call and asks for smaller calls; a blank cut round gets one direct retry; a verbatim-repeated chunk stops the chain. The only remaining ceilings are infrastructure: the run's wall clock (chat 15 min, research/Julius 40 min) and the per-message storage cap (600 000 chars ≈ 150k tokens) — at which the reply wraps up honestly (`stopReason: "size"`, “say continue”) instead of being truncated on save. The system prompt rule “Be concise” was replaced by “Length follows the task, not a quota … deliver all of it in one reply” in both engine copies.

Verification: 1029 unit tests / 93 files; 52 browser tests / 9 files; separate e2e 31 tests = 29 neutral scenarios + drag-and-drop + legacy-settings-PAT migration. All final runs have 0 failures/skips. Reports: `web/e2e-results/mcp-{unit|browser|e2e}-final-2026-09-06.json`; scenario report `web.latest.json` started `2026-09-06T18:50:00.158Z` (29/0). The e2e count is a subset of browser, not an additional 31 tests. Reply-length change (2026-09-07): unit **94 files, 1051/1051 pass, 0 skip** — `web/e2e-results/output-length-unit-2026-09-07.json` (new file `agent-output-length.test.ts`, 22 tests); the e2e scenario “Deferred MCP loading rides into the run” was run alone in the browser (1 pass, 30 filtered out) to confirm `config.maxOutputTokens = 64_000` from the stubbed catalog — that is not a full browser/e2e run.

Live gaps: authenticated DeepWiki `/mcp/check`, OAuth re-login/check and a >8-server user run still require the user's account. The unauthenticated direct DeepWiki transport at `2026-09-06T18:51:03.026Z` returned legacy 2025-11-25 / 3 tools; it does not close those gaps. Published `/ping` and CORS OPTIONS passed; internal resolve/catalog-write remain public 404; GitHub/project credential routes require sign-in.

Historical delivery notes (2026-09-05; superseded where the current sections below differ): MCP audit closure in three phases — (1) no per-run
  inline cap (was 90; only 500/server remains), `auto → deferred` decided
  solely by schema share > 15% of the context window, no per-run server
  count (was 8) and no per-agent link cap (was 5): a 20 s parallel connect
  budget (`CONNECT_BUDGET_MS`, late handshakes finish in the background and
  a deferred call waits for them) and a 24 MB combined-catalog budget
  (`RUN_CATALOG_CHARS`, `mcp_limit` record names the left-out server) bound a
  run instead; (2) the browser holds no MCP grant anymore — legacy
  `gera.mcp.oauth.*` keys are purged on boot (`mcp-credential-migration.ts`),
  cards that relied on one show the amber "sign in again" notice
  (`mcp-resignin-notice`), `/mcp/oauth-store` and `/mcp/oauth-refresh` answer
  410, GitHub REST from the browser goes through `/github-proxy` by sentinel
  whenever the card has a vault credential, Diagnostics shows a
  `credential-migration` line; (3) the stateless MCP revision 2026-07-28 —
  `server/discover` probe first (5 s), `_meta` + `Mcp-Method`/`Mcp-Name` on
  every request, no initialize / session id, `input_required` answered
  through the elicitation hook and re-sent with `inputResponses` +
  `requestState`, `subscriptions/listen` SSE instead of the GET stream,
  `-32022` retry, negotiation cached with the catalog (`wire`), protocol badge
  `mcp-protocol-badge` on the card; MCP deploy-error recovery / account-pinned retries and stale-check guards;
  Astra and Grok together in quick choices / Fast retirement,
  Blender MCP secured-bridge setup; previous Phase 6 engineering, behaviour
  unchanged under the existing suites: Worker MCP/OAuth relays moved
  verbatim to `functions/mcp-relay.ts` (`/mcp/oauth/callback`, `/mcp/oauth-rotations`,
  `/mcp/oauth-refresh`, account `/mcp/*` control routes, `/mcp-proxy`) behind
  the `McpRelayContext` seam; project-agent tool assembly (`buildAgentToolset`,
  `resolveOwnerMcp`, `resolveOwnerAuth`) moved verbatim to
  `functions/agent-toolset.ts` behind `AgentToolsetContext`; the account
  shard's `/mcp/*` handlers left `chat-store.ts` (160 KB → 91 KB): check /
  resolve / auth-lease in `functions/mcp-routes.ts` over the credential-store
  seam, the browser sign-in state machine + GitHub device flow in
  `functions/mcp-oauth-routes.ts` (`McpOAuthRouteContext`), and ONE
  `mcp_oauth_states` state machine / grant store in
  `functions/mcp-oauth-store.ts` (`OAuthStoreContext`) shared by ChatStore and
  RunManager (the RunManager copy is gone); `/mcp/oauth-store` now seals under
  the account scope like every other grant row; the browser transport
  (`web/src/lib/mcp.ts`) parses and flattens through the same protocol core
  (`functions/mcp-protocol.ts`) the Worker uses — two fetch adapters, one
  parser. Size guidelines met: chat-store 91 KB (< 100), project-store 109 KB
  (< 130 — every desk route of the shard: screens, Intercom inbox / thread /
  details / reply / mention-admins / suggest / action / ask-gera, tracking +
  pv-ingest, desk ↔ Slack, stats + link, screen chat now lives in
  `functions/desk-routes.ts` over `DeskContext` (sql, workerEnv, metaValue,
  loadMember, memberRole, loadAgent, loadScreen, screenIntercomToken,
  screenSlackToken); shared row types and row → wire mappers in
  `functions/project-rows.ts`), index.ts 75 KB (< 80 — `/projects/*`, Slack
  events, the Slack install callback and `/pv/*` relays in
  `functions/project-relay.ts` over `ProjectRelayContext`; `/repo-previews`,
  `/repo-preview/*` hooks, archive upload and registry sweep in
  `functions/repo-preview-relay.ts` over `RepoPreviewRelayContext`) — MCP secrets & results: vault
  scopes bound to the Rork Auth account (`vault-scope.ts` one-time sweep,
  `/diag/vault` reports `scope` + `unreadable`), per-request credential leases
  on cloud MCP sessions (`mcp-credentials.ts` — no token strings on session or
  server objects), images / audio / blobs from tool results as thumbnails,
  saveable files and vision input (`message-tool-images`,
  `message-tool-file`) — MCP policies & confirmations:
  one policy gate in the toolset resolver — per-agent tool allowlists and a
  write policy for project agents, the account "Confirm write tools by
  default" switch, a Run once / Always allow in this chat / Decline card on
  the run-pause board, honest declines on unattended runs, and an
  `mcp-policy` audit trail in Diagnostics — MCP OAuth parity: pinned scopes
  and a metadata-URL override behind "Advanced" on the server card, scope order
  challenge → resource → authorization server, `offline_access` only when
  declared, `insufficient_scope` step-up that parks the server for the run and
  widens the next sign-in — MCP spec coverage: one protocol
  core (`functions/mcp-protocol.ts`, 2025-11-25 negotiation, injectable fetch),
  composer `/` prompts and `@` resources menus, elicitation cards that pause a
  run, tool annotation badges + UI-only markers, list_changed over the GET
  stream, conformance suite against the real `@modelcontextprotocol/sdk` server
  — deferred MCP tools through one
  toolset resolver — `mcp_search_tools` / `mcp_call_tool`, Settings → Toolkit
  "MCP tool loading", account tool-catalog cache, Deep Research connector
  scout — MCP server-owned credential
  recovery and bounded health checks, project Settings tab replaces the ··· menu,
  Diagnostics journals cloud-run
  failures and real MCP disconnects again, Gera-chat GitHub writes on by
  default, MCP no longer asks to reconnect when the browser has no local
  grant, Rork-hosted immutable web-
repository launches, evidence-backed autonomous execution outcomes for
Automations and project agents, quiet no-change checks, Luna suggestion
model, fable back in chat, note @-mentions, explicit
inbox ranking, home & composer shortcut strips, settings redesign,
attachment image shrink, stop/steering hardening, GitHub run credential
hand-off + pin/access fixes, truthful MCP health + OAuth/account-session/
sleep/deploy-resume hardening, authenticated file reads, Intercom
attachments, full 98-entry MCP audit, the five-model primary picker with
More, fixed-position screen assistant panels, and the live code Changes /
Preview workbench)
Drift check: `git log --oneline 32e3559..HEAD`, then compare against
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
every gate state. A build without `EXPO_PUBLIC_RORK_AUTH_URL`/`APP_KEY` shows
a configuration error on sign-in instead of POSTing to a relative URL; an
initiate response without an `https` `auth_url` is an error too, never
`window.open(undefined)`. Builds made outside Rork (a Repo Preview of this
repository from GitHub has no project env) get the public client settings from
the committed `web/.env.production` — exactly five `EXPO_PUBLIC_*` keys, pinned
by `env-production.test.ts`, never a secret; real process env wins on Rork’s
own builds. Related backend rule: the Worker answers unknown routes with
`404 {error:"not_found"}` (health stays on `GET /`), so a misconfigured client
never mistakes the catch-all for a successful `/oauth/initiate`. A document
with an opaque origin (the sandboxed Repo Preview: `self.origin === "null"` —
never `location.origin`, which serialises the URL and stays `https://` in a
sandbox) cannot call `api.rork.com` directly — its CORS answers `Origin: null` with
`https://rork.com` — so `resolveAuthUrl` (`auth-url.test.ts`) points such
builds at the Worker’s `POST /auth-relay/oauth/{initiate,token,refresh}`, a
body-verbatim relay pinned to this app’s public key (403 on mismatch, 404 for
other paths, 405 for non-POST, 503 when the Worker lacks the key). Sign-in
errors name the host and status (“… api.rork.com answered 404 (not_found)”,
“couldn’t reach … (network or CORS)”) and a popup that closes before the
callback reports “The sign-in window closed before finishing.” — only after a
1.5 s grace (`POPUP_CLOSE_GRACE_MS`), because the callback page posts and
closes in one breath and in a proxied window the code and the `closed` report
travel separate hops. Which Rork Auth flow `/oauth/initiate` asks for is
`authInitiateEnv` (`proxied-popup.test.ts`): Rork’s own preview iframe uses
`preview` (its callback page posts the code to `window.opener` for the
project’s preview origin only); a sandboxed build is embedded but is *not* the
popup’s opener — Gera’s trusted document opens the window for it and may run
on any Gera origin — so it asks for `production`, whose landing is Gera’s own
`/auth/callback` (`AuthCallback.tsx`). That page relays: in a window whose
`window.name` carries the Gera-minted `gera-preview-popup-*` marker
(`PreviewPopupRegistry.open` names every real window it opens; the name
survives cross-origin hops because the opener is kept) it posts
`{type:"rork_auth_callback", code | error}` to `window.opener` once per
trusted origin (`trustedRelayOrigins`: the page’s own origin plus
`https://<EXPO_PUBLIC_PROJECT_ID>-web.rork.live`, never `"*"` — a hostile
opener of a flow it initiated must not receive a victim’s code), shows
“Returning you to Gera…” (`auth-callback-status`) and closes itself; Gera relays
into the frame, which completes the PKCE exchange through the relay. A window
with an opener but no verifier of its own and no marker (an older Gera still
opening `_blank`, a browser that dropped the name) cannot finish the exchange
itself either: it gets the same relay and shows “you can close this window”
instead of failing with “session expired”, but never closes itself; the
top-level landing exchanges with this tab’s verifier as before. Deploy note:
`runChecks` publishes only the `*-web.rork.live` preview host — the production
landing at `gera-ai-agent-hub.rork.app` ships with Rork’s Publish, and a
sandboxed build’s sign-in depends on that landing carrying the relay. A callback that
brought a refusal instead of a code is worded by `describeAuthCallbackRefusal`
(“Sign in was cancelled…”). Production landing (2026-09-04): the sign-in
landings `/auth/callback` and `/oauth/callback` are routed *outside* the
account boundary (`AppRoutes` in `App.tsx`; `AccountProviders` re-keys
`AgentProvider` + the query cache on “loading” → “signed-out” → account —
the very transition a landing causes). Inside that boundary the landing was
torn down and remounted mid-exchange, redeemed its one-time code a second
time, and when Rork Auth’s “Invalid or expired code” for the duplicate landed
first it cancelled the sign-in that had just succeeded — the gate showed that
error in a normal browser while the preview popup flow (listener lives in
`AuthProvider`, unaffected by the re-key) kept working. Belt and braces:
`exchangeCode` is single-flight per code (`codeExchangesInFlight`, cleared
when settled), boot’s rejected refresh grant removes only the access/refresh
tokens (never this tab’s PKCE attempt), and a token refusal is worded by
`describeTokenExchangeRefusal` (“… rejected as invalid or expired. Please try
again.”). Browser: `auth-callback.browser.test.tsx` (real `AppRoutes` under a
held-open boot; concurrent redeem shares one request),
`repo-preview.browser.test.tsx` (window name). E2E bypasses
the gate: fake JWT in `localStorage` + stubbed `/access/status` → `invited`.

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
  rewrite the URL (push on switches, replace on first-message/deletion),
  an id missing on this device waits for cloud sync (8s signed-in / 2s out)
  — opens it the moment it lands, never rewrites the address meanwhile —
  then honestly toasts "Chat not found" and lands on `/`. Page loads are
  decided before the first render by `bootActiveId` (`lib/agent-store.ts`):
  a reload at `/` is a fresh thread (no remembered chat, and pulled history
  never yanks a null selection), `/c/<id>` opens exactly that thread, only
  non-chat pages (settings, projects…) fall back to the remembered thread so
  "← Chat" still returns somewhere sensible. Unit: `chat-url-boot.test.ts`. Editor addresses
  (automations/profiles/skills `/new|/<id>`) resolve after a 2.5s profile-sync
  grace, else toast + return to the list. Background-run toasts and desktop
  notifications navigate to the finished chat via the NavBridge
  (`lib/nav.ts`, registered inside the router in `App.tsx`).

## Chat (`/`)

Empty thread shows the Launchpad hero (`launchpad`) with the big composer
(`composer-input`, send `composer-send`). Starter chips under the hero
composer (`launchpad-starters`) fade out (aria-hidden, no pointer/tab stops)
the moment the prompt has text and return when it is cleared. The composer
textarea auto-grows line by line with an animated height (hook
`use-autogrow.ts`; caps: hero 320px / docked 256px, lower on mobile; scrolls
internally past the cap) — the same hook powers the edit-and-resend box in
user bubbles. A thread renders `chat-thread`
with `message-user` / `message-assistant` rows (markdown, artifacts, media).

Reply timeline (2026-09-08): an assistant bubble renders in reading order —
prose segment (`message-text`), the batch of tool calls issued at that point
(`message-tool-group`), the prose that followed, and so on — instead of a wall
of tool rows above a lone final paragraph. The commentary a model writes
before calling tools (“Checking the failed job logs first.”) is part of the
reply: the server engine (`runEngineTurn`) keeps it on screen through the tool
phase, appends the next round below it (`\n\n`), persists the whole text as
`content`, and stamps every tool record with `textOffset` — the length of the
text already written when the call was issued (`agent-engine.ts`,
`run-protocol.ts`, `cappedToolCalls` in `run-manager.ts` passes it, plus
`images`/`files`, through snapshots and the final message; resumed runs
re-base offsets onto the shown text via `rebaseToolOffset`). The bubble splits
`content` at those offsets (`web/src/lib/message-timeline.ts`,
`buildMessageTimeline`); records without an offset (older replies, MCP
failure notes) keep the old rows-then-text layout. Up to three calls in a
batch list as rows (`message-tool-call`); four or more fold into one summary
row (`message-tool-group-toggle`: “8 tool calls · mcp_github_get_job_logs ×8”,
“now · <call in flight>” while running, “N failed”) that expands on tap; media a
call returned stays visible while folded. “Gera is thinking” dots show only
when nothing else is live (no text streaming in, no call spinning). The
browser Julius loop (`chat.ts` `runAgentTurn`) applies the same accumulation.
Tests: `agent-commentary.test.ts` (three-round prose+tools turn, silent tool
round, loop-guard wrap-up under kept commentary), `message-timeline.test.ts`
(segmentation, legacy order, stable sort, clamping, summary, rebase),
browser `message-timeline.browser.test.tsx` (order, fold/expand, running /
failed headers, legacy layout).

Reply length (2026-09-07): a Standard reply is never cut short by the
provider. The run config carries the model's `maxOutputTokens` from the
gateway catalog (`cachedMaxOutputTokens`), the server sends it as
`max_tokens`, and a round that still ends with `finish_reason: "length"` is
continued in place in the same bubble — the text only grows, no restart, no
“continue?” prompt. Regression: `agent-output-length.test.ts`.

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

Repository launch (2026-08-31): pin a GitHub repo, then tap the cyan Play
button `composer-repo-launch` beside its pill. `repo-launch-dialog` performs a
server-side inspection before spending build time: immutable commit SHA,
framework/lockfile detection, monorepo root suggestions, optional output
folder, and whether the one-time runner is installed. A missing/outdated
runner never triggers mystery code: `repo-launch-install` creates a reviewable
PR containing `.github/workflows/gera-web-preview.yml`; the app asks the user
to merge it once, then `repo-launch-start` dispatches that read-only workflow.
The workflow checks out the exact SHA with persisted Git credentials OFF,
receives no Rork/Gera/repository secrets, installs with bun/pnpm/yarn/npm,
builds Vite/React/Next static export/Astro/Nuxt static/SvelteKit/Remix/
Angular or standalone HTML, and uploads only a bounded static artifact. The
repository install/build job has `id-token: none`; only separate trusted begin
and publish jobs can mint GitHub OIDC, with a pinned immutable Actions artifact
as the bounded cross-job handoff. No callback secret is dispatched. Rork verifies
the JWT issuer/JWKS signature, fixed audience, repository, exact run, workflow
ref + SHA, dispatch ref/event, and GitHub-hosted runner before every callback.
It also reads back the just-created workflow run and cancels it unless its real
head SHA/path/branch/event/repository match the canonical revision inspected
before dispatch. The run title is generic. Its GitHub-visible id is routing-only:
a separate 48-hex read capability is minted and returned only to the OIDC-
authenticated publish job, after the public GitHub handoff artifact already
exists. The build uses a fixed base placeholder; trusted publish rewrites text
entries and regenerates the tar manifest locally before direct Rork upload.

The launch dialog inspects with root `.`; when the repository root is not a
confident web entry (no package.json/index.html, or a workspace shell with
rork.json / workspaces / turbo / nx / lerna / no build script) the backend
resolves the real app folder itself: first the `framework: "web"` app declared in
a Rork workspace's `rork.json` (this repo's own `web/` + `functions/` shape), then
ranked candidate folders (`web`, `apps/site`… above `functions`, `api`, `server`;
never `dist`, `public`, `node_modules`, dot folders) until one has a recognised
framework or a static index.html. The inspection carries `rootSource`
(`explicit | root | rork.json | detected`); the dialog adopts the resolved root,
shows why it was chosen, and re-inspects immediately when a root chip is
clicked. An explicitly typed root is always respected.

The launch writes an ordinary user turn + durable `repo-preview-flow` receipt
into the existing chat — no new IDE/page. Source → Install → Build → Preview
phases poll the account's Rork Durable Object and survive tab close, reload and
cloud sync. The receipt links the exact GitHub Actions run, exposes bounded
credential-redacted logs (`repo-preview-logs`), Stop, and terminal Rebuild.
Ready artifacts run in `repo-preview-frame` (opaque-origin sandboxed iframe +
fullscreen, never an unsandboxed backend-origin tab) for 24h. On desktop
(`lg`, 1024px+) the chat workspace docks the launch v0-style to the right of
the thread: `PreviewPanelProvider` (`use-preview-panel.tsx`, mounted in
`Index`) tracks the active thread's launches; a fresh launch always takes the
dock over, closing is remembered per thread for the session, and the `TopNav`
`PanelRight` button toggles it. The dock (`repo-preview-panel`,
`RepoPreviewPanel.tsx`) carries browser-like chrome — Preview/Log tabs, an
address bar with reload/copy/open/expand, Stop/Rebuild, `repo-preview-panel-close`
— and a draggable divider (ratio persisted as `gera.preview.ratio.v1`). While
docked the thread shows only a compact clickable `repo-preview-flow` receipt
(`RepoPreviewReceipt`, `aria-pressed` when focused) so exactly one
`repo-preview-frame` exists; below `lg`, shared pages and channels keep the
full inline card. Both surfaces share one polling query per launch
(`use-repo-preview-job.ts`). Browser: `repo-preview.browser.test.tsx`
(receipt), e2e `github-launch-web-preview` (panel + frame at 1280px).

Popups: the iframe sandbox has no `allow-popups` (`REMOTE_SANDBOX`), because
from an opaque origin a popup can only ever be an inert `about:blank`. Instead
the served HTML's shim bridges `window.open` (returns a window-like stub whose
`location` setter also bridges, so `open('about:blank')` + later navigation
works), `target="_blank"`/modifier-clicked links, and `pushState`/`popstate`/
`hashchange`/`<title>` changes to the embedder via `postMessage`
(`{source:"gera-preview", type:"open"|"state"}`); root-relative popups are
folded under the artifact `<base>` like the Worker's HTML rewrite. The bridge
is inert when the preview is the top-level document. Gera validates the shape
(`parsePreviewBridgeMessage`) and the sender (`findPreviewFrameKey`: only its
own `data-preview-frame` iframes), then routes (`routePreviewPopup`). In the
dock every popup becomes a tab (`repo-preview-tabs`, `repo-preview-tab`, max
8, inactive pages stay mounted, middle-click/× closes, falls back to the left
neighbour), and the tab's body depends on the destination: same origin → a
sandboxed frame; `about:blank` → an empty page (`repo-preview-popup-page`,
"New tab") until the app navigates it; other web origins → a real browser
window opened from Gera's trusted document with the tab standing in for it
(host label, "Continues in a separate window", Show window/Close; when the
blocker refused, `data-window-state="blocked"` with an Open window button
(`repo-preview-window-open`) that retries under the click — no toast); the
stand-in disappears when the real window closes. Non-web
schemes/credentials → refused.
For `window.open` the shim mints a popup id and Gera plays opener for the
real window (`PreviewPopupRegistry`, `use-preview-bridge.ts`): the window
keeps `opener` so OAuth callback pages can `opener.postMessage(...)`, and
whatever they post is relayed only into the frame that asked
(`{source:"gera-preview-host", type:"message"}` → re-dispatched as a real
`message` event with the popup's origin); `closed` is polled every 500ms and
reported (`type:"closed"`, also when a popup that lived as a panel tab is
closed or the popup was refused), and the stub's `close()`/`focus()`/
`postMessage()` drive the real window. Placement hints (`popup,width=`) pass
through, `noopener`/`noreferrer` are stripped so the handle survives. A blank
open (`window.open()`/`about:blank`, the open-now-navigate-later pattern) is
bridged immediately as `url:"about:blank"`; the later `stub.location = url`
carries the same id, so the dock retargets that tab (`PreviewTabHost.open`
with a known opener) and a real window already held (`registry.has`) is
navigated instead of a second one appearing. `popup.close()`/`focus()` from
the app close/activate the tab; closing a tab (×, Close) closes any real
window behind it and reports `closed`, so the app's "waiting for the popup"
spinner settles. `target="_blank"` links (no id) to other origins open as
plain browser tabs with the opener severed, like a browser. The address bar
(`repo-preview-address`) shows host + live in-app route of the active page
tab, the real window's host + path for a stand-in, or `about:blank`;
reload/expand only act on page tabs, copy/open on anything with a URL. The
inline card (mobile/shared) has no strip: popups become real windows, blank
ones silently report `closed` when blocked, and blocked URL opens get a
toast with an Open action. Unit:
`preview-bridge.test.ts`; browser: `repo-preview-sandbox.browser.test.tsx`
(real `sandbox="allow-scripts"` frame runs the OAuth wait pattern end to end
against a scripted host), registry + panel tests in
`repo-preview.browser.test.tsx`.

The Rork backend stores an uncompressed tar in project R2 and a
validated path→offset manifest in SQLite; public asset reads are MIME-derived
R2 Range requests, SPA paths fall back to the indexed root, and Vite/root HTML
assets are namespaced below the id + separate unguessable read capability.
HTML stays origin-
sandboxed; because an opaque origin throws on the mere read of
`localStorage`/`sessionStorage`/`document.cookie` (which blanks almost any SPA
before first render), the Worker injects an inline storage shim right after
`<base>` — per-document in-memory stand-ins installed only where the real ones
are blocked (`repoPreviewSandboxShim`, `repo-preview-sandbox.browser.test.tsx`
proves both the failure and the fix inside a real `sandbox="allow-scripts"`
frame). Gera's own router follows Vite's `--base` (`basename={BASE_URL}`), so
the app previews itself at its access gate instead of a 404; SVG keeps image rendering but receives its own no-script CSP sandbox
so direct navigation cannot gain the backend origin, while active XML is not
accepted as a public artifact. Capability-bearing hook/asset paths and preview
ids are redacted from backend/build diagnostics. Limits: 50 MiB, 1,000 files,
two active and twelve recent jobs per account; one conditional SQLite insert
reserves both quotas atomically, and expired/cancelled runs cannot upload. Dynamic SSR/server processes are intentionally not claimed —
v1 requires a static `index.html` build output and says exactly when none was
found.

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
repo pin (only while the GitHub connector is on), model picker (swapped for
the Julius roster pill `composer-julius-roster` while Julius is engaged — see
the 2026-09-17 paragraph at the top), send. The
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
Credential references (2026-09-06): browser runs send connector IDs only; `injectGitHubRunAuth` removes legacy secret fields from its run copy. RunManager opens sealed keys/headers through the common `mcpConfigsWithSecrets` reader. Standalone Research now carries the already-scoped connector IDs; Julius and Slack restrictions remain unchanged.
Cloud REST transport now identifies EVERY native GitHub request with GitHub's
mandatory User-Agent + API version. The missing header made GitHub reject all
Worker calls — including `/user` — with 403 while the same credential passed in
the browser, producing the false "token dead" diagnosis. Live control probe:
no User-Agent → 403, identified request → 200. Error classification matches the
browser: only 401 asks for a new credential; 403/429 (including Retry-After
secondary limits) keeps it and reports the actual rate-limit/SSO/org-policy
cause. Native browser and Worker tables are contract-tested as the same 30 tools;
every dispatcher has a method/endpoint fixture. Gera chat GitHub is write-capable:
commits, branches, PRs and issues stay armed (factory read-only blocks on old
profiles are stripped on load and on the worker). Project agents still follow
their own Read-only / Read & write switch; Slack-originated runs stay native
GitHub read-only. `get_contents` now requires an exact
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
contents response too, not only metadata. Diagnostics, viewer, repositories, file bodies, and log reads all use `/github-proxy`; preview actions send a reference to `/repo-previews/*`. Raw PAT requests and the vault-401 fallback are removed. `connector-cache-scope.ts` pins references, inventories, pending requests and repository lists to the Gera session plus connection generation. Re-check, unlink, OAuth replacement and account exit invalidate that scope; late results cannot populate a new cache. Gera account JWTs are not provider tokens. Project-agent GitHub tokens are normalized and a newly
entered token must verify before save. Slack-originated project-agent runs are
always native GitHub read-only, even when the same agent has write access inside
authenticated Gera.

- Attachments: paste/pick files (images, pdf, docx, xlsx) or drag & drop them
  onto the prompt card — an ember "Drop files to attach" overlay
  (`composer-drop-zone`) confirms the target, with the same accept rules as
  the paperclip (chat: images + documents; Image/Video modes: images only,
  Video keeps one and replaces; unsupported drops get an honest toast and
  attach nothing). Chips (`composer-attachment`) removable; drag to reorder
  (↑/↓ works too). The composer card itself is NOT draggable — dragging is
  reserved for files.
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

- **Model** (`model-picker-model-row`) → searchable catalog submenu. Its main
  view contains exactly GPT-6 Astra, Grok 4.6, GPT-5.6 Sol, Claude Fable 5.1 and
  GPT-5.6 Luna, in that order. **More** (`model-picker-more-row`) opens every other
  curated base model. A selected secondary model is summarized on the More row, while
  searching from the main view still scans the full catalog. Model rows use
  `model-option-<id>`, show cost badge + tier, and dedupe effort variants.
- **Effort** (`model-picker-effort-row`) → `effort-option-default|low|medium|high|xhigh`;
  pins `reasoning.effort` (selection id becomes `catalogId:effort`).
- **Reset to default** (`model-picker-reset`) → Grok 4.6 xHigh.

Model and effort are orthogonal — switching one keeps the other. Media modes
open the flat catalog directly. Selection persists per mode in settings.
GPT-6 Astra Fast is excluded from all curated pickers; persisted Fast IDs
migrate to ordinary Astra with their effort preserved (`MODEL_SUCCESSORS`),
including restored composer settings, profiles and Julius panel selections.
Existing Grok selections and the Reset default are unchanged. Unit
`model-effort.test.ts`; browser `switch-chat-model` checks Astra and Grok
visible and selectable in quick choices (neither duplicated in More), with
Fast absent even when the gateway offers it.

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

The report writer (2026-09-07) streams through `streamGatewayText`: it sends
the report model's own output ceiling and continues a report the provider
cut (`finish_reason: "length"`) in place until it is complete — long Fable
5.1 reports no longer stop mid-section. Cancel stops the chain with what
streamed. Regression: `agent-output-length.test.ts` (streamGatewayText).

Research runs on the question text alone (2026-08-30): an attachments-only
send in research mode is blocked with an honest toast, and both engines
(`functions/research-runner.ts` + browser twin `deep-research.ts`) reject a
blank prompt before any network call — previously the report ended up
riffing on the skill packs, the only content left in context. Workspace
context (profile + skills + knowledge) rides into the report writer via
`synthesisSystem` framed as guidance that "is NOT the research subject",
replacing the old "User instructions (always follow these)" label.

Hand-off between the loop's agents (2026-09-03). Planner, per-wave reflector
and report writer used to pass each other findings only; the considerations
behind them died as a 110-char step caption. Now the reflector receives its
own earlier notes ("Your notes from earlier waves: - Wave 1: …") and is told
to change angle or accept a gap as unfindable rather than re-run an angle
that came up empty; the writer receives a `<research_log>` after the
`<research_dossier>` (`buildResearchLog`, ≤ 8 000 chars, sections ordered
notes → failures → queries so a budget cut trims the query list first): the
reflector's per-wave "still missing" notes, every step that errored (search
failed, page needs JavaScript, connector disabled, repo read failed) and
every query run — so "Limitations" states what was looked for and not found,
and the log is never cited as a source. Pages SelfSurf fetched live carry
`Fetched live: <date>` in the dossier and the writer treats them as today's
state. The registry keys sources by `sourceDedupeKey` (scheme, `www.`,
trailing slash, parameter order and tracking params collapse; meaningful
queries and fragments stay — repo sources hang `#readme` off the overview
URL), so one article behind variant URLs costs one read and one dossier
slot instead of two. Both engines carry identical copies; unit
`deep-research.test.ts` (`sourceDedupeKey`, `buildResearchLog`, live
marker, two-wave run with a failed search) and `research-runner.test.ts`
(byte-for-byte twin parity).

Connected MCP servers (2026-09-04, server engine only): after planning and
prompt-URL browsing, a bounded scout step on the fast model gets the run's
deferred toolset (`mcp_search_tools` / `mcp_call_tool` — never one function
per tool, regardless of the account's loading setting) and reads at most 6
tools whose output bears on the question, read-only intent, 90 s budget.
Every successful read becomes a dossier source `mcp://<server>/<tool>[#n]`
titled "<Server> · <tool>" (the writer is told these are the user's own
systems' data); the trail shows "Checking connected MCP servers" plus one
search/read step per call, errors stay honest. GitHub keeps its native
deterministic preload. The research gear panel lists the connected generic
servers with "searched on demand (deferred tools, up to 6 reads per run)".

## Julius

Composer toggle: parallel candidate answers compete, or the council
quality-checks a single answer; after the ruling the chairman merges the
best parts. Config popover: candidate count/models, decision mode — "I pick"
(user chooses), "Council decides" (Proponent / Critic / Verifier / Chairman)
or "Council v2 · Jev" (Verifier + Jev's block-level board + Editor; see the
2026-09-17 paragraph at the top). Verdicts render as a dedicated panel
in the thread (`JuliusPanel`). The Verifier receives the run's scoped native
GitHub route in plain Julius and Research × Julius, is explicitly told to
inspect connected sources, and can execute read tools only (no issues, branches,
files, comments, or PR writes). Regression: `github-run-flow.test.ts`.
Every phase runs its own model, so each completion carries that model's
output ceiling (`maxOutputTokensFor` → server catalog) and council/chairman/
synthesis prose is continued in place when the provider cuts it
(`streamGatewayText`); candidates and the verifier inherit the same
continuation from `runEngineTurn` (2026-09-07).

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
`/projects/:id/{screens|agents|members|settings}`, an open thread rides
`?thread=<root id>` — Back closes it on mobile); a screen opens its own desk
at `/projects/:id/screens/:sid` (`screen-desk`; the open case rides
`?conversation=<id>`, the performance panel `?panel=performance`).

- **Autonomous outcome contract (2026-08-31)**: every channel mention,
  private screen-assistant turn (including Ask Gera), and inbound Slack
  mention ends with one typed outcome: Ready · Needs review · Blocked · No
  material change · Error. A compact expandable receipt sits under the
  answer and carries the named artifact, runtime-derived evidence, next
  owner and exact unblock request. Project jobs persist that semantic status
  instead of treating an LLM call returning as `done`; existing rows remain
  valid without a receipt. The external `slack.com` surface receives the
  same contract as a short mrkdwn footer through the existing Events API →
  `chat.postMessage` path; it is not the internal project-channel UI. The
  model submits a claim through a metadata-only tool, but
  the shard independently validates real sources/tool results before
  accepting completion; unsupported claims downgrade to Needs review.
- **Create / list**: New project → creator becomes owner; the list comes
  from the ProjectStore registry singleton (instant after create).
- **Roles**: owner (delete project) > admin (channels, agents, members,
  rename) > member (talk, summon agents, leave). Enforced inside the
  project's ProjectStore shard (`proj:<id>`), never client-side.
- **Channels & threads**: `#general` auto-created; admins add channels
  (name + topic, rail + or Settings tab). Replies live in threads; root rows
  show reply-count chips; thread pane is a side column (overlay on mobile).
- **Settings tab** (`project-settings`, replaces the old ··· header menu):
  a real screen with General (rename), Channels (chip list + create form),
  the project-level Slack app manager (connect via pasted `xoxe-1-…` refresh
  token / disconnect — the same `/slack-config` connection the agent editor's
  bot wizard uses), and an owner-only Danger zone (delete project). Members
  see a read-only view; admins manage; only the owner sees delete.
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
  uses the server-owned device-flow dialog (`GitHubSignInDialog`) and verifies the account through `/github-proxy` ("Acts as @login", scope warnings from `githubIdentityLabel`). A manually entered project PAT goes only to `POST /projects/:id/agents/github-validate`; saving through `agents/upsert` validates the new PAT again and seals it in the project. This does not overwrite the personal GitHub credential. Successful save/close clears the browser draft and validation copy. Intercom/Slack stay paste fields with direct
  "where to get it" links (Developer Hub / api.slack.com/apps).
- **Linked MCP servers per agent**: fifth access row "MCP servers"
  (plug icon) — the SAME picker pattern as chat/automations, not paste
  fields: the admin toggles their connected MCP servers without a link-count cap
  (favicon + name + tool count + amber "connect first" readiness chip
  via `cloudMcpReadiness`; native GitHub/Slack/Intercom entries are
  excluded — they have dedicated rows). Empty state links to /mcp; the
  footer counter also links there ("Missing a server?") and says the
  native trio has its own rows above. The
  agent stores only refs `{owner, servers:[{id,name,tools?}], writes?}`
  (`parseMcpSelectionPatch` / `normalizeStoredMcpSelection` in
  `functions/project-shared.ts`; honest 400s `invalid_mcp_selection` /
  `invalid_mcp_writes`; omit = keep, [] unlinks,
  every non-empty save re-links to the saving admin — refs saved by another
  admin render as removable "saved link" rows plus an amber "linked through
  <owner>'s account" note).
  **Per-agent MCP policy** (2026-09-04): a linked server row expands
  ("Limit tools" / "Tool allowlist") into per-tool switches with
  read-only / writes / destructive chips from the annotations the last check
  saw, plus "Allow all" and "Read-only only" shortcuts — the first uncheck
  turns the ref's `tools` into an explicit allowlist (tools the server adds
  later stay out until allowed). Below the servers a "Write tools"
  radiogroup (`agent-mcp-writes`: Auto-run | Ask before running) sets
  `mcpWrites`; "Ask" is honest about agents running unattended: write and
  destructive tools are declined with a note in the reply, read-only tools
  run. Runs turn the selection into `agentMcpPolicy(selection)` (allow map
  per server, null = all tools) for the toolset resolver; the agent card
  chips read "MCP · <server> · N tools" and "MCP · writes need
  confirmation". Policy decisions of agent runs are posted to the linking
  admin's diagnostics journal (`postMcpJournal` → owner shard
  `/diag/append`). Authenticated runs — channel mention and screen assistant —
  resolve the refs through the owner's account shard (internal worker-only
  `POST /mcp/resolve` on ChatStore: profile
  blob + rotation overlays via `cloudMcpServersForAutomation`). Bootstrap resolves metadata/cache without refreshing unused generic grants. Each lease re-resolves only the addressed ID and rechecks the live agent, linking admin and unchanged delegation. Lazy catalog write-back uses the private `/mcp/catalog-write` route with an owner-generation compare immediately before publication; this route is not public. Explicit native starts in parallel; cold auto/deferred follows the two-step schema-first contract. All 12 linked IDs survive the integrated parser → owner resolve → toolset test; the browser editor shows `12 linked` (`agent-mcp-link-count`). Tool results retain actual file bodies across every project-agent
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
  (`screen-desk-performance-panel`, POST `/intercom/stats`): custom From/To
  dates plus 7/30/90-day and All-time presets (`screen-desk-performance-dates`)
  filter every metric by reply timestamp. Per-teammate cards use REAL transcripts
  and show conversations/replies, median speed, slow-tail p90, share answered
  within one hour, good/bad grades, ungraded work, exact first/last dates,
  coaching and up to 10 explained examples. **Trend over the period**
  (`screen-desk-performance-trend`, 2026-09-14): the stats payload now carries a
  text-free `timeline` (at/adminId/conversationId/responseMs/grade per visible
  reply, already visibility-filtered server-side); the client buckets it in the
  viewer's local time (`web/src/lib/desk-trends.ts`: days ≤31d, weeks ≤190d,
  months beyond, manual override, empty buckets kept, weeks start Monday) into a
  recharts bar chart with three metric tabs — Volume (stacked good/bad/ungraded),
  Reply time (median per bucket, red >1h), Quality (good share, colour-coded) —
  and a "Compared with the previous <equal-length period>" strip (replies,
  conversations, median reply, rated good) with signed deltas; a previous window
  with zero collected replies says so instead of faking a delta. Open-ended
  ranges derive the span from the data. Section hidden without timeline.
  **Per-teammate dynamics** (2026-09-14, `screen-desk-teammate-trend`): each
  teammate card gets a collapsed "Dynamics over time" toggle
  (`screen-desk-teammate-trend-toggle`, shown only when the teammate has timeline
  points) opening `TeammateTrend.tsx` — four metric tabs (Quality good-share,
  Reply time median, Within 1h share, Volume stacked by grade) with bars for the
  teammate coloured by thresholds and a dashed team line over the SAME buckets
  (`bucketMetricValue`), a model-free one-line verdict
  (`describeTrend`: streak ≥2 buckets, last-bucket vs earlier mean with noise
  tolerance, stable, or "not enough data"), and a vs-previous-period strip
  (replies, median, rated good, within 1h) from the teammate's own points.
  Volume charts (team + teammate) render each stacked `Bar` as a direct child of
  the chart — recharts 2 ships react-is 18, which cannot see children wrapped in
  a React 19 fragment, so the Volume tab used to draw an empty grid (fixed
  2026-09-14; the browser test counts `.recharts-bar-rectangle` and imports
  `@/index.css` so chart boxes have real height). Admin-only "Who moved most"
  ranking (`screen-desk-performance-shifts`,
  `rankTeammateShifts`) inside the team trend section lists quality pts / speed %
  / replies % deltas sorted by movement, skipping teammates without replies in
  both windows; hidden when ≤1 teammate is passed (members). Unit:
  `desk-trends.test.ts` (8); browser: `desk-teammate-trend.browser.test.tsx` (2).
  The compact "What to act on" block
  reports only operational signals: ungraded backlog, bad replies, >1h slow tail,
  and incomplete scan coverage. Data flows only on demand:
  admin "Analyze conversations" (`screen-desk-performance-analyze`, POST
  `/intercom/stats/refresh`) uses Intercom Search date filters (`harvestSearchQuery`:
  `updated_at > from AND created_at < to`, so conversations touched again AFTER the
  range still get scanned — fixed 2026-09-14) and cursor pages to
  scan/read up to 300 matching conversations via `harvestIntercomReplyPairs` /
  `deriveReplyPairs` (human admin comments paired with the customer message they
  answered; bots and notes skipped; exact reply-date filter; dedup by part id into
  `desk_replies`, cap 2,000). It stores one deeper transcript per conversation
  (`deriveConversationTranscript`, up to 100 lines / 12k chars), then grades ≤24
  new replies in ONE model call grouped BY CONVERSATION; each grading block keeps
  up to 70 lines / 7.5k chars and protects target `[partId]` lines. Coaching is
  3–5 specific sentences based on recurring patterns across the sample (medium
  reasoning; pair-only fallback when a transcript is gone;
  `buildGradeMessages`/`parseGradePayload`). Coverage count/range/timestamp and
  scan-limit truth persist in `desk_stats_meta`. "Clear current results"
  (`screen-desk-performance-clear`, POST `/intercom/stats/clear`) permanently
  removes replies, transcripts, grades and coaching after confirmation while
  preserving teammate links; the former shallow result set is cleared once on
  the v2 migration. Intercom admins auto-link to Gera members by email match
  (`desk_links`); admins re-link manually per card and pre-link teammates with no
  replies yet ("Other Intercom teammates", POST `/intercom/stats/link`). Admins
  see the whole team; members and summary metrics expose ONLY their own linked
  replies — grades are coaching, not a public scoreboard. **AI assistant** — a floating live-chat
  launcher + fixed-position panel (`screen-desk-assistant`, Intercom-messenger
  style, bottom-right). The open panel (`screen-desk-assistant-panel`) stays
  anchored in its corner on desktop and mobile; it has no drag handle, move
  gesture, position persistence, or movement tooltip. PRIVATE chat per member
  (3.5s poll only while open,
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

Every browser and cloud run now persists an evidence-backed execution
receipt in its existing thread: named artifact, objective sources/tool/code/
check/preview evidence, typed handoff, and structured significance. Ready is
accepted only when runtime records corroborate the claimed artifact; factual
reports/checks require actual sources or read tools, while a delivered draft
can prove itself as the artifact. Missing proof downgrades to Needs review;
blocked work requires one concrete request to a human. A validated No
material change check still writes its audit row but suppresses completion
sound, background toast and desktop notification. Manual Run now follows the
same rule. Deep-research automations submit the same claim through a stripped
hidden marker because that pipeline has no final tool round.

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

Connector studio: add MCP servers from a catalog or by URL, OAuth/device
sign-in, per-server tool listing and health, and native GitHub / Slack / Intercom
connectors. Connected servers appear in the composer Studio popover, Profiles,
and Skills.

Blender MCP (2026-09-05): catalog → Popular or Design / search “Blender”
(`mcp-catalog-search`) → **Set up** (`mcp-catalog-connect-blender`) →
`BlenderMcpSetupDialog` (`blender-setup`). This is the third-party
ahujasid/blender-mcp integration, NOT an official hosted Blender endpoint.
The catalog entry explicitly has `setup: blender` and no shared URL; it
cannot be auto-added by the fixed-endpoint or bulk catalog factories.
Guide (2026-09-08, self-protecting bridge): install the add-on in local
Blender, start its TCP socket (9876), download `gera-blender-bridge.py`
(`blender-download`, served verbatim from `web/public/`) and run
`uv run gera-blender-bridge.py --tunnel` on the same machine. The script is
Python standard library only: it spawns upstream `uvx blender-mcp` on stdio
(`DISABLE_TELEMETRY=true`), serves Streamable HTTP at
`http://127.0.0.1:8000/mcp`, and answers **401** + `WWW-Authenticate: Bearer`
to every request without its own token (generated once into
`~/.gera/blender-bridge.token`, printed at start; `--rotate-token`,
`--show-token`, `--token`, `GERA_BRIDGE_TOKEN`). `--tunnel` starts a
Cloudflare quick tunnel via `cloudflared` and prints the
`https://….trycloudflare.com/mcp` address plus token to paste; the address
changes on every cloudflared restart, the token does not. Any other HTTPS
tunnel works without `--tunnel`. Wire: `server/discover` → JSON-RPC -32601
(so Gera's client falls back to the initialize handshake), `initialize`
answered from the cached upstream handshake with a fresh `Mcp-Session-Id`
(one shared upstream session; stale ids are tolerated rather than 404ed).
Protocol revision: the bridge speaks the initialize line only
(`2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`) because
`blender-mcp` (1.9.1, 2026-09-02) pins `mcp<2` and the Python SDK 1.x
ceiling is `2025-11-25`; the spec's current revision `2026-07-28`
(`server/discover`, no handshake/sessions, SDK 2.x) is Gera's client-side
probe, not something a stdio wrapper can add. `negotiate_version` (bridge
1.0.1) never advertises a revision newer than the one upstream actually
negotiated: requested 2025-11-25 over an upstream on 2025-06-18 →
2025-06-18; an older supported request is honoured; unknown/modern requests
→ the upstream revision.
notifications → 202, other requests forwarded with id remapping, GET → 405,
DELETE → 204, upstream crash → error then restart on the next request,
per-request timeout → -32001. No CORS headers are ever emitted. It does NOT
replace the add-on or its 9876 socket — it wraps the upstream stdio server.

Bridge 1.1.0 (2026-09-08, files from the internet): two bridge-owned tools
are appended to blender-mcp's `tools/list` (`annotate_tools`; the
`execute_blender_code` description gets a note pointing at them, `initialize`
`instructions` too) and answered by the bridge itself, never forwarded.
Reason: the asset host `pub-…r2.dev` answers Python's default
`Python-urllib/3.x` User-Agent with 403 (curl / requests / browser UAs get
206/200, verified 2026-09-08), a transfer inside `execute_blender_code`
blocks the add-on with no retry or resume, and blender-mcp's safe mode
rejects network code outright — so a Gera run could only fetch 256-byte Range
probes and never import. `download_file({url, filename?, overwrite?,
wait_seconds?})` fetches a public http(s) URL on the Blender computer with a
browser-grade UA (`Mozilla/5.0 (compatible; gera-blender-bridge/…)`, a 403
is retried once with a Chrome UA), retries with backoff on network errors /
408/425/429/5xx (Retry-After honoured, 5 attempts), resumes dropped
transfers with `Range` + `If-Range: <ETag|Last-Modified>` (200 instead of
206 → restart), falls back to `curl` when the Python has no CA bundle, caps
the size (`--max-download-mb`, default 2048), infers a missing extension
from the `glTF` magic / Content-Type, verifies the result (GLB header +
JSON chunk, glTF JSON, .blend magic; an HTML page saved as `.glb` is refused
with the Content-Type named) and returns `{status, path, bytes, sha256,
content_type, verification: {ok, detail, generator, nodes, meshes,
materials, skins, animations: [{name, seconds, channels}],
external_resources}, hint}`. Files land in `~/.gera/blender-downloads`
(`--downloads-dir`) next to a `manifest.json`; the same URL again returns
the saved file instantly (`cached: true`), `overwrite: true` refetches,
unrelated files with the same name get a `-<sha1(url)[:6]>` suffix. A call
waits at most `wait_seconds` (default 25, max 30 — under Gera's 40 s
`tools/call` budget) and then reports `status: "downloading"` with
received/total/percent; the transfer keeps running in a thread and the next
call with the same URL picks it up (a client that disconnected early does
not kill it). `import_model_from_url({url, filename?, collection?,
overwrite?, wait_seconds?})` does the same download, then sends the bridge's
import script through upstream `execute_blender_code`: literal operator
candidates per extension (`.glb/.gltf` → `import_scene.gltf`; `.fbx` →
`wm.fbx_import` then legacy `import_scene.fbx`; `.obj/.stl/.ply` → `wm.*_import`
then legacy; USD/ABC/DAE via `wm.*`; `.blend` appends all objects through
`bpy.data.libraries`), no `os`/`open`/computed `getattr` so it passes
blender-mcp's safe mode (verified against the upstream validator; the
`.blend` branch is the one thing safe mode rejects, honestly). Existing
objects stay untouched; the reply lists new objects (type, dimensions,
location, parent, vertices, materials, bones, action), new actions (name,
frame range, seconds), scene fps/frame range, optional target collection
(created, objects moved), plus the file facts. A missing `GERA_IMPORT_JSON`
line returns the Blender text as `status: "failed"` (file stays saved).
Both tools carry annotations `readOnlyHint: false, destructiveHint: false`
(→ Gera risk "write", so "Confirm write tools" asks, like
`execute_blender_code`); failures come back as `isError` tool results with
`status: "failed"`, never JSON-RPC errors. Only `http`/`https` URLs, basename
sanitised to `[A-Za-z0-9._-]`, logs name host + file (never the full URL or
the token). Gera caches a server's catalog for 10 min: after replacing an
older bridge, press Re-check on the Blender card so the two tools appear.
UI: `blender-mcp.ts` exports `BLENDER_BRIDGE_VERSION`,
`BLENDER_BRIDGE_TOOLS`, `BLENDER_BRIDGE_DOWNLOADS_DIR`; the setup dialog
step 2 explains the tools and the re-download + Re-check step.
The previous third-party bridge is kept only as a pinned alternative:
`uvx --with "mcp<2" mcp-proxy …` (`mcp-proxy` 0.12 has no upper bound on
`mcp`, and `mcp==2.0.0` of 2026-07-28 removed `request_ctx`, so a plain
`uvx mcp-proxy` fails with `ImportError: cannot import name 'request_ctx'`);
it has no auth of its own and must stay behind Cloudflare Access Service
Auth. Never tunnel the raw 9876 socket or expose an unauthenticated bridge.
The web app does not install software or run Blender locally.
Form uses `blenderSetupSchema`: public HTTPS only, no localhost/private
hosts, website/stdio URLs, port 9876, URL credentials/query/fragment;
selected auth fields + explicit risk acknowledgement required. Default auth
is the bridge's Bearer token (`authMode: bearer`, token to the vault);
Cloudflare credentials become `CF-Access-Client-Id` /
`CF-Access-Client-Secret` headers, not an OAuth popup. Connect keeps `catalogId: blender` through the existing
`/mcp/check` → vault → generic MCP path; no backend transport or network
exceptions. Cancel/invalid input sends nothing and adds no phantom row.
The connected card offers setup/credential replacement; existing disabled
tools are preserved. Before verification, the stored-credential flag is
unknown, not false (false would request vault deletion on a later retry).
Secrets are excluded from persisted browser settings.
Verification here means MCP handshake + tools/list, NOT that Blender is
open or a scene operation succeeded: the guide asks the user to run
`get_scene_info` without changes as the first actual scene check. Requires
the user's running Blender and reachable secured bridge; real-device scene
operations are not covered by the hermetic tests.
Unit `blender-mcp.test.ts`: endpoint rejection, auth mapping, cloud tool
eligibility, catalog guards, profile preservation, the documented commands
and a static contract check of the shipped script (stdlib-only imports,
loopback default, `compare_digest` Bearer gate, discover → -32601, tunnel,
token file, no CORS) plus a 1.1 contract check (version, both tool names,
browser-grade UA + 403 fallback, Range/If-Range resume, 25 s wait, cached
flag, GLB refusal, importer chains, safe-mode-clean script, http(s)-only,
sanitised names, tools/list + tools/call interception, host-only logging).
The bridge's live behaviour was exercised on
2026-09-08 against a stdio fixture (`tmp/fake_blender_mcp.py`, not shipped):
401 without/with wrong token, discover probe, initialize + session id,
202 for notifications, id remapping, tools/call, 405/204/404/400, two
parallel 2 s calls in 2.0 s, -32001 timeout, crash → restart, batch. That
is a local fixture run, not a Blender or tunnel check. Bridge 1.1.0 was
exercised the same day against the fixture upstream (it echoes a
`GERA_IMPORT_JSON` summary for `execute_blender_code`) and a fixture file
server (`tmp/bridge-fixture/files.py`, not shipped): plain GLB → done +
animations; 403 for the bridge UA → browser UA → done (`attempts: 2`,
note); connection dropped mid-body → `Range` resume → done (note); HTML
as `.glb` → `isError` refusal naming `text/html`; slow file with
`wait_seconds: 1` → `downloading` → second call `done`; extension-less URL
→ `.glb` from the magic; repeat → `cached: true`; `file:`/`ftp:`/missing
url → refused; 404 → failed; `import_model_from_url` → `imported` with
the Blender summary; non-model → refused with the saved path. Against the
real asset host the user's two GLBs (11.4 MB and 7.3 MB from
`pub-…r2.dev`) downloaded in 0.6 s / 0.5 s as valid glTF 2.0 with their
Mixamo clips listed (`Goalie_Throw` 3.87 s, `Dribble` 1.77 s, …). Not a
Blender check: the import step reached a fixture, not a running Blender. Browser scenarios
`blender-mcp-setup` (guide with the `uv run … --tunnel` command, 401 note
and download link, bad URL, cancel, zero checks) and `blender-mcp-connect`
(fixture bridge with a Bearer token, verified tools, token absent from
browser persistence). Testids: `blender-guide`, `blender-endpoint`,
`blender-auth`, `blender-client-id`, `blender-client-secret`, `blender-token`,
`blender-acknowledge`, `blender-connect`, `blender-cancel`, `blender-errors`.
Verification 2026-09-05: unit 87 files / 994 checks; browser 8 files / 47
checks (18.59 s). Browser config prebundles form dependencies to prevent a
mid-test Vite reload / duplicate React hooks.

Deferred tools (2026-09-04, `functions/mcp-toolset.ts` — the ONE resolver
every run kind uses: chat/resume/Julius in `run-manager.ts`, cloud automations
in `automation-runner.ts`, project agents in `project-store.ts`
(`buildAgentToolset`), Deep Research in `research-runner.ts`; Slack agents
still get no generic MCP via `accessForAgentSurface`). Setting "MCP tool
loading" (Settings → Toolkit, `settings.mcpToolLoading`, synced in the
profile, snapshot sent in every `/runs/start` config as `mcpToolLoading` +
`contextWindow` from the gateway catalog): **auto** registers one
`mcp_<server>_<tool>` function per tool while the visible generic MCP tools'
schema JSON stays under 15% of the model's context window (unknown window →
128k; the tool count alone never decides — `DEFERRED_AUTO_CONTEXT_SHARE`), but only when all catalogs are warm. Any cold/expired catalog chooses deferred without connecting. Warming does not change the current run's mode; the next run prices the warmed catalogs again. Otherwise auto defers; **native** always inlines (no per-run cap since
2026-09-05; 500 per server is the one remaining fuse — a server that does not
fit leaves an honest `mcp_limit` record naming it and pointing at the
setting); **deferred** always
exposes only two meta functions — `mcp_search_tools({query, serverId?,
limit?})` (full text over names, descriptions and inputSchema fields; exact
name → name token → description → field name; up to 20 descriptors with
complete schemas plus every server with its tool count and unavailability
reason) and `mcp_call_tool({serverId, toolName, arguments})`, which runs only
a tool whose complete descriptor was actually returned in this run. Startup and unaddressed search read cache only: unloaded servers have `toolCount:-1` / `catalogStatus:unloaded`, not zero tools or a connection failure. An addressed search connects only that server. A first cold call does the addressed search and returns `executed:false` plus the schema; it never invokes tools/call. The next call checks current schema, existence, disabled/UI-only, allowlist and confirmation. Oversized/omitted descriptors are never revealed. The system prompt gets one line per deferred server (known tool count or catalog-not-loaded), not all schemas.
Native GitHub / Slack / Intercom connectors always register inline (their
function names drive the code-changes workbench and the repo preflight).
Deferred limits: 5 000 tools per server, 6 MB of schema JSON (over → the
server is reported unavailable). Run budgets (2026-09-05, replacing the old
8-servers-per-run and 5-servers-per-agent counts, which are gone from
`cloudMcpServersForAutomation`, `parseMcpSelectionPatch` and the agent
editor — "N linked", no cap): explicit native starts handshakes in parallel. Each addressed lazy connect/refresh is single-flight and bounded to 20 s from before its credential lease through catalog pages (`CONNECT_BUDGET_MS`). It never waits for other servers. Timeout leaves the operation aborted; closing a run prevents late requests, cache writes and stream attachment. Durable OAuth rotation still commits safely. Cached catalogs are admitted at startup and newly loaded catalogs on use until their JSON would exceed 24 MB
(`RUN_CATALOG_CHARS`), the rest stay out with an `mcp_limit` record "left
out of this run … combined tool catalogs" naming them (health checks are
uncapped). Unit: `mcp-toolset.test.ts` (12 servers × 30 tools → 360
functions, per-server fuse, 20 servers reach the resolver, slow server +
lease-inclusive timeout/close, no late publication, and lazy catalog budgets); `project-shared.test.ts` (12 persisted links through actual owner resolve and tool execution, durable warmup, delegation revocation). Catalog cache: account-shard table
`mcp_tool_catalog` (full remote table incl. disabled tools, TTL 10 min)
written by every `/mcp/check` (Connect / Re-check now runs uncapped and no
longer truncates big servers at 90) and by every handshake a run performs;
`/mcp/resolve` ships `toolLoading` + the cached `catalog` to project shards so
agents defer without a handshake. Chat rows for the meta calls read
"MCP · <server> · <tool>" (`describeToolCall`, testid `message-tool-call`,
inside a `message-tool-group` batch placed where the model issued them — see
Reply timeline under Chat) with the same running/done/failed chip as native
tools. Binary parts of a
result (2026-09-04, `extractMcpResultMedia` in `mcp-protocol.ts`): `type:
"image"` parts (up to 5 / 4 MB per call) become thumbnails under the row
(`message-tool-images`, `ToolCallMedia`) and message images; audio parts and
embedded `resource` blobs (4 MB each) become saveable chips
(`message-tool-file`, Save = download via `downloadOrOpenMedia`); anything
over a cap is described in the model text. The run persists them as
`gera-cloud:` refs on `toolCalls[].images` / `.files` (`persistMedia` →
`agent_run_media`, per-run idx counter); the tab resolves and vaults them
(`resolveToolCallMedia`, pulled chats too). A vision model (web: `vision`
from the catalog's `modalities.input`; background runs / old clients:
`model-catalog.ts`, gateway `/v1/models` cached 10 min, unknown → no) gets
the pictures as one extra user message per tool round ("Images returned by
<tool> (n):" + `image_url` parts, max 8); text-only models keep the stub.
Unit `mcp-result-media.test.ts`. Unit
`mcp-toolset.test.ts` (a–e acceptance: 3×40 tools → exactly two MCP
functions, search by description word and schema field, call refused before
search then lazy connect, disabled tools invisible + refused, setting picks
the mode, auto thresholds, uncapped health check refreshes the cache, native
connectors stay inline next to deferred servers, rejected server reported
without leaking its credential); browser scenario
`connect-open-mcp-deferred`.

Stateless revision 2026-07-28 (2026-09-05, `functions/mcp-protocol.ts`, one
source of versions: `MCP_MODERN_PROTOCOL_VERSION(S)`, legacy
`MCP_LATEST_PROTOCOL_VERSION` / `MCP_SUPPORTED_PROTOCOL_VERSIONS` /
`MCP_DEFAULT_PROTOCOL_VERSION` — `mcp-cloud.ts` no longer keeps its own
copy). `mcpConnect` probes `server/discover` first (5 s,
`DISCOVER_TIMEOUT_MS`): a result with `supportedVersions` ∋ 2026-07-28 puts
the session on the **modern** wire (`session.wire`), `-32022` is retried once
with the newest supported intersection from `data.supported`. `-32021` gets at most one correction for implemented nested capabilities (form elicitation/empty roots only); unsupported requirements and second refusals remain structured errors. Recognized modern errors never trigger initialize. Other legacy/transport probe failures
(404/-32601, non-JSON-RPC 4xx/5xx, silence) falls back to the legacy
initialize handshake unchanged; 401/403 propagate. Modern requests carry
`_meta` (`io.modelcontextprotocol/protocolVersion`, `clientCapabilities`
(`elicitation: { form: {} }`), `clientInfo`), headers `MCP-Protocol-Version`,
`Mcp-Method`, `Mcp-Name` (tools/call name, resources/read uri, prompts/get
name; non-ASCII as `=?base64?…?=`), never `Mcp-Session-Id` (a stray one is
ignored), no `initialize` / `notifications/initialized` / `ping`. Results:
missing `resultType` = complete; `input_required` (tools/call, resources/read,
prompts/get via `mcpRequestWithInput`) answers each `inputRequests` entry
through the session's server-request handler — `elicitation/create` → the
same run-pause card / honest background decline, `roots/list` → `[]`,
`sampling/createMessage` → refused — and re-sends the call (new id) with
`inputResponses` + the opaque `requestState`, up to 3 rounds
(`MCP_MAX_INPUT_ROUNDS`). `serverInfo` comes from
`result._meta["io.modelcontextprotocol/serverInfo"]`. Notifications:
`subscriptions/listen` POST (filter from capabilities) whose SSE response
stays open — acknowledgement, then `notifications/*/list_changed` → catalog
invalidation; a final `result` frame = server closed it. JSON-RPC errors on
400/404 bodies surface as `McpRpcError` (`rpcCode`, `rpcData`,
`httpStatus`). The negotiation is cached with the tool catalog
(`McpCatalogEntry.wire`: era, version, capabilities, serverInfo; SQL payload
key `wire`, `/mcp/resolve` carries it) so runs skip the probe (a stale
"modern" hint that meets -32601/404/405 is redone with a fresh probe); a
Re-check (uncapped) always probes afresh. `/mcp/check` returns
`protocolVersion`; the card persists it (`McpServerConfig.protocolVersion`)
and shows "MCP <revision>" (`mcp-protocol-badge`) next to the verified line.
Cloud and relay share `mcp-headers.ts`'s explicit four-header table; configured credentials cannot override protocol-owned headers and modern never echoes sessions. Static CORS Allow/Expose includes Method/Name; OPTIONS still echoes requested fields. Optional request-scoped `logLevel` is carried through discovery, pages, calls, input rounds and subscriptions without a default level. OAuth challenge probing uses the same envelope/versions. The badge recognizes only `MCP_MODERN_PROTOCOL_VERSIONS.includes(...)`. Unit:
`mcp-modern-protocol.test.ts` (in-process stateless server: discover →
modern path, -32022 retry, legacy fallback, input_required round trip,
background decline + sampling refusal, listen stream invalidation, cached
hint vs Re-check, mixed modern + legacy run, header encoding);
`mcp-conformance.test.ts` preserves the real SDK 1.x legacy suite. `mcp-sdk-v2.test.ts` runs the official `@modelcontextprotocol/server@2.0.0` with `createMcpHandler(factory, { legacy: "reject" })`: cold two-step calls, inventory, cache reuse, subscription invalidation, interactive MRTR and unattended decline. Its Standard Schema adapter uses the app's existing Zod validation without upgrading app dependencies. `mcp-modern-regressions.test.ts` covers nested capability/log metadata retries, no fallback on modern errors, SQL inventory wire and partial-read preservation, malformed wire, owner-write races, refresh cancellation and relay headers. This proves these flows, not every optional MCP feature or extension.

Protocol core & spec coverage (2026-09-04, `functions/mcp-protocol.ts` — the
ONE JSON-RPC / Streamable HTTP implementation; `mcp-cloud.ts` is a thin
transport over it; the browser legacy transport was deleted on 2026-09-06).
`fetch` is injected (production keeps the public-HTTPS guard; the conformance
suite talks to 127.0.0.1). Initialize proposes **2025-11-25** and declares
`elicitation: { form: {} }`; accepted answers: 2025-11-25 / 2025-06-18 /
2025-03-26 / 2024-11-05 (anything else → honest "unsupported MCP protocol
version"); `MCP-Protocol-Version` rides on every request AFTER initialize
(never on initialize itself), `Mcp-Session-Id` is adopted from the response
and redacted from provider text. SSE bodies are read incrementally: progress
notifications dispatch as they land, server → client requests are answered by
POST (`ping` → `{}`, `roots/list` → `[]`, `sampling/createMessage` → method
not found, `elicitation/create` → see below); the idle timeout pauses while a
handler runs. 401/403 → `McpAuthRejectedError` (status + WWW-Authenticate kept
for Phase 3), 404/"session" 400 after a session id → `McpSessionLostError`,
bodies over 2M chars refused.

- **Annotations & MCP Apps**: `tools/list` `annotations` (readOnlyHint,
  destructiveHint, idempotentHint, openWorldHint, title) and `title` are kept
  on catalog tools and shown as badges on McpStudio tool rows (testid
  `mcp-tool-badge`: read-only / destructive / idempotent / open-world /
  UI-only). A tool with `_meta.ui.resourceUri` or `_meta["ui/resourceUri"]`
  is **UI-only**: kept in the catalog for the badge (switch disabled), never
  registered as a function, never returned by `mcp_search_tools`, refused by
  `mcp_call_tool` with the reason.
- **Prompts & resources** (`functions/mcp-routes.ts`, account routes through
  the `McpRouteContext` seam; ChatStore dispatches three lines): `/mcp/check`
  now lists prompts / resources / templates too (`inventory: true`, bounded
  200/300/100) and returns `promptCount` + `resourceCount` (card: "N tools · M
  prompts · K resources"); `/mcp/inventory {serverId}` answers from the
  account catalog cache when fresh (else one handshake refreshes it);
  `/mcp/prompt-get {serverId, name, arguments}` and `/mcp/resource-read
  {serverId, uri}` connect server-side (credentials never leave the shard).
  Composer (chat mode): typing `/` at the start or after whitespace opens the
  prompts menu (testid `composer-mcp-menu`, rows
  `composer-mcp-prompt-<server>-<name>`), `@` the resources menu (rows
  `composer-mcp-resource-<server>-<uri>` / `composer-mcp-template-…`); menus
  list only connected, enabled, generic servers (native GitHub/Slack/Intercom
  never), filter on the typed query, arrow/Enter/Tab/Escape. A prompt with
  arguments opens the form dialog (`mcp-args-dialog`, fields
  `mcp-args-field-<name>`, required enforced, `mcp-args-submit`); the result
  replaces the token with the prompt text (one user message as-is; several or
  assistant turns keep `[user]` / `[assistant]` markers), inline images become
  attachments. A resource replaces the token with `@<server>/<uri>` and
  attaches the read: text as an extracted-text attachment (server cap 300k
  chars, truncation noted in the text), blobs ≤ 4 MB as a data-URL attachment,
  larger ones as an honest note with mime + size; templates open the same
  dialog for their URI variables (RFC 6570 level-1 expansion). Inventories
  cache client-side for 5 minutes (`web/src/lib/mcp-inventory.ts`).
- **list_changed**: after a run's handshake, when the server advertises
  `listChanged` for tools/prompts/resources, the toolset opens the standalone
  GET stream (405/404/no-SSE → no stream, no error) and closes it when the run
  settles (`toolset.close()` from `finishRun`; automations close in `finish`);
  a `notifications/*/list_changed` drops the account catalog entry and marks
  the run's table stale — the next `mcp_search_tools` / `mcp_call_tool`
  re-lists on the live session (journal `catalog_refreshed`). Project agents
  run with `notificationStreams: false` (short background runs; the owner's
  cache carries the change to their next resolve). Browser: Re-check.
- **Elicitation** (`functions/run-pause.ts` — the ONE run-pause board,
  reused by Phase 4 confirmations): `elicitation/create` arriving on the
  tools/call stream or the GET stream is flattened to fields (string / number
  / integer / boolean, enums incl. titled `oneOf`, formats, bounds, defaults).
  Interactive chat runs pause: RunManager emits `{t:"pause", pending}` (also
  in the persisted snapshot, so a reopened tab sees the card) and the thread
  shows a card (`run-pause-card`: server name, message, form fields
  `run-pause-field-<name>`, Accept `run-pause-accept` / Decline
  `run-pause-decline` / Cancel, time left). Answers go to `POST /runs/answer
  {conversationId, requestId, answer}`; the board validates accepted values
  against the schema (field errors come back and show on the card; values are
  never logged or journaled) and resolves the waiting tool call; 5 minutes
  without an answer → `cancel`; Stop and run end cancel every open card. The
  toolset re-validates before replying and answers `cancel` on a mismatch.
  Background surfaces (automations, project/Slack agents, Deep Research
  scout) answer `decline` and record it — automations show an
  `mcp_elicitation` tool record naming the server; URL-mode elicitation is
  declined everywhere with the reason. Research/Julius runs are not
  steerable and never pause.
- **Policy & confirmations** (2026-09-04, `functions/mcp-policy.ts` — the
  pure policy: allowlist, risk, verdict, argument preview, prompt wording;
  `functions/mcp-journal.ts` — journal rows; the gate itself lives in
  `resolveMcpToolset` so inline functions, native GitHub/Slack/Intercom
  routes and `mcp_call_tool` all pass the same door). Risk: `readOnlyHint`
  true → read; `destructiveHint` true → destructive; anything else —
  annotations missing included — is a write; native connectors use a static
  table (GitHub create/put/branch/pull writes, `delete_file` destructive,
  Slack `send_message`, Intercom reply/send). Allowlist (`policy.allow`,
  server id → tool names | null): servers outside a set allowlist take no
  part in the run; non-allowlisted tools vanish from inline definitions,
  search results and counts, and `mcp_call_tool` refuses them ("not allowed
  by this agent's MCP policy", journal `policy_blocked`). Write policy
  `ask`: read-only tools run; write/destructive calls on interactive chat
  runs pause on a confirmation card through the run-pause board
  (`kind: "confirmation"`, `confirm: {toolName, risk, argumentsPreview}` —
  the preview masks secret-looking keys, runs the server's credential
  redaction and caps at 2 000 chars; `run-confirm-card`, buttons
  `run-confirm-once` → `{action:"accept"}`, `run-confirm-always` →
  `{action:"always"}` + the thread remembers `mcpApproved` so later runs
  skip the card, `run-confirm-decline`); 10 minutes without a decision
  declines; the model is told not to retry a declined call. Unattended
  surfaces (automations, project/Slack agents, the Deep Research scout)
  decline honestly ("this unattended run cannot ask") and the system
  prompt says so up front. Account switch: Settings → Toolkit "Confirm
  write tools by default" (`settings-confirm-writes`,
  `settings.confirmWriteTools`, synced; the tab's snapshot rides in
  `StartRunConfig.confirmWriteTools`, the profile is the fallback) covers
  chat, resume, Deep Research and cloud automations. Journal: every
  granted / always / declined / timed-out / blocked decision becomes a
  `diagnostics` row with scope `mcp-policy` ("Declined: write_thing on
  Things", detail = server id, tool, run surface + label, reason — never an
  argument value); RunManager and the automation alarm append directly to
  the account shard, project agents post to the linking owner's shard.
  Automations also keep `mcp_policy` tool records in the thread. The
  Diagnostics badge ignores `mcp-policy` rows (audit trail, not errors).
- **Conformance** (`web/src/test/mcp-conformance.test.ts`, unit run, Node):
  an in-process `@modelcontextprotocol/sdk` 1.30 Streamable HTTP server
  (stateful sessions, random port) proves version negotiation, the version
  header + session echo on every later request, 3-page `tools/list`
  pagination, prompts/get, resources/templates/read, the account routes
  (inventory cached on the second call, prompt-get, resource-read, 404 for an
  unknown server), elicitation accept + decline through the pause hook,
  background decline journaling, UI-only hiding/refusal, `list_changed` over
  the GET stream refreshing the catalog. Mocks of those scenarios were removed
  from `mcp-security` / `mcp-file-content`; only failures a conforming server
  never produces stay mocked (`mcp-protocol.test.ts`: 401/403 with challenge,
  lost session, oversized body, unsupported revision, 405 GET, in-stream
  ping/notification dispatch, elicitation validation, URI templates, pause
  board, composer trigger parsing).
- **OAuth parity** (2026-09-04, `functions/mcp-oauth-flow.ts` discovery,
  `functions/mcp-auth-challenge.ts` — WWW-Authenticate / scope-string parsing
  + rejection classification, `functions/mcp-oauth-scopes.ts` — the
  `mcp_oauth_scopes` table (requested / granted / required / step_up_code per
  connector, metadata only), `/mcp/oauth-start` now served by
  `functions/mcp-routes.ts` through the same seam as the menus). Server card
  → "Advanced · OAuth" (collapsed; testid `mcp-advanced-toggle`; shown for
  OAuth servers and custom "auto" servers) holds **Scopes**
  (`mcp-scopes-input`, RFC 6749 §3.3, commas/newlines tolerated, illegal
  tokens dropped) and **Authorization-server metadata URL**
  (`mcp-metadata-url-input`); committing a changed value (blur / Enter) signs
  the server out (`/mcp/oauth-clear` disconnect, card back to idle,
  `credentialStored` false) — press Sign in afterwards. Both sync in the
  profile as `oauthScopes` / `authServerMetadataUrl` and ride in the
  `/mcp/oauth-start` body. Scope decision on the shard: pinned scopes go into
  the authorize URL as-is (`scopeSource: explicit`); without a pin, an
  unauthenticated shared modern-first negotiation of the MCP URL reads the 401 challenge's
  `scope` (and its `resource_metadata` becomes the first PRM candidate, RFC
  9728 §5.1), then the protected resource's `scopes_supported`, then the
  authorization server's; `offline_access` is appended only when the
  authorization server declares it. Metadata URL override: public HTTPS only
  (http:// / private hosts refused before any request: "OAuth metadata URL
  must be a public HTTPS URL"), the document replaces the well-known walk, and
  its `issuer` must match a server the protected-resource metadata named (or,
  when none was named, the issuer its own well-known path encodes / its
  origin) — mismatch is refused. The token response's `scope` is recorded as
  granted (silence = as requested). **Step-up**: a 403 (or 401) whose Bearer
  challenge says `error="insufficient_scope"` — or a 403 naming scopes — on
  tools/call or the handshake parks the server for the rest of the run (no
  retry with the same token; native routes and `mcp_call_tool` answer from
  the parked state, `mcp_search_tools` lists it as unavailable), journals
  `step_up_required`, and reports through `reportFailure` with
  `requiredScopes` → `mcp_oauth_states` = `step_up_required` +
  `mcp_oauth_scopes.required`. The tool result names the fix ("Sign in again
  with wider access"). While pending: `/mcp/check` still handshakes and lists
  tools but returns `stepUp: { scopes, code }` and does NOT clear the marker
  (nor does `/mcp/auth-lease`); the card shows the amber hint
  (`mcp-step-up-hint`) with the button `mcp-step-up-sign-in`, which forces the
  popup (`signInMcp`) even though the card is green; chat runs record an
  honest `mcp_auth` row for the parked server instead of silently dropping
  it. The next `/mcp/oauth-start` asks for pin ∪ granted ∪ required;
  `/mcp/oauth-complete` records the grant and clears required/code → `ready`.
  Check failures `step_up_required` / `reauth_required` render in plain words
  on the card. Unit: `mcp-oauth-scopes.test.ts` (challenge parser, scope
  order, pin in the authorize URL, offline_access rule, override used /
  http refused / issuer mismatch, route with an in-memory shard, step-up
  union + clearing, toolset parking in deferred and native mode, blocked-run
  records); browser: `oauth-step-up`.

Deployment recovery (2026-09-05): a reset of AccessRegistry now returns
`identity_unavailable` / 503 with `transient` + `retryable`, not a provider-auth
verdict. `/mcp/check` retries it once, including old responses without the flag;
both attempts use `authedFetchForSession` pinned to the original account.
Saved `identity_unavailable` and old internal-check errors can self-heal. A
stored generic upstream `auth rejected (401)` with `credentialStored: true`
is rechecked against the vault on boot and at most every ten minutes; explicit
reauth/step-up/missing-key/conflict verdicts are not auto-retried. Errors remain
visible until a real successful check (no optimistic green). Already verified
cards stay armed through transient manual/background failures. Account-scoped
in-memory `mcp-health.ts` bookkeeping prevents a late check from overwriting a
newer success, config edit, removal, disable or account switch, and suppresses
the duplicate forced check after recovery. Cancelling an in-flight check by
editing/disabling returns the card to idle so Connect stays usable. Unit:
`mcp-health.test.ts`, `mcp-check-retry.test.ts`, `mcp-session.test.ts`. Browser:
`mcp-deploy-recovery` (GitHub/Intercom stored identity errors + TesterArmy stored
401; unchanged credentials, bounded request counts, persisted success),
`mcp-cancel-check` (Connect → disable/enable → Connect, old failure cannot win).
These are fixture regressions, not a live verification of this user's provider grants.

Server ownership (2026-09-01): OAuth access/refresh grants, pasted API keys,
custom headers, refresh single-flight, connection checks, protocol sessions and
tool calls are owned by the signed-in account's ChatStore shard. Grants are
minted only by the server-side flows (`/mcp/oauth-start` → popup →
`/mcp/oauth/callback` → `/mcp/oauth-complete`; GitHub device flow
`/mcp/github-device-start|status`) and sealed there in one step;
`/mcp/check` stores submitted key/header material in the server vault and returns
only redacted tool/status metadata plus a non-secret `credentialStored` flag. The
health request sends only connection fields—not cached tool schemas—so large
servers cannot exceed the control-route body cap. Re-checks always return the full
tool table (including locally disabled tools), and legacy instance IDs can reuse
their catalog ID's server-owned key or OAuth grant. Browser profile and local settings serializers
strip `token` and `headersJson`; a legacy `mcpOAuth` half of a synced profile is
ignored by the browser and dropped (never imported) by the shard.

No browser-held grants (2026-09-05, `web/src/lib/mcp-oauth.ts` slimmed to the
popup driver + non-secret markers; `web/src/lib/mcp-credential-migration.ts`).
The browser never reads or writes an access/refresh token or a client
registration: `hasOAuthToken` / `oauthAuthHeader` / `exportOAuthTokens` /
`adoptProfileOAuthTokens` / rotation adoption are gone, and
`/mcp/oauth-store` + `/mcp/oauth-refresh` answer 410
`server_owned_oauth_required` to any old bundle (no silent import of a
browser token). Boot (`initialAgentState` → `bootSettings`) purges every
legacy key (`gera.mcp.oauth.tokens.v1`, `gera.mcp.oauth.token.v2.*`,
`gera.mcp.oauth.clients.v1`); a card that depended on one (OAuth catalog
server, `authMode: oauth`, custom `auto` server without key/headers, GitHub
device sign-in) and has no `credentialStored` proof becomes `status: error`
with `VAULT_RESIGNIN_NOTICE` ("Gera moved sign-ins to the server vault — sign
in again…"), rendered amber (`mcp-resignin-notice`, catalog badge "Sign-in
needed again"), Connect reads "Sign in"; vault-backed cards keep their status
and are verified by the session's health check. Old PAT/header copies in a settings blob are also purged, including blobs with no OAuth keys. Known vault credentials are retained; unknown presence is never turned into an explicit `credentialStored:false` deletion signal. Those cards request a server re-check before asking for a new key.
The migrated settings are saved at once so React StrictMode's second
initializer call reads the migrated copy. A non-secret report
(`gera.mcp.oauth.migration.v1`: counts + ids) feeds the Diagnostics line
"Browser grants retired · N moved to the vault · M await a fresh sign-in"
(`credential-migration`). Readiness (`cloudMcpReadiness`) and health retries
key on `credentialStored`. GitHub from the browser (`resolveGitHubAuth`):
vault first — `credentialStored` or a green card → `/github-proxy` probe →
the `gera-account:<id>` sentinel (repo picker, repo previews, repo-access
diagnostics all ride the proxy; `githubTransportFetch` passes headers as a
plain object so `X-Gera-GitHub-Accept` survives `authedFetch`). Raw PAT fallback is forbidden, even after vault 401. A new PAT is submitted only to the explicit Gera save/check route, then removed from the draft once stored. Unit:
`oauth-clear-safety.test.ts` (purge, no grant API, explicit disconnect
revokes), `mcp-credential-migration.test.ts`; browser: `oauth-sign-in-vault`
(stubbed server-side flow ends green with no token / nonce in localStorage,
`credentialStored: true`), `mcp-vault-migration` (legacy keys gone, amber
notice, Sign in button, report `moved 0 / awaiting 1`).

Encryption at rest (2026-09-04, `functions/secret-vault.ts`, `secret-rows.ts`).
Every credential a Durable Object stores is sealed with AES-256-GCM under a
data key derived (HKDF-SHA-256) from the `SECRETS_ENCRYPTION_KEY` Worker
secret; the key never touches storage. Key material must be base64 /
base64url / hex of at least 32 random bytes (`openssl rand -base64 32`);
whitespace inside the value (line-wrapped `openssl` output, paste artefacts)
is ignored for validation only — the data key is derived from the string
exactly as configured, so the production value must never be "cleaned up"
in place (that is a rotation: new value in `SECRETS_ENCRYPTION_KEY`, old one
in `SECRETS_ENCRYPTION_KEY_PREVIOUS`). Anything else disables the vault with
`secrets_key_missing` / `secrets_key_malformed` / `secrets_key_too_short`
(`GET /ping` reports `secretVault: enabled | <reason>`, nothing else about
the key). Sealed rows:
account shard `mcp_oauth_grants` (accessToken/refreshToken; endpoint, expiry
and ids stay readable), `mcp_server_secrets` (token/headersJson),
`mcp_oauth_pending` (all four proofs: PKCE verifier, authorization code,
browser_nonce, callback_challenge — the challenge is opened only to build the
popup's `confirm` redirect, and `/mcp/oauth-complete` compares both proofs
constant-time after the shard opens them), `mcp_github_device_pending`
(device_code) and the legacy KV `oauthref:*` rotation escrow (whole value,
`{ sealed }`); project shard `agents.secrets` (githubToken, intercomToken,
slackToken, slackSigningSecret, slackClientSecret — metadata such as
slackAppId/team/mcpSelection stays readable so the agent list and
`secretsSet` flags never need a key) and `meta.slack_config`
(access/refresh). Envelope `enc1:<kid>:<iv>:<ct>`; the additional
authenticated data binds each value to its row and field
(`mcp-oauth-grant:<owner>:<serverId>#accessToken`,
`project-agent:<agentId>#slackToken`, …), so a ciphertext copied into another
row or field fails to open. `<owner>` started as the account's
`storageOwner` — the alias AccessRegistry freezes at first claim and binds to
the Rork user id. Since 2026-09-04 (`functions/vault-scope.ts`,
`vault-scope-sweep.ts`) it is `acct:<account_id>` (the immutable Rork Auth
subject): the Worker stamps `X-Gera-Account-Id` on every relayed shard call
(`shardCall`); the shard adopts it on first sight — or, when an internal call
(`/mcp/resolve`, `/mcp/auth-lease`, cron `/fire`) comes first, asks the
AccessRegistry (`POST /principal/lookup`, internal route `principal-lookup`,
misses remembered 5 min) — and runs a one-time sweep under
`blockConcurrencyWhile` that re-seals every credential row + the KV escrow
into the account scope and stamps the new `account_id` column
(`mcp_oauth_grants`, `mcp_server_secrets`, `mcp_oauth_pending`,
`mcp_github_device_pending`). The sweep tries the new scope first, then the
old one, so it is idempotent and resumable; values it can open under neither
are kept (never deleted) and counted; marker `vaultScope` in KV. After it,
`CredentialScope.subject(owner)` names the account and the owner scope is
dead outside the sweep. A request whose account id contradicts the adopted
one is refused (409 `wrong_account`); requests without the header keep
working. Unit `vault-scope.test.ts`. RunManager seals/opens grants through
the same `secret-rows` helpers (and the same `CredentialScope`) as ChatStore. Migration export/import moves envelopes as-is (same owner + server
id ⇒ same scope). No plaintext passthrough: `open` accepts only envelopes and
refuses a plaintext value where a credential should be (`secret_unreadable`,
"plaintext rejected"), so a row swapped for plaintext in storage never
authenticates. The only reader of plaintext is `reseal`, used by the
one-time-per-key sweep each object runs on wake under `blockConcurrencyWhile`
(marker `secretVaultKid` in KV / `meta.secret_vault_kid`) — no request ever
sees an unswept shard, which is why no global "all shards woke" flag is
needed. The sweep continues past a row it cannot re-seal (logged coarse;
that row stays unreadable) and drops poisoned placeholder rows. Rotation:
set the new `SECRETS_ENCRYPTION_KEY`, keep the old in
`SECRETS_ENCRYPTION_KEY_PREVIOUS` (comma-separated, decrypt-only) until
every shard has woken once. Fail-closed: without a usable key every
credential read and write returns 503 `secrets_key_unavailable` with a plain
message (agent save, Slack app-manager token, OAuth store/complete,
`/mcp/check` with a pasted key, device start, sync of a profile carrying
keys). A row the key set cannot open is logged coarse and treated as a
missing grant (never a crashed run). Self-check: `GET /diag/vault` (identity
+ invite, same relay as the journal) returns counts only — `vault`, `swept`
(marker equals current key id), per-table `{ total, sealed, current,
plaintext }` for grants, serverSecrets, pending, deviceCodes, escrow, plus
`scope` (`account` | `owner`) and `unreadable` (values the account-scope
sweep could not open — the line says "N unreadable — reconnect those
servers"); the Diagnostics dialog/tab renders it as the "Credential vault · …" line
(`data-testid="vault-status"`, ember-tinted when anything is plaintext, under
a previous key, unswept, or the server key is unusable). Unit
`secret-vault.test.ts` (key-format acceptance/refusal incl. previous-key
list, roundtrip, AAD/row binding, tamper, IV freshness, plaintext refusal,
reseal as the sole plaintext reader, disabled key, rotation, field helpers,
tallySealed, grant/server-secret/escrow rows, all pending-flow scopes) and
`vault-status.test.ts` (summary + label copy).

Every interactive, scheduled, project and Slack run resolves its connector
configuration and credential again from durable server state. Run-start requests
carry only selected connector ids; any client-supplied credential or GitHub auth
is removed, and the backend ignores client connector config beyond that scope.
Refresh occurs 60 seconds before recorded expiry and reactively after auth
rejection, is committed before use, and survives browser closure or deploys.
The browser may still host the provider's authorization UI and a temporary PKCE
verifier, but it is not an MCP state owner.

Status checks also execute via the account shard. They do not start while Gera auth
is loading or signed out; an account-level `sign_in_required` response stays silent
and keeps every connector armed instead of masquerading as provider revocation. A
missing browser token/OAuth grant is likewise not a disconnect — credentials live
in the shard, so a green card without localStorage material stays connected and
cloud-ready until `/mcp/check` reports a real provider rejection. Re-checking an
OAuth connector with a server-held grant does not incorrectly reopen sign-in; the
key field says the credential is stored server-side and accepts a replacement. A
network/provider outage is likewise retryable and does not erase a credential; only
a definitive provider rejection marks that connector disconnected. `/mcp/check`
failures come in two kinds and the body says which: a verdict the shard reached
(`server_auth_missing`, `reauth_required`, or a 502 whose `error` is the provider
failure text such as `Could not connect MCP server "X": HTTP 503`) versus
`account_shard_unavailable` — the Worker's catch-all when its call into the
account shard itself threw (`reason: redeploy | overloaded | internal`; a Worker
deploy resets every Durable Object and aborts checks in flight). The latter says
nothing about the MCP server and is never labelled "upstream unreachable"; the
client retries a `retryable: true` 5xx once after 600 ms, then words it as
"Gera's backend was updating/busy/hit an internal error … a temporary blip", which
stays recoverable and is never an auth error. An unexpected exception inside the
shard's check returns `mcp_check_failed` + redacted `detail` instead of escaping
as a Durable Object error (`mcp-check-retry.test.ts`). Generic MCP parsing preserves text resources,
`structuredContent`, resource links and request-id matching. Legacy direct-browser
transport remains test-only for protocol parity; production calls use the Worker.
Regression coverage: `mcp-server-ownership.test.ts`, `mcp-session.test.ts`,
`mcp-oauth-refresh.test.ts`, `mcp-rotation.test.ts`, `mcp-security.test.ts`, and
`mcp-file-content.test.ts`.

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
OAuth/session/file-content suites. Full verification on 2026-09-05 (Phase 6
close, size targets met): 973 unit checks in 86 files (~4.3 s, conformance
server in-process), 45 browser checks in 8 files (~19 s), web build/deploy,
Worker deploy, `/ping` (`secretVault: enabled`), the moved relays live —
`/projects` and `/repo-previews` 401 without a session, `/repo-preview/<bad>`
404, `/pv/<x>` 404 `tracking_not_configured` through the moved
`handlePageViewIngest`, `/slack/oauth/callback` 400 HTML page — and a real
`/mcp/check` against DeepWiki through the moved handler (3 tools) passed.

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
  enabled set; search/fetch ride every message while enabled. "MCP tool
  loading" segmented control (testid `settings-mcp-loading`, options
  `mcp-loading-option-{auto|native|deferred}`; default auto, normalized in
  `history.ts`) with a hint that changes per option — see MCP › Deferred
  tools for the run-time semantics. "Confirm write tools by default"
  switch (`settings-confirm-writes`, `settings.confirmWriteTools`, default
  off, normalized in `history.ts`): write / destructive MCP tools (native
  GitHub / Slack / Intercom writes included) pause chat runs on a
  confirmation card, unattended automations decline them honestly — see
  MCP › Policy & confirmations.
  Models are NOT here — they're picked in the composer/arena.

## Admin (`/admin`)

Requires `role === "admin"` from `/access/status`; others see an honest
"not for you" state. Tabs (deep-linkable `?tab=`):

- **People** — members, roles, invites, the waitlist (approve/reject).
- **Arena** — model standings, blind duels (ArenaStudio), usage stats with
  service-call split, usage clear.
- **Diagnostics** — client/worker error journal (`/diag`), clearable. Cloud
  runs that finish as `error` (they no longer throw in the tab) still land in
  the journal, as do real MCP disconnects and failed sign-ins. Transient Gera
  relay/account blips and a missing browser grant stay silent. MCP policy
  decisions (confirmed once / always allowed / declined / timed out / blocked
  by allowlist) appear as green `mcp-policy` rows written server-side — an
  audit trail that never lights the unseen badge; declined background
  elicitations use the `mcp` scope.

## Sharing (`/s/:shareId`)

Share button → dialog creates a public read-only snapshot link (worker
`/share/create`), lists mine (`/share/mine`), revoke (`/share/revoke`).
The share page renders without an account, on purpose.

## Notifications behavior

On run finish: chime per preference (default only when tab hidden or
another thread active); desktop notification only when the tab is hidden,
click focuses the thread. Manual stops and steer-interrupts never signal.
Validated automation outcomes with `significance.notify = false` (No
material change) also suppress sound, background toast and desktop signals;
the thread entry and normal unread behavior remain as the audit trail.
All notify paths fail silent.

## Worker route map

`functions/index.ts` dispatch: `/ping` health · GET `/storage/ping` secret-free
storage probe (`{ok, bucket, apiHost, expiresAt}` 200 or `{ok:false, error}` 503
— the first thing to curl when a Repo Preview or knowledge upload reports
`storage_unavailable`) · `/access/*` gate+admin ·
`/share/*` · `/arena/*` (usage, battles, log, clear) · `/chats/sync` ·
`/runs/*` (start, stream SSE, active, steer/stop, answer — elicitation and
write-tool confirmation card replies: `accept` / `always` / `decline` /
`cancel`) · `/diag/*` ·
`/repo-previews/{inspect|install|start|status|cancel}` authenticated launch
control · `/repo-preview-hook/:id/*` GitHub Actions OIDC-authenticated workflow
callback (the runner's `PUT …/archive` tar is handled in the entrypoint:
DO `archive-claim` mints a presigned R2 PUT for a per-run staging key → the
entrypoint streams the body straight into R2 with a fixed length → DO
`archive-commit` records bytes or persists a specific storage error; the
multi-MB body never rides the DO transport). Storage credentials
(`knowledge-storage.ts`): the temp-credentials POST tries
`EXPO_PUBLIC_RORK_API_BASE_URL` → `EXPO_PUBLIC_RORK_AUTH_URL` → `RORK_AUTH_URL`
→ `https://api.rork.com` with manual redirects and an 8s cap per host; only a
valid credential or a JSON Rork error (401/403/429) is final, everything else
(404 HTML dev host, 301, 5xx, timeout) moves to the next host; the winning
host is remembered. Failures throw `storage_unavailable:<hosts + statuses>`
(never secrets) and `repoPreviewStorageUnavailableMessage` surfaces that
reason verbatim. Unit: `rork-storage.test.ts`. · `/repo-preview/:id/:access/*`
public expiring static artifact delivery ·
`/mcp/oauth-refresh` (durable rotating-token escrow) + `/mcp/oauth-rotations` ·
`/mcp/check` (uncapped handshake + prompts/resources inventory, refreshes the
account's `mcp_tool_catalog` cache) · `/mcp/inventory` · `/mcp/prompt-get` ·
`/mcp/resource-read` (composer menus; `functions/mcp-routes.ts`) · internal
`/mcp/resolve` (project shards; answers `servers`, `toolLoading`, cached
`catalog`, opaque `generations`; `bootstrap:true` is credential-stripped and refresh-free) · internal `/mcp/catalog-write` (owner catalog, never publicly relayed) · `/github-proxy` (server-owned REST, preserves step-up/temporary refusals) · `/projects/:id/agents/github-validate` (admin-only, separate project PAT validation) ·
`/automations/run-now` · `/projects` +
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

The network harness rejects any browser `/mcp-proxy`, `/mcp/resolve` or direct api.github.com fetch. Bespoke e2e checks cover real drag-and-drop and legacy-settings PAT cleanup followed by a server-owned check. `mcp-agent-editor.browser.test.tsx` opens the actual editor and verifies `12 linked`, not `N/5` (testids `project-agent-edit`, `agent-mcp-link-count`). These two e2e tests are not added to the neutral scenario count.

| Scenario | Covers |
| --- | --- |
| boot-to-launchpad | Gate bypass, launchpad, composer, sidebar render |
| starters-hide-while-typing | Starter chips fade out on typing (notSee), return on clear |
| send-chat-message | Send → user turn + streamed reply + `/c/` address |
| code-changes-preview | Repository edit event → live Changes diff → runnable sandbox Preview iframe |
| new-chat-keeps-history | New chat resets view, thread stays listed |
| github-pin-and-send | Connected GitHub → server-proxied private repo list → pin → `/runs/start` carries exact repo + connector ID, never provider credentials |
| github-launch-web-preview | Pin private repo → cloud Play → server inspection → immutable launch → live Rork iframe |
| switch-chat-model | Picker root → four main models → More → secondary selection sticks |
| switch-chat-effort | Picker root → Effort submenu → budget pins |
| switch-run-mode | Model-style mode picker engages Deep research, trigger reflects it |
| run-mode-settings-panel | Gear opens the research settings panel (depth control) |
| skills-rail-panel | Skills rail button opens the per-mode packs panel |
| projects-page-opens | Projects page renders + create action behind the gate |
| studio-pages-navigate | Tabs automations → hub → mcp → settings |
| connect-open-mcp | MCP catalog → Connect → initialize/session/tools-list → verified tool count |
| mcp-deploy-recovery | Reload saved identity/401 errors → server-owned checks (Intercom retries 503) → three verified cards, credentials preserved, no duplicate checks |
| mcp-cancel-check | Connect (held request) → disable/enable → Connect remains usable → newer verification beats old failing response |
| blender-mcp-setup | Search Blender → Set up → self-protecting bridge guide (`uv run gera-blender-bridge.py --tunnel`, 401 note, download link) → localhost rejected → Cancel → no request or phantom connector |
| blender-mcp-connect | Bearer-token bridge form → explicit stubbed `/mcp/check` (`authMode: bearer`, no headers) → Blender identity + tools → token absent from browser persistence (not a real Blender operation) |
| connect-open-mcp-deferred | Settings → Toolkit “Always deferred” → send → `/runs/start` carries `mcpToolLoading` + `contextWindow` → `mcp_search_tools` / `mcp_call_tool` rows read “MCP · deepwiki · ask_question · done” → reply |
| prompt-slash | Connected DeepWiki → type `/expl` → prompts menu → pick `explain_repo` → required-argument dialog → submit → `/mcp/prompt-get` text lands in the composer input, dialog gone |
| resource-mention | Type `@READ` → resources menu → pick the README → `/mcp/resource-read` becomes an attachment chip, `@deepwiki/wiki://…` mention stays in the input |
| elicitation-accept | Send → stream pauses with a `pause` event → card with the `region` field → fill + Accept → `/runs/answer` carries `{action:"accept", content:{region:"eu"}}` → card clears, reply streams |
| mcp-confirm-card | Settings → Toolkit “Confirm write tools by default” → send → `/runs/start` carries `confirmWriteTools: true` → stream pauses with a `confirmation` request → card names `create_issue` on Tracker with the masked (`•••`) argument preview, Always allow + Decline present → Run once → `/runs/answer` carries `{action:"accept"}` → card clears, reply streams |
| oauth-step-up | `/mcp?server=scoped` (custom OAuth server, signed in) → boot re-check's `/mcp/check` reports `stepUp` → amber hint names `things:write` + “Sign in again with wider access” → Advanced collapsed → toggle → Scopes + Metadata URL fields |
| oauth-sign-in-vault | `/mcp?server=vault-oauth` (OAuth server, idle) → Sign in → stubbed `/mcp/oauth-start` + popup stub + `/mcp/oauth-status` completed → `/mcp/check` (no credential in the body) → green card, Re-check, identity; localStorage holds no grant / client registration / browser nonce, card persists `credentialStored: true` |
| mcp-vault-migration | Legacy `gera.mcp.oauth.*` keys + a green OAuth card without vault proof → boot purges the keys → amber `mcp-resignin-notice` “sign in again”, Connect reads “Sign in” → persisted `status: error`, unknown credential presence (no delete flag), report `moved 0 / awaiting 1`, no token text anywhere in storage |
| objects-have-addresses | Deep links: /automations/new, /skills/new, /profiles/new, /hub?tab= |
| stop-run-settles-ui | Stop clears the composer when the run node lost the run (hanging stream, `not_running` stop) |

Repository-launch coverage: `repo-preview.test.ts` pins repository/ref/path
validation, framework + lockfile detection, Rork-workspace root resolution
(`rork.json` web app, ranked `web` > `functions`, workspace-shell roots,
`rootSource` normalization), manifest offset bounds, HTML asset
namespacing, SVG sandboxing + XML rejection, capability/credential redaction,
synced job normalization, dispatch-run + OIDC claim binding, and the generated
workflow's immutable/read-only/no-dispatched-secret contract. It also asserts
that repository build steps have OIDC disabled and know only a fixed base
placeholder; only trusted begin/publish jobs can mint identity, the publish job
alone receives the separate read capability, and both handoff actions are pinned.
`repo-preview.browser.test.tsx`
checks the real preview iframe + expandable bounded log, and
`github-launch-web-preview` drives the complete pin → dialog → launch → receipt
flow against network fixtures. No external repository is mutated or workflow
dispatched by CI; the setup PR + real GitHub runner callback remains an honest
manual/live integration check.

Outcome coverage: `execution-outcome.test.ts` pins strict completion,
draft-as-artifact, blocked handoff, quiet no-change, failed/mutating-check
downgrades, interruption, marker parsing, sync normalization, Slack footer,
and the real cloud-automation outcome-tool loop. Browser regression
`execution-outcome.browser.test.tsx` expands the compact receipt and checks
artifact, evidence, and next owner.

Reply-timeline coverage (2026-09-08): browser regression
`message-timeline.browser.test.tsx` renders the real `MessageList` with an
interleaved reply (prose → 8-call batch → prose → 1-call batch → prose),
checks DOM order of `message-text` / `message-tool-group`, the folded summary
(“8 tool calls”, “mcp_github_get_job_logs ×8”) expanding to nine
`message-tool-call` rows, the “now · <call>” / “1 failed” headers, no thinking
dots under a spinning batch, and the legacy rows-then-text layout for records
without offsets. The neutral scenario `connect-open-mcp-deferred` keeps
asserting the MCP meta-call rows (two calls → rows, no fold). Reports:
`web/e2e-results/tool-timeline-unit-2026-09-08.json` (96 files / 1063 tests)
and `tool-timeline-browser-2026-09-08.json` (10 files / 56 tests).

Browser-only auth coverage: `auth-resume.browser.test.ts` recreates two MCP
relay requests returning delayed 401s after a sleeping-tab token expiry and
proves both reuse one refreshed Gera generation (real localStorage + Web Lock).
It also proves a rollout-time Gera refresh failure keeps the stored identity and
that a new bundle adopts the MCP pair escrowed before the old response vanished.

Honest gaps (no click coverage yet): Skills page actions, Automations CRUD,
Admin tabs, the MCP OAuth popup itself and API-key/custom-header setup (open
connect, the step-up hint and the Advanced OAuth fields are covered; editing
Scopes / Metadata URL and the sign-out it triggers are unit-level only),
elicitation Decline/Cancel and enum/boolean fields (accept with a text field
is covered; validation is unit-tested), confirmation “Always allow” /
Decline clicks and the project-agent tool-allowlist editor (Run once is
clicked; always/decline/timeout/allowlist semantics are unit-tested against
the resolver), resource-template variable dialog
(prompt-argument dialog is covered), Share dialog, Settings toggles other
than MCP tool loading and Confirm write tools, media modes,
Julius/Deep Research runs, repository setup-PR merge + real external build
callback, dynamic SSR previews, incognito, thread menu (pin/rename/delete),
Project workspace internals (posting, threads, agent editor, members,
screens tab, screen desk / Intercom widgets) — only the list page render
is clicked; the shared outcome receipt itself has a real-browser component
regression, while channel/screen/Slack transport is contract-tested below
the UI. Screen-widget validation IS unit-tested
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
protocol and native Slack/Intercom parity), `mcp-toolset` (deferred tools:
mode decision, search ranking, search gate, lazy connect, disabled tools,
catalog cache, native soft caps with honest records), `mcp-conformance` (the
real `@modelcontextprotocol/sdk` server in-process: negotiation, headers,
pagination, prompts/resources, routes, elicitation, UI-only, list_changed),
`mcp-protocol` (transport failures, frames, annotations, templates,
elicitation validation, run pause board, composer triggers), `mcp-policy`
(risk classification incl. native tables, verdicts, masked/capped argument
previews, allowlist filtering of functions/search/calls, unattended declines
without network for MCP and GitHub routes, interactive accept/always/decline/
timeout, run-config approvals, confirmation answers on the pause board, agent
selection → policy, journal rows without argument values), `mcp-oauth-scopes`
(WWW-Authenticate parsing, scope order, pinned scopes, offline_access rule,
metadata override, step-up parking/union, blocked-run records), `auth-boundary` +
`mcp-oauth-refresh` + `mcp-session` (staggered expired-Gera 401s, provider-token
rotation rescue, deploy-response escrow/replay, transient health recovery),
`code-change-flow` (diff capture,
HTML/CSS/JS assembly, HTTPS-only deployment previews, continuation merge),
`agent-steering`, `github-native`.
Only the Durable
Object glue in `chat-store.ts` / `project-store.ts` stays untested — its
typecheck happens at the functions deploy (`runChecks functions`), not in
web tsc.
