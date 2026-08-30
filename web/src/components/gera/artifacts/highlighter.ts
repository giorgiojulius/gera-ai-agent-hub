import type { ComponentType, CSSProperties } from "react";
import type { SyntaxHighlighterProps } from "react-syntax-highlighter";

/**
 * Lazy-loaded Prism highlighter singleton. Code blocks render plain text
 * instantly and swap to highlighted output once this chunk arrives.
 */
export type Highlighter = {
  Component: ComponentType<SyntaxHighlighterProps>;
  theme: Record<string, CSSProperties>;
  languages: Set<string>;
};

const LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  ts: "typescript",
  py: "python",
  python3: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  terminal: "bash",
  yml: "yaml",
  html: "markup",
  xml: "markup",
  svg: "markup",
  vue: "markup",
  golang: "go",
  rs: "rust",
  kt: "kotlin",
  md: "markdown",
  jsonc: "json",
  json5: "json",
  postgres: "sql",
  postgresql: "sql",
  mysql: "sql",
  sqlite: "sql",
};

export function normalizeLanguage(language?: string): string {
  const lower = (language ?? "").trim().toLowerCase();
  return LANGUAGE_ALIASES[lower] ?? lower;
}

let cached: Highlighter | null = null;
let pending: Promise<Highlighter> | null = null;

export function cachedHighlighter(): Highlighter | null {
  return cached;
}

const LANGUAGE_NAMES = [
  "markup",
  "css",
  "javascript",
  "jsx",
  "typescript",
  "tsx",
  "json",
  "python",
  "bash",
  "sql",
  "yaml",
  "go",
  "rust",
  "java",
  "swift",
  "kotlin",
  "markdown",
] as const;

export function loadHighlighter(): Promise<Highlighter> {
  if (cached) {
    return Promise.resolve(cached);
  }
  pending ??= (async () => {
    const [core, theme, ...langs] = await Promise.all([
      import("react-syntax-highlighter/dist/esm/prism-light"),
      import("react-syntax-highlighter/dist/esm/styles/prism/one-dark"),
      import("react-syntax-highlighter/dist/esm/languages/prism/markup"),
      import("react-syntax-highlighter/dist/esm/languages/prism/css"),
      import("react-syntax-highlighter/dist/esm/languages/prism/javascript"),
      import("react-syntax-highlighter/dist/esm/languages/prism/jsx"),
      import("react-syntax-highlighter/dist/esm/languages/prism/typescript"),
      import("react-syntax-highlighter/dist/esm/languages/prism/tsx"),
      import("react-syntax-highlighter/dist/esm/languages/prism/json"),
      import("react-syntax-highlighter/dist/esm/languages/prism/python"),
      import("react-syntax-highlighter/dist/esm/languages/prism/bash"),
      import("react-syntax-highlighter/dist/esm/languages/prism/sql"),
      import("react-syntax-highlighter/dist/esm/languages/prism/yaml"),
      import("react-syntax-highlighter/dist/esm/languages/prism/go"),
      import("react-syntax-highlighter/dist/esm/languages/prism/rust"),
      import("react-syntax-highlighter/dist/esm/languages/prism/java"),
      import("react-syntax-highlighter/dist/esm/languages/prism/swift"),
      import("react-syntax-highlighter/dist/esm/languages/prism/kotlin"),
      import("react-syntax-highlighter/dist/esm/languages/prism/markdown"),
    ]);
    const Component = core.default;
    LANGUAGE_NAMES.forEach((name, index) => {
      const mod = langs[index] as { default: unknown } | undefined;
      if (mod) {
        Component.registerLanguage(name, mod.default);
      }
    });
    cached = {
      Component: Component as unknown as ComponentType<SyntaxHighlighterProps>,
      theme: theme.default as Record<string, CSSProperties>,
      languages: new Set(LANGUAGE_NAMES),
    };
    return cached;
  })();
  return pending;
}
