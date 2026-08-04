import React, { createContext, useContext, useReducer, useCallback, useMemo, useEffect } from 'react'
import { STAGE_DEFINITIONS, STAGE_NAMES, buildDefaultStageConfigs, getProjectFlowConfig, getProjectStages, buildDefaultFlowConfig } from '@/data/stages'
import { getProjectDAG, dagToStageList, dagToFlowConfigFull } from '@/data/flowEngine'
import { storage } from '@/adapters/StorageService'

// ─── Local persistence keys (SQLite kv_store via StorageService) ──
export const PROJECTS_KEY = 'flowforge_projects'
export const DELIVERIES_KEY = 'flowforge_deliveries'
export const STAGE_DELIVERABLES_KEY = 'flowforge_stage_deliverables'

// ─── Pipeline stage names (imported from centralized definitions) ─
const stageNames = STAGE_NAMES


// ─── Top-level Agents (global, decoupled from projects) ──────────
// System default capability definitions.
// DEFAULT_STAGE_AGENTS (src/data/stages.js) binds pipeline stages to
// a1~a5 by id and getStageConfig resolves them.
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

// ─── Initial state ───────────────────────────────────────────────

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
 * Build the initial state. Pure client-side app: boots with a local
 * workspace user, then hydrates projects / deliveries / stage
 * deliverables from local persistence (SQLite kv_store). System
 * default agents are kept (functional stage bindings).
 * Exported for unit tests.
 */
export function buildInitialState() {
  const localUser = { id: 'u-local', name: '我的工作区', role: '本机用户', roleTag: '本机', avatarInitial: '我' }
  // Ensure all persisted projects have stageConfigs
  const persistedProjects = (storage.getJSON(PROJECTS_KEY, []) || []).map(p => ({
    ...p,
    stageConfigs: p.stageConfigs || buildDefaultStageConfigs(),
  }))
  return {
    agents,
    isAuthenticated: true,
    toasts: [],
    toastIdCounter: 0,
    // User-level preferences (not project-scoped)
    devMode: 'bridge-agent', // 'uri-scheme' | 'bridge-agent' | 'cloud' | 'spec'
    // Deliverable content storage: { [deliveryId]: { [stageId]: { content, review, generatedAt } } }
    stageDeliverables: storage.getJSON(STAGE_DELIVERABLES_KEY, {}) || {},
    users: [localUser],
    projects: persistedProjects,
    deliveries: storage.getJSON(DELIVERIES_KEY, []) || [],
    currentUser: localUser,
    currentProject: persistedProjects[0] || buildEmptyWorkspaceProject(),
  }
}

// Initial state is built lazily at first mount (useReducer init) so the
// workspace always hydrates from whatever local storage holds at that moment.

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

    case 'DELETE_PROJECT': {
      const projectId = action.payload
      const removedDeliveryIds = new Set(
        state.deliveries.filter(d => d.projectId === projectId).map(d => d.id)
      )
      const projects = state.projects.filter(p => p.id !== projectId)
      const deliveries = state.deliveries.filter(d => d.projectId !== projectId)
      // Cascade: drop stage deliverables that belonged to removed deliveries
      const stageDeliverables = Object.fromEntries(
        Object.entries(state.stageDeliverables).filter(([deliveryId]) => !removedDeliveryIds.has(deliveryId))
      )
      const currentProject = state.currentProject.id === projectId
        ? (projects[0] || buildEmptyWorkspaceProject())
        : state.currentProject
      return { ...state, projects, deliveries, stageDeliverables, currentProject }
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

    case 'UPDATE_DELIVERY': {
      const { deliveryId, data } = action.payload
      return {
        ...state,
        deliveries: state.deliveries.map(d =>
          d.id === deliveryId ? { ...d, ...data, updatedAt: new Date().toISOString() } : d
        ),
      }
    }

    case 'DELETE_DELIVERY': {
      const deliveryId = action.payload
      const stageDeliverables = { ...state.stageDeliverables }
      delete stageDeliverables[deliveryId]
      return {
        ...state,
        deliveries: state.deliveries.filter(d => d.id !== deliveryId),
        stageDeliverables,
      }
    }

    case 'ARCHIVE_DELIVERY': {
      const { deliveryId, archived = true } = action.payload
      return {
        ...state,
        deliveries: state.deliveries.map(d =>
          d.id === deliveryId
            ? { ...d, archived, archivedAt: archived ? new Date().toISOString() : null }
            : d
        ),
      }
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
  const [state, dispatch] = useReducer(appReducer, undefined, buildInitialState)

  // ─── Local persistence: mirror state slices into SQLite kv_store ───
  useEffect(() => { storage.setJSON(PROJECTS_KEY, state.projects) }, [state.projects])
  useEffect(() => { storage.setJSON(DELIVERIES_KEY, state.deliveries) }, [state.deliveries])
  useEffect(() => { storage.setJSON(STAGE_DELIVERABLES_KEY, state.stageDeliverables) }, [state.stageDeliverables])

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

  const deleteProject = useCallback((projectId) => {
    dispatch({ type: 'DELETE_PROJECT', payload: projectId })
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

  const updateDelivery = useCallback((deliveryId, data) => {
    dispatch({ type: 'UPDATE_DELIVERY', payload: { deliveryId, data } })
  }, [])

  const deleteDelivery = useCallback((deliveryId) => {
    dispatch({ type: 'DELETE_DELIVERY', payload: deliveryId })
  }, [])

  const archiveDelivery = useCallback((deliveryId, archived = true) => {
    dispatch({ type: 'ARCHIVE_DELIVERY', payload: { deliveryId, archived } })
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
    deleteProject,
    addUser,
    removeUser,
    login,
    logout,
    createDelivery,
    advanceDeliveryStage,
    updateDelivery,
    deleteDelivery,
    archiveDelivery,
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
  }), [state, setCurrentUser, setCurrentProject, setDevMode, showToast, removeToast, updateProjectConfig, toggleProjectConfigItem, toggleReviewGate, toggleNotification, addProject, deleteProject, addUser, removeUser, login, logout, createDelivery, advanceDeliveryStage, updateDelivery, deleteDelivery, archiveDelivery, saveStageDeliverable, saveStageReview, updateStageConfig, toggleStageConfigItem, getStageConfig, addDeliveryStageOverride, removeDeliveryStageOverride, setDeliveryStageModel, setDeliveryStagePrompt, getEffectiveStageConfig, addAgent, updateAgent, deleteAgent, assignAgentToStage, unassignAgentFromStage, updateProjectFlow, updateFlowNode, resetProjectFlow, getFlowConfig, getProjectStageList, getFlowNode, getStageGate])

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
