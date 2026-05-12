import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const API_VERSION = "7.1";
const DEFAULT_DATA_DIR = ".wiki-cache";
const SNAPSHOT_FILE = "snapshot.json";
const VECTOR_DIM = 256;
const WORD_RE = /[a-z0-9_]+/gi;

export const WIKI_SUPPORT_TOOLS = {
  sync_now: "wiki_sync_now",
  search_issues: "wiki_search_issues",
  get_solution: "wiki_get_solution",
  get_runbook_steps: "wiki_get_runbook_steps",
  list_sources: "wiki_list_sources",
};

// Normalize wiki paths to start with "/".
function normalizePath(inputPath) {
  if (!inputPath) return "/";
  return inputPath.startsWith("/") ? inputPath : `/${inputPath}`;
}

// Read wiki scopes from env variables.
function parseScopes() {
  const defaultProject = process.env.ADO_PROJECT;
  const raw = process.env.WIKI_SCOPES;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      return parsed.map((entry) => ({
        wikiIdentifier: entry.wikiIdentifier,
        parentPath: normalizePath(entry.parentPath),
        project: entry.project || defaultProject,
        enabled: entry.enabled !== false,
      }));
    } catch {
      throw new Error("WIKI_SCOPES must be valid JSON.");
    }
  }

  const scopes = [];
  for (const n of [1, 2]) {
    const wikiIdentifier = process.env[`WIKI_${n}_NAME`];
    const parentPath = process.env[`WIKI_${n}_PARENT_PATH`];
    if (wikiIdentifier && parentPath) {
      scopes.push({
        wikiIdentifier,
        parentPath: normalizePath(parentPath),
        project: process.env[`WIKI_${n}_PROJECT`] || defaultProject,
        enabled: true,
      });
    }
  }
  return scopes;
}

// Build and validate runtime config from env.
function loadConfig() {
  const config = {
    orgUrl: (process.env.ADO_ORG_URL || "").replace(/\/$/, ""),
    project: process.env.ADO_PROJECT || "",
    pat: process.env.ADO_PAT || "",
    userAgent: process.env.WIKI_USER_AGENT || "ado-wiki-read-mcp/1.0",
    dataDir: path.resolve(process.env.WIKI_DATA_DIR || DEFAULT_DATA_DIR),
    sessionId: process.env.COPILOT_SESSION_ID || process.env.GITHUB_COPILOT_SESSION_ID || process.env.MCP_SESSION_ID || crypto.randomUUID(),
    scopes: parseScopes(),
  };

  if (!config.orgUrl || !config.project || !config.pat) {
    throw new Error("Missing required env vars: ADO_ORG_URL, ADO_PROJECT, ADO_PAT.");
  }
  if (!config.scopes.length) {
    throw new Error("No wiki scopes configured. Set WIKI_SCOPES or WIKI_1_NAME/WIKI_1_PARENT_PATH.");
  }
  return config;
}

class AdoWikiClient {
  // Initialize ADO wiki API client settings.
  constructor(config) {
    this.orgUrl = config.orgUrl;
    this.defaultProject = config.project;
    this.auth = `Basic ${Buffer.from(`:${config.pat}`).toString("base64")}`;
    this.userAgent = config.userAgent;
  }

  // Return standard request headers.
  headers() {
    return {
      Authorization: this.auth,
      "User-Agent": this.userAgent,
      "Content-Type": "application/json",
    };
  }

  // Build base wiki pages API URL.
  apiUrl(project, wikiIdentifier) {
    return `${this.orgUrl}/${encodeURIComponent(project)}/_apis/wiki/wikis/${encodeURIComponent(wikiIdentifier)}/pages`;
  }

  // Flatten nested wiki page tree into paths.
  flattenTree(node, output) {
    if (node?.path) output.add(node.path);
    for (const child of node?.subPages || []) this.flattenTree(child, output);
  }

