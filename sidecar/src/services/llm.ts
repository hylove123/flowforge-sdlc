// ================================================================
//  LLM Service — OpenAI-compatible chat completions for the sidecar
//
//  Migrated from src/services/ai.js (streamChat + stage prompts).
//  Differences from the frontend original:
//    - model config is passed in explicitly (never read from localStorage)
//    - fetch is injectable so tests can run with a fake transport
//    - streaming deltas are surfaced through an onDelta callback
// ================================================================

// ─── Types ──────────────────────────────────────────────────────

/** Model configuration — same shape the frontend stores: { id, name, endpoint, apiKey, modelId, enabled } */
export interface ModelConfig {
  id?: string
  name?: string
  endpoint: string
  apiKey: string
  modelId: string
  enabled?: boolean
  /** Per-request timeout override (ms); takes precedence over ResilienceOptions.timeoutMs. */
  timeoutMs?: number
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** assistant messages may carry tool calls (function calling round-trip). */
  tool_calls?: ToolCall[]
  /** tool messages reference the call they answer. */
  tool_call_id?: string
}

/** OpenAI function-calling tool schema (what MCP tools are converted into). */
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

/** A tool invocation requested by the model (arguments as raw JSON string). */
export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** One tool-aware completion turn: text and/or requested tool calls. */
export interface ChatTurnResult {
  content: string
  toolCalls: ToolCall[]
}

export interface ChatOptions {
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  /** Called for each streamed content delta. */
  onDelta?: (delta: string) => void
  /** Function-calling tools offered to the model (chatTools only). */
  tools?: ToolDefinition[]
  /** Opaque call metadata (stage id, call kind) — ignored by real clients, used by test doubles. */
  meta?: Record<string, unknown>
}

/** Abstract LLM client — production uses OpenAICompatibleClient, tests inject fakes. */
export interface LLMClient {
  /** Streams a chat completion; resolves with the full concatenated text. */
  chatStream(messages: ChatMessage[], options?: ChatOptions): Promise<string>
  /**
   * Optional tool-aware turn: passes options.tools to the model and surfaces
   * tool_calls. Clients without this method simply don't support tools
   * (toolRegistry.generateWithTools falls back to plain chatStream).
   */
  chatTools?(messages: ChatMessage[], options?: ChatOptions): Promise<ChatTurnResult>
}

export type FetchLike = typeof fetch

// ─── Structured errors & resilience options ─────────────────────

/** Failure taxonomy surfaced to callers (frontend Toast + retry policy). */
export type LLMErrorCategory = 'timeout' | 'network' | 'http_5xx' | 'http_4xx'

/** Structured LLM failure: category + HTTP status + user-presentable message. */
export class LLMError extends Error {
  readonly category: LLMErrorCategory
  readonly status?: number
  /** timeout / network / http_5xx are retryable; http_4xx (incl. 401/429) never is. */
  readonly retryable: boolean

  constructor(category: LLMErrorCategory, message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = 'LLMError'
    this.category = category
    this.status = opts.status
    this.retryable = category !== 'http_4xx'
  }

  /** Stable JSON shape for RPC error transport (frontend Toast consumes message). */
  toJSON(): { name: string; category: LLMErrorCategory; status?: number; message: string; retryable: boolean } {
    return {
      name: this.name,
      category: this.category,
      status: this.status,
      message: this.message,
      retryable: this.retryable,
    }
  }
}

/** Client-level resilience knobs (modelConfig.timeoutMs wins over timeoutMs here). */
export interface ResilienceOptions {
  /** Per-request budget covering the full streamed response. Default 120 000 ms. */
  timeoutMs?: number
  /** Extra attempts after the first failure. Default 2. */
  maxRetries?: number
  /** First backoff delay; doubles per retry (1s, 2s, …). Default 1000 ms. */
  retryBaseDelayMs?: number
}

export const DEFAULT_TIMEOUT_MS = 120_000
export const DEFAULT_MAX_RETRIES = 2
export const DEFAULT_RETRY_BASE_DELAY_MS = 1_000

// ─── OpenAI-compatible client (SSE streaming) ───────────────────

export class OpenAICompatibleClient implements LLMClient {
  private config: ModelConfig
  private fetchImpl: FetchLike
  private timeoutMs: number
  private maxRetries: number
  private retryBaseDelayMs: number

