import React, { useState, useEffect } from 'react'
import {
  FolderKanban, Plus, GitBranch, ChevronDown, LayoutGrid, List, X, Users, Folder
} from 'lucide-react'
import { useApp } from '@/context/AppContext'
import ConfigScopeBanner from '@/components/ConfigScopeBanner'
import { getRepositories, addRepository, updateRepository, registerLocalRepository } from '@/services/repository'
import { detectRuntimeMode } from '@/adapters/StorageService'

const projectStages = ['需求分析', 'BRD生成', 'PRD生成', '测试用例', '开发', 'Code Review', '自动化测试', '交付']

export default function Projects() {
  const [viewMode, setViewMode] = useState('cards')
  const [selectedProjectIndex, setSelectedProjectIndex] = useState(0)
  const { projects, currentProject, setCurrentProject, showToast, addProject, users, updateProjectConfig } = useApp()

  // Git repos come from the repository service (real data), re-read on change
  const [repoRefreshTick, setRepoRefreshTick] = useState(0)

  // Dialog visibility
  const [showCreateProject, setShowCreateProject] = useState(false)
  const [showAddRepo, setShowAddRepo] = useState(false)
  const [showSwitchBranch, setShowSwitchBranch] = useState(false)
  const [showAddMember, setShowAddMember] = useState(false)
  const [addMemberSelection, setAddMemberSelection] = useState([])

  // Create Project form state
  const [projectName, setProjectName] = useState('')
  const [projectStage, setProjectStage] = useState('需求分析')
  const [selectedMembers, setSelectedMembers] = useState([])

  // Add Repo form state
  const [repoMode, setRepoMode] = useState('git') // 'git' 克隆 | 'local' 引用本地目录
  const [repoName, setRepoName] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [repoPath, setRepoPath] = useState('')
  const [repoBranch, setRepoBranch] = useState('main')

  // Switch Branch form state
  const [switchBranchTarget, setSwitchBranchTarget] = useState('')
  const [switchBranchRepoIndex, setSwitchBranchRepoIndex] = useState(null)

  const handleSelectProject = (i) => {
    setSelectedProjectIndex(i)
    setCurrentProject(projects[i])
    showToast(`已切换到「${projects[i].name}」`, 'success')
  }

  const selectedProject = projects[selectedProjectIndex] || projects[0] || null
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const gitRepos = React.useMemo(
    () => (selectedProject ? getRepositories(selectedProject.id) : []),
    [selectedProject?.id, repoRefreshTick]
  )

  // Escape key closes any open dialog
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (showCreateProject) setShowCreateProject(false)
        else if (showAddRepo) setShowAddRepo(false)
        else if (showSwitchBranch) setShowSwitchBranch(false)
        else if (showAddMember) { setShowAddMember(false); setAddMemberSelection([]) }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [showCreateProject, showAddRepo, showSwitchBranch, showAddMember])

  // ── Create Project handlers ──
  const openCreateProject = () => {
    setProjectName('')
    setProjectStage('需求分析')
    setSelectedMembers([])
    setShowCreateProject(true)
  }

  const handleCreateProject = () => {
    if (!projectName.trim()) {
      showToast('请输入项目名称', 'info')
      return
    }
    const newProject = {
      id: `p${Date.now()}`,
      name: projectName.trim(),
      stage: projectStage,
      progress: 0,
      status: 'planning',
      members: selectedMembers,
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
      pipeline: {
        stages: [
          { id: 1, name: '需求分析', icon: 'FileText', status: 'pending', hasAiReview: true, aiReviewStatus: null },
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
      activities: [],
    }
    addProject(newProject)
    showToast(`项目「${projectName.trim()}」创建成功`, 'success')
    setShowCreateProject(false)
  }

  const toggleMember = (memberName) => {
    setSelectedMembers(prev =>
      prev.includes(memberName)
        ? prev.filter(m => m !== memberName)
        : [...prev, memberName]
    )
  }

  // ── Add Repo handlers ──
  const openAddRepo = () => {
    setRepoMode('git')
    setRepoName('')
    setRepoUrl('')
    setRepoPath('')
    setRepoBranch('main')
    setShowAddRepo(true)
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
        setRepoPath(dir)
        if (!repoName.trim()) {
          setRepoName(dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '')
        }
      }
    } catch (e) {
      showToast(`目录选择失败：${e?.message || e}`, 'error')
    }
  }

  const handleAddRepo = async () => {
    if (!repoName.trim()) {
      showToast('请输入仓库名称', 'info')
      return
    }
    if (repoMode === 'local') {
      // web 模式无法访问本机文件系统，明确拒绝而非假校验通过
      if (detectRuntimeMode() !== 'tauri') {
        showToast('浏览器模式不支持引用本地目录，请使用桌面版', 'error')
        return
      }
      // 引用本地已有目录：原路径直接注册，不 clone 不复制
      if (!repoPath.trim()) {
        showToast('请选择或输入本地目录', 'info')
        return
      }
      try {
        const repo = await registerLocalRepository({
          projectId: selectedProject.id,
          name: repoName.trim(),
          path: repoPath.trim(),
        })
        setRepoRefreshTick(t => t + 1)
        showToast(
          repo.isGitRepo
            ? `已引用本地仓库「${repo.name}」（分支 ${repo.branch}）`
            : `已引用本地目录「${repo.name}」；非 Git 仓库，交付时将跳过分支隔离`,
          'success'
        )
        setShowAddRepo(false)
      } catch (e) {
        showToast(`引用失败：${e?.message || e}`, 'error')
      }
      return
    }
    addRepository({
      projectId: selectedProject.id,
      name: repoName.trim(),
      type: 'git',
      gitUrl: repoUrl.trim(),
      branch: repoBranch.trim() || 'main',
    })
    setRepoRefreshTick(t => t + 1)
    showToast(`仓库「${repoName.trim()}」已添加`, 'success')
    setShowAddRepo(false)
  }

  // ── Switch Branch handlers ──
  const openSwitchBranch = (repoIndex) => {
    setSwitchBranchTarget('')
    setSwitchBranchRepoIndex(repoIndex)
    setShowSwitchBranch(true)
  }

  const handleSwitchBranch = () => {
    if (!switchBranchTarget.trim()) {
      showToast('请输入目标分支', 'info')
      return
    }
    const target = switchBranchTarget.trim()
    const repo = switchBranchRepoIndex !== null ? gitRepos[switchBranchRepoIndex] : null
    if (repo) {
      updateRepository(repo.id, { branch: target })
      setRepoRefreshTick(t => t + 1)
    }
    showToast(`已切换到分支「${target}」`, 'success')
    setShowSwitchBranch(false)
  }

  // Shared Create Project dialog (rendered in both empty state and normal view)
  const renderCreateProjectDialog = () => (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100
    }} onClick={() => setShowCreateProject(false)} role="presentation">
      <div style={{
        background: 'var(--bg)', borderRadius: '12px', padding: '24px',
        width: '520px', maxWidth: '90vw', maxHeight: '85vh', overflowY: 'auto',
        border: '1px solid var(--border)', boxShadow: '0 8px 32px rgba(0,0,0,0.12)'
      }} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="create-project-title">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h3 id="create-project-title">新建项目</h3>
          <button className="btn btn-ghost" onClick={() => setShowCreateProject(false)} aria-label="关闭对话框">
            <X size={18} />
          </button>
        </div>

        {/* 项目名称 */}
        <div style={{ marginBottom: '16px' }}>
          <label htmlFor="project-name" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>
            项目名称 <span style={{ color: 'var(--color-danger, #e53e3e)' }}>*</span>
          </label>
          <input
            id="project-name"
            className="input"
            type="text"
            value={projectName}
            onChange={e => setProjectName(e.target.value)}
            placeholder="请输入项目名称"
            style={{ width: '100%' }}
            autoFocus
          />
        </div>

        {/* 项目阶段 */}
        <div style={{ marginBottom: '16px' }}>
          <label htmlFor="project-stage" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>
            项目阶段
          </label>
          <select
            id="project-stage"
            className="select"
            value={projectStage}
            onChange={e => setProjectStage(e.target.value)}
            style={{ width: '100%' }}
          >
            {projectStages.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        {/* 项目成员 */}
        <div style={{ marginBottom: '24px' }}>
          <label style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '8px' }}>
            项目成员
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {users.map(user => (
              <label
                key={user.id}
                htmlFor={`member-${user.id}`}
                style={{
                  display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px',
                  border: '1px solid var(--border)', borderRadius: '6px', cursor: 'pointer',
                  fontSize: '13px',
                  background: selectedMembers.includes(user.name) ? 'color-mix(in srgb, var(--accent) 6%, var(--bg))' : 'transparent',
                  borderColor: selectedMembers.includes(user.name) ? 'var(--accent)' : 'var(--border)',
                }}
              >
                <input
                  type="checkbox"
                  id={`member-${user.id}`}
                  checked={selectedMembers.includes(user.name)}
                  onChange={() => toggleMember(user.name)}
                />
                <span style={{ fontWeight: 510 }}>{user.name}</span>
                <span style={{ color: 'var(--fg-tertiary)', fontSize: '12px' }}>{user.role} · {user.roleTag}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button
            className="btn btn-secondary"
            onClick={() => setShowCreateProject(false)}
            role="button"
            tabIndex={0}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowCreateProject(false) } }}
          >
            取消
          </button>
          <button
            className="btn btn-primary"
            onClick={handleCreateProject}
            role="button"
            tabIndex={0}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleCreateProject() } }}
          >
            创建
          </button>
        </div>
      </div>
    </div>
  )

  // ── Empty state: no project yet (clean first run on desktop) ──
  if (!selectedProject) {
    return (
      <div className="fade-in">
        <div className="page-header">
          <h2>项目管理</h2>
          <button className="btn btn-primary" onClick={openCreateProject} aria-haspopup="dialog">
            <Plus size={14} /> 新建项目
          </button>
        </div>
        <div className="card" style={{ textAlign: 'center', padding: '64px 24px', color: 'var(--fg-tertiary)' }}>
          <FolderKanban size={40} style={{ opacity: 0.3, marginBottom: '12px' }} />
          <div style={{ fontSize: '14px', fontWeight: 510, color: 'var(--fg)' }}>还没有项目</div>
          <div style={{ fontSize: '13px', marginTop: '6px' }}>点击右上角「新建项目」开始你的第一个交付流程</div>
        </div>
        {showCreateProject && renderCreateProjectDialog()}
      </div>
    )
  }

  return (
    <div className="fade-in">
      <ConfigScopeBanner />

      <div className="page-header">
        <h2>项目管理</h2>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: '6px', overflow: 'hidden' }}>
            <button className={`btn btn-ghost ${viewMode === 'cards' ? 'active' : ''}`}
              onClick={() => setViewMode('cards')}
              aria-pressed={viewMode === 'cards'}
              aria-label="卡片视图"
              style={{ borderRadius: 0, background: viewMode === 'cards' ? 'var(--surface)' : 'transparent' }}>
              <LayoutGrid size={14} />
            </button>
            <button className={`btn btn-ghost ${viewMode === 'list' ? 'active' : ''}`}
              onClick={() => setViewMode('list')}
              aria-pressed={viewMode === 'list'}
              aria-label="列表视图"
              style={{ borderRadius: 0, background: viewMode === 'list' ? 'var(--surface)' : 'transparent' }}>
              <List size={14} />
            </button>
          </div>
          <button className="btn btn-primary" onClick={openCreateProject} aria-haspopup="dialog">
            <Plus size={14} /> 新建项目
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: '20px' }}>
        {/* Project List */}
        <div>
          {projects.map((project, i) => (
            <div key={project.id}
              className="card"
              role="button"
              tabIndex={0}
              aria-label={`选择项目 ${project.name}`}
              onClick={() => handleSelectProject(i)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSelectProject(i) } }}
              style={{
                marginBottom: '8px', cursor: 'pointer',
                borderColor: selectedProject.id === project.id ? 'var(--accent)' : 'var(--border)',
                background: selectedProject.id === project.id ? 'color-mix(in srgb, var(--accent) 4%, var(--bg))' : 'var(--bg)'
              }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                  <FolderKanban size={18} style={{ color: 'var(--accent)' }} />
                  <div>
                    <div style={{ fontWeight: 510, fontSize: '14px' }}>{project.name}</div>
                    <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)', marginTop: '2px' }}>
                      {project.stage} · 进度 {project.progress}%
                    </div>
                  </div>
                </div>
                <span className={`status-badge status-${project.status === 'active' ? 'progress' : 'pending'}`}>
                  <span className="status-dot"></span>
                </span>
              </div>
              <div style={{ display: 'flex', gap: '16px', marginTop: '12px', fontSize: '12px', color: 'var(--fg-tertiary)' }}>
                <span>{(project.agents || []).length} 个智能体</span>
                <span>{(project.skills || []).length} 个Skill</span>
                <span>{project.members.length} 位成员</span>
              </div>
            </div>
          ))}
        </div>

        {/* Project Detail */}
        <div>
          {/* Git Repos */}
          <div className="card" style={{ marginBottom: '16px' }}>
            <div className="card-header">
              <h4 className="card-title">
                <GitBranch size={16} style={{ marginRight: '6px', verticalAlign: 'middle' }} />
                Git 仓库管理
              </h4>
              <button className="btn btn-secondary" style={{ fontSize: '12px' }} onClick={openAddRepo} aria-haspopup="dialog">
                <Plus size={12} /> 添加仓库
              </button>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>仓库名称</th>
                  <th>Clone 地址</th>
                  <th>当前分支</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {gitRepos.length > 0 ?
                  gitRepos.map((repo, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 510, color: 'var(--fg)' }}>{repo.name}</td>
                      <td style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}>
                        {repo.source === 'local'
                          ? <span title="引用本地目录">📁 {repo.path || '—'}</span>
                          : (repo.gitUrl || repo.url || repo.path || '—')}
                      </td>
                      <td>
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', gap: '4px',
                          padding: '2px 8px', background: 'var(--surface)', borderRadius: '4px',
                          fontSize: '12px', fontFamily: 'JetBrains Mono, monospace'
                        }}>
                          <GitBranch size={12} /> {repo.branch}
                        </span>
                      </td>
                      <td>
                        <button className="btn btn-ghost" style={{ fontSize: '12px', padding: '4px 8px' }} onClick={() => openSwitchBranch(i)} aria-haspopup="dialog">
                          <ChevronDown size={12} /> 切换分支
                        </button>
                      </td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan={4} style={{ textAlign: 'center', color: 'var(--fg-muted)', padding: '24px' }}>
                        暂无仓库配置，点击"添加仓库"通过Clone链接导入
                      </td>
                    </tr>
                  )
                }
              </tbody>
            </table>
          </div>

          {/* Bridge Agent Status（暂无真实探测能力，如实展示未连接） */}
          <div className="card">
            <div className="card-header">
              <h4 className="card-title">Bridge Agent 状态</h4>
              <span className="status-badge status-pending">
                <span className="status-dot"></span>
                未连接
              </span>
            </div>
            <div style={{ fontSize: '13px', color: 'var(--fg-tertiary)' }}>
              尚未检测到本地 Bridge Agent。安装并启动后，可在此查看连接状态。
            </div>
          </div>

          {/* Project Members */}
          <div className="card" style={{ marginTop: '16px' }}>
            <div className="card-header">
              <h4 className="card-title">
                <Users size={16} style={{ marginRight: '6px', verticalAlign: 'middle' }} />
                项目成员
              </h4>
              <button className="btn btn-secondary" style={{ fontSize: '12px' }}
                onClick={() => { setAddMemberSelection([]); setShowAddMember(true) }}>
                <Plus size={12} /> 添加成员
              </button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
              {(selectedProject.members || []).map((memberName, i) => {
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
                    {(selectedProject.members || []).length > 1 && (
                      <button style={{ marginLeft: '4px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-muted)', padding: '2px' }}
                        onClick={() => {
                          const newMembers = selectedProject.members.filter((_, j) => j !== i)
                          updateProjectConfig(selectedProject.id, 'members', newMembers)
                          showToast(`已移除成员「${memberName}」`, 'success')
                        }}
                        aria-label={`移除 ${memberName}`}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ─── Create Project Dialog ─── */}
      {showCreateProject && renderCreateProjectDialog()}

      {/* ─── Add Repository Dialog ─── */}
      {showAddRepo && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100
        }} onClick={() => setShowAddRepo(false)} role="presentation">
          <div style={{
            background: 'var(--bg)', borderRadius: '12px', padding: '24px',
            width: '480px', maxWidth: '90vw',
            border: '1px solid var(--border)', boxShadow: '0 8px 32px rgba(0,0,0,0.12)'
          }} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="add-repo-title">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 id="add-repo-title">添加仓库</h3>
              <button className="btn btn-ghost" onClick={() => setShowAddRepo(false)} aria-label="关闭对话框">
                <X size={18} />
              </button>
            </div>

            {/* 导入方式 */}
            <div style={{ marginBottom: '16px' }}>
              <label style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>
                导入方式
              </label>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  className={`btn ${repoMode === 'git' ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ flex: 1, fontSize: '13px' }}
                  onClick={() => setRepoMode('git')}
                  aria-pressed={repoMode === 'git'}
                  aria-label="Git 仓库克隆"
                >
                  <GitBranch size={14} /> Git 仓库克隆
                </button>
                <button
                  className={`btn ${repoMode === 'local' ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ flex: 1, fontSize: '13px' }}
                  onClick={() => setRepoMode('local')}
                  aria-pressed={repoMode === 'local'}
                  aria-label="引用本地目录"
                >
                  <Folder size={14} /> 引用本地目录
                </button>
              </div>
            </div>

            {/* 仓库名称 */}
            <div style={{ marginBottom: '16px' }}>
              <label htmlFor="repo-name" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>
                仓库名称
              </label>
              <input
                id="repo-name"
                className="input"
                type="text"
                value={repoName}
                onChange={e => setRepoName(e.target.value)}
                placeholder="例如：my-service"
                style={{ width: '100%' }}
                autoFocus
              />
            </div>

            {/* Clone 地址（git 模式） */}
            {repoMode === 'git' && (
              <div style={{ marginBottom: '16px' }}>
                <label htmlFor="repo-url" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>
                  Clone 地址
                </label>
                <input
                  id="repo-url"
                  className="input"
                  type="text"
                  value={repoUrl}
                  onChange={e => setRepoUrl(e.target.value)}
                  placeholder="git@github.com:org/repo.git"
                  style={{ width: '100%', fontFamily: 'JetBrains Mono, monospace', fontSize: '13px' }}
                />
              </div>
            )}

            {/* 本地目录（local 模式） */}
            {repoMode === 'local' && (
              <div style={{ marginBottom: '16px' }}>
                <label htmlFor="repo-local-path" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>
                  本地目录
                </label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    id="repo-local-path"
                    className="input"
                    type="text"
                    value={repoPath}
                    onChange={e => setRepoPath(e.target.value)}
                    placeholder="/Users/xxx/project"
                    style={{ flex: 1, fontFamily: 'JetBrains Mono, monospace', fontSize: '13px' }}
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

            {/* 默认分支（git 模式；本地引用自动探测当前分支） */}
            {repoMode === 'git' && (
              <div style={{ marginBottom: '24px' }}>
                <label htmlFor="repo-branch" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>
                  默认分支
                </label>
                <input
                  id="repo-branch"
                  className="input"
                  type="text"
                  value={repoBranch}
                  onChange={e => setRepoBranch(e.target.value)}
                  placeholder="main"
                  style={{ width: '100%', fontFamily: 'JetBrains Mono, monospace', fontSize: '13px' }}
                />
              </div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                className="btn btn-secondary"
                onClick={() => setShowAddRepo(false)}
                role="button"
                tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowAddRepo(false) } }}
              >
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={handleAddRepo}
                disabled={repoMode === 'local' && detectRuntimeMode() !== 'tauri'}
                role="button"
                tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleAddRepo() } }}
              >
                添加
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Switch Branch Dialog ─── */}
      {showSwitchBranch && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100
        }} onClick={() => setShowSwitchBranch(false)} role="presentation">
          <div style={{
            background: 'var(--bg)', borderRadius: '12px', padding: '24px',
            width: '440px', maxWidth: '90vw',
            border: '1px solid var(--border)', boxShadow: '0 8px 32px rgba(0,0,0,0.12)'
          }} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="switch-branch-title">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 id="switch-branch-title">切换分支</h3>
              <button className="btn btn-ghost" onClick={() => setShowSwitchBranch(false)} aria-label="关闭对话框">
                <X size={18} />
              </button>
            </div>

            {/* 当前分支 (read-only) */}
            <div style={{ marginBottom: '16px' }}>
              <label style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>
                当前分支
              </label>
              <div style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                padding: '8px 12px', background: 'var(--surface)', borderRadius: '6px',
                fontSize: '13px', fontFamily: 'JetBrains Mono, monospace',
                color: 'var(--fg)', border: '1px solid var(--border)', width: '100%',
                boxSizing: 'border-box'
              }}>
                <GitBranch size={14} />
                {switchBranchRepoIndex !== null && gitRepos[switchBranchRepoIndex]
                  ? gitRepos[switchBranchRepoIndex].branch
                  : '—'}
              </div>
            </div>

            {/* 目标分支 */}
            <div style={{ marginBottom: '24px' }}>
              <label htmlFor="target-branch" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>
                目标分支
              </label>
              <input
                id="target-branch"
                className="input"
                type="text"
                value={switchBranchTarget}
                onChange={e => setSwitchBranchTarget(e.target.value)}
                placeholder="例如：develop, feature/xxx"
                style={{ width: '100%', fontFamily: 'JetBrains Mono, monospace', fontSize: '13px' }}
                autoFocus
              />
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                className="btn btn-secondary"
                onClick={() => setShowSwitchBranch(false)}
                role="button"
                tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowSwitchBranch(false) } }}
              >
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={handleSwitchBranch}
                role="button"
                tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSwitchBranch() } }}
              >
                切换
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Add Member Dialog ─── */}
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
              选择要添加到项目「{selectedProject.name}」的成员
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '24px' }}>
              {users.filter(u => !(selectedProject.members || []).includes(u.name)).length === 0 && (
                <div style={{ textAlign: 'center', color: 'var(--fg-muted)', padding: '24px', fontSize: '13px' }}>
                  所有团队成员已在项目中
                </div>
              )}
              {users.filter(u => !(selectedProject.members || []).includes(u.name)).map(user => (
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
                role="button"
                tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowAddMember(false); setAddMemberSelection([]) } }}>
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  if (addMemberSelection.length === 0) { showToast('请至少选择一位成员', 'info'); return }
                  const currentMembers = selectedProject.members || []
                  updateProjectConfig(selectedProject.id, 'members', [...currentMembers, ...addMemberSelection])
                  showToast(`已添加 ${addMemberSelection.length} 位成员`, 'success')
                  setShowAddMember(false)
                  setAddMemberSelection([])
                }}
                role="button"
                tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (addMemberSelection.length === 0) { showToast('请至少选择一位成员', 'info'); return } const currentMembers = selectedProject.members || []; updateProjectConfig(selectedProject.id, 'members', [...currentMembers, ...addMemberSelection]); showToast(`已添加 ${addMemberSelection.length} 位成员`, 'success'); setShowAddMember(false); setAddMemberSelection([]) } }}>
                添加
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
