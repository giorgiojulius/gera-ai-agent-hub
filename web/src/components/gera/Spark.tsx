import { cn } from "@/lib/utils";

export function SparkMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("text-ember", className)} aria-hidden>
      <path
        fill="currentColor"
        d="M16 2.2 18.7 12.4 29.8 16 18.7 19.6 16 29.8 13.3 19.6 2.2 16 13.3 12.4Z"
      />
      <path fill="#EFD3E1" d="M16 11.2 17.1 15 21 16.1 17.1 17.2 16 21 14.9 17.2 11 16.1 14.9 15Z" />
    </svg>
  );
}
