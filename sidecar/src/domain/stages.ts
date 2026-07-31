// ================================================================
//  Stage Definitions — centralized metadata for all delivery stages
//  Each stage carries: guidance, quality checklist, default config
//  (TypeScript port of src/data/stages.js for the sidecar; the
//  frontend original stays untouched until a later phase unifies them)
// ================================================================

// ─── Types ──────────────────────────────────────────────────────

export interface StageSkill {
  name: string
  desc: string
  enabled: boolean
}

export interface StageGuidance {
  goal: string
  steps: string[]
  qualityChecklist: string[]
  template: string
}

export interface StageDefaultConfig {
  skills: StageSkill[]
  mcps: StageSkill[]
  rules: StageSkill[]
  model: string
  temperature: number
}

export interface StageDefinition {
  id: string
  name: string
  shortName: string
  icon: string
  color: string
  concept: string
  description: string
  deliverables: string[]
  generatable: boolean
  hasAiReview: boolean
  guidance: StageGuidance
  defaultConfig: StageDefaultConfig
}

export interface StageGate {
  aiReview: boolean
  humanReview: boolean
  manualTrigger: boolean
  threshold: number
}

export interface FlowNode {
  stage: string
  concept: string
  label: string
  agentId: string | null
  gate: StageGate
}

export interface FlowNodeInput {
  stage: string
  concept?: string
  label?: string
  agentId?: string | null
  gate?: StageGate
}

export interface ProjectLike {
  customFlow?: FlowNodeInput[] | string[] | null
  [key: string]: any
}

// ─── Stage definitions ──────────────────────────────────────────

