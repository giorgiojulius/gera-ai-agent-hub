import { McpStudio } from "@/components/gera/McpStudio";
import { StudioPageHero, StudioPageShell } from "@/components/gera/StudioPageShell";

/** Full-page MCP workspace: connected servers plus the vetted catalog. */
export default function McpPage() {
  return (
    <StudioPageShell active="mcp">
      <StudioPageHero
        title="MCP servers"
        subtitle="Give Gera hands — connect Notion, GitHub, Linear and dozens more, or any custom Streamable HTTP endpoint. Scope them per profile and per automation."
      />
      <div className="mt-8 max-w-3xl">
        <McpStudio />
      </div>
    </StudioPageShell>
  );
}
