// ================================================================
//  Flow Engine — DAG-based flow orchestration
//  Supports: free node placement, parallel paths, per-node config
// ================================================================

import { STAGE_DEFINITIONS, DEFAULT_STAGE_AGENTS, DEFAULT_GATES } from './stages'
import { storage } from '@/adapters/StorageService'

// ─── DAG Node Schema ────────────────────────────────────────────
// Each node in the flow DAG:
// {
//   id: string,              // unique node id (e.g. 'node_req_1')
//   stageId: string,         // references STAGE_DEFINITIONS id, or 'custom'
//   label: string,           // display name
//   concept: string,         // ontology concept
//   position: { x, y },     // canvas position for editor
//   dependsOn: string[],     // predecessor node ids (all must complete)
//   config: {                // per-node configuration
//     skills: [{ name, desc, enabled }],
//     mcps: [{ name, desc, enabled }],
//     rules: [{ name, desc, enabled }],
//     model: string,
//     temperature: number,
//     agentId: string | null,
//     gate: { aiReview, humanReview, manualTrigger, threshold },
//     guidance: { goal, steps[], qualityChecklist[], template },
//     deliverables: string[],
//     generatable: boolean,
//   },
// }

// ─── DAG Definition ─────────────────────────────────────────────
// {
//   id: string,
//   name: string,
//   description: string,
//   nodes: FlowNode[],
//   createdAt: string,
//   updatedAt: string,
// }

let idCounter = 0
export function generateNodeId(stageId) {
  idCounter++
  return `node_${stageId}_${Date.now().toString(36)}_${idCounter}`
}

