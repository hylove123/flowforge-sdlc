import React, { createContext, useContext, useReducer, useCallback, useMemo } from 'react'
import { STAGE_DEFINITIONS, STAGE_NAMES, buildDefaultStageConfigs, getProjectFlowConfig, getProjectStages, buildDefaultFlowConfig } from '@/data/stages'
import { getProjectDAG, dagToStageList, dagToFlowConfigFull } from '@/data/flowEngine'
import { detectRuntimeMode } from '@/adapters/StorageService'

// ═══ Web-mode demo seed data ═════════════════════════════════════
// The blocks below (users / projects / deliveries) are DEMO data used
// only in web mode (protects Playwright e2e). Tauri (desktop/production)
// boots with a clean empty state — see buildInitialState().

// ─── Users (web demo seed) ───────────────────────────────────────
const users = [
  { id: 'u1', name: '张明', role: '产品经理', roleTag: 'PM', avatarInitial: '张' },
  { id: 'u2', name: '李华', role: '架构师', roleTag: '架构', avatarInitial: '李' },
  { id: 'u3', name: '王磊', role: '测试工程师', roleTag: '测试', avatarInitial: '王' },
]

// ─── Projects with per-project independent configuration (web demo seed) ─────────
const projects = [
  {
    id: 'p1',
    name: '智能客服系统 v2.0',
    stage: 'PRD生成',
    progress: 68,
    status: 'active',
    members: ['张明', '李华', '王磊'],
    agents: [
      { name: 'BRD-Writer', model: 'GPT-4o', stage: 'BRD生成', status: 'idle', tasks: 0, enabled: true },
      { name: 'PRD-Writer', model: 'Claude 3.5 Sonnet', stage: 'PRD生成', status: 'running', tasks: 1, enabled: true },
      { name: 'Test-Generator', model: 'DeepSeek V3', stage: '测试用例', status: 'idle', tasks: 0, enabled: true },
      { name: 'Code-Architect', model: 'GPT-4o', stage: '开发方案', status: 'idle', tasks: 0, enabled: true },
      { name: 'Code-Reviewer', model: 'Claude 3.5 Sonnet', stage: 'Code Review', status: 'running', tasks: 2, enabled: true },
      { name: 'AI-Reviewer-QA', model: 'GPT-4o-mini', stage: 'AI质量评审', status: 'running', tasks: 3, enabled: true },
    ],
    skills: [
      { name: 'PRD-Generator', desc: '自动生成PRD文档，支持多种模板', stage: 'PRD生成', enabled: true },
      { name: 'Test-Case-Writer', desc: '基于PRD自动生成测试用例', stage: '测试用例', enabled: true },
      { name: 'Code-Review-Expert', desc: '代码质量审查和最佳实践检查', stage: 'Code Review', enabled: true },
      { name: 'Architecture-Planner', desc: '系统架构设计和技术选型', stage: '开发方案', enabled: true },
    ],
    rules: [
      { name: 'PRD完整性规则', desc: '确保PRD包含用户故事、验收标准、非功能需求', stage: 'PRD生成', enabled: true },
      { name: '代码风格规则', desc: '强制Go/TypeScript代码风格统一', stage: '开发', enabled: true },
      { name: '测试覆盖率规则', desc: '单元测试覆盖率不低于80%', stage: '自动化测试', enabled: true },
    ],
    mcpTools: [
      { name: 'Code-base MCP', desc: '代码图谱索引和知识问答', enabled: true },
      { name: 'Git MCP', desc: 'Git操作集成（clone/branch/merge）', enabled: true },
      { name: 'Jira MCP', desc: 'Jira需求同步', enabled: true },
      { name: 'Slack MCP', desc: 'Slack通知推送', enabled: true },
    ],
    modelMatrix: [
      { stage: '需求分析', genModel: 'GPT-4o', reviewModel: 'GPT-4o-mini', genTemp: 0.7, reviewTemp: 0.3, tokens: '12.4k', avgTime: '8.2s', passRate: '91%', status: 'connected' },
      { stage: 'BRD生成', genModel: 'GPT-4o', reviewModel: 'Claude 3.5 Sonnet', genTemp: 0.7, reviewTemp: 0.3, tokens: '28.6k', avgTime: '15.4s', passRate: '88%', status: 'connected' },
      { stage: 'PRD生成', genModel: 'Claude 3.5 Sonnet', reviewModel: 'GPT-4o', genTemp: 0.6, reviewTemp: 0.3, tokens: '45.2k', avgTime: '22.1s', passRate: '85%', status: 'connected' },
      { stage: '测试用例', genModel: 'DeepSeek V3', reviewModel: 'GPT-4o-mini', genTemp: 0.5, reviewTemp: 0.2, tokens: '18.8k', avgTime: '12.6s', passRate: '93%', status: 'connected' },
      { stage: '开发方案', genModel: 'GPT-4o', reviewModel: 'Claude 3.5 Sonnet', genTemp: 0.7, reviewTemp: 0.3, tokens: '36.1k', avgTime: '18.9s', passRate: '82%', status: 'connected' },
      { stage: '开发', genModel: 'Claude 3.5 Sonnet', reviewModel: '—', genTemp: 0.4, reviewTemp: null, tokens: '156.3k', avgTime: '45.2s', passRate: '—', status: 'connected' },
      { stage: 'Code Review', genModel: 'GPT-4o', reviewModel: '—', genTemp: 0.3, reviewTemp: null, tokens: '67.8k', avgTime: '28.4s', passRate: '—', status: 'connected' },
      { stage: '自动化测试', genModel: 'DeepSeek V3', reviewModel: '—', genTemp: 0.2, reviewTemp: null, tokens: '24.5k', avgTime: '35.6s', passRate: '—', status: 'connected' },
    ],
    reviewGates: [
      { stage: '需求分析', aiReview: true, humanReview: true, manualTrigger: true, threshold: 80 },
      { stage: 'BRD', aiReview: true, humanReview: true, manualTrigger: true, threshold: 80 },
      { stage: 'PRD', aiReview: true, humanReview: true, manualTrigger: true, threshold: 75 },
      { stage: '测试用例', aiReview: true, humanReview: false, manualTrigger: true, threshold: 75 },
      { stage: '开发方案', aiReview: true, humanReview: false, manualTrigger: true, threshold: 75 },
    ],
    notifications: {
      stageComplete: true,
      aiReviewComplete: true,
      humanReviewRequest: true,
      devComplete: true,
      deliverySuccess: false,
      errorAlert: true,
    },
    pipeline: {
      stages: [
        { id: 1, name: '需求分析', icon: 'FileText', status: 'complete', hasAiReview: true, aiReviewStatus: 'complete' },
        { id: 2, name: 'BRD', icon: 'BookOpen', status: 'complete', hasAiReview: true, aiReviewStatus: 'complete' },
        { id: 3, name: 'PRD', icon: 'FileText', status: 'progress', hasAiReview: true, aiReviewStatus: 'progress' },
        { id: 4, name: '测试用例', icon: 'CheckSquare', status: 'ai-review', hasAiReview: true, aiReviewStatus: 'progress' },
        { id: 5, name: '开发方案', icon: 'Code', status: 'pending', hasAiReview: false, aiReviewStatus: null },
        { id: 6, name: '开发', icon: 'Terminal', status: 'pending', hasAiReview: false, aiReviewStatus: null },
        { id: 7, name: 'Code Review', icon: 'Search', status: 'pending', hasAiReview: true, aiReviewStatus: null },
        { id: 8, name: '自动化测试', icon: 'Zap', status: 'pending', hasAiReview: false, aiReviewStatus: null },
        { id: 9, name: '交付', icon: 'Package', status: 'pending', hasAiReview: false, aiReviewStatus: null },
      ],
    },
    activities: [
      { icon: 'CheckCircle', text: 'BRD文档 AI评审通过', time: '10分钟前', color: 'var(--color-success)' },
      { icon: 'Bot', text: 'PRD-Writer 开始生成用户故事模块', time: '25分钟前', color: 'var(--color-progress)' },
      { icon: 'AlertTriangle', text: '需求分析阶段 人工评审请求', time: '1小时前', color: 'var(--color-human-review)' },
      { icon: 'GitBranch', text: '新功能分支 feature/chat-engine 已创建', time: '2小时前', color: 'var(--fg-tertiary)' },
      { icon: 'Users', text: '王磊 加入项目团队', time: '3小时前', color: 'var(--fg-tertiary)' },
    ],
  },
  {
    id: 'p2',
    name: '数据中台重构',
    stage: '开发',
    progress: 42,
    status: 'active',
    members: ['李华', '王磊'],
    agents: [
      { name: 'BRD-Writer', model: 'GPT-4o', stage: 'BRD生成', status: 'idle', tasks: 0, enabled: true },
      { name: 'Code-Architect', model: 'GPT-4o', stage: '开发方案', status: 'running', tasks: 2, enabled: true },
      { name: 'Code-Reviewer', model: 'Claude 3.5 Sonnet', stage: 'Code Review', status: 'running', tasks: 4, enabled: true },
      { name: 'Data-Modeler', model: 'DeepSeek V3', stage: '数据建模', status: 'idle', tasks: 0, enabled: true },
    ],
    skills: [
      { name: 'Code-Review-Expert', desc: '代码质量审查和最佳实践检查', stage: 'Code Review', enabled: true },
      { name: 'Architecture-Planner', desc: '系统架构设计和技术选型', stage: '开发方案', enabled: true },
      { name: 'Data-Model-Generator', desc: '数据库模型设计和ER图生成', stage: '数据建模', enabled: true },
    ],
    rules: [
      { name: '代码风格规则', desc: '强制Java/Kotlin代码风格统一', stage: '开发', enabled: true },
      { name: 'API规范规则', desc: 'REST API设计必须符合OpenAPI 3.0规范', stage: '开发', enabled: true },
      { name: '数据一致性规则', desc: '所有数据变更必须通过事务保证一致性', stage: '数据建模', enabled: true },
      { name: '性能基线规则', desc: '核心查询响应时间不超过200ms', stage: '自动化测试', enabled: false },
    ],
    mcpTools: [
      { name: 'Code-base MCP', desc: '代码图谱索引和知识问答', enabled: true },
      { name: 'Git MCP', desc: 'Git操作集成（clone/branch/merge）', enabled: true },
      { name: 'Slack MCP', desc: 'Slack通知推送', enabled: true },
    ],
    modelMatrix: [
      { stage: '需求分析', genModel: 'Claude 3.5 Sonnet', reviewModel: 'GPT-4o-mini', genTemp: 0.6, reviewTemp: 0.3, tokens: '15.2k', avgTime: '9.8s', passRate: '89%', status: 'connected' },
      { stage: 'BRD生成', genModel: 'Claude 3.5 Sonnet', reviewModel: 'GPT-4o', genTemp: 0.6, reviewTemp: 0.3, tokens: '32.1k', avgTime: '18.2s', passRate: '86%', status: 'connected' },
      { stage: 'PRD生成', genModel: 'Claude 3.5 Sonnet', reviewModel: 'GPT-4o', genTemp: 0.5, reviewTemp: 0.3, tokens: '48.7k', avgTime: '24.5s', passRate: '83%', status: 'connected' },
      { stage: '测试用例', genModel: 'DeepSeek V3', reviewModel: 'GPT-4o-mini', genTemp: 0.4, reviewTemp: 0.2, tokens: '22.3k', avgTime: '14.1s', passRate: '91%', status: 'connected' },
      { stage: '开发方案', genModel: 'GPT-4o', reviewModel: 'Claude 3.5 Sonnet', genTemp: 0.6, reviewTemp: 0.3, tokens: '41.5k', avgTime: '20.3s', passRate: '80%', status: 'connected' },
      { stage: '开发', genModel: 'GPT-4o', reviewModel: '—', genTemp: 0.3, reviewTemp: null, tokens: '189.2k', avgTime: '52.1s', passRate: '—', status: 'connected' },
      { stage: 'Code Review', genModel: 'Claude 3.5 Sonnet', reviewModel: '—', genTemp: 0.3, reviewTemp: null, tokens: '78.4k', avgTime: '31.2s', passRate: '—', status: 'connected' },
      { stage: '自动化测试', genModel: 'DeepSeek V3', reviewModel: '—', genTemp: 0.2, reviewTemp: null, tokens: '28.9k', avgTime: '38.4s', passRate: '—', status: 'connected' },
    ],
    reviewGates: [
      { stage: '需求分析', aiReview: true, humanReview: true, manualTrigger: true, threshold: 85 },
      { stage: 'BRD', aiReview: true, humanReview: true, manualTrigger: true, threshold: 80 },
      { stage: 'PRD', aiReview: true, humanReview: true, manualTrigger: false, threshold: 80 },
      { stage: '测试用例', aiReview: true, humanReview: true, manualTrigger: true, threshold: 75 },
      { stage: '开发方案', aiReview: true, humanReview: true, manualTrigger: true, threshold: 80 },
    ],
    notifications: {
      stageComplete: true,
      aiReviewComplete: true,
      humanReviewRequest: true,
      devComplete: true,
      deliverySuccess: true,
      errorAlert: true,
    },
    pipeline: {
      stages: [
        { id: 1, name: '需求分析', icon: 'FileText', status: 'complete', hasAiReview: true, aiReviewStatus: 'complete' },
        { id: 2, name: 'BRD', icon: 'BookOpen', status: 'complete', hasAiReview: true, aiReviewStatus: 'complete' },
        { id: 3, name: 'PRD', icon: 'FileText', status: 'complete', hasAiReview: true, aiReviewStatus: 'complete' },
        { id: 4, name: '测试用例', icon: 'CheckSquare', status: 'complete', hasAiReview: true, aiReviewStatus: 'complete' },
        { id: 5, name: '开发方案', icon: 'Code', status: 'complete', hasAiReview: true, aiReviewStatus: 'complete' },
        { id: 6, name: '开发', icon: 'Terminal', status: 'progress', hasAiReview: false, aiReviewStatus: null },
        { id: 7, name: 'Code Review', icon: 'Search', status: 'pending', hasAiReview: true, aiReviewStatus: null },
        { id: 8, name: '自动化测试', icon: 'Zap', status: 'pending', hasAiReview: false, aiReviewStatus: null },
        { id: 9, name: '交付', icon: 'Package', status: 'pending', hasAiReview: false, aiReviewStatus: null },
      ],
    },
    activities: [
      { icon: 'Terminal', text: 'Data-Architect 正在生成数据迁移方案', time: '5分钟前', color: 'var(--color-progress)' },
      { icon: 'CheckCircle', text: '开发方案评审通过', time: '30分钟前', color: 'var(--color-success)' },
      { icon: 'GitBranch', text: '分支 feature/data-migration 已推送', time: '1小时前', color: 'var(--fg-tertiary)' },
    ],
  },
  {
    id: 'p3',
    name: '移动端App升级',
    stage: '测试用例',
    progress: 35,
    status: 'active',
    members: ['张明', '王磊'],
    agents: [
      { name: 'PRD-Writer', model: 'Claude 3.5 Sonnet', stage: 'PRD生成', status: 'idle', tasks: 0, enabled: true },
      { name: 'Test-Generator', model: 'DeepSeek V3', stage: '测试用例', status: 'running', tasks: 2, enabled: true },
      { name: 'UI-Reviewer', model: 'GPT-4o', stage: 'UI评审', status: 'idle', tasks: 0, enabled: true },
    ],
    skills: [
      { name: 'Test-Case-Writer', desc: '基于PRD自动生成测试用例', stage: '测试用例', enabled: true },
      { name: 'UI-Review-Expert', desc: '移动端UI/UX评审和一致性检查', stage: 'UI评审', enabled: true },
    ],
    rules: [
      { name: '移动端适配规则', desc: '确保所有页面适配主流移动设备分辨率', stage: 'UI评审', enabled: true },
      { name: '性能规则', desc: '首屏加载时间不超过2秒', stage: '自动化测试', enabled: true },
    ],
    mcpTools: [
      { name: 'Code-base MCP', desc: '代码图谱索引和知识问答', enabled: true },
      { name: 'Git MCP', desc: 'Git操作集成（clone/branch/merge）', enabled: true },
      { name: 'Figma MCP', desc: 'Figma设计稿同步和标注', enabled: true },
    ],
    modelMatrix: [
      { stage: '需求分析', genModel: 'GPT-4o', reviewModel: 'GPT-4o-mini', genTemp: 0.7, reviewTemp: 0.3, tokens: '10.1k', avgTime: '7.5s', passRate: '92%', status: 'connected' },
      { stage: 'BRD生成', genModel: 'GPT-4o', reviewModel: 'GPT-4o-mini', genTemp: 0.7, reviewTemp: 0.3, tokens: '24.3k', avgTime: '13.8s', passRate: '90%', status: 'connected' },
      { stage: 'PRD生成', genModel: 'Claude 3.5 Sonnet', reviewModel: 'GPT-4o', genTemp: 0.6, reviewTemp: 0.3, tokens: '38.9k', avgTime: '19.7s', passRate: '87%', status: 'connected' },
      { stage: '测试用例', genModel: 'DeepSeek V3', reviewModel: 'GPT-4o-mini', genTemp: 0.5, reviewTemp: 0.2, tokens: '16.2k', avgTime: '11.3s', passRate: '94%', status: 'connected' },
      { stage: '开发方案', genModel: 'GPT-4o', reviewModel: 'Claude 3.5 Sonnet', genTemp: 0.7, reviewTemp: 0.3, tokens: '30.8k', avgTime: '16.5s', passRate: '84%', status: 'connected' },
      { stage: '开发', genModel: 'Claude 3.5 Sonnet', reviewModel: '—', genTemp: 0.4, reviewTemp: null, tokens: '120.5k', avgTime: '40.8s', passRate: '—', status: 'connected' },
      { stage: 'Code Review', genModel: 'GPT-4o', reviewModel: '—', genTemp: 0.3, reviewTemp: null, tokens: '55.2k', avgTime: '25.1s', passRate: '—', status: 'connected' },
      { stage: '自动化测试', genModel: 'DeepSeek V3', reviewModel: '—', genTemp: 0.2, reviewTemp: null, tokens: '20.7k', avgTime: '32.3s', passRate: '—', status: 'connected' },
    ],
    reviewGates: [
      { stage: '需求分析', aiReview: true, humanReview: true, manualTrigger: true, threshold: 80 },
      { stage: 'BRD', aiReview: true, humanReview: false, manualTrigger: true, threshold: 75 },
      { stage: 'PRD', aiReview: true, humanReview: true, manualTrigger: true, threshold: 80 },
      { stage: '测试用例', aiReview: true, humanReview: false, manualTrigger: false, threshold: 75 },
      { stage: '开发方案', aiReview: true, humanReview: false, manualTrigger: true, threshold: 75 },
    ],
    notifications: {
      stageComplete: true,
      aiReviewComplete: false,
      humanReviewRequest: true,
      devComplete: true,
      deliverySuccess: false,
      errorAlert: true,
    },
    pipeline: {
      stages: [
        { id: 1, name: '需求分析', icon: 'FileText', status: 'complete', hasAiReview: true, aiReviewStatus: 'complete' },
        { id: 2, name: 'BRD', icon: 'BookOpen', status: 'complete', hasAiReview: true, aiReviewStatus: 'complete' },
        { id: 3, name: 'PRD', icon: 'FileText', status: 'complete', hasAiReview: true, aiReviewStatus: 'complete' },
        { id: 4, name: '测试用例', icon: 'CheckSquare', status: 'progress', hasAiReview: true, aiReviewStatus: 'progress' },
        { id: 5, name: '开发方案', icon: 'Code', status: 'pending', hasAiReview: false, aiReviewStatus: null },
        { id: 6, name: '开发', icon: 'Terminal', status: 'pending', hasAiReview: false, aiReviewStatus: null },
        { id: 7, name: 'Code Review', icon: 'Search', status: 'pending', hasAiReview: true, aiReviewStatus: null },
        { id: 8, name: '自动化测试', icon: 'Zap', status: 'pending', hasAiReview: false, aiReviewStatus: null },
        { id: 9, name: '交付', icon: 'Package', status: 'pending', hasAiReview: false, aiReviewStatus: null },
      ],
    },
    activities: [
      { icon: 'Bot', text: 'Test-Generator 正在生成移动端测试用例', time: '15分钟前', color: 'var(--color-progress)' },
      { icon: 'CheckCircle', text: 'PRD文档已生成并通过评审', time: '2小时前', color: 'var(--color-success)' },
    ],
  },
  {
    id: 'p4',
    name: '内部运维平台',
    stage: '需求分析',
    progress: 12,
    status: 'planning',
    members: ['李华'],
    agents: [
      { name: 'BRD-Writer', model: 'GPT-4o', stage: 'BRD生成', status: 'idle', tasks: 0, enabled: true },
      { name: 'PRD-Writer', model: 'GPT-4o', stage: 'PRD生成', status: 'idle', tasks: 0, enabled: true },
    ],
    skills: [
      { name: 'PRD-Generator', desc: '自动生成PRD文档，支持多种模板', stage: 'PRD生成', enabled: true },
    ],
    rules: [
      { name: '安全审计规则', desc: '所有运维操作必须记录审计日志', stage: '开发', enabled: true },
      { name: '权限控制规则', desc: 'RBAC权限模型，最小权限原则', stage: '开发方案', enabled: true },
    ],
    mcpTools: [
      { name: 'Code-base MCP', desc: '代码图谱索引和知识问答', enabled: true },
      { name: 'Git MCP', desc: 'Git操作集成（clone/branch/merge）', enabled: true },
    ],
    modelMatrix: [
      { stage: '需求分析', genModel: 'GPT-4o', reviewModel: 'GPT-4o-mini', genTemp: 0.7, reviewTemp: 0.3, tokens: '8.6k', avgTime: '6.9s', passRate: '93%', status: 'connected' },
      { stage: 'BRD生成', genModel: 'GPT-4o', reviewModel: 'GPT-4o-mini', genTemp: 0.7, reviewTemp: 0.3, tokens: '20.1k', avgTime: '12.4s', passRate: '91%', status: 'connected' },
      { stage: 'PRD生成', genModel: 'GPT-4o', reviewModel: 'GPT-4o-mini', genTemp: 0.6, reviewTemp: 0.3, tokens: '35.4k', avgTime: '17.8s', passRate: '89%', status: 'connected' },
      { stage: '测试用例', genModel: 'GPT-4o', reviewModel: 'GPT-4o-mini', genTemp: 0.5, reviewTemp: 0.2, tokens: '14.7k', avgTime: '10.2s', passRate: '95%', status: 'connected' },
      { stage: '开发方案', genModel: 'GPT-4o', reviewModel: 'GPT-4o-mini', genTemp: 0.6, reviewTemp: 0.3, tokens: '28.3k', avgTime: '15.1s', passRate: '86%', status: 'connected' },
      { stage: '开发', genModel: 'GPT-4o', reviewModel: '—', genTemp: 0.3, reviewTemp: null, tokens: '95.2k', avgTime: '35.6s', passRate: '—', status: 'connected' },
      { stage: 'Code Review', genModel: 'GPT-4o', reviewModel: '—', genTemp: 0.3, reviewTemp: null, tokens: '42.1k', avgTime: '20.8s', passRate: '—', status: 'connected' },
      { stage: '自动化测试', genModel: 'GPT-4o', reviewModel: '—', genTemp: 0.2, reviewTemp: null, tokens: '18.3k', avgTime: '28.5s', passRate: '—', status: 'connected' },
    ],
    reviewGates: [
      { stage: '需求分析', aiReview: true, humanReview: true, manualTrigger: true, threshold: 85 },
      { stage: 'BRD', aiReview: true, humanReview: true, manualTrigger: true, threshold: 85 },
      { stage: 'PRD', aiReview: true, humanReview: true, manualTrigger: true, threshold: 80 },
      { stage: '测试用例', aiReview: true, humanReview: true, manualTrigger: true, threshold: 80 },
      { stage: '开发方案', aiReview: true, humanReview: true, manualTrigger: true, threshold: 80 },
    ],
    notifications: {
      stageComplete: true,
      aiReviewComplete: true,
      humanReviewRequest: true,
      devComplete: false,
      deliverySuccess: false,
      errorAlert: true,
    },
    pipeline: {
      stages: [
        { id: 1, name: '需求分析', icon: 'FileText', status: 'progress', hasAiReview: true, aiReviewStatus: 'progress' },
        { id: 2, name: 'BRD', icon: 'BookOpen', status: 'pending', hasAiReview: true, aiReviewStatus: null },
        { id: 3, name: 'PRD', icon: 'FileText', status: 'pending', hasAiReview: true, aiReviewStatus: null },
        { id: 4, name: '测试用例', icon: 'CheckSquare', status: 'pending', hasAiReview: true, aiReviewStatus: null },
        { id: 5, name: '开发方案', icon: 'Code', status: 'pending', hasAiReview: false, aiReviewStatus: null },
        { id: 6, name: '开发', icon: 'Terminal', status: 'pending', hasAiReview: false, aiReviewStatus: null },
        { id: 7, name: 'Code Review', icon: 'Search', status: 'pending', hasAiReview: true, aiReviewStatus: null },
        { id: 8, name: '自动化测试', icon: 'Zap', status: 'pending', hasAiReview: false, aiReviewStatus: null },
        { id: 9, name: '交付', icon: 'Package', status: 'pending', hasAiReview: false, aiReviewStatus: null },
      ],
    },
    activities: [
      { icon: 'FileText', text: '需求分析文档正在生成中', time: '3分钟前', color: 'var(--color-progress)' },
    ],
  },
]

