/**
 * graphEngine — 引擎 B（codebase-memory-mcp）前端封装（t3 双引擎索引）
 *
 * sidecar 以受管 stdio MCP 进程托管 codebase-memory-mcp，本模块封装
 * graph_engine.* RPC：索引/跨仓库智能/结构搜索/调用链追踪/Cypher。
 * 引擎 B 不可用时所有方法优雅降级（返回 null / unavailable），
 * 搜索与索引流程自动回落到引擎 A（tree-sitter FTS5 + 向量）。
 *
 * project 命名约定：codebase-memory-mcp 从 repo_path 目录名推导项目名，
 * 因此查询侧统一用 graphProjectName(repo) 保持一致。
 */

import { sidecar } from '@/adapters/SidecarBridge'

/**
 * 图谱侧项目名展示用推导 = 仓库目录名。
 * 注意：引擎真实项目名由绝对路径推导（路径分隔符 → '-'，如
 * /data/repos/x → data-repos-x），与目录名不一致；因此所有查询
 * 应同时传 repoPath，由 sidecar resolveProjectName 解析真实项目名。
 */
export function graphProjectName(repo) {
  const path = repo?.path || ''
  const normalized = path.replace(/[\\/]+$/, '')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1) || normalized
  return base || repo?.name || ''
}

async function invoke(method, params) {
  return sidecar.invoke(method, params)
}

/** 引擎状态探测：{ available, tools, error, config }；sidecar 不可用时返回 unavailable。 */
export async function getGraphEngineStatus() {
  try {
    return await invoke('graph_engine.status', {})
  } catch (e) {
    return { available: false, tools: [], error: e?.message || String(e), config: null }
  }
}

/** 配置引擎启动命令（{ command, args?, env? }）。 */
export async function configureGraphEngine(config) {
  return invoke('graph_engine.configure', { config })
}

/** 单仓库图谱索引（full/moderate 按仓库规模选择，默认 full）。 */
export async function indexRepoGraph(repoPath, mode) {
  return invoke('graph_engine.index_repo', { repoPath, ...(mode ? { mode } : {}) })
}

/** 跨仓库智能：Route/Channel 匹配生成 CROSS_HTTP_CALLS / CROSS_ASYNC_CALLS / CROSS_CHANNEL 边。 */
export async function indexCrossRepo(repoPath, targetProjects = ['*']) {
  return invoke('graph_engine.index_cross_repo', { repoPath, targetProjects })
}

/** 结构感知代码搜索（引擎 B 路）；repoPath 供 sidecar 解析真实项目名。 */
export async function searchGraphCode(project, pattern, { limit = 10, pathFilter, repoPath } = {}) {
  return invoke('graph_engine.search', { project, pattern, limit, ...(pathFilter ? { pathFilter } : {}), ...(repoPath ? { repoPath } : {}) })
}

/** 调用链/影响面追踪（跨服务多跳）。 */
export async function traceSymbol(project, functionName, { direction, depth, mode, repoPath } = {}) {
  return invoke('graph_engine.trace', { project, functionName, direction, depth, mode, ...(repoPath ? { repoPath } : {}) })
}

/** Cypher 图查询。 */
export async function queryGraph(project, query, maxRows, repoPath) {
  return invoke('graph_engine.cypher', { project, query, maxRows, ...(repoPath ? { repoPath } : {}) })
}

/** 单仓库索引状态（引擎 B 视角）。 */
export async function graphIndexStatus(project, repoPath) {
  return invoke('graph_engine.index_status', { project, ...(repoPath ? { repoPath } : {}) })
}

/** 增量变更检测（commit watcher 统一增量的 B 侧入口）。 */
export async function detectGraphChanges(project, since, repoPath) {
  return invoke('graph_engine.detect_changes', { project, ...(since ? { since } : {}), ...(repoPath ? { repoPath } : {}) })
}

/** 已索引项目列表。 */
export async function listGraphProjects() {
  return invoke('graph_engine.projects', {})
}

/** 删除图谱项目索引。 */
export async function deleteGraphProject(project, repoPath) {
  return invoke('graph_engine.delete_project', { project, ...(repoPath ? { repoPath } : {}) })
}

/**
 * 统计跨服务调用边（CROSS_*）数量 — 用于索引管理页「项目知识图谱」卡片。
 * 失败（引擎未就绪/项目未索引）返回 null。
 */
export async function countCrossServiceEdges(project, repoPath) {
  try {
    const res = await queryGraph(
      project,
      "MATCH ()-[r]->() WHERE type(r) STARTS WITH 'CROSS_' RETURN type(r) AS type, count(r) AS count",
      100,
      repoPath
    )
    const rows = Array.isArray(res) ? res : res?.rows ?? res?.results ?? []
    let total = 0
    const byType = {}
    for (const row of rows) {
      const count = Number(row?.count ?? row?.['count(r)'] ?? 0)
      const type = row?.type ?? row?.['type(r)'] ?? 'UNKNOWN'
      byType[type] = count
      total += count
    }
    return { total, byType }
  } catch {
    return null
  }
}
