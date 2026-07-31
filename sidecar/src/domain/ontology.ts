// ================================================================
//  Ontology — Domain concept definitions for SDLC knowledge graph
//  (TypeScript port of src/data/ontology.js for the sidecar; the
//  frontend original stays untouched until a later phase unifies them)
//
//  This is the product's DESIGN PHILOSOPHY, not a hardcoded process.
//  It defines:
//    - Concepts:  WHAT entities exist in the SDLC domain
//    - Relations: HOW entities connect to each other
//    - Rules:     WHAT constraints/suggestions the engine can evaluate
//    - Quality:   WHAT dimensions define "good"
//
//  The actual delivery flow (which stages, what order, what concept
//  each stage produces) is NOT defined here — it is configured per
//  project in stages.ts / project.customFlow.
// ================================================================

// ─── Types ──────────────────────────────────────────────────────

export interface ConceptDef {
  id: string
  label: string
  icon: string
  color: string
  description: string
  properties: string[]
}

export interface RelationDef {
  id: string
  label: string
  description: string
  source: string
  target: string
  traceability: boolean
  color: string
  inverse: string
}

export interface ChainItem {
  stage: string
  concept: string
  label: string
}

/** Minimal shape of a graph entity as seen by rule evaluators. */
export interface GraphEntityLike {
  id: string
  label: string
  properties: Record<string, any>
}

/** Minimal graph interface the ontology rules evaluate against. */
export interface GraphLike {
  getEntity(entityId: string): GraphEntityLike | null | undefined
  getEntitiesByStage(stageId: string): GraphEntityLike[]
  getEntitiesByConcept(conceptId: string): GraphEntityLike[]
  getRelations(entityId: string, relationId: string): { target: GraphEntityLike }[]
}

export interface RuleContext {
  flowConfig?: ChainItem[]
  targetStage?: string
  [key: string]: any
}

export interface RuleResult {
  passed: boolean
  message?: string
  suggestion?: string
  context?: any[]
}

export interface OntologyRule {
  id: string
  type: 'constraint' | 'suggestion'
  label: string
  description: string
  condition: (graph: GraphLike, entityId: string | null, context?: RuleContext) => RuleResult
}

export interface QualityDimension {
  id: string
  label: string
  description: string
  weight: number
}

// ─── Concepts (Entity Types) ────────────────────────────────────
// These are the types of things that can exist in the knowledge graph.
// A project's delivery flow decides WHICH concepts are used and in
// what order, but the set of possible concepts is universal.

export const CONCEPTS: Record<string, ConceptDef> = {
  Requirement: {
    id: 'Requirement',
    label: '需求',
    icon: 'Lightbulb',
    color: '#3b82f6',
    description: '业务需求、用户场景、功能点',
    properties: ['title', 'priority', 'status', 'assignee'],
  },
  Deliverable: {
    id: 'Deliverable',
    label: '交付物',
    icon: 'FileText',
    color: '#8b5cf6',
    description: '各阶段产出的文档（需求规格、BRD、PRD、技术方案等）',
    properties: ['title', 'stage', 'content', 'qualityScore', 'status', 'generatedAt', 'author'],
  },
  CodeModule: {
    id: 'CodeModule',
    label: '代码模块',
    icon: 'Code2',
    color: '#22c55e',
    description: '代码仓库中被索引的文件、模块、函数',
    properties: ['filePath', 'repoName', 'language', 'type'],
  },
  TestCase: {
    id: 'TestCase',
    label: '测试用例',
    icon: 'TestTube2',
    color: '#06b6d4',
    description: '功能测试、边界测试、异常测试用例',
    properties: ['name', 'scenario', 'priority', 'status'],
  },
  Review: {
    id: 'Review',
    label: '评审记录',
    icon: 'CheckCircle',
    color: '#f59e0b',
    description: 'AI评审和人工评审的结果',
    properties: ['type', 'score', 'dimensions', 'suggestions', 'passed', 'reviewer'],
  },
  KnowledgeAsset: {
    id: 'KnowledgeAsset',
    label: '知识资产',
    icon: 'BookOpen',
    color: '#ec4899',
    description: '团队沉淀的规范、模板、最佳实践、历史经验',
    properties: ['title', 'type', 'tags', 'content'],
  },
  Agent: {
    id: 'Agent',
    label: '智能体',
    icon: 'Bot',
    color: '#6366f1',
    description: '配置的AI智能体及其能力',
    properties: ['name', 'model', 'stage', 'status', 'enabled'],
  },
}