  constructor(config: ModelConfig, fetchImpl: FetchLike = fetch, resilience: ResilienceOptions = {}) {
    if (!config || !config.endpoint) throw new Error('模型配置缺少 endpoint')
    if (!config.apiKey) throw new Error('模型配置缺少 apiKey')
    if (!config.modelId) throw new Error('模型配置缺少 modelId')
    this.config = config
    this.fetchImpl = fetchImpl
    this.timeoutMs = config.timeoutMs ?? resilience.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxRetries = resilience.maxRetries ?? DEFAULT_MAX_RETRIES
    this.retryBaseDelayMs = resilience.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('timeoutMs 必须为正数')
    if (this.maxRetries < 0) throw new Error('maxRetries 不能为负数')
  }

  async chatStream(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const turn = await this.streamTurn(messages, options, /* withTools */ false)
    return turn.content
  }

  /** Tool-aware turn: sends options.tools and accumulates streamed tool_calls deltas. */
  async chatTools(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatTurnResult> {
    return this.streamTurn(messages, options, /* withTools */ true)
  }

  /** Retry loop: retryable failures (timeout/network/5xx) back off exponentially, up to maxRetries. */
  private async streamTurn(
    messages: ChatMessage[],
    options: ChatOptions,
    withTools: boolean
  ): Promise<ChatTurnResult> {
    const maxAttempts = this.maxRetries + 1
    for (let attempt = 1; ; attempt++) {
      const delivered = { value: false }
      try {
        return await this.attemptStreamTurn(messages, options, withTools, delivered)
      } catch (err) {
        const retryable = err instanceof LLMError && err.retryable
        // never retry once content already streamed out — the consumer would see duplicated deltas
        if (!retryable || delivered.value || attempt >= maxAttempts) throw err
        await this.backoff(attempt, options.signal)
      }
    }
  }

  /** Abort-aware exponential backoff: base × 2^(attempt-1); external abort cancels the wait. */
  private backoff(attempt: number, signal?: AbortSignal): Promise<void> {
    const ms = this.retryBaseDelayMs * 2 ** (attempt - 1)
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error('请求已取消'))
      const onAbort = () => {
        clearTimeout(timer)
        reject(signal?.reason ?? new Error('请求已取消'))
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private async attemptStreamTurn(
    messages: ChatMessage[],
    options: ChatOptions,
    withTools: boolean,
    delivered: { value: boolean }
  ): Promise<ChatTurnResult> {
    const { endpoint, apiKey, modelId } = this.config
    const body: Record<string, unknown> = {
      model: modelId,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4096,
      stream: true,
    }
    if (withTools && options.tools && options.tools.length > 0) body.tools = options.tools

    // merge external signal with the per-attempt timeout: either one aborts the request
    const attemptCtl = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; attemptCtl.abort() }, this.timeoutMs)
    const onExternalAbort = () => attemptCtl.abort(options.signal?.reason)
    if (options.signal) {
      if (options.signal.aborted) {
        clearTimeout(timer)
        throw options.signal.reason ?? new Error('请求已取消')
      }
      options.signal.addEventListener('abort', onExternalAbort, { once: true })
    }

    try {
      const response = await this.fetchImpl(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: attemptCtl.signal,
      })

      if (!response.ok) {
        const errText = await response.text()
        let errMsg = `API 请求失败 (${response.status})`
        try {
          const errJson = JSON.parse(errText)
          errMsg = errJson.error?.message || errMsg
        } catch { /* use default */ }
        throw new LLMError(response.status >= 500 ? 'http_5xx' : 'http_4xx', errMsg, {
          status: response.status,
        })
      }

      if (!response.body) throw new LLMError('network', 'API 响应缺少 body')

      // SSE parsing — same protocol handling as ai.js streamChat, plus
      // index-keyed accumulation of streamed tool_calls fragments
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let full = ''
      const calls = new Map<number, ToolCall>()

      const finish = (): ChatTurnResult => ({
        content: full,
        toolCalls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c),
      })

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue
          const data = trimmed.slice(6)
          if (data === '[DONE]') return finish()

