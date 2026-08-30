import { describe, expect, it } from "vitest";

import { armCloudMcp } from "../../../functions/automation-runner";
import { cloudMcpServersForAutomation } from "../../../functions/mcp-cloud";
import { githubRunRepoRefs as serverGitHubRunRepoRefs } from "../../../functions/native-github";

/** Regression coverage for the browser-token → cloud-native-tool boundary. */
describe("GitHub cloud run hand-off", () => {
  it("keeps the exact browser credential and arms server-side GitHub tools", async () => {
    const eligible = cloudMcpServersForAutomation(
      [
        {
          id: "github",
          catalogId: "github",
          name: "GitHub",
          enabled: true,
          token: "Bearer gho_browser_token",
          disabledTools: [],
        },
      ],
      null,
    );

    expect(eligible).toHaveLength(1);
    expect(eligible[0].kind).toBe("github");
    expect(eligible[0].token).toBe("Bearer gho_browser_token");

    const runtime = await armCloudMcp(eligible);
    expect(runtime.toolDefs.some((tool) => tool.function.name === "mcp_github_get_contents")).toBe(true);
    const route = runtime.routes.get("mcp_github_get_contents");
    expect(route?.type).toBe("native");
    if (route?.type === "native") {
      expect(route.kind).toBe("github");
      expect(route.auth).toBe("Bearer gho_browser_token");
    }
  });

  it("feeds a thread pin to the server research contour without changing the question", () => {
    expect(serverGitHubRunRepoRefs("why does login fail?", "acme/private-app")).toEqual([
      { owner: "acme", repo: "private-app" },
    ]);
  });

  it("keeps an explicitly named repository ahead of the pin", () => {
    expect(serverGitHubRunRepoRefs("inspect other/service", "acme/private-app")).toEqual([
      { owner: "other", repo: "service" },
    ]);
  });
});