// ─── Pipeline stage names (imported from centralized definitions) ─
const stageNames = STAGE_NAMES

// ─── Deliveries (需求交付记录，web demo seed) ────────────────
const deliveries = [
  {
    id: 'd1',
    title: '智能客服对话引擎升级',
    description: '支持多轮对话、意图识别增强、知识库实时检索',
    priority: 'P0',
    projectId: 'p1',
    assignee: '张明',
    currentStageIndex: 2, // PRD stage (0-based)
    createdAt: '2026-06-25',
  },
  {
    id: 'd2',
    title: '数据中台ETL流程优化',
    description: '重构ETL管道，支持实时流处理，降低延迟至秒级',
    priority: 'P1',
    projectId: 'p2',
    assignee: '李华',
    currentStageIndex: 5, // 开发 stage
    createdAt: '2026-06-20',
  },
  {
    id: 'd3',
    title: '移动端消息推送SDK',
    description: '集成Firebase和APNs，支持离线消息和本地通知',
    priority: 'P2',
    projectId: 'p1',
    assignee: '王磊',
    currentStageIndex: 8, // 交付 stage (completed)
    createdAt: '2026-06-10',
  },
]

// ─── Top-level Agents (global, decoupled from projects) ──────────
// NOT demo data: these are the system default capability definitions.
// DEFAULT_STAGE_AGENTS (src/data/stages.js) binds pipeline stages to
// a1~a5 by id and getStageConfig resolves them, so they are kept in
// BOTH web and tauri modes.
const agents = [
  {
    id: 'a1',
    name: 'BRD-Writer',
    description: '专业BRD文档撰写智能体，擅长需求分析和商业方案编写',
    model: 'GPT-4o',
    systemPrompt: '你是一个专业的BRD撰写助手...',
    temperature: 0.7,
    skills: ['PRD-Generator', 'Requirement-Analyzer'],
    mcpTools: ['Code-base MCP', 'Jira MCP'],
    rules: ['PRD完整性规则'],
    enabled: true,
    createdAt: '2026-06-01',
    assignedStages: [], // { projectId, stageId } — 记录分配到哪些项目的哪些阶段
  },
  {
    id: 'a2',
    name: 'PRD-Writer',
    description: 'PRD文档撰写专家，支持多种产品模板',
    model: 'Claude 3.5 Sonnet',
    systemPrompt: '你是专业的PRD撰写助手...',
    temperature: 0.6,
    skills: ['PRD-Generator'],
    mcpTools: ['Code-base MCP'],
    rules: ['PRD完整性规则'],
    enabled: true,
    createdAt: '2026-06-01',
    assignedStages: [],
  },
  {
    id: 'a3',
    name: 'Test-Generator',
    description: '测试用例自动生成智能体，覆盖功能和边界测试',
    model: 'DeepSeek V3',
    systemPrompt: '你是测试用例生成专家...',
    temperature: 0.5,
    skills: ['Test-Case-Writer'],
    mcpTools: ['Code-base MCP'],
    rules: ['测试覆盖率规则'],
    enabled: true,
    createdAt: '2026-06-01',
    assignedStages: [],
  },
  {
    id: 'a4',
    name: 'Code-Architect',
    description: '系统架构设计和技术选型智能体',
    model: 'GPT-4o',
    systemPrompt: '你是系统架构师...',
    temperature: 0.7,
    skills: ['Architecture-Planner'],
    mcpTools: ['Code-base MCP', 'Git MCP'],
    rules: [],
    enabled: true,
    createdAt: '2026-06-01',
    assignedStages: [],
  },
  {
    id: 'a5',
    name: 'Code-Reviewer',
    description: '代码质量审查智能体，检查最佳实践',
    model: 'Claude 3.5 Sonnet',
    systemPrompt: '你是代码审查专家...',
    temperature: 0.3,
    skills: ['Code-Review-Expert'],
    mcpTools: ['Code-base MCP', 'Git MCP'],
    rules: ['代码风格规则'],
    enabled: true,
    createdAt: '2026-06-01',
    assignedStages: [],
  },
  {
    id: 'a6',
    name: 'AI-Reviewer-QA',
    description: 'AI质量评审智能体，多维度评估交付物质量',
    model: 'GPT-4o-mini',
    systemPrompt: '你是质量评审专家...',
    temperature: 0.3,
    skills: ['Code-Review-Expert'],
    mcpTools: [],
    rules: [],
    enabled: true,
    createdAt: '2026-06-01',
    assignedStages: [],
  },
]

