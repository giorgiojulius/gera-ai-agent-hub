import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { useAgent } from "@/hooks/use-agent";
import { errorFromUnknown } from "@/lib/errors";
import { resolveGitHubAuth } from "@/lib/github-native";
import { cancelRepoPreview, getRepoPreview, startRepoPreview } from "@/lib/repo-preview";
import type { RepoPreviewJob, RepoPreviewPhase } from "@/lib/types";

/** Phases that still poll the backend; everything else is a durable terminal state. */
export const REPO_PREVIEW_ACTIVE_PHASES = new Set<RepoPreviewPhase>([
  "queued",
  "installing",
  "building",
  "packaging",
  "uploading",
]);

export type LiveRepoPreview = {
  /** Freshest job: live status when available, else the durable receipt. */
  job: RepoPreviewJob;
  isRefreshing: boolean;
  /** The status endpoint failed; the last durable state is shown. */
  statusUnavailable: boolean;
  actionBusy: boolean;
  refresh: () => void;
  cancel: () => void;
  rebuild: () => void;
};

/**
 * Shares one polling query per launch between the thread receipt and the
 * docked panel, and mirrors phase changes back into the durable message
 * without ever persisting private preview URLs or build logs.
 */
export function useRepoPreviewJob(initialJob: RepoPreviewJob, options: { readOnly?: boolean } = {}): LiveRepoPreview {
  const readOnly = options.readOnly ?? false;
  const { state, recordRepoPreview, updateRepoPreview } = useAgent();
  const queryClient = useQueryClient();
  const [actionBusy, setActionBusy] = useState<boolean>(false);
  const query = useQuery({
    queryKey: ["repo-preview", initialJob.id],
    queryFn: () => getRepoPreview(initialJob.id),
    initialData: initialJob,
    enabled: !readOnly,
    staleTime: 1_000,
    refetchInterval: (current) => {
      const job = current.state.data;
      return job && REPO_PREVIEW_ACTIVE_PHASES.has(job.phase) ? 2_500 : false;
    },
    retry: 2,
  });
  const job = query.data ?? initialJob;
  const server = state.settings.mcpServers.find(
    (item) => item.enabled && (item.catalogId ?? item.id) === "github",
  );
  const conversationId = state.conversations.find((conversation) =>
    conversation.messages.some((message) => message.repoPreview?.id === initialJob.id),
  )?.id;

  useEffect(() => {
    if (job.phase !== initialJob.phase || job.expiresAt !== initialJob.expiresAt) {
      updateRepoPreview(job);
    }
  }, [initialJob.expiresAt, initialJob.phase, job, updateRepoPreview]);

  const resolveAuth = async (): Promise<string | undefined> => {
    if (!server) return undefined;
    try {
      return await resolveGitHubAuth(server);
    } catch {
      return undefined;
    }
  };

  const cancel = async (): Promise<void> => {
    setActionBusy(true);
    try {
      const next = await cancelRepoPreview(job.id, await resolveAuth());
      queryClient.setQueryData(["repo-preview", job.id], next);
      toast.success("Preview stopped");
    } catch (error) {
      toast.error("Could not stop the preview", { description: errorFromUnknown(error) });
    } finally {
      setActionBusy(false);
    }
  };

  const rebuild = async (): Promise<void> => {
    setActionBusy(true);
    try {
      const auth = await resolveAuth();
      if (!auth) throw new Error("Reconnect GitHub before rebuilding this repository.");
      const next = await startRepoPreview(
        {
          repository: job.repository,
          ref: job.ref,
          rootDirectory: job.rootDirectory,
          outputDirectory: job.outputDirectory,
        },
        auth,
      );
      recordRepoPreview(next, conversationId);
      toast.success("Fresh repository preview started", { description: `${job.repository}@${job.commitSha.slice(0, 7)}` });
    } catch (error) {
      toast.error("Could not rebuild the preview", { description: errorFromUnknown(error) });
    } finally {
      setActionBusy(false);
    }
  };

  return {
    job,
    isRefreshing: query.isFetching,
    statusUnavailable: query.isError,
    actionBusy,
    refresh: () => void query.refetch(),
    cancel: () => void cancel(),
    rebuild: () => void rebuild(),
  };
}