// ─── Relations (Edge Types) ─────────────────────────────────────
// These define the SEMANTIC vocabulary of how entities can relate.
// They are universal — any project can use any relation.
// `traceability: true` means the relation is part of a traceability chain.

export const RELATIONS: Record<string, RelationDef> = {
  DERIVED_FROM: {
    id: 'DERIVED_FROM',
    label: '派生自',
    description: '下游交付物由上游交付物派生',
    source: 'Deliverable',
    target: 'Deliverable',
    traceability: true,
    color: '#8b5cf6',
    inverse: 'DERIVES',
  },
  DERIVES: {
    id: 'DERIVES',
    label: '派生出',
    description: '上游交付物派生下游交付物',
    source: 'Deliverable',
    target: 'Deliverable',
    traceability: true,
    color: '#8b5cf6',
    inverse: 'DERIVED_FROM',
  },
  IMPLEMENTS: {
    id: 'IMPLEMENTS',
    label: '实现',
    description: '代码模块实现了某交付物中定义的方案',
    source: 'CodeModule',
    target: 'Deliverable',
    traceability: true,
    color: '#22c55e',
    inverse: 'IMPLEMENTED_BY',
  },
  IMPLEMENTED_BY: {
    id: 'IMPLEMENTED_BY',
    label: '由...实现',
    description: '交付物被某代码模块实现',
    source: 'Deliverable',
    target: 'CodeModule',
    traceability: true,
    color: '#22c55e',
    inverse: 'IMPLEMENTS',
  },
  VALIDATES: {
    id: 'VALIDATES',
    label: '验证',
    description: '测试用例验证了某交付物定义的功能',
    source: 'TestCase',
    target: 'Deliverable',
    traceability: true,
    color: '#06b6d4',
    inverse: 'VALIDATED_BY',
  },
  VALIDATED_BY: {
    id: 'VALIDATED_BY',
    label: '由...验证',
    description: '交付物被某测试用例验证',
    source: 'Deliverable',
    target: 'TestCase',
    traceability: true,
    color: '#06b6d4',
    inverse: 'VALIDATES',
  },
  REVIEWED_BY: {
    id: 'REVIEWED_BY',
    label: '被评审',
    description: '交付物接受了评审',
    source: 'Deliverable',
    target: 'Review',
    traceability: true,
    color: '#f59e0b',
    inverse: 'REVIEWS',
  },
  REVIEWS: {
    id: 'REVIEWS',
    label: '评审了',
    description: '评审记录针对某交付物',
    source: 'Review',
    target: 'Deliverable',
    traceability: true,
    color: '#f59e0b',
    inverse: 'REVIEWED_BY',
  },
  REQUIRES: {
    id: 'REQUIRES',
    label: '需求来源',
    description: '交付物来源于某需求',
    source: 'Deliverable',
    target: 'Requirement',
    traceability: true,
    color: '#3b82f6',
    inverse: 'PRODUCES',
  },
  PRODUCES: {
    id: 'PRODUCES',
    label: '产出',
    description: '需求产出了某交付物',
    source: 'Requirement',
    target: 'Deliverable',
    traceability: true,
    color: '#3b82f6',
    inverse: 'REQUIRES',
  },
  REFERENCES: {
    id: 'REFERENCES',
    label: '引用',
    description: '交付物引用了某知识资产（规范、模板）',
    source: 'Deliverable',
    target: 'KnowledgeAsset',
    traceability: false,
    color: '#ec4899',
    inverse: 'REFERENCED_BY',
  },
  REFERENCED_BY: {
    id: 'REFERENCED_BY',
    label: '被引用',
    description: '知识资产被某交付物引用',
    source: 'KnowledgeAsset',
    target: 'Deliverable',
    traceability: false,
    color: '#ec4899',
    inverse: 'REFERENCES',
  },
  AUTHORED_BY: {
    id: 'AUTHORED_BY',
    label: '由...生成',
    description: '交付物由某智能体生成',
    source: 'Deliverable',
    target: 'Agent',
    traceability: false,
    color: '#6366f1',
    inverse: 'AUTHORED',
  },
  AUTHORED: {
    id: 'AUTHORED',
    label: '生成了',
    description: '智能体生成了某交付物',
    source: 'Agent',
    target: 'Deliverable',
    traceability: false,
    color: '#6366f1',
    inverse: 'AUTHORED_BY',
  },
}

