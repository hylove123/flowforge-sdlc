// ================================================================
//  MCP Client Manager — connection lifecycle for user-configured
//  MCP servers (Phase 4).
//
//  SDK: @modelcontextprotocol/sdk 1.29.0
//    Client                    client/index.js  (connect/listTools/callTool/close)
//    StdioClientTransport      client/stdio.js  ({ command, args, env, stderr })
//    StreamableHTTPClientTransport / SSEClientTransport for { url } servers
//
//  Failure isolation: every per-server operation catches its own error
//  and records it on the server entry — one broken server never takes
//  down the others (or graph execution).
// ================================================================

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'

// ─── Config shapes (as passed from the frontend via RPC) ────────

/** stdio server: { name, command, args?, env? } · remote server: { name, url, transport? } */
export interface McpServerConfig {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  /** 'http' (streamable, default for url) | 'sse' (legacy fallback). */
  transport?: 'stdio' | 'http' | 'sse'
}

export interface McpToolInfo {
  /** Tool name as exposed by the server. */
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  /** Owning server name. */
  server: string
}

export interface McpServerStatus {
  name: string
  status: 'connected' | 'error' | 'disconnected'
  error: string | null
  toolCount: number
}

const CONNECT_TIMEOUT_MS = 15_000

interface Connection {
  config: McpServerConfig
  client: Client
  tools: McpToolInfo[]
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) }
    )
  })
}

function buildTransport(config: McpServerConfig) {
  if (config.command) {
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      // merge onto the SDK's safe default env so PATH etc. survive
      env: config.env ? { ...process.env as Record<string, string>, ...config.env } : undefined,
      stderr: 'ignore',
    })
  }
  if (config.url) {
    if (config.transport === 'sse') return new SSEClientTransport(new URL(config.url))
    return new StreamableHTTPClientTransport(new URL(config.url))
  }
  throw new Error(`MCP server "${config.name}" 配置缺少 command 或 url`)
}

// ─── Manager ────────────────────────────────────────────────────

export class McpClientManager {
  private connections = new Map<string, Connection>()
  private errors = new Map<string, string>()

  /**
   * Connects a single server (idempotent — an existing live connection is
   * reused). Throws on failure; the error is also recorded for status().
   */
  async connect(config: McpServerConfig): Promise<McpToolInfo[]> {
    if (!config?.name) throw new Error('MCP server 配置缺少 name')
    const existing = this.connections.get(config.name)
    if (existing) return existing.tools

    const client = new Client({ name: 'flowforge-sidecar', version: '0.1.0' }, { capabilities: {} })
    try {
      const transport = buildTransport(config)
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connect(${config.name})`)
      const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `listTools(${config.name})`)
      const tools: McpToolInfo[] = (listed.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
        server: config.name,
      }))
      this.connections.set(config.name, { config, client, tools })
      this.errors.delete(config.name)
      return tools
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.errors.set(config.name, message)
      try { await client.close() } catch { /* transport may never have started */ }
      throw new Error(`MCP server "${config.name}" 连接失败: ${message}`)
    }
  }

  /**
   * Connects a batch of servers; failures are isolated per server and
   * reported in the returned status list instead of thrown.
   */
  async connectAll(configs: McpServerConfig[]): Promise<McpServerStatus[]> {
    await Promise.all(
      (configs ?? []).map((c) => this.connect(c).catch(() => { /* recorded in this.errors */ }))
    )
    return this.status(configs)
  }

  /** All tools from currently-connected servers. */
  listTools(): McpToolInfo[] {
    return [...this.connections.values()].flatMap((c) => c.tools)
  }

  status(configs?: McpServerConfig[]): McpServerStatus[] {
    const names = configs?.map((c) => c.name)
      ?? [...new Set([...this.connections.keys(), ...this.errors.keys()])]
    return names.map((name) => {
      const conn = this.connections.get(name)
      if (conn) return { name, status: 'connected', error: null, toolCount: conn.tools.length }
      const error = this.errors.get(name)
      return { name, status: error ? 'error' : 'disconnected', error: error ?? null, toolCount: 0 }
    })
  }

  /** Calls a tool on a named server; returns the flattened text content. */
  async callTool(serverName: string, toolName: string, args: Record<string, unknown> = {}): Promise<{
    text: string
    isError: boolean
    raw: unknown
  }> {
    const conn = this.connections.get(serverName)
    if (!conn) {
      const err = this.errors.get(serverName)
      throw new Error(err
        ? `MCP server "${serverName}" 不可用: ${err}`
        : `MCP server "${serverName}" 未连接`)
    }
    const result = await withTimeout(
      conn.client.callTool({ name: toolName, arguments: args }),
      CONNECT_TIMEOUT_MS,
      `callTool(${serverName}/${toolName})`
    )
    const content = Array.isArray(result.content) ? result.content : []
    const text = content
      .map((c: any) => (c?.type === 'text' ? c.text : JSON.stringify(c)))
      .join('\n')
    return { text, isError: Boolean(result.isError), raw: result }
  }

  async disconnect(name: string): Promise<void> {
    const conn = this.connections.get(name)
    this.connections.delete(name)
    this.errors.delete(name)
    if (conn) {
      try { await conn.client.close() } catch { /* already dead */ }
    }
  }

  async disconnectAll(): Promise<void> {
    const names = [...this.connections.keys()]
    await Promise.all(names.map((n) => this.disconnect(n)))
    this.errors.clear()
  }
}

// ─── Module-level singleton (shared by RPC handlers + graph runtime) ──

let manager: McpClientManager | null = null

export function getMcpManager(): McpClientManager {
  if (!manager) manager = new McpClientManager()
  return manager
}

/** Test helper — drops all connections and the singleton. */
export async function resetMcpManager(): Promise<void> {
  if (manager) await manager.disconnectAll()
  manager = null
}
