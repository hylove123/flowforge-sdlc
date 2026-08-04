// ================================================================
//  Graph Engine — engine B of the dual-index architecture (t3).
//
//  Wraps codebase-memory-mcp (stdio MCP server) as a managed
//  process: spawn → heartbeat via lazy reconnect on broken pipe,
//  long-running index calls get a 10-minute timeout.
//
//  RPC surface (registered in index.ts):
//    graph_engine.configure / status
//    graph_engine.index_repo / index_cross_repo / index_status
//    graph_engine.search / trace / cypher
//    graph_engine.detect_changes / projects / delete_project
//
//  Engine A (tree-sitter FTS5 + sqlite-vec, Rust code_index) stays
//  the fast keyword/semantic path; this engine adds deep structural
//  knowledge: call graphs, cross-service edges (CROSS_HTTP_CALLS…),
//  trace_path impact analysis.
// ================================================================

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

export interface GraphEngineConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}

const BIN_NAME = process.platform === 'win32' ? 'codebase-memory-mcp.exe' : 'codebase-memory-mcp'

/**
 * Resolve the default launch config — zero external dependencies:
 *   1. FLOWFORGE_GRAPH_ENGINE_BIN env override (explicit path)
 *   2. bundled binary shipped next to the sidecar bundle
 *      (dist/graph-engine/, copied there by scripts/build.mjs)
 *   3. dev fallback: the package binary under sidecar/node_modules
 *   4. last resort: npx download (needs local npm + network)
 */
function resolveDefaultConfig(): GraphEngineConfig {
  const envBin = process.env.FLOWFORGE_GRAPH_ENGINE_BIN
  if (envBin && fs.existsSync(envBin)) return { command: envBin, args: [] }
  // bundled layout: dist/index.js sits next to dist/graph-engine/
  const here = path.dirname(fileURLToPath(import.meta.url))
  const bundled = path.join(here, 'graph-engine', BIN_NAME)
  if (fs.existsSync(bundled)) {
    try { fs.chmodSync(bundled, 0o755) } catch { /* best effort */ }
    return { command: bundled, args: [] }
  }
  try {
    const req = createRequire(import.meta.url)
    const pkgDir = path.dirname(req.resolve('codebase-memory-mcp/package.json'))
    const devBin = path.join(pkgDir, 'bin', BIN_NAME)
    if (fs.existsSync(devBin)) return { command: devBin, args: [] }
  } catch { /* package not installed */ }
  return { command: 'npx', args: ['-y', 'codebase-memory-mcp'] }
}