export const STAGE_DEFINITIONS: StageDefinition[] = [
  {
    id: 'req',
    name: '需求分析',
    shortName: '需求',
    icon: 'FileText',
    color: '#3b82f6',
    concept: 'Deliverable',
    description: '收集和分析业务需求，定义功能范围和优先级。',
    deliverables: ['需求规格说明书', '用户画像', '业务流程图'],
    generatable: true,
    hasAiReview: true,
    guidance: {
      goal: '明确"做什么、为谁做、解决什么问题"',
      steps: [
        '描述业务背景和核心痛点',
        '定义目标用户和核心使用场景',
        '梳理功能范围并排列优先级（P0-P3）',
      ],
      qualityChecklist: [
        '业务目标清晰且可衡量',
        '覆盖至少 3 个核心用户场景',
        '功能有明确的优先级排序',
        '识别了关键约束和技术风险',
      ],
      template: '请基于以下信息生成需求分析文档：\n\n## 业务背景\n[描述业务现状和痛点]\n\n## 目标用户\n[定义核心用户群体]\n\n## 核心场景\n[列出 3-5 个核心使用场景]\n\n## 功能范围\n[梳理功能清单并标注优先级]',
    },
    defaultConfig: {
      skills: [
        { name: 'Requirement-Analyzer', desc: '需求分析和拆解', enabled: true },
        { name: 'User-Story-Writer', desc: '用户故事编写', enabled: true },
      ],
      mcps: [
        { name: 'Jira MCP', desc: '需求同步和跟踪', enabled: true },
        { name: 'Confluence MCP', desc: '文档检索', enabled: false },
      ],
      rules: [
        { name: '需求完整性规则', desc: '确保覆盖用户故事和验收标准', enabled: true },
      ],
      model: 'GPT-4o',
      temperature: 0.7,
    },
  },
  {
    id: 'brd',
    name: 'BRD',
    shortName: 'BRD',
    icon: 'FileCheck',
    color: '#8b5cf6',
    concept: 'Deliverable',
    description: '编写业务需求文档，明确商业目标和成功指标。',
    deliverables: ['BRD文档'],
    generatable: true,
    hasAiReview: true,
    guidance: {
      goal: '将需求转化为可量化的商业目标和成功指标',
      steps: [
        '从需求分析中提炼商业目标',
        '定义成功指标（KPI/OKR）',
        '进行竞品分析和差异化定位',
        '评估 ROI 和资源投入',
      ],
      qualityChecklist: [
        '商业目标与需求分析一致',
        '成功指标可量化、可追踪',
        '包含竞品分析',
        'ROI 评估合理',
      ],
      template: '请基于需求分析结果生成 BRD 文档：\n\n## 商业背景与目标\n## 成功指标 (KPI)\n## 竞品分析\n## ROI 评估\n## 范围与约束',
    },
    defaultConfig: {
      skills: [
        { name: 'BRD-Writer', desc: 'BRD文档自动生成', enabled: true },
      ],
      mcps: [
        { name: 'Jira MCP', desc: '需求同步', enabled: true },
      ],
      rules: [
        { name: 'BRD完整性规则', desc: '包含商业目标、成功指标、竞品分析', enabled: true },
      ],
      model: 'GPT-4o',
      temperature: 0.7,
    },
  },
  {
    id: 'prd',
    name: 'PRD',
    shortName: 'PRD',
    icon: 'ClipboardList',
    color: '#845ef7',
    concept: 'Deliverable',
    description: '产品需求文档，定义功能细节、交互逻辑和验收标准。',
    deliverables: ['PRD文档'],
    generatable: true,
    hasAiReview: true,
    guidance: {
      goal: '将业务需求转化为详细的产品规格，开发可执行',
      steps: [
        '定义功能模块和子功能',
        '编写用户故事和验收标准',
        '设计交互流程和页面结构',
        '明确非功能需求（性能、安全）',
      ],
      qualityChecklist: [
        '功能模块划分清晰',
        '每个功能有对应的用户故事',
        '验收标准具体且可测试',
        '包含异常流程处理',
        '非功能需求明确',
      ],
      template: '请基于 BRD 生成 PRD 文档：\n\n## 功能概述\n## 功能模块\n### 模块1: [名称]\n- 用户故事\n- 验收标准\n- 交互流程\n## 非功能需求\n## 依赖与约束',
    },
    defaultConfig: {
      skills: [
        { name: 'PRD-Generator', desc: '自动生成PRD文档，支持多种模板', enabled: true },
        { name: 'User-Story-Writer', desc: '用户故事编写', enabled: true },
      ],
      mcps: [
        { name: 'Figma MCP', desc: '设计稿同步和标注', enabled: false },
        { name: 'Jira MCP', desc: '需求同步', enabled: true },
      ],
      rules: [
        { name: 'PRD完整性规则', desc: '确保PRD包含用户故事、验收标准、非功能需求', enabled: true },
      ],
      model: 'Claude 3.5 Sonnet',
      temperature: 0.6,
    },
  },
  {
    id: 'test',
    name: '测试用例',
    shortName: '测试',
    icon: 'TestTube2',
    color: '#06b6d4',
    concept: 'TestCase',
    description: '根据PRD自动生成测试用例，覆盖正常流程和边界场景。',
    deliverables: ['测试用例文档'],
    generatable: true,
    hasAiReview: true,
    guidance: {
      goal: '基于 PRD 生成全面的测试用例，覆盖正常和边界场景',
      steps: [
        '从 PRD 提取测试点',
        '编写正常流程测试用例',
        '补充边界和异常场景',
        '定义测试数据和预期结果',
      ],
      qualityChecklist: [
        '覆盖所有 PRD 功能点',
        '包含正常、异常、边界场景',
        '测试步骤可执行',
        '预期结果明确',
      ],
      template: '请基于 PRD 生成测试用例：\n\n## 测试范围\n## 测试用例\n| 编号 | 场景 | 前置条件 | 步骤 | 预期结果 | 优先级 |\n## 边界场景\n## 异常场景',
    },
    defaultConfig: {
      skills: [
        { name: 'Test-Case-Writer', desc: '基于PRD自动生成测试用例', enabled: true },
      ],
      mcps: [
        { name: 'Jira MCP', desc: '用例同步', enabled: false },
      ],
      rules: [
        { name: '测试覆盖率规则', desc: '覆盖所有PRD功能点', enabled: true },
      ],
      model: 'DeepSeek V3',
      temperature: 0.5,
    },
  },
  {
    id: 'dev-plan',
    name: '开发方案',
    shortName: '方案',
    icon: 'Code2',
    color: '#f59e0b',
    concept: 'Deliverable',
    description: '基于PRD产出技术方案文档（TS），包括架构设计、接口定义和数据库设计。',
    deliverables: ['技术方案文档(TS)'],
    generatable: true,
    hasAiReview: true,
    guidance: {
      goal: '将 PRD 转化为可执行的技术方案，指导开发实现',
      steps: [
        '设计系统架构和技术选型',
        '定义 API 接口规范',
        '设计数据库表结构',
        '评估技术风险和依赖',
      ],
      qualityChecklist: [
        '架构图清晰',
        'API 接口定义完整',
        '数据库设计合理',
        '技术风险已识别',
      ],
      template: '请基于 PRD 生成技术方案文档：\n\n## 系统架构\n## 技术选型\n## API 接口设计\n## 数据库设计\n## 技术风险与对策',
    },
    defaultConfig: {
      skills: [
        { name: 'Architecture-Planner', desc: '系统架构设计和技术选型', enabled: true },
      ],
      mcps: [
        { name: 'Code-base MCP', desc: '代码图谱索引和知识问答', enabled: true },
        { name: 'Git MCP', desc: 'Git操作集成', enabled: true },
      ],
      rules: [
        { name: 'API规范规则', desc: 'REST API设计符合OpenAPI 3.0规范', enabled: true },
      ],
      model: 'GPT-4o',
      temperature: 0.6,
    },
  },
  {
    id: 'dev',
    name: '开发',
    shortName: '开发',
    icon: 'GitMerge',
    color: '#22c55e',
    concept: 'CodeModule',
    description: '基于TS技术方案进行编码实现，支持spec驱动开发模式。',
    deliverables: ['源代码', 'Spec文档(可选)'],
    generatable: false,
    hasAiReview: false,
    guidance: {
      goal: '基于技术方案完成编码实现',
      steps: [
        '选择开发模式（本地IDE/Bridge Agent/云端/Spec）',
        '按模块实现功能代码',
        '编写单元测试',
        '提交代码并发起 Code Review',
      ],
      qualityChecklist: [
        '代码符合技术方案',
        '单元测试覆盖核心逻辑',
        '代码风格统一',
        '无明显安全漏洞',
      ],
      template: '',
    },
    defaultConfig: {
      skills: [
        { name: 'Code-Generator', desc: '基于TS方案生成代码骨架', enabled: true },
      ],
      mcps: [
        { name: 'Code-base MCP', desc: '代码图谱索引和知识问答', enabled: true },
        { name: 'Git MCP', desc: 'Git操作集成（clone/branch/merge）', enabled: true },
      ],
      rules: [
        { name: '代码风格规则', desc: '强制代码风格统一', enabled: true },
      ],
      model: 'Claude 3.5 Sonnet',
      temperature: 0.4,
    },
  },
  {
    id: 'review',
    name: 'Code Review',
    shortName: 'CR',
    icon: 'Eye',
    color: '#845ef7',
    concept: 'Review',
    description: '代码审查，确保代码质量和规范一致性。',
    deliverables: ['Code Review报告'],
    generatable: true,
    hasAiReview: true,
    guidance: {
      goal: '通过代码审查确保质量和规范一致性',
      steps: [
        '发起 AI 自动 Code Review',
        '检查代码规范和安全漏洞',
        '审查依赖版本和性能问题',
        '确认修改并合并',
      ],
      qualityChecklist: [
        '代码规范检查通过',
        '无安全漏洞',
        '依赖版本合理',
        '性能无明显问题',
      ],
      template: '请对以下代码进行 Code Review：\n\n## 代码片段\n[粘贴代码]\n\n## 审查维度\n- 代码规范\n- 安全性\n- 性能\n- 可维护性',
    },
    defaultConfig: {
      skills: [
        { name: 'Code-Review-Expert', desc: '代码质量审查和最佳实践检查', enabled: true },
      ],
      mcps: [
        { name: 'Code-base MCP', desc: '代码图谱索引', enabled: true },
        { name: 'Git MCP', desc: '代码变更对比', enabled: true },
      ],
      rules: [
        { name: '代码风格规则', desc: '强制代码风格统一', enabled: true },
        { name: '安全审计规则', desc: '检查常见安全漏洞', enabled: true },
      ],
      model: 'Claude 3.5 Sonnet',
      temperature: 0.3,
    },
  },
  {
    id: 'auto-test',
    name: '自动化测试',
    shortName: '自测',
    icon: 'TestTube2',
    color: '#06b6d4',
    concept: 'Review',
    description: '运行自动化测试套件，验证功能正确性。',
    deliverables: ['测试报告'],
    generatable: true,
    hasAiReview: false,
    guidance: {
      goal: '通过自动化测试验证功能正确性',
      steps: [
        '运行单元测试套件',
        '运行集成测试',
        '分析失败用例并修复',
        '生成测试覆盖率报告',
      ],
      qualityChecklist: [
        '所有测试用例通过',
        '覆盖率达标（≥80%）',
        '无 flaky 测试',
        '测试报告完整',
      ],
      template: '请生成自动化测试报告：\n\n## 测试概览\n- 总用例数\n- 通过/失败/跳过\n- 覆盖率\n## 失败用例分析\n## 修复建议',
    },
    defaultConfig: {
      skills: [
        { name: 'Test-Runner', desc: '自动化测试执行和报告', enabled: true },
      ],
      mcps: [
        { name: 'Git MCP', desc: '获取代码变更', enabled: true },
      ],
      rules: [
        { name: '测试覆盖率规则', desc: '单元测试覆盖率不低于80%', enabled: true },
      ],
      model: 'DeepSeek V3',
      temperature: 0.2,
    },
  },
  {
    id: 'deploy',
    name: '交付',
    shortName: '交付',
    icon: 'Rocket',
    color: '#22c55e',
    concept: 'Deliverable',
    description: '部署上线，完成交付验收。',
    deliverables: ['部署文档', 'Release Notes'],
    generatable: true,
    hasAiReview: false,
    guidance: {
      goal: '完成部署上线和交付验收',
      steps: [
        '生成部署检查清单',
        '执行部署流程',
        '验证线上功能',
        '生成 Release Notes',
      ],
      qualityChecklist: [
        '部署检查清单完成',
        '线上功能验证通过',
        'Release Notes 已生成',
        '回滚方案已准备',
      ],
      template: '请生成部署文档和 Release Notes：\n\n## 部署检查清单\n## 部署步骤\n## Release Notes\n- 新功能\n- 修复\n- 已知问题\n## 回滚方案',
    },
    defaultConfig: {
      skills: [
        { name: 'Deploy-Assistant', desc: '部署清单和Release Notes生成', enabled: true },
      ],
      mcps: [
        { name: 'Slack MCP', desc: '通知推送', enabled: true },
      ],
      rules: [
        { name: '安全发布规则', desc: '必须有回滚方案', enabled: true },
      ],
      model: 'GPT-4o',
      temperature: 0.3,
    },
  },
]