// ─── Default Traceability Chain (TEMPLATE, not hardcoded) ───────
// This is a DEFAULT TEMPLATE that new projects can adopt or customize.
// It is NOT the only possible flow. Projects can configure their own
// flow via project.customFlow, which overrides this template.
//
// Each entry: { stage, concept, label }
//   - stage:   matches a stage id from STAGE_DEFINITIONS
//   - concept: which CONCEPTS type this stage produces
//   - label:   display label for the traceability view

export const DEFAULT_TRACEABILITY_CHAIN: ChainItem[] = [
  { stage: 'req', concept: 'Deliverable', label: '需求规格' },
  { stage: 'brd', concept: 'Deliverable', label: 'BRD' },
  { stage: 'prd', concept: 'Deliverable', label: 'PRD' },
  { stage: 'test', concept: 'TestCase', label: '测试用例' },
  { stage: 'dev-plan', concept: 'Deliverable', label: '技术方案' },
  { stage: 'dev', concept: 'CodeModule', label: '代码实现' },
  { stage: 'review', concept: 'Review', label: '代码评审' },
  { stage: 'auto-test', concept: 'Review', label: '测试报告' },
  { stage: 'deploy', concept: 'Deliverable', label: '交付文档' },
]

// ─── Ontology Rules (Axioms) ────────────────────────────────────
// Rules are GENERIC EVALUATORS that work against ANY flow config.
// Each rule receives: (graph, entityId, context)
//   - graph:    the knowledge graph instance
//   - entityId: the entity being evaluated
//   - context:  { flowConfig, targetStage, ... } — project-specific
//
// type: 'constraint' = hard rule (block), 'suggestion' = soft rule (warn)

