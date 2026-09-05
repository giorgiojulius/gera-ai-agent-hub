// One-off, deterministic split of functions/project-store.ts into
// project-rows.ts (shared row types + row→wire mappers) and desk-routes.ts
// (desk/screens/Intercom/tracking/stats/screen-chat handlers over DeskContext).
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = "/home/user/rork-app/functions";
const SRC = `${ROOT}/project-store.ts`;
const src = readFileSync(SRC, "utf8");
const lines = src.split("\n");

function findLine(pred: (l: string) => boolean, from = 1): number {
  for (let i = from; i <= lines.length; i++) {
    if (pred(lines[i - 1])) return i;
  }
  throw new Error("line not found");
}
function withLeadingComments(start: number): number {
  let s = start;
  while (s > 1) {
    const prev = lines[s - 2];
    if (/^(\/\*\*|\s\*|\/\/)/.test(prev)) s -= 1;
    else break;
  }
  return s;
}
function typeBlock(name: string): [number, number] {
  const s = findLine((l) => l.startsWith(`type ${name} =`));
  const e = lines[s - 1].trimEnd().endsWith(";") ? s : findLine((l) => l === "};", s);
  return [withLeadingComments(s), e];
}
function fnBlock(name: string): [number, number] {
  const s = findLine((l) => l.startsWith(`function ${name}(`));
  const e = findLine((l) => l === "}", s);
  return [withLeadingComments(s), e];
}
function slice([s, e]: [number, number]): string {
  return lines.slice(s - 1, e).join("\n");
}

// ---- blocks -------------------------------------------------------------
const ROW_TYPES = ["MemberRow", "AgentRow", "ScreenRow", "ScreenChatRow", "ScreenJobRow"];
const ROW_FNS = ["newId", "parseWidgets", "screenWire", "storedExecutionOutcome", "screenChatWire"];
const DESK_TYPES = [
  "DeskReplyRow",
  "DeskSuggestionRow",
  "DeskLinkRow",
  "DeskCoachRow",
  "DeskStatsMetaRow",
  "DeskStatsRange",
  "DeskSlackPoolData",
  "DeskSlackThreadWire",
];
const DESK_FNS = ["deskStatsRange"];

const constStart = findLine((l) => l.startsWith("// Desk intelligence:"));
const constEnd = findLine((l) => l.startsWith("const DESK_ASK_VISIBLE_MS ="));
const methodStart = findLine((l) => l.startsWith("  private handleScreenUpsert("));
const agentRunsMarker = findLine((l) => l.startsWith("  // --- Agent runs ---"));
let methodEnd = agentRunsMarker - 1;
while (lines[methodEnd - 1].trim() === "") methodEnd -= 1;
if (lines[methodEnd - 1] !== "  }") throw new Error(`unexpected method end ${methodEnd}: ${lines[methodEnd - 1]}`);

const removed: Array<[number, number]> = [];
const rowTypeBlocks = ROW_TYPES.map(typeBlock);
const rowFnBlocks = ROW_FNS.map(fnBlock);
const deskTypeBlocks = DESK_TYPES.map(typeBlock);
const deskFnBlocks = DESK_FNS.map(fnBlock);
removed.push(...rowTypeBlocks, ...rowFnBlocks, ...deskTypeBlocks, ...deskFnBlocks);
removed.push([constStart, constEnd]);
removed.push([methodStart, methodEnd]);