// ─── Initial state (dual runtime) ────────────────────────────────
// Ensure all initial projects have stageConfigs
const projectsWithConfigs = projects.map(p => ({
  ...p,
  stageConfigs: p.stageConfigs || buildDefaultStageConfigs(),
}))

// Neutral placeholder shown before the user creates a real project.
// Not part of state.projects — many components dereference currentProject
// unconditionally (TopBar/Settings/Pipeline/...), so it must never be null.
// Exported so UI entries can detect the placeholder without magic strings.
export const EMPTY_WORKSPACE_PROJECT_ID = 'p-empty-workspace'

function buildEmptyWorkspaceProject() {
  return {
    id: EMPTY_WORKSPACE_PROJECT_ID,
    name: '未创建项目',
    stage: '需求分析',
    progress: 0,
    status: 'planning',
    members: [],
    agents: [],
    skills: [],
    rules: [],
    mcpTools: [],
    modelMatrix: [],
    reviewGates: [],
    notifications: {
      stageComplete: true,
      aiReviewComplete: true,
      humanReviewRequest: true,
      devComplete: false,
      deliverySuccess: false,
      errorAlert: true,
    },
    pipeline: { stages: [] },
    activities: [],
    stageConfigs: buildDefaultStageConfigs(),
  }
}

/**
 * Build the initial state for the given runtime mode.
 *  - 'tauri' (desktop/production): NO demo business data — users holds only
 *    a local workspace user (first-run experience), projects/deliveries are
 *    empty. System default agents are kept (functional stage bindings).
 *  - 'web': demo seed kept intact (protects Playwright e2e).
 * Exported for unit tests.
 */