export const STAGE_NAMES: string[] = STAGE_DEFINITIONS.map((s) => s.name)

export function getStageDefinition(stageId: string): StageDefinition | undefined {
  return STAGE_DEFINITIONS.find((s) => s.id === stageId)
}

// Build default stage configs for a project
export function buildDefaultStageConfigs(): Record<string, StageDefaultConfig> {
  const configs: Record<string, StageDefaultConfig> = {}
  STAGE_DEFINITIONS.forEach((stage) => {
    configs[stage.id] = { ...stage.defaultConfig }
  })
  return configs
}

// ─── Flow Config Builder ────────────────────────────────────────
// Build a traceability chain config from stage definitions.
// This is the DEFAULT flow — projects can customize it.
// Returns: [{ stage, concept, label, agentId, gate }] — the format the graph engine expects.

// Default agent assignment for each stage
export const DEFAULT_STAGE_AGENTS: Record<string, string | null> = {
  'req': 'a1',      // BRD-Writer covers req too
  'brd': 'a1',      // BRD-Writer
  'prd': 'a2',      // PRD-Writer
  'test': 'a3',     // Test-Generator
  'dev-plan': 'a4', // Code-Architect
  'dev': 'a4',      // Code-Architect (same agent, different stage context)
  'review': 'a5',   // Code-Reviewer
  'auto-test': 'a3',// Test-Generator
  'deploy': null,   // No default agent
}