// ---- transform methods → functions -------------------------------------
const SEAM = ["metaValue", "loadMember", "memberRole", "loadAgent", "loadScreen", "screenIntercomToken", "screenSlackToken"];
const INTERNAL = [
  "trackingKey",
  "contactPageViews",
  "deskAuthKey",
  "screenDeskModel",
  "deskCompletion",
  "deskSlackPool",
  "deskSlackThreads",
  "deskStatsPayload",
];
const handlers: string[] = [];
const methodLines = lines.slice(methodStart - 1, methodEnd);
const out: string[] = [];
for (let i = 0; i < methodLines.length; i++) {
  const line = methodLines[i];
  const decl = /^  private (async )?([A-Za-z_]\w*)\((.*)$/.exec(line);
  if (decl) {
    const [, asyncKw, name, rest] = decl;
    const exported = name.startsWith("handle");
    if (exported) handlers.push(name);
    else if (!INTERNAL.includes(name)) throw new Error(`unexpected internal method ${name}`);
    const head = `${exported ? "export " : ""}${asyncKw ?? ""}function ${name}(`;
    if (rest === "") {
      out.push(head);
      out.push("  ctx: DeskContext,");
    } else if (rest.startsWith(")")) {
      out.push(`${head}ctx: DeskContext${rest}`);
    } else {
      out.push(`${head}ctx: DeskContext, ${rest}`);
    }
    continue;
  }
  out.push(line.startsWith("  ") ? line.slice(2) : line);
}
let body = out.join("\n");
body = body.replace(/\bthis\.ctx\.storage\.sql\b/g, "ctx.sql");
body = body.replace(/\bthis\.workerEnv\b/g, "ctx.workerEnv");
body = body.replace(new RegExp(`\\bthis\\.(${SEAM.join("|")})\\(`, "g"), "ctx.$1(");
// Internal calls: zero-arg, line-ending (multi-line args) and inline forms.
body = body.replace(new RegExp(`\\bthis\\.(${INTERNAL.join("|")})\\(\\)`, "g"), "$1(ctx)");
{
  const bl = body.split("\n");
  for (let i = 0; i < bl.length; i++) {
    const m = new RegExp(`\\bthis\\.(${INTERNAL.join("|")})\\($`).exec(bl[i]);
    if (m) {
      const nextIndent = /^\s*/.exec(bl[i + 1] ?? "")![0];
      bl[i] = bl[i].replace(m[0], `${m[1]}(`);
      bl.splice(i + 1, 0, `${nextIndent}ctx,`);
    }
  }
  body = bl.join("\n");
}
body = body.replace(new RegExp(`\\bthis\\.(${INTERNAL.join("|")})\\(`, "g"), "$1(ctx, ");
const leftoverThis = body.split("\n").filter((l) => /\bthis\./.test(l));
if (leftoverThis.length) {
  console.error("LEFTOVER this:\n" + leftoverThis.join("\n"));
  process.exit(1);
}

// ---- imports ------------------------------------------------------------
type Imp = { module: string; names: Array<{ name: string; isType: boolean }>; start: number; end: number };
const imports: Imp[] = [];
for (let i = 1; i <= lines.length; i++) {
  const l = lines[i - 1];
  if (!l.startsWith("import ")) continue;
  let e = i;
  while (!/from "[^"]+";$/.test(lines[e - 1])) e += 1;
  const text = lines.slice(i - 1, e).join("\n");
  const mod = /from "([^"]+)";$/.exec(text)![1];
  const inner = /\{([\s\S]*)\}/.exec(text);
  const names = inner
    ? inner[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => ({ name: s.replace(/^type /, ""), isType: s.startsWith("type ") }))
    : [];
  imports.push({ module: mod, names, start: i, end: e });
  i = e;
}
const importEnd = imports[imports.length - 1].end;

function usedIn(text: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(text);
}
function importBlock(module: string, names: Array<{ name: string; isType: boolean }>): string {
  const sorted = [...names].sort((a, b) => a.name.localeCompare(b.name, "en"));
  const items = sorted.map((n) => `${n.isType ? "type " : ""}${n.name}`);
  const one = `import { ${items.join(", ")} } from "${module}";`;
  if (one.length <= 100) return one;
  return `import {\n${items.map((s) => `  ${s},`).join("\n")}\n} from "${module}";`;
}

// desk-routes text (before imports) to compute its needs
const deskTypesText = deskTypeBlocks.map(slice).join("\n");
const deskConstsText = slice([constStart, constEnd]);
const deskFnsText = deskFnBlocks.map(slice).join("\n\n");
const deskCore = `${deskConstsText}\n\n${deskTypesText}\n\n${deskFnsText}\n\n${body}`;

