import { HubStudio } from "@/components/gera/HubStudio";
import { StudioPageHero, StudioPageShell } from "@/components/gera/StudioPageShell";

/** Full-page personal hub: memory, trackers, and tasks Gera keeps for you. */
export default function HubPage() {
  return (
    <StudioPageShell active="hub">
      <StudioPageHero
        title="Personal hub"
        subtitle="Gera remembers, tracks, and reminds. Say “drank 2 glasses of water” or “remind me tomorrow” in any thread — it lands here automatically."
      />
      <HubStudio />
    </StudioPageShell>
  );
}
