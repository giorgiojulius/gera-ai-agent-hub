import type { McpServerConfig } from "@/lib/types";

export type McpAuthKind = "none" | "token" | "oauth";

export type McpCategory =
  | "comms"
  | "docs"
  | "search"
  | "code"
  | "cloud"
  | "data"
  | "work"
  | "design"
  | "commerce"
  | "observability";

export type McpCatalogEntry = {
  id: string;
  name: string;
  url: string;
  category: McpCategory;
  auth: McpAuthKind;
  hint: string;
  tokenPlaceholder?: string;
  /** Server works without a key; adding one unlocks more tools/quota. */
  tokenOptional?: boolean;
  /** Send the API key as this query parameter instead of an Authorization header. */
  tokenQueryParam?: string;
  /** Replace the whole URL with this template ({token} placeholder) when a key is set. */
  tokenUrlTemplate?: string;
  /** Link to the provider's setup / how-to-get-a-token docs. */
  docsUrl?: string;
  /**
   * Present when the server exists but rejects pure-browser clients
   * (no CORS and/or confidential-only OAuth). Value is the honest reason
   * shown in the catalog; the Connect button is hidden.
   */
  blocked?: string;
  /**
   * Skip the MCP-Protocol-Version / Mcp-Session-Id request headers: some
   * hosts (Google) reject any CORS preflight that asks for custom headers.
   */
  omitMcpHeaders?: boolean;
  /**
   * Sign-in works via the OAuth device flow with a workspace-registered
   * client ID (the provider refuses dynamic registration, so the popup flow
   * can't work). The UI offers "Sign in" when the client ID is configured.
   */
  deviceFlow?: boolean;
  /**
   * Built-in browser connector that speaks the provider's public REST API
   * instead of MCP — used when the provider's MCP endpoint rejects browsers
   * but its plain API is CORS-open (probed live).
   */
  native?: "slack" | "intercom" | "github";
  /** Brand domain whose favicon is shown in the catalog (defaults to the MCP URL's host). */
  icon?: string;
};

