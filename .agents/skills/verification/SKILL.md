---
name: verification
description: Run, verify, and debug the Gera app like a user. Use after ANY code change to web/ or functions/ (unit tests → browser e2e → build → logs), when the user says "проверь", "verify", "не работает", "сломалось", when adding e2e scenarios or testids, when you need to know how a feature is reached from the user's point of view (read references/feature-map.md), and when asked to update or drift-check the feature map ("карта фич", "maintain verification").
---

# Gera Verification

Gera is an invite-only AI agent hub. Two apps:

- `web/` — Vite + React SPA. Preview: https://4dk0pad86vrg8v41n9wm2-web.rork.live
- `functions/` — Cloudflare Worker backend: https://gera-ai-agent-hub-backend.rork.app

The user-POV map of every feature (routes, click paths, testids, coverage
gaps) lives in `references/feature-map.md`. Read it before verifying a
feature manually, writing a scenario, or answering "how do users reach X".

## Verification ladder

Run from cheapest to most expensive. Never claim something is verified
without actually running the step; report failures verbatim.

1. **Unit tests** (~3s, 42 files):
   `cd web && bunx vitest run`
2. **Browser e2e** (real clicks in headless Chromium, network fully stubbed,
   zero credits spent):
   `cd web && bunx vitest run --config vitest.browser.config.ts`
3. **Build + deploy**: `runChecks({ appPath: "web" })` — tsc, eslint,
   `bun run build`, deploys the preview. Run `runChecks({ appPath: "functions" })`
   too whenever anything under `functions/` changed.
4. **Live logs** when behavior is wrong despite green tests:
   - `rork-agent logs backend --errors` — worker (runs, sync, automations)
   - `rork-agent logs runtime --errors` — browser console of the preview

A turn that changed code ends only after steps 1–3 are green.

## Sandbox repair (browser tests)

The sandbox gets recreated; Playwright then fails with "Executable doesn't
exist", "error while loading shared libraries: libnspr4.so / libnss3.so",
or a segfault. Run BOTH commands — `sudo -n` works in the sandbox. Never
substitute LD_LIBRARY_PATH / dpkg-deb hacks: they don't survive the next
run. Re-run the suite cleanly (no env vars) to confirm the repair:

```bash
cd web && bunx playwright install chromium-headless-shell
sudo -n apt-get install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libasound2
```

## E2E architecture

- `web/src/lib/testids.ts` — the ONLY selector registry (`TID`,
  `modelOptionTid`, `effortOptionTid`, `studioPageTid`, `studioTabTid`).
  Components attach them as `data-testid`. Never query by text/CSS in
  scenarios; a future mobile app reuses the same constants as `testID`.
- `web/e2e/scenarios.ts` — platform-neutral scenario catalog. Verbs:
  `goto`, `tap`, `fill`, `see`, `notSee` (unmounted or visually hidden —
  aria-hidden fade-outs count), `seeText`, `urlContains`.
- `web/src/test/e2e.browser.test.tsx` — the web driver. Boots the real
  `<App />`, bypasses the invite gate with a fake JWT in localStorage plus a
  stubbed `/access/status` → `invited`, stubs the whole network (gateway
  models, completions, `/runs/start` + SSE stream, sync). Deterministic and
  hermetic.
- Reports persist to `web/e2e-results/` (`web.latest.json` +
  `history.jsonl`); `cd web && bun run e2e:stats` prints the merged table.
- `web/src/test/calendar.browser.test.tsx` — screenshot regression test.
- `web/src/test/autogrow.browser.test.tsx` — composer auto-grow regression
  (grows per line, clamps at the cap, shrinks back).

### Adding a scenario for a new feature

1. Add the id to `web/src/lib/testids.ts` (or a `*Tid` factory).
2. Attach `data-testid` in the component.
3. Append a scenario to `E2E_SCENARIOS` in `web/e2e/scenarios.ts`.
4. If the flow hits a new backend route, stub it in `handleStubbed`
   (e2e.browser.test.tsx) — fail-soft JSON, same shape as the worker.
5. Run the browser suite. Update the coverage table in the feature map.

## Maintaining the feature map

The map goes stale fast — treat it as part of the definition of done:

- **Shipping a user-facing change** (route, page, button, flow, testid,
  scenario, worker route): update `references/feature-map.md` in the SAME
  turn, including its "Last synced" stamp (date + `git log -1 --format=%h`).
- **Drift check** (when asked, or when the map's commit looks old):
  1. `git log --oneline <stamped-commit>..HEAD` — anything user-facing?
  2. Diff reality against the map: routes in `web/src/App.tsx`, studio tabs
     in `StudioPageShell.tsx`, ids in `testids.ts`, scenarios in
     `e2e/scenarios.ts`, worker routes in `functions/index.ts`.
  3. Fix discrepancies in the map, refresh the stamp, report what drifted.

Keep the map honest: coverage gaps are listed as gaps, never papered over.

**Dogfood option**: Gera itself can run the audit. The in-app Skills
catalog ships a "Maintain the feature map" playbook (Playbooks group) and
the Automations page a "Feature map drift-check" daily template — with the
GitHub connector armed, a scheduled run fetches this map from the repo,
drift-checks it against the ground-truth files, and opens a correcting PR
(merging stays with the human).