  // List all page paths under a scope root.
  async listPaths(scope) {
    const project = scope.project || this.defaultProject;
    const url = `${this.apiUrl(project, scope.wikiIdentifier)}?path=${encodeURIComponent(scope.parentPath)}&recursionLevel=Full&api-version=${API_VERSION}`;
    const response = await fetch(url, { headers: this.headers() });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to list pages for ${scope.wikiIdentifier}: ${response.status} ${errorText}`);
    }
    const root = await response.json();
    const paths = new Set();
    this.flattenTree(root, paths);
    return [...paths].sort((a, b) => a.localeCompare(b));
  }

  // Fetch one wiki page with full content.
  async getPage(scope, pagePath) {
    const project = scope.project || this.defaultProject;
    const url = `${this.apiUrl(project, scope.wikiIdentifier)}?path=${encodeURIComponent(pagePath)}&includeContent=true&api-version=${API_VERSION}`;
    const response = await fetch(url, { headers: this.headers() });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get page ${scope.wikiIdentifier}${pagePath}: ${response.status} ${errorText}`);
    }
    const page = await response.json();
    const content = page?.content || "";
    return {
      wikiIdentifier: scope.wikiIdentifier,
      project,
      path: page?.path || pagePath,
      title: (page?.path || pagePath).split("/").filter(Boolean).pop() || "Home",
      content,
      updatedAt: new Date().toISOString(),
      hash: crypto.createHash("sha256").update(content).digest("hex"),
    };
  }
}

// Ensure cache directory exists.
async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

// Load cached wiki snapshot from disk.
async function loadSnapshot(dataDir) {
  await ensureDir(dataDir);
  const filePath = path.join(dataDir, SNAPSHOT_FILE);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return { pages: [], chunks: [], lastSyncAt: undefined, lastSyncedSessionId: undefined };
  }
}

// Save wiki snapshot to disk.
async function saveSnapshot(dataDir, snapshot) {
  await ensureDir(dataDir);
  const filePath = path.join(dataDir, SNAPSHOT_FILE);
  await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2), "utf8");
}

// Split markdown into heading-based sections.
function splitSections(markdown) {
  const lines = markdown.split(/\r?\n/);
  const sections = [];
  let heading = "Overview";
  let body = [];
  const flush = () => {
    // Save current section text.
    const text = body.join("\n").trim();
    if (text) sections.push({ section: heading, text });
    body = [];
  };

  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+)$/.exec(line);
    if (m) {
      flush();
      heading = m[2].trim();
    } else {
      body.push(line);
    }
  }
  flush();
  return sections.length ? sections : [{ section: "Overview", text: markdown }];
}

// Break long text into overlapping chunks.
function chunkWithOverlap(text, maxChars = 1800, overlap = 220) {
  if (text.length <= maxChars) return [text];
  const chunks = [];
  let cursor = 0;
  while (cursor < text.length) {
    const end = Math.min(text.length, cursor + maxChars);
    chunks.push(text.slice(cursor, end));
    if (end === text.length) break;
    cursor = Math.max(end - overlap, cursor + 1);
  }
  return chunks;
}

// Convert one wiki page into searchable chunks.
function chunkPage(page) {
  const chunks = [];
  const sections = splitSections(page.content || "");
  for (const section of sections) {
    const textChunks = chunkWithOverlap(section.text);
    textChunks.forEach((text, idx) => {
      const id = crypto
        .createHash("sha1")
        .update(`${page.project}|${page.wikiIdentifier}|${page.path}|${section.section}|${idx}|${page.hash}`)
        .digest("hex");
      chunks.push({
        id,
        wikiIdentifier: page.wikiIdentifier,
        project: page.project,
        path: page.path,
        title: page.title,
        section: section.section,
        text,
        updatedAt: page.updatedAt,
        hash: page.hash,
      });
    });
  }
  return chunks;
}

// Tokenize text into searchable terms.
function tokenize(text) {
  return (text.toLowerCase().match(WORD_RE) || []).filter((t) => t.length > 1);
}

// Build document frequency map for BM25 scoring.
function buildDocFreq(chunks) {
  const freq = new Map();
  for (const chunk of chunks) {
    const unique = new Set(tokenize(chunk.text));
    for (const token of unique) freq.set(token, (freq.get(token) || 0) + 1);
  }
  return freq;
}

// Compute BM25 lexical relevance score.
function bm25(queryTokens, chunk, docFreq, totalDocs) {
  if (!queryTokens.length) return 0;
  const tokens = tokenize(chunk.text);
  if (!tokens.length) return 0;
  const tf = new Map();
  for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);

  const k1 = 1.5;
  const b = 0.75;
  const avgDocLength = 220;
  const docLength = tokens.length;
  let score = 0;

  for (const token of queryTokens) {
    const n = docFreq.get(token) || 0;
    if (!n) continue;
    const idf = Math.log(1 + (totalDocs - n + 0.5) / (n + 0.5));
    const f = tf.get(token) || 0;
    if (!f) continue;
    const denom = f + k1 * (1 - b + b * (docLength / avgDocLength));
    score += idf * ((f * (k1 + 1)) / denom);
  }
  return score;
}

