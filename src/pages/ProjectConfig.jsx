import React, { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import {
  Plus, X, Trash2, Edit3, Loader2, Eye, EyeOff,
  Server, GitBranch, Folder, Search, Database, CheckCircle,
  AlertCircle, FileCode, Zap, ChevronRight, ChevronDown, RefreshCw,
  Code2, Terminal, BookOpen, Layers, Bot, Settings,
  SlidersHorizontal, ArrowUp, ArrowDown, GripVertical, PlusCircle, RotateCcw,
  Cpu, Sliders, Link2, Shield, Users, Share2,
} from 'lucide-react'
import { useApp } from '@/context/AppContext'
import ConfigScopeBanner from '@/components/ConfigScopeBanner'
import { Toggle } from '@/components/ui/Toggle'
import {
  getRepositories, addRepository, updateRepository, deleteRepository,
  cloneRepository, validateGitUrl, validateLocalPath, getRepoNameFromUrl,
  validateLocalRepo, supportsGitOps,
  listBranches, checkoutBranch, createBranch,
} from '@/services/repository'
import {
  getIndexes, startIndexing, getIndexStatus, getProjectIndexStats,
  deleteIndex, searchCodebase,
  getCodeIndexStats,
  watchCodeIndex, unwatchCodeIndex, onCodeIndexUpdated,
  buildCrossRepoIntelligence, syncGraphChanges,
} from '@/services/codebaseIndex'
import { getGraphEngineStatus, countCrossServiceEdges, graphProjectName } from '@/services/graphEngine'
import { getModelOptions } from '@/services/ai'
import { STAGE_DEFINITIONS, buildDefaultFlowConfig, getProjectFlowConfig, getProjectStages } from '@/data/stages'

// Local stage output type options for the custom flow editor
const STAGE_OUTPUT_TYPES = [
  { value: 'Deliverable', label: '文档交付物' },
  { value: 'TestCase', label: '测试用例' },
  { value: 'CodeModule', label: '代码模块' },
  { value: 'Review', label: '评审记录' },
  { value: 'Requirement', label: '需求' },
  { value: 'KnowledgeAsset', label: '知识资产' },
  { value: 'Agent', label: '智能体' },
]

// Common model options for the model selects come from the custom model registry
// (see getModelOptions in @/services/ai) — no hardcoded model names.

// stage.icon is a string (e.g. 'FileText'); map stage id -> importable lucide icon
const STAGE_ICON_MAP = {
  req: FileCode,
  brd: BookOpen,
  prd: FileCode,
  test: CheckCircle,
  'dev-plan': Code2,
  dev: Terminal,
  review: Eye,
  'auto-test': Zap,
  deploy: Server,
}

const TABS = [
  { key: 'repos', label: '仓库管理', icon: GitBranch },
  { key: 'flow', label: '交付流编排', icon: Layers },
  { key: 'index', label: '索引管理', icon: Database },
  { key: 'members', label: '成员管理', icon: Users },
]

const REPO_STATUS_META = {
  ready: { label: '就绪', color: 'var(--color-success)' },
  cloning: { label: '克隆中', color: 'var(--color-progress)' },
  error: { label: '错误', color: 'var(--color-error)' },
  pending: { label: '待克隆', color: 'var(--fg-muted)' },
}

const EMPTY_REPO_FORM = {
  name: '',
  type: 'local',
  path: '',
  gitUrl: '',
  branch: 'main',
  isMain: false,
}

function getStageIcon(stageId) {
  return STAGE_ICON_MAP[stageId] || FileCode
}

function formatTime(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return '—'
  }
}