export const ONTOLOGY_RULES: OntologyRule[] = [
  {
    id: 'rule-stage-order',
    type: 'constraint',
    label: '阶段顺序约束',
    description: '前置阶段未产出交付物时，不能进入当前阶段',
    condition: (graph, entityId, context = {}) => {
      const flowConfig = context.flowConfig || DEFAULT_TRACEABILITY_CHAIN
      const targetStage = context.targetStage
      if (!targetStage) return { passed: true }

      const targetIdx = flowConfig.findIndex((c) => c.stage === targetStage)
      if (targetIdx <= 0) return { passed: true }

      const prerequisite = flowConfig[targetIdx - 1]
      const entities = graph.getEntitiesByStage(prerequisite.stage)
      if (entities.length === 0) {
        return { passed: false, message: `前置阶段「${prerequisite.label}」尚未产出交付物` }
      }
      return { passed: true }
    },
  },
  {
    id: 'rule-review-required',
    type: 'constraint',
    label: '评审门禁约束',
    description: '交付物必须通过评审才能进入下一阶段',
    condition: (graph, entityId, context = {}) => {
      const entity = entityId ? graph.getEntity(entityId) : null
      if (!entity) return { passed: true }
      const reviews = graph.getRelations(entity.id, 'REVIEWED_BY')
      if (reviews.length === 0) {
        return { passed: false, message: '该交付物尚未通过评审' }
      }
      const lastReview = reviews[reviews.length - 1].target
      if (!lastReview.properties.passed) {
        return { passed: false, message: `评审未通过（得分 ${lastReview.properties.score}）` }
      }
      return { passed: true }
    },
  },
  {
    id: 'rule-context-injection',
    type: 'suggestion',
    label: '上下文注入建议',
    description: '生成交付物时自动注入上游交付物作为上下文',
    condition: (graph, entityId, context = {}) => {
      const flowConfig = context.flowConfig || DEFAULT_TRACEABILITY_CHAIN
      const targetStage = context.targetStage
      if (!targetStage) return { passed: true, context: [] }

      const targetIdx = flowConfig.findIndex((c) => c.stage === targetStage)
      if (targetIdx <= 0) return { passed: true, context: [] }

      const upstreamStages = flowConfig.slice(0, targetIdx)
      const ctx: any[] = []
      upstreamStages.forEach((item) => {
        const entities = graph.getEntitiesByStage(item.stage)
        entities.forEach((e) => {
          ctx.push({
            stage: item.stage,
            stageLabel: item.label,
            entityId: e.id,
            entityLabel: e.label,
            snippet: (e.properties.content || '').slice(0, 500),
            qualityScore: e.properties.qualityScore,
          })
        })
      })
      return { passed: true, context: ctx }
    },
  },
  {
    id: 'rule-quality-score',
    type: 'suggestion',
    label: '质量分追踪',
    description: '每个交付物的质量分应记录到知识图谱中',
    condition: (graph, entityId, context = {}) => {
      const entity = entityId ? graph.getEntity(entityId) : null
      if (!entity) return { passed: true }
      if (entity.properties.qualityScore === undefined || entity.properties.qualityScore === null) {
        return { passed: false, message: '该交付物尚未有质量评分', suggestion: '建议先进行AI评审' }
      }
      return { passed: true }
    },
  },
  {
    id: 'rule-code-linkage',
    type: 'suggestion',
    label: '代码关联建议',
    description: '代码产出后，建议建立代码与设计方案的实现关系',
    condition: (graph, entityId, context = {}) => {
      const flowConfig = context.flowConfig || DEFAULT_TRACEABILITY_CHAIN
      // Find the stage that produces CodeModule and the stage that produces Deliverable before it
      const codeStageIdx = flowConfig.findIndex((c) => c.concept === 'CodeModule')
      if (codeStageIdx <= 0) return { passed: true }

      const codeModules = graph.getEntitiesByConcept('CodeModule')
      if (codeModules.length === 0) return { passed: true }

      // Find the upstream Deliverable stage (usually dev-plan)
      for (let i = codeStageIdx - 1; i >= 0; i--) {
        if (flowConfig[i].concept === 'Deliverable') {
          const upstreamEntities = graph.getEntitiesByStage(flowConfig[i].stage)
          if (upstreamEntities.length > 0) {
            const linked = graph.getRelations(upstreamEntities[0].id, 'IMPLEMENTED_BY')
            if (linked.length === 0) {
              return { passed: false, message: `${flowConfig[i].label}尚未关联代码模块`, suggestion: '建议建立实现关系' }
            }
          }
          break
        }
      }
      return { passed: true }
    },
  },
]

// ─── Quality Dimensions ─────────────────────────────────────────

export const QUALITY_DIMENSIONS: QualityDimension[] = [
  { id: 'completeness', label: '完整性', description: '内容是否覆盖所有必要方面', weight: 0.3 },
  { id: 'consistency', label: '一致性', description: '前后逻辑是否一致，与上游交付物是否对齐', weight: 0.25 },
  { id: 'feasibility', label: '可行性', description: '方案是否技术可行', weight: 0.25 },
  { id: 'standardization', label: '规范性', description: '是否遵循行业规范和团队标准', weight: 0.2 },
]

// ─── Helpers ────────────────────────────────────────────────────

export function getTraceabilityRelations(): RelationDef[] {
  return Object.values(RELATIONS).filter((r) => r.traceability)
}

export function getConcept(conceptId: string): ConceptDef | undefined {
  return CONCEPTS[conceptId]
}

export function getRelation(relationId: string): RelationDef | undefined {
  return RELATIONS[relationId]
}

// Build a traceability chain from a project's custom flow config.
// If the project has no custom flow, fall back to DEFAULT_TRACEABILITY_CHAIN.
export function buildTraceabilityChain(customFlow: ChainItem[] | null = null): ChainItem[] {
  if (!customFlow || !Array.isArray(customFlow) || customFlow.length === 0) {
    return DEFAULT_TRACEABILITY_CHAIN
  }
  return customFlow
}
