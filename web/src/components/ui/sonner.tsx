import type { ComponentProps } from "react";
import { useSyncExternalStore } from "react";
import { Toaster as Sonner, toast } from "sonner";

type ToasterProps = ComponentProps<typeof Sonner>;

const MOBILE_QUERY = "(max-width: 639px)";

function subscribeViewport(onChange: () => void): () => void {
  const mql = window.matchMedia(MOBILE_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function isMobileViewport(): boolean {
  return window.matchMedia(MOBILE_QUERY).matches;
}

const Toaster = ({ ...props }: ToasterProps) => {
  // Phones: toasts drop from the top so they never cover the composer / send
  // button pinned to the bottom. Desktop keeps the default bottom-right spot.
  const mobile = useSyncExternalStore(subscribeViewport, isMobileViewport, () => false);
  return (
    <Sonner
      theme="light"
      position={mobile ? "top-center" : "bottom-right"}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster, toast };
