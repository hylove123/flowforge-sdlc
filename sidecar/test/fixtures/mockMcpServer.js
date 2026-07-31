// Minimal stdio MCP server used by the Phase 4 checks.
// Implements initialize / tools/list / tools/call via the official SDK
// (same @modelcontextprotocol/sdk version the client manager uses).
//
// Tools:
//   echo   { text }        → "echo: <text>"
//   add    { a, b }        → "<a+b>"
//   boom   {}              → isError result (tool-level failure path)

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  { name: 'mock-mcp', version: '0.0.1' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echoes the given text back',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    {
      name: 'add',
      description: 'Adds two numbers',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
    },
    {
      name: 'boom',
      description: 'Always fails (error-path fixture)',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params
  if (name === 'echo') return { content: [{ type: 'text', text: `echo: ${args.text}` }] }
  if (name === 'add') return { content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }] }
  if (name === 'boom') return { content: [{ type: 'text', text: 'kaboom' }], isError: true }
  return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true }
})

await server.connect(new StdioServerTransport())