// Map token to vector dimension index.
function hashIndex(token) {
  let h = 0;
  for (let i = 0; i < token.length; i += 1) h = (h * 31 + token.charCodeAt(i)) >>> 0;
  return h % VECTOR_DIM;
}

// Build normalized hashed vector for semantic search.
function buildVector(text) {
  const vector = new Array(VECTOR_DIM).fill(0);
  for (const token of tokenize(text)) vector[hashIndex(token)] += 1;
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

// Compute cosine similarity between vectors.
function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}

// Normalize scores to 0..1 range.
function normalize(values) {
  const max = Math.max(...values, 0);
  if (!max) return values.map(() => 0);
  return values.map((v) => v / max);
}

// Run hybrid lexical + semantic ranking.
function hybridSearch(query, chunks, topK = 8) {
  if (!chunks.length) return [];
  const queryTokens = tokenize(query);
  const queryVector = buildVector(query);
  const docFreq = buildDocFreq(chunks);
  const totalDocs = chunks.length;

  const lexicalRaw = chunks.map((chunk) => bm25(queryTokens, chunk, docFreq, totalDocs));
  const semanticRaw = chunks.map((chunk) => cosine(queryVector, buildVector(chunk.text)));
  const lexical = normalize(lexicalRaw);
  const semantic = normalize(semanticRaw);

  return chunks
    .map((chunk, idx) => ({
      chunk,
      lexicalScore: lexical[idx],
      semanticScore: semantic[idx],
      score: lexical[idx] * 0.55 + semantic[idx] * 0.45,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// Convert a hit to citation metadata.
function toCitation(hit) {
  return {
    wikiIdentifier: hit.chunk.wikiIdentifier,
    project: hit.chunk.project,
    path: hit.chunk.path,
    section: hit.chunk.section,
    chunkId: hit.chunk.id,
  };
}

// Convert numeric score into confidence band.
function confidence(score) {
  if (score >= 0.78) return "high";
  if (score >= 0.48) return "medium";
  return "low";
}

// Pull list-like lines as actionable steps.
function extractSteps(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(-|\*|\d+\.)\s+/.test(line))
    .slice(0, 8);
}

// Build final support answer payload.
function buildAnswer(problem, hits) {
  if (!hits.length) {
    return {
      summary: `No strong evidence found for: "${problem}".`,
      confidence: "low",
      knownFix: [],
      workaround: [],
      investigation: [],
      escalation: ["Escalate with error text, timestamp, affected tenant/environment, and recent deployment context."],
      citations: [],
    };
  }

  const topTexts = hits.slice(0, 4).map((hit) => hit.chunk.text);
  const steps = topTexts.flatMap(extractSteps);
  return {
    summary: `Relevant guidance found in ${hits.length} chunks across ${new Set(hits.map((h) => h.chunk.wikiIdentifier)).size} wiki scopes.`,
    confidence: confidence(hits[0].score),
    knownFix: topTexts.slice(0, 1),
    workaround: topTexts.slice(1, 2),
    investigation: steps.length ? steps : ["Follow troubleshooting checks in cited sections below."],
    escalation: ["Escalate if issue persists after known fix/workaround checks and include source citations."],
    citations: hits.map(toCitation),
  };
}

// Check if page path belongs to scope root.
function pageInScope(pagePath, parentPath) {
  if (parentPath === "/") return true;
  return pagePath === parentPath || pagePath.startsWith(`${parentPath}/`);
}

// Perform full wiki sync and rebuild cache.
async function runFullSync(client, config, sessionId) {
  const existing = await loadSnapshot(config.dataDir);
  const oldByKey = new Map(existing.pages.map((page) => [`${page.project}|${page.wikiIdentifier}|${page.path}`, page]));
  const pages = [];
  let scanned = 0;
  let changed = 0;

  for (const scope of config.scopes.filter((s) => s.enabled)) {
    const paths = await client.listPaths(scope);
    for (const pagePath of paths) {
      if (!pageInScope(pagePath, scope.parentPath)) continue;
      scanned += 1;
      const page = await client.getPage(scope, pagePath);
      const key = `${page.project}|${page.wikiIdentifier}|${page.path}`;
      const old = oldByKey.get(key);
      if (!old || old.hash !== page.hash) changed += 1;
      pages.push(page);
    }
  }

  const chunks = pages.flatMap(chunkPage);
  const snapshot = {
    pages,
    chunks,
    lastSyncAt: new Date().toISOString(),
    lastSyncedSessionId: sessionId,
  };
  await saveSnapshot(config.dataDir, snapshot);

  return {
    scanned,
    changed,
    totalPages: pages.length,
    totalChunks: chunks.length,
    lastSyncAt: snapshot.lastSyncAt,
    sessionId,
  };
}

// Return JSON MCP response payload.
function jsonResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

// Return MCP error response payload.
function errorResult(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

// Register all wiki MCP tools on the server.
export function configureWikiSupportTools(server) {
  const config = loadConfig();
  const client = new AdoWikiClient(config);
  let syncPromise = null;

  // Load cache and sync once per session if needed.
  const getSnapshot = async () => {
    const snapshot = await loadSnapshot(config.dataDir);
    const alreadySyncedForSession = snapshot?.lastSyncedSessionId === config.sessionId;
    if (!snapshot?.chunks?.length || !alreadySyncedForSession) {
      if (!syncPromise) syncPromise = runFullSync(client, config, config.sessionId).finally(() => { syncPromise = null; });
      await syncPromise;
      return loadSnapshot(config.dataDir);
    }
    return snapshot;
  };

  // Start or reuse an in-flight sync operation.
  const ensureSyncRunning = async () => {
    if (!syncPromise) syncPromise = runFullSync(client, config, config.sessionId).finally(() => { syncPromise = null; });
    return syncPromise;
  };

  server.tool(
    WIKI_SUPPORT_TOOLS.sync_now,
    "Run full sync for configured wiki scopes and rebuild searchable snapshot.",
    {},
    async () => {
      try {
        const stats = await ensureSyncRunning();
        return jsonResult(stats);
      } catch (error) {
        return errorResult(`wiki_sync_now failed: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }
  );

  server.tool(
    WIKI_SUPPORT_TOOLS.search_issues,
    "Search both wiki scopes using hybrid retrieval (lexical + semantic).",
    {
      query: z.string().min(3).describe("Issue text, symptoms, error code, or support question."),
      topK: z.coerce.number().int().min(1).max(30).default(8),
    },
    async ({ query, topK = 8 }) => {
      try {
        const snapshot = await getSnapshot();
        const hits = hybridSearch(query, snapshot.chunks, topK).map((hit) => ({
          score: hit.score,
          lexicalScore: hit.lexicalScore,
          semanticScore: hit.semanticScore,
          wikiIdentifier: hit.chunk.wikiIdentifier,
          project: hit.chunk.project,
          path: hit.chunk.path,
          section: hit.chunk.section,
          snippet: hit.chunk.text.slice(0, 350),
          chunkId: hit.chunk.id,
        }));
        return jsonResult({ query, totalHits: hits.length, hits });
      } catch (error) {
        return errorResult(`wiki_search_issues failed: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }
  );

  server.tool(
    WIKI_SUPPORT_TOOLS.get_solution,
    "Return summary + ordered support guidance with citations and confidence.",
    {
      problem: z.string().min(3).describe("Production issue summary to solve."),
      topK: z.coerce.number().int().min(1).max(30).default(8),
    },
    async ({ problem, topK = 8 }) => {
      try {
        const snapshot = await getSnapshot();
        const hits = hybridSearch(problem, snapshot.chunks, topK);
        const answer = buildAnswer(problem, hits);
        return jsonResult(answer);
      } catch (error) {
        return errorResult(`wiki_get_solution failed: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }
  );

  server.tool(
    WIKI_SUPPORT_TOOLS.get_runbook_steps,
    "Return only actionable troubleshooting/runbook steps with citations.",
    {
      problem: z.string().min(3).describe("Issue context for extracting runbook steps."),
      topK: z.coerce.number().int().min(1).max(30).default(8),
    },
    async ({ problem, topK = 8 }) => {
      try {
        const snapshot = await getSnapshot();
        const hits = hybridSearch(problem, snapshot.chunks, topK);
        const answer = buildAnswer(problem, hits);
        return jsonResult({
          confidence: answer.confidence,
          steps: answer.investigation,
          citations: answer.citations,
        });
      } catch (error) {
        return errorResult(`wiki_get_runbook_steps failed: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }
  );

  server.tool(
    WIKI_SUPPORT_TOOLS.list_sources,
    "Return the source citations used for a query.",
    {
      query: z.string().min(3).describe("Search query to resolve source list."),
      topK: z.coerce.number().int().min(1).max(30).default(10),
    },
    async ({ query, topK = 10 }) => {
      try {
        const snapshot = await getSnapshot();
        const hits = hybridSearch(query, snapshot.chunks, topK);
        const citations = hits.map(toCitation);
        return jsonResult({ query, totalSources: citations.length, citations });
      } catch (error) {
        return errorResult(`wiki_list_sources failed: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }
  );
}

