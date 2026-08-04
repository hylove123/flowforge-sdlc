// ================================================================
//  Builtin Tools — 内置代码智能工具（harness agent 自主能力主路径）
//
//  交付流 stageNode 生成阶段可用的 function-calling 工具，直接
//  进程内调用现有模块，零外部依赖（不走 MCP stdio 进程）：
//    builtin__code_search      引擎 A BM25 代码索引检索
//    builtin__graph_search     引擎 B（codebase-memory-mcp）结构搜索
//    builtin__graph_trace      引擎 B 调用链追踪（影响面评估）
//    builtin__knowledge_recall 项目知识库召回（知识资产 + 上游交付物）
//
//  与 MCP 工具的关系：内置工具是主路径（会话级总是可用），
//  MCP 工具是扩展；两者经 mergeToolsets 合并进同一个 ToolExecutor。
//  失败以文本形式返回给模型（与 MCP 工具一致），不抛出。
// ================================================================

import { codeSearch } from '../knowledge/codeSearch.js'
import { knowledgeMethods } from '../knowledge/knowledgeService.js'
import { getGraphEngine, resolveProjectName } from '../graph/graphEngine.js'
import type { ToolExecutor } from './toolRegistry.js'

export interface BuiltinToolContext {
  projectId: string
  /** 交付绑定的仓库路径 — 缺失时 code/graph 工具返回明确错误文本 */
  repoPath?: string | null
}

const NS = 'builtin'

function failNoRepo(): string {
  return '错误：当前交付未绑定仓库路径，代码检索不可用。请先在项目配置中关联本地仓库。'
}

/** 引擎 B search_code 结果 → 可读行 */
function searchHitsToText(res: unknown): string {
  if (typeof res === 'string') return res.slice(0, 4000)
  const obj = res as any
  const items: any[] = obj?.results ?? obj?.matches ?? obj?.hits ?? (Array.isArray(res) ? res : [])
  if (!Array.isArray(items) || items.length === 0) return '代码图谱无匹配结果'
  return items.slice(0, 10).map((it) => {
    const loc = it?.file ?? it?.path ?? it?.location ?? ''
    const name = it?.name ?? it?.symbol ?? ''
    const snippet = typeof it?.snippet === 'string' ? it.snippet.slice(0, 160).replace(/\n/g, ' ') : ''
    return `- ${loc}${name ? ` ${name}` : ''}${snippet ? ` — ${snippet}` : ''}`
  }).join('\n')
}

/**
 * Builds the session-scoped builtin toolset. Never returns null —
 * knowledge_recall is always usable; code/graph tools surface clear
 * error text when no repo is bound (the model can adapt).
 */
export function buildBuiltinToolset(ctx: BuiltinToolContext): ToolExecutor {
  const tools: ToolExecutor['tools'] = [
    {
      type: 'function',
      function: {
        name: `${NS}__code_search`,
        description: '在当前仓库已建立的代码索引（BM25）中检索符号/函数/关键词，返回文件位置与签名',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '检索关键词，如函数名、类名或业务词' },
            topK: { type: 'number', description: '返回条数，默认 5' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: `${NS}__graph_search`,
        description: '代码图谱结构搜索（引擎 B codebase-memory-mcp），比关键词检索更精准，返回相关模块/符号',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: '结构搜索模式或自然语言意图' },
          },
          required: ['pattern'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: `${NS}__graph_trace`,
        description: '追踪指定函数的调用链（上下游双向、深度 2），评估改动影响面',
        parameters: {
          type: 'object',
          properties: {
            function_name: { type: 'string', description: '函数/方法名' },
          },
          required: ['function_name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: `${NS}__knowledge_recall`,
        description: '从项目知识库召回与当前交付相关的知识资产、历史反思与上游交付物摘要',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '召回主题/关键词' },
          },
          required: ['query'],
        },
      },
    },
  ]

  return {
    tools,
    async execute(name, args) {
      try {
        switch (name) {
          case `${NS}__code_search`: {
            if (!ctx.repoPath) return failNoRepo()
            const { results } = await codeSearch({
              repoPath: ctx.repoPath,
              query: String(args.query ?? ''),
              topK: typeof args.topK === 'number' ? args.topK : 5,
            })
            if (results.length === 0) return '代码索引无匹配结果'
            return results.map((r) =>
              `- ${r.file}:${r.startLine} ${r.kind} **${r.name}**${r.signature ? `：\`${r.signature.slice(0, 100)}\`` : ''}`
            ).join('\n')
          }
          case `${NS}__graph_search`: {
            if (!ctx.repoPath) return failNoRepo()
            const project = await resolveProjectName(undefined, ctx.repoPath)
            if (!project) return '错误：无法解析图谱项目名，请先在项目配置中完成代码索引'
            const res = await getGraphEngine().call('search_code', {
              project,
              pattern: String(args.pattern ?? ''),
              mode: 'compact',
              limit: 8,
            })
            return searchHitsToText(res)
          }
          case `${NS}__graph_trace`: {
            if (!ctx.repoPath) return failNoRepo()
            const project = await resolveProjectName(undefined, ctx.repoPath)
            if (!project) return '错误：无法解析图谱项目名，请先在项目配置中完成代码索引'
            const res = await getGraphEngine().call('trace_path', {
              project,
              function_name: String(args.function_name ?? ''),
              direction: 'both',
              depth: 2,
              mode: 'calls',
            })
            if (!res) return '未找到该函数的调用链'
            if (typeof res === 'string') return res.slice(0, 3000)
            const obj = res as any
            const chain = obj.path ?? obj.calls ?? obj.chain ?? obj.nodes
            if (Array.isArray(chain) && chain.length > 0) {
              const names = chain.map((n: any) => (typeof n === 'string' ? n : n?.name ?? n?.function ?? n?.label ?? '?'))
              return `调用链：${names.join(' → ')}`
            }
            return JSON.stringify(res).slice(0, 3000)
          }
          case `${NS}__knowledge_recall`: {
            const res = await knowledgeMethods['knowledge.recall']({
              projectId: ctx.projectId,
              query: args.query ? String(args.query) : undefined,
            })
            return JSON.stringify(res ?? null).slice(0, 3000)
          }
          default:
            return `错误：未注册的内置工具 "${name}"`
        }
      } catch (e) {
        // 工具失败以文本返回给模型（可重试/换工具/跳过），与 MCP 工具一致
        return `工具调用失败：${e instanceof Error ? e.message : String(e)}`
      }
    },
  }
}

/**
 * Merges builtin + MCP toolsets into one executor. Builtin first so
 * the model sees them at the top of the tool list. Returns null only
 * when every input is null/empty.
 */
export function mergeToolsets(...sets: Array<ToolExecutor | null | undefined>): ToolExecutor | null {
  const live = sets.filter((s): s is ToolExecutor => Boolean(s && s.tools.length > 0))
  if (live.length === 0) return null
  if (live.length === 1) return live[0]
  const tools = live.flatMap((s) => s.tools)
  return {
    tools,
    async execute(name, args) {
      for (const s of live) {
        if (s.tools.some((t) => t.function.name === name)) return s.execute(name, args)
      }
      return `错误：未注册的工具 "${name}"`
    },
  }
}