          try {
            const parsed = JSON.parse(data)
            const delta = parsed.choices?.[0]?.delta
            if (delta?.content) {
              delivered.value = true
              full += delta.content
              options.onDelta?.(delta.content)
            }
            for (const tc of delta?.tool_calls ?? []) {
              delivered.value = true
              const idx = tc.index ?? 0
              const cur = calls.get(idx) ?? {
                id: '',
                type: 'function' as const,
                function: { name: '', arguments: '' },
              }
              if (tc.id) cur.id = tc.id
              if (tc.function?.name) cur.function.name += tc.function.name
              if (tc.function?.arguments) cur.function.arguments += tc.function.arguments
              calls.set(idx, cur)
            }
          } catch { /* skip malformed chunk */ }
        }
      }
      return finish()
    } catch (err) {
      throw this.classifyFailure(err, options.signal, timedOut)
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onExternalAbort)
    }
  }

  /** Maps transport failures onto the LLMError taxonomy; external cancellation passes through untouched. */
  private classifyFailure(err: unknown, externalSignal: AbortSignal | undefined, timedOut: boolean): unknown {
    if (err instanceof LLMError) return err
    if (externalSignal?.aborted && !timedOut) return err // user cancel — keep original AbortError semantics
    if (timedOut) {
      return new LLMError('timeout', `LLM 请求超时（超过 ${this.timeoutMs}ms 未完成）`, { cause: err })
    }
    const detail = err instanceof Error ? err.message : String(err)
    return new LLMError('network', `网络请求失败：${detail}`, { cause: err })
  }
}

// ─── Stage system prompts (migrated from ai.js) ─────────────────

export const STAGE_SYSTEM_PROMPTS: Record<string, string> = {
  chat: `你是 FlowForge AI 助手，一个专业的软件开发生命周期管理助手。你需要：
1. 帮助用户完成需求分析、文档编写、技术方案设计、代码审查、测试等各阶段工作
2. 回答专业、结构清晰，使用 markdown 格式
3. 如果用户提到具体阶段，提供针对该阶段的专业建议
4. 保持友好但专业的语调`,

  'req': `你是一位资深产品经理和需求分析师。请帮助分析用户需求：
- 梳理用户场景和核心痛点
- 定义功能边界和MVP范围
- 输出结构化的需求规格说明
- 使用 markdown 格式，包含标题、列表、表格等`,

  'brd': `你是一位资深商业分析师。请帮助编写业务需求文档(BRD)：
- 明确商业目标和成功指标
- 分析市场机会和竞品
- 定义项目范围和约束条件
- 评估投资回报
- 使用 markdown 格式，专业详尽`,

  'prd': `你是一位资深产品经理。请帮助编写产品需求文档(PRD)：
- 详细定义每个功能的交互逻辑
- 编写用户故事(格式: 作为...我希望...以便...)
- 定义验收标准(可量化、可测试)
- 说明非功能性需求
- 使用 markdown 格式，结构清晰`,

  'test': `你是一位资深测试工程师。请帮助生成测试用例：
- 覆盖正常流程、异常流程、边界场景
- 使用 Given-When-Then 格式
- 标注优先级(P0/P1/P2)
- 包含测试数据准备说明
- 使用 markdown 表格格式`,

  'dev-plan': `你是一位资深架构师。请帮助编写技术方案文档(TS)：
- 评估并推荐技术架构
- 设计数据库表结构
- 定义 API 接口规范(RESTful)
- 分析技术风险和依赖
- 包含架构图和部署方案
- 使用 markdown 格式`,

  'dev': `你是一位资深全栈工程师。请帮助编码实现：
- 基于已有的技术方案编写代码
- 遵循编码规范和最佳实践
- 考虑性能、安全、可维护性
- 提供必要的注释
- 使用 markdown 代码块格式`,

  'review': `你是一位资深代码审查专家。请帮助审查代码质量：
- 检查代码规范和风格
- 发现潜在的 bug 和性能问题
- 评估安全性和可维护性
- 提供具体的改进建议
- 使用 markdown 格式，包含代码示例`,

  'auto-test': `你是一位资深测试自动化工程师。请帮助编写自动化测试：
- 基于已有代码编写单元测试
- 覆盖核心逻辑和边界场景
- 使用流行的测试框架(Jest/Vitest)
- 提供测试运行说明
- 使用 markdown 代码块格式`,

  'deploy': `你是一位资深 DevOps 工程师。请帮助完成部署交付：
- 编写部署检查清单
- 配置 CI/CD 流程
- 制定监控告警方案
- 准备回滚方案
- 使用 markdown 格式`,
}

// ─── Deliverable generation prompts (migrated from ai.js) ───────

