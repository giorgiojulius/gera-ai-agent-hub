import { Bell, Compass, SlidersHorizontal, Volume2, Wrench } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { StudioPageHero, StudioPageShell } from "@/components/gera/StudioPageShell";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useAgent } from "@/hooks/use-agent";
import {
  desktopNotifyState,
  playCompletionChime,
  requestDesktopPermission,
  type DesktopNotifyState,
} from "@/lib/notify";
import type { BuiltinToolId, NotifySoundPref } from "@/lib/types";
import { cn } from "@/lib/utils";

const TOOLKIT_ITEMS: { id: BuiltinToolId; label: string; hint: string }[] = [
  { id: "web_search", label: "Web search", hint: "Exa live search with citations — rides every message while enabled" },
  { id: "fetch_url", label: "Fetch URL", hint: "Pull page text for the agent — rides every message while enabled" },
  {
    id: "selfsurf",
    label: "SelfSurf browser",
    hint: "Autonomous browsing: follows links, submits forms, keeps cookies — no JS, no CAPTCHAs",
  },
  { id: "generate_image", label: "Image generation", hint: "GPT Image via toolkit" },
  { id: "generate_video", label: "Video generation", hint: "Seedance / Wan / Grok video" },
  { id: "generate_audio", label: "Audio generation", hint: "Grok / OpenAI text-to-speech" },
];

const SOUND_OPTIONS: { value: NotifySoundPref; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "background", label: "In background" },
  { value: "always", label: "Always" },
];

