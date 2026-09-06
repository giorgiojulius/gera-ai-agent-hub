import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { AgentsPanel } from "@/components/gera/projects/AgentsPanel";
import { TID } from "@/lib/testids";
import type { ProjectAgent } from "@/lib/projects";

vi.mock("@/hooks/use-agent", () => ({ useAgent: () => ({ state: { settings: { mcpServers: [], profiles: [], modelId: "xai/grok-4.20" } } }) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { email: "owner@example.com" } }) }));
afterEach(() => vi.unstubAllGlobals());

test("project agent editor displays all 12 persisted MCP links without a five-link cap", async () => {
  const refs = Array.from({ length: 12 }, (_, index) => ({ id: `srv${index}`, name: `Server ${index}` }));
  const agent: ProjectAgent = { id: "reader", name: "Reader", handle: "reader", emoji: "", model: "", instructions: "Read",
    access: { github: "off", web: false, intercom: false, slack: false, mcp: true },
    secretsSet: { github: false, intercom: false, slack: false, slackSigning: false }, mcpServers: refs, mcpWrites: "ask", mcpOwner: "owner@example.com", createdAt: 1, updatedAt: 1,
  };
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ agents: [agent], channels: [] })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(<QueryClientProvider client={client}><MemoryRouter><AgentsPanel projectId="project" agents={[agent]} canManage slackConfig={null} /></MemoryRouter></QueryClientProvider>);
  await page.getByTestId(TID.projectAgentEdit).click();
  await expect.element(page.getByTestId(TID.agentMcpLinkCount)).toHaveTextContent("12 linked.");
  await expect.element(page.getByTestId(TID.agentMcpLinkCount)).not.toHaveTextContent("/5");
  await view.unmount(); client.clear();
});