// ─── Default DAG Builder ────────────────────────────────────────
export function buildDefaultDAG() {
  const nodes = STAGE_DEFINITIONS.map((s, idx) => ({
    id: `node_${s.id}`,
    stageId: s.id,
    label: s.shortName || s.name,
    concept: s.concept || 'Deliverable',
    position: { x: 80 + (idx % 5) * 200, y: 80 + Math.floor(idx / 5) * 160 },
    dependsOn: idx === 0 ? [] : [`node_${STAGE_DEFINITIONS[idx - 1].id}`],
    config: {
      skills: [...s.defaultConfig.skills],
      mcps: [...s.defaultConfig.mcps],
      rules: [...s.defaultConfig.rules],
      model: s.defaultConfig.model,
      temperature: s.defaultConfig.temperature,
      agentId: DEFAULT_STAGE_AGENTS[s.id] || null,
      gate: DEFAULT_GATES[idx] || { aiReview: s.hasAiReview, humanReview: false, manualTrigger: true, threshold: 75 },
      guidance: { ...s.guidance },
      deliverables: [...s.deliverables],
      generatable: s.generatable,
    },
  }))

  // Upgrade: PRD → parallel (test + dev-plan)
  const prdNode = nodes.find(n => n.stageId === 'prd')
  const testNode = nodes.find(n => n.stageId === 'test')
  const devPlanNode = nodes.find(n => n.stageId === 'dev-plan')
  const devNode = nodes.find(n => n.stageId === 'dev')
  const reviewNode = nodes.find(n => n.stageId === 'review')

  if (prdNode && testNode && devPlanNode) {
    testNode.dependsOn = [prdNode.id]
    devPlanNode.dependsOn = [prdNode.id]
    // dev depends on dev-plan
    if (devNode) devNode.dependsOn = [devPlanNode.id]
    // review depends on both test and dev (parallel merge)
    if (reviewNode) reviewNode.dependsOn = [testNode.id, devNode.id].filter(Boolean)
    // fix positions for parallel layout
    prdNode.position = { x: 480, y: 200 }
    testNode.position = { x: 680, y: 100 }
    devPlanNode.position = { x: 680, y: 300 }
    if (devNode) devNode.position = { x: 880, y: 300 }
    if (reviewNode) reviewNode.position = { x: 1080, y: 200 }
  }

  return {
    id: 'dag_default',
    name: '标准交付流程',
    description: '需求 → BRD → PRD → (测试用例 ∥ 开发方案 → 开发) → CR → 自测 → 交付',
    nodes,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

// ─── Create a new node from a stage template ────────────────────
export function createNodeFromStage(stageId, position = { x: 200, y: 200 }) {
  const def = STAGE_DEFINITIONS.find(s => s.id === stageId)
  if (!def) {
    // Custom node
    return {
      id: generateNodeId('custom'),
      stageId: 'custom',
      label: '自定义节点',
      concept: 'Deliverable',
      position,
      dependsOn: [],
      config: {
        skills: [],
        mcps: [],
        rules: [],
        model: 'GPT-4o',
        temperature: 0.7,
        agentId: null,
        gate: { aiReview: true, humanReview: false, manualTrigger: true, threshold: 75 },
        guidance: { goal: '', steps: [], qualityChecklist: [], template: '' },
        deliverables: [],
        generatable: true,
      },
    }
  }

  return {
    id: generateNodeId(stageId),
    stageId: def.id,
    label: def.shortName || def.name,
    concept: def.concept || 'Deliverable',
    position,
    dependsOn: [],
    config: {
      skills: [...def.defaultConfig.skills],
      mcps: [...def.defaultConfig.mcps],
      rules: [...def.defaultConfig.rules],
      model: def.defaultConfig.model,
      temperature: def.defaultConfig.temperature,
      agentId: DEFAULT_STAGE_AGENTS[def.id] || null,
      gate: { aiReview: def.hasAiReview, humanReview: false, manualTrigger: true, threshold: 75 },
      guidance: { ...def.guidance },
      deliverables: [...def.deliverables],
      generatable: def.generatable,
    },
  }
}

// ─── DAG Validation ─────────────────────────────────────────────
export function validateDAG(dag) {
  const errors = []
  const nodeIds = new Set(dag.nodes.map(n => n.id))

  // Check for orphan dependencies
  for (const node of dag.nodes) {
    for (const dep of node.dependsOn) {
      if (!nodeIds.has(dep)) {
        errors.push(`节点 "${node.label}" 依赖了不存在的节点 "${dep}"`)
      }
    }
  }

  // Check for cycles (topological sort)
  const cycle = detectCycle(dag.nodes)
  if (cycle) {
    errors.push(`检测到循环依赖：${cycle.join(' → ')}`)
  }

  // Check for disconnected nodes (no deps and not depended upon, unless it's the only node)
  if (dag.nodes.length > 1) {
    const dependedUpon = new Set(dag.nodes.flatMap(n => n.dependsOn))
    const roots = dag.nodes.filter(n => n.dependsOn.length === 0)
    const leaves = dag.nodes.filter(n => !dependedUpon.has(n.id))
    if (roots.length === 0) {
      errors.push('流程没有起始节点（所有节点都有前置依赖）')
    }
    if (leaves.length === 0) {
      errors.push('流程没有结束节点（所有节点都被其他节点依赖）')
    }
  }

  return { valid: errors.length === 0, errors }
}

function detectCycle(nodes) {
  const graph = new Map()
  nodes.forEach(n => graph.set(n.id, n.dependsOn))

  const visited = new Set()
  const inStack = new Set()
  const path = []

  function dfs(nodeId) {
    visited.add(nodeId)
    inStack.add(nodeId)
    path.push(nodeId)

    const deps = graph.get(nodeId) || []
    for (const dep of deps) {
      if (!visited.has(dep)) {
        const result = dfs(dep)
        if (result) return result
      } else if (inStack.has(dep)) {
        const cycleStart = path.indexOf(dep)
        return [...path.slice(cycleStart), dep].map(id => {
          const n = nodes.find(x => x.id === id)
          return n ? n.label : id
        })
      }
    }

    path.pop()
    inStack.delete(nodeId)
    return null
  }

  for (const node of nodes) {
    if (!visited.has(node.id)) {
      const result = dfs(node.id)
      if (result) return result
    }
  }
  return null
}

// ─── Topological Sort (execution order) ─────────────────────────
export function topologicalSort(nodes) {
  const graph = new Map()
  const inDegree = new Map()

  nodes.forEach(n => {
    graph.set(n.id, [])
    inDegree.set(n.id, 0)
  })

  // Build adjacency: dep → node (dep must come before node)
  nodes.forEach(n => {
    n.dependsOn.forEach(dep => {
      if (graph.has(dep)) {
        graph.get(dep).push(n.id)
        inDegree.set(n.id, (inDegree.get(n.id) || 0) + 1)
      }
    })
  })

  const queue = nodes.filter(n => (inDegree.get(n.id) || 0) === 0).map(n => n.id)
  const sorted = []

  while (queue.length > 0) {
    const current = queue.shift()
    sorted.push(current)
    for (const neighbor of (graph.get(current) || [])) {
      inDegree.set(neighbor, inDegree.get(neighbor) - 1)
      if (inDegree.get(neighbor) === 0) {
        queue.push(neighbor)
      }
    }
  }

  return sorted.map(id => nodes.find(n => n.id === id)).filter(Boolean)
}

// ─── Get parallel groups (nodes that can execute simultaneously) ─
export function getParallelGroups(nodes) {
  const sorted = topologicalSort(nodes)
  const groups = []
  const completed = new Set()

  while (completed.size < nodes.length) {
    const ready = sorted.filter(n =>
      !completed.has(n.id) &&
      n.dependsOn.every(dep => completed.has(dep))
    )
    if (ready.length === 0) break // safety: avoid infinite loop
    groups.push(ready)
    ready.forEach(n => completed.add(n.id))
  }

  return groups
}

// ─── Get node status in a delivery ──────────────────────────────
// deliveryState: { [nodeId]: 'pending' | 'active' | 'complete' | 'skipped' }
export function getNodeStatus(node, deliveryState) {
  return deliveryState[node.id] || 'pending'
}

export function canActivateNode(node, deliveryState) {
  // A node can be activated when all its dependencies are complete
  return node.dependsOn.every(dep => deliveryState[dep] === 'complete' || deliveryState[dep] === 'skipped')
}

// ─── Convert DAG to legacy flowConfig format (for backward compat) ─
export function dagToFlowConfig(dag) {
  const sorted = topologicalSort(dag.nodes)
  return sorted.map(node => ({
    stage: node.stageId,
    concept: node.concept,
    label: node.label,
    agentId: node.config.agentId,
    gate: node.config.gate,
    nodeId: node.id,
    dependsOn: node.dependsOn,
  }))
}

// ─── Convert legacy customFlow to DAG (migration helper) ────────
export function flowConfigToDAG(flowConfig, name = '自定义流程') {
  const nodes = flowConfig.map((item, idx) => {
    const def = STAGE_DEFINITIONS.find(s => s.id === item.stage)
    return {
      id: `node_${item.stage}_${idx}`,
      stageId: item.stage,
      label: item.label || def?.shortName || item.stage,
      concept: item.concept || def?.concept || 'Deliverable',
      position: { x: 80 + (idx % 5) * 200, y: 80 + Math.floor(idx / 5) * 160 },
      dependsOn: idx === 0 ? [] : [`node_${flowConfig[idx - 1].stage}_${idx - 1}`],
      config: {
        skills: def ? [...def.defaultConfig.skills] : [],
        mcps: def ? [...def.defaultConfig.mcps] : [],
        rules: def ? [...def.defaultConfig.rules] : [],
        model: def?.defaultConfig.model || 'GPT-4o',
        temperature: def?.defaultConfig.temperature || 0.7,
        agentId: item.agentId || null,
        gate: item.gate || { aiReview: false, humanReview: false, manualTrigger: true, threshold: 75 },
        guidance: def ? { ...def.guidance } : { goal: '', steps: [], qualityChecklist: [], template: '' },
        deliverables: def ? [...def.deliverables] : [],
        generatable: def?.generatable ?? true,
      },
    }
  })

  return {
    id: `dag_${Date.now().toString(36)}`,
    name,
    description: '从旧版流程配置迁移',
    nodes,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

// ─── Persistence (via StorageService; SQLite in Tauri, Phase 2a) ─
const DAG_STORAGE_KEY = 'flowforge_dags'

export function saveDAGs(dags) {
  storage.setJSON(DAG_STORAGE_KEY, dags)
}

export function loadDAGs() {
  return storage.getJSON(DAG_STORAGE_KEY, []) || []
}

export function getDAGById(id) {
  return loadDAGs().find(d => d.id === id)
}

export function saveDAG(dag) {
  const dags = loadDAGs()
  const idx = dags.findIndex(d => d.id === dag.id)
  dag.updatedAt = new Date().toISOString()
  if (idx >= 0) {
    dags[idx] = dag
  } else {
    dags.push(dag)
  }
  saveDAGs(dags)
  return dag
}

export function deleteDAG(id) {
  saveDAGs(loadDAGs().filter(d => d.id !== id))
}

// ─── Project ↔ DAG binding ──────────────────────────────────────
const PROJECT_DAG_KEY = 'flowforge_project_dag'

export function getProjectDAGId(projectId) {
  const map = storage.getJSON(PROJECT_DAG_KEY, {}) || {}
  return map[projectId] || null
}

export function setProjectDAG(projectId, dagId) {
  const map = storage.getJSON(PROJECT_DAG_KEY, {}) || {}
  map[projectId] = dagId
  storage.setJSON(PROJECT_DAG_KEY, map)
}

// ─── Get effective DAG for a project ────────────────────────────
export function getProjectDAG(project) {
  if (!project) return buildDefaultDAG()

  // 1. Check if project has a bound DAG
  const dagId = getProjectDAGId(project.id)
  if (dagId) {
    const dag = getDAGById(dagId)
    if (dag) return dag
  }

  // 2. Check if project has legacy customFlow → migrate
  if (project.customFlow && Array.isArray(project.customFlow) && project.customFlow.length > 0) {
    const migrated = flowConfigToDAG(project.customFlow, `${project.name} 流程`)
    saveDAG(migrated)
    setProjectDAG(project.id, migrated.id)
    return migrated
  }

  // 3. Default
  return buildDefaultDAG()
}

// ─── Convert DAG → full stage definition list (Pipeline-compatible) ─
// Returns the same shape as getProjectStages(): array of stage defs enriched with agentId, gate, nodeId, dependsOn
export function dagToStageList(dag) {
  const sorted = topologicalSort(dag.nodes)
  return sorted.map(node => {
    const def = STAGE_DEFINITIONS.find(s => s.id === node.stageId)
    if (def) {
      return {
        ...def,
        label: node.label,
        concept: node.concept || def.concept,
        agentId: node.config.agentId ?? null,
        gate: node.config.gate,
        // DAG-specific fields
        nodeId: node.id,
        dependsOn: node.dependsOn,
        // Override config from DAG node
        defaultConfig: {
          skills: node.config.skills,
          mcps: node.config.mcps,
          rules: node.config.rules,
          model: node.config.model,
          temperature: node.config.temperature,
        },
        guidance: node.config.guidance || def.guidance,
        deliverables: node.config.deliverables?.length ? node.config.deliverables : def.deliverables,
        generatable: node.config.generatable ?? def.generatable,
      }
    }
    // Custom node not in defaults
    return {
      id: node.stageId === 'custom' ? node.id : node.stageId,
      name: node.label,
      shortName: node.label,
      icon: 'Circle',
      color: '#6b7280',
      concept: node.concept || 'Deliverable',
      description: '自定义阶段',
      deliverables: node.config.deliverables || [],
      generatable: node.config.generatable ?? true,
      hasAiReview: node.config.gate?.aiReview ?? true,
      guidance: node.config.guidance || { goal: '', steps: [], qualityChecklist: [], template: '' },
      defaultConfig: {
        skills: node.config.skills || [],
        mcps: node.config.mcps || [],
        rules: node.config.rules || [],
        model: node.config.model || 'GPT-4o',
        temperature: node.config.temperature ?? 0.7,
      },
      agentId: node.config.agentId ?? null,
      gate: node.config.gate,
      nodeId: node.id,
      dependsOn: node.dependsOn,
    }
  })
}

// ─── Convert DAG → flowConfig format (for graph engine / traceability) ─
export function dagToFlowConfigFull(dag) {
  const sorted = topologicalSort(dag.nodes)
  return sorted.map(node => ({
    stage: node.stageId === 'custom' ? node.id : node.stageId,
    concept: node.concept,
    label: node.label,
    agentId: node.config.agentId,
    gate: node.config.gate,
    nodeId: node.id,
    dependsOn: node.dependsOn,
  }))
}