/** Favicon proxy for brand icons; the UI falls back to initials if the image fails. */
export function mcpIconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(domain)}`;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function catalogIconUrl(entry: McpCatalogEntry): string | null {
  const domain = entry.icon ?? hostOf(entry.url);
  return domain ? mcpIconUrl(domain) : null;
}

/** Icon for an added server: catalog brand if known, else the custom URL's host favicon. */
export function serverIconUrl(server: McpServerConfig): string | null {
  const entry = findCatalogEntry(server.catalogId ?? server.id);
  if (entry) {
    return catalogIconUrl(entry);
  }
  const domain = hostOf(server.url);
  return domain ? mcpIconUrl(domain) : null;
}

export const MCP_CATEGORY_LABEL: Record<McpCategory, string> = {
  comms: "Mail & Chat",
  docs: "Docs",
  search: "Search",
  code: "Code",
  cloud: "Cloud",
  data: "Data",
  work: "Work",
  design: "Design",
  commerce: "Commerce",
  observability: "Observe",
};

export const MCP_AUTH_LABEL: Record<McpAuthKind, string> = {
  none: "Open",
  token: "API key",
  oauth: "Sign in",
};

/** Popular servers shown first. */
export const FEATURED_MCP_IDS: string[] = [
  "github",
  "stripe",
  "supabase",
  "vercel",
  "linear",
  "notion",
  "gmail",
  "slack",
  "intercom",
  "intercom-mcp",
  "klaviyo",
  "figma",
  "higgsfield",
  "mobbin",
  "clickup",
  "todoist",
  "monday",
  "composio",
  "zapier",
  "deepwiki",
  "context7",
  "huggingface",
  "exa",
  "firecrawl",
  "apify",
  "postman",
  "ms-learn",
  "cloudflare-docs",
  "atlassian",
  "asana",
  "canva",
  "square",
  "paypal",
  "globalping",
  "wolfram",
  "gitmcp",
  "stackoverflow",
  "datadog",
  "buildkite",
  "testerarmy",
];

/**
 * Every connectable entry below passed a live probe from this project: the
 * endpoint answers MCP initialize over Streamable HTTP. All MCP traffic
 * flows through the Gera backend relay, so browser CORS restrictions never
 * apply — any spec-compliant server works. Open servers connect
 * instantly (handshake + tools/list verified without credentials); "Sign
 * in" servers use OAuth (popup, PKCE + dynamic client registration — the
 * registration endpoint was confirmed live for each); "API key" servers
 * take a pasted token. Entries with `blocked` exist but reject outside
 * clients for policy reasons — listed for transparency with the probed
 * reason. A large batch below was imported from the GitHub MCP Registry
 * (github.com/mcp) and re-probed individually.
 */
export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: "gmail",
    name: "Gmail",
    url: "https://gmailmcp.googleapis.com/mcp/v1",
    category: "comms",
    auth: "token",
    omitMcpHeaders: true,
    hint: "Official Gmail MCP: search threads, read mail, draft, label",
    icon: "gmail.com",
    tokenPlaceholder: "Google OAuth access token (ya29.…)",
    docsUrl: "https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server",
  },
  {
    id: "slack",
    name: "Slack",
    url: "https://slack.com/api",
    category: "comms",
    auth: "token",
    native: "slack",
    hint: "Send, read, and search messages via the Slack Web API — paste a bot token",
    icon: "slack.com",
    tokenPlaceholder: "xoxb-… bot token (or xoxp-… user token)",
    docsUrl: "https://api.slack.com/quickstart",
  },
  {
    id: "intercom",
    name: "Intercom",
    url: "https://api.intercom.io",
    category: "comms",
    auth: "token",
    native: "intercom",
    hint: "Read, reply, and start Intercom chats — paste an Access Token",
    icon: "intercom.com",
    tokenPlaceholder: "dG9rOi… Access Token (Developer Hub)",
    docsUrl: "https://developers.intercom.com/docs/build-an-integration/getting-started",
  },
  {
    id: "intercom-mcp",
    name: "Intercom MCP",
    url: "https://mcp.intercom.com/mcp",
    category: "comms",
    auth: "oauth",
    hint: "Official Intercom MCP: search chats, contacts, companies, edit articles",
    icon: "intercom.com",
    blocked:
      "Intercom's OAuth only accepts apps on its redirect allowlist (Claude, Cursor…) and rejected this app's domain at registration (invalid_redirect_uri, probed live). Use the Intercom connector with an Access Token instead.",
    docsUrl: "https://developers.intercom.com/docs/guides/mcp",
  },
  { id: "klaviyo", name: "Klaviyo", url: "https://mcp.klaviyo.com/mcp", category: "comms", auth: "oauth", icon: "klaviyo.com", hint: "Email marketing: campaigns, flows, subscribers" },
  { id: "publora", name: "Publora", url: "https://mcp.publora.com/mcp", category: "comms", auth: "token", icon: "publora.com", hint: "Schedule posts to X, LinkedIn, Instagram, TikTok", tokenPlaceholder: "sk_… Publora API key", docsUrl: "https://docs.publora.com" },

  { id: "deepwiki", name: "DeepWiki", url: "https://mcp.deepwiki.com/mcp", category: "docs", auth: "none", icon: "deepwiki.com", hint: "Ask questions about any public GitHub repo" },
  { id: "ms-learn", name: "Microsoft Learn", url: "https://learn.microsoft.com/api/mcp", category: "docs", auth: "none", icon: "learn.microsoft.com", hint: "Official Microsoft, Azure, and .NET docs" },
  { id: "context7", name: "Context7", url: "https://mcp.context7.com/mcp", category: "docs", auth: "token", tokenOptional: true, icon: "context7.com", hint: "Up-to-date library docs and examples", tokenPlaceholder: "ctx7sk-… (optional)" },
  { id: "huggingface", name: "Hugging Face", url: "https://huggingface.co/mcp", category: "docs", auth: "token", tokenOptional: true, icon: "huggingface.co", hint: "Models, datasets, Spaces, papers", tokenPlaceholder: "hf_… token (optional)" },
  { id: "gitmcp", name: "GitMCP", url: "https://gitmcp.io/docs", category: "docs", auth: "none", icon: "gitmcp.io", hint: "Docs and code search for any GitHub repo" },
  { id: "wolfram", name: "Wolfram", url: "https://agenttools.wolfram.com/mcp", category: "docs", auth: "none", icon: "wolfram.com", hint: "Computation, math, and curated knowledge" },
  { id: "cloudflare-docs", name: "Cloudflare Docs", url: "https://docs.mcp.cloudflare.com/mcp", category: "docs", auth: "none", icon: "cloudflare.com", hint: "Search Cloudflare product docs" },
  { id: "cf-agents", name: "Agents SDK Docs", url: "https://agents.cloudflare.com/mcp", category: "docs", auth: "none", icon: "cloudflare.com", hint: "Cloudflare Agents SDK docs" },
  { id: "context-awesome", name: "Context Awesome", url: "https://www.context-awesome.com/api/mcp", category: "docs", auth: "none", icon: "context-awesome.com", hint: "Search curated awesome-lists" },
  { id: "remote-mcp", name: "Remote MCP", url: "https://mcp.remote-mcp.com", category: "docs", auth: "none", icon: "remote-mcp.com", hint: "Directory of remote MCP servers" },
  { id: "stackoverflow", name: "Stack Overflow", url: "https://mcp.stackoverflow.com", category: "docs", auth: "token", icon: "stackoverflow.com", hint: "Q&A search", tokenPlaceholder: "Access token" },
  { id: "zine", name: "Zine", url: "https://www.zine.ai/mcp", category: "docs", auth: "oauth", icon: "zine.ai", hint: "Reading and research memory" },
  { id: "svelte-docs", name: "Svelte", url: "https://mcp.svelte.dev/mcp", category: "docs", auth: "none", icon: "svelte.dev", hint: "Official Svelte & SvelteKit docs, playground, autofixer" },
  { id: "cometchat-docs", name: "CometChat Docs", url: "https://mcp.cometchat.com/mcp", category: "docs", auth: "none", icon: "cometchat.com", hint: "CometChat docs and implementation bundles" },
  { id: "soracom-docs", name: "Soracom Docs", url: "https://knowledge-mcp.soracom.com", category: "docs", auth: "none", icon: "soracom.io", hint: "SORACOM IoT platform docs and API reference" },

  { id: "exa", name: "Exa", url: "https://mcp.exa.ai/mcp", category: "search", auth: "token", tokenOptional: true, tokenQueryParam: "exaApiKey", icon: "exa.ai", hint: "Neural web search and crawling", tokenPlaceholder: "Exa API key (optional)" },
  { id: "firecrawl", name: "Firecrawl", url: "https://mcp.firecrawl.dev/mcp", category: "search", auth: "token", tokenOptional: true, tokenUrlTemplate: "https://mcp.firecrawl.dev/{token}/v2/mcp", icon: "firecrawl.dev", hint: "Scrape and crawl any website", tokenPlaceholder: "fc-… key (optional)" },
  { id: "parallel-task", name: "Parallel Task", url: "https://task-mcp.parallel.ai/mcp", category: "search", auth: "token", icon: "parallel.ai", hint: "Long-running research tasks", tokenPlaceholder: "Parallel API key" },
  { id: "searchapi", name: "SearchAPI", url: "https://www.searchapi.io/mcp", category: "search", auth: "token", icon: "searchapi.io", hint: "Google SERP and web results", tokenPlaceholder: "SearchAPI key" },
  { id: "simplescraper", name: "SimpleScraper", url: "https://mcp.simplescraper.io/mcp", category: "search", auth: "token", icon: "simplescraper.io", hint: "Structured web scraping", tokenPlaceholder: "Bearer token" },
  { id: "ean-search", name: "EAN-Search", url: "https://www.ean-search.org/mcp", category: "search", auth: "token", icon: "ean-search.org", hint: "Product barcode lookups", tokenPlaceholder: "API token" },
  { id: "nyc-subway", name: "NYC Subway", url: "https://subwayinfo.nyc/mcp", category: "search", auth: "none", icon: "subwayinfo.nyc", hint: "Live NYC subway status" },
  { id: "apify", name: "Apify", url: "https://mcp.apify.com/", category: "search", auth: "token", icon: "apify.com", hint: "Run 6,000+ ready-made scrapers (Actors)", tokenPlaceholder: "apify_api_… token", docsUrl: "https://docs.apify.com/platform/integrations/mcp" },
  { id: "serpapi", name: "SerpAPI", url: "https://mcp.serpapi.com/mcp", category: "search", auth: "token", icon: "serpapi.com", hint: "Google, Bing, Maps and more SERP data", tokenPlaceholder: "SerpAPI key", docsUrl: "https://serpapi.com/manage-api-key" },
  { id: "mapbox", name: "Mapbox", url: "https://mcp.mapbox.com/mcp", category: "search", auth: "oauth", icon: "mapbox.com", hint: "Geocoding, directions, isochrones, POI search" },

  { id: "github", name: "GitHub", url: "https://api.github.com", native: "github", category: "code", auth: "token", tokenOptional: true, deviceFlow: true, icon: "github.com", hint: "Native GitHub connector: your repos (incl. private), files, issues, PRs, code search — sign in with GitHub or paste a PAT", tokenPlaceholder: "ghp_… or github_pat_… (optional after sign-in)", docsUrl: "https://docs.github.com/rest" },
  { id: "postman", name: "Postman", url: "https://mcp.postman.com/mcp", category: "code", auth: "token", icon: "postman.com", hint: "Collections, environments, and your API workspace", tokenPlaceholder: "PMAK-… Postman API key" },
  { id: "lovable", name: "Lovable", url: "https://mcp.lovable.dev", category: "code", auth: "oauth", icon: "lovable.dev", hint: "Your Lovable apps and projects" },
  { id: "sonatype", name: "Sonatype", url: "https://mcp.guide.sonatype.com/mcp", category: "code", auth: "none", icon: "sonatype.com", hint: "Maven Central versions and upgrade recommendations" },
  { id: "nslookup", name: "NsLookup", url: "https://mcp.nslookup.io/mcp", category: "code", auth: "none", icon: "nslookup.io", hint: "DNS records, SSL certs, email-auth checks" },
  { id: "mabl", name: "mabl", url: "https://mcp.mabl.com/mcp", category: "code", auth: "oauth", icon: "mabl.com", hint: "AI test automation: runs and results" },
  { id: "opslevel", name: "OpsLevel", url: "https://app.opslevel.com/mcp", category: "code", auth: "oauth", icon: "opslevel.com", hint: "Service catalog, standards, and checks" },
  { id: "octoperf", name: "OctoPerf", url: "https://api.octoperf.com/mcp", category: "code", auth: "oauth", icon: "octoperf.com", hint: "Load tests and performance reports" },
  { id: "testerarmy", name: "TesterArmy", url: "https://tester.army/mcp", category: "code", auth: "oauth", icon: "tester.army", hint: "AI QA agents that click through and test your app — your account's runs and reports", docsUrl: "https://docs.tester.army/get-started" },
  { id: "testerarmy-docs", name: "TesterArmy Docs", url: "https://docs.tester.army/_mcp/server", category: "docs", auth: "none", icon: "tester.army", hint: "Search TesterArmy's documentation — no key needed", docsUrl: "https://docs.tester.army/get-started" },
  { id: "buildkite", name: "Buildkite", url: "https://mcp.buildkite.com/mcp", category: "code", auth: "oauth", icon: "buildkite.com", hint: "CI pipelines and builds" },
  { id: "globalping", name: "Globalping", url: "https://mcp.globalping.dev/mcp", category: "code", auth: "oauth", icon: "globalping.io", hint: "Ping, traceroute, DNS from anywhere" },
  { id: "port", name: "Port", url: "https://mcp.port.io/v1", category: "code", auth: "token", icon: "getport.io", hint: "Internal developer portal", tokenPlaceholder: "Port API token" },

  { id: "netlify", name: "Netlify", url: "https://netlify-mcp.netlify.app/mcp", category: "cloud", auth: "oauth", icon: "netlify.com", hint: "Sites, deploys, env vars" },
  { id: "supabase", name: "Supabase", url: "https://mcp.supabase.com/mcp", category: "cloud", auth: "oauth", icon: "supabase.com", hint: "Your Supabase projects: database, auth, storage" },
  { id: "vercel", name: "Vercel", url: "https://mcp.vercel.com", category: "cloud", auth: "oauth", icon: "vercel.com", hint: "Deployments, projects, and logs" },
  { id: "cpln", name: "Control Plane", url: "https://mcp.cpln.io/mcp", category: "cloud", auth: "oauth", icon: "controlplane.com", hint: "Multi-cloud workloads and orgs" },
  { id: "wpagent", name: "WP Agent", url: "https://mcp.getwpagent.com/mcp", category: "cloud", auth: "oauth", icon: "getwpagent.com", hint: "WordPress sites: content, plugins, maintenance" },
  { id: "cf-bindings", name: "Cloudflare Workers", url: "https://bindings.mcp.cloudflare.com/mcp", category: "cloud", auth: "oauth", icon: "cloudflare.com", hint: "Workers, KV, D1, R2 in your account" },
  { id: "cf-browser", name: "Cloudflare Browser", url: "https://browser.mcp.cloudflare.com/mcp", category: "cloud", auth: "oauth", icon: "cloudflare.com", hint: "Render pages with a headless browser" },
  { id: "stytch", name: "Stytch", url: "https://mcp.stytch.dev/mcp", category: "cloud", auth: "oauth", icon: "stytch.com", hint: "Auth platform management" },
  { id: "telnyx", name: "Telnyx", url: "https://api.telnyx.com/v2/mcp", category: "comms", auth: "token", tokenOptional: true, icon: "telnyx.com", hint: "Calls, SMS, and phone numbers", tokenPlaceholder: "Telnyx API key (optional)" },

  { id: "thoughtspot", name: "ThoughtSpot", url: "https://agent.thoughtspot.app/mcp", category: "data", auth: "oauth", icon: "thoughtspot.com", hint: "Analytics answers from your data" },
  { id: "neon", name: "Neon", url: "https://mcp.neon.tech/mcp", category: "data", auth: "oauth", icon: "neon.tech", hint: "Serverless Postgres: projects, branches, run SQL" },
  { id: "unstructured", name: "Unstructured", url: "https://mcp.transform.unstructured.io", category: "data", auth: "oauth", icon: "unstructured.io", hint: "Parse documents into structured data (ETL workflows)" },
  { id: "quicknode", name: "QuickNode", url: "https://mcp.quicknode.com/mcp", category: "data", auth: "token", icon: "quicknode.com", hint: "Blockchain RPC across major chains", tokenPlaceholder: "QuickNode API key" },
  { id: "chainstack", name: "Chainstack", url: "https://mcp.chainstack.com/mcp", category: "data", auth: "token", icon: "chainstack.com", hint: "Blockchain infra: nodes, projects, faucets — connects openly but every tool call needs the key", tokenPlaceholder: "Chainstack platform API key", docsUrl: "https://console.chainstack.com/user/settings/api-keys" },

  { id: "linear", name: "Linear", url: "https://mcp.linear.app/mcp", category: "work", auth: "oauth", icon: "linear.app", hint: "Issues, projects, comments" },
  { id: "notion", name: "Notion", url: "https://mcp.notion.com/mcp", category: "work", auth: "oauth", icon: "notion.so", hint: "Pages and databases" },
  { id: "asana", name: "Asana", url: "https://mcp.asana.com/mcp", category: "work", auth: "oauth", icon: "asana.com", hint: "Tasks and projects" },
  { id: "atlassian", name: "Atlassian", url: "https://mcp.atlassian.com/v1/mcp", category: "work", auth: "oauth", icon: "atlassian.com", hint: "Jira and Confluence" },
  { id: "attio", name: "Attio", url: "https://mcp.attio.com/mcp", category: "work", auth: "oauth", icon: "attio.com", hint: "CRM records and lists" },
  { id: "clickup", name: "ClickUp", url: "https://mcp.clickup.com/mcp", category: "work", auth: "oauth", icon: "clickup.com", hint: "Tasks, docs, spaces, and goals" },
  { id: "box", name: "Box", url: "https://mcp.box.com", category: "work", auth: "oauth", icon: "box.com", hint: "Files and folders" },
  { id: "fireflies", name: "Fireflies", url: "https://api.fireflies.ai/mcp", category: "work", auth: "token", icon: "fireflies.ai", hint: "Meeting transcripts and notes", tokenPlaceholder: "Fireflies API key" },
  { id: "egnyte", name: "Egnyte", url: "https://mcp-server.egnyte.com/mcp", category: "work", auth: "oauth", icon: "egnyte.com", hint: "Content collaboration" },
  { id: "todoist", name: "Todoist", url: "https://ai.todoist.net/mcp", category: "work", auth: "oauth", icon: "todoist.com", hint: "Tasks, projects, and filters" },
  { id: "monday", name: "monday.com", url: "https://mcp.monday.com/mcp", category: "work", auth: "oauth", icon: "monday.com", hint: "Boards, items, and docs" },
  { id: "guru", name: "Guru", url: "https://mcp.api.getguru.com/mcp", category: "work", auth: "oauth", icon: "getguru.com", hint: "Company knowledge base search" },
  { id: "tallyfy", name: "Tallyfy", url: "https://mcp.tallyfy.com/", category: "work", auth: "oauth", icon: "tallyfy.com", hint: "Processes and workflow tracking" },
  { id: "composio", name: "Composio", url: "https://connect.composio.dev/mcp", category: "work", auth: "oauth", icon: "composio.dev", hint: "Bridge to 500+ app integrations through one sign-in" },
  {
    id: "zapier",
    name: "Zapier",
    url: "https://mcp.zapier.com",
    category: "work",
    auth: "none",
    icon: "zapier.com",
    hint: "8,000+ apps through your personal Zapier MCP URL",
    blocked:
      "Zapier issues each account a personal server URL instead of one shared endpoint — copy yours from zapier.com/mcp and paste it into Custom MCP above (auth: Detect automatically).",
    docsUrl: "https://zapier.com/mcp",
  },

  { id: "figma", name: "Figma", url: "https://mcp.figma.com/mcp", category: "design", auth: "oauth", icon: "figma.com", hint: "Design files and components" },
  { id: "higgsfield", name: "Higgsfield", url: "https://mcp.higgsfield.ai/mcp", category: "design", auth: "oauth", icon: "higgsfield.ai", hint: "Generate images & video — 30+ models (Kling, Veo, Sora, Seedance, Soul). Spends your Higgsfield plan credits", docsUrl: "https://higgsfield.ai/mcp" },
  { id: "canva", name: "Canva", url: "https://mcp.canva.com/mcp", category: "design", auth: "oauth", icon: "canva.com", hint: "Designs and assets" },
  { id: "wix", name: "Wix", url: "https://mcp.wix.com/mcp", category: "design", auth: "oauth", icon: "wix.com", hint: "Manage Wix sites" },
  { id: "invideo", name: "InVideo", url: "https://mcp.invideo.io/mcp", category: "design", auth: "none", icon: "invideo.io", hint: "Generate videos from prompts" },
  { id: "miro", name: "Miro", url: "https://mcp.miro.com/", category: "design", auth: "oauth", icon: "miro.com", hint: "Boards, frames, and widgets" },
  { id: "webflow", name: "Webflow", url: "https://mcp.webflow.com/mcp", category: "design", auth: "oauth", icon: "webflow.com", hint: "Sites, CMS collections, publishing" },
  { id: "mobbin", name: "Mobbin", url: "https://api.mobbin.com/mcp", category: "design", auth: "oauth", icon: "mobbin.com", hint: "UI patterns and flows from real apps" },
  { id: "lucid", name: "Lucid", url: "https://mcp.lucid.app/mcp", category: "design", auth: "oauth", icon: "lucid.co", hint: "Lucidchart and Lucidspark documents" },
  { id: "opusclip", name: "OpusClip", url: "https://mcp.opus.pro/mcp", category: "design", auth: "oauth", icon: "opus.pro", hint: "Turn long videos into short clips" },
  { id: "glif", name: "Glif", url: "https://glif.app/api/mcp", category: "design", auth: "token", icon: "glif.app", hint: "Run community AI workflows (image, meme, text)", tokenPlaceholder: "Glif API token", docsUrl: "https://glif.app/settings/api-tokens" },

  { id: "square", name: "Square", url: "https://mcp.squareup.com/mcp", category: "commerce", auth: "oauth", icon: "squareup.com", hint: "Payments, catalog, customers" },
  { id: "paypal", name: "PayPal", url: "https://mcp.paypal.com/mcp", category: "commerce", auth: "oauth", icon: "paypal.com", hint: "Payments and invoices" },
  { id: "dodo", name: "Dodo Payments", url: "https://mcp.dodopayments.com/mcp", category: "commerce", auth: "oauth", icon: "dodopayments.com", hint: "Payments platform" },
  { id: "octagon", name: "Octagon", url: "https://mcp.octagonagents.com/mcp", category: "commerce", auth: "token", icon: "octagonagents.com", hint: "Financial and market research", tokenPlaceholder: "Octagon API key" },
  { id: "manifold", name: "Manifold", url: "https://api.manifold.markets/v0/mcp", category: "commerce", auth: "none", icon: "manifold.markets", hint: "Prediction market data" },
  { id: "stripe", name: "Stripe", url: "https://mcp.stripe.com", category: "commerce", auth: "oauth", icon: "stripe.com", hint: "Payments, customers, invoices, subscriptions" },
  { id: "atom", name: "Atom.com", url: "https://mcp.atom.com/mcp", category: "commerce", auth: "token", tokenOptional: true, icon: "atom.com", hint: "Domain name search, brainstorm, appraisal — connects openly, most tools need an API key", tokenPlaceholder: "Atom.com API key (optional)" },
  { id: "easyship", name: "Easyship", url: "https://mcp.easyship.com/mcp", category: "commerce", auth: "oauth", icon: "easyship.com", hint: "Shipping rates, labels, and tracking" },
  { id: "longbridge", name: "Longbridge", url: "https://mcp.longbridge.com", category: "commerce", auth: "oauth", icon: "longbridge.com", hint: "Markets: quotes, portfolio, and orders" },

  { id: "datadog", name: "Datadog", url: "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp", category: "observability", auth: "token", icon: "datadoghq.com", hint: "Metrics, logs, traces", tokenPlaceholder: "Datadog API key" },
  { id: "cf-observability", name: "Cloudflare Observability", url: "https://observability.mcp.cloudflare.com/mcp", category: "observability", auth: "oauth", icon: "cloudflare.com", hint: "Workers logs and analytics" },
  { id: "cf-radar", name: "Cloudflare Radar", url: "https://radar.mcp.cloudflare.com/mcp", category: "observability", auth: "oauth", icon: "cloudflare.com", hint: "Internet traffic insights" },
  { id: "amplitude", name: "Amplitude", url: "https://mcp.amplitude.com/mcp", category: "observability", auth: "oauth", icon: "amplitude.com", hint: "Product analytics: events, charts, cohorts" },
  { id: "axiom", name: "Axiom", url: "https://mcp.axiom.co/mcp", category: "observability", auth: "oauth", icon: "axiom.co", hint: "Query logs, traces, and events" },
];

const CATALOG_BY_ID = new Map(MCP_CATALOG.map((entry) => [entry.id, entry]));

export function findCatalogEntry(id: string): McpCatalogEntry | undefined {
  return CATALOG_BY_ID.get(id);
}

export function catalogEntryToServer(entry: McpCatalogEntry): McpServerConfig {
  return {
    id: entry.id,
    name: entry.name,
    url: entry.url,
    headersJson: "",
    token: "",
    catalogId: entry.id,
    enabled: true,
    status: "idle",
    tools: [],
    disabledTools: [],
  };
}

export function missingCatalogEntries(servers: McpServerConfig[]): McpCatalogEntry[] {
  const taken = new Set<string>();
  for (const server of servers) {
    if (server.catalogId) {
      taken.add(server.catalogId);
    }
    taken.add(server.id);
    taken.add(server.url.replace(/\/$/, ""));
  }
  return MCP_CATALOG.filter((entry) => {
    const url = entry.url.replace(/\/$/, "");
    return !taken.has(entry.id) && !taken.has(url);
  });
}

export function featuredCatalogEntries(): McpCatalogEntry[] {
  return FEATURED_MCP_IDS.map(findCatalogEntry).filter((entry): entry is McpCatalogEntry => Boolean(entry));
}

/** Drop unused auto-seeded catalog rows; keep custom URLs and anything the user actually tried. */
export function keepUserMcpServers(servers: McpServerConfig[]): McpServerConfig[] {
  return servers.filter((server) => {
    const fromCatalog = Boolean(server.catalogId) || Boolean(findCatalogEntry(server.id));
    if (!fromCatalog) {
      return Boolean(server.url?.trim());
    }
    if ((server.token ?? "").trim()) {
      return true;
    }
    if (server.headersJson?.trim()) {
      return true;
    }
    if (server.tools.length > 0) {
      return true;
    }
    return server.status === "connected" || server.status === "error" || server.status === "connecting";
  });
}
