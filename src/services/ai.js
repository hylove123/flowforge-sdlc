/**
 * AI Service — Custom model integration
 * Supports any OpenAI-compatible API via custom model configuration
 * Integrated with Ontology Knowledge Graph for context injection
 */

import { storage } from '@/adapters/StorageService'
import { sidecar } from '@/adapters/SidecarBridge'

const CUSTOM_MODELS_KEY = 'flowforge_custom_models'
const ACTIVE_MODEL_KEY = 'flowforge_active_model'

// ─── Custom Model Registry ──────────────────────────────────────
// Model structure: { id, name, endpoint, apiKey, modelId, enabled, createdAt }

export function getCustomModels() {
  return storage.getJSON(CUSTOM_MODELS_KEY, [])
}

export function saveCustomModels(models) {
  storage.setJSON(CUSTOM_MODELS_KEY, models)
}

export function addCustomModel(model) {
  const models = getCustomModels()
  const newModel = {
    id: `model_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    enabled: true,
    ...model,
    endpoint: normalizeEndpoint(model.endpoint),
    createdAt: new Date().toISOString(),
  }
  models.push(newModel)
  saveCustomModels(models)
  return newModel
}

export function updateCustomModel(id, updates) {
  const models = getCustomModels()
  const idx = models.findIndex(m => m.id === id)
  if (idx >= 0) {
    const normalized = updates.endpoint !== undefined
      ? { ...updates, endpoint: normalizeEndpoint(updates.endpoint) }
      : updates
    models[idx] = { ...models[idx], ...normalized }
    saveCustomModels(models)
    return models[idx]
  }
  return null
}

export function deleteCustomModel(id) {
  saveCustomModels(getCustomModels().filter(m => m.id !== id))
  // Clear active model if it was deleted
  const activeId = getActiveModelId()
  if (activeId === id) setActiveModelId(null)
}

export function getCustomModelById(id) {
  return getCustomModels().find(m => m.id === id)
}

// ─── Active Model Selection ─────────────────────────────────────

export function getActiveModelId() {
  return storage.get(ACTIVE_MODEL_KEY) || null
}

export function setActiveModelId(id) {
  if (id) {
    storage.set(ACTIVE_MODEL_KEY, id)
  } else {
    storage.remove(ACTIVE_MODEL_KEY)
  }
}

export function getActiveModel() {
  const id = getActiveModelId()
  if (!id) return null
  return getCustomModelById(id)
}

export function hasAPIKey() {
  return getCustomModels().some(m => m.enabled && m.apiKey && m.apiKey.trim().length > 0)
}

// ─── Resolve model config by name or ID ─────────────────────────

export function resolveModelConfig(modelNameOrId) {
  if (!modelNameOrId || modelNameOrId === '—') return null
  const models = getCustomModels()
  const match = models.find(m =>
    m.name === modelNameOrId || m.id === modelNameOrId || m.modelId === modelNameOrId
  )
  if (match && match.enabled) {
    return {
      endpoint: match.endpoint,
      apiKey: match.apiKey,
      model: match.modelId,
    }
  }
  return null
}

// ─── Model options for dropdowns ───────────────────────

/** 返回所有已启用的自定义模型选项（供下拉列表使用） */
export function getModelOptions() {
  return getCustomModels()
    .filter(m => m.enabled)
    .map(m => ({ value: m.name, label: m.name }))
}

// ─── Test Model Connection ──────────────────────────────────────

/** 去除 endpoint 尾部斜杠，避免拼接出双斜杠 URL */
export function normalizeEndpoint(endpoint) {
  return (endpoint || '').trim().replace(/\/+$/, '')
}

/**
 * 连接测试改走 sidecar（Node 环境无 CORS 预检问题）。
 * 渲染进程直连 fetch 会因 Authorization + JSON 触发预检，
 * 而多数 LLM 端点（如阿里百炼）不返回 CORS 头，导致误报"网络错误"。
 */
export async function testModelConnection(config) {
  const { endpoint, apiKey, modelId } = config
  if (!apiKey) return { success: false, message: '未配置 Token' }
  if (!endpoint) return { success: false, message: '未配置 API 地址' }
  if (!modelId) return { success: false, message: '未配置模型名称' }

  try {
    const result = await sidecar.invoke('llm.connect_test', {
      endpoint: normalizeEndpoint(endpoint),
      apiKey,
      modelId,
    })
    if (result && typeof result.success === 'boolean') {
      return result
    }
    return { success: false, message: 'sidecar 返回结果异常' }
  } catch (err) {
    const detail = err?.message || String(err)
    return { success: false, message: `sidecar 服务不可用：${detail}` }
  }
}

// ─── Core API Call ──────────────────────────────────────────────

async function callLLM(messages, options = {}) {
  // Determine which model to use
  let endpoint, apiKey, model

  if (options.modelOverride) {
    const resolved = resolveModelConfig(options.modelOverride)
    if (resolved) {
      endpoint = resolved.endpoint
      apiKey = resolved.apiKey
      model = resolved.model
    }
  }

  // Fall back to active model
  if (!endpoint) {
    const active = getActiveModel()
    if (active && active.enabled) {
      endpoint = active.endpoint
      apiKey = active.apiKey
      model = active.modelId
    }
  }

  if (!apiKey) {
    throw new Error('请先在「模型管理」中添加并启用一个自定义模型')
  }

  const body = {
    model,
    messages,
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens ?? 4096,
    stream: options.stream ?? false,
  }

  const response = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errText = await response.text()
    let errMsg = `API 请求失败 (${response.status})`
    try {
      const errJson = JSON.parse(errText)
      errMsg = errJson.error?.message || errMsg
    } catch (e) { /* use default */ }
    throw new Error(errMsg)
  }

  if (options.stream) return response

  const data = await response.json()
  return data.choices[0]?.message?.content || ''
}

// ─── Streaming Chat ─────────────────────────────────────────────

export async function* streamChat(messages, options = {}) {
  let endpoint, apiKey, model

  if (options.modelOverride) {
    const resolved = resolveModelConfig(options.modelOverride)
    if (resolved) {
      endpoint = resolved.endpoint
      apiKey = resolved.apiKey
      model = resolved.model
    }
  }

  if (!endpoint) {
    const active = getActiveModel()
    if (active && active.enabled) {
      endpoint = active.endpoint
      apiKey = active.apiKey
      model = active.modelId
    }
  }

  if (!apiKey) {
    yield { error: '请先在「模型管理」中添加并启用一个自定义模型' }
    return
  }

  const body = {
    model,
    messages,
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens ?? 4096,
    stream: true,
  }

  try {
    const response = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errText = await response.text()
      let errMsg = `API 请求失败 (${response.status})`
      try {
        const errJson = JSON.parse(errText)
        errMsg = errJson.error?.message || errMsg
      } catch (e) { /* use default */ }
      yield { error: errMsg }
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

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
        if (data === '[DONE]') return

        try {
          const parsed = JSON.parse(data)
          const content = parsed.choices?.[0]?.delta?.content
          if (content) yield { content }
        } catch (e) { /* skip */ }
      }
    }
  } catch (err) {
    yield { error: `请求失败: ${err.message}` }
  }
}

// ─── System Prompts ─────────────────────────────────────────────

const STAGE_SYSTEM_PROMPTS = {
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

  review: `你是一位资深的软件质量评审专家。请对以下交付物进行AI评审，从以下维度评分(0-100分)：
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
}`,
}

// ─── Chat API ───────────────────────────────────────────────────

export async function chat(userMessage, chatHistory = [], stageId = null) {
  const systemPrompt = STAGE_SYSTEM_PROMPTS[stageId] || STAGE_SYSTEM_PROMPTS.chat
  const messages = [
    { role: 'system', content: systemPrompt },
    ...chatHistory.map(m => ({
      role: m.role === 'ai' ? 'assistant' : 'user',
      content: m.content,
    })),
    { role: 'user', content: userMessage },
  ]
  return callLLM(messages)
}

export function streamStageChat(userMessage, chatHistory = [], stageId = null, modelOverride = null, graphContext = null) {
  const systemPrompt = STAGE_SYSTEM_PROMPTS[stageId] || STAGE_SYSTEM_PROMPTS.chat

  // ─── Ontology context injection ───
  let contextBlock = ''
  if (graphContext && graphContext.context && graphContext.context.length > 0) {
    const contextSections = graphContext.context.map(c => {
      const score = c.qualityScore ? `（质量分: ${c.qualityScore}）` : ''
      return `── ${c.stageLabel}：${c.entityLabel} ${score} ──\n${c.content}`
    })
    contextBlock = `\n\n【本体知识图谱 - 上游交付物上下文】\n以下是你当前阶段之前的已产出交付物，请确保你生成的内容与它们保持一致性和可追溯性：\n\n${contextSections.join('\n\n')}\n\n请在生成内容时主动引用上游交付物的关键信息，保持追溯链完整。`
  }

  const messages = [
    { role: 'system', content: systemPrompt + contextBlock },
    ...chatHistory.map(m => ({
      role: m.role === 'ai' ? 'assistant' : 'user',
      content: m.content,
    })),
    { role: 'user', content: userMessage },
  ]
  return streamChat(messages, modelOverride ? { modelOverride } : {})
}

// ─── Deliverable Generation ─────────────────────────────────────

const GENERATION_PROMPTS = {
  'req': '请为以下项目生成需求规格说明书，包含：用户场景分析、功能范围定义、优先级排序、业务流程图说明。\n\n项目：{project}\n需求：{requirement}',
  'brd': '请为以下项目生成BRD(业务需求文档)，包含：商业目标、市场分析、目标用户画像、核心功能列表、成功指标(KPI)、风险评估、项目时间线。\n\n项目：{project}\n需求：{requirement}\n前置内容(需求规格)：{previousContent}',
  'prd': '请为以下项目生成PRD(产品需求文档)，包含：功能详细描述、用户故事、交互流程、验收标准、非功能性需求。\n\n项目：{project}\n需求：{requirement}\n前置内容(BRD)：{previousContent}',
  'test': '请根据以下PRD内容生成测试用例，包含：功能测试、边界测试、异常测试。每个用例使用Given-When-Then格式，标注优先级(P0/P1/P2)。\n\n项目：{project}\n需求：{requirement}\nPRD内容：{previousContent}',
  'dev-plan': '请根据以下PRD内容生成技术方案文档(TS)，包含：架构设计、技术选型、数据库设计、API接口定义、技术风险评估。\n\n项目：{project}\n需求：{requirement}\nPRD内容：{previousContent}',
  'prototype': '请根据以下PRD内容生成一个单文件 HTML 交互原型（线框图风格）。要求：\n1. 输出完整的单个 HTML 文件，所有 CSS 内联在 <style> 中，不依赖任何外部资源；\n2. 线框风格：灰白色调、简洁边框、清晰的信息层级，顶部标注原型标题；\n3. 按 PRD 描述的页面结构组织多个页面，用顶部 tab 切换（纯内联 JS 实现）；\n4. 覆盖 PRD 中的核心页面与关键交互流程，交互控件用占位元素表达；\n5. 只输出 HTML 代码本身，不要任何解释文字。\n\n项目：{project}\n需求：{requirement}\nPRD内容：{previousContent}',
}

export async function generateDeliverable(stageId, projectName, requirement, previousContent = '', modelOverride = null, graphContext = null, userInstructions = null, chatHistory = null) {
  const systemPrompt = STAGE_SYSTEM_PROMPTS[stageId] || STAGE_SYSTEM_PROMPTS.chat
  const template = GENERATION_PROMPTS[stageId] || '请为项目"{project}"生成阶段"{stage}"的交付物。需求：{requirement}'
  let userPrompt = template
    .replace('{project}', projectName)
    .replace('{requirement}', requirement)
    .replace('{previousContent}', previousContent)

  // ─── Knowledge graph: inject upstream context ───
  if (graphContext && graphContext.context && graphContext.context.length > 0) {
    const contextSections = graphContext.context.map(c => {
      const score = c.qualityScore ? `（质量分: ${c.qualityScore}）` : ''
      return `── ${c.stageLabel}：${c.entityLabel} ${score} ──\n${c.content}`
    })
    userPrompt += `\n\n【上游交付物上下文】\n以下是之前阶段的已产出交付物，请确保生成的内容与它们保持一致性，并建立追溯关系：\n\n${contextSections.join('\n\n')}`
  }

  // ─── User instructions: append to prompt ───
  if (userInstructions && userInstructions.trim()) {
    userPrompt += `\n\n【用户补充要求】\n${userInstructions.trim()}`
  }

  // ─── Chat history: include prior conversation turns ───
  const messages = [
    { role: 'system', content: systemPrompt },
  ]
  if (chatHistory && chatHistory.length > 0) {
    chatHistory.forEach(msg => {
      if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({ role: msg.role, content: msg.content })
      }
    })
  }
  messages.push({ role: 'user', content: userPrompt })

  return callLLM(messages, { temperature: 0.7, maxTokens: 4096, modelOverride })
}

/**
 * Interactive chat with stage context — for conversational deliverable generation.
 * Returns a non-streamed response. Uses the same stage system prompt + graph context.
 */
export async function chatWithStage(stageId, userMessage, chatHistory = [], graphContext = null, modelOverride = null, agentConfig = null) {
  const basePrompt = STAGE_SYSTEM_PROMPTS[stageId] || STAGE_SYSTEM_PROMPTS.chat
  const agentPrompt = agentConfig?.systemPrompt ? `\n\n【智能体配置提示词】\n${agentConfig.systemPrompt}` : ''
  let contextBlock = ''

  if (graphContext && graphContext.context && graphContext.context.length > 0) {
    const contextSections = graphContext.context.map(c => {
      const score = c.qualityScore ? `（质量分: ${c.qualityScore}）` : ''
      return `── ${c.stageLabel}：${c.entityLabel} ${score} ──\n${c.content}`
    })
    contextBlock = `\n\n【上游交付物上下文】\n以下是之前阶段已产出的交付物，请在回答中保持一致性和可追溯性：\n\n${contextSections.join('\n\n')}`
  }

  const messages = [
    { role: 'system', content: basePrompt + agentPrompt + contextBlock },
    ...chatHistory.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ]

  return callLLM(messages, {
    temperature: agentConfig?.temperature ?? 0.7,
    maxTokens: 4096,
    modelOverride: modelOverride || agentConfig?.model || null,
  })
}

// ─── AI Review ──────────────────────────────────────────────────

export async function aiReview(deliverableContent, stageName) {
  const systemPrompt = STAGE_SYSTEM_PROMPTS.review
  const userPrompt = `请评审以下「${stageName}」阶段的交付物：\n\n${deliverableContent}`

  const result = await callLLM([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ], { temperature: 0.3, maxTokens: 2048 })

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
  } catch (e) {
    console.warn('AI review JSON parse failed:', e)
  }

  return {
    totalScore: 0,
    dimensions: {},
    suggestions: [result],
    passed: false,
  }
}

// ─── Stream Deliverable Generation ──────────────────────────────

export function streamGenerateDeliverable(stageId, projectName, requirement, previousContent = '') {
  const systemPrompt = STAGE_SYSTEM_PROMPTS[stageId] || STAGE_SYSTEM_PROMPTS.chat
  const template = GENERATION_PROMPTS[stageId] || '请为项目"{project}"生成阶段"{stage}"的交付物。需求：{requirement}'
  const userPrompt = template
    .replace('{project}', projectName)
    .replace('{requirement}', requirement)
    .replace('{previousContent}', previousContent)

  return streamChat([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ], { temperature: 0.7, maxTokens: 4096 })
}