const CONNECT_TIMEOUT_MS = 30_000
/** index_repository on large repos can run for minutes. */
const CALL_TIMEOUT_MS = 10 * 60_000
/** Search/trace stay snappy. */
const QUERY_TIMEOUT_MS = 60_000

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} 超时（${Math.round(ms / 1000)}s）`)), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) }
    )
  })
}

/** MCP tool results arrive as text — parse JSON payloads when possible. */
function parseToolText(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed) } catch { /* not JSON — return raw text */ }
  }
  return trimmed
}

class GraphEngine {
  private config: GraphEngineConfig = resolveDefaultConfig()
  private client: Client | null = null
  private transport: StdioClientTransport | null = null
  private connecting: Promise<void> | null = null
  private toolNames: string[] = []
  lastError: string | null = null

  /** Swap the launch config; takes effect on (re)spawn. */
  configure(config: Partial<GraphEngineConfig> | null | undefined): void {
    if (config?.command) {
      this.config = {
        command: config.command,
        args: Array.isArray(config.args) ? config.args : [],
        env: config.env && typeof config.env === 'object' ? config.env : undefined,
      }
      // force respawn with the new command line
      void this.shutdown()
    }
  }

  get configSnapshot(): GraphEngineConfig {
    return { ...this.config, args: [...(this.config.args ?? [])] }
  }

  /** Lazy spawn + reconnect; concurrent callers share one attempt. */
  private async ensure(): Promise<Client> {
    if (this.client) return this.client
    if (!this.connecting) {
      this.connecting = this.spawn().finally(() => { this.connecting = null })
    }
    await this.connecting
    if (!this.client) throw new Error(this.lastError ?? '图谱引擎启动失败')
    return this.client
  }

  private async spawn(): Promise<void> {
    await this.shutdown()
    const client = new Client({ name: 'flowforge-graph-engine', version: '0.1.0' }, { capabilities: {} })
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args ?? [],
      // merge onto the SDK's safe default env so PATH etc. survive
      env: this.config.env ? { ...process.env as Record<string, string>, ...this.config.env } : undefined,
      stderr: 'ignore',
    })
    try {
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, '图谱引擎连接')
      const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, '图谱引擎工具发现')
      this.toolNames = (listed.tools ?? []).map((t) => t.name)
      this.client = client
      this.transport = transport
      this.lastError = null
      // process died → drop the connection so the next call respawns
      transport.onclose = () => {
        if (this.client === client) {
          this.client = null
          this.transport = null
        }
      }
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e)
      try { await client.close() } catch { /* transport may never have started */ }
      throw new Error(`图谱引擎（codebase-memory-mcp）启动失败：${this.lastError}`)
    }
  }

  private async shutdown(): Promise<void> {
    const client = this.client
    this.client = null
    this.transport = null
    if (client) {
      try { await client.close() } catch { /* already dead */ }
    }
  }

  /** Status probe — spawns on demand so the UI reflects reality. */
  async status(): Promise<{ available: boolean; tools: string[]; error: string | null; config: GraphEngineConfig }> {
    try {
      await this.ensure()
      return { available: true, tools: [...this.toolNames], error: null, config: this.configSnapshot }
    } catch (e) {
      return {
        available: false, tools: [],
        error: e instanceof Error ? e.message : String(e),
        config: this.configSnapshot,
      }
    }
  }

  /** Call a codebase-memory-mcp tool; broken pipes force a respawn next time. */
  async call(tool: string, args: Record<string, unknown>, timeoutMs = QUERY_TIMEOUT_MS): Promise<unknown> {
    const client = await this.ensure()
    try {
      const result = await withTimeout(
        client.callTool({ name: tool, arguments: args }),
        timeoutMs,
        `图谱引擎 ${tool}`
      )
      const content = Array.isArray(result.content) ? result.content : []
      const text = content
        .map((c: any) => (c?.type === 'text' ? c.text : JSON.stringify(c)))
        .join('\n')
      if (result.isError) throw new Error(text || `${tool} 执行失败`)
      return parseToolText(text)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // dead transport → clear so the next call respawns (exit-restart)
      if (/closed|terminated|not connected|EPIPE|disconnect/i.test(msg)) {
        this.client = null
        this.transport = null
      }
      this.lastError = msg
      throw e
    }
  }

  async stop(): Promise<void> {
    await this.shutdown()
  }
}

// ─── Module singleton + RPC handlers ────────────────────────────

let engine: GraphEngine | null = null

export function getGraphEngine(): GraphEngine {
  if (!engine) engine = new GraphEngine()
  return engine
}

/** Test helper — drops the singleton (process stays up). */
export async function resetGraphEngine(): Promise<void> {
  if (engine) await engine.stop()
  engine = null
}

/**
 * The engine derives project names from the repo's absolute path
 * (path separators → '-', e.g. /data/repos/order-service →
 * data-repos-order-service), NOT the directory basename. Resolve the
 * authoritative name for a repo path: prefer the engine's own
 * list_projects (root_path match), fall back to the slug rule.
 */
const projectNameCache = new Map<string, string>()

/** Mirror of the engine's derivation: absolute path, '/' → '-'. */
export function slugFromPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\//g, '-')
}

export async function resolveProjectName(
  project: string | undefined,
  repoPath: string | undefined
): Promise<string> {
  if (!repoPath) return project ?? ''
  let abs: string
  try { abs = fs.realpathSync(path.resolve(repoPath)) } catch { abs = path.resolve(repoPath) }
  const cached = projectNameCache.get(abs)
  if (cached) return cached
  try {
    const listed = (await getGraphEngine().call('list_projects', {})) as any
    const projects = Array.isArray(listed) ? listed : listed?.projects ?? []
    const norm = (s: string) => (s || '').replace(/\\/g, '/').replace(/\/+$/, '')
    const match = projects.find((pr: any) => norm(pr?.root_path ?? '') === norm(abs))
    if (match?.name) {
      projectNameCache.set(abs, match.name)
      return match.name
    }
  } catch { /* engine offline → fall back to the slug rule */ }
  const slug = slugFromPath(abs)
  projectNameCache.set(abs, slug)
  return slug
}

export const graphEngineMethods: Record<string, (params: any) => unknown | Promise<unknown>> = {
  /** { config: { command, args?, env? } } → status — swap launch command. */
  'graph_engine.configure': async (params) => {
    getGraphEngine().configure(params?.config)
    return getGraphEngine().status()
  },

  /** → { available, tools, error, config } */
  'graph_engine.status': () => getGraphEngine().status(),

  /** { repoPath, mode? } → index_repository result (project name derives from repo dir). */
  'graph_engine.index_repo': (params) => {
    const { repoPath, mode } = params ?? {}
    if (!repoPath) throw new Error('repoPath is required')
    return getGraphEngine().call(
      'index_repository',
      { repo_path: repoPath, ...(mode ? { mode } : {}) },
      CALL_TIMEOUT_MS
    )
  },

  /** { repoPath, targetProjects? } → cross-repo-intelligence pass (CROSS_* edges). */
  'graph_engine.index_cross_repo': (params) => {
    const { repoPath, targetProjects } = params ?? {}
    if (!repoPath) throw new Error('repoPath is required')
    return getGraphEngine().call(
      'index_repository',
      { repo_path: repoPath, mode: 'cross-repo-intelligence', target_projects: targetProjects ?? ['*'] },
      CALL_TIMEOUT_MS
    )
  },

  /** { project|repoPath, pattern|regex, mode?, limit? } → search_code (structure-aware). */
  'graph_engine.search': async (params) => {
    const { project, repoPath, pattern, regex, mode, limit, pathFilter } = params ?? {}
    const resolved = await resolveProjectName(project, repoPath)
    if (!resolved || (!pattern && !regex)) throw new Error('project|repoPath and pattern|regex are required')
    return getGraphEngine().call('search_code', {
      project: resolved,
      ...(pattern ? { pattern } : {}),
      ...(regex ? { regex } : {}),
      mode: mode ?? 'compact',
      limit: limit ?? 10,
      ...(pathFilter ? { path_filter: pathFilter } : {}),
    })
  },

  /** { project|repoPath, functionName, direction?, depth?, mode? } → trace_path. */
  'graph_engine.trace': async (params) => {
    const { project, repoPath, functionName, direction, depth, mode } = params ?? {}
    const resolved = await resolveProjectName(project, repoPath)
    if (!resolved || !functionName) throw new Error('project|repoPath and functionName are required')
    return getGraphEngine().call('trace_path', {
      project: resolved, function_name: functionName,
      ...(direction ? { direction } : {}),
      ...(depth ? { depth } : {}),
      mode: mode ?? 'calls',
    })
  },

  /** { project|repoPath, query, maxRows? } → query_graph (Cypher). */
  'graph_engine.cypher': async (params) => {
    const { project, repoPath, query, maxRows } = params ?? {}
    const resolved = await resolveProjectName(project, repoPath)
    if (!resolved || !query) throw new Error('project|repoPath and query are required')
    return getGraphEngine().call('query_graph', {
      project: resolved, query, ...(maxRows ? { max_rows: maxRows } : {}),
    })
  },

  /** { project|repoPath } → index_status. */
  'graph_engine.index_status': async (params) => {
    const { project, repoPath } = params ?? {}
    const resolved = await resolveProjectName(project, repoPath)
    if (!resolved) throw new Error('project|repoPath is required')
    return getGraphEngine().call('index_status', { project: resolved })
  },

  /** { project|repoPath, since? } → detect_changes (incremental sync entry). */
  'graph_engine.detect_changes': async (params) => {
    const { project, repoPath, since } = params ?? {}
    const resolved = await resolveProjectName(project, repoPath)
    if (!resolved) throw new Error('project|repoPath is required')
    return getGraphEngine().call('detect_changes', { project: resolved, ...(since ? { since } : {}) })
  },

  /** → list_projects. */
  'graph_engine.projects': () => getGraphEngine().call('list_projects', {}),

  /** { project|repoPath } → delete_project. */
  'graph_engine.delete_project': async (params) => {
    const { project, repoPath } = params ?? {}
    const resolved = await resolveProjectName(project, repoPath)
    if (!resolved) throw new Error('project|repoPath is required')
    projectNameCache.delete(resolved)
    return getGraphEngine().call('delete_project', { project: resolved })
  },
}
