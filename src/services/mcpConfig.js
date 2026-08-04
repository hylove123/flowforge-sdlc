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
      : { name: item?.name || '', type: item?.type || 'link', url: item?.url || '', description: item?.description || '', env: item?.env }
  )
}

/** Single mcpTools item → sidecar McpServerConfig (null when incomplete). */
export function toMcpServerConfig(item) {
  const name = (item?.name || '').trim()
  const spec = (item?.url || '').trim()
  if (!name || !spec) return null
  if (/^https?:\/\//i.test(spec)) return { name, url: spec }
  const [command, ...args] = spec.split(/\s+/)
  const env = item?.env && typeof item.env === 'object' && !Array.isArray(item.env) ? item.env : undefined
  return env ? { name, command, args, env } : { name, command, args }
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

// ─── Standard mcpServers JSON mode (Settings → MCP工具) ──────
//
// Accepts either `{ "mcpServers": { name: spec } }` or a bare `{ name: spec }`,
// where spec is `{ command, args?, env? }` (stdio) or `{ url }` (http/sse).
// Parsed entries reuse the mcpTools item shape so toMcpServerConfig and the
// sidecar execution chain stay untouched.

function extractJsonErrorLine(text, err) {
  const m = /position (\d+)/.exec(err?.message || '')
  if (m) {
    const pos = Math.min(Number(m[1]), text.length)
    return text.slice(0, pos).split('\n').length
  }
  return 1
}

function findKeyLine(lines, key) {
  const pattern = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`)
  const idx = lines.findIndex(l => pattern.test(l))
  return idx >= 0 ? idx + 1 : 1
}

/**
 * Parse standard mcpServers JSON text.
 * @returns {{ entries: Array, errors: Array<{ line: number, message: string }> }}
 */
export function parseMcpServersJson(text) {
  const errors = []
  const entries = []
  if (!text || !text.trim()) {
    return { entries, errors: [{ line: 1, message: '内容为空，请粘贴 mcpServers 格式 JSON' }] }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { entries, errors: [{ line: extractJsonErrorLine(text, e), message: `JSON 解析失败：${e.message}` }] }
  }
  const servers = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.mcpServers
    ? parsed.mcpServers
    : parsed
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    return { entries, errors: [{ line: 1, message: '根节点需要是 mcpServers 对象：{ "mcpServers": { name: { command, args } | { url } } }' }] }
  }
  const lines = text.split('\n')
  for (const [name, spec] of Object.entries(servers)) {
    const line = findKeyLine(lines, name)
    if (!name.trim()) {
      errors.push({ line, message: '服务名称不能为空' })
      continue
    }
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      errors.push({ line, message: `「${name}」配置项需要是对象` })
      continue
    }
    if (typeof spec.url === 'string' && spec.url.trim()) {
      if (!/^https?:\/\//i.test(spec.url.trim())) {
        errors.push({ line, message: `「${name}」url 需要以 http:// 或 https:// 开头` })
        continue
      }
      entries.push({ name: name.trim(), type: 'http', url: spec.url.trim(), description: spec.description || '', enabled: true })
    } else if (typeof spec.command === 'string' && spec.command.trim()) {
      if (spec.args != null && !Array.isArray(spec.args)) {
        errors.push({ line, message: `「${name}」args 需要是字符串数组` })
        continue
      }
      if (spec.env != null && (typeof spec.env !== 'object' || Array.isArray(spec.env))) {
        errors.push({ line, message: `「${name}」env 需要是对象` })
        continue
      }
      const args = (spec.args || []).map(String)
      entries.push({
        name: name.trim(), type: 'stdio',
        url: [spec.command.trim(), ...args].join(' '),
        env: spec.env, description: spec.description || '', enabled: true,
      })
    } else {
      errors.push({ line, message: `「${name}」缺少 command（stdio）或 url（http/sse）配置` })
    }
  }
  return { entries, errors }
}

/** Existing mcpTools entries → standard mcpServers object (for export). */
export function toMcpServersObject(items) {
  const out = {}
  for (const item of normalizeItems(items)) {
    const cfg = toMcpServerConfig(item)
    if (!cfg) continue
    if (cfg.url) {
      out[cfg.name] = { url: cfg.url }
    } else {
      const spec = { command: cfg.command, args: cfg.args || [] }
      if (item.env && Object.keys(item.env).length > 0) spec.env = item.env
      out[cfg.name] = spec
    }
  }
  return out
}

/** Serialize current entries as standard mcpServers JSON text. */
export function exportMcpServersJson(items) {
  return JSON.stringify({ mcpServers: toMcpServersObject(items) }, null, 2)
}
