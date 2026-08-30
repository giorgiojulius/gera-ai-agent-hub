import type { NotifySoundPref } from "@/lib/types";

/**
 * Completion signals: a soft two-note chime (Web Audio, no asset) and an
 * optional browser notification for runs that finish while the tab is hidden.
 * Everything here fails silent by design — a blocked AudioContext or a
 * platform without the Notification constructor must never break a run settle.
 */

let sharedContext: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    if (!sharedContext) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        return null;
      }
      sharedContext = new Ctor();
    }
    if (sharedContext.state === "suspended") {
      // Autoplay policy: resume works once the user has interacted with the
      // page (they typed the prompt) — otherwise this run stays silent.
      void sharedContext.resume().catch(() => undefined);
    }
    return sharedContext;
  } catch {
    return null;
  }
}

/** Decides whether the chime plays: off / only out-of-view turns / every turn. */
export function shouldPlaySound(pref: NotifySoundPref, inBackground: boolean): boolean {
  if (pref === "off") {
    return false;
  }
  if (pref === "always") {
    return true;
  }
  return inBackground;
}

/** Soft A5→E6 chime, ~0.6s. Safe to call anytime; silently no-ops when audio is unavailable. */
export function playCompletionChime(): void {
  const audio = audioContext();
  if (!audio) {
    return;
  }
  try {
    const now = audio.currentTime;
    const master = audio.createGain();
    master.gain.value = 0.12;
    master.connect(audio.destination);
    const notes: { frequency: number; at: number }[] = [
      { frequency: 880, at: 0 },
      { frequency: 1318.51, at: 0.09 },
    ];
    for (const note of notes) {
      const osc = audio.createOscillator();
      osc.type = "sine";
      osc.frequency.value = note.frequency;
      const gain = audio.createGain();
      gain.gain.setValueAtTime(0, now + note.at);
      gain.gain.linearRampToValueAtTime(1, now + note.at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, now + note.at + 0.5);
      osc.connect(gain);
      gain.connect(master);
      osc.start(now + note.at);
      osc.stop(now + note.at + 0.55);
    }
  } catch {
    // Closed context or exotic platform — the chime is a convenience, never an error.
  }
}

export type DesktopNotifyState = "granted" | "denied" | "default" | "unsupported";

export function desktopNotifyState(): DesktopNotifyState {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission;
}

/** Requests browser permission; resolves true only when notifications may actually be shown. */
export async function requestDesktopPermission(): Promise<boolean> {
  const state = desktopNotifyState();
  if (state === "granted") {
    return true;
  }
  if (state === "unsupported" || state === "denied") {
    return false;
  }
  try {
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

/**
 * Shows a desktop notification for a settled run. Per-thread tag: a newer
 * finish of the same thread replaces its previous notification instead of
 * stacking. Click focuses the tab and opens the thread.
 */
export function showRunFinishedNotification(options: {
  title: string;
  body?: string;
  tag?: string;
  onOpen?: () => void;
}): void {
  if (desktopNotifyState() !== "granted") {
    return;
  }
  try {
    const notification = new Notification(options.title, {
      body: options.body,
      icon: "/icon.png",
      tag: options.tag,
    });
    notification.onclick = () => {
      try {
        window.focus();
      } catch {
        // Some browsers refuse programmatic focus — the click still landed.
      }
      options.onOpen?.();
      notification.close();
    };
  } catch {
    // Android Chrome requires a service worker for the constructor — silent.
  }
}