export default function ProjectConfig({ embedded = false }) {
  const {
    currentProject, projects, setCurrentProject, showToast,
    stageDefinitions,
    toggleReviewGate,
    updateProjectFlow, updateFlowNode, resetProjectFlow, getProjectStageList,
    getFlowNode, getStageGate,
    agents, updateAgent,
    users, updateProjectConfig,
  } = useApp()

  const [activeTab, setActiveTab] = useState('repos')
  const [repos, setRepos] = useState([])
  const [indexes, setIndexes] = useState([])
  const [indexStats, setIndexStats] = useState({
    repoCount: 0, totalFiles: 0, totalChunks: 0, languages: [], lastIndexed: null,
  })

  // Repo dialog state
  const [showRepoDialog, setShowRepoDialog] = useState(false)
  const [editingRepoId, setEditingRepoId] = useState(null)
  const [repoForm, setRepoForm] = useState(EMPTY_REPO_FORM)
  const [cloningRepoId, setCloningRepoId] = useState(null)
  // Clone progress relayed from git://clone_progress (tauri mode): { repoId, percent, line }
  const [cloneProgress, setCloneProgress] = useState(null)

  // ─── Branch picker state (real git checkout via Rust commands) ───
  const [branchPickerRepoId, setBranchPickerRepoId] = useState(null)
  const [branchList, setBranchList] = useState(null) // {local, remote, current}
  const [branchLoading, setBranchLoading] = useState(false)
  const [checkingOutBranch, setCheckingOutBranch] = useState(null)
  const [newBranchName, setNewBranchName] = useState('')

  // ─── Real Rust index stats + commit watcher (merged from KnowledgeBase) ───
  const [repoIndexStats, setRepoIndexStats] = useState({}) // repoId -> stats
  const [watched, setWatched] = useState({}) // repoPath -> bool
  const [rebuilding, setRebuilding] = useState(false)
  const [idxRefreshTick, setIdxRefreshTick] = useState(0)

  // ─── Member management state (migrated from Projects page) ───
  const [showAddMember, setShowAddMember] = useState(false)
  const [addMemberSelection, setAddMemberSelection] = useState([])

  // ─── Custom flow editor state ───
  const projectStages = getProjectStageList(currentProject)
  const [showAddStageDialog, setShowAddStageDialog] = useState(false)
  const [newStageForm, setNewStageForm] = useState({ id: '', name: '', concept: 'Deliverable' })

  // ─── Agent quick edit modal state ───
  const [showAgentEditModal, setShowAgentEditModal] = useState(false)
  const [editingAgentId, setEditingAgentId] = useState(null)
  const [agentEditForm, setAgentEditForm] = useState({
    name: '', description: '', model: 'GPT-4o', systemPrompt: '', temperature: 0.7,
    skills: '', mcpTools: '', rules: '',
  })

  // Enabled top-level agents (for binding dropdown)
  const enabledAgents = agents.filter(a => a.enabled)

  // Flow editor handlers
  const moveStage = (idx, direction) => {
    const flow = getProjectFlowConfig(currentProject)
    const newFlow = [...flow]
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1
    if (targetIdx < 0 || targetIdx >= newFlow.length) return
    ;[newFlow[idx], newFlow[targetIdx]] = [newFlow[targetIdx], newFlow[idx]]
    updateProjectFlow(currentProject.id, newFlow)
  }

  const removeStageFromFlow = (stageId) => {
    const flow = getProjectFlowConfig(currentProject)
    const newFlow = flow.filter(s => s.stage !== stageId)
    updateProjectFlow(currentProject.id, newFlow)
    showToast('已从交付流中移除该阶段', 'success')
  }

  const addStageToFlow = () => {
    if (!newStageForm.id || !newStageForm.name) {
      showToast('请填写阶段ID和名称', 'error')
      return
    }
    const flow = getProjectFlowConfig(currentProject)
    const exists = flow.some(s => s.stage === newStageForm.id)
    if (exists) {
      showToast('该阶段已存在于交付流中', 'error')
      return
    }
    const newFlow = [...flow, {
      stage: newStageForm.id,
      concept: newStageForm.concept,
      label: newStageForm.name,
    }]
    updateProjectFlow(currentProject.id, newFlow)
    setShowAddStageDialog(false)
    setNewStageForm({ id: '', name: '', concept: 'Deliverable' })
    showToast('已添加新阶段到交付流', 'success')
  }

  const handleResetFlow = () => {
    resetProjectFlow(currentProject.id)
    showToast('已重置为默认交付流模板', 'success')
  }

  // Index state
  const [indexingRepoId, setIndexingRepoId] = useState(null)

  // QA test state
  const [qaQuery, setQaQuery] = useState('')
  const [qaResults, setQaResults] = useState(null)
  const [qaSearching, setQaSearching] = useState(false)

  // Refresh data when project changes
  useEffect(() => {
    if (!currentProject) return
    setRepos(getRepositories(currentProject.id))
    setIndexes(getIndexes(currentProject.id))
    setIndexStats(getProjectIndexStats(currentProject.id))
  }, [currentProject])

  // Escape closes all dialogs
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setShowRepoDialog(false)
        setShowAddStageDialog(false)
        setShowAgentEditModal(false)
        setShowAddMember(false)
        setBranchPickerRepoId(null)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  const refreshRepos = useCallback(() => {
    if (!currentProject) return
    setRepos(getRepositories(currentProject.id))
  }, [currentProject])

  const refreshIndexes = useCallback(() => {
    if (!currentProject) return
    setIndexes(getIndexes(currentProject.id))
    setIndexStats(getProjectIndexStats(currentProject.id))
  }, [currentProject])

  // ─── Repo handlers ──────────────────────────────────────────────
  const handleOpenAddRepo = () => {
    setEditingRepoId(null)
    setRepoForm(EMPTY_REPO_FORM)
    setShowRepoDialog(true)
  }

  const handleOpenEditRepo = (repo) => {
    setEditingRepoId(repo.id)
    setRepoForm({
      name: repo.name || '',
      type: repo.type || 'local',
      path: repo.path || '',
      gitUrl: repo.gitUrl || '',
      branch: repo.branch || 'main',
      isMain: !!repo.isMain,
    })
    setShowRepoDialog(true)
  }

  const handleRepoFieldChange = (field, value) => {
    setRepoForm(prev => {
      const next = { ...prev, [field]: value }
      // auto-fill name from git URL when name is still empty
      if (field === 'gitUrl' && prev.type === 'git' && !prev.name) {
        next.name = getRepoNameFromUrl(value)
      }
      return next
    })
  }

  const handleRepoTypeChange = (type) => {
    setRepoForm(prev => ({ ...prev, type }))
  }

  // 原生目录选择器（tauri-plugin-dialog）
  const handlePickDirectory = async () => {
    let open
    try {
      ({ open } = await import('@tauri-apps/plugin-dialog'))
    } catch (e) {
      showToast(`目录选择器加载失败：${e?.message || e}`, 'error')
      return
    }
    try {
      const dir = await open({ directory: true, multiple: false, title: '选择要引用的项目目录' })
      if (dir === null) return // 用户取消选择：静默返回
      if (typeof dir === 'string' && dir) {
        setRepoForm(prev => ({
          ...prev,
          path: dir,
          name: prev.name || dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '',
        }))
      }
    } catch (e) {
      showToast(`目录选择失败：${e?.message || e}`, 'error')
    }
  }

  const handleSaveRepo = async () => {
    if (!repoForm.name.trim()) {
      showToast('请填写仓库名称', 'error')
      return
    }
    if (repoForm.type === 'local') {
      const v = validateLocalPath(repoForm.path)
      if (!v.valid) {
        showToast(v.message, 'error')
        return
      }
    } else {
      const v = validateGitUrl(repoForm.gitUrl)
      if (!v.valid) {
        showToast(v.message, 'error')
        return
      }
      // git 类型可选自定义克隆目录：填了就必须是合法绝对路径
      if (repoForm.path.trim()) {
        const pv = validateLocalPath(repoForm.path.trim())
        if (!pv.valid) {
          showToast(pv.message, 'error')
          return
        }
      }
    }

    // Enforce single main repo (microservice)
    if (repoForm.isMain) {
      repos.forEach(r => {
        if (r.isMain && r.id !== editingRepoId) {
          updateRepository(r.id, { isMain: false })
        }
      })
    }

    if (repoForm.type === 'local') {
      // 引用本地目录：Rust 侧校验后原路径直接注册（不 clone、不复制）
      const localPath = repoForm.path.trim()
      let info
      try {
        info = await validateLocalRepo(localPath)
      } catch (e) {
        showToast(`路径校验失败：${e?.message || e}`, 'error')
        return
      }
      if (!info.exists) {
        showToast(`路径不存在：${localPath}`, 'error')
        return
      }
      if (!info.isDirectory) {
        showToast('该路径是文件，请选择项目目录', 'error')
        return
      }
      const localPayload = {
        projectId: currentProject.id,
        name: repoForm.name.trim(),
        type: 'local',
        source: 'local',
        path: localPath,
        gitUrl: '',
        branch: info.currentBranch || repoForm.branch.trim() || 'main',
        isMain: repoForm.isMain,
        isGitRepo: !!info.isGitRepo,
        gitRoot: info.gitRoot || null,
        status: 'ready',
        lastSync: new Date().toISOString(),
        error: null,
      }
      if (editingRepoId) {
        updateRepository(editingRepoId, localPayload)
      } else {
        addRepository(localPayload)
      }
      showToast(
        info.isGitRepo
          ? `已引用本地仓库（分支 ${localPayload.branch}）`
          : '已引用本地目录；非 Git 仓库，交付时将跳过分支隔离',
        'success'
      )
      refreshRepos()
      setShowRepoDialog(false)
      return
    }

    const payload = {
      projectId: currentProject.id,
      name: repoForm.name.trim(),
      type: repoForm.type,
      path: repoForm.path.trim(),
      gitUrl: repoForm.type === 'git' ? repoForm.gitUrl.trim() : '',
      branch: repoForm.branch.trim() || 'main',
      isMain: repoForm.isMain,
    }

    if (editingRepoId) {
      updateRepository(editingRepoId, payload)
      showToast('仓库已更新', 'success')
    } else {
      addRepository(payload)
      showToast('仓库已添加', 'success')
    }
    refreshRepos()
    setShowRepoDialog(false)
  }

  const handleDeleteRepo = (repo) => {
    deleteRepository(repo.id)
    deleteIndex(repo.id)
    showToast(`已删除「${repo.name}」`, 'success')
    refreshRepos()
    refreshIndexes()
  }

  const handleCloneRepo = async (repo) => {
    setCloningRepoId(repo.id)
    setCloneProgress({ repoId: repo.id, percent: 0, line: '' })
    try {
      await cloneRepository(repo, (p) => {
        setCloneProgress({ repoId: repo.id, percent: p.percent, line: p.line || '' })
      })
      showToast(`「${repo.name}」克隆成功`, 'success')
    } catch (e) {
      showToast(`克隆失败：${e?.message || repo.name}`, 'error')
    }
    setCloningRepoId(null)
    setCloneProgress(null)
    refreshRepos()
  }

  // ─── Flow node agent binding handler (unified model) ───────────
  const handleNodeAgentChange = (nodeIndex, agentId) => {
    updateFlowNode(currentProject.id, nodeIndex, { agentId: agentId || null })
    if (agentId) {
      const ag = agents.find(a => a.id === agentId)
      showToast(`已绑定智能体「${ag?.name || ''}」`, 'success')
    } else {
      showToast('已取消该节点的智能体绑定', 'info')
    }
  }

  // ─── Flow node label edit handler ──────────────────────────────
  const handleNodeLabelChange = (nodeIndex, label) => {
    updateFlowNode(currentProject.id, nodeIndex, { label })
  }

  // ─── Flow node gate toggle handler ─────────────────────────────
  const handleToggleGate = (stageId, field) => {
    toggleReviewGate(currentProject.id, stageId, field)
    showToast('门禁设置已更新', 'success')
  }

  // ─── Flow node gate threshold change ───────────────────────────
  const handleGateThresholdChange = (nodeIndex, value) => {
    const num = Math.max(0, Math.min(100, Number(value) || 0))
    updateFlowNode(currentProject.id, nodeIndex, {
      gate: { ...getFlowNode(currentProject.id, projectStages[nodeIndex]?.id)?.gate, threshold: num },
    })
  }

  // ─── Agent quick edit modal handlers ───────────────────────────
  const openAgentEditModal = (agentId) => {
    const agent = agents.find(a => a.id === agentId)
    if (!agent) {
      showToast('未找到该智能体', 'error')
      return
    }
    setEditingAgentId(agentId)
    setAgentEditForm({
      name: agent.name || '',
      description: agent.description || '',
      model: agent.model || '',
      systemPrompt: agent.systemPrompt || '',
      temperature: typeof agent.temperature === 'number' ? agent.temperature : 0.7,
      skills: (agent.skills || []).join(', '),
      mcpTools: (agent.mcpTools || []).join(', '),
      rules: (agent.rules || []).join(', '),
    })
    setShowAgentEditModal(true)
  }

  const handleSaveAgentEdit = () => {
    if (!editingAgentId) return
    const name = agentEditForm.name.trim()
    if (!name) {
      showToast('请填写智能体名称', 'error')
      return
    }
    const parseList = (str) => str ? str.split(',').map(s => s.trim()).filter(Boolean) : []
    const data = {
      name,
      description: agentEditForm.description.trim(),
      model: agentEditForm.model,
      systemPrompt: agentEditForm.systemPrompt.trim(),
      temperature: Number(agentEditForm.temperature),
      skills: parseList(agentEditForm.skills),
      mcpTools: parseList(agentEditForm.mcpTools),
      rules: parseList(agentEditForm.rules),
    }
    updateAgent(editingAgentId, data)
    showToast(`智能体「${name}」已更新`, 'success')
    setShowAgentEditModal(false)
    setEditingAgentId(null)
  }

  // ─── Index handlers ─────────────────────────────────────────────
  const handleStartIndex = async (repo) => {
    setIndexingRepoId(repo.id)
    try {
      const updated = await startIndexing(currentProject.id, repo.id, repo.name)
      showToast(`「${repo.name}」索引完成`, 'success')
      // 多仓库项目：所有仓库就绪后自动触发跨仓库智能（CROSS_* 边）
      const all = getIndexes(currentProject.id)
      const repoCount = repos.filter(r => r.path).length
      const readyCount = all.filter(i => i.status === 'ready').length
      if (repoCount >= 2 && readyCount >= repoCount && updated?.status === 'ready') {
        try {
          await buildCrossRepoIntelligence(currentProject.id)
          showToast('所有仓库已就绪，跨仓库智能已自动建立', 'success')
        } catch (e) {
          showToast(`跨仓库智能建立失败：${e?.message || e}`, 'error')
        }
      }
    } catch (e) {
      showToast(`索引失败：${repo.name}`, 'error')
    }
    setIndexingRepoId(null)
    refreshIndexes()
  }

  const handleDeleteIndex = (repo) => {
    deleteIndex(repo.id)
    showToast(`已删除「${repo.name}」的索引`, 'success')
    refreshIndexes()
  }

  // ─── QA search handler ──────────────────────────────────────────
  const handleQaSearch = async () => {
    if (!qaQuery.trim()) {
      showToast('请输入查询内容', 'error')
      return
    }
    setQaSearching(true)
    setQaResults(null)
    try {
      const result = await searchCodebase(currentProject.id, qaQuery.trim())
      setQaResults(result)
    } catch (e) {
      showToast('查询失败', 'error')
    }
    setQaSearching(false)
  }

  // ─── Branch picker handlers (real git via Rust shell) ───────────
  const openBranchPicker = async (repo) => {
    if (branchPickerRepoId === repo.id) {
      setBranchPickerRepoId(null)
      return
    }
    setBranchPickerRepoId(repo.id)
    setBranchList(null)
    setNewBranchName('')
    setBranchLoading(true)
    try {
      const list = await listBranches(repo.path)
      setBranchList(list)
    } catch (e) {
      showToast(`分支列表获取失败：${e?.message || e}`, 'error')
      setBranchPickerRepoId(null)
    }
    setBranchLoading(false)
  }

  const handleCheckoutBranch = async (repo, branch) => {
    if (branch === repo.branch) {
      setBranchPickerRepoId(null)
      return
    }
    setCheckingOutBranch(branch)
    try {
      await checkoutBranch(repo.path, branch)
      updateRepository(repo.id, { branch })
      refreshRepos()
      showToast(`已切换到分支「${branch}」`, 'success')
      setBranchPickerRepoId(null)
    } catch (e) {
      showToast(`切换分支失败：${e?.message || e}`, 'error')
    }
    setCheckingOutBranch(null)
  }

  const handleCreateBranch = async (repo) => {
    const name = newBranchName.trim()
    if (!name) {
      showToast('请输入新分支名', 'info')
      return
    }
    setCheckingOutBranch(`new:${name}`)
    try {
      await createBranch(repo.path, name, repo.branch)
      await checkoutBranch(repo.path, name)
      updateRepository(repo.id, { branch: name })
      refreshRepos()
      showToast(`已创建并切换到分支「${name}」`, 'success')
      setBranchPickerRepoId(null)
    } catch (e) {
      showToast(`新建分支失败：${e?.message || e}`, 'error')
    }
    setCheckingOutBranch(null)
  }

  // ─── Real Rust index stats (single source of truth for the index tab) ───
  useEffect(() => {
    if (activeTab !== 'index' || !currentProject) return undefined
    let cancelled = false
    const load = async () => {
      const withPath = getRepositories(currentProject.id).filter(r => r.path)
      const entries = await Promise.all(withPath.map(async (repo) => {
        try {
          return [repo.id, await getCodeIndexStats(repo.path)]
        } catch {
          return [repo.id, null]
        }
      }))
      if (!cancelled) setRepoIndexStats(Object.fromEntries(entries))
    }
    load()
    // auto-incremental reindex (commit watcher) → refresh the stats
    // 统一增量：同时触发引擎 B 的 detect_changes（t3）
    const off = onCodeIndexUpdated(() => {
      setIdxRefreshTick(t => t + 1)
      syncGraphChanges(currentProject.id).catch(() => {})
    })
    return () => { cancelled = true; off() }
  }, [activeTab, currentProject, idxRefreshTick])

  // ─── 引擎 B（codebase-memory-mcp）状态 + 跨服务调用边统计（t3） ───
  const [graphEngineStatus, setGraphEngineStatus] = useState(null)
  const [graphEdgeStats, setGraphEdgeStats] = useState(null) // { total, byType }
  const [crossBuilding, setCrossBuilding] = useState(false)

  useEffect(() => {
    if (activeTab !== 'index' || !currentProject) return undefined
    let cancelled = false
    const load = async () => {
      const status = await getGraphEngineStatus()
      if (cancelled) return
      setGraphEngineStatus(status)
      // 逐图谱就绪仓库统计 CROSS_* 边并汇总
      const graphReady = getIndexes(currentProject.id).filter(i => i.graphStatus === 'ready')
      const repos = getRepositories(currentProject.id)
      const edgeResults = await Promise.all(graphReady.map(async (idx) => {
        const repo = repos.find(r => r.id === idx.repoId)
        const project = graphProjectName(repo || { path: idx.repoPath, name: idx.repoName })
        return project ? countCrossServiceEdges(project, repo?.path || idx.repoPath) : null
      }))
      if (cancelled) return
      const total = edgeResults.reduce((s, r) => s + (r?.total ?? 0), 0)
      const byType = {}
      for (const r of edgeResults) {
        for (const [t, c] of Object.entries(r?.byType ?? {})) byType[t] = (byType[t] || 0) + c
      }
      setGraphEdgeStats({ total, byType })
    }
    load()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, currentProject, idxRefreshTick, indexes])

  const handleBuildCrossRepo = async () => {
    setCrossBuilding(true)
    try {
      await buildCrossRepoIntelligence(currentProject.id)
      showToast('跨仓库智能建立完成，已生成跨服务调用边', 'success')
      setIdxRefreshTick(t => t + 1)
    } catch (e) {
      showToast(`跨仓库智能建立失败：${e?.message || e}`, 'error')
    }
    setCrossBuilding(false)
  }

  const handleToggleWatch = async (repo) => {
    try {
      if (watched[repo.path]) {
        await unwatchCodeIndex(repo.path)
        setWatched(w => ({ ...w, [repo.path]: false }))
        showToast('已停止增量监听', 'info')
      } else {
        await watchCodeIndex(repo.path)
        setWatched(w => ({ ...w, [repo.path]: true }))
        showToast('已开启 commit 监听，变更后自动增量索引', 'success')
      }
    } catch (e) {
      showToast(`监听切换失败：${e?.message || e}`, 'error')
    }
  }

  const handleRebuildAllIndexes = async () => {
    const targets = repos.filter(r => r.path)
    if (targets.length === 0) {
      showToast('请先添加含本地路径的仓库', 'error')
      return
    }
    setRebuilding(true)
    try {
      for (const repo of targets) {
        // 统一入口：startIndexing 内部串行 引擎A → 引擎B
        await startIndexing(currentProject.id, repo.id, repo.name)
      }
      // 多仓库项目重建完成后自动重建跨仓库智能
      if (targets.length >= 2) {
        try {
          await buildCrossRepoIntelligence(currentProject.id)
          showToast('跨仓库智能已同步重建', 'success')
        } catch (e) {
          showToast(`跨仓库智能重建失败：${e?.message || e}`, 'error')
        }
      }
      setIdxRefreshTick(t => t + 1)
      refreshIndexes()
    } catch (e) {
      showToast(`重建索引失败：${e?.message || e}`, 'error')
    }
    setRebuilding(false)
  }

  // CommandPalette 快捷动作「重建索引」→ 切到索引页签并触发重建
  useEffect(() => {
    const onRebuild = () => {
      setActiveTab('index')
      handleRebuildAllIndexes()
    }
    window.addEventListener('flowforge:rebuild-index', onRebuild)
    return () => window.removeEventListener('flowforge:rebuild-index', onRebuild)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos])

  // ─── Member handlers (migrated from Projects page) ─────────────
  const handleRemoveMember = (memberName, index) => {
    const newMembers = currentProject.members.filter((_, j) => j !== index)
    updateProjectConfig(currentProject.id, 'members', newMembers)
    showToast(`已移除成员「${memberName}」`, 'success')
  }

  const handleAddMembers = () => {
    if (addMemberSelection.length === 0) {
      showToast('请至少选择一位成员', 'info')
      return
    }
    const currentMembers = currentProject.members || []
    updateProjectConfig(currentProject.id, 'members', [...currentMembers, ...addMemberSelection])
    showToast(`已添加 ${addMemberSelection.length} 位成员`, 'success')
    setShowAddMember(false)
    setAddMemberSelection([])
  }

  // ─── Render helpers ─────────────────────────────────────────────
  const renderBadge = (text, color, bg) => (
    <span style={{
      fontSize: '10px', fontWeight: 510, color,
      padding: '1px 7px', borderRadius: '9999px',
      background: bg || 'var(--surface)',
      border: '1px solid var(--border-subtle)',
      whiteSpace: 'nowrap',
    }}>
      {text}
    </span>
  )

  // ─── Validation feedback for repo form ──────────────────────────
  const gitValidation = repoForm.type === 'git' ? validateGitUrl(repoForm.gitUrl) : null
  const pathValidation = repoForm.type === 'local' ? validateLocalPath(repoForm.path) : null
  // Optional custom clone dir for git repos — only validated when non-empty
  const gitPathValidation = repoForm.type === 'git' && repoForm.path.trim()
    ? validateLocalPath(repoForm.path.trim())
    : null

  // Index tab aggregates — single source of truth: Rust `code_index_stats`.
  // Falls back to the stored index records until the Rust stats are loaded.
  const rustStatValues = Object.values(repoIndexStats).filter(s => s && s.exists)
  const hasRustStats = rustStatValues.length > 0
  const indexAggregate = hasRustStats
    ? {
        repoCount: rustStatValues.length,
        totalFiles: rustStatValues.reduce((sum, s) => sum + (s.files ?? 0), 0),
        totalSymbols: rustStatValues.reduce((sum, s) => sum + (s.symbols ?? 0), 0),
        totalRelations: rustStatValues.reduce((sum, s) => sum + (s.relations ?? 0), 0),
        lastIndexed: rustStatValues.map(s => s.lastIndexedAt).filter(Boolean).sort().reverse()[0] || null,
        languages: [...new Set(rustStatValues.flatMap(s => s.languages ?? []))],
      }
    : {
        repoCount: indexStats.repoCount,
        totalFiles: indexStats.totalFiles,
        totalSymbols: indexStats.totalChunks,
        totalRelations: null,
        lastIndexed: indexStats.lastIndexed,
        languages: indexStats.languages,
      }

  // ════════════════════════════════════════════════════════════════
  //  RENDER
  // ════════════════════════════════════════════════════════════════
  if (!currentProject) {
    return (
      <div className="fade-in">
        {!embedded && <ConfigScopeBanner />}
        <div className="card" style={{ padding: '40px', textAlign: 'center', color: 'var(--fg-tertiary)' }}>
          请先选择一个项目
        </div>
      </div>
    )
  }

  return (
    <div className="fade-in">
      {!embedded && <ConfigScopeBanner />}

      {/* Header with project selector (standalone page only; embedded mode is
          scoped by the project list of the project center) */}
      {!embedded && (
        <div className="page-header">
          <div>
            <h2>项目配置中心</h2>
            <p style={{ fontSize: '13px', color: 'var(--fg-tertiary)', marginTop: '4px' }}>
              统一管理项目仓库、交付流编排和代码索引
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <label htmlFor="project-select" style={{ fontSize: '12px', color: 'var(--fg-tertiary)' }}>当前项目</label>
            <select
              id="project-select"
              className="select"
              style={{ minWidth: '200px' }}
              value={currentProject.id}
              onChange={(e) => {
                const proj = projects.find(p => p.id === e.target.value)
                if (proj) {
                  setCurrentProject(proj)
                }
              }}
              aria-label="切换项目"
            >
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="tabs">
        {TABS.map(tab => (
          <div
            key={tab.key}
            className={`tab-item ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
            role="tab"
            aria-selected={activeTab === tab.key}
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveTab(tab.key) } }}
          >
            <tab.icon size={14} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
            {tab.label}
          </div>
        ))}
      </div>

      {/* ════════ Tab 1: 仓库管理 ════════ */}
      {activeTab === 'repos' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '14px', fontWeight: 510, color: 'var(--fg)' }}>
                仓库列表 <span style={{ color: 'var(--fg-muted)', fontWeight: 400, fontSize: '12px', marginLeft: '4px' }}>{repos.length} 个</span>
              </span>
            </div>
            <button className="btn btn-primary" onClick={handleOpenAddRepo}>
              <Plus size={14} /> 添加仓库
            </button>
          </div>

          {/* Microservice note */}
          <div style={{
            padding: '10px 14px', marginBottom: '16px', borderRadius: '8px',
            background: 'color-mix(in srgb, var(--accent) 4%, var(--bg))',
            border: '1px solid color-mix(in srgb, var(--accent) 20%, var(--border))',
            fontSize: '12px', color: 'var(--fg-secondary)',
            display: 'flex', alignItems: 'center', gap: '8px',
          }}>
            <Layers size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
            支持微服务架构，可添加多个仓库组成一个项目。标记为「主仓库」的仓库将作为项目入口。
          </div>

          {repos.length === 0 ? (
            <div className="card" style={{ padding: '60px 24px', textAlign: 'center' }}>
              <Folder size={40} style={{ color: 'var(--fg-muted)', marginBottom: '16px', opacity: 0.4 }} />
              <div style={{ fontSize: '15px', fontWeight: 510, color: 'var(--fg-secondary)', marginBottom: '6px' }}>
                还没有添加仓库
              </div>
              <div style={{ fontSize: '13px', color: 'var(--fg-tertiary)', marginBottom: '20px' }}>
                添加本地路径或 Git 仓库，开始管理项目代码
              </div>
              <button className="btn btn-primary" onClick={handleOpenAddRepo}>
                <Plus size={14} /> 添加第一个仓库
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {repos.map(repo => {
                const statusMeta = REPO_STATUS_META[repo.status] || REPO_STATUS_META.pending
                const idxStatus = getIndexStatus(repo.id)
                const isGit = repo.type === 'git'
                const isCloning = cloningRepoId === repo.id
                return (
                  <div
                    key={repo.id}
                    className="card"
                    style={{
                      padding: '16px 20px',
                      display: 'flex', alignItems: 'center', gap: '16px',
                      border: repo.isMain ? '1px solid color-mix(in srgb, var(--accent) 40%, var(--border))' : '1px solid var(--border)',
                    }}
                  >
                    {/* Icon */}
                    <div style={{
                      width: '40px', height: '40px', borderRadius: '10px',
                      background: repo.isMain ? 'color-mix(in srgb, var(--accent) 12%, var(--bg))' : 'var(--surface)',
                      color: repo.isMain ? 'var(--accent)' : 'var(--fg-tertiary)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    }}>
                      {isGit ? <GitBranch size={18} /> : <Folder size={18} />}
                    </div>

                    {/* Info */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '5px', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '14px', fontWeight: 590, color: 'var(--fg)' }}>{repo.name}</span>
                        {repo.isMain && renderBadge('主仓库', 'var(--accent)', 'color-mix(in srgb, var(--accent) 10%, transparent)')}
                        {renderBadge(isGit ? 'Git' : '本地引用', isGit ? 'var(--color-progress)' : 'var(--fg-secondary)')}
                        {!isGit && repo.source === 'local' && repo.isGitRepo === false &&
                          renderBadge('非 Git 目录', 'var(--color-progress)')}
                        {renderBadge(statusMeta.label, statusMeta.color)}
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', gap: '4px',
                          fontSize: '10px', fontWeight: 510, color: idxStatus.color,
                          padding: '1px 7px', borderRadius: '9999px',
                          background: 'var(--surface)', border: '1px solid var(--border-subtle)',
                          whiteSpace: 'nowrap',
                        }}>
                          <Database size={10} /> {idxStatus.label}
                        </span>
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', fontSize: '12px', color: 'var(--fg-tertiary)' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0 }}>
                          {isGit ? <GitBranch size={11} /> : <Folder size={11} />}
                          <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', color: 'var(--fg-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {isGit ? (repo.gitUrl || '—') : (repo.path || '—')}
                          </code>
                        </span>
                        {repo.status === 'ready' && repo.path && supportsGitOps(repo) ? (
                          <button
                            className="btn btn-ghost"
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: '4px',
                              padding: '2px 8px', fontSize: '12px',
                              fontFamily: 'JetBrains Mono, monospace',
                            }}
                            onClick={(e) => { e.stopPropagation(); openBranchPicker(repo) }}
                            aria-haspopup="menu"
                            aria-expanded={branchPickerRepoId === repo.id}
                            aria-label={`切换 ${repo.name} 的分支`}
                            title="切换分支"
                          >
                            <GitBranch size={11} /> {repo.branch || 'main'}
                            {branchPickerRepoId === repo.id ? <ChevronDown size={10} style={{ transform: 'rotate(180deg)' }} /> : <ChevronDown size={10} />}
                          </button>
                        ) : (
                          <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <GitBranch size={11} /> {repo.branch || 'main'}
                          </span>
                        )}
                        {repo.lastSync && (
                          <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <RefreshCw size={11} /> {formatTime(repo.lastSync)}
                          </span>
                        )}
                      </div>

                      {/* Clone progress (tauri: relayed from git://clone_progress) */}
                      {isCloning && cloneProgress?.repoId === repo.id && (
                        <div style={{ marginTop: '8px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <div
                              role="progressbar"
                              aria-valuenow={cloneProgress.percent ?? 0}
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-label={`${repo.name} 克隆进度`}
                              style={{ flex: 1, height: '4px', borderRadius: '2px', background: 'var(--surface)', overflow: 'hidden' }}
                            >
                              <div style={{
                                width: `${cloneProgress.percent ?? 0}%`, height: '100%',
                                background: 'var(--color-progress)', transition: 'width 0.2s ease',
                              }} />
                            </div>
                            <span style={{ fontSize: '11px', color: 'var(--color-progress)', fontFamily: 'JetBrains Mono, monospace', flexShrink: 0 }}>
                              {cloneProgress.percent != null ? `${cloneProgress.percent}%` : '…'}
                            </span>
                          </div>
                          {cloneProgress.line && (
                            <div style={{ fontSize: '10px', color: 'var(--fg-muted)', marginTop: '3px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {cloneProgress.line}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Clone error */}
                      {repo.status === 'error' && repo.error && (
                        <div style={{
                          marginTop: '8px', fontSize: '11px', color: 'var(--color-error)',
                          display: 'flex', alignItems: 'center', gap: '4px',
                        }}>
                          <AlertCircle size={11} style={{ flexShrink: 0 }} />
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{repo.error}</span>
                        </div>
                      )}

                      {/* Branch picker dropdown (real git checkout) */}
                      {branchPickerRepoId === repo.id && (
                        <div
                          role="menu"
                          aria-label={`${repo.name} 分支列表`}
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            marginTop: '10px', padding: '10px', borderRadius: '8px',
                            background: 'var(--surface)', border: '1px solid var(--border)',
                            boxShadow: '0 6px 20px rgba(0,0,0,0.08)', maxWidth: '420px',
                          }}
                        >
                          {branchLoading ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--fg-tertiary)', padding: '6px 4px' }}>
                              <Loader2 size={12} className="ff-spin" /> 加载分支列表…
                            </div>
                          ) : branchList ? (
                            <div style={{ maxHeight: '220px', overflowY: 'auto' }}>
                              {[{ label: '本地分支', items: branchList.local || [] }, { label: '远程分支', items: branchList.remote || [] }].map(group => (
                                group.items.length > 0 && (
                                  <div key={group.label} style={{ marginBottom: '8px' }}>
                                    <div style={{ fontSize: '10px', fontWeight: 510, color: 'var(--fg-muted)', padding: '2px 6px' }}>{group.label}</div>
                                    {group.items.map(b => {
                                      const isCurrent = b === branchList.current || b === repo.branch
                                      const busy = checkingOutBranch === b
                                      return (
                                        <button
                                          key={b}
                                          role="menuitem"
                                          className="btn btn-ghost"
                                          disabled={busy || checkingOutBranch !== null}
                                          onClick={() => handleCheckoutBranch(repo, b)}
                                          style={{
                                            display: 'flex', alignItems: 'center', gap: '6px', width: '100%',
                                            justifyContent: 'flex-start', fontSize: '12px', padding: '5px 8px',
                                            fontFamily: 'JetBrains Mono, monospace',
                                            color: isCurrent ? 'var(--accent)' : 'var(--fg-secondary)',
                                            fontWeight: isCurrent ? 510 : 400,
                                          }}
                                        >
                                          {busy ? <Loader2 size={11} className="ff-spin" /> : <GitBranch size={11} />}
                                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b}</span>
                                          {isCurrent && <span style={{ fontSize: '10px', color: 'var(--accent)', marginLeft: 'auto', flexShrink: 0 }}>当前</span>}
                                        </button>
                                      )
                                    })}
                                  </div>
                                )
                              ))}
                              {(branchList.local || []).length === 0 && (branchList.remote || []).length === 0 && (
                                <div style={{ fontSize: '12px', color: 'var(--fg-muted)', padding: '6px 4px' }}>未发现分支</div>
                              )}
                            </div>
                          ) : null}
                          {/* New branch entry */}
                          <div style={{ display: 'flex', gap: '6px', marginTop: '8px', paddingTop: '8px', borderTop: '1px solid var(--border-subtle)' }}>
                            <input
                              className="input"
                              value={newBranchName}
                              onChange={(e) => setNewBranchName(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateBranch(repo) }}
                              placeholder="新分支名，如 feature/xxx"
                              style={{ flex: 1, fontSize: '12px', padding: '5px 8px', fontFamily: 'JetBrains Mono, monospace' }}
                              aria-label="新分支名"
                            />
                            <button
                              className="btn btn-secondary"
                              style={{ fontSize: '12px', padding: '5px 10px', flexShrink: 0 }}
                              disabled={checkingOutBranch !== null}
                              onClick={() => handleCreateBranch(repo)}
                            >
                              {checkingOutBranch?.startsWith('new:') ? <Loader2 size={12} className="ff-spin" /> : <Plus size={12} />}
                              新建并切换
                            </button>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                      {isGit && (
                        <button
                          className="btn btn-secondary"
                          style={{ fontSize: '12px' }}
                          onClick={() => handleCloneRepo(repo)}
                          disabled={isCloning}
                          aria-label={`克隆 ${repo.name}`}
                        >
                          {isCloning ? <Loader2 size={12} className="ff-spin" /> : <GitBranch size={12} />}
                          {isCloning ? '克隆中' : (repo.status === 'ready' ? '重新克隆' : '克隆')}
                        </button>
                      )}
                      {repo.status === 'ready' && (
                        <button
                          className="btn btn-secondary"
                          style={{ fontSize: '12px' }}
                          onClick={() => handleStartIndex(repo)}
                          disabled={indexingRepoId === repo.id}
                          aria-label={`建立索引 ${repo.name}`}
                        >
                          {indexingRepoId === repo.id ? <Loader2 size={12} className="ff-spin" /> : <Database size={12} />}
                          {indexingRepoId === repo.id ? '索引中' : '建立索引'}
                        </button>
                      )}
                      <button
                        className="btn btn-ghost"
                        style={{ padding: '6px' }}
                        onClick={() => handleOpenEditRepo(repo)}
                        title="编辑"
                        aria-label={`编辑 ${repo.name}`}
                      >
                        <Edit3 size={14} />
                      </button>
                      <button
                        className="btn btn-ghost"
                        style={{ padding: '6px', color: 'var(--fg-muted)' }}
                        onClick={() => handleDeleteRepo(repo)}
                        title="删除"
                        aria-label={`删除 ${repo.name}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ════════ Tab 2: 交付流编排 ════════ */}
      {activeTab === 'flow' && (
        <div>
          {/* Agent management moved hint */}
          <div className="flow-agent-hint">
            <Bot size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
            <span>每个交付流节点 = 一个智能体在工作。为节点绑定智能体，能力配置在智能体上维护。</span>
            <Link to="/agents" className="flow-agent-hint-link">
              前往智能体管理 <ChevronRight size={12} />
            </Link>
          </div>

          {/* ─── Flow Orchestrator: unified node cards ─── */}
          <div className="card" style={{ marginBottom: '20px', padding: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <Layers size={18} style={{ color: 'var(--accent)' }} />
                <span style={{ fontSize: '14px', fontWeight: 590, color: 'var(--fg)' }}>交付流编排</span>
                <span style={{
                  fontSize: '10px', fontWeight: 510, color: 'var(--accent)',
                  padding: '2px 8px', borderRadius: '9999px',
                  background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--accent) 25%, transparent)',
                }}>
                  项目级配置
                </span>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn btn-ghost" style={{ fontSize: '12px', padding: '6px 12px' }} onClick={handleResetFlow} title="重置为默认模板">
                  <RotateCcw size={14} />
                  重置为默认
                </button>
                <button className="btn btn-primary" style={{ fontSize: '12px', padding: '6px 12px' }} onClick={() => setShowAddStageDialog(true)}>
                  <PlusCircle size={14} />
                  添加阶段
                </button>
              </div>
            </div>

            <p style={{ fontSize: '12px', color: 'var(--fg-tertiary)', marginBottom: '14px', lineHeight: 1.5 }}>
              每个节点绑定一个智能体，智能体的模型/提示词/技能/工具/规则即为该阶段的能力配置。门禁设置控制该节点的流程准入。
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {getProjectFlowConfig(currentProject).map((item, idx) => {
                const stageDef = STAGE_DEFINITIONS.find(s => s.id === item.stage)
                const conceptDef = STAGE_OUTPUT_TYPES.find(t => t.value === item.concept)
                const isCustom = !stageDef
                const nodeAgent = item.agentId ? agents.find(a => a.id === item.agentId) : null
                const gate = item.gate || { aiReview: false, humanReview: false, manualTrigger: true, threshold: 0 }
                return (
                  <div key={item.stage} className="card flow-node-card" style={{
                    padding: '14px 16px',
                    border: '1px solid var(--border-subtle)',
                    display: 'flex', flexDirection: 'column', gap: '12px',
                  }}>
                    {/* ── Row 1: drag handle, index, label, concept, agent selector, actions ── */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <GripVertical size={14} style={{ color: 'var(--fg-muted)', flexShrink: 0 }} />
                      <span style={{
                        fontSize: '11px', fontWeight: 600, color: 'var(--fg-muted)',
                        width: '24px', textAlign: 'center', flexShrink: 0,
                        fontFamily: 'JetBrains Mono, monospace',
                      }}>{String(idx + 1).padStart(2, '0')}</span>

                      {/* Editable label */}
                      <input
                        type="text"
                        className="input"
                        style={{ width: '120px', fontSize: '13px', fontWeight: 510, padding: '4px 8px' }}
                        value={item.label}
                        onChange={(e) => handleNodeLabelChange(idx, e.target.value)}
                        aria-label={`阶段 ${idx + 1} 标签`}
                      />
                      {isCustom && (
                        <span style={{ fontSize: '10px', color: 'var(--color-progress)', padding: '1px 6px', borderRadius: '4px', background: 'color-mix(in srgb, var(--color-progress) 10%, transparent)' }}>自定义</span>
                      )}

                      {/* Concept badge */}
                      <span style={{
                        fontSize: '10px', fontWeight: 510, padding: '2px 8px', borderRadius: '6px',
                        color: conceptDef?.color || '#6b7280',
                        background: `color-mix(in srgb, ${conceptDef?.color || '#6b7280'} 12%, transparent)`,
                        flexShrink: 0,
                      }}>
                        {conceptDef?.label || item.concept}
                      </span>

                      {/* Agent selector */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: '1 1 200px', minWidth: '180px' }}>
                        <select
                          className="select"
                          style={{ flex: 1, fontSize: '12px', padding: '4px 24px 4px 8px' }}
                          value={item.agentId || ''}
                          onChange={(e) => handleNodeAgentChange(idx, e.target.value)}
                          aria-label={`节点 ${item.label} 智能体选择`}
                        >
                          <option value="">选择智能体</option>
                          {enabledAgents.map(a => (
                            <option key={a.id} value={a.id}>{a.name} · {a.model}</option>
                          ))}
                        </select>
                        {nodeAgent && (
                          <>
                            <span style={{ fontSize: '11px', color: 'var(--fg-tertiary)', whiteSpace: 'nowrap' }}>
                              {nodeAgent.name} · {nodeAgent.model}
                            </span>
                            <button
                              className="btn btn-ghost"
                              style={{ fontSize: '11px', padding: '3px 8px', color: 'var(--accent)' }}
                              onClick={() => openAgentEditModal(nodeAgent.id)}
                              aria-label={`编辑智能体 ${nodeAgent.name}`}
                            >
                              <Edit3 size={11} /> 编辑
                            </button>
                          </>
                        )}
                      </div>

                      {/* Move / delete actions */}
                      <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                        <button
                          className="btn btn-ghost"
                          style={{ padding: '4px', minWidth: '28px', minHeight: '28px' }}
                          onClick={() => moveStage(idx, 'up')}
                          disabled={idx === 0}
                          aria-label="上移"
                        >
                          <ArrowUp size={14} />
                        </button>
                        <button
                          className="btn btn-ghost"
                          style={{ padding: '4px', minWidth: '28px', minHeight: '28px' }}
                          onClick={() => moveStage(idx, 'down')}
                          disabled={idx === getProjectFlowConfig(currentProject).length - 1}
                          aria-label="下移"
                        >
                          <ArrowDown size={14} />
                        </button>
                        <button
                          className="btn btn-ghost"
                          style={{ padding: '4px', minWidth: '28px', minHeight: '28px', color: 'var(--color-error)' }}
                          onClick={() => removeStageFromFlow(item.stage)}
                          aria-label="移除"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>

                    {/* ── Row 2: read-only agent capability summary + inline gate settings ── */}
                    <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-start', paddingLeft: '50px' }}>
                      {/* Agent capability summary (read-only) */}
                      <div style={{ flex: '1 1 240px', display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
                        {nodeAgent ? (
                          <>
                            {renderBadge(`Skills ${(nodeAgent.skills || []).length}`, 'var(--fg-secondary)')}
                            {renderBadge(`MCP ${(nodeAgent.mcpTools || []).length}`, 'var(--fg-secondary)')}
                            {renderBadge(`Rules ${(nodeAgent.rules || []).length}`, 'var(--fg-secondary)')}
                            {(nodeAgent.skills || []).length > 0 && (
                              <span style={{ fontSize: '10px', color: 'var(--fg-muted)' }}>
                                {nodeAgent.skills.join(', ')}
                              </span>
                            )}
                          </>
                        ) : (
                          <span style={{ fontSize: '11px', color: 'var(--fg-muted)' }}>
                            未绑定智能体，该阶段将使用默认配置
                          </span>
                        )}
                      </div>

                      {/* Inline gate settings */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap', flexShrink: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <Toggle
                            checked={!!gate.aiReview}
                            onChange={() => handleToggleGate(item.stage, 'aiReview')}
                            label={`${item.label} AI评审`}
                            size="sm"
                          />
                          <span style={{ fontSize: '11px', color: 'var(--fg-tertiary)' }}>AI评审</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <Toggle
                            checked={!!gate.humanReview}
                            onChange={() => handleToggleGate(item.stage, 'humanReview')}
                            label={`${item.label} 人工评审`}
                            size="sm"
                          />
                          <span style={{ fontSize: '11px', color: 'var(--fg-tertiary)' }}>人工评审</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <Toggle
                            checked={!!gate.manualTrigger}
                            onChange={() => handleToggleGate(item.stage, 'manualTrigger')}
                            label={`${item.label} 手动触发`}
                            size="sm"
                          />
                          <span style={{ fontSize: '11px', color: 'var(--fg-tertiary)' }}>手动触发</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <span style={{ fontSize: '11px', color: 'var(--fg-tertiary)' }}>阈值</span>
                          <input
                            type="number"
                            min="0"
                            max="100"
                            className="input"
                            style={{ width: '64px', fontSize: '12px', padding: '3px 6px' }}
                            value={gate.threshold ?? 0}
                            onChange={(e) => handleGateThresholdChange(idx, e.target.value)}
                            aria-label={`${item.label} 质量阈值`}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* ════════ Tab 3: 索引管理 ════════ */}
      {activeTab === 'index' && (
        <div>
          {/* Overall stats + rebuild (data source: Rust code_index_stats) */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
            <div style={{ fontSize: '14px', fontWeight: 510, color: 'var(--fg)' }}>
              索引总览
              <span style={{ color: 'var(--fg-muted)', fontWeight: 400, fontSize: '12px', marginLeft: '6px' }}>
                {hasRustStats ? 'tree-sitter 真实索引统计' : '本地索引记录'}
              </span>
            </div>
            <button className="btn btn-secondary" style={{ fontSize: '12px' }} onClick={handleRebuildAllIndexes} disabled={rebuilding}>
              {rebuilding ? <Loader2 size={12} className="ff-spin" /> : <RefreshCw size={12} />}
              {rebuilding ? '重建中…' : '重建全部索引'}
            </button>
          </div>
          <div style={{ display: 'flex', gap: '12px', marginBottom: '20px', flexWrap: 'wrap' }}>
            {[
              { label: '已索引仓库', value: indexAggregate.repoCount, icon: Database, color: 'var(--accent)' },
              { label: '总文件数', value: indexAggregate.totalFiles.toLocaleString(), icon: FileCode, color: 'var(--color-progress)' },
              { label: '总符号数', value: indexAggregate.totalSymbols.toLocaleString(), icon: Layers, color: 'var(--color-ai-review)' },
              { label: '总关系数', value: indexAggregate.totalRelations == null ? '—' : indexAggregate.totalRelations.toLocaleString(), icon: GitBranch, color: 'var(--fg-secondary)' },
              { label: '最近索引', value: formatTime(indexAggregate.lastIndexed), icon: RefreshCw, color: 'var(--color-success)' },
            ].map(stat => (
              <div key={stat.label} className="card" style={{ flex: '1 1 180px', padding: '16px 18px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                  <div style={{
                    width: '30px', height: '30px', borderRadius: '8px',
                    background: `color-mix(in srgb, ${stat.color} 12%, var(--bg))`, color: stat.color,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <stat.icon size={15} />
                  </div>
                  <span style={{ fontSize: '12px', color: 'var(--fg-tertiary)' }}>{stat.label}</span>
                </div>
                <div style={{ fontSize: '20px', fontWeight: 590, color: 'var(--fg)' }}>{stat.value}</div>
              </div>
            ))}
          </div>

          {/* Languages */}
          {indexAggregate.languages.length > 0 && (
            <div style={{
              padding: '12px 16px', marginBottom: '20px', borderRadius: '8px',
              background: 'var(--surface)', border: '1px solid var(--border-subtle)',
              display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
            }}>
              <span style={{ fontSize: '12px', color: 'var(--fg-tertiary)' }}>检测到的语言：</span>
              {indexAggregate.languages.map(lang => (
                <span key={lang} style={{
                  fontSize: '11px', fontWeight: 510, color: 'var(--fg-secondary)',
                  padding: '2px 8px', borderRadius: '6px', background: 'var(--bg)', border: '1px solid var(--border-subtle)',
                }}>
                  {lang}
                </span>
              ))}
            </div>
          )}

          {/* 项目知识图谱（引擎 B：codebase-memory-mcp，t3） */}
          <div className="card" style={{ padding: '16px 20px', marginBottom: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px', flexWrap: 'wrap' }}>
              <Share2 size={16} style={{ color: 'var(--color-ai-review)' }} />
              <span style={{ fontSize: '14px', fontWeight: 510 }}>项目知识图谱</span>
              <span style={{ fontSize: '11px', color: 'var(--fg-muted)' }}>引擎 B · codebase-memory-mcp（调用图/跨服务调用识别）</span>
              {graphEngineStatus && (
                renderBadge(
                  graphEngineStatus.available ? '引擎就绪' : '引擎未就绪',
                  graphEngineStatus.available ? 'var(--color-success)' : 'var(--fg-muted)',
                  graphEngineStatus.available ? 'color-mix(in srgb, var(--color-success) 10%, transparent)' : 'var(--surface)'
                )
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
              <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)', flex: 1, minWidth: '240px', lineHeight: 1.7 }}>
                {graphEngineStatus?.available
                  ? `双引擎进度：${indexes.filter(i => i.graphStatus === 'ready').length}/${indexes.filter(i => i.status === 'ready').length} 个就绪仓库已建图谱 · 跨服务调用边 ${graphEdgeStats?.total ?? 0} 条${graphEdgeStats?.byType?.CROSS_HTTP_CALLS ? `（HTTP ${graphEdgeStats.byType.CROSS_HTTP_CALLS}）` : ''}`
                  : graphEngineStatus?.error
                    ? `图谱引擎不可用，搜索已自动降级仅用引擎 A：${graphEngineStatus.error}`
                    : '正在探测图谱引擎状态…'}
              </div>
              <button
                className="btn btn-secondary"
                style={{ fontSize: '12px' }}
                onClick={handleBuildCrossRepo}
                disabled={crossBuilding || indexes.filter(i => i.graphStatus === 'ready').length === 0}
                title="cross-repo-intelligence：匹配 Route/Channel 生成 CROSS_HTTP_CALLS / CROSS_ASYNC_CALLS / CROSS_CHANNEL 边"
              >
                {crossBuilding ? <Loader2 size={12} className="ff-spin" /> : <Share2 size={12} />}
                {crossBuilding ? '建立中…' : '一键建立跨仓库智能'}
              </button>
            </div>
          </div>

          {/* Repo index list */}
          <div style={{ fontSize: '14px', fontWeight: 510, color: 'var(--fg)', marginBottom: '14px' }}>
            仓库索引
          </div>

          {repos.length === 0 ? (
            <div className="card" style={{ padding: '60px 24px', textAlign: 'center' }}>
              <Database size={40} style={{ color: 'var(--fg-muted)', marginBottom: '16px', opacity: 0.4 }} />
              <div style={{ fontSize: '15px', fontWeight: 510, color: 'var(--fg-secondary)', marginBottom: '6px' }}>
                暂无仓库
              </div>
              <div style={{ fontSize: '13px', color: 'var(--fg-tertiary)' }}>
                请先在「仓库管理」中添加仓库，再建立代码索引
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {repos.map(repo => {
                const index = indexes.find(i => i.repoId === repo.id)
                const idxStatus = getIndexStatus(repo.id)
                const isIndexing = indexingRepoId === repo.id
                const isReady = idxStatus.status === 'ready'
                const rustStats = repoIndexStats[repo.id]
                return (
                  <div key={repo.id} className="card" style={{ padding: '16px 20px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                      <div style={{
                        width: '38px', height: '38px', borderRadius: '10px',
                        background: isReady ? 'color-mix(in srgb, var(--color-success) 12%, var(--bg))' : 'var(--surface)',
                        color: isReady ? 'var(--color-success)' : 'var(--fg-tertiary)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                      }}>
                        {isIndexing ? <Loader2 size={18} className="ff-spin" /> : <Database size={18} />}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '14px', fontWeight: 590, color: 'var(--fg)' }}>{repo.name}</span>
                          {renderBadge(idxStatus.label, idxStatus.color)}
                          {/* 引擎 B 图谱状态徽章（t3 双引擎） */}
                          {index?.graphStatus === 'indexing' && renderBadge('图谱索引中', 'var(--color-progress)', 'color-mix(in srgb, var(--color-progress) 10%, transparent)')}
                          {index?.graphStatus === 'ready' && renderBadge('图谱就绪', 'var(--color-ai-review)', 'color-mix(in srgb, var(--color-ai-review) 10%, transparent)')}
                          {index?.graphStatus === 'error' && renderBadge('图谱失败', 'var(--color-error)', 'color-mix(in srgb, var(--color-error) 10%, transparent)')}
                          {repo.isMain && renderBadge('主仓库', 'var(--accent)', 'color-mix(in srgb, var(--accent) 10%, transparent)')}
                        </div>
                        <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)' }}>
                          {repo.type === 'git' ? repo.gitUrl : repo.path}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                        {repo.path && (
                          <button
                            className={`btn ${watched[repo.path] ? 'btn-primary' : 'btn-secondary'}`}
                            style={{ fontSize: '12px' }}
                            onClick={() => handleToggleWatch(repo)}
                            aria-label={`${watched[repo.path] ? '停止' : '开启'} ${repo.name} 增量监听`}
                            title="commit 变更后自动增量索引"
                          >
                            <Zap size={12} /> {watched[repo.path] ? '监听中' : '增量监听'}
                          </button>
                        )}
                        <button
                          className="btn btn-secondary"
                          style={{ fontSize: '12px' }}
                          onClick={() => handleStartIndex(repo)}
                          disabled={isIndexing}
                          aria-label={`${isReady ? '重新索引' : '建立索引'} ${repo.name}`}
                        >
                          {isIndexing ? <Loader2 size={12} className="ff-spin" /> : (isReady ? <RefreshCw size={12} /> : <Database size={12} />)}
                          {isIndexing ? '索引中' : (isReady ? '重新索引' : '建立索引')}
                        </button>
                        {isReady && (
                          <button
                            className="btn btn-ghost"
                            style={{ padding: '6px', color: 'var(--fg-muted)' }}
                            onClick={() => handleDeleteIndex(repo)}
                            title="删除索引"
                            aria-label={`删除 ${repo.name} 索引`}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Index detail — real Rust stats preferred, stored record as fallback */}
                    {rustStats?.exists ? (
                      <div style={{
                        marginTop: '14px', paddingTop: '14px', borderTop: '1px solid var(--border-subtle)',
                        display: 'flex', flexWrap: 'wrap', gap: '20px', fontSize: '12px', color: 'var(--fg-tertiary)',
                      }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                          <FileCode size={12} /> 文件：<strong style={{ color: 'var(--fg-secondary)' }}>{(rustStats.files ?? 0).toLocaleString()}</strong>
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                          <Layers size={12} /> 符号：<strong style={{ color: 'var(--fg-secondary)' }}>{(rustStats.symbols ?? 0).toLocaleString()}</strong>
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                          <GitBranch size={12} /> 关系：<strong style={{ color: 'var(--fg-secondary)' }}>{(rustStats.relations ?? 0).toLocaleString()}</strong>
                        </span>
                        {(rustStats.languages ?? []).length > 0 && (
                          <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                            <Code2 size={12} /> 语言：<strong style={{ color: 'var(--fg-secondary)' }}>{rustStats.languages.join(', ')}</strong>
                          </span>
                        )}
                        <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                          <RefreshCw size={12} /> 索引时间：<strong style={{ color: 'var(--fg-secondary)' }}>{formatTime(rustStats.lastIndexedAt)}</strong>
                        </span>
                      </div>
                    ) : isReady && index ? (
                      <div style={{
                        marginTop: '14px', paddingTop: '14px', borderTop: '1px solid var(--border-subtle)',
                        display: 'flex', flexWrap: 'wrap', gap: '20px', fontSize: '12px', color: 'var(--fg-tertiary)',
                      }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                          <FileCode size={12} /> 文件：<strong style={{ color: 'var(--fg-secondary)' }}>{index.fileCount.toLocaleString()}</strong>
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                          <Layers size={12} /> 分块：<strong style={{ color: 'var(--fg-secondary)' }}>{index.chunks.toLocaleString()}</strong>
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                          <Database size={12} /> 索引大小：<strong style={{ color: 'var(--fg-secondary)' }}>{index.indexSize}</strong>
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                          <RefreshCw size={12} /> 索引时间：<strong style={{ color: 'var(--fg-secondary)' }}>{formatTime(index.lastIndexed)}</strong>
                        </span>
                      </div>
                    ) : null}

                    {/* Prompt to index */}
                    {!isReady && !isIndexing && (
                      <div style={{
                        marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--border-subtle)',
                        fontSize: '12px', color: 'var(--fg-tertiary)', display: 'flex', alignItems: 'center', gap: '6px',
                      }}>
                        <AlertCircle size={13} style={{ color: 'var(--color-progress)' }} />
                        该仓库尚未建立索引，建立索引后可支持代码知识问答
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* QA test section */}
          <div className="card" style={{ marginTop: '24px', padding: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
              <Search size={16} style={{ color: 'var(--accent)' }} />
              <h4 style={{ margin: 0, fontSize: '15px' }}>知识问答测试</h4>
            </div>
            <p style={{ fontSize: '12px', color: 'var(--fg-tertiary)', margin: '0 0 16px' }}>
              基于已索引的代码库进行语义检索，验证索引效果
            </p>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                className="input"
                value={qaQuery}
                onChange={(e) => setQaQuery(e.target.value)}
                placeholder="输入查询，如：用户登录接口在哪？"
                style={{ flex: 1 }}
                onKeyDown={(e) => { if (e.key === 'Enter') handleQaSearch() }}
                aria-label="知识问答查询"
              />
              <button
                className="btn btn-primary"
                onClick={handleQaSearch}
                disabled={qaSearching}
                aria-label="执行查询"
              >
                {qaSearching ? <Loader2 size={14} className="ff-spin" /> : <Search size={14} />}
                {qaSearching ? '查询中' : '查询'}
              </button>
            </div>

            {/* Results */}
            {qaResults && (
              <div style={{ marginTop: '16px' }}>
                {qaResults.message && (
                  <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)', marginBottom: '12px' }}>
                    {qaResults.message}
                  </div>
                )}
                {qaResults.results && qaResults.results.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {qaResults.results.map((res, i) => (
                      <div key={i} style={{
                        padding: '12px 14px', borderRadius: '8px',
                        background: 'var(--surface)', border: '1px solid var(--border-subtle)',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px', gap: '8px' }}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 510, color: 'var(--fg)' }}>
                            <FileCode size={13} style={{ color: 'var(--accent)' }} />
                            <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '11px' }}>{res.file}</code>
                            <span style={{ color: 'var(--fg-muted)', fontWeight: 400 }}>:{res.line}</span>
                          </span>
                          <span style={{ fontSize: '10px', color: 'var(--fg-muted)' }}>
                            相关度 {(res.relevance * 100).toFixed(0)}%
                          </span>
                        </div>
                        <pre style={{
                          margin: 0, padding: '10px', fontSize: '11px', lineHeight: 1.5,
                          background: 'var(--bg)', borderRadius: '6px', overflow: 'auto',
                          fontFamily: 'JetBrains Mono, monospace', color: 'var(--fg-secondary)',
                          border: '1px solid var(--border-subtle)',
                        }}>
{res.snippet}
                        </pre>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{
                    padding: '16px', textAlign: 'center', borderRadius: '8px',
                    background: 'var(--surface)', border: '1px dashed var(--border-subtle)',
                    fontSize: '13px', color: 'var(--fg-tertiary)',
                  }}>
                    未找到相关结果
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ════════ Tab 4: 成员管理 ════════ */}
      {activeTab === 'members' && (
        <div className="card">
          <div className="card-header">
            <h4 className="card-title">
              <Users size={16} style={{ marginRight: '6px', verticalAlign: 'middle' }} />
              项目成员 <span style={{ color: 'var(--fg-muted)', fontWeight: 400, fontSize: '12px', marginLeft: '4px' }}>{(currentProject.members || []).length} 位</span>
            </h4>
            <button className="btn btn-secondary" style={{ fontSize: '12px' }}
              onClick={() => { setAddMemberSelection([]); setShowAddMember(true) }}
              aria-haspopup="dialog">
              <Plus size={12} /> 添加成员
            </button>
          </div>
          {(currentProject.members || []).length === 0 ? (
            <div style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--fg-tertiary)', fontSize: '13px' }}>
              暂无成员，点击「添加成员」邀请团队成员加入项目
            </div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
              {(currentProject.members || []).map((memberName, i) => {
                const user = users.find(u => u.name === memberName)
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', border: '1px solid var(--border)', borderRadius: '6px' }}>
                    <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 510 }}>
                      {user ? user.avatarInitial : memberName.charAt(0)}
                    </div>
                    <div>
                      <div style={{ fontWeight: 510, fontSize: '13px' }}>{memberName}</div>
                      <div style={{ fontSize: '11px', color: 'var(--fg-tertiary)' }}>{user ? user.role : '外部成员'}</div>
                    </div>
                    {(currentProject.members || []).length > 1 && (
                      <button style={{ marginLeft: '4px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-muted)', padding: '2px' }}
                        onClick={() => handleRemoveMember(memberName, i)}
                        aria-label={`移除 ${memberName}`}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ════════ Repo Add/Edit Dialog ════════ */}
      {showRepoDialog && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
          onClick={() => setShowRepoDialog(false)}
          role="presentation"
        >
          <div
            style={{
              background: 'var(--bg)', borderRadius: '14px', padding: '28px',
              width: '520px', maxWidth: '90vw',
              border: '1px solid var(--border)', boxShadow: '0 12px 40px rgba(0,0,0,0.15)',
            }}
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="repo-dialog-title"
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
              <h3 id="repo-dialog-title" style={{ fontSize: '16px', fontWeight: 590, margin: 0 }}>
                {editingRepoId ? '编辑仓库' : '添加仓库'}
              </h3>
              <button className="btn btn-ghost" style={{ padding: '4px' }} onClick={() => setShowRepoDialog(false)} aria-label="关闭">
                <X size={18} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
              {/* Name */}
              <div>
                <label htmlFor="repo-name" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px', color: 'var(--fg-secondary)' }}>
                  仓库名称
                </label>
                <input
                  id="repo-name"
                  className="input"
                  value={repoForm.name}
                  onChange={(e) => handleRepoFieldChange('name', e.target.value)}
                  placeholder="如：user-service"
                  style={{ width: '100%' }}
                  aria-label="仓库名称"
                />
              </div>

              {/* Type toggle */}
              <div>
                <label style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '8px', color: 'var(--fg-secondary)' }}>
                  导入方式
                </label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    className={`btn ${repoForm.type === 'git' ? 'btn-primary' : 'btn-secondary'}`}
                    style={{ flex: 1, fontSize: '13px' }}
                    onClick={() => handleRepoTypeChange('git')}
                    aria-label="Git 仓库克隆"
                  >
                    <GitBranch size={14} /> Git 仓库克隆
                  </button>
                  <button
                    className={`btn ${repoForm.type === 'local' ? 'btn-primary' : 'btn-secondary'}`}
                    style={{ flex: 1, fontSize: '13px' }}
                    onClick={() => handleRepoTypeChange('local')}
                    aria-label="引用本地目录"
                  >
                    <Folder size={14} /> 引用本地目录
                  </button>
                </div>
              </div>

              {/* Local path */}
              {repoForm.type === 'local' && (
                <div>
                  <label htmlFor="repo-path" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px', color: 'var(--fg-secondary)' }}>
                    本地目录
                  </label>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <input
                      id="repo-path"
                      className="input"
                      value={repoForm.path}
                      onChange={(e) => handleRepoFieldChange('path', e.target.value)}
                      placeholder="/Users/xxx/project"
                      style={{ flex: 1, fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}
                      aria-label="本地目录"
                    />
                    <button
                      className="btn btn-secondary"
                      style={{ fontSize: '12px', flexShrink: 0 }}
                      onClick={handlePickDirectory}
                      aria-label="选择目录"
                    >
                      <Folder size={13} /> 选择目录
                    </button>
                  </div>
                  {pathValidation && (
                    <div style={{
                      fontSize: '11px', marginTop: '4px',
                      color: pathValidation.valid ? 'var(--color-success)' : 'var(--color-error)',
                      display: 'flex', alignItems: 'center', gap: '4px',
                    }}>
                      {pathValidation.valid ? <CheckCircle size={11} /> : <AlertCircle size={11} />}
                      {pathValidation.message}
                    </div>
                  )}
                  <div style={{ fontSize: '11px', color: 'var(--fg-muted)', marginTop: '4px' }}>
                    直接引用本机已有项目（不 clone、不复制）；非 Git 目录也可引用，交付时自动跳过分支隔离
                  </div>
                </div>
              )}

              {/* Git URL */}
              {repoForm.type === 'git' && (
                <div>
                  <label htmlFor="repo-giturl" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px', color: 'var(--fg-secondary)' }}>
                    Git 地址
                  </label>
                  <input
                    id="repo-giturl"
                    className="input"
                    value={repoForm.gitUrl}
                    onChange={(e) => handleRepoFieldChange('gitUrl', e.target.value)}
                    placeholder="git@github.com:org/repo.git 或 https://github.com/org/repo.git"
                    style={{ width: '100%', fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}
                    aria-label="Git 地址"
                  />
                  {gitValidation && (
                    <div style={{
                      fontSize: '11px', marginTop: '4px',
                      color: gitValidation.valid ? 'var(--color-success)' : 'var(--color-error)',
                      display: 'flex', alignItems: 'center', gap: '4px',
                    }}>
                      {gitValidation.valid ? <CheckCircle size={11} /> : <AlertCircle size={11} />}
                      {gitValidation.message}
                    </div>
                  )}
                  <div style={{ fontSize: '11px', color: 'var(--fg-muted)', marginTop: '4px' }}>
                    输入 Git 地址后可自动提取仓库名称
                  </div>
                </div>
              )}

              {/* Custom local clone dir (git type, optional) */}
              {repoForm.type === 'git' && (
                <div>
                  <label htmlFor="repo-clone-path" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px', color: 'var(--fg-secondary)' }}>
                    本地克隆路径（可选）
                  </label>
                  <input
                    id="repo-clone-path"
                    className="input"
                    value={repoForm.path}
                    onChange={(e) => handleRepoFieldChange('path', e.target.value)}
                    placeholder="留空则使用应用数据目录 repos/{项目}/{仓库}"
                    style={{ width: '100%', fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}
                    aria-label="本地克隆路径"
                  />
                  {gitPathValidation && (
                    <div style={{
                      fontSize: '11px', marginTop: '4px',
                      color: gitPathValidation.valid ? 'var(--color-success)' : 'var(--color-error)',
                      display: 'flex', alignItems: 'center', gap: '4px',
                    }}>
                      {gitPathValidation.valid ? <CheckCircle size={11} /> : <AlertCircle size={11} />}
                      {gitPathValidation.message}
                    </div>
                  )}
                </div>
              )}

              {/* Branch — 本地引用时由校验自动探测当前分支 */}
              {repoForm.type === 'git' && (
                <div>
                  <label htmlFor="repo-branch" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px', color: 'var(--fg-secondary)' }}>
                    分支
                  </label>
                  <input
                    id="repo-branch"
                    className="input"
                    value={repoForm.branch}
                    onChange={(e) => handleRepoFieldChange('branch', e.target.value)}
                    placeholder="main"
                    style={{ width: '100%' }}
                    aria-label="分支"
                  />
                </div>
              )}

              {/* Main repo toggle */}
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '12px 14px', borderRadius: '8px',
                background: 'var(--surface)', border: '1px solid var(--border-subtle)',
              }}>
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 510, color: 'var(--fg-secondary)' }}>设为主仓库</div>
                  <div style={{ fontSize: '11px', color: 'var(--fg-tertiary)', marginTop: '2px' }}>
                    微服务架构中作为项目入口仓库（仅可设置一个）
                  </div>
                </div>
                <Toggle
                  checked={repoForm.isMain}
                  onChange={(v) => handleRepoFieldChange('isMain', v)}
                  label="设为主仓库"
                  size="md"
                />
              </div>
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '28px' }}>
              <button className="btn btn-secondary" onClick={() => setShowRepoDialog(false)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={handleSaveRepo}
              >
                {editingRepoId ? '保存' : '添加'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ════════ Agent Quick Edit Modal ════════ */}
      {showAgentEditModal && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}
          onClick={() => setShowAgentEditModal(false)}
          role="presentation"
        >
          <div
            style={{
              background: 'var(--bg)', borderRadius: '14px', padding: '28px',
              width: '560px', maxWidth: '90vw', maxHeight: '90vh', overflowY: 'auto',
              border: '1px solid var(--border)', boxShadow: '0 12px 40px rgba(0,0,0,0.15)',
            }}
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent-edit-title"
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
              <h3 id="agent-edit-title" style={{ fontSize: '16px', fontWeight: 590, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Bot size={18} style={{ color: 'var(--accent)' }} />
                编辑智能体
              </h3>
              <button className="btn btn-ghost" style={{ padding: '4px' }} onClick={() => setShowAgentEditModal(false)} aria-label="关闭">
                <X size={18} />
              </button>
            </div>

            {editingAgentId ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {/* Name + Description */}
                <div>
                  <label htmlFor="ae-name" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px', color: 'var(--fg-secondary)' }}>
                    智能体名称 <span style={{ color: 'var(--color-error)' }}>*</span>
                  </label>
                  <input
                    id="ae-name"
                    className="input"
                    value={agentEditForm.name}
                    onChange={(e) => setAgentEditForm(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="如：BRD-Writer"
                    style={{ width: '100%' }}
                    aria-label="智能体名称"
                  />
                </div>
                <div>
                  <label htmlFor="ae-desc" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px', color: 'var(--fg-secondary)' }}>
                    描述
                  </label>
                  <textarea
                    id="ae-desc"
                    className="input"
                    value={agentEditForm.description}
                    onChange={(e) => setAgentEditForm(prev => ({ ...prev, description: e.target.value }))}
                    placeholder="简要描述智能体的职责和能力"
                    rows={2}
                    style={{ width: '100%', resize: 'vertical' }}
                    aria-label="描述"
                  />
                </div>

                {/* Model + Temperature */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                  <div>
                    <label htmlFor="ae-model" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px', color: 'var(--fg-secondary)' }}>
                      <Cpu size={12} style={{ verticalAlign: 'middle', marginRight: '4px' }} />模型
                    </label>
                    <select
                      id="ae-model"
                      className="select"
                      value={agentEditForm.model}
                      onChange={(e) => setAgentEditForm(prev => ({ ...prev, model: e.target.value }))}
                      style={{ width: '100%' }}
                      aria-label="模型"
                    >
                      <option value="">使用默认模型</option>
                      {getModelOptions().map(m => (
                        <option key={m.value} value={m.value}>{m.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="ae-temp" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px', color: 'var(--fg-secondary)' }}>
                      <Sliders size={12} style={{ verticalAlign: 'middle', marginRight: '4px' }} />温度
                      <span style={{ color: 'var(--accent)', fontFamily: 'JetBrains Mono, monospace', fontSize: '12px', marginLeft: '6px' }}>{Number(agentEditForm.temperature).toFixed(1)}</span>
                    </label>
                    <input
                      id="ae-temp"
                      type="range"
                      min="0"
                      max="1"
                      step="0.1"
                      value={agentEditForm.temperature}
                      onChange={(e) => setAgentEditForm(prev => ({ ...prev, temperature: Number(e.target.value) }))}
                      style={{ width: '100%', accentColor: 'var(--accent)' }}
                      aria-label="温度"
                    />
                  </div>
                </div>

                {/* System Prompt */}
                <div>
                  <label htmlFor="ae-prompt" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px', color: 'var(--fg-secondary)' }}>
                    系统提示词
                  </label>
                  <textarea
                    id="ae-prompt"
                    className="input"
                    value={agentEditForm.systemPrompt}
                    onChange={(e) => setAgentEditForm(prev => ({ ...prev, systemPrompt: e.target.value }))}
                    placeholder="定义智能体的角色、行为边界和输出要求..."
                    rows={4}
                    style={{ width: '100%', resize: 'vertical', fontFamily: 'JetBrains Mono, monospace', fontSize: '12px', lineHeight: 1.6 }}
                    aria-label="系统提示词"
                  />
                </div>

                {/* Skills / MCP / Rules */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
                  <div>
                    <label htmlFor="ae-skills" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px', color: 'var(--fg-secondary)' }}>
                      <Zap size={12} style={{ verticalAlign: 'middle', marginRight: '4px' }} />技能列表
                    </label>
                    <input
                      id="ae-skills"
                      className="input"
                      value={agentEditForm.skills}
                      onChange={(e) => setAgentEditForm(prev => ({ ...prev, skills: e.target.value }))}
                      placeholder="逗号分隔"
                      style={{ width: '100%' }}
                      aria-label="技能列表"
                    />
                  </div>
                  <div>
                    <label htmlFor="ae-mcp" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px', color: 'var(--fg-secondary)' }}>
                      <Link2 size={12} style={{ verticalAlign: 'middle', marginRight: '4px' }} />MCP 工具
                    </label>
                    <input
                      id="ae-mcp"
                      className="input"
                      value={agentEditForm.mcpTools}
                      onChange={(e) => setAgentEditForm(prev => ({ ...prev, mcpTools: e.target.value }))}
                      placeholder="逗号分隔"
                      style={{ width: '100%' }}
                      aria-label="MCP 工具"
                    />
                  </div>
                  <div>
                    <label htmlFor="ae-rules" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px', color: 'var(--fg-secondary)' }}>
                      <Shield size={12} style={{ verticalAlign: 'middle', marginRight: '4px' }} />规则列表
                    </label>
                    <input
                      id="ae-rules"
                      className="input"
                      value={agentEditForm.rules}
                      onChange={(e) => setAgentEditForm(prev => ({ ...prev, rules: e.target.value }))}
                      placeholder="逗号分隔"
                      style={{ width: '100%' }}
                      aria-label="规则列表"
                    />
                  </div>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--fg-muted)', marginTop: '-8px' }}>
                  多个条目请用英文逗号分隔，提交后自动转为数组
                </div>
              </div>
            ) : (
              <div style={{ padding: '40px', textAlign: 'center', color: 'var(--fg-tertiary)' }}>
                请先选择智能体
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '24px' }}>
              <button className="btn btn-secondary" onClick={() => setShowAgentEditModal(false)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={handleSaveAgentEdit} disabled={!editingAgentId}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ════════ Add Custom Stage Dialog ════════ */}
      {showAddStageDialog && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={() => setShowAddStageDialog(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-stage-title"
        >
          <div
            style={{ background: 'var(--bg)', borderRadius: '14px', padding: '28px', width: '440px', maxWidth: '90vw', border: '1px solid var(--border)' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 id="add-stage-title" style={{ fontSize: '16px', fontWeight: 600, margin: 0 }}>添加自定义阶段</h3>
              <button className="btn btn-ghost" onClick={() => setShowAddStageDialog(false)} aria-label="关闭"><X size={18} /></button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* Stage ID */}
              <div>
                <label htmlFor="stage-id" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px', color: 'var(--fg-secondary)' }}>
                  阶段 ID
                </label>
                <input
                  id="stage-id"
                  className="input"
                  value={newStageForm.id}
                  onChange={(e) => setNewStageForm(f => ({ ...f, id: e.target.value }))}
                  placeholder="如 api-design、security-audit"
                  style={{ width: '100%', fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}
                  aria-label="阶段ID"
                />
              </div>

              {/* Stage Name */}
              <div>
                <label htmlFor="stage-name" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px', color: 'var(--fg-secondary)' }}>
                  阶段名称
                </label>
                <input
                  id="stage-name"
                  className="input"
                  value={newStageForm.name}
                  onChange={(e) => setNewStageForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="如 API设计、安全审计"
                  style={{ width: '100%' }}
                  aria-label="阶段名称"
                />
              </div>

              {/* Concept Type */}
              <div>
                <label htmlFor="stage-concept" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px', color: 'var(--fg-secondary)' }}>
                  产出类型
                </label>
                <select
                  id="stage-concept"
                  className="select"
                  value={newStageForm.concept}
                  onChange={(e) => setNewStageForm(f => ({ ...f, concept: e.target.value }))}
                  style={{ width: '100%' }}
                  aria-label="产出类型"
                >
                  {STAGE_OUTPUT_TYPES.map(c => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '28px' }}>
              <button className="btn btn-secondary" onClick={() => setShowAddStageDialog(false)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={addStageToFlow}>
                添加
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ════════ Add Member Dialog ════════ */}
      {showAddMember && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100
        }} onClick={() => { setShowAddMember(false); setAddMemberSelection([]) }} role="presentation">
          <div style={{
            background: 'var(--bg)', borderRadius: '12px', padding: '24px',
            width: '480px', maxWidth: '90vw', maxHeight: '85vh', overflowY: 'auto',
            border: '1px solid var(--border)', boxShadow: '0 8px 32px rgba(0,0,0,0.12)'
          }} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="add-member-title">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 id="add-member-title">添加项目成员</h3>
              <button className="btn btn-ghost" onClick={() => { setShowAddMember(false); setAddMemberSelection([]) }} aria-label="关闭对话框">
                <X size={18} />
              </button>
            </div>
            <p style={{ fontSize: '12px', color: 'var(--fg-tertiary)', marginBottom: '16px' }}>
              选择要添加到项目「{currentProject.name}」的成员
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '24px' }}>
              {users.filter(u => !(currentProject.members || []).includes(u.name)).length === 0 && (
                <div style={{ textAlign: 'center', color: 'var(--fg-muted)', padding: '24px', fontSize: '13px' }}>
                  所有团队成员已在项目中
                </div>
              )}
              {users.filter(u => !(currentProject.members || []).includes(u.name)).map(user => (
                <label
                  key={user.id}
                  htmlFor={`add-member-${user.id}`}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px',
                    border: '1px solid var(--border)', borderRadius: '6px', cursor: 'pointer',
                    fontSize: '13px',
                    background: addMemberSelection.includes(user.name) ? 'color-mix(in srgb, var(--accent) 6%, var(--bg))' : 'transparent',
                    borderColor: addMemberSelection.includes(user.name) ? 'var(--accent)' : 'var(--border)',
                  }}>
                  <input
                    type="checkbox"
                    id={`add-member-${user.id}`}
                    checked={addMemberSelection.includes(user.name)}
                    onChange={() => {
                      setAddMemberSelection(prev =>
                        prev.includes(user.name)
                          ? prev.filter(n => n !== user.name)
                          : [...prev, user.name]
                      )
                    }} />
                  <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 510 }}>
                    {user.avatarInitial}
                  </div>
                  <div>
                    <div style={{ fontWeight: 510 }}>{user.name}</div>
                    <div style={{ fontSize: '11px', color: 'var(--fg-tertiary)' }}>{user.role}</div>
                  </div>
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                className="btn btn-secondary"
                onClick={() => { setShowAddMember(false); setAddMemberSelection([]) }}
              >
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={handleAddMembers}
              >
                添加
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Spin animation */}
      <style>{`
        @keyframes ff-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .ff-spin { animation: ff-spin 0.8s linear infinite; }
      `}</style>
    </div>
  )
}