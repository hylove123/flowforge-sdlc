// ================================================================
//  Knowledge Service Facade — 前端知识层统一入口
//
//  纯客户端架构：所有知识图谱操作走 sidecar knowledgeService
//  （SQLite WAL + 向量检索），不再有本地 localStorage 图谱。
//
//  对应 sidecar RPC（sidecar/src/knowledge/knowledgeService.ts）：
//    knowledge.recall               上游交付物 + 相关资产 + 追溯链
//    knowledge.trace_chain          追溯链（含每实体出向关系）
//    knowledge.register             登记交付物 / 评审
//    knowledge.register_code_modules 登记代码模块
//    knowledge.search / knowledge.stats
// ================================================================

import { sidecar } from '@/adapters/SidecarBridge'
import { RELATIONS, getConcept, ONTOLOGY_RULES } from '@/data/ontology'

// ─── 上游上下文注入（AI 生成 / 对话）──────────────────────────

/**
 * 获取当前阶段的上游交付物上下文。
 * 返回形状与旧 graph.js getAIContext 兼容：{ context: [...], summary }
 */
export async function getUpstreamContext(projectId, stageId, deliveryId = null, flowConfig = null) {
  const recall = await sidecar.invoke('knowledge.recall', {
    projectId, stageId, deliveryId, flowConfig,
  })
  const context = (recall?.upstreamDeliverables ?? []).map(u => ({
    stage: u.stage,
    stageLabel: u.stageLabel,
    entityId: u.entityId,
    entityLabel: u.label,
    content: u.snippet,
    qualityScore: u.qualityScore,
  }))
  const summary = context.length > 0
    ? `已注入 ${context.length} 个上游交付物作为上下文：${context.map(c => `${c.stageLabel}(${c.entityLabel})`).join('、')}`
    : '暂无上游交付物上下文'
  return { context, summary }
}

// ─── 追溯链（交付追溯 tab）────────────────────────────────────

/**
 * 获取交付物追溯链，实体附带出向关系（含关系定义与目标实体）。
 */
export async function getTraceabilityChain(projectId, deliveryId = null, flowConfig = null) {
  const chain = await sidecar.invoke('knowledge.trace_chain', { projectId, deliveryId, flowConfig })
  return (chain ?? []).map(item => ({
    ...item,
    entities: (item.entities ?? []).map(e => ({
      ...e,
      conceptDef: getConcept(e.type),
      relations: (e.relations ?? []).map(r => ({
        ...r,
        relationDef: RELATIONS[r.relation],
      })),
    })),
  }))
}

// ─── 登记交付物 / 评审 ────────────────────────────────────────

/** 登记交付物（AI 生成 / 手动导入后调用） */
export function registerDeliverable({ projectId, deliveryId, stageId, label, content, author = null, flowConfig = null }) {
  return sidecar.invoke('knowledge.register', {
    projectId,
    deliveryId,
    stageId,
    title: label,
    content,
    source: author || 'builtin',
    flowConfig,
  })
}

/**
 * 登记评审结果：sidecar 会 upsert 交付物实体（更新质量分）
 * 并创建 Review 实体 + REVIEWED_BY 边。
 */
export function registerReview({ projectId, deliveryId, stageId, content, review, flowConfig = null }) {
  return sidecar.invoke('knowledge.register', {
    projectId,
    deliveryId,
    stageId,
    content: content ?? '',
    qualityScore: review?.totalScore ?? null,
    review: review ? {
      totalScore: review.totalScore,
      suggestions: review.suggestions || [],
      passed: review.passed,
      dimensions: review.dimensions || {},
    } : null,
    source: 'ai-review',
    flowConfig,
  })
}

/** 登记代码模块（代码索引 → 知识图谱） */
export function registerCodeModules(input) {
  return sidecar.invoke('knowledge.register_code_modules', input)
}

// ─── 检索 / 统计（知识库页面）─────────────────────────────────

export async function searchKnowledge(query, projectId) {
  const res = await sidecar.invoke('knowledge.search', { projectId, query })
  return (res?.results ?? []).map(r => ({
    id: r.entityId,
    label: r.label,
    type: r.type,
    stageId: r.stageId,
    snippet: r.snippet,
    relationCount: r.relationCount,
    score: r.score,
  }))
}

export function getKnowledgeStats(projectId) {
  return sidecar.invoke('knowledge.stats', { projectId })
}

// ─── 本体规则评估适配器 ───────────────────────────────────────

/**
 * 从追溯链数据构建只读图适配器，供 ontology.js ONTOLOGY_RULES
 * 评估使用（规则接口：getEntity/getEntitiesByStage/getEntitiesByConcept/getRelations）。
 */
export function createChainGraphAdapter(chain) {
  const entities = (chain ?? []).flatMap(item => item.entities ?? [])
  const byId = new Map(entities.map(e => [e.id, e]))
  return {
    getEntity: (id) => byId.get(id) ?? null,
    getEntitiesByStage: (stage) => entities.filter(e => e.stageId === stage),
    getEntitiesByConcept: (concept) => entities.filter(e => e.type === concept),
    getRelations: (entityId, relationType = null) => {
      const e = byId.get(entityId)
      if (!e) return []
      return (e.relations ?? [])
        .filter(r => !relationType || r.relation === relationType)
        .map(r => ({
          ...r,
          relationDef: RELATIONS[r.relation],
          target: byId.get(r.target?.id) ?? r.target ?? null,
        }))
        .filter(r => r.target)
    },
  }
}

/** 用追溯链数据评估本体规则（ONTOLOGY_RULES） */
export function evaluateChainRules(chain, entityId, context = {}) {
  const adapter = createChainGraphAdapter(chain)
  return ONTOLOGY_RULES.map(rule => {
    try {
      const result = rule.condition(adapter, entityId, context)
      return { ...rule, ...result }
    } catch (e) {
      return { ...rule, passed: true, error: e.message }
    }
  })
}
