// ================================================================
//  Tool Registry — turns MCP tools into LLM function-calling tools
//  and drives the tool-calling loop inside stage generation.
//
//  Naming: tools are exposed to the model as `${server}__${tool}`
//  (double underscore) so multi-server setups can't collide and the
//  executor can route calls back to the owning server.
//
//  Filtering: the Agents page binds skills/mcpTools per agent; the
//  frontend passes those names down as `allowedTools` — matching
//  either a server name (whole server) or a specific tool name.
// ================================================================

import {
  getMcpManager,
  type McpClientManager,
  type McpServerConfig,
  type McpToolInfo,
} from './mcpClient.js'
import type {
  ChatMessage,
  ChatOptions,
  LLMClient,
  ToolCall,
  ToolDefinition,
} from '../services/llm.js'

export const MAX_TOOL_ROUNDS = 5

export interface ToolExecutor {
  /** OpenAI function-calling schemas for every registered tool. */
  tools: ToolDefinition[]
  /** Executes a namespaced tool call; never throws (errors become result text). */
  execute(name: string, args: Record<string, unknown>): Promise<string>
}

const NAME_SEP = '__'

/** `${server}__${tool}` with unsafe chars normalized for function-calling names. */
export function namespacedToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `${clean(server)}${NAME_SEP}${clean(tool)}`
}

/**
 * Filters MCP tools by the agent's configured names: a filter entry
 * matches a whole server, a bare tool name, or a namespaced name.
 * Empty/absent filter → everything is allowed.
 */
export function filterTools(tools: McpToolInfo[], allowedTools?: string[] | null): McpToolInfo[] {
  if (!allowedTools || allowedTools.length === 0) return tools
  const allowed = new Set(allowedTools)
  return tools.filter(
    (t) => allowed.has(t.server) || allowed.has(t.name) || allowed.has(namespacedToolName(t.server, t.name))
  )
}

/**
 * Connects the given servers (failure-isolated) and builds a ToolExecutor
 * over the surviving tools. Returns null when nothing is usable — callers
 * treat that as "no tools" and skip the tool-calling loop entirely.
 */
export async function buildToolset(opts: {
  servers: McpServerConfig[]
  allowedTools?: string[] | null
  manager?: McpClientManager
}): Promise<ToolExecutor | null> {
  const manager = opts.manager ?? getMcpManager()
  if (!opts.servers || opts.servers.length === 0) return null
  await manager.connectAll(opts.servers)

  const serverNames = new Set(opts.servers.map((s) => s.name))
  const available = manager.listTools().filter((t) => serverNames.has(t.server))
  const selected = filterTools(available, opts.allowedTools)
  if (selected.length === 0) return null

  const byName = new Map<string, McpToolInfo>()
  for (const t of selected) byName.set(namespacedToolName(t.server, t.name), t)

  return {
    tools: [...byName.entries()].map(([name, t]) => ({
      type: 'function',
      function: {
        name,
        description: t.description ? `[${t.server}] ${t.description}` : `MCP tool ${t.name} (server: ${t.server})`,
        parameters: t.inputSchema ?? { type: 'object', properties: {} },
      },
    })),
    async execute(name, args) {
      const info = byName.get(name)
      if (!info) return `错误：未注册的工具 "${name}"`
      try {
        const result = await manager.callTool(info.server, info.name, args)
        return result.isError ? `工具执行报错：${result.text}` : result.text
      } catch (e) {
        // tool failures are surfaced to the model as text, not thrown —
        // the LLM can retry, pick another tool, or answer without it
        return `工具调用失败：${e instanceof Error ? e.message : String(e)}`
      }
    },
  }
}

// ─── Tool-calling loop ──────────────────────────────────────────

export interface ToolLoopEvent {
  round: number
  tool: string
  arguments: Record<string, unknown>
  result: string
}

/**
 * LLM generation with a bounded tool-calling loop:
 *   LLM → tool_calls → execute via MCP → feed results back → repeat.
 * Capped at MAX_TOOL_ROUNDS; the final round withdraws the tools so the
 * model must answer. Falls back to plain chatStream when the client has
 * no chatTools or there is no toolset.
 */
export async function generateWithTools(
  llm: LLMClient,
  messages: ChatMessage[],
  toolset: ToolExecutor | null,
  options: ChatOptions = {},
  onToolEvent?: (event: ToolLoopEvent) => void
): Promise<string> {
  if (!toolset || toolset.tools.length === 0 || typeof llm.chatTools !== 'function') {
    return llm.chatStream(messages, options)
  }

  const history: ChatMessage[] = [...messages]
  for (let round = 1; round <= MAX_TOOL_ROUNDS; round += 1) {
    const withdrawTools = round === MAX_TOOL_ROUNDS
    const turn = await llm.chatTools(history, {
      ...options,
      tools: withdrawTools ? undefined : toolset.tools,
      meta: { ...options.meta, toolRound: round },
    })

    if (turn.toolCalls.length === 0) return turn.content

    history.push({ role: 'assistant', content: turn.content ?? '', tool_calls: turn.toolCalls })
    for (const call of turn.toolCalls) {
      const args = parseToolArguments(call)
      const result = await toolset.execute(call.function.name, args)
      onToolEvent?.({ round, tool: call.function.name, arguments: args, result })
      history.push({ role: 'tool', tool_call_id: call.id, content: result })
    }
  }

  // unreachable in practice (last round has no tools), kept as a hard stop
  return llm.chatStream(history, options)
}

function parseToolArguments(call: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments || '{}')
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

// ─── JSON-RPC method handlers (registered by index.ts) ──────────

export const toolsMethods = {
  /**
   * { servers?: McpServerConfig[] } → { servers: McpServerStatus[], tools: McpToolInfo[] }
   * With configs: connects them (failure-isolated) and reports status.
   * Without: reports the current connection pool.
   */
  'tools.list_servers': async (params: any) => {
    const manager = getMcpManager()
    const configs: McpServerConfig[] = params?.servers ?? []
    const servers = configs.length > 0 ? await manager.connectAll(configs) : manager.status()
    return { servers, tools: manager.listTools() }
  },

  /** { server: McpServerConfig } → { ok, tools?, error? } — throwaway connection. */
  'tools.connect_test': async (params: any) => {
    const config: McpServerConfig = params?.server
    if (!config?.name) throw new Error('server config with name is required')
    const manager = getMcpManager()
    const alreadyConnected = manager.status([config])[0]?.status === 'connected'
    try {
      const tools = await manager.connect(config)
      return { ok: true, tools: tools.map((t) => ({ name: t.name, description: t.description })) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      // probe connections don't linger — keep only pre-existing ones
      if (!alreadyConnected) await manager.disconnect(config.name)
    }
  },

  /** { server: name|config, tool, arguments? } → { text, isError } — manual debug call. */
  'tools.call': async (params: any) => {
    const { tool } = params ?? {}
    if (!tool) throw new Error('tool is required')
    const manager = getMcpManager()
    let serverName: string
    if (typeof params.server === 'string') {
      serverName = params.server
    } else if (params.server?.name) {
      await manager.connect(params.server)
      serverName = params.server.name
    } else {
      throw new Error('server (name or config) is required')
    }
    const result = await manager.callTool(serverName, tool, params.arguments ?? {})
    return { text: result.text, isError: result.isError }
  },
}