export function buildInitialState(mode = detectRuntimeMode()) {
  const base = {
    agents,
    isAuthenticated: true,
    toasts: [],
    toastIdCounter: 0,
    // User-level preferences (not project-scoped)
    devMode: 'bridge-agent', // 'uri-scheme' | 'bridge-agent' | 'cloud' | 'spec'
    // Deliverable content storage: { [deliveryId]: { [stageId]: { content, review, generatedAt } } }
    stageDeliverables: {},
  }

  if (mode === 'tauri') {
    const localUser = { id: 'u-local', name: '我的工作区', role: '本机用户', roleTag: '本机', avatarInitial: '我' }
    return {
      ...base,
      users: [localUser],
      projects: [],
      deliveries: [],
      currentUser: localUser,
      currentProject: buildEmptyWorkspaceProject(),
    }
  }

  return {
    ...base,
    users,
    projects: projectsWithConfigs,
    deliveries,
    currentUser: users[0],
    currentProject: projectsWithConfigs[0],
  }
}

const initialState = buildInitialState()

// Project-scoped write actions that must not target the read-only placeholder
// project — otherwise the edits look accepted but are silently lost.
const PROJECT_WRITE_ACTIONS = new Set([
  'UPDATE_PROJECT_CONFIG',
  'TOGGLE_PROJECT_CONFIG_ITEM',
  'TOGGLE_REVIEW_GATE',
  'TOGGLE_NOTIFICATION',
  'UPDATE_STAGE_CONFIG',
  'TOGGLE_STAGE_CONFIG_ITEM',
  'UPDATE_PROJECT_FLOW',
  'UPDATE_FLOW_NODE',
  'RESET_PROJECT_FLOW',
])