export const DEFAULT_GATES: StageGate[] = [
  { aiReview: true, humanReview: true, manualTrigger: true, threshold: 80 },   // 需求分析
  { aiReview: true, humanReview: true, manualTrigger: true, threshold: 80 },   // BRD
  { aiReview: true, humanReview: true, manualTrigger: true, threshold: 75 },   // PRD
  { aiReview: true, humanReview: false, manualTrigger: true, threshold: 75 },  // 测试用例
  { aiReview: true, humanReview: false, manualTrigger: true, threshold: 75 },  // 开发方案
  { aiReview: false, humanReview: false, manualTrigger: true, threshold: 0 },  // 开发
  { aiReview: true, humanReview: false, manualTrigger: true, threshold: 75 },  // Code Review
  { aiReview: false, humanReview: false, manualTrigger: true, threshold: 0 },  // 自动化测试
  { aiReview: false, humanReview: false, manualTrigger: true, threshold: 0 },  // 交付
]

export function buildDefaultFlowConfig(): FlowNode[] {
  return STAGE_DEFINITIONS.map((s, idx) => ({
    stage: s.id,
    concept: s.concept || 'Deliverable',
    label: s.shortName || s.name,
    agentId: DEFAULT_STAGE_AGENTS[s.id] || null,  // 默认绑定的智能体ID
    gate: DEFAULT_GATES[idx] || { aiReview: s.hasAiReview, humanReview: false, manualTrigger: true, threshold: 75 },
  }))
}