const deskImports: string[] = [];
for (const imp of imports) {
  if (imp.module === "cloudflare:workers") continue;
  const need = imp.names.filter((n) => usedIn(deskCore, n.name));
  if (need.length) deskImports.push(importBlock(imp.module, need));
}
// shared helpers / types from project-rows
const rowNames = [...ROW_FNS, ...ROW_TYPES];
const deskRowNeed = rowNames.filter((n) => usedIn(deskCore, n) || ["MemberRow", "AgentRow", "ScreenRow"].includes(n));
deskImports.push(
  importBlock(
    "./project-rows",
    deskRowNeed.map((n) => ({ name: n, isType: ROW_TYPES.includes(n) })),
  ),
);
// ChatSql for the seam
const chatSharedIdx = deskImports.findIndex((s) => s.includes('"./chat-shared"'));
{
  const imp = imports.find((i) => i.module === "./chat-shared")!;
  const need = imp.names.filter((n) => usedIn(deskCore, n.name));
  need.push({ name: "ChatSql", isType: true });
  const block = importBlock("./chat-shared", need);
  if (chatSharedIdx >= 0) deskImports[chatSharedIdx] = block;
  else deskImports.push(block);
}
// ProjectRole for the seam
{
  const idx = deskImports.findIndex((s) => s.includes('"./project-shared"'));
  const imp = imports.find((i) => i.module === "./project-shared")!;
  const need = imp.names.filter((n) => usedIn(deskCore, n.name));
  if (!need.some((n) => n.name === "ProjectRole")) need.push({ name: "ProjectRole", isType: true });
  const block = importBlock("./project-shared", need);
  if (idx >= 0) deskImports[idx] = block;
  else deskImports.push(block);
}
deskImports.sort((a, b) => {
  const ma = /from "([^"]+)"/.exec(a)![1];
  const mb = /from "([^"]+)"/.exec(b)![1];
  return ma.localeCompare(mb, "en");
});

// unresolved top-level references (would need a cycle) → report
const topDecls = new Set<string>();
for (const l of lines) {
  const m = /^(?:export )?(?:async function|function|const|type|interface) ([A-Za-z_]\w*)/.exec(l);
  if (m) topDecls.add(m[1]);
}
for (const n of [...ROW_TYPES, ...ROW_FNS, ...DESK_TYPES, ...DESK_FNS]) topDecls.delete(n);
const unresolved = [...topDecls].filter((n) => !/^DESK_/.test(n) && usedIn(body, n));
if (unresolved.length) {
  console.error("UNRESOLVED top-level refs in desk body: " + unresolved.join(", "));
  process.exit(1);
}

const deskHeader = `// Desk routes of the ProjectStore shard — screens, the Intercom inbox desk
// (inbox / thread / details / reply / mention-admins / suggest / action /
// ask-gera), website page-view tracking, desk ↔ Slack awareness, desk stats
// and screen chat. Moved verbatim out of project-store.ts: the shard stays a
// thin dispatcher and lends storage, its member / agent / screen lookups and
// the widget credentials through DeskContext. Secrets never leave the shard —
// tokens are resolved per request and only ever reach the connector calls.
`;
const seam = `/** What the ProjectStore shard lends the desk routes: storage plus its lookups and widget credentials. */
export type DeskContext = {
  sql: ChatSql;
  /** Worker env — the AI gateway key for desk completions. */
  workerEnv: { EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY?: string; RORK_TOOLKIT_SECRET_KEY?: string };
  metaValue(key: string): string;
  loadMember(email: string): MemberRow | null;
  memberRole(member: MemberRow): ProjectRole;
  loadAgent(id: string): AgentRow | undefined;
  loadScreen(id: string): ScreenRow | undefined;
  /** The inbox widget's agent supplies the Intercom credential for the screen. */
  screenIntercomToken(screen: ScreenRow): Promise<{ token: string } | { error: string }>;
  /** The screen's Slack-capable agent supplies the bot token. */
  screenSlackToken(screen: ScreenRow): Promise<{ token: string } | { error: string }>;
};
`;
const deskFile = `${deskHeader}\n${deskImports.join("\n")}\n\n${seam}\n${deskConstsText}\n\n${deskTypesText}\n\n${deskFnsText}\n\n${body}\n`;

// ---- project-rows -------------------------------------------------------
const rowsCore = `${rowTypeBlocks.map(slice).join("\n")}\n\n${rowFnBlocks.map(slice).join("\n\n")}`;
const rowsImports: string[] = [];
for (const imp of imports) {
  if (imp.module === "cloudflare:workers") continue;
  const need = imp.names.filter((n) => usedIn(rowsCore, n.name));
  if (need.length) rowsImports.push(importBlock(imp.module, need));
}
const rowsUnresolved = [...topDecls].filter((n) => usedIn(rowsCore, n));
if (rowsUnresolved.length) {
  console.error("UNRESOLVED top-level refs in rows: " + rowsUnresolved.join(", "));
  process.exit(1);
}
const rowsExported = rowsCore
  .replace(/^type /gm, "export type ")
  .replace(/^function /gm, "export function ");