function appReducer(state, action) {
  // Reject writes against the empty-workspace placeholder (see above)
  if (PROJECT_WRITE_ACTIONS.has(action.type)
    && action.payload?.projectId === EMPTY_WORKSPACE_PROJECT_ID) {
    return state
  }

  switch (action.type) {
    case 'SET_CURRENT_USER':
      return { ...state, currentUser: action.payload }

    case 'SET_CURRENT_PROJECT':
      return { ...state, currentProject: action.payload }

    case 'SET_DEV_MODE':
      return { ...state, devMode: action.payload }

    case 'ADD_TOAST': {
      const id = state.toastIdCounter + 1
      return {
        ...state,
        toastIdCounter: id,
        toasts: [...state.toasts, { id, message: action.payload.message, type: action.payload.type || 'info' }],
      }
    }

    case 'REMOVE_TOAST':
      return {
        ...state,
        toasts: state.toasts.filter(t => t.id !== action.payload),
      }

    case 'UPDATE_PROJECT_CONFIG': {
      const { projectId, configType, data } = action.payload
      const updatedProjects = state.projects.map(p => {
        if (p.id !== projectId) return p
        const updated = { ...p, [configType]: data }
        return updated
      })
      const updatedCurrentProject = state.currentProject.id === projectId
        ? { ...state.currentProject, [configType]: data }
        : state.currentProject
      return { ...state, projects: updatedProjects, currentProject: updatedCurrentProject }
    }

    case 'TOGGLE_PROJECT_CONFIG_ITEM': {
      const { projectId, configType, itemName } = action.payload
      const updatedProjects = state.projects.map(p => {
        if (p.id !== projectId) return p
        const items = p[configType]
        if (!Array.isArray(items)) return p
        const updatedItems = items.map(item =>
          item.name === itemName ? { ...item, enabled: !item.enabled } : item
        )
        return { ...p, [configType]: updatedItems }
      })
      const currentItems = state.currentProject[configType]
      let updatedCurrentProject = state.currentProject
      if (state.currentProject.id === projectId && Array.isArray(currentItems)) {
        const updatedItems = currentItems.map(item =>
          item.name === itemName ? { ...item, enabled: !item.enabled } : item
        )
        updatedCurrentProject = { ...state.currentProject, [configType]: updatedItems }
      }
      return { ...state, projects: updatedProjects, currentProject: updatedCurrentProject }
    }

    case 'TOGGLE_REVIEW_GATE': {
      const { projectId, stageId, field } = action.payload
      const updateProjectGate = (project) => {
        if (project.id !== projectId) return project
        // Ensure customFlow exists; if not, create from default
        let flow = (project.customFlow && project.customFlow.length > 0)
          ? [...project.customFlow]
          : buildDefaultFlowConfig()
        // Find the node matching stageId
        let nodeIndex = flow.findIndex(n => n.stage === stageId)
        if (nodeIndex === -1) return project
        const node = { ...flow[nodeIndex] }
        const gate = { ...(node.gate || { aiReview: false, humanReview: false, manualTrigger: true, threshold: 75 }) }
        if (field === 'threshold') {
          // threshold is set via SET_FLOW_NODE, skip here
          return project
        }
        gate[field] = !gate[field]
        node.gate = gate
        flow[nodeIndex] = node
        return { ...project, customFlow: flow }
      }
      const updatedProjects = state.projects.map(updateProjectGate)
      const updatedCurrentProject = state.currentProject.id === projectId
        ? updateProjectGate(state.currentProject)
        : state.currentProject
      return { ...state, projects: updatedProjects, currentProject: updatedCurrentProject }
    }

    case 'TOGGLE_NOTIFICATION': {
      const { projectId, key } = action.payload
      const updatedProjects = state.projects.map(p => {
        if (p.id !== projectId) return p
        return { ...p, notifications: { ...p.notifications, [key]: !p.notifications[key] } }
      })
      let updatedCurrentProject = state.currentProject
      if (state.currentProject.id === projectId) {
        updatedCurrentProject = {
          ...state.currentProject,
          notifications: { ...state.currentProject.notifications, [key]: !state.currentProject.notifications[key] },
        }
      }
      return { ...state, projects: updatedProjects, currentProject: updatedCurrentProject }
    }

    case 'ADD_PROJECT': {
      const newProject = action.payload
      // Ensure stageConfigs exists
      if (!newProject.stageConfigs) {
        newProject.stageConfigs = buildDefaultStageConfigs()
      }
      // First real project replaces the empty-workspace placeholder
      const currentProject = state.currentProject?.id === EMPTY_WORKSPACE_PROJECT_ID || state.projects.length === 0
        ? newProject
        : state.currentProject
      return { ...state, projects: [...state.projects, newProject], currentProject }
    }

    case 'ADD_USER': {
      const newUser = action.payload
      return { ...state, users: [...state.users, newUser] }
    }

    case 'REMOVE_USER': {
      const userId = action.payload
      return { ...state, users: state.users.filter(u => u.id !== userId) }
    }

    case 'LOGIN': {
      const user = action.payload
      return { ...state, currentUser: user, isAuthenticated: true }
    }

    case 'LOGOUT':
      return { ...state, currentUser: null, isAuthenticated: false }

    case 'CREATE_DELIVERY': {
      const newDelivery = action.payload
      return { ...state, deliveries: [...state.deliveries, newDelivery] }
    }

    case 'ADVANCE_DELIVERY_STAGE': {
      const deliveryId = action.payload
      const updatedDeliveries = state.deliveries.map(d => {
        if (d.id !== deliveryId || d.currentStageIndex >= 8) return d
        return { ...d, currentStageIndex: d.currentStageIndex + 1 }
      })
      return { ...state, deliveries: updatedDeliveries }
    }

    case 'UPDATE_STAGE_DELIVERABLE': {
      const { deliveryId, stageId, content } = action.payload
      const existing = state.stageDeliverables[deliveryId] || {}
      return {
        ...state,
        stageDeliverables: {
          ...state.stageDeliverables,
          [deliveryId]: {
            ...existing,
            [stageId]: {
              content,
              generatedAt: new Date().toISOString(),
            },
          },
        },
      }
    }

    case 'UPDATE_STAGE_REVIEW': {
      const { deliveryId, stageId, review } = action.payload
      const existing = state.stageDeliverables[deliveryId] || {}
      const stageData = existing[stageId] || { content: '', generatedAt: new Date().toISOString() }
      return {
        ...state,
        stageDeliverables: {
          ...state.stageDeliverables,
          [deliveryId]: {
            ...existing,
            [stageId]: { ...stageData, review },
          },
        },
      }
    }

    case 'UPDATE_STAGE_CONFIG': {
      const { projectId, stageId, configType, data } = action.payload
      const updateProjectStageConfigs = (project) => {
        if (project.id !== projectId) return project
        const stageConfigs = { ...(project.stageConfigs || buildDefaultStageConfigs()) }
        const currentStageConfig = stageConfigs[stageId] || { skills: [], mcps: [], rules: [], model: '', temperature: 0.7, prompt: '' }
        stageConfigs[stageId] = { ...currentStageConfig, [configType]: data }
        return { ...project, stageConfigs }
      }
      const updatedProjects = state.projects.map(updateProjectStageConfigs)
      const updatedCurrentProject = state.currentProject.id === projectId
        ? updateProjectStageConfigs(state.currentProject)
        : state.currentProject
      return { ...state, projects: updatedProjects, currentProject: updatedCurrentProject }
    }

    case 'TOGGLE_STAGE_CONFIG_ITEM': {
      const { projectId, stageId, configType, itemName } = action.payload
      const updateProjectStageConfigs = (project) => {
        if (project.id !== projectId) return project
        const stageConfigs = { ...(project.stageConfigs || buildDefaultStageConfigs()) }
        const currentStageConfig = stageConfigs[stageId] || { skills: [], mcps: [], rules: [], model: '', temperature: 0.7, prompt: '' }
        const items = currentStageConfig[configType] || []
        const updatedItems = items.map(item =>
          item.name === itemName ? { ...item, enabled: !item.enabled } : item
        )
        stageConfigs[stageId] = { ...currentStageConfig, [configType]: updatedItems }
        return { ...project, stageConfigs }
      }
      const updatedProjects = state.projects.map(updateProjectStageConfigs)
      const updatedCurrentProject = state.currentProject.id === projectId
        ? updateProjectStageConfigs(state.currentProject)
        : state.currentProject
      return { ...state, projects: updatedProjects, currentProject: updatedCurrentProject }
    }

    // ─── Project-level Custom Delivery Flow ───
    // Updates the project's customFlow: array of { stage, concept, label, agentId, gate }
    // This is the project's own delivery pipeline definition — not hardcoded.
    case 'UPDATE_PROJECT_FLOW': {
      const { projectId, customFlow } = action.payload
      const updateProjectFlow = (project) => {
        if (project.id !== projectId) return project
        return { ...project, customFlow }
      }
      const updatedProjects = state.projects.map(updateProjectFlow)
      const updatedCurrentProject = state.currentProject.id === projectId
        ? updateProjectFlow(state.currentProject)
        : state.currentProject
      return { ...state, projects: updatedProjects, currentProject: updatedCurrentProject }
    }

    // Update a single flow node's properties (agentId, gate, label, concept)
    case 'UPDATE_FLOW_NODE': {
      const { projectId, nodeIndex, data } = action.payload
      const updateProjectFlowNode = (project) => {
        if (project.id !== projectId) return project
        // Ensure customFlow exists; if not, create from default
        const flow = (project.customFlow && project.customFlow.length > 0)
          ? [...project.customFlow]
          : buildDefaultFlowConfig()
        if (nodeIndex < 0 || nodeIndex >= flow.length) return project
        flow[nodeIndex] = { ...flow[nodeIndex], ...data }
        return { ...project, customFlow: flow }
      }
      const updatedProjects = state.projects.map(updateProjectFlowNode)
      const updatedCurrentProject = state.currentProject.id === projectId
        ? updateProjectFlowNode(state.currentProject)
        : state.currentProject
      return { ...state, projects: updatedProjects, currentProject: updatedCurrentProject }
    }

    // Reset a project's flow back to the default template
    case 'RESET_PROJECT_FLOW': {
      const { projectId } = action.payload
      const resetProjectFlow = (project) => {
        if (project.id !== projectId) return project
        const { customFlow, ...rest } = project
        return rest
      }
      const updatedProjects = state.projects.map(resetProjectFlow)
      const updatedCurrentProject = state.currentProject.id === projectId
        ? resetProjectFlow(state.currentProject)
        : state.currentProject
      return { ...state, projects: updatedProjects, currentProject: updatedCurrentProject }
    }

    // ─── User Runtime Overrides (delivery-level, does not affect admin config) ───
    case 'ADD_DELIVERY_STAGE_OVERRIDE': {
      const { deliveryId, stageId, configType, item } = action.payload
      const updatedDeliveries = state.deliveries.map(d => {
        if (d.id !== deliveryId) return d
        const stageOverrides = { ...(d.stageOverrides || {}) }
        const stageOverride = stageOverrides[stageId] || { skills: [], mcps: [], rules: [], model: null, prompt: null }
        const items = stageOverride[configType] || []
        // Avoid duplicates
        if (items.some(i => i.name === item.name)) return d
        stageOverride[configType] = [...items, { ...item, enabled: true, userAdded: true }]
        stageOverrides[stageId] = stageOverride
        return { ...d, stageOverrides }
      })
      return { ...state, deliveries: updatedDeliveries }
    }

    case 'REMOVE_DELIVERY_STAGE_OVERRIDE': {
      const { deliveryId, stageId, configType, itemName } = action.payload
      const updatedDeliveries = state.deliveries.map(d => {
        if (d.id !== deliveryId) return d
        const stageOverrides = { ...(d.stageOverrides || {}) }
        const stageOverride = stageOverrides[stageId]
        if (!stageOverride) return d
        const items = stageOverride[configType] || []
        stageOverride[configType] = items.filter(i => i.name !== itemName)
        stageOverrides[stageId] = { ...stageOverride }
        return { ...d, stageOverrides }
      })
      return { ...state, deliveries: updatedDeliveries }
    }

    case 'SET_DELIVERY_STAGE_MODEL': {
      const { deliveryId, stageId, model } = action.payload
      const updatedDeliveries = state.deliveries.map(d => {
        if (d.id !== deliveryId) return d
        const stageOverrides = { ...(d.stageOverrides || {}) }
        const stageOverride = stageOverrides[stageId] || { skills: [], mcps: [], rules: [], model: null, prompt: null }
        stageOverride.model = model
        stageOverrides[stageId] = stageOverride
        return { ...d, stageOverrides }
      })
      return { ...state, deliveries: updatedDeliveries }
    }

    case 'SET_DELIVERY_STAGE_PROMPT': {
      const { deliveryId, stageId, prompt } = action.payload
      const updatedDeliveries = state.deliveries.map(d => {
        if (d.id !== deliveryId) return d
        const stageOverrides = { ...(d.stageOverrides || {}) }
        const stageOverride = stageOverrides[stageId] || { skills: [], mcps: [], rules: [], model: null, prompt: null }
        stageOverride.prompt = prompt
        stageOverrides[stageId] = stageOverride
        return { ...d, stageOverrides }
      })
      return { ...state, deliveries: updatedDeliveries }
    }

    // ─── Top-level Agent Management ───
    case 'ADD_AGENT': {
      const newAgent = action.payload
      return { ...state, agents: [...state.agents, newAgent] }
    }

    case 'UPDATE_AGENT': {
      const { agentId, data } = action.payload
      const updatedAgents = state.agents.map(a =>
        a.id === agentId ? { ...a, ...data } : a
      )
      return { ...state, agents: updatedAgents }
    }

    case 'DELETE_AGENT': {
      const agentId = action.payload
      const updatedAgents = state.agents.map(a =>
        a.id === agentId ? { ...a, enabled: false, assignedStages: [] } : a
      )
      return { ...state, agents: updatedAgents }
    }

    case 'ASSIGN_AGENT_TO_STAGE': {
      const { agentId, projectId, stageId } = action.payload
      const updatedAgents = state.agents.map(a => {
        if (a.id !== agentId) return a
        const exists = (a.assignedStages || []).some(
          s => s.projectId === projectId && s.stageId === stageId
        )
        if (exists) return a
        return { ...a, assignedStages: [...(a.assignedStages || []), { projectId, stageId }] }
      })
      return { ...state, agents: updatedAgents }
    }

    case 'UNASSIGN_AGENT_FROM_STAGE': {
      const { agentId, projectId, stageId } = action.payload
      const updatedAgents = state.agents.map(a => {
        if (a.id !== agentId) return a
        const assignedStages = (a.assignedStages || []).filter(
          s => !(s.projectId === projectId && s.stageId === stageId)
        )
        return { ...a, assignedStages }
      })
      return { ...state, agents: updatedAgents }
    }

    default:
      return state
  }
}