const SECTIONS = [
  { id: "general", label: "General", icon: SlidersHorizontal, blurb: "Behavior applied to every thread." },
  {
    id: "shortcuts",
    label: "Shortcuts",
    icon: Compass,
    blurb: "One-tap jumps: projects and screen desks on the home screen, saved profiles at the composer.",
  },
  { id: "notifications", label: "Notifications", icon: Bell, blurb: "How Gera signals a finished run." },
  {
    id: "toolkit",
    label: "Toolkit",
    icon: Wrench,
    blurb:
      "Master switches — off here means the agent never sees the tool. Auto routing picks media tools per prompt from this set; search, fetch, and browsing ride every message while on.",
  },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

/**
 * Full-page settings, sectioned: an anchor rail on the left (chips on
 * phones) tracks the section in view; each card carries an icon tile.
 * Sections: General, Shortcuts, Notifications, Toolkit.
 */
export default function SettingsPage() {
  const { state, setAutoTools, setSystemPrompt, toggleBuiltin, patchSettings } = useAgent();
  const settings = state.settings;
  const [permission, setPermission] = useState<DesktopNotifyState>(() => desktopNotifyState());
  const [activeSection, setActiveSection] = useState<SectionId>("general");
  const visibleRef = useRef<Set<string>>(new Set());

  // Scrollspy: the rail highlights the topmost section currently in view.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            visibleRef.current.add(entry.target.id);
          } else {
            visibleRef.current.delete(entry.target.id);
          }
        }
        const first = SECTIONS.find((section) => visibleRef.current.has(section.id));
        if (first) {
          setActiveSection(first.id);
        }
      },
      { rootMargin: "-96px 0px -45% 0px", threshold: 0 },
    );
    for (const section of SECTIONS) {
      const el = document.getElementById(section.id);
      if (el) {
        observer.observe(el);
      }
    }
    return () => observer.disconnect();
  }, []);

  const jumpTo = (id: SectionId) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const onToggleDesktop = async (checked: boolean) => {
    if (!checked) {
      patchSettings({ notifyDesktop: false });
      return;
    }
    const granted = await requestDesktopPermission();
    const stateNow = desktopNotifyState();
    setPermission(stateNow);
    if (!granted) {
      toast.error(
        stateNow === "unsupported"
          ? "This browser does not support notifications"
          : "Notifications are blocked by the browser",
        { description: "Allow notifications for this site in the browser settings, then try again." },
      );
      return;
    }
    patchSettings({ notifyDesktop: true });
  };

  return (
    <StudioPageShell active="settings">
      <StudioPageHero
        title="Settings"
        subtitle="Global behavior, home and composer shortcuts, completion notifications, and the built-in toolkit. Models are picked next to the composer; per-profile overrides live on the Profiles page."
      />
      <div className="mt-8 lg:grid lg:grid-cols-[190px_minmax(0,1fr)] lg:gap-10">
        {/* Phone: anchor chips in a scrollable row. */}
        <div className="mb-5 flex gap-1.5 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:hidden">
          {SECTIONS.map((section) => {
            const Icon = section.icon;
            const current = activeSection === section.id;
            return (
              <button
                key={section.id}
                type="button"
                onClick={() => jumpTo(section.id)}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                  current
                    ? "border-transparent bg-white text-foreground shadow-sm"
                    : "border-border/70 text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className={cn("h-3.5 w-3.5", current && "text-ember")} />
                {section.label}
              </button>
            );
          })}
        </div>

        {/* Desktop: sticky rail highlighting the section in view. */}
        <nav aria-label="Settings sections" className="hidden lg:block">
          <ul className="sticky top-24 space-y-1">
            {SECTIONS.map((section) => {
              const Icon = section.icon;
              const current = activeSection === section.id;
              return (
                <li key={section.id}>
                  <button
                    type="button"
                    onClick={() => jumpTo(section.id)}
                    aria-current={current ? "true" : undefined}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] font-medium transition-colors",
                      current
                        ? "bg-white text-foreground shadow-sm"
                        : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                    )}
                  >
                    <Icon className={cn("h-4 w-4", current ? "text-ember" : "text-muted-foreground/70")} />
                    {section.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="min-w-0 max-w-3xl space-y-5">
          <SettingsCard section={SECTIONS[0]}>
            <div className="divide-y divide-border/60">
              <SettingRow
                title="Auto tool routing"
                hint="Gera picks media tools and MCP servers per prompt — only from what’s enabled in Toolkit"
                control={<Switch checked={settings.autoTools} onCheckedChange={setAutoTools} />}
              />
              <SettingRow
                title="Enter sends the message"
                hint="Off: Enter makes a new line and Ctrl/⌘+Enter sends. Touch keyboards always use the send button."
                control={
                  <Switch
                    checked={settings.enterSends}
                    onCheckedChange={(checked) => patchSettings({ enterSends: checked })}
                  />
                }
              />
              <div className="pt-4">
                <p className="text-sm">System prompt</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Applied to every thread, on top of tool instructions
                </p>
                <Textarea
                  value={settings.systemPrompt}
                  onChange={(event) => setSystemPrompt(event.target.value)}
                  placeholder={'e.g. "Always answer in Russian. You are the marketing copilot for my startup."'}
                  className="mt-3 min-h-[140px] rounded-xl border-border bg-white text-sm"
                />
              </div>
            </div>
          </SettingsCard>

          <SettingsCard section={SECTIONS[1]}>
            <div className="divide-y divide-border/60">
              <SettingRow
                title="Home shortcuts"
                hint="Project and screen chips above the home greeting — one tap into a workspace or a support desk. Hidden until you have a project."
                control={
                  <Switch
                    checked={settings.homeShortcuts}
                    onCheckedChange={(checked) => patchSettings({ homeShortcuts: checked })}
                  />
                }
              />
              <SettingRow
                title="Profiles at the composer"
                hint="Monogram row at the top right of the new-thread composer — start a thread with a saved profile in one tap. Hidden while no profiles exist."
                control={
                  <Switch
                    checked={settings.composerProfiles}
                    onCheckedChange={(checked) => patchSettings({ composerProfiles: checked })}
                  />
                }
              />
            </div>
          </SettingsCard>

          <SettingsCard section={SECTIONS[2]}>
            <div className="divide-y divide-border/60">
              <div className="flex flex-wrap items-center justify-between gap-3 pb-4 pt-1">
                <div className="min-w-0">
                  <p className="text-sm">Completion sound</p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                    Soft chime when a reply finishes. In background — a hidden tab or another thread.
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <div className="inline-flex rounded-full border border-border bg-background p-0.5">
                    {SOUND_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => patchSettings({ notifySound: option.value })}
                        className={cn(
                          "rounded-full px-2.5 py-1 text-[11px] transition-colors",
                          settings.notifySound === option.value
                            ? "bg-foreground text-background"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => playCompletionChime()}
                    title="Preview the chime"
                    aria-label="Preview the chime"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <Volume2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <SettingRow
                title="Desktop notifications"
                hint="Browser notification when a run finishes while the tab is hidden — clicking it opens the thread"
                note={
                  permission === "denied" ? (
                    <p className="mt-1 text-[11px] text-ember">
                      Blocked by the browser — allow notifications for this site, then flip the switch again.
                    </p>
                  ) : null
                }
                control={
                  <Switch
                    checked={settings.notifyDesktop}
                    onCheckedChange={(checked) => void onToggleDesktop(checked)}
                  />
                }
              />
            </div>
          </SettingsCard>

          <SettingsCard section={SECTIONS[3]}>
            <div className="divide-y divide-border/60">
              {TOOLKIT_ITEMS.map((item) => (
                <label
                  key={item.id}
                  className="flex cursor-pointer items-center justify-between gap-4 py-4 first:pt-1 last:pb-1"
                >
                  <span className="min-w-0">
                    <span className="block text-sm">{item.label}</span>
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">{item.hint}</span>
                  </span>
                  <Switch
                    checked={settings.builtinTools[item.id]}
                    onCheckedChange={() => toggleBuiltin(item.id)}
                  />
                </label>
              ))}
            </div>
          </SettingsCard>
        </div>
      </div>
    </StudioPageShell>
  );
}

/** Anchor-addressable settings card: ember icon tile, display title, blurb. */
function SettingsCard({
  section,
  children,
}: {
  section: (typeof SECTIONS)[number];
  children: ReactNode;
}) {
  const Icon = section.icon;
  return (
    <section id={section.id} aria-labelledby={`${section.id}-title`} className="gera-card scroll-mt-24 rounded-3xl p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-ember/15 text-ember">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h2 id={`${section.id}-title`} className="font-display text-lg leading-tight">
            {section.label}
          </h2>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{section.blurb}</p>
        </div>
      </div>
      <div className="mt-4 border-t border-border/60 pt-1">{children}</div>
    </section>
  );
}

/** One switch row: title + hint on the left, the control pinned right. */
function SettingRow({
  title,
  hint,
  note,
  control,
}: {
  title: string;
  hint: string;
  note?: ReactNode;
  control: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 py-4 first:pt-1 last:pb-1">
      <div className="min-w-0 flex-1 basis-56">
        <p className="text-sm">{title}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{hint}</p>
        {note}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}