const rowsHeader = `// Row shapes and row → wire mappers shared by the ProjectStore shard
// (project-store.ts) and its desk routes (desk-routes.ts). Pure: no storage,
// no secrets — the sealed \`agents.secrets\` blob is opened only in the shard.
`;
const rowsFile = `${rowsHeader}\n${rowsImports.join("\n")}\n\n${rowsExported}\n`;

// ---- rewrite project-store ----------------------------------------------
const drop = new Set<number>();
for (const [s, e] of removed) for (let i = s; i <= e; i++) drop.add(i);
let kept = lines.filter((_, idx) => !drop.has(idx + 1));
// deskContext() seam + dispatcher rewrite
let storeText = kept.join("\n");
storeText = storeText.replace(new RegExp(`this\\.(${handlers.join("|")})\\(`, "g"), "$1(this.deskContext(), ");
const deskContextMethod = `  /** Storage, lookups and widget credentials the desk routes (desk-routes.ts) run over. */
  private deskContext(): DeskContext {
    return {
      sql: this.ctx.storage.sql,
      workerEnv: this.workerEnv,
      metaValue: (key) => this.metaValue(key),
      loadMember: (email) => this.loadMember(email),
      memberRole: (member) => this.memberRole(member),
      loadAgent: (id) => this.loadAgent(id),
      loadScreen: (id) => this.loadScreen(id),
      screenIntercomToken: (screen) => this.screenIntercomToken(screen),
      screenSlackToken: (screen) => this.screenSlackToken(screen),
    };
  }

  // --- Agent runs ---`;
storeText = storeText.replace("  // --- Agent runs ---", deskContextMethod);

// imports: prune unused, add new
const storeLines = storeText.split("\n");
const storeImportEnd = (() => {
  let e = 0;
  for (let i = 0; i < storeLines.length; i++) if (/^} from "|^import .* from "/.test(storeLines[i])) e = i + 1;
  return e;
})();
const storeBody = storeLines.slice(storeImportEnd).join("\n");
const newImports: string[] = [];
for (const imp of imports) {
  if (imp.module === "cloudflare:workers") {
    newImports.push(lines.slice(imp.start - 1, imp.end).join("\n"));
    continue;
  }
  const need = imp.names.filter((n) => usedIn(storeBody, n.name));
  if (need.length) newImports.push(importBlock(imp.module, need));
}
newImports.push(
  importBlock(
    "./desk-routes",
    [...handlers.map((n) => ({ name: n, isType: false })), { name: "DeskContext", isType: true }],
  ),
);
const rowsNeed = rowNames.filter((n) => usedIn(storeBody, n));
newImports.push(importBlock("./project-rows", rowsNeed.map((n) => ({ name: n, isType: ROW_TYPES.includes(n) }))));
const cf = newImports.shift()!;
newImports.sort((a, b) => /from "([^"]+)"/.exec(a)![1].localeCompare(/from "([^"]+)"/.exec(b)![1], "en"));
// header comment = everything before the first import in the original
const headerEnd = imports[0].start - 1;
const header = lines.slice(0, headerEnd).join("\n");
let finalStore = `${header}\n${cf}\n\n${newImports.join("\n")}\n${storeLines.slice(storeImportEnd).join("\n")}`;
finalStore = finalStore.replace(/\n{3,}/g, "\n\n");

writeFileSync(`${ROOT}/desk-routes.ts`, deskFile.replace(/\n{3,}/g, "\n\n"));
writeFileSync(`${ROOT}/project-rows.ts`, rowsFile.replace(/\n{3,}/g, "\n\n"));
writeFileSync(SRC, finalStore);
console.log(
  JSON.stringify(
    {
      handlers,
      methodRange: [methodStart, methodEnd],
      consts: [constStart, constEnd],
      deskImports,
      rowsImports,
      storeBytes: Buffer.byteLength(finalStore),
      deskBytes: Buffer.byteLength(deskFile),
      rowsBytes: Buffer.byteLength(rowsFile),
    },
    null,
    2,
  ),
);