// Build a flow config from a custom stage list (for project-level customization).
// customStages: array of stage IDs in the desired order, OR array of { stage, concept, label, agentId?, gate? }.
// Returns: [{ stage, concept, label, agentId, gate }] — preserves agentId/gate if present.
export function buildFlowConfig(customStages: FlowNodeInput[] | string[] | null = null): FlowNode[] {
  if (!customStages || !Array.isArray(customStages) || customStages.length === 0) {
    return buildDefaultFlowConfig()
  }

  // If it's already in object format, preserve agentId/gate if present
  if (typeof customStages[0] === 'object' && (customStages[0] as FlowNodeInput).stage) {
    return (customStages as FlowNodeInput[]).map((item, idx) => {
      const def = STAGE_DEFINITIONS.find((s) => s.id === item.stage)
      const defaultAgent = DEFAULT_STAGE_AGENTS[item.stage] || null
      const defaultGate = DEFAULT_GATES[idx] || { aiReview: def?.hasAiReview ?? false, humanReview: false, manualTrigger: true, threshold: 75 }
      return {
        stage: item.stage,
        concept: item.concept || def?.concept || 'Deliverable',
        label: item.label || def?.shortName || def?.name || item.stage,
        agentId: item.agentId !== undefined ? item.agentId : defaultAgent,
        gate: item.gate || defaultGate,
      }
    })
  }

  // If it's an array of stage IDs, resolve from STAGE_DEFINITIONS
  return (customStages as string[]).map((stageId, idx) => {
    const def = STAGE_DEFINITIONS.find((s) => s.id === stageId)
    if (def) {
      return {
        stage: def.id,
        concept: def.concept || 'Deliverable',
        label: def.shortName || def.name,
        agentId: DEFAULT_STAGE_AGENTS[def.id] || null,
        gate: DEFAULT_GATES[idx] || { aiReview: def.hasAiReview, humanReview: false, manualTrigger: true, threshold: 75 },
      }
    }
    // Unknown stage — create a generic entry
    return { stage: stageId, concept: 'Deliverable', label: stageId, agentId: null, gate: { aiReview: false, humanReview: false, manualTrigger: true, threshold: 75 } }
  })
}

// Get the effective flow config for a project.
// If project has customFlow, use it; otherwise use default.
export function getProjectFlowConfig(project: ProjectLike | null = null): FlowNode[] {
  if (project && project.customFlow && Array.isArray(project.customFlow) && project.customFlow.length > 0) {
    return buildFlowConfig(project.customFlow)
  }
  return buildDefaultFlowConfig()
}

// Get the effective stage list for a project (resolves customFlow to full stage definitions).
// Returns an array of stage definition objects (with all metadata), enriched with agentId and gate from flow node.
export function getProjectStages(project: ProjectLike | null = null): (StageDefinition & { agentId: string | null; gate: StageGate })[] {
  const flowConfig = getProjectFlowConfig(project)
  return flowConfig.map((item) => {
    const def = STAGE_DEFINITIONS.find((s) => s.id === item.stage)
    if (def) {
      return { ...def, concept: item.concept || def.concept, agentId: item.agentId ?? null, gate: item.gate }
    }
    // Custom stage not in defaults — create a minimal definition
    return {
      id: item.stage,
      name: item.label,
      shortName: item.label,
      icon: 'Circle',
      color: '#6b7280',
      concept: item.concept || 'Deliverable',
      description: '自定义阶段',
      deliverables: [],
      generatable: true,
      hasAiReview: item.gate?.aiReview ?? true,
      guidance: { goal: '', steps: [], qualityChecklist: [], template: '' },
      defaultConfig: { skills: [], mcps: [], rules: [], model: '', temperature: 0.7 },
      agentId: item.agentId ?? null,
      gate: item.gate,
    }
  })
}
