/**
 * mcpConfig — turns Agents-page skills/mcpTools annotations into real
 * MCP server configs for the sidecar (Phase 4).
 *
 * An mcpTools item ({ name, type, url }) maps to:
 *   - url starting with http(s)://  → { name, url }            (SSE / Streamable HTTP)
 *   - anything else                 → { name, command, args }  (stdio command line)
 */

function normalizeItems(arr) {
  if (!Array.isArray(arr)) return []
  return arr.map(item =>
    typeof item === 'string'
      ? { name: item, type: 'link', url: '', description: '' }
      : { name: item?.name || '', type: item?.type || 'link', url: item?.url || '', description: item?.description || '' }
  )
}

/** Single mcpTools item → sidecar McpServerConfig (null when incomplete). */
export function toMcpServerConfig(item) {
  const name = (item?.name || '').trim()
  const spec = (item?.url || '').trim()
  if (!name || !spec) return null
  if (/^https?:\/\//i.test(spec)) return { name, url: spec }
  const [command, ...args] = spec.split(/\s+/)
  return { name, command, args }
}

/** All runnable MCP server configs bound to an agent. */
export function collectAgentMcpServers(agent) {
  return normalizeItems(agent?.mcpTools)
    .map(toMcpServerConfig)
    .filter(Boolean)
}

/** Agent-bound tool filter: MCP server names + skill names. */
export function collectAllowedTools(agent) {
  const names = [
    ...normalizeItems(agent?.mcpTools).map(i => i.name.trim()),
    ...normalizeItems(agent?.skills).map(i => i.name.trim()),
  ]
  return [...new Set(names.filter(Boolean))]
}

/** Finds the agent bound to a stage through the project flow config. */
export function findStageAgent(agents, flowNode) {
  if (!flowNode?.agentId || !Array.isArray(agents)) return null
  return agents.find(a => a.id === flowNode.agentId && a.enabled) || null
}
