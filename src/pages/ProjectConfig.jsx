import React, { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import {
  Plus, X, Trash2, Edit3, Loader2, Eye, EyeOff,
  Server, GitBranch, Folder, Search, Database, CheckCircle,
  AlertCircle, FileCode, Zap, ChevronRight, RefreshCw,
  Code2, Terminal, BookOpen, Layers, Bot, Settings,
  SlidersHorizontal, ArrowUp, ArrowDown, GripVertical, PlusCircle, RotateCcw,
  Cpu, Sliders, Link2, Shield,
} from 'lucide-react'
import { useApp } from '@/context/AppContext'
import ConfigScopeBanner from '@/components/ConfigScopeBanner'
import { Toggle } from '@/components/ui/Toggle'
import {
  getRepositories, addRepository, updateRepository, deleteRepository,
  cloneRepository, validateGitUrl, validateLocalPath, getRepoNameFromUrl,
  validateLocalRepo,
} from '@/services/repository'
import { detectRuntimeMode } from '@/adapters/StorageService'
import {
  getIndexes, startIndexing, getIndexStatus, getProjectIndexStats,
  deleteIndex, searchCodebase
} from '@/services/codebaseIndex'
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

// Common model options for the model selects
const MODEL_OPTIONS = [
  'GPT-4o',
  'GPT-4o-mini',
  'Claude 3.5 Sonnet',
  'DeepSeek V3',
]

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
  { key: 'index', label: '代码索引', icon: Database },
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

export default function ProjectConfig() {
  const {
    currentProject, projects, setCurrentProject, showToast,
    stageDefinitions,
    toggleReviewGate,
    updateProjectFlow, updateFlowNode, resetProjectFlow, getProjectStageList,
    getFlowNode, getStageGate,
    agents, updateAgent,
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

  // 原生目录选择器（tauri-plugin-dialog）；web 模式不支持引用本地目录
  const handlePickDirectory = async () => {
    if (detectRuntimeMode() !== 'tauri') {
      showToast('浏览器模式不支持引用本地目录，请使用桌面版', 'info')
      return
    }
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
      // web 模式无法访问本机文件系统，明确拒绝而非假校验通过
      if (detectRuntimeMode() !== 'tauri') {
        showToast('浏览器模式不支持引用本地目录，请使用桌面版', 'error')
        return
      }
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
      model: agent.model || MODEL_OPTIONS[0],
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
      await startIndexing(currentProject.id, repo.id, repo.name)
      showToast(`「${repo.name}」索引完成`, 'success')
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

  // ════════════════════════════════════════════════════════════════
  //  RENDER
  // ════════════════════════════════════════════════════════════════
  if (!currentProject) {
    return (
      <div className="fade-in">
        <ConfigScopeBanner />
        <div className="card" style={{ padding: '40px', textAlign: 'center', color: 'var(--fg-tertiary)' }}>
          请先选择一个项目
        </div>
      </div>
    )
  }

  return (
    <div className="fade-in">
      <ConfigScopeBanner />

      {/* Header with project selector */}
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
                        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <GitBranch size={11} /> {repo.branch || 'main'}
                        </span>
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

      {/* ════════ Tab 3: 代码索引 ════════ */}
      {activeTab === 'index' && (
        <div>
          {/* Overall stats */}
          <div style={{ display: 'flex', gap: '12px', marginBottom: '20px', flexWrap: 'wrap' }}>
            {[
              { label: '已索引仓库', value: indexStats.repoCount, icon: Database, color: 'var(--accent)' },
              { label: '总文件数', value: indexStats.totalFiles.toLocaleString(), icon: FileCode, color: 'var(--color-progress)' },
              { label: '总分块数', value: indexStats.totalChunks.toLocaleString(), icon: Layers, color: 'var(--color-ai-review)' },
              { label: '最近索引', value: formatTime(indexStats.lastIndexed), icon: RefreshCw, color: 'var(--color-success)' },
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
          {indexStats.languages.length > 0 && (
            <div style={{
              padding: '12px 16px', marginBottom: '20px', borderRadius: '8px',
              background: 'var(--surface)', border: '1px solid var(--border-subtle)',
              display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
            }}>
              <span style={{ fontSize: '12px', color: 'var(--fg-tertiary)' }}>检测到的语言：</span>
              {indexStats.languages.map(lang => (
                <span key={lang} style={{
                  fontSize: '11px', fontWeight: 510, color: 'var(--fg-secondary)',
                  padding: '2px 8px', borderRadius: '6px', background: 'var(--bg)', border: '1px solid var(--border-subtle)',
                }}>
                  {lang}
                </span>
              ))}
            </div>
          )}

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
                          {repo.isMain && renderBadge('主仓库', 'var(--accent)', 'color-mix(in srgb, var(--accent) 10%, transparent)')}
                        </div>
                        <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)' }}>
                          {repo.type === 'git' ? repo.gitUrl : repo.path}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
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

                    {/* Index detail */}
                    {isReady && index && (
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
                    )}

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
                  {detectRuntimeMode() !== 'tauri' && (
                    <div style={{ fontSize: '11px', color: 'var(--color-error)', marginTop: '4px' }}>
                      浏览器模式不支持引用本地目录，请使用桌面版
                    </div>
                  )}
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
                disabled={repoForm.type === 'local' && detectRuntimeMode() !== 'tauri'}
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
                      {MODEL_OPTIONS.map(m => (
                        <option key={m} value={m}>{m}</option>
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