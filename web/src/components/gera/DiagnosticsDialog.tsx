import { Activity } from "lucide-react";

import { DiagnosticsJournal } from "@/components/gera/DiagnosticsJournal";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Account error journal viewer — a thin dialog around the shared journal. */
export function DiagnosticsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden rounded-3xl border-border/70 p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-border/60 px-5 pb-3.5 pt-5 text-left">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4 text-ember" />
            Diagnostics
          </DialogTitle>
          <DialogDescription className="text-xs">
            API failures, run crashes, and uncaught errors. Saved to your account journal and
            synced across your devices — visible only to you.
          </DialogDescription>
        </DialogHeader>
        <DiagnosticsJournal frame="dialog" />
      </DialogContent>
    </Dialog>
  );
}
