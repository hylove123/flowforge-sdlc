import { describe, it, expect } from 'vitest'
import {
  toMcpServerConfig,
  parseMcpServersJson,
  toMcpServersObject,
  exportMcpServersJson,
} from '@/services/mcpConfig'

describe('mcpConfig — toMcpServerConfig', () => {
  it('maps stdio command line string to { command, args }', () => {
    const cfg = toMcpServerConfig({ name: 'srv', url: 'npx -y my-mcp --flag' })
    expect(cfg).toEqual({ name: 'srv', command: 'npx', args: ['-y', 'my-mcp', '--flag'] })
  })

  it('passes env through for stdio servers', () => {
    const cfg = toMcpServerConfig({ name: 'srv', url: 'node server.js', env: { KEY: 'v' } })
    expect(cfg).toEqual({ name: 'srv', command: 'node', args: ['server.js'], env: { KEY: 'v' } })
  })

  it('keeps http url servers as-is (no env)', () => {
    const cfg = toMcpServerConfig({ name: 'srv', url: 'https://example.com/mcp', env: { A: '1' } })
    expect(cfg).toEqual({ name: 'srv', url: 'https://example.com/mcp' })
  })
})

describe('mcpConfig — parseMcpServersJson', () => {
  it('parses standard mcpServers payload with stdio + http entries', () => {
    const text = JSON.stringify({
      mcpServers: {
        fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], env: { DEBUG: '1' } },
        remote: { url: 'https://mcp.example.com/sse' },
      },
    })
    const { entries, errors } = parseMcpServersJson(text)
    expect(errors).toEqual([])
    expect(entries).toHaveLength(2)
    const fs = entries.find(e => e.name === 'fs')
    expect(fs.type).toBe('stdio')
    expect(fs.url).toBe('npx -y @modelcontextprotocol/server-filesystem /tmp')
    expect(fs.env).toEqual({ DEBUG: '1' })
    const remote = entries.find(e => e.name === 'remote')
    expect(remote.type).toBe('http')
    expect(remote.url).toBe('https://mcp.example.com/sse')
  })

  it('accepts a bare servers object without mcpServers wrapper', () => {
    const { entries, errors } = parseMcpServersJson('{"a": {"command": "node", "args": ["x.js"]}}')
    expect(errors).toEqual([])
    expect(entries[0].url).toBe('node x.js')
  })

  it('reports line number for invalid server specs', () => {
    const text = '{\n  "mcpServers": {\n    "bad": { "nothing": true },\n    "badUrl": { "url": "ftp://x" }\n  }\n}'
    const { entries, errors } = parseMcpServersJson(text)
    expect(entries).toEqual([])
    expect(errors).toHaveLength(2)
    expect(errors[0].line).toBe(3)
    expect(errors[0].message).toContain('bad')
    expect(errors[1].line).toBe(4)
    expect(errors[1].message).toContain('http')
  })

  it('reports JSON syntax errors with line info', () => {
    const { entries, errors } = parseMcpServersJson('{\n  "mcpServers": {\n}')
    expect(entries).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('JSON 解析失败')
  })

  it('rejects empty text and non-object roots', () => {
    expect(parseMcpServersJson('').errors).toHaveLength(1)
    expect(parseMcpServersJson('[1,2]').errors).toHaveLength(1)
  })
})

describe('mcpConfig — export round-trip', () => {
  it('exports entries back to standard mcpServers JSON', () => {
    const items = [
      { name: 'fs', type: 'stdio', url: 'npx -y fs-server', env: { A: '1' }, enabled: true },
      { name: 'remote', type: 'http', url: 'https://mcp.example.com', enabled: true },
      { name: 'incomplete', type: 'link', url: '', enabled: true },
    ]
    const obj = toMcpServersObject(items)
    expect(obj.fs).toEqual({ command: 'npx', args: ['-y', 'fs-server'], env: { A: '1' } })
    expect(obj.remote).toEqual({ url: 'https://mcp.example.com' })
    expect(obj.incomplete).toBeUndefined()
    // round-trip: exported JSON parses back to equivalent entries
    const { entries, errors } = parseMcpServersJson(exportMcpServersJson(items))
    expect(errors).toEqual([])
    expect(entries.map(e => e.name).sort()).toEqual(['fs', 'remote'])
  })
})