// ─── Context ─────────────────────────────────────────────────────
const AppContext = createContext(null)

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(appReducer, initialState)

  const setCurrentUser = useCallback((user) => {
    dispatch({ type: 'SET_CURRENT_USER', payload: user })
  }, [])

  const setCurrentProject = useCallback((project) => {
    dispatch({ type: 'SET_CURRENT_PROJECT', payload: project })
  }, [])

  const setDevMode = useCallback((mode) => {
    dispatch({ type: 'SET_DEV_MODE', payload: mode })
  }, [])

  const showToast = useCallback((message, type = 'info') => {
    dispatch({ type: 'ADD_TOAST', payload: { message, type } })
  }, [])

  const removeToast = useCallback((id) => {
    dispatch({ type: 'REMOVE_TOAST', payload: id })
  }, [])

  const updateProjectConfig = useCallback((projectId, configType, data) => {
    dispatch({ type: 'UPDATE_PROJECT_CONFIG', payload: { projectId, configType, data } })
  }, [])

  const toggleProjectConfigItem = useCallback((projectId, configType, itemName) => {
    dispatch({ type: 'TOGGLE_PROJECT_CONFIG_ITEM', payload: { projectId, configType, itemName } })
  }, [])

  const toggleReviewGate = useCallback((projectId, stageId, field) => {
    dispatch({ type: 'TOGGLE_REVIEW_GATE', payload: { projectId, stageId, field } })
  }, [])

  const toggleNotification = useCallback((projectId, key) => {
    dispatch({ type: 'TOGGLE_NOTIFICATION', payload: { projectId, key } })
  }, [])

  const addProject = useCallback((project) => {
    dispatch({ type: 'ADD_PROJECT', payload: project })
  }, [])

  const addUser = useCallback((user) => {
    dispatch({ type: 'ADD_USER', payload: user })
  }, [])

  const removeUser = useCallback((userId) => {
    dispatch({ type: 'REMOVE_USER', payload: userId })
  }, [])

  const login = useCallback((user) => {
    dispatch({ type: 'LOGIN', payload: user })
  }, [])

  const logout = useCallback(() => {
    dispatch({ type: 'LOGOUT' })
  }, [])

  const createDelivery = useCallback((delivery) => {
    dispatch({ type: 'CREATE_DELIVERY', payload: delivery })
  }, [])

  const advanceDeliveryStage = useCallback((deliveryId) => {
    dispatch({ type: 'ADVANCE_DELIVERY_STAGE', payload: deliveryId })
  }, [])

  const saveStageDeliverable = useCallback((deliveryId, stageId, content) => {
    dispatch({ type: 'UPDATE_STAGE_DELIVERABLE', payload: { deliveryId, stageId, content } })
  }, [])

  const saveStageReview = useCallback((deliveryId, stageId, review) => {
    dispatch({ type: 'UPDATE_STAGE_REVIEW', payload: { deliveryId, stageId, review } })
  }, [])

  const updateStageConfig = useCallback((projectId, stageId, configType, data) => {
    dispatch({ type: 'UPDATE_STAGE_CONFIG', payload: { projectId, stageId, configType, data } })
  }, [])

  const toggleStageConfigItem = useCallback((projectId, stageId, configType, itemName) => {
    dispatch({ type: 'TOGGLE_STAGE_CONFIG_ITEM', payload: { projectId, stageId, configType, itemName } })
  }, [])

  const getStageConfig = useCallback((projectId, stageId) => {
    const project = state.projects.find(p => p.id === projectId)
    const stageConfig = project?.stageConfigs?.[stageId]
    const stageDef = STAGE_DEFINITIONS.find(s => s.id === stageId)
    const baseConfig = stageConfig || stageDef?.defaultConfig || { skills: [], mcps: [], rules: [], model: '', temperature: 0.7, prompt: '' }

    // ── New unified model: check flow node's agentId first ──
    const flowConfig = getProjectFlowConfig(project)
    const flowNode = flowConfig.find(n => n.stage === stageId)
    if (flowNode?.agentId) {
      const agent = state.agents.find(a => a.id === flowNode.agentId)
      if (agent) {
        return {
          model: agent.model,
          temperature: agent.temperature,
          prompt: agent.systemPrompt || baseConfig.prompt || '',
          skills: (agent.skills || []).map(name => ({ name, enabled: true })),
          mcps: (agent.mcpTools || []).map(name => ({ name, enabled: true })),
          rules: (agent.rules || []).map(name => ({ name, enabled: true })),
          agent: agent,
          agentId: agent.id,
          agentName: agent.name,
        }
      }
    }

    // ── Fallback: legacy stageConfig / defaultConfig ──
    return baseConfig
  }, [state.projects, state.agents])

  // ─── Project-level Custom Delivery Flow ───
  const updateProjectFlow = useCallback((projectId, customFlow) => {
    dispatch({ type: 'UPDATE_PROJECT_FLOW', payload: { projectId, customFlow } })
  }, [])

  const resetProjectFlow = useCallback((projectId) => {
    dispatch({ type: 'RESET_PROJECT_FLOW', payload: { projectId } })
  }, [])

  // Update a single flow node's properties (agentId, gate, label, concept)
  const updateFlowNode = useCallback((projectId, nodeIndex, data) => {
    dispatch({ type: 'UPDATE_FLOW_NODE', payload: { projectId, nodeIndex, data } })
  }, [])

  // Get the flow node for a specific stage in a project (returns { stage, concept, label, agentId, gate })
  const getFlowNode = useCallback((projectId, stageId) => {
    const project = state.projects.find(p => p.id === projectId)
    const flowConfig = getProjectFlowConfig(project)
    return flowConfig.find(n => n.stage === stageId) || null
  }, [state.projects])

  // Get the gate settings for a specific stage in a project
  const getStageGate = useCallback((projectId, stageId) => {
    const node = getFlowNode(projectId, stageId)
    return node?.gate || { aiReview: false, humanReview: false, manualTrigger: true, threshold: 0 }
  }, [getFlowNode])

  // Get the effective flow config for the current project (or a specific project)
  // Resolves from DAG engine first, falls back to legacy customFlow
  const getFlowConfig = useCallback((project = null) => {
    const p = project || state.currentProject
    try {
      const dag = getProjectDAG(p)
      if (dag && dag.nodes && dag.nodes.length > 0) {
        return dagToFlowConfigFull(dag)
      }
    } catch (e) { /* DAG not available, fall back */ }
    return getProjectFlowConfig(p)
  }, [state.currentProject])

  // Get the effective stage list for the current project (or a specific project)
  // Resolves from DAG engine first, falls back to legacy getProjectStages
  const getProjectStageList = useCallback((project = null) => {
    const p = project || state.currentProject
    try {
      const dag = getProjectDAG(p)
      if (dag && dag.nodes && dag.nodes.length > 0) {
        return dagToStageList(dag)
      }
    } catch (e) { /* DAG not available, fall back */ }
    return getProjectStages(p)
  }, [state.currentProject])

  // ─── User Runtime Override management ───
  const addDeliveryStageOverride = useCallback((deliveryId, stageId, configType, item) => {
    dispatch({ type: 'ADD_DELIVERY_STAGE_OVERRIDE', payload: { deliveryId, stageId, configType, item } })
  }, [])

  const removeDeliveryStageOverride = useCallback((deliveryId, stageId, configType, itemName) => {
    dispatch({ type: 'REMOVE_DELIVERY_STAGE_OVERRIDE', payload: { deliveryId, stageId, configType, itemName } })
  }, [])

  const setDeliveryStageModel = useCallback((deliveryId, stageId, model) => {
    dispatch({ type: 'SET_DELIVERY_STAGE_MODEL', payload: { deliveryId, stageId, model } })
  }, [])

  const setDeliveryStagePrompt = useCallback((deliveryId, stageId, prompt) => {
    dispatch({ type: 'SET_DELIVERY_STAGE_PROMPT', payload: { deliveryId, stageId, prompt } })
  }, [])

  // ─── Top-level Agent Management ───
  const addAgent = useCallback((agent) => {
    dispatch({ type: 'ADD_AGENT', payload: agent })
  }, [])

  const updateAgent = useCallback((agentId, data) => {
    dispatch({ type: 'UPDATE_AGENT', payload: { agentId, data } })
  }, [])

  const deleteAgent = useCallback((agentId) => {
    dispatch({ type: 'DELETE_AGENT', payload: agentId })
  }, [])

  const assignAgentToStage = useCallback((agentId, projectId, stageId) => {
    dispatch({ type: 'ASSIGN_AGENT_TO_STAGE', payload: { agentId, projectId, stageId } })
  }, [])

  const unassignAgentFromStage = useCallback((agentId, projectId, stageId) => {
    dispatch({ type: 'UNASSIGN_AGENT_FROM_STAGE', payload: { agentId, projectId, stageId } })
  }, [])

  /**
   * Get the effective stage config = admin config + user runtime overrides.
   * Admin config (project.stageConfigs) is never modified by user actions.
   * If the flow node has an agentId, the agent's config is the base.
   * User overrides (delivery.stageOverrides) are merged on top.
   */
  const getEffectiveStageConfig = useCallback((projectId, stageId, deliveryId) => {
    const adminConfig = getStageConfig(projectId, stageId)
    if (!deliveryId) return adminConfig

    const delivery = state.deliveries.find(d => d.id === deliveryId)
    const override = delivery?.stageOverrides?.[stageId]
    if (!override) return adminConfig

    // Merge: admin/agent items + user-added items
    return {
      skills: [...(adminConfig.skills || []), ...(override.skills || [])],
      mcps: [...(adminConfig.mcps || []), ...(override.mcps || [])],
      rules: [...(adminConfig.rules || []), ...(override.rules || [])],
      model: override.model || adminConfig.model,
      temperature: adminConfig.temperature,
      prompt: override.prompt || adminConfig.prompt || '',
      agent: adminConfig.agent,
      agentId: adminConfig.agentId,
      agentName: adminConfig.agentName,
    }
  }, [state.deliveries, getStageConfig])

  const value = useMemo(() => ({
    users: state.users,
    projects: state.projects,
    deliveries: state.deliveries,
    agents: state.agents,
    stageNames,
    currentUser: state.currentUser,
    currentProject: state.currentProject,
    isAuthenticated: state.isAuthenticated,
    devMode: state.devMode,
    toasts: state.toasts,
    stageDeliverables: state.stageDeliverables,
    setCurrentUser,
    setCurrentProject,
    setDevMode,
    showToast,
    removeToast,
    updateProjectConfig,
    toggleProjectConfigItem,
    toggleReviewGate,
    toggleNotification,
    addProject,
    addUser,
    removeUser,
    login,
    logout,
    createDelivery,
    advanceDeliveryStage,
    saveStageDeliverable,
    saveStageReview,
    updateStageConfig,
    toggleStageConfigItem,
    getStageConfig,
    addDeliveryStageOverride,
    removeDeliveryStageOverride,
    setDeliveryStageModel,
    setDeliveryStagePrompt,
    getEffectiveStageConfig,
    // Top-level agent management
    addAgent,
    updateAgent,
    deleteAgent,
    assignAgentToStage,
    unassignAgentFromStage,
    // Project-level custom delivery flow
    updateProjectFlow,
    updateFlowNode,
    resetProjectFlow,
    getFlowConfig,
    getProjectStageList,
    getFlowNode,
    getStageGate,
    stageDefinitions: STAGE_DEFINITIONS,
  }), [state, setCurrentUser, setCurrentProject, setDevMode, showToast, removeToast, updateProjectConfig, toggleProjectConfigItem, toggleReviewGate, toggleNotification, addProject, addUser, removeUser, login, logout, createDelivery, advanceDeliveryStage, saveStageDeliverable, saveStageReview, updateStageConfig, toggleStageConfigItem, getStageConfig, addDeliveryStageOverride, removeDeliveryStageOverride, setDeliveryStageModel, setDeliveryStagePrompt, getEffectiveStageConfig, addAgent, updateAgent, deleteAgent, assignAgentToStage, unassignAgentFromStage, updateProjectFlow, updateFlowNode, resetProjectFlow, getFlowConfig, getProjectStageList, getFlowNode, getStageGate])

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  )
}

export function useApp() {
  const context = useContext(AppContext)
  if (!context) {
    throw new Error('useApp must be used within an AppProvider')
  }
  return context
}