export const GENERATION_PROMPTS: Record<string, string> = {
  'req': '请为以下项目生成需求规格说明书，包含：用户场景分析、功能范围定义、优先级排序、业务流程图说明。\n\n项目：{project}\n需求：{requirement}',
  'brd': '请为以下项目生成BRD(业务需求文档)，包含：商业目标、市场分析、目标用户画像、核心功能列表、成功指标(KPI)、风险评估、项目时间线。\n\n项目：{project}\n需求：{requirement}\n前置内容(需求规格)：{previousContent}',
  'prd': '请为以下项目生成PRD(产品需求文档)，包含：功能详细描述、用户故事、交互流程、验收标准、非功能性需求。\n\n项目：{project}\n需求：{requirement}\n前置内容(BRD)：{previousContent}',
  'test': '请根据以下PRD内容生成测试用例，包含：功能测试、边界测试、异常测试。每个用例使用Given-When-Then格式，标注优先级(P0/P1/P2)。\n\n项目：{project}\n需求：{requirement}\nPRD内容：{previousContent}',
  'dev-plan': '请根据以下PRD内容生成技术方案文档(TS)，包含：架构设计、技术选型、数据库设计、API接口定义、技术风险评估。\n\n项目：{project}\n需求：{requirement}\nPRD内容：{previousContent}',
}

/** AI review scoring prompt — mirrors ai.js STAGE_SYSTEM_PROMPTS.review (the scoring variant). */
export const REVIEW_SYSTEM_PROMPT = `你是一位资深的软件质量评审专家。请对以下交付物进行AI评审，从以下维度评分(0-100分)：
1. **完整性** — 内容是否覆盖所有必要方面
2. **一致性** — 前后逻辑是否一致
3. **可行性** — 方案是否技术可行
4. **规范性** — 是否遵循行业规范

输出格式(JSON)：
{
  "totalScore": 85,
  "dimensions": {
    "completeness": {"score": 90, "comment": "..."},
    "consistency": {"score": 85, "comment": "..."},
    "feasibility": {"score": 82, "comment": "..."},
    "standardization": {"score": 83, "comment": "..."}
  },
  "suggestions": ["改进建议1", "改进建议2"],
  "passed": true
}`

// ─── Message builders ───────────────────────────────────────────

export interface GenerationContext {
  projectName: string
  requirement: string
  previousContent?: string
  /** Extra context block (upstream deliverables etc.), appended to the user prompt. */
  contextBlock?: string
}

export function buildGenerationMessages(stageId: string, ctx: GenerationContext): ChatMessage[] {
  const systemPrompt = STAGE_SYSTEM_PROMPTS[stageId] || STAGE_SYSTEM_PROMPTS.chat
  const template = GENERATION_PROMPTS[stageId]
    || `请为项目"{project}"生成阶段"${stageId}"的交付物。需求：{requirement}\n前置内容：{previousContent}`
  let userPrompt = template
    .replace('{project}', ctx.projectName)
    .replace('{requirement}', ctx.requirement)
    .replace('{previousContent}', ctx.previousContent ?? '')

  if (ctx.contextBlock) {
    userPrompt += `\n\n【上游交付物上下文】\n以下是之前阶段的已产出交付物，请确保生成的内容与它们保持一致性，并建立追溯关系：\n\n${ctx.contextBlock}`
  }

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]
}

// ─── AI review ──────────────────────────────────────────────────

export interface ReviewResult {
  totalScore: number
  dimensions: Record<string, unknown>
  suggestions: string[]
  passed: boolean
}

/** Parses the JSON scoring payload out of a review completion — same fallbacks as ai.js aiReview. */
export function parseReviewResult(result: string): ReviewResult {
  try {
    const jsonMatch = result.match(/```json\s*([\s\S]*?)\s*```/) || result.match(/(\{[\s\S]*\})/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0])
      return {
        totalScore: parsed.totalScore || 0,
        dimensions: parsed.dimensions || {},
        suggestions: parsed.suggestions || [],
        passed: parsed.passed ?? (parsed.totalScore >= 75),
      }
    }
  } catch { /* fall through */ }

  return { totalScore: 0, dimensions: {}, suggestions: [result], passed: false }
}

export async function reviewDeliverable(
  client: LLMClient,
  stageName: string,
  deliverableContent: string,
  options: ChatOptions = {}
): Promise<ReviewResult> {
  const raw = await client.chatStream(
    [
      { role: 'system', content: REVIEW_SYSTEM_PROMPT },
      { role: 'user', content: `请评审以下「${stageName}」阶段的交付物：\n\n${deliverableContent}` },
    ],
    { temperature: 0.3, maxTokens: 2048, ...options, meta: { ...options.meta, kind: 'review' } }
  )
  return parseReviewResult(raw)
}
