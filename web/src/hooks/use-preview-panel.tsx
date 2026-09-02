import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useAgent } from "@/hooks/use-agent";
import type { RepoPreviewJob } from "@/lib/types";

/** The split chat + preview layout needs a desktop viewport (Tailwind `lg`). */
const DESKTOP_QUERY = "(min-width: 1024px)";

export type PreviewPanelValue = {
  /** Repository launches recorded in the active thread, oldest first. */
  jobs: RepoPreviewJob[];
  /** The launch docked in the side panel, or null when the panel is closed. */
  openJob: RepoPreviewJob | null;
  /** True when the viewport can host the split layout; below that the thread keeps inline cards. */
  isDesktop: boolean;
  /** Docks a launch in the side panel. */
  open: (jobId: string) => void;
  /** Closes the panel for the active thread; a fresh launch reopens it. */
  close: () => void;
  /** Header toggle: hides the panel or brings back the newest launch. */
  toggle: () => void;
};

const PreviewPanelContext = createContext<PreviewPanelValue | null>(null);

function useDesktopViewport(): boolean {
  const [desktop, setDesktop] = useState<boolean>(
    () => typeof window !== "undefined" && window.matchMedia(DESKTOP_QUERY).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => setDesktop(mql.matches);
    mql.addEventListener("change", onChange);
    setDesktop(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return desktop;
}

/**
 * Per-thread choice for the side panel: `undefined` follows the newest launch,
 * `null` means the user closed it, a string pins one launch.
 */
type PanelChoice = string | null | undefined;

/**
 * Hosts the v0-style preview dock: which repository launch of the active
 * thread is shown to the right of the chat. A new launch always takes the
 * panel over; closing it is remembered per thread for the session.
 */
export function PreviewPanelProvider({ children }: { children: ReactNode }) {
  const { active } = useAgent();
  const isDesktop = useDesktopViewport();
  const activeId = active?.id ?? null;
  const messages = active?.messages;
  const jobs = useMemo<RepoPreviewJob[]>(
    () => (messages ?? []).flatMap((message) => (message.repoPreview ? [message.repoPreview] : [])),
    [messages],
  );
  const [selection, setSelection] = useState<Record<string, PanelChoice>>({});
  const knownIdsRef = useRef<Map<string, Set<string>>>(new Map());

  useEffect(() => {
    if (!activeId) {
      return;
    }
    const known = knownIdsRef.current.get(activeId);
    if (known) {
      const fresh = jobs.find((job) => !known.has(job.id));
      if (fresh) {
        setSelection((prev) => ({ ...prev, [activeId]: fresh.id }));
      }
    }
    knownIdsRef.current.set(activeId, new Set(jobs.map((job) => job.id)));
  }, [activeId, jobs]);

  const choice: PanelChoice = activeId ? selection[activeId] : null;
  const openJob = useMemo<RepoPreviewJob | null>(() => {
    if (jobs.length === 0 || choice === null) {
      return null;
    }
    const newest = jobs[jobs.length - 1] ?? null;
    if (choice === undefined) {
      return newest;
    }
    return jobs.find((job) => job.id === choice) ?? newest;
  }, [choice, jobs]);

  const open = useCallback(
    (jobId: string) => {
      if (activeId) {
        setSelection((prev) => ({ ...prev, [activeId]: jobId }));
      }
    },
    [activeId],
  );

  const close = useCallback(() => {
    if (activeId) {
      setSelection((prev) => ({ ...prev, [activeId]: null }));
    }
  }, [activeId]);

  const toggle = useCallback(() => {
    if (activeId) {
      setSelection((prev) => ({ ...prev, [activeId]: prev[activeId] === null ? undefined : null }));
    }
  }, [activeId]);

  const value = useMemo<PreviewPanelValue>(
    () => ({ jobs, openJob, isDesktop, open, close, toggle }),
    [close, isDesktop, jobs, open, openJob, toggle],
  );

  return <PreviewPanelContext.Provider value={value}>{children}</PreviewPanelContext.Provider>;
}

/** Null outside the chat workspace (shared pages, project channels) so receipts fall back to inline cards. */
export function usePreviewPanel(): PreviewPanelValue | null {
  return useContext(PreviewPanelContext);
}
